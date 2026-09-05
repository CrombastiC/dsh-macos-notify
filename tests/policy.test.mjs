import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import {
  DuplicateTracker,
  TtlCache,
  buildNotificationScript,
  duplicateKey,
  normalizeDuplicateText,
  truncateNotification,
  validateSettingsPatch,
  isCompletionKind,
  isCriticalKind,
  matchingProjectRule,
  minuteOfDay,
  parseProjectRules,
  quietHoursActive,
} from '../src/policy.js'

const NUL = String.fromCharCode(0)

test('minuteOfDay parses strict HH:mm and rejects invalid input', () => {
  assert.equal(minuteOfDay('00:00'), 0)
  assert.equal(minuteOfDay('08:30'), 510)
  assert.equal(minuteOfDay('23:59'), 1439)
  assert.equal(minuteOfDay('24:00'), null)
  assert.equal(minuteOfDay('12:60'), null)
  assert.equal(minuteOfDay('7:30'), null)
  assert.equal(minuteOfDay('abc'), null)
  assert.equal(minuteOfDay(1230), null)
})

test('quietHoursActive handles same-day and overnight ranges', () => {
  const enabled = { quietHoursEnabled: true, quietStart: '10:00', quietEnd: '12:00' }
  assert.equal(quietHoursActive(enabled, new Date(2026, 0, 15, 11, 0)), true)
  assert.equal(quietHoursActive(enabled, new Date(2026, 0, 15, 9, 59)), false)
  assert.equal(quietHoursActive(enabled, new Date(2026, 0, 15, 12, 0)), false)

  const overnight = { quietHoursEnabled: true, quietStart: '23:00', quietEnd: '08:00' }
  assert.equal(quietHoursActive(overnight, new Date(2026, 0, 15, 23, 30)), true)
  assert.equal(quietHoursActive(overnight, new Date(2026, 0, 15, 3, 0)), true)
  assert.equal(quietHoursActive(overnight, new Date(2026, 0, 15, 7, 59)), true)
  assert.equal(quietHoursActive(overnight, new Date(2026, 0, 15, 8, 0)), false)
  assert.equal(quietHoursActive(overnight, new Date(2026, 0, 15, 22, 59)), false)

  assert.equal(quietHoursActive({ ...enabled, quietHoursEnabled: false }, new Date(2026, 0, 15, 11, 0)), false)
  assert.equal(quietHoursActive({ ...enabled, quietStart: '12:00', quietEnd: '12:00' }, new Date(2026, 0, 15, 12, 30)), false)
  assert.equal(quietHoursActive({ ...enabled, quietStart: '25:00' }, new Date(2026, 0, 15, 12, 30)), false)
})

test('parseProjectRules keeps only well-formed rules and resolves paths', () => {
  assert.deepEqual(parseProjectRules('[]'), [])
  assert.deepEqual(parseProjectRules('not json'), [])
  assert.deepEqual(parseProjectRules('"x"'), [])
  const parsed = parseProjectRules(JSON.stringify([
    { path: ' /tmp/project ', mode: 'mute' },
    { path: '/tmp/other', mode: 'nope' },
    { mode: 'mute' },
    { path: 'relative/path', mode: 'important' },
  ]))
  assert.deepEqual(parsed, [
    { path: '/tmp/project', mode: 'mute' },
    { path: resolve('relative/path'), mode: 'important' },
  ])
  const capped = parseProjectRules(JSON.stringify(
    Array.from({ length: 51 }, (_, i) => ({ path: `/p/${i}`, mode: 'mute' })),
  ))
  assert.equal(capped.length, 50)
})

test('matchingProjectRule prefers the most specific path segment match', () => {
  const rules = parseProjectRules(JSON.stringify([
    { path: '/tmp', mode: 'mute' },
    { path: '/tmp/project', mode: 'errors' },
  ]))
  assert.equal(matchingProjectRule(rules, '/tmp/project/src').mode, 'errors')
  assert.equal(matchingProjectRule(rules, '/tmp/project').mode, 'errors')
  assert.equal(matchingProjectRule(rules, '/tmp/other').mode, 'mute')
  assert.equal(matchingProjectRule(rules, '/tmpx'), null)
  assert.equal(matchingProjectRule(rules, ''), null)
  assert.equal(matchingProjectRule(rules, undefined), null)
})

test('DuplicateTracker collapses repeats inside the window and summarizes on expiry', () => {
  const tracker = new DuplicateTracker()
  const t0 = 1_000_000
  assert.deepEqual(tracker.admit('k', t0, 300_000), { send: true, suffix: '' })
  assert.deepEqual(tracker.admit('k', t0 + 100_000, 300_000), { send: false, count: 1 })
  assert.deepEqual(tracker.admit('k', t0 + 200_000, 300_000), { send: false, count: 2 })
  assert.deepEqual(tracker.admit('k', t0 + 400_000, 300_000), { send: true, suffix: '（此前重复 2 次）' })
  assert.deepEqual(tracker.admit('k', t0 + 500_000, 300_000), { send: false, count: 1 })
})

test('DuplicateTracker passes through with a disabled window and tracks keys independently', () => {
  const tracker = new DuplicateTracker()
  assert.deepEqual(tracker.admit('k', 0, 0), { send: true, suffix: '' })
  assert.deepEqual(tracker.admit('k', 1000, 0), { send: true, suffix: '' })
  assert.deepEqual(tracker.admit('a', 0, 60_000), { send: true, suffix: '' })
  assert.deepEqual(tracker.admit('b', 0, 60_000), { send: true, suffix: '' })
  assert.deepEqual(tracker.admit('a', 1000, 60_000), { send: false, count: 1 })
  assert.deepEqual(tracker.admit('b', 1000, 60_000), { send: false, count: 1 })
})

test('duplicateKey binds suppression to session, kind and body', () => {
  assert.equal(duplicateKey({ sessionId: 's1', kind: '出错', body: 'boom' }), ['s1', '出错', 'boom'].join(NUL))
  assert.equal(duplicateKey({ kind: '出错', body: 'boom' }), ['', '出错', 'boom'].join(NUL))
})

test('kind classification matches the notification vocabulary', () => {
  for (const kind of ['出错', '被阻止', '审批']) assert.equal(isCriticalKind(kind), true)
  for (const kind of ['完成', '中断', '子 Agent']) assert.equal(isCriticalKind(kind), false)
  assert.equal(isCompletionKind('完成'), true)
  assert.equal(isCompletionKind('中断'), false)
})

test('buildNotificationScript escapes quotes and collapses newlines', () => {
  assert.equal(buildNotificationScript('T', 'B', ''), 'display notification "B" with title "T"')
  assert.equal(buildNotificationScript('He said "hi"', 'back\\slash', 'Glass'),
    'display notification "back\\\\slash" with title "He said \\"hi\\"" sound name "Glass"')
  assert.equal(buildNotificationScript('a\nb', 'c\r\nd', ''), 'display notification "c d" with title "a b"')
  assert.equal(buildNotificationScript('T', 'B', 'Glass'), 'display notification "B" with title "T" sound name "Glass"')
})

test('TtlCache serves values within the ttl only', () => {
  const cache = new TtlCache(5000)
  assert.equal(cache.get(0).hit, false)
  cache.set(0, 42)
  assert.deepEqual(cache.get(4000), { hit: true, value: 42 })
  assert.equal(cache.get(5001).hit, false)
  cache.set(6000, 7)
  assert.deepEqual(cache.get(7000), { hit: true, value: 7 })
})

test('DuplicateTracker serializes to and from plain entries', () => {
  const tracker = new DuplicateTracker()
  tracker.admit('k', 1000, 60_000)
  tracker.admit('k', 2000, 60_000)
  assert.equal(tracker.size, 1)
  const restored = DuplicateTracker.fromJSON(tracker.toJSON())
  assert.deepEqual(restored.admit('k', 3000, 60_000), { send: false, count: 2 })
})

test('validateSettingsPatch enforces editable fields, ranges and formats', () => {
  const current = { sounds: { completed: 'Glass', error: 'Basso', aborted: '', approval: 'Ping' } }
  assert.deepEqual(validateSettingsPatch({ minDurationSec: 45 }, current), { minDurationSec: 45 })
  assert.deepEqual(validateSettingsPatch({ sounds: { completed: 'Ping' } }, current),
    { sounds: { completed: 'Ping', error: 'Basso', aborted: '', approval: 'Ping' } })
  assert.throws(() => validateSettingsPatch({ notifyOnLoad: true }, current), /不可编辑/)
  assert.throws(() => validateSettingsPatch({ minDurationSec: 99999 }, current), /超出范围/)
  assert.throws(() => validateSettingsPatch({ minDurationSec: '30' }, current), /必须为有限数值/)
  assert.throws(() => validateSettingsPatch({ onCompleted: 1 }, current), /必须为布尔值/)
  assert.throws(() => validateSettingsPatch({ channel: 'sms' }, current), /取值无效/)
  assert.throws(() => validateSettingsPatch({ quietStart: '25:00' }, current), /勿扰时间格式无效/)
  assert.throws(() => validateSettingsPatch({ projectRulesJson: 'not json' }, current), /项目规则格式无效/)
  assert.throws(() => validateSettingsPatch({ sounds: { nope: 'X' } }, current), /未知/)
  assert.throws(() => validateSettingsPatch(null, current), /设置格式无效/)
})

test('normalizeDuplicateText converges volatile fragments but keeps distinguishing codes', () => {
  assert.equal(
    normalizeDuplicateText('proj: 请求被限流（429），服务商建议 60 秒后重试'),
    normalizeDuplicateText('proj: 请求被限流（429），服务商建议 30 秒后重试'))
  assert.notEqual(
    normalizeDuplicateText('proj: task failed 429'),
    normalizeDuplicateText('proj: task failed 500'))
  assert.equal(
    normalizeDuplicateText('req 8f3a2b1c-4d5e-6f70-8234-56789abcdef0 failed after 1.5 秒'),
    'req <uuid> failed after <n> 秒')
  assert.equal(normalizeDuplicateText('a   b\nc'), 'a b c')
  assert.equal(
    normalizeDuplicateText('retry after 30 seconds'),
    normalizeDuplicateText('retry after 45 seconds'))
  assert.equal(normalizeDuplicateText('retry after 30s'), 'retry after <n> s')
  assert.equal(normalizeDuplicateText('x'.repeat(600)).length, 500)
})

test('duplicateKey ignores volatile fragments across sends', () => {
  const a = duplicateKey({ sessionId: 's1', kind: '出错', body: 'proj: 限流，建议 60 秒后重试' })
  const b = duplicateKey({ sessionId: 's1', kind: '出错', body: 'proj: 限流，建议 30 秒后重试' })
  assert.equal(a, b)
})

test('truncateNotification caps title and body with an ellipsis', () => {
  assert.deepEqual(truncateNotification('T', 'B'), { title: 'T', body: 'B' })
  const long = truncateNotification('t'.repeat(130), 'b'.repeat(600))
  assert.equal(long.title.length, 120)
  assert.ok(long.title.endsWith('…'))
  assert.equal(long.body.length, 500)
  assert.ok(long.body.endsWith('…'))
})

test('buildNotificationScript truncates long bodies', () => {
  const script = buildNotificationScript('T', 'b'.repeat(600), '')
  assert.ok(script.includes('b'.repeat(499) + '…'))
})
