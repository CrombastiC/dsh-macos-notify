import assert from 'node:assert/strict'
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
  apply(ctx, config)
  return {
    emit: (session, event) => eventHandler(session, event),
    rpc: (endpoint, payload) => rpcHandler(endpoint, payload),
  }
}

const session = { id: 'session-test', header: { cwd: '/tmp/project' } }

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
