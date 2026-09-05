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

/** 重复指纹归一化：只收敛已知易变片段（UUID、长 token、带单位的数量/时长），
 *  裸数字（状态码、端口、行号）原样保留，避免把不同错误合并成同一个 */
export function normalizeDuplicateText(text) {
  let value = String(text ?? '').replace(/\s+/g, ' ').trim()
  value = value.replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, '<uuid>')
  value = value.replace(/(?<![0-9a-zA-Z_])[0-9a-fA-F]{16,}(?![0-9a-zA-Z_])/gi, '<token>')
  value = value.replace(/(\d+(?:\.\d+)?)\s*(毫秒|秒|分钟|小时|次|个|MB|KB|GB|ms|s|min|seconds?|secs?)(?![0-9a-zA-Z_])/gi, '<n> $2')
  return value.length > 500 ? value.slice(0, 500) : value
}

export function duplicateKey(item) {
  return `${item.sessionId ?? ''}\u0000${item.kind}\u0000${normalizeDuplicateText(item.body)}`
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

/** 声音事件字段；服务端与客户端共享同一集合 */
export const SOUND_KINDS = ['completed', 'error', 'aborted', 'approval']

export const MAX_NOTIFICATION_TITLE = 120
export const MAX_NOTIFICATION_BODY = 500

/** 通知文案截断（内容策略）：标题/正文各自封顶并加省略号；通道级的总长限制另算 */
export function truncateNotification(title, body) {
  const trim = (value, max) => {
    const text = String(value ?? '')
    return text.length > max ? `${text.slice(0, max - 1)}…` : text
  }
  return { title: trim(title, MAX_NOTIFICATION_TITLE), body: trim(body, MAX_NOTIFICATION_BODY) }
}

/** AppleScript 字符串转义 + 通知脚本组装；换行会截断 display notification 的字面量，压成空格 */
export function buildNotificationScript(title, body, sound) {
  const truncated = truncateNotification(title, body)
  const clean = (value) => String(value).replace(/\r?\n/g, ' ')
  const quote = (value) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const soundPart = sound ? ` sound name "${quote(sound)}"` : ''
  return `display notification "${quote(clean(truncated.body))}" with title "${quote(clean(truncated.title))}"${soundPart}`
}

/** settings set/patch 共用的可编辑字段与校验（服务端唯一真相；客户端只做输入提示） */
export const EDITABLE_SETTINGS = new Set([
  'onCompleted', 'onError', 'onAborted', 'onApproval', 'minDurationSec',
  'onlyWhenIdleSec', 'onlyWhenUnfocused', 'digestMinutes', 'includeSubagents',
  'channel', 'sounds', 'coalesceMs', 'quietHoursEnabled', 'quietStart', 'quietEnd',
  'quietAllowCritical', 'pauseUntil', 'duplicateWindowSec', 'projectRulesJson',
])
/** 数值字段的合法区间（与客户端 NUMBER_BOUNDS 一致，服务端强制执行） */
export const NUMBER_BOUNDS = {
  minDurationSec: [0, 3600],
  onlyWhenIdleSec: [0, 3600],
  digestMinutes: [0, 1440],
  coalesceMs: [0, 60000],
  duplicateWindowSec: [0, 86400],
}
const BOOLEAN_SETTINGS = new Set([
  'onCompleted', 'onError', 'onAborted', 'onApproval',
  'onlyWhenUnfocused', 'includeSubagents', 'quietHoursEnabled', 'quietAllowCritical',
])
const CHANNELS = new Set(['auto', 'osascript', 'osc9'])

export function assertProjectRulesJson(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('项目规则格式无效')
  }
  if (!Array.isArray(parsed) || parsed.length > 50) throw new Error('项目规则格式无效')
  if (parsed.some((rule) => typeof rule?.path !== 'string' || !['mute', 'errors', 'important'].includes(rule?.mode))) {
    throw new Error('项目规则格式无效')
  }
  return raw
}

function validateSettingsField(field, value, current) {
  if (BOOLEAN_SETTINGS.has(field)) {
    if (typeof value !== 'boolean') throw new Error(`${field} 必须为布尔值`)
    return value
  }
  if (NUMBER_BOUNDS[field]) {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field} 必须为有限数值`)
    const [min, max] = NUMBER_BOUNDS[field]
    if (value < min || value > max) throw new Error(`${field} 超出范围 [${min}, ${max}]`)
    return value
  }
  if (field === 'pauseUntil') {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('pauseUntil 必须为非负数值')
    return value
  }
  if (field === 'channel') {
    if (!CHANNELS.has(value)) throw new Error('channel 取值无效')
    return value
  }
  if (field === 'quietStart' || field === 'quietEnd') {
    if (minuteOfDay(value) === null) throw new Error('勿扰时间格式无效')
    return value
  }
  if (field === 'sounds') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('sounds 格式无效')
    for (const [kind, name] of Object.entries(value)) {
      if (!SOUND_KINDS.includes(kind)) throw new Error(`未知的声音字段：${kind}`)
      if (typeof name !== 'string') throw new Error(`声音 ${kind} 必须为字符串`)
    }
    return { ...(current?.sounds ?? {}), ...value }
  }
  if (field === 'projectRulesJson') {
    if (typeof value !== 'string') throw new Error('项目规则格式无效')
    return assertProjectRulesJson(value)
  }
  throw new Error(`不可编辑的设置字段：${field}`)
}

/** 校验并归一化设置 patch；set 端点用单字段对象调用同一入口 */
export function validateSettingsPatch(patch, current = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('设置格式无效')
  const normalized = {}
  for (const [field, value] of Object.entries(patch)) {
    if (!EDITABLE_SETTINGS.has(field)) throw new Error('包含不可编辑的设置字段')
    normalized[field] = validateSettingsField(field, value, current)
  }
  return normalized
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
