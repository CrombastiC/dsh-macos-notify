// 通知决策历史、重复合并状态、会话标题的磁盘持久化。
// 文件缺失或损坏一律按空状态处理，绝不让坏文件拖垮通知插件。
import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const STATE_VERSION = 1
export const MAX_PERSISTED_DIAGNOSTICS = 50
export const MAX_PERSISTED_DUPLICATES = 500
export const MAX_PERSISTED_TITLES = 200

/** 校验并收敛状态；各字段独立取舍，坏条目丢弃而不是整体作废 */
export function sanitizeState(raw) {
  const state = { diagnostics: [], duplicates: [], titles: [] }
  if (!raw || typeof raw !== 'object') return state
  if (Array.isArray(raw.diagnostics)) {
    state.diagnostics = raw.diagnostics
      .filter((item) => item && typeof item === 'object')
      .slice(0, MAX_PERSISTED_DIAGNOSTICS)
  }
  if (Array.isArray(raw.duplicates)) {
    state.duplicates = raw.duplicates.slice(0, MAX_PERSISTED_DUPLICATES).flatMap((entry) => {
      const value = Array.isArray(entry) ? entry[1] : null
      if (!entry || typeof entry[0] !== 'string' || !value
        || typeof value.at !== 'number' || typeof value.count !== 'number') return []
      return [[entry[0], { at: value.at, count: value.count }]]
    })
  }
  if (Array.isArray(raw.titles)) {
    state.titles = raw.titles
      .slice(-MAX_PERSISTED_TITLES)
      .flatMap((entry) => (
        Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string'
          ? [[entry[0], entry[1]]]
          : []
      ))
  }
  return state
}

/** 初始化时同步读取：保证恢复完成后再处理任何事件，不存在恢复与事件的竞态 */
export function loadStateSync(file) {
  try {
    return sanitizeState(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return { diagnostics: [], duplicates: [], titles: [] }
  }
}

/** 先写临时文件再 rename，避免崩溃留下半个 JSON */
export async function saveState(file, state) {
  const clean = sanitizeState(state)
  const payload = JSON.stringify({ version: STATE_VERSION, ...clean }, null, 2)
  const temp = `${file}.tmp`
  await mkdir(dirname(file), { recursive: true })
  await writeFile(temp, payload, { mode: 0o600 })
  await rename(temp, file)
}
