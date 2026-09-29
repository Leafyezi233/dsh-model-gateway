/**
 * Tests for the persisted day-bucket statistics store (0.5.0).
 *
 * Everything runs against a temporary file so no test touches the real
 * DSH home. The store's contract under test:
 * - debounced writes actually land (flush is observable),
 * - prune drops days beyond the retention window,
 * - a corrupt file degrades to empty instead of throwing,
 * - dispose stops further writes,
 * - group rename/reconcile/forget keep days and candidates consistent.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StatsStore, localDateKey } from '../lib/stats-store.js'

let failures = 0
const test = async (label, fn) => {
  try {
    await fn()
    console.log(`ok   - ${label}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL - ${label}`)
    console.log(`       ${error.message}`)
  }
}

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-relay-stats-'))
  const file = join(dir, 'stats.json')
  const store = new StatsStore({ file })
  return { store, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

await test('localDateKey is the local calendar date', () => {
  const ts = new Date(2026, 8, 27, 13, 45).getTime() // local Sep 27 2026
  assert.equal(localDateKey(ts), '2026-09-27')
})

await test('record folds into day, hour, and group rows', async () => {
  const { store, cleanup } = tempStore()
  try {
    await store.loaded
    store.record({ groupName: 'g', request: true })
    store.record({ groupName: 'g', leg: 'p_m', answered: true, usage: { inputTokens: 100, outputTokens: 50 } })
    const snap = store.snapshot()
    const key = localDateKey()
    const day = snap.days[key]
    assert.ok(day, 'today exists')
    assert.equal(day.requests, 1)
    assert.equal(day.calls, 1)
    assert.equal(day.answered, 1)
    assert.equal(day.inputTokens, 100)
    assert.equal(day.callsWithUsage, 1)
    assert.equal(day.groups.g.requests, 1)
    const hourTotal = day.hours.reduce((n, h) => n + h.requests, 0)
    assert.equal(hourTotal, 1, 'the hour buckets hold the same request')
    const candidate = snap.candidates.g['p_m']
    assert.equal(candidate.answered, 1)
    assert.equal(candidate.inputTokens, 100)
  } finally { await store.dispose(); cleanup() }
})

await test('poisoned usage fields are zeroed, never NaN', async () => {
  const { store, cleanup } = tempStore()
  try {
    await store.loaded
    store.record({ groupName: 'g', leg: 'p_m', answered: true, usage: { inputTokens: Number.NaN, outputTokens: undefined, cacheReadTokens: -5 } })
    const snap = store.snapshot()
    const day = snap.days[localDateKey()]
    assert.equal(day.inputTokens, 0)
    assert.equal(day.outputTokens, 0)
    const candidate = snap.candidates.g['p_m']
    assert.equal(Number.isFinite(candidate.inputTokens), true)
  } finally { await store.dispose(); cleanup() }
})

await test('flush writes the file and prune drops old days', async () => {
  const { store, file, cleanup } = tempStore()
  try {
    await store.loaded
    store.record({ groupName: 'g', leg: 'p_m', answered: true })
    await store.flush()
    assert.ok(existsSync(file), 'the file exists after flush')
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(parsed.version, 1)
    // Inject a 200-day-old bucket, flush, and expect it pruned.
    store.days.set('2020-01-01', { ...store.days.get(localDateKey()) })
    await store.flush()
    const after = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(after.days['2020-01-01'], undefined, 'the ancient day is pruned')
    assert.ok(after.days[localDateKey()], 'today survives')
  } finally { await store.dispose(); cleanup() }
})

await test('a corrupt file degrades to an empty store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-relay-stats-'))
  const file = join(dir, 'stats.json')
  try {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(file, '{ not json', 'utf8')
    const store = new StatsStore({ file })
    await store.loaded
    assert.equal(store.days.size, 0)
    assert.equal(store.candidates.size, 0)
    await store.dispose()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await test('dispose refuses further records', async () => {
  const { store, file, cleanup } = tempStore()
  try {
    await store.loaded
    store.record({ groupName: 'g', request: true })
    store.record({ groupName: 'g', leg: 'p_m', answered: true })
    await store.dispose()
    store.record({ groupName: 'g', leg: 'p_m', answered: true })
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(parsed.days[localDateKey()].requests, 1, 'the post-dispose record never landed')
  } finally { cleanup() }
})

await test('rename carries days and candidates; forget removes both', async () => {
  const { store, cleanup } = tempStore()
  try {
    await store.loaded
    store.record({ groupName: 'a', leg: 'p_m', answered: true })
    store.renameGroup('a', 'b')
    let snap = store.snapshot()
    assert.ok(snap.days[localDateKey()].groups.b, 'the day row followed the rename')
    assert.ok(snap.candidates.b, 'the lifetime entries followed the rename')
    assert.equal(snap.candidates.a, undefined)
    store.forgetGroup('b')
    snap = store.snapshot()
    assert.equal(snap.days[localDateKey()].groups.b, undefined, 'the day row is gone with the group')
    assert.equal(snap.candidates.b, undefined, 'the lifetime entries are gone with the group')
  } finally { await store.dispose(); cleanup() }
})

await test('reconcile drops only the removed candidates', async () => {
  const { store, cleanup } = tempStore()
  try {
    await store.loaded
    store.record({ groupName: 'g', leg: 'p_x', answered: true })
    store.record({ groupName: 'g', leg: 'p_y', answered: true })
    store.reconcileGroup('g', ['p_x'])
    const snap = store.snapshot()
    assert.ok(snap.candidates.g.p_x, 'the kept candidate stays')
    assert.equal(snap.candidates.g.p_y, undefined, 'the removed candidate goes')
  } finally { await store.dispose(); cleanup() }
})

process.exitCode = failures === 0 ? 0 : 1
