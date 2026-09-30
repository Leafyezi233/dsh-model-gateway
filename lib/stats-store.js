/**
 * Persistent daily-bucket statistics store (0.5.0).
 *
 * The in-memory scoreboard in `lib/stats.js` stays the source of truth for
 * routing-adjacent display (badges, tooltips). This module adds the OTHER
 * half of the contract from the 0.5.0 design doc (v2.1): per-day aggregates
 * that survive a restart, for the heatmap and trend chart.
 *
 * ## Structure (data model "O4", per the design doc §4.4)
 *
 * - `days`: 90 retained days, per-day global totals plus per-GROUP rows.
 *   Per-group day rows carry additive counters only; "last time" semantics
 *   live in the lifetime layer, not per day.
 * - `days[d].hours`: a fixed 24-slot array, GLOBAL (not per group). The
 *   24h rolling window reads these. Hourly buckets per group would scale the
 *   file by the group count (measured 38x at cap) and are deliberately not
 *   kept. A group has NO hourly history; the UI says so rather than faking it.
 * - `candidates`: lifetime per `<group>\0<candidate>` — the counters the
 *   scoreboard already shows, plus token/TTFT sums, so the persisted view
 *   matches what the live page shows across restarts.
 *
 * ## Discipline (the two iron rules, unchanged)
 *
 * 1. Statistics never affect routing.
 * 2. Statistics never slow down or fail a request. Writes are debounced
 *    (2s, matching dsh-router-core), async, fully try/catch-swallowed, and
 *    the timer is unref'd so telemetry never holds the process open. A kill
 *    within the debounce window loses at most ~2s of counters — the README
 *    discloses this.
 *
 * The detail feed (`events`) stays MEMORY-ONLY in `lib/stats.js` and never
 * reaches this file: aggregates only. dsh-router-core's module header records
 * why — a ring buffer scanned by statistics silently truncates at its cap and
 * produces "today 500 / 7 days 1621" contradictions.
 */

import { copyFile, mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Days of per-day buckets retained. Design doc decision 5 (v2.1: 90). */
export const KEEP_DAYS = 90

/** Slots in a day's hourly array. Fixed length, global per day. */
export const HOURS = 24

/** Debounce window for writes, in ms (matches dsh-router-core). */
export const SAVE_DEBOUNCE_MS = 2000

/** Current document schema version, for future migrations. */
const VERSION = 1

/** One additive day row (per group, and the global rollup). */
function emptyRow() {
  return {
    requests: 0, calls: 0, answered: 0, refused: 0,
    inputTokens: 0, outputTokens: 0, callsWithUsage: 0,
  }
}

/** One hourly slot: the same counters, scoped to one wall-clock hour. */
const emptyHour = emptyRow

/** One lifetime candidate row: the counters + "last time" semantics. */
function emptyCandidate() {
  return {
    attempts: 0, answered: 0, refused: 0, retry429: 0, ignored: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0,
    callsWithUsage: 0, ttftMsSum: 0, ttftSamples: 0, ttftMax: 0,
    lastCode: undefined, lastAt: undefined, lastOkAt: undefined,
  }
}

/** Local-date key, matching dsh-router-core's localDateKey exactly. */
export function localDateKey(ts = Date.now()) {
  const d = new Date(ts)
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

/** Collapse to a safe non-negative finite integer; anything else is 0. */
function field(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0
  return Math.floor(value)
}

function addToRow(row, delta) {
  row.requests += field(delta.requests)
  row.calls += field(delta.calls)
  row.answered += field(delta.answered)
  row.refused += field(delta.refused)
  row.inputTokens += field(delta.inputTokens)
  row.outputTokens += field(delta.outputTokens)
  row.callsWithUsage += field(delta.callsWithUsage)
}

export class StatsStore {
  /**
   * @param options - `{ file?, logger? }`. The file defaults to the DSH home.
   *   Tests pass a temp path and a stub logger.
   */
  constructor({ file = dshHomePath('model-relay-stats.json'), logger } = {}) {
    this.file = file
    this.logger = logger
    this.days = new Map()
    this.candidates = new Map()
    this.timer = null
    this.disposed = false
    this.loaded = this.load()
  }

  /** Load and migrate the document; every failure degrades to empty. */
  async load() {
    let raw
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error) {
      // A missing file is a normal first run and stays silent; any other read
      // failure is worth one line — the store starts empty below, and the
      // next flush rewrites whatever the file held.
      if (error?.code !== 'ENOENT') {
        this.logger?.warn?.(`dsh-model-relay: ${this.file} could not be read; starting stats fresh`, error)
      }
      return
    }
    try {
      const parsed = JSON.parse(raw)
      const days = parsed?.days
      if (days && typeof days === 'object') {
        for (const [key, day] of Object.entries(days)) {
          if (day === undefined || day === null || typeof day !== 'object') continue
          // Field-level repair: an older file missing a later field must not
          // turn into NaN through the spread. Hours are repaired by length.
          const hours = Array.from({ length: HOURS }, (_, i) => ({ ...emptyHour(), ...(Array.isArray(day.hours) ? day.hours[i] : undefined) }))
          const groups = {}
          for (const [name, row] of Object.entries(day.groups ?? {})) {
            if (row !== undefined && row !== null && typeof row === 'object') groups[name] = { ...emptyRow(), ...row }
          }
          this.days.set(key, { ...emptyRow(), ...day, hours, groups })
        }
      }
      const candidates = parsed?.candidates
      if (candidates && typeof candidates === 'object') {
        for (const [key, entry] of Object.entries(candidates)) {
          if (entry !== undefined && entry !== null && typeof entry === 'object') {
            this.candidates.set(key, { ...emptyCandidate(), ...entry })
          }
        }
      }
      // Prune on load too: a clock that jumped (or a file copied between
      // machines) can leave the document older than the retention window.
      this.prune()
    } catch (error) {
      this.logger?.warn?.(`dsh-model-relay: ${this.file} is not valid JSON; starting stats fresh`)
      this.logger?.warn?.(error)
      // No map reset here: population only ever starts after a successful
      // parse, so there is nothing half-loaded to clear — but a record that
      // landed before load settled must survive this failure.
    }
  }

  /** The bucket for a local date, created (and scheduled for retention) on use. */
  #day(key = localDateKey()) {
    let day = this.days.get(key)
    if (day === undefined) {
      day = { ...emptyRow(), hours: Array.from({ length: HOURS }, () => emptyHour()), groups: {} }
      this.days.set(key, day)
      this.scheduleSave()
    }
    return day
  }

  /** The lifetime candidate row, keyed by `<group>\0<candidate>`. */
  #candidate(groupName, candidate) {
    const key = `${groupName}\0${candidate}`
    let entry = this.candidates.get(key)
    if (entry === undefined) {
      entry = emptyCandidate()
      this.candidates.set(key, entry)
      this.scheduleSave()
    }
    return entry
  }

  /**
   * Fold one request's outcome into the buckets.
   *
   * Called ONCE per completed request, from the same places that already call
   * the scoreboard — never from the streaming hot path more than once.
   * @param record - `{ groupName, leg, hour, answered, refused, ignored,
   *   usage?, ttft? }`. `hour` defaults to the current local hour.
   */
  record(record) {
    if (this.disposed) return
    try {
      const key = localDateKey()
      const hour = Math.min(HOURS - 1, Math.max(0, field(record.hour ?? new Date().getHours())))
      const day = this.#day(key)
      // `requests` counts LOGICAL requests (one per call into the group), so
      // it moves only on the request-start record; outcome records (one per
      // attempt result) move `calls`/answered/refused — that asymmetry is the
      // design doc's requests-vs-calls distinction (120 vs 124).
      const delta = {
        requests: record.request === true ? 1 : 0,
        calls: record.answered || record.refused ? 1 : 0,
        answered: record.answered ? 1 : 0,
        refused: record.refused ? 1 : 0,
        inputTokens: field(record.usage?.inputTokens),
        outputTokens: field(record.usage?.outputTokens),
        // "With usage" means at least one token field actually arrived. An
        // empty usage OBJECT (all fields absent or invalid) must not count:
        // live data showed callsWithUsage=8 beside all-zero tokens, a column
        // pair that contradicts itself.
        callsWithUsage:
          field(record.usage?.inputTokens) + field(record.usage?.outputTokens) > 0 ? 1 : 0,
      }
      addToRow(day, delta)
      addToRow(day.hours[hour], delta)
      // A request-start record may name the group without a leg (no outcome
      // yet); it still owns a group row so per-group requests are counted.
      if (record.groupName !== undefined && record.leg === undefined && record.request === true) {
        const groupRow = day.groups[record.groupName] ?? (day.groups[record.groupName] = emptyRow())
        addToRow(groupRow, delta)
      }
      if (record.groupName !== undefined && record.leg !== undefined) {
        const groupRow = day.groups[record.groupName] ?? (day.groups[record.groupName] = emptyRow())
        addToRow(groupRow, delta)
        const entry = this.#candidate(record.groupName, record.leg)
        entry.attempts += record.attempt ? 1 : 0
        entry.answered += record.answered ? 1 : 0
        entry.refused += record.refused ? 1 : 0
        entry.inputTokens += field(record.usage?.inputTokens)
        entry.outputTokens += field(record.usage?.outputTokens)
        if (field(record.usage?.inputTokens) + field(record.usage?.outputTokens) > 0) entry.callsWithUsage += 1
        if (typeof record.ttft === 'number' && Number.isFinite(record.ttft) && record.ttft >= 0) {
          entry.ttftMsSum += record.ttft
          entry.ttftSamples += 1
          if (record.ttft > entry.ttftMax) entry.ttftMax = record.ttft
        }
        if (record.lastCode !== undefined) { entry.lastCode = record.lastCode; entry.lastAt = Date.now() }
        if (record.answered) entry.lastOkAt = Date.now()
      }
      this.scheduleSave()
    } catch (error) {
      // Rule 2: a statistics failure must never surface to a request.
      this.logger?.warn?.('dsh-model-relay: stats record failed', error)
    }
  }

  /** A group was renamed: carry its days rows and lifetime entries over. */
  renameGroup(from, to) {
    if (this.disposed || from === to) return
    try {
      for (const day of this.days.values()) {
        const row = day.groups[from]
        if (row === undefined) continue
        delete day.groups[from]
        day.groups[to] = row
      }
      const prefix = `${from}\0`
      for (const [key, entry] of [...this.candidates]) {
        if (key.startsWith(prefix)) {
          this.candidates.delete(key)
          this.candidates.set(`${to}\0${key.slice(prefix.length)}`, entry)
        }
      }
      this.scheduleSave()
    } catch (error) {
      this.logger?.warn?.('dsh-model-relay: stats rename failed', error)
    }
  }

  /** A group's candidate list changed: drop the members that are gone. */
  reconcileGroup(groupName, models) {
    if (this.disposed) return
    try {
      const keep = new Set(Array.isArray(models) ? models : [])
      const prefix = `${groupName}\0`
      for (const key of [...this.candidates.keys()]) {
        if (key.startsWith(prefix) && !keep.has(key.slice(prefix.length))) this.candidates.delete(key)
      }
      this.scheduleSave()
    } catch (error) {
      this.logger?.warn?.('dsh-model-relay: stats reconcile failed', error)
    }
  }

  /** A group was removed: its history goes with it (design decision 2). */
  forgetGroup(groupName) {
    if (this.disposed) return
    try {
      for (const day of this.days.values()) delete day.groups[groupName]
      const prefix = `${groupName}\0`
      for (const key of [...this.candidates.keys()]) {
        if (key.startsWith(prefix)) this.candidates.delete(key)
      }
      this.scheduleSave()
    } catch (error) {
      this.logger?.warn?.('dsh-model-relay: stats forget failed', error)
    }
  }

  /** Drop day buckets older than the retention window. */
  prune() {
    const cutoff = localDateKey(Date.now() - KEEP_DAYS * 86400000)
    for (const key of [...this.days.keys()]) {
      if (key < cutoff) this.days.delete(key)
    }
  }

  /** Debounced save. Trailing-only, like dsh-router-core's own store. */
  scheduleSave() {
    if (this.disposed || this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush().catch(() => {})
    }, SAVE_DEBOUNCE_MS)
    this.timer.unref?.()
  }

  /** Write the document atomically. Errors are swallowed with a warning. */
  async flush() {
    if (this.disposed) return
    try {
      // Never write before the load has settled: a flush that races its own
      // load serializes empty memory over whatever the file held.
      await this.loaded
      this.prune()
      const document = {
        version: VERSION,
        days: Object.fromEntries([...this.days.entries()].sort()),
        candidates: Object.fromEntries([...this.candidates.entries()].sort()),
      }
      // An empty document carries no information; writing one over an
      // existing file can only destroy history (degraded load, racing
      // dispose). Skipping is always the safe side: the next real record
      // flushes a non-empty document.
      if (this.days.size === 0 && this.candidates.size === 0) {
        this.logger?.warn?.('dsh-model-relay: stats store is empty — skipping flush to keep any existing document')
        return
      }
      await mkdir(dirname(this.file), { recursive: true })
      // Insurance rotation: keep the previous document one copy away, so a
      // bad overwrite (unreadable at startup, rewritten later) is recoverable.
      try {
        await copyFile(this.file, `${this.file}.bak`)
      } catch {
        // First run, or the current file is unreadable: nothing to rotate.
      }
      const temporary = `${this.file}.${process.pid}.tmp`
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
      // Windows: a lock holder (AV, a peer instance) can refuse the replace
      // for a moment; a short retry avoids losing the flush and leaving the
      // temporary file behind.
      for (let attempt = 1; ; attempt += 1) {
        try {
          await rename(temporary, this.file)
          break
        } catch (error) {
          if (attempt >= 3) throw error
          await new Promise((resolve) => setTimeout(resolve, 100 * attempt))
        }
      }
      try {
        await chmod(this.file, 0o600)
      } catch {
        // Windows has no POSIX mode to set; the rename preserved creation mode.
      }
    } catch (error) {
      this.logger?.warn?.('dsh-model-relay: stats flush failed', error)
    }
  }

  /**
   * Stop the store: cancel the timer, write what is pending, refuse further
   * writes. Wired through ctx.effect so a hot-reload generation cannot
   * outlive its own timer and write after its successor has.
   */
  async dispose() {
    if (this.disposed) return
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    await this.flush()
    this.disposed = true
  }

  /** JSON-safe summary for the settings page (charts read this). */
  snapshot() {
    const days = {}
    for (const [key, day] of this.days) {
      days[key] = {
        requests: day.requests, calls: day.calls, answered: day.answered, refused: day.refused,
        inputTokens: day.inputTokens, outputTokens: day.outputTokens, callsWithUsage: day.callsWithUsage,
        hours: day.hours.map((h) => ({ ...h })),
        groups: Object.fromEntries(Object.entries(day.groups).map(([name, row]) => [name, { ...row }])),
      }
    }
    const candidates = {}
    for (const [key, entry] of this.candidates) {
      const [groupName, candidate] = key.split('\0')
      ;(candidates[groupName] ??= {})[candidate] = { ...entry }
    }
    return { days, candidates, keepDays: KEEP_DAYS }
  }
}
