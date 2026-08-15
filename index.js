import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-macos-notify'
export const inject = ['sessions']

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
  /** 各事件类型的通知声音（macOS 声音名，空串为静音） */
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

function esc(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function notify(title, body, sound) {
  const soundPart = sound ? ` sound name "${esc(sound)}"` : ''
  const script = `display notification "${esc(body)}" with title "${esc(title)}"${soundPart}`
  execFile('osascript', ['-e', script], (err) => {
    if (err) console.warn('[dsh-macos-notify] osascript failed:', err.message)
  })
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

  // 接收浏览器半的焦点上报。connection 服务只在 web profile 存在，
  // 用 ctx.inject() 延迟挂载：headless 下回调永不触发（视为无人盯着，通知照发）
  ctx.inject(['connection'], (connCtx) => {
    connCtx.connection.rpc.intercept(
      '/api',
      (endpoint) => endpoint === 'macos-notify/visibility',
      async (_endpoint, payload) => {
        const { id, focused } = payload ?? {}
        if (typeof id === 'string') {
          if (focused) focusedClients.set(id, Date.now())
          else focusedClients.delete(id)
        }
        return { ok: true, value: null }
      },
      { authority: 'trusted-host' },
    )
  })

  const label = (session) =>
    titles.get(session.id) ??
    (session.header?.cwd ? basename(session.header.cwd) : String(session.id).slice(0, 8))

  const runningSuffix = () => {
    const n = running.size
    return n > 0 ? `（还有 ${n} 个任务进行中）` : ''
  }

  // 「完成」类（纯 completed 的一批）过两道闸：焦点抑制 + 键鼠空闲抑制
  const gateAndNotify = async (items, send) => {
    if (items.every((i) => i.kind === '完成')) {
      if (config.onlyWhenUnfocused && anyFocused()) return
      if (config.onlyWhenIdleSec > 0) {
        const idle = await idleSeconds()
        if (idle < config.onlyWhenIdleSec) return
      }
    }
    send()
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
      notify(title, body + runningSuffix(), sound)
    })
  }

  const flushDigest = () => {
    const items = digestPending
    digestPending = []
    if (items.length === 0) return
    void gateAndNotify(items, () => {
      const names = items.slice(0, 5).map((i) => i.label).join('、')
      const more = items.length > 5 ? ` 等 ${items.length} 个` : ''
      notify(
        `${items.length} 个任务完成`,
        `${names}${more}${runningSuffix()}`,
        config.sounds.completed,
      )
    })
  }

  // digest 定时器常驻，到点攒了多少发多少；卸载时统一清理
  const digestTimer = config.digestMinutes > 0
    ? setInterval(flushDigest, config.digestMinutes * 60_000)
    : null

  const enqueue = (kind, title, body, sound, session) => {
    if (kind === '完成' && config.digestMinutes > 0) {
      digestPending.push({ kind, title, body, sound, label: label(session) })
      return
    }
    if (config.coalesceMs <= 0) {
      void gateAndNotify([{ kind, title, body, sound, label: label(session) }], () => {
        notify(title, body + runningSuffix(), sound)
      })
      return
    }
    pending.push({ kind, title, body, sound, label: label(session) })
    if (!flushTimer) flushTimer = setTimeout(flush, config.coalesceMs)
  }

  if (config.notifyOnLoad) {
    notify('DSH', 'macOS 通知插件已加载', config.sounds.completed)
  }

  ctx.on('session/event', (session, event) => {
    if (event.type === 'session/title') {
      titles.set(session.id, event.data.title)
      return
    }

    if (!config.includeSubagents && session.header?.origin === 'subagent') return

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
      if (kind === 'completed' && config.onCompleted) {
        // 秒级完成的轮次大概率正被盯着看，不打扰
        if (durationSec < config.minDurationSec) return
        enqueue('完成', '任务完成', name, config.sounds.completed, session)
      } else if (kind === 'aborted' && config.onAborted) {
        enqueue('中断', '任务已中断', name, config.sounds.aborted, session)
      } else if (kind === 'blocked' && config.onError) {
        enqueue('被阻止', '任务被阻止', name, config.sounds.error, session)
      } else if (kind === 'error' && config.onError) {
        const err = event.data.reason?.error
        if (err?.code === 'RATE_LIMIT' || err?.status === 429) {
          const retry = err.providerRetryAfterMs
            ? `，服务商建议 ${Math.ceil(err.providerRetryAfterMs / 1000)} 秒后重试`
            : ''
          enqueue('出错', 'API 限流', `${name}: 请求被限流（429）${retry}`, config.sounds.error, session)
        } else {
          const msg = err?.message ?? '未知错误'
          enqueue('出错', '任务出错', `${name}: ${msg}`, config.sounds.error, session)
        }
      }
      return
    }

    if (event.type === 'approval/asked' && config.onApproval) {
      // 审批需要人处理，立即发，不合并
      const reason = event.data.reason ? ` — ${event.data.reason}` : ''
      notify('等待审批', `${label(session)}: ${event.data.toolName}${reason}`, config.sounds.approval)
    }
  })

  // 卸载时清掉未发出的通知，避免插件已卸载还弹通知
  ctx.effect(() => () => {
    if (flushTimer) clearTimeout(flushTimer)
    if (digestTimer) clearInterval(digestTimer)
  })
}
