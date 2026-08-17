import { execFile } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { promisify } from 'node:util'
import Schema from '@deepseek-ai/schemastery'

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
  /** 插件加载时发一条测试通知 */
  notifyOnLoad: Schema.boolean().default(true),
})

/** 设置页可编辑的提示音字段 */
const SOUND_KINDS = ['completed', 'error', 'aborted', 'approval']
const SOUND_EXTENSIONS = new Set(['.aif', '.aiff', '.caf', '.m4a', '.wav'])
const IMPORT_EXTENSIONS = new Set([
  '.aac', '.aif', '.aiff', '.caf', '.flac', '.m4a', '.mp3', '.oga', '.ogg', '.opus', '.wav',
])
const MAX_SOUND_BYTES = 5 * 1024 * 1024
const MAX_SOUND_DURATION_SEC = 10
const execFileAsync = promisify(execFile)

function userSoundsDir() {
  return join(homedir(), 'Library/Sounds')
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
    const destination = await availableSoundPath(name)
    await copyFile(output, destination.path, fsConstants.COPYFILE_EXCL)
    await chmod(destination.path, 0o644)
    return destination.candidateName
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
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

function esc(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function notify(title, body, sound, channel) {
  if (channel === 'osc9') {
    emitOsc9(title, body)
    return
  }
  const soundPart = sound ? ` sound name "${esc(sound)}"` : ''
  const script = `display notification "${esc(body)}" with title "${esc(title)}"${soundPart}`
  execFile('osascript', ['-e', script], (err) => {
    if (err) console.warn('[dsh-macos-notify] osascript failed:', err.message)
  })
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
  const message = [title, body].map(sanitizeOsc9).filter(Boolean).join(': ').slice(0, 256)
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

export function apply(ctx, config) {
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
  // digest 通道：只攒「完成」
  let digestPending = []
  let digestTimer = null

  // 通知通道：auto 在支持的终端里走 OSC 9（终端自己转系统通知），否则 osascript
  let resolvedChannel = resolveChannel()
  function resolveChannel() {
    return current.channel === 'auto' ? (supportsOsc9() ? 'osc9' : 'osascript') : current.channel
  }
  const send = (title, body, sound) => notify(title, body, sound, resolvedChannel)

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
          // 设置页的「试听」按钮，立即发一条带对应提示音的测试通知
          const kind = payload?.kind
          if (SOUND_KINDS.includes(kind)) {
            const sound = typeof payload?.sound === 'string' ? payload.sound : current.sounds[kind]
            send('试听', `这是「${kind}」事件的提示音`, sound)
          }
          return { ok: true, value: null }
        }
        if (endpoint === 'sounds') {
          return { ok: true, value: await systemSoundNames() }
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
        if (endpoint === 'settings') {
          // 设置卡片读写用户层：get 返回解析后的生效值，set 写入一个字段
          const op = payload?.op
          if (op === 'get') return { ok: true, value: scope.get() }
          if (op === 'set' && typeof payload.field === 'string') {
            try {
              await scope.update({ [payload.field]: payload.value })
              return { ok: true, value: null }
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
    }
  })

  const label = (session) =>
    titles.get(session.id) ??
    (session.header?.cwd ? basename(session.header.cwd) : String(session.id).slice(0, 8))

  const runningSuffix = () => {
    const n = running.size
    return n > 0 ? `（还有 ${n} 个任务进行中）` : ''
  }

  // 「完成」类（纯 completed 的一批）过两道闸：焦点抑制 + 键鼠空闲抑制
  const gateAndNotify = async (items, sendBatch) => {
    if (items.every((i) => i.kind === '完成')) {
      if (current.onlyWhenUnfocused && anyFocused()) return
      if (current.onlyWhenIdleSec > 0) {
        const idle = await idleSeconds()
        if (idle < current.onlyWhenIdleSec) return
      }
    }
    sendBatch()
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
    void gateAndNotify(items, () => {
      const { title, body, sound } = render(items)
      send(title, body + runningSuffix(), sound)
    })
  }

  const flushDigest = () => {
    const items = digestPending
    digestPending = []
    if (items.length === 0) return
    void gateAndNotify(items, () => {
      const names = items.slice(0, 5).map((i) => i.label).join('、')
      const more = items.length > 5 ? ` 等 ${items.length} 个` : ''
      send(
        `${items.length} 个任务完成`,
        `${names}${more}${runningSuffix()}`,
        current.sounds.completed,
      )
    })
  }

  const setupDigest = () => {
    if (digestTimer) {
      clearInterval(digestTimer)
      digestTimer = null
    }
    if (current.digestMinutes > 0) {
      digestTimer = setInterval(flushDigest, current.digestMinutes * 60_000)
    }
  }
  setupDigest()

  // 设置页写入实时生效：换配置快照、重算通道、按新间隔重建 digest 定时器
  scope.watch((next) => {
    current = next
    resolvedChannel = resolveChannel()
    setupDigest()
  })

  const enqueue = (kind, title, body, sound, session) => {
    if (kind === '完成' && current.digestMinutes > 0) {
      digestPending.push({ kind, title, body, sound, label: label(session) })
      return
    }
    if (current.coalesceMs <= 0) {
      void gateAndNotify([{ kind, title, body, sound, label: label(session) }], () => {
        send(title, body + runningSuffix(), sound)
      })
      return
    }
    pending.push({ kind, title, body, sound, label: label(session) })
    if (!flushTimer) flushTimer = setTimeout(flush, current.coalesceMs)
  }

  if (current.notifyOnLoad) {
    send('DSH', 'macOS 通知插件已加载', current.sounds.completed)
  }

  ctx.on('session/event', (session, event) => {
    if (event.type === 'session/title') {
      titles.set(session.id, event.data.title)
      return
    }

    if (!current.includeSubagents && session.header?.origin === 'subagent') return

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
      if (kind === 'completed' && current.onCompleted) {
        // 秒级完成的轮次大概率正被盯着看，不打扰
        if (durationSec < current.minDurationSec) return
        enqueue('完成', '任务完成', name, current.sounds.completed, session)
      } else if (kind === 'aborted' && current.onAborted) {
        enqueue('中断', '任务已中断', name, current.sounds.aborted, session)
      } else if (kind === 'blocked' && current.onError) {
        enqueue('被阻止', '任务被阻止', name, current.sounds.error, session)
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
      }
      return
    }

    if (event.type === 'approval/asked' && current.onApproval) {
      // 审批需要人处理，立即发，不合并
      const reason = event.data.reason ? ` — ${event.data.reason}` : ''
      send('等待审批', `${label(session)}: ${event.data.toolName}${reason}`, current.sounds.approval)
    }
  })

  // 卸载时清掉未发出的通知，避免插件已卸载还弹通知
  ctx.effect(() => () => {
    if (flushTimer) clearTimeout(flushTimer)
    if (digestTimer) clearInterval(digestTimer)
  })
}
