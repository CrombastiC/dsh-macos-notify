// 纯策略函数：时间窗、项目规则、重复合并。不碰 IO，便于脱离插件宿主单测。
import { resolve } from 'node:path'

/** 关键事件：勿扰时段和「errors」项目规则下仍然放行 */
export function isCriticalKind(kind) {
  return kind === '出错' || kind === '被阻止' || kind === '审批'
}

/** 「完成类」通知：唯一受 最短耗时 / 聚焦 / 空闲 / 摘要 过滤约束的类型 */
export function isCompletionKind(kind) {
  return kind === '完成'
}

/** 本机 HH:mm -> 当日分钟数；格式无效返回 null */
export function minuteOfDay(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value))
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return hour * 60 + minute
}

/** 每日勿扰是否生效；支持跨午夜区间，start === end 视为未配置 */
export function quietHoursActive(config, now = new Date()) {
  if (!config.quietHoursEnabled) return false
  const start = minuteOfDay(config.quietStart)
  const end = minuteOfDay(config.quietEnd)
  if (start === null || end === null || start === end) return false
  const currentMinute = now.getHours() * 60 + now.getMinutes()
  return start < end
    ? currentMinute >= start && currentMinute < end
    : currentMinute >= start || currentMinute < end
}

/** 项目规则 JSON -> [{ path, mode }]；非法项丢弃，最多 50 条，相对路径按本进程 cwd 解析 */
export function parseProjectRules(raw) {
  try {
    const value = JSON.parse(raw)
    if (!Array.isArray(value)) return []
    return value.slice(0, 50).flatMap((item) => {
      const path = typeof item?.path === 'string' ? item.path.trim() : ''
      const mode = item?.mode
      if (!path || !['mute', 'errors', 'important'].includes(mode)) return []
      return [{ path: resolve(path), mode }]
    })
  } catch {
    return []
  }
}

/** 命中 cwd 的最具体规则；前缀比较要求完整路径段，避免 /tmp 误匹配 /tmpx */
export function matchingProjectRule(rules, cwd) {
  if (!cwd) return null
  const target = resolve(cwd)
  return rules
    .filter((rule) => target === rule.path || target.startsWith(`${rule.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0] ?? null
}

export function duplicateKey(item) {
  return `${item.sessionId ?? ''}\u0000${item.kind}\u0000${item.body}`
}

/**
 * 重复通知合并器：相同 key 在窗口内只发第一条；窗口过期后的第一条会带上
 * 「此前重复 N 次」的汇总。窗口按条目各自的首次发送时间独立计算。
 */
export class DuplicateTracker {
  #entries = new Map()

  /**
   * @param {string} key 重复判定键
   * @param {number} now 当前时间戳（毫秒），显式传入便于测试
   * @param {number} windowMs 抑制窗口毫秒数；<=0 时直通且不记录状态
   * @returns {{ send: boolean, count?: number, suffix: string }}
   *   send=false 时 count 为本窗口内已合并次数；send=true 时 suffix 需追加到正文（可为空串）
   */
  admit(key, now, windowMs) {
    if (!(windowMs > 0)) return { send: true, suffix: '' }
    const previous = this.#entries.get(key)
    if (previous && now - previous.at < windowMs) {
      previous.count += 1
      return { send: false, count: previous.count }
    }
    const suffix = previous?.count ? `（此前重复 ${previous.count} 次）` : ''
    this.#entries.set(key, { at: now, count: 0 })
    const threshold = Math.max(windowMs * 2, 60_000)
    for (const [candidate, value] of this.#entries) {
      if (now - value.at > threshold) this.#entries.delete(candidate)
    }
    return { send: true, suffix }
  }

  get size() {
    return this.#entries.size
  }

  /** 供持久化：[key, { at, count }] 数组 */
  toJSON() {
    return [...this.#entries.entries()]
  }

  static fromJSON(entries) {
    const tracker = new DuplicateTracker()
    for (const [key, value] of entries) tracker.#entries.set(key, value)
    return tracker
  }
}

/** AppleScript 字符串转义 + 通知脚本组装；换行会截断 display notification 的字面量，压成空格 */
export function buildNotificationScript(title, body, sound) {
  const clean = (value) => String(value).replace(/\r?\n/g, ' ')
  const quote = (value) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const soundPart = sound ? ` sound name "${quote(sound)}"` : ''
  return `display notification "${quote(clean(body))}" with title "${quote(clean(title))}"${soundPart}`
}

/** 极简 TTL 缓存：命中返回 { hit: true, value }，过期或未填充返回 { hit: false } */
export class TtlCache {
  constructor(ttlMs) {
    this.ttlMs = ttlMs
    this.value = null
    this.at = 0
    this.filled = false
  }

  get(now) {
    return this.filled && now - this.at < this.ttlMs ? { hit: true, value: this.value } : { hit: false, value: null }
  }

  set(now, value) {
    this.at = now
    this.value = value
    this.filled = true
  }
}
