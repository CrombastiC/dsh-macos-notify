import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../index.js'

const defaults = {
  onCompleted: true,
  onError: true,
  onAborted: false,
  onApproval: true,
  minDurationSec: 30,
  onlyWhenIdleSec: 0,
  onlyWhenUnfocused: false,
  digestMinutes: 0,
  includeSubagents: false,
  channel: 'osascript',
  sounds: { completed: '', error: '', aborted: '', approval: '' },
  coalesceMs: 0,
  quietHoursEnabled: false,
  quietStart: '23:00',
  quietEnd: '08:00',
  quietAllowCritical: true,
  pauseUntil: 0,
  duplicateWindowSec: 300,
  projectRulesJson: '[]',
  notifyOnLoad: false,
}

let harnessSeq = 0

function createHarness(overrides = {}) {
  let config = { ...defaults, ...overrides }
  let watcher = () => {}
  let eventHandler
  let rpcHandler
  const scope = {
    get: () => config,
    update: async (patch) => {
      config = { ...config, ...patch }
      watcher(config)
    },
    watch: (callback) => { watcher = callback },
  }
  const ctx = {
    settings: { register: () => scope },
    inject: (_services, callback) => callback({
      connection: { rpc: { handle: (_path, handler) => { rpcHandler = handler } } },
    }),
    on: (_event, callback) => { eventHandler = callback },
    effect: () => {},
  }
  // 状态文件按 harness 隔离：测试互不串写，也绝不落真实用户目录；
  // 测试自行预设 DSH_MACOS_NOTIFY_STATE_FILE 时（持久化用例跨 harness 共享）沿用并还原
  const presetStateFile = process.env.DSH_MACOS_NOTIFY_STATE_FILE
  process.env.DSH_MACOS_NOTIFY_STATE_FILE = presetStateFile
    || join(tmpdir(), `dsh-notify-harness-${process.pid}-${++harnessSeq}.json`)
  apply(ctx, config)
  if (presetStateFile === undefined) delete process.env.DSH_MACOS_NOTIFY_STATE_FILE
  else process.env.DSH_MACOS_NOTIFY_STATE_FILE = presetStateFile
  return {
    emit: (session, event) => eventHandler(session, event),
    rpc: (endpoint, payload) => rpcHandler(endpoint, payload),
  }
}

const session = { id: 'session-test', header: { cwd: '/tmp/project' } }

test('registers the Web UI as a first-level settings section', () => {
  const clientSource = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const hostSource = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.match(clientSource, /ctx\.slots\.inject\('settings\.section'/)
  assert.match(clientSource, /name: 'settings\.section'/)
  assert.match(clientSource, /label: 'macOS 通知'/)
  assert.doesNotMatch(clientSource, /settings\.plugin\.item/)
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'))
  assert.doesNotMatch(hostSource, /macOS 通知插件已加载/)
  assert.match(hostSource, /macOS 通知插件加载失败/)
})

test('records minimum-duration suppression', async () => {
  const app = createHarness({ minDurationSec: 30 })
  app.emit(session, { type: 'turn/start', time: 1_000, data: {} })
  app.emit(session, { type: 'turn/end', time: 3_000, data: { reason: { kind: 'completed' } } })
  const result = await app.rpc('diagnostics', { op: 'get' })
  assert.equal(result.value.entries[0].status, 'suppressed')
  assert.match(result.value.entries[0].detail, /短于 30 秒/)
})

test('records temporary-pause suppression', async () => {
  const app = createHarness({ minDurationSec: 0, pauseUntil: Date.now() + 60_000 })
  app.emit(session, { type: 'turn/start', time: 1_000, data: {} })
  app.emit(session, { type: 'turn/end', time: 3_000, data: { reason: { kind: 'completed' } } })
  await new Promise((resolve) => setImmediate(resolve))
  const result = await app.rpc('diagnostics', { op: 'get' })
  assert.equal(result.value.entries[0].status, 'suppressed')
  assert.match(result.value.entries[0].detail, /通知已暂停/)
})

test('project mute rule suppresses matching descendants', async () => {
  const app = createHarness({
    minDurationSec: 0,
    projectRulesJson: JSON.stringify([{ path: '/tmp', mode: 'mute' }]),
  })
  app.emit(session, { type: 'turn/start', time: 1_000, data: {} })
  app.emit(session, { type: 'turn/end', time: 3_000, data: { reason: { kind: 'completed' } } })
  const result = await app.rpc('diagnostics', { op: 'get' })
  assert.match(result.value.entries[0].detail, /项目规则已静音/)
})

test('repeated errors are coalesced inside the configured window', async () => {
  const app = createHarness({ pauseUntil: Date.now() + 60_000 })
  const errorEvent = { type: 'turn/end', time: 3_000, data: { reason: { kind: 'error', error: { message: 'same failure' } } } }
  app.emit(session, errorEvent)
  app.emit(session, errorEvent)
  await new Promise((resolve) => setImmediate(resolve))
  const result = await app.rpc('diagnostics', { op: 'get' })
  assert.ok(result.value.entries.some((entry) => /重复通知已合并/.test(entry.detail)))
})

test('settings patch rejects invalid project rules', async () => {
  const app = createHarness()
  const result = await app.rpc('settings', {
    op: 'patch',
    value: { projectRulesJson: JSON.stringify([{ path: '/tmp', mode: 'unknown' }]) },
  })
  assert.equal(result.ok, false)
  assert.match(result.error.message, /项目规则格式无效/)
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 捕获 osc9 通道真正投递的通知文本：record 只记状态，看不到正文 */
const OSC_MARK = String.fromCharCode(0x1b)
const OSC_TMUX_RE = new RegExp(OSC_MARK + '(Ptmux;)?', 'g')
const OSC_CTRL_RE = new RegExp('[' + OSC_MARK + String.fromCharCode(0x07) + ']', 'g')

async function withOsc(fn) {
  const chunks = []
  const original = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk, ...rest) => {
    if (typeof chunk === 'string' && chunk.includes(OSC_MARK + ']9;')) chunks.push(chunk)
    return original(chunk, ...rest)
  }
  try {
    await fn()
    return chunks.map((raw) => raw.replace(OSC_TMUX_RE, '').replace(OSC_CTRL_RE, '').trim())
  } finally {
    process.stdout.write = original
  }
}

test('aborted notifications ignore the focus gate', async () => {
  const app = createHarness({ onAborted: true, minDurationSec: 0, onlyWhenUnfocused: true, channel: 'osc9' })
  await app.rpc('visibility', { id: 'tab-1', focused: true })
  const messages = await withOsc(async () => {
    app.emit(session, { type: 'turn/end', time: 1_000, data: { reason: { kind: 'aborted' } } })
    app.emit(session, { type: 'turn/start', time: 2_000, data: {} })
    app.emit(session, { type: 'turn/end', time: 3_000, data: { reason: { kind: 'completed' } } })
  })
  const result = await app.rpc('diagnostics', { op: 'get' })
  const byKind = Object.fromEntries(result.value.entries.map((entry) => [entry.kind, entry]))
  assert.equal(byKind['中断'].status, 'sent')
  assert.match(byKind['完成'].detail, /聚焦/)
  assert.ok(messages.some((message) => message.includes('任务已中断')))
})

test('duplicate error summary survives when coalescing is disabled', async () => {
  const app = createHarness({ coalesceMs: 0, duplicateWindowSec: 0.3, onlyWhenUnfocused: false, channel: 'osc9' })
  const errorEvent = { type: 'turn/end', time: 1_000, data: { reason: { kind: 'error', error: { message: 'same failure' } } } }
  const messages = await withOsc(async () => {
    app.emit(session, errorEvent)
    app.emit(session, errorEvent)
    await sleep(500)
    app.emit(session, errorEvent)
  })
  assert.equal(messages.filter((message) => message.includes('same failure')).length, 2)
  assert.ok(messages.some((message) => message.includes('same failure（此前重复 1 次）')))
})

test('duplicate error summary is included in coalesced flushes', async () => {
  const app = createHarness({ coalesceMs: 10, duplicateWindowSec: 0.3, onlyWhenUnfocused: false, channel: 'osc9' })
  const errorEvent = { type: 'turn/end', time: 1_000, data: { reason: { kind: 'error', error: { message: 'same failure' } } } }
  const messages = await withOsc(async () => {
    app.emit(session, errorEvent)
    await sleep(60)
    app.emit(session, errorEvent)
    await sleep(500)
    app.emit(session, errorEvent)
    await sleep(60)
  })
  assert.ok(messages.some((message) => message.includes('same failure（此前重复 1 次）')))
})

test('digest deadline survives unrelated settings changes', async () => {
  const app = createHarness({ digestMinutes: 10, onlyWhenUnfocused: false })
  app.emit(session, { type: 'turn/start', time: 0, data: {} })
  app.emit(session, { type: 'turn/end', time: 1_000, data: { reason: { kind: 'completed' } } })
  const before = (await app.rpc('diagnostics', { op: 'get' })).value.status.digestDeadline
  assert.ok(before > Date.now() + 500_000)
  await app.rpc('settings', { op: 'set', field: 'onAborted', value: false })
  const status = (await app.rpc('diagnostics', { op: 'get' })).value.status
  assert.equal(status.digestDeadline, before)
  assert.equal(status.digestPending, 1)
})

test('disabling digest flushes the accumulated batch', async () => {
  const app = createHarness({ digestMinutes: 10, onlyWhenUnfocused: false, channel: 'osc9' })
  app.emit(session, { type: 'turn/start', time: 0, data: {} })
  app.emit(session, { type: 'turn/end', time: 1_000, data: { reason: { kind: 'completed' } } })
  const messages = await withOsc(async () => {
    await app.rpc('settings', { op: 'set', field: 'digestMinutes', value: 0 })
  })
  const result = await app.rpc('diagnostics', { op: 'get' })
  assert.equal(result.value.status.digestPending, 0)
  assert.equal(result.value.status.digestDeadline, 0)
  assert.ok(result.value.entries.some((entry) => entry.status === 'sent'))
  assert.ok(messages.some((message) => message.includes('1 个任务完成')))
})

test('settings set returns the updated snapshot', async () => {
  const app = createHarness()
  const result = await app.rpc('settings', { op: 'set', field: 'minDurationSec', value: 5 })
  assert.equal(result.ok, true)
  assert.equal(result.value.minDurationSec, 5)
})

test('sound preview rejects invalid and unknown sound names', async () => {
  const app = createHarness()
  const invalid = await app.rpc('sound/preview', { name: '../etc/passwd' })
  assert.equal(invalid.ok, false)
  assert.match(invalid.error.message, /声音名无效/)
  const unknown = await app.rpc('sound/preview', { name: 'NoSuchSound' })
  assert.equal(unknown.ok, false)
  assert.match(unknown.error.message, /找不到声音文件/)
})

test('notification decisions survive a plugin restart', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-notify-persist-'))
  const file = join(dir, 'state.json')
  const previous = process.env.DSH_MACOS_NOTIFY_STATE_FILE
  process.env.DSH_MACOS_NOTIFY_STATE_FILE = file
  try {
    const first = createHarness({ minDurationSec: 0, onlyWhenUnfocused: false, channel: 'osc9' })
    first.emit(session, { type: 'session/title', time: 0, data: { title: 'PersistedProject' } })
    first.emit(session, { type: 'turn/end', time: 1_000, data: { reason: { kind: 'completed' } } })
    await sleep(700)

    const second = createHarness({ minDurationSec: 0, onlyWhenUnfocused: false, channel: 'osc9' })
    const messages = await withOsc(async () => {
      second.emit(session, { type: 'turn/end', time: 1_000, data: { reason: { kind: 'completed' } } })
    })
    const result = await second.rpc('diagnostics', { op: 'get' })
    assert.ok(result.value.entries.some((entry) => entry.label === 'PersistedProject'), 'diagnostics should be restored')
    assert.ok(messages.some((message) => message.includes('PersistedProject')), 'restored title should label the notification')
  } finally {
    if (previous === undefined) delete process.env.DSH_MACOS_NOTIFY_STATE_FILE
    else process.env.DSH_MACOS_NOTIFY_STATE_FILE = previous
    await rm(dir, { recursive: true, force: true })
  }
})

test('duplicate suppression state survives a plugin restart', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-notify-persist-'))
  const file = join(dir, 'state.json')
  const previous = process.env.DSH_MACOS_NOTIFY_STATE_FILE
  process.env.DSH_MACOS_NOTIFY_STATE_FILE = file
  try {
    const first = createHarness({ channel: 'osc9', onlyWhenUnfocused: false })
    const errorEvent = { type: 'turn/end', time: 1_000, data: { reason: { kind: 'error', error: { message: 'persist boom' } } } }
    first.emit(session, errorEvent)
    await sleep(700)

    const second = createHarness({ channel: 'osc9', onlyWhenUnfocused: false })
    second.emit(session, errorEvent)
    const entry = (await second.rpc('diagnostics', { op: 'get' })).value.entries[0]
    assert.equal(entry.status, 'suppressed')
    assert.match(entry.detail, /重复通知已合并/)
  } finally {
    if (previous === undefined) delete process.env.DSH_MACOS_NOTIFY_STATE_FILE
    else process.env.DSH_MACOS_NOTIFY_STATE_FILE = previous
    await rm(dir, { recursive: true, force: true })
  }
})

test('settings card covers pause, unsaved-guard and polling affordances', () => {
  const clientSource = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(clientSource, /剩余约 /)
  assert.match(clientSource, /放弃未保存的修改/)
  assert.match(clientSource, /清空全部诊断记录/)
  assert.match(clientSource, /dsh-notify-cwds/)
  assert.match(clientSource, /document\.hidden/)
  assert.match(clientSource, /开始与结束时间相同视为未启用/)
  assert.match(clientSource, /并指派给/)
})

test('settings set rejects non-editable fields and invalid values', async () => {
  const app = createHarness()
  const legacy = await app.rpc('settings', { op: 'set', field: 'notifyOnLoad', value: true })
  assert.equal(legacy.ok, false)
  assert.match(legacy.error.message, /不可编辑/)
  const outOfRange = await app.rpc('settings', { op: 'set', field: 'minDurationSec', value: 99999 })
  assert.equal(outOfRange.ok, false)
  assert.match(outOfRange.error.message, /超出范围/)
  const badTime = await app.rpc('settings', { op: 'set', field: 'quietStart', value: '25:00' })
  assert.equal(badTime.ok, false)
  assert.match(badTime.error.message, /勿扰时间格式无效/)
  const badChannel = await app.rpc('settings', { op: 'set', field: 'channel', value: 'sms' })
  assert.equal(badChannel.ok, false)
  const badRules = await app.rpc('settings', { op: 'set', field: 'projectRulesJson', value: '[{"path":1}]' })
  assert.equal(badRules.ok, false)
  assert.match(badRules.error.message, /项目规则格式无效/)
})

test('settings set merges partial sounds and keeps other values', async () => {
  const app = createHarness()
  const result = await app.rpc('settings', { op: 'set', field: 'sounds', value: { completed: 'Ping' } })
  assert.equal(result.ok, true)
  assert.equal(result.value.sounds.completed, 'Ping')
  assert.equal(result.value.sounds.error, '')
  assert.equal(result.value.sounds.aborted, '')
  assert.equal(result.value.sounds.approval, '')
})

test('settings patch accepts valid values and rejects unknown fields', async () => {
  const app = createHarness()
  const okResult = await app.rpc('settings', { op: 'patch', value: { minDurationSec: 45, channel: 'osascript' } })
  assert.equal(okResult.ok, true)
  assert.equal(okResult.value.minDurationSec, 45)
  assert.equal(okResult.value.channel, 'osascript')
  const bad = await app.rpc('settings', { op: 'patch', value: { notifyOnLoad: true } })
  assert.equal(bad.ok, false)
  assert.match(bad.error.message, /不可编辑/)
})
