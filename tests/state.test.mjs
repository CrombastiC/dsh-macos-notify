import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadStateSync, saveState, sanitizeState } from '../src/state.js'

const EMPTY = { diagnostics: [], duplicates: [], titles: [] }

test('sanitizeState keeps well-formed entries and drops the rest', () => {
  const state = sanitizeState({
    diagnostics: [{ id: 1, status: 'sent' }, 'garbage', null],
    duplicates: [['k', { at: 1, count: 2 }], ['bad'], ['x', { at: 'no' }]],
    titles: [['s1', 'T'], ['s2'], 'junk'],
  })
  assert.deepEqual(state.diagnostics, [{ id: 1, status: 'sent' }])
  assert.deepEqual(state.duplicates, [['k', { at: 1, count: 2 }]])
  assert.deepEqual(state.titles, [['s1', 'T']])
})

test('sanitizeState caps collections and rejects non-object payloads', () => {
  const state = sanitizeState({
    diagnostics: Array.from({ length: 60 }, (_, i) => ({ id: i, status: 'sent' })),
    duplicates: Array.from({ length: 501 }, (_, i) => [`k${i}`, { at: 1, count: 0 }]),
    titles: Array.from({ length: 300 }, (_, i) => [`s${i}`, `t${i}`]),
  })
  assert.equal(state.diagnostics.length, 50)
  assert.equal(state.duplicates.length, 500)
  assert.equal(state.titles.length, 200)
  assert.deepEqual(sanitizeState(null), EMPTY)
  assert.deepEqual(sanitizeState('nope'), EMPTY)
  assert.deepEqual(sanitizeState(undefined), EMPTY)
})

test('loadStateSync round-trips through a temp file and tolerates corruption', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-notify-state-'))
  try {
    const file = join(dir, 'state.json')
    await saveState(file, {
      diagnostics: [{ id: 7, status: 'sent' }],
      duplicates: [['k', { at: 5, count: 1 }]],
      titles: [['s1', 'T']],
    })
    assert.deepEqual(loadStateSync(file), {
      diagnostics: [{ id: 7, status: 'sent' }],
      duplicates: [['k', { at: 5, count: 1 }]],
      titles: [['s1', 'T']],
    })
    await writeFile(file, '{not json')
    assert.deepEqual(loadStateSync(file), EMPTY)
    assert.deepEqual(loadStateSync(join(dir, 'missing.json')), EMPTY)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
