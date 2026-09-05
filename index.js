import { execFile } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import Schema from '@deepseek-ai/schemastery'
import {
  DuplicateTracker,
  SOUND_KINDS,
  TtlCache,
  buildNotificationScript,
  duplicateKey,
  isCompletionKind,
  isCriticalKind,
  matchingProjectRule,
  parseProjectRules,
  quietHoursActive,
  truncateNotification,
  validateSettingsPatch,
} from './src/policy.js'
import { loadStateSync, saveState } from './src/state.js'

export const name = 'dsh-macos-notify'
export const inject = ['sessions', 'settings']

export const Config = Schema.object({
  /** 轮次正常完成时通知 */
  onCompleted: Schema.boolean().default(true),
  /** 轮次出错或被阻止时通知（不受 minDurationSec / onlyWhenIdleSec / onlyWhenUnfocused / digestMinutes 限制） */
  onError: Schema.boolean().default(true),
  /** 用户取消（中断）时通知 */
  onAborted: Schema.boolean().default(false),
  /** 工具等待审批时通知（立即发送，不参与合并） */
  onApproval: Schema.boolean().default(true),
  /** 「完成」通知的最短轮次时长（秒）：短于此值的轮次不弹完成通知，0 表示都弹 */
  minDurationSec: Schema.number().default(30),
  /** 「完成」类通知仅在键鼠空闲超过此值（秒）时发送，0 关闭。注意：测的是输入空闲，切走应用但还在打字就不算空闲 */
  onlyWhenIdleSec: Schema.number().default(0),
  /** 「完成」类通知仅在没有任何浏览器 tab 聚焦 dsh 时发送（切走 tab 或切走应用都会弹）。无客户端上报时（如 headless）视为未聚焦，照弹 */
  onlyWhenUnfocused: Schema.boolean().default(true),
  /** 「完成」类通知的汇总间隔（分钟）：攒一批定时合并发送，0 表示实时。审批和出错不受影响 */
  digestMinutes: Schema.number().default(0),
  /** 子 agent 会话也通知（默认只通知顶层会话，避免刷屏） */
  includeSubagents: Schema.boolean().default(false),
  /** 通知通道：auto = 支持的终端走 OSC 9，否则 osascript；osc9/osascript 强制指定 */
  channel: Schema.union(['auto', 'osascript', 'osc9']).default('auto'),
  /** 各事件类型的通知声音（macOS 声音名，空串为静音；OSC 9 通道下声音由终端决定，此配置无效） */
  sounds: Schema.object({
    completed: Schema.string().default('Glass'),
    error: Schema.string().default('Basso'),
    aborted: Schema.string().default(''),
    approval: Schema.string().default('Ping'),
  }).default({ completed: 'Glass', error: 'Basso', aborted: '', approval: 'Ping' }),
  /** 轮次结束通知的合并窗口（毫秒）：窗口内多个会话的结束合并成一条，0 关闭合并 */
  coalesceMs: Schema.number().default(1500),
  /** 是否启用每日勿扰时段 */
  quietHoursEnabled: Schema.boolean().default(false),
  /** 每日勿扰开始时间（本机时间，HH:mm） */
  quietStart: Schema.string().default('23:00'),
  /** 每日勿扰结束时间（本机时间，HH:mm） */
  quietEnd: Schema.string().default('08:00'),
  /** 勿扰时段仍允许错误、阻止和审批通知 */
  quietAllowCritical: Schema.boolean().default(true),
  /** 临时暂停截止时间（Unix 毫秒）；0 表示未暂停 */
  pauseUntil: Schema.number().default(0),
  /** 相同会话相同错误的重复抑制窗口（秒）；0 表示关闭 */
  duplicateWindowSec: Schema.number().default(300),
  /** 项目规则 JSON：[{ path, mode }]，mode 为 mute / errors / important */
  projectRulesJson: Schema.string().default('[]'),
  /** 兼容旧配置；成功加载现在始终静默，仅初始化失败时提醒 */
  notifyOnLoad: Schema.boolean().default(false),
})

const SOUND_EXTENSIONS = new Set(['.aif', '.aiff', '.caf', '.m4a', '.wav'])
const IMPORT_EXTENSIONS = new Set([
  '.aac', '.aif', '.aiff', '.caf', '.flac', '.m4a', '.mp3', '.oga', '.ogg', '.opus', '.wav',
])
const MAX_SOUND_BYTES = 5 * 1024 * 1024
const MAX_SOUND_DURATION_SEC = 10
const MAX_MANAGED_SOUND_COUNT = 20
const MAX_MANAGED_SOUND_BYTES = 50 * 1024 * 1024
const MAX_DIAGNOSTICS = 50
const execFileAsync = promisify(execFile)

function userSoundsDir() {
  return join(homedir(), 'Library/Sounds')
}

function soundRegistryPath() {
  return join(homedir(), 'Library/Application Support/dsh-macos-notify/sounds.json')
}

/** 决策历史与重复合并状态的落盘位置；测试可通过 DSH_MACOS_NOTIFY_STATE_FILE 重定向 */
function stateFilePath() {
  return process.env.DSH_MACOS_NOTIFY_STATE_FILE
    || join(homedir(), 'Library/Application Support/dsh-macos-notify/state.json')
}

async function readSoundRegistry() {
  try {
    const parsed = JSON.parse(await readFile(soundRegistryPath(), 'utf8'))
    return Array.isArray(parsed) ? parsed.filter((item) =>
      item && typeof item.name === 'string' && typeof item.filename === 'string') : []
  } catch {
    return []
  }
}

async function writeSoundRegistry(entries) {
  const path = soundRegistryPath()
  await mkdir(resolve(path, '..'), { recursive: true })
  await writeFile(path, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 })
}

async function managedSoundCatalog() {
  const dir = userSoundsDir()
  const registry = await readSoundRegistry()
  const catalog = []
  const kept = []
  for (const item of registry) {
    const path = join(dir, item.filename)
    try {
      const info = await stat(path)
      if (!info.isFile()) continue
      kept.push(item)
      catalog.push({
        name: item.name,
        filename: item.filename,
        bytes: info.size,
        importedAt: Number(item.importedAt) || info.birthtimeMs || info.mtimeMs,
      })
    } catch {
      // 用户在 Finder 中删除了文件；下次写回时清理失效注册项。
    }
  }
  if (kept.length !== registry.length) await writeSoundRegistry(kept)
  return catalog.sort((a, b) => b.importedAt - a.importedAt)
}

function safeSoundName(filename) {
  const extension = extname(filename).toLowerCase()
  if (!IMPORT_EXTENSIONS.has(extension)) {
    throw new Error('不支持该音频格式')
  }
  const name = basename(filename, extension)
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^\.+|\.+$/g, '')
    .trim()
    .slice(0, 80)
  if (!name) throw new Error('声音文件名无效')
  return { extension, name }
}

async function availableSoundPath(name) {
  const dir = userSoundsDir()
  await mkdir(dir, { recursive: true })
  const existing = new Set((await readdir(dir)).map((item) => item.toLowerCase()))
  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const candidateName = suffix === 0 ? name : `${name} (${suffix + 1})`
    const filename = `${candidateName}.aiff`
    if (!existing.has(filename.toLowerCase())) {
      return { candidateName, path: join(dir, filename) }
    }
  }
  throw new Error('同名声音文件过多')
}

async function convertToAiff(input, output) {
  try {
    await execFileAsync('/usr/bin/afconvert', ['-f', 'AIFF', '-d', 'BEI16@44100', input, output])
  } catch (afconvertError) {
    try {
      await execFileAsync('ffmpeg', [
        '-y', '-loglevel', 'error', '-i', input,
        '-ar', '44100', '-ac', '1', '-c:a', 'pcm_s16be', output,
      ])
    } catch {
      throw new Error(`音频转换失败：${afconvertError?.message ?? '格式无法识别'}`)
    }
  }
}

async function validateSoundDuration(path) {
  const { stdout } = await execFileAsync('/usr/bin/afinfo', ['-r', path])
  const match = stdout.match(/estimated duration:\s*([\d.]+)\s*sec/i)
  const duration = match ? Number(match[1]) : NaN
  if (!Number.isFinite(duration)) throw new Error('无法读取音频时长')
  if (duration > MAX_SOUND_DURATION_SEC) {
    throw new Error(`提示音时长不能超过 ${MAX_SOUND_DURATION_SEC} 秒`)
  }
}

async function importSound(payload) {
  if (typeof payload?.filename !== 'string' || typeof payload?.data !== 'string') {
    throw new Error('缺少声音文件')
  }
  if (payload.data.length > Math.ceil(MAX_SOUND_BYTES * 4 / 3) + 8) {
    throw new Error('声音文件不能超过 5MB')
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload.data)) {
    throw new Error('声音文件内容无效')
  }
  const bytes = Buffer.from(payload.data, 'base64')
  if (bytes.length === 0 || bytes.length > MAX_SOUND_BYTES) {
    throw new Error('声音文件不能超过 5MB')
  }

  const { extension, name } = safeSoundName(payload.filename)
  const tempDir = await mkdtemp(join(tmpdir(), 'dsh-macos-notify-'))
  try {
    const input = join(tempDir, `input${extension}`)
    const output = join(tempDir, 'output.aiff')
    await writeFile(input, bytes)
    await convertToAiff(input, output)
    await validateSoundDuration(output)
    const existing = await managedSoundCatalog()
    const outputInfo = await stat(output)
    const usedBytes = existing.reduce((total, item) => total + item.bytes, 0)
    if (existing.length >= MAX_MANAGED_SOUND_COUNT) {
      throw new Error(`最多管理 ${MAX_MANAGED_SOUND_COUNT} 个自定义提示音，请先删除不用的声音`)
    }
    if (usedBytes + outputInfo.size > MAX_MANAGED_SOUND_BYTES) {
      throw new Error('自定义提示音总容量不能超过 50MB，请先删除不用的声音')
    }
    const destination = await availableSoundPath(name)
    await copyFile(output, destination.path, fsConstants.COPYFILE_EXCL)
    await chmod(destination.path, 0o644)
    try {
      const registry = await readSoundRegistry()
      registry.push({
        name: destination.candidateName,
        filename: basename(destination.path),
        importedAt: Date.now(),
      })
      await writeSoundRegistry(registry)
    } catch (err) {
      await rm(destination.path, { force: true })
      throw err
    }
    return destination.candidateName
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

async function deleteManagedSound(name) {
  const registry = await readSoundRegistry()
  const index = registry.findIndex((item) => item.name === name)
  if (index < 0) throw new Error('只能删除由本插件导入并管理的声音')
  const [entry] = registry.splice(index, 1)
  const target = resolve(userSoundsDir(), entry.filename)
  const root = `${resolve(userSoundsDir())}/`
  if (!target.startsWith(root) || basename(target) !== entry.filename) {
    throw new Error('声音文件路径无效')
  }
  try {
    await unlink(target)
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err
  }
  await writeSoundRegistry(registry)
}

/** 试听：把声音名解析为磁盘文件后交给 afplay 本地播放，不经过通知通道 */
async function previewSound(name) {
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error('声音名无效')
  }
  const dir = userSoundsDir()
  const registry = await readSoundRegistry()
  const managed = registry.find((item) => item.name === name)
  const candidates = managed ? [join(dir, managed.filename)] : []
  for (const base of ['/System/Library/Sounds', '/Library/Sounds', dir]) {
    for (const extension of SOUND_EXTENSIONS) candidates.push(join(base, `${name}${extension}`))
  }
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate)
      if (!info.isFile()) continue
    } catch {
      continue
    }
    await execFileAsync('/usr/bin/afplay', [candidate])
    return
  }
  throw new Error('找不到声音文件')
}

/** macOS 系统与用户声音目录；读取失败的目录直接忽略 */
async function systemSoundNames() {
  const dirs = [
    '/System/Library/Sounds',
    '/Library/Sounds',
    userSoundsDir(),
  ]
  const names = new Set()
  await Promise.all(dirs.map(async (dir) => {
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile()) continue
        const extension = extname(entry.name).toLowerCase()
        if (SOUND_EXTENSIONS.has(extension)) names.add(basename(entry.name, extension))
      }
    } catch {
      // 目录可能不存在或无读取权限；其余目录仍可用
    }
  }))
  return [...names].sort((a, b) => a.localeCompare(b, 'en'))
}

async function soundCatalog() {
  const [names, managed] = await Promise.all([systemSoundNames(), managedSoundCatalog()])
  return {
    names,
    managed,
    limits: { count: MAX_MANAGED_SOUND_COUNT, bytes: MAX_MANAGED_SOUND_BYTES },
  }
}

function notify(title, body, sound, channel, onResult = () => {}) {
  if (channel === 'osc9') {
    emitOsc9(title, body)
    onResult(null)
    return
  }
  execFile('osascript', ['-e', buildNotificationScript(title, body, sound)], (err) => {
    if (err) console.warn('[dsh-macos-notify] osascript failed:', err.message)
    onResult(err ?? null)
  })
}

function notifyStartupFailure(err, sound = 'Basso') {
  const detail = String(err?.message ?? err ?? '未知错误').replace(/\s+/g, ' ').trim().slice(0, 180)
  notify('DSH', `macOS 通知插件加载失败：${detail || '未知错误'}`, sound, 'osascript')
}

// —— OSC 9 通道（思路参考 kimi-code 的 terminal-notification.ts）——

/** 认识 OSC 9 桌面通知的终端白名单；不认识 OSC 9 的终端收到转义序列会打印乱码，所以必须保守 */
function supportsOsc9(env = process.env) {
  const termProgram = env.TERM_PROGRAM ?? ''
  if (['iTerm.app', 'WezTerm', 'ghostty', 'WarpTerminal'].includes(termProgram)) return true
  const term = env.TERM ?? ''
  return term === 'xterm-kitty' || term === 'xterm-ghostty'
}

/** 剥掉控制字符，避免污染终端 */
function sanitizeOsc9(s) {
  return String(s).replace(/[\x00-\x1f\x7f]/g, ' ').trim()
}

function emitOsc9(title, body) {
  const truncated = truncateNotification(title, body)
  const message = [truncated.title, truncated.body].map(sanitizeOsc9).filter(Boolean).join(': ').slice(0, 256)
  if (!message) return
  let seq = `\x1b]9;${message}\x07`
  // tmux 会吞掉 OSC，需要 DCS passthrough 包裹并把载荷里的 ESC 双写
  if (process.env.TMUX) {
    seq = `\x1bPtmux;${seq.replaceAll('\x1b', '\x1b\x1b')}\x1b\\`
  }
  process.stdout.write(seq)
}

/** macOS 键鼠空闲秒数；读不到时返回 0（视为"人在电脑前"，即不抑制通知） */
function idleSeconds() {
  return new Promise((resolve) => {
    execFile('ioreg', ['-c', 'IOHIDSystem', '-d', '1'], (err, stdout) => {
      const m = stdout?.match(/"HIDIdleTime" = (\d+)/)
      resolve(m ? Number(m[1]) / 1e9 : 0)
    })
  })
}

function applyImpl(ctx, config) {
  // 配置三层叠加：schema 默认值 < cordis 组合层（base = 插件 config）< 用户层（设置页）。
  // 设置页写入后经 watch 实时生效，不需要重启。
  const scope = ctx.settings.register('macos-notify', Config, { base: config, applies: 'live' })
  let current = scope.get()

  // sessionId -> 最新标题（session/title 事件是 latest-wins 快照）
  const titles = new Map()
  // sessionId -> 本轮 turn/start 的时间戳，用于算轮次时长
  const turnStartedAt = new Map()
  // 有未关闭轮次的顶层会话，用于「还有 N 个任务进行中」
  const running = new Set()
  // 合并窗口内待发的轮次结束通知（实时通道）
  let pending = []
  let flushTimer = null
  // digest 通道：只攒「完成」；发送时刻绑定在已积累的批次上，设置变更不重置已排定的 deadline
  let digestPending = []
  let digestTimer = null
  let digestDeadline = 0
  // 最近的通知决策，仅保存在当前进程内；设置页用于解释“为什么没弹”。
  let diagnostics = []
  let diagnosticSeq = 0
  // 重复错误键 -> 首次发送时间、被抑制次数
  let duplicates = new DuplicateTracker()
  let projectRules = parseProjectRules(current.projectRulesJson)

  // —— 状态持久化：通知决策、重复合并、会话标题。防抖落盘，退出时立即 flush ——
  const stateFile = stateFilePath()
  let persistTimer = null
  const schedulePersist = () => {
    if (persistTimer) return
    persistTimer = setTimeout(() => {
      persistTimer = null
      saveState(stateFile, {
        diagnostics,
        duplicates: duplicates.toJSON(),
        titles: [...titles.entries()],
      }).catch((err) => console.warn('[dsh-macos-notify] state persist failed:', err?.message ?? err))
    }, 500)
    persistTimer.unref?.()
  }
  const restored = loadStateSync(stateFile)
  if (diagnostics.length === 0 && restored.diagnostics.length) diagnostics = restored.diagnostics
  if (duplicates.size === 0 && restored.duplicates.length) duplicates = DuplicateTracker.fromJSON(restored.duplicates)
  if (titles.size === 0 && restored.titles.length) for (const [id, title] of restored.titles) titles.set(id, title)

  const record = (status, item, detail, extra = {}) => {
    diagnostics.unshift({
      id: ++diagnosticSeq,
      time: Date.now(),
      status,
      kind: item?.kind ?? '系统',
      title: item?.title ?? '',
      label: item?.label ?? '',
      sessionId: item?.sessionId ?? null,
      cwd: item?.cwd ?? null,
      detail,
      channel: resolvedChannel,
      ...extra,
    })
    if (diagnostics.length > MAX_DIAGNOSTICS) diagnostics.length = MAX_DIAGNOSTICS
    schedulePersist()
  }

  // 通知通道：auto 在支持的终端里走 OSC 9（终端自己转系统通知），否则 osascript
  let resolvedChannel = resolveChannel()
  function resolveChannel() {
    return current.channel === 'auto' ? (supportsOsc9() ? 'osc9' : 'osascript') : current.channel
  }
  const send = (title, body, sound, items = [], options = {}) => {
    const representative = items[0] ?? { kind: options.kind ?? '系统', title, label: body }
    notify(title, body, sound, resolvedChannel, (err) => {
      if (err) {
        for (const item of items.length ? items : [representative]) {
          record('error', item, `发送失败：${err.message}`)
        }
        return
      }
      for (const item of items.length ? items : [representative]) {
        record('sent', item, options.detail ?? `已通过 ${resolvedChannel} 发送`)
      }
    })
  }

  // 上报「正在看 dsh tab」的浏览器客户端：id -> 最近一次聚焦上报的时间戳
  const focusedClients = new Map()

  /** 是否有客户端正聚焦在 dsh tab 上（90 秒未上报视为已关闭） */
  const anyFocused = () => {
    const cutoff = Date.now() - 90_000
    for (const [id, at] of focusedClients) {
      if (at < cutoff) focusedClients.delete(id)
    }
    return focusedClients.size > 0
  }

  // 接收浏览器半的焦点上报、试听与设置读写。connection 服务只在 web profile 存在，
  // 用 ctx.inject() 延迟挂载：headless 下回调永不触发（视为无人盯着，通知照发）
  //
  // 注意一：设置读写走自有 RPC 而不是 settings.describe/mutate 线面——
  // dsh-host-apiproxy 对暴露给 Web 的设置命名空间有硬编码白名单
  // （WEB_SETTINGS_NAMESPACES），第三方命名空间目前上不了那条线。
  // 注意二：共享的 /api 通道只允许一个拦截器（已被 api-gateway 占用），
  // 所以用 rpc.handle 注册独立通道 /macos-notify。
  ctx.inject(['connection'], (connCtx) => {
    try {
      connCtx.connection.rpc.handle(
      '/macos-notify',
      async (endpoint, payload) => {
        if (endpoint === 'visibility') {
          const { id, focused } = payload ?? {}
          if (typeof id === 'string') {
            if (focused) focusedClients.set(id, Date.now())
            else focusedClients.delete(id)
          }
          return { ok: true, value: null }
        }
        if (endpoint === 'test') {
          // 测试矩阵绕过勿扰和过滤规则，确保能直接验证系统投递通道。
          const kind = payload?.kind
          if (SOUND_KINDS.includes(kind)) {
            const sound = typeof payload?.sound === 'string' ? payload.sound : current.sounds[kind]
            const labels = {
              completed: ['完成测试', '模拟任务已完成'],
              error: ['错误测试', '模拟任务发生错误'],
              aborted: ['中断测试', '模拟任务已中断'],
              approval: ['审批测试', '模拟工具正在等待审批'],
            }
            const item = { kind: kind === 'approval' ? '审批' : `测试/${kind}`, title: labels[kind][0], label: labels[kind][1] }
            send(labels[kind][0], labels[kind][1], sound, [item], { detail: '设置页测试通知' })
          } else if (kind === 'coalesced') {
            const items = [
              { kind: '完成', title: '合并测试', label: '示例任务 A' },
              { kind: '完成', title: '合并测试', label: '示例任务 B' },
            ]
            send('2 个任务有结果', '2 个完成：示例任务 A、示例任务 B', current.sounds.completed, items, { detail: '设置页合并通知测试' })
          } else if (kind === 'digest') {
            const item = { kind: '完成', title: '摘要测试', label: '3 个示例任务' }
            send('3 个任务完成', '示例任务 A、示例任务 B、示例任务 C', current.sounds.completed, [item], { detail: '设置页摘要通知测试' })
          }
          return { ok: true, value: null }
        }
        if (endpoint === 'sounds') {
          return { ok: true, value: await soundCatalog() }
        }
        if (endpoint === 'sound/import') {
          try {
            const imported = await importSound(payload)
            return { ok: true, value: { name: imported } }
          } catch (err) {
            console.warn('[dsh-macos-notify] sound import failed:', err?.message ?? err)
            return {
              ok: false,
              error: { code: 'internal', message: String(err?.message ?? err), details: {} },
            }
          }
        }
        if (endpoint === 'sound/delete') {
          try {
            const soundName = typeof payload?.name === 'string' ? payload.name : ''
            const inUse = SOUND_KINDS.filter((kind) => current.sounds[kind] === soundName)
            if (inUse.length && payload?.force !== true) {
              return { ok: true, value: { requiresConfirmation: true, inUse } }
            }
            await deleteManagedSound(soundName)
            if (inUse.length) {
              const sounds = { ...current.sounds }
              for (const kind of inUse) sounds[kind] = ''
              await scope.update({ sounds })
            }
            return { ok: true, value: { deleted: true, catalog: await soundCatalog() } }
          } catch (err) {
            return { ok: false, error: { code: 'internal', message: String(err?.message ?? err), details: {} } }
          }
        }
        if (endpoint === 'sound/preview') {
          try {
            await previewSound(typeof payload?.name === 'string' ? payload.name.trim() : '')
            return { ok: true, value: null }
          } catch (err) {
            console.warn('[dsh-macos-notify] sound preview failed:', err?.message ?? err)
            return { ok: false, error: { code: 'internal', message: String(err?.message ?? err), details: {} } }
          }
        }
        if (endpoint === 'diagnostics') {
          const op = payload?.op ?? 'get'
          if (op === 'clear') {
            diagnostics = []
            schedulePersist()
          }
          anyFocused()
          return {
            ok: true,
            value: {
              entries: diagnostics,
              status: {
                channel: resolvedChannel,
                configuredChannel: current.channel,
                focusedTabs: focusedClients.size,
                quietActive: quietHoursActive(current),
                pauseUntil: current.pauseUntil,
                pending: pending.length,
                digestPending: digestPending.length,
                digestDeadline,
              },
            },
          }
        }
        if (endpoint === 'settings') {
          // 设置卡片读写用户层：get 返回解析后的生效值，set 写入一个字段
          const op = payload?.op
          if (op === 'get') return { ok: true, value: scope.get() }
          if (op === 'set' && typeof payload.field === 'string') {
            try {
              await scope.update(validateSettingsPatch({ [payload.field]: payload.value }, current))
              return { ok: true, value: scope.get() }
            } catch (err) {
              return { ok: false, error: { code: 'internal', message: String(err?.message ?? err), details: {} } }
            }
          }
          if (op === 'patch' && payload.value && typeof payload.value === 'object' && !Array.isArray(payload.value)) {
            try {
              await scope.update(validateSettingsPatch(payload.value, current))
              return { ok: true, value: scope.get() }
            } catch (err) {
              return { ok: false, error: { code: 'internal', message: String(err?.message ?? err), details: {} } }
            }
          }
          return { ok: false, error: { code: 'internal', message: 'unknown settings op', details: {} } }
        }
        return { ok: false, error: { code: 'internal', message: 'unknown endpoint', details: {} } }
      },
      { authority: 'trusted-host' },
    )
      console.log('[dsh-macos-notify] RPC intercept mounted')
    } catch (err) {
      console.error('[dsh-macos-notify] RPC intercept failed:', err)
      notifyStartupFailure(err, current.sounds.error)
    }
  })

  const label = (session) =>
    titles.get(session.id) ??
    (session.header?.cwd ? basename(session.header.cwd) : String(session.id).slice(0, 8))

  const runningSuffix = () => {
    const n = running.size
    return n > 0 ? `（还有 ${n} 个任务进行中）` : ''
  }

  const makeItem = (kind, title, body, sound, session) => ({
    kind,
    title,
    body,
    sound,
    label: label(session),
    sessionId: session?.id ?? null,
    cwd: session?.header?.cwd ?? null,
    important: false,
  })

  const applyProjectRule = (item) => {
    const rule = matchingProjectRule(projectRules, item.cwd)
    if (!rule) return true
    if (rule.mode === 'mute') {
      record('suppressed', item, `项目规则已静音：${rule.path}`)
      return false
    }
    if (rule.mode === 'errors' && !isCriticalKind(item.kind)) {
      record('suppressed', item, `项目规则仅允许错误和审批：${rule.path}`)
      return false
    }
    if (rule.mode === 'important') item.important = true
    return true
  }

  const applyTimePolicy = (item) => {
    if (item.important) return true
    if (current.pauseUntil > Date.now()) {
      record('suppressed', item, `通知已暂停至 ${new Date(current.pauseUntil).toLocaleString()}`)
      return false
    }
    if (quietHoursActive(current) && !(current.quietAllowCritical && isCriticalKind(item.kind))) {
      record('suppressed', item, `当前处于勿扰时段 ${current.quietStart}–${current.quietEnd}`)
      return false
    }
    return true
  }

  const applyDuplicatePolicy = (item) => {
    if (!['出错', '被阻止'].includes(item.kind)) return true
    const decision = duplicates.admit(duplicateKey(item), Date.now(), current.duplicateWindowSec * 1000)
    schedulePersist()
    if (!decision.send) {
      record('suppressed', item, `重复通知已合并（本窗口第 ${decision.count} 次）`)
      return false
    }
    if (decision.suffix) item.body += decision.suffix
    return true
  }

  // 键鼠空闲查询要 fork ioreg，5 秒内复用上次结果
  const idleCache = new TtlCache(5000)
  const idleSecondsCached = async () => {
    const cached = idleCache.get(Date.now())
    if (cached.hit) return cached.value
    const idle = await idleSeconds()
    idleCache.set(Date.now(), idle)
    return idle
  }

  // 发送前再检查实时策略；摘要可能在进入队列后才跨入勿扰时段。
  const gateAndNotify = async (items, sendBatch) => {
    let allowed = items.filter(applyTimePolicy)
    if (allowed.length === 0) return
    if (current.onlyWhenUnfocused && anyFocused()) {
      allowed = allowed.filter((item) => {
        if (!isCompletionKind(item.kind) || item.important) return true
        record('suppressed', item, 'DSH Web 页面当前处于聚焦状态')
        return false
      })
    }
    const idleCandidates = allowed.filter((item) => isCompletionKind(item.kind) && !item.important)
    if (current.onlyWhenIdleSec > 0 && idleCandidates.length) {
      const idle = await idleSecondsCached()
      if (idle < current.onlyWhenIdleSec) {
        allowed = allowed.filter((item) => {
          if (!isCompletionKind(item.kind) || item.important) return true
          record('suppressed', item, `键鼠仅空闲 ${Math.floor(idle)} 秒，要求 ${current.onlyWhenIdleSec} 秒`)
          return false
        })
      }
    }
    if (allowed.length) sendBatch(allowed)
  }

  const render = (items) => {
    if (items.length === 1) {
      return { title: items[0].title, body: items[0].body, sound: items[0].sound }
    }
    // 同类合并：N 个完成 / N 个出错；列表取前 3 个标签
    const byKind = Map.groupBy(items, (i) => i.kind)
    const parts = []
    let sound = ''
    for (const [kind, group] of byKind) {
      const names = group.slice(0, 3).map((g) => g.label).join('、')
      const more = group.length > 3 ? ` 等 ${group.length} 个` : ''
      parts.push(`${group.length} 个${kind}：${names}${more}`)
      // 合并通知的声音：有出错优先用出错声，否则用第一条的
      if (!sound || kind === '出错' || kind === '被阻止') sound = group[0].sound
    }
    return { title: `${items.length} 个任务有结果`, body: parts.join('；'), sound }
  }

  const flush = () => {
    flushTimer = null
    const items = pending
    pending = []
    if (items.length === 0) return
    void gateAndNotify(items, (allowed) => {
      const { title, body, sound } = render(allowed)
      send(title, body + runningSuffix(), sound, allowed)
    })
  }

  const flushDigest = () => {
    const items = digestPending
    digestPending = []
    if (items.length === 0) return
    void gateAndNotify(items, (allowed) => {
      const names = allowed.slice(0, 5).map((i) => i.label).join('、')
      const more = allowed.length > 5 ? ` 等 ${allowed.length} 个` : ''
      send(
        `${allowed.length} 个任务完成`,
        `${names}${more}${runningSuffix()}`,
        current.sounds.completed,
        allowed,
      )
    })
  }

  // 摘要按绝对 deadline 触发：入队时排定，设置变更只重挂定时器、不重置等待时间；
  // 关闭摘要时立即发掉已积累的批次，避免通知滞留。
  const armDigest = () => {
    if (digestTimer) {
      clearTimeout(digestTimer)
      digestTimer = null
    }
    if (current.digestMinutes <= 0 || digestPending.length === 0) {
      digestDeadline = 0
      return
    }
    if (!digestDeadline) digestDeadline = Date.now() + current.digestMinutes * 60_000
    digestTimer = setTimeout(() => {
      digestTimer = null
      digestDeadline = 0
      flushDigest()
    }, Math.max(0, digestDeadline - Date.now()))
    digestTimer.unref?.()
  }

  // 设置页写入实时生效：换配置快照、重算通道、按新间隔重挂 digest 定时器
  scope.watch((next) => {
    current = next
    resolvedChannel = resolveChannel()
    projectRules = parseProjectRules(current.projectRulesJson)
    if (current.digestMinutes <= 0 && digestPending.length) flushDigest()
    armDigest()
  })

  const enqueue = (kind, title, body, sound, session, options = {}) => {
    const item = makeItem(kind, title, body, sound, session)
    if (!applyProjectRule(item)) return
    if (isCompletionKind(kind) && options.durationSec < current.minDurationSec && !item.important) {
      record('suppressed', item, `任务耗时 ${options.durationSec.toFixed(1)} 秒，短于 ${current.minDurationSec} 秒`)
      return
    }
    if (!applyDuplicatePolicy(item)) return
    if (isCompletionKind(kind) && current.digestMinutes > 0) {
      digestPending.push(item)
      record('queued', item, `已进入 ${current.digestMinutes} 分钟摘要队列`)
      armDigest()
      return
    }
    if (current.coalesceMs <= 0) {
      void gateAndNotify([item], (allowed) => {
        const { title, body, sound } = render(allowed)
        send(title, body + runningSuffix(), sound, allowed)
      })
      return
    }
    pending.push(item)
    record('queued', item, `等待 ${current.coalesceMs} 毫秒合并窗口`)
    if (!flushTimer) flushTimer = setTimeout(flush, current.coalesceMs)
  }

  ctx.on('session/event', (session, event) => {
    if (event.type === 'session/title') {
      // 标题按会话累积，封顶避免长驻进程缓慢泄漏
      if (titles.size >= 200) titles.delete(titles.keys().next().value)
      titles.set(session.id, event.data.title)
      schedulePersist()
      return
    }

    if (!current.includeSubagents && session.header?.origin === 'subagent') {
      if (event.type === 'turn/end' || event.type === 'approval/asked') {
        record('suppressed', makeItem('子 Agent', '通知已过滤', label(session), '', session), '配置已排除子 Agent 会话')
      }
      return
    }

    if (event.type === 'turn/start') {
      running.add(session.id)
      turnStartedAt.set(session.id, event.time)
      return
    }

    if (event.type === 'turn/end') {
      running.delete(session.id)
      const startedAt = turnStartedAt.get(session.id)
      turnStartedAt.delete(session.id)
      const durationSec = startedAt ? (event.time - startedAt) / 1000 : Infinity

      const kind = event.data.reason?.kind
      const name = label(session)
      if (kind === 'completed') {
        if (current.onCompleted) enqueue('完成', '任务完成', name, current.sounds.completed, session, { durationSec })
        else record('suppressed', makeItem('完成', '任务完成', name, current.sounds.completed, session), '完成通知已关闭')
      } else if (kind === 'aborted') {
        if (current.onAborted) enqueue('中断', '任务已中断', name, current.sounds.aborted, session)
        else record('suppressed', makeItem('中断', '任务已中断', name, current.sounds.aborted, session), '中断通知已关闭')
      } else if (kind === 'blocked') {
        if (current.onError) enqueue('被阻止', '任务被阻止', name, current.sounds.error, session)
        else record('suppressed', makeItem('被阻止', '任务被阻止', name, current.sounds.error, session), '错误通知已关闭')
      } else if (kind === 'error' && current.onError) {
        const err = event.data.reason?.error
        if (err?.code === 'RATE_LIMIT' || err?.status === 429) {
          const retry = err.providerRetryAfterMs
            ? `，服务商建议 ${Math.ceil(err.providerRetryAfterMs / 1000)} 秒后重试`
            : ''
          enqueue('出错', 'API 限流', `${name}: 请求被限流（429）${retry}`, current.sounds.error, session)
        } else {
          const msg = err?.message ?? '未知错误'
          enqueue('出错', '任务出错', `${name}: ${msg}`, current.sounds.error, session)
        }
      } else if (kind === 'error') {
        record('suppressed', makeItem('出错', '任务出错', name, current.sounds.error, session), '错误通知已关闭')
      }
      return
    }

    if (event.type === 'approval/asked' && current.onApproval) {
      // 审批需要人处理，立即发，不合并
      const reason = event.data.reason ? ` — ${event.data.reason}` : ''
      const item = makeItem('审批', '等待审批', `${label(session)}: ${event.data.toolName}${reason}`, current.sounds.approval, session)
      if (applyProjectRule(item)) {
        void gateAndNotify([item], (allowed) => {
          const { title, body, sound } = render(allowed)
          send(title, body, sound, allowed)
        })
      }
    } else if (event.type === 'approval/asked') {
      record('suppressed', makeItem('审批', '等待审批', label(session), current.sounds.approval, session), '审批通知已关闭')
    }
  })

  // 卸载时清掉未发出的通知，避免插件已卸载还弹通知
  ctx.effect(() => () => {
    if (flushTimer) clearTimeout(flushTimer)
    if (digestTimer) clearInterval(digestTimer)
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    saveState(stateFile, {
      diagnostics,
      duplicates: duplicates.toJSON(),
      titles: [...titles.entries()],
    }).catch(() => {})
  })
}

export function apply(ctx, config) {
  try {
    return applyImpl(ctx, config)
  } catch (err) {
    console.error('[dsh-macos-notify] plugin initialization failed:', err)
    notifyStartupFailure(err, config?.sounds?.error)
    throw err
  }
}
