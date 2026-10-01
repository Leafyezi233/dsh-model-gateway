/**
 * Per-candidate call statistics for model groups.
 *
 * A group hides its members' health: the caller sees one name and the failover
 * loop silently walks past a dead candidate. This module keeps the scoreboard
 * the settings page needs to show which member is answering and which is not.
 *
 * ## What is counted, and what is deliberately not
 *
 * The unit is "did this candidate answer", not "did it succeed". A candidate
 * that produced output and then died mid-stream is counted as ANSWERED. That is
 * a real loss of information, accepted on purpose, and the reason is
 * structural rather than an oversight:
 *
 *  - On DSH's own path (`streamGroup`, an async generator) a post-output failure
 *    is still observable, because control returns to the loop on the next pull.
 *  - On the `/v1` path (`openStream`) the committed attempt is handed off as
 *    `resume(buffered, iterator)` and the failure then happens inside `resume`,
 *    where `openStream` can no longer see it.
 *
 * Counting only "answered" keeps one definition on both paths. Counting
 * "success" would make the two paths disagree, or force a wrapper around the
 * streaming hot path to make them agree. The honest naming is the trade:
 * `answered` / `refused`, never "success" / "failure".
 *
 * ## Failures that are not the candidate's fault
 *
 * A request that is too large, malformed, or cancelled fails the same way on
 * every candidate, so charging it to whichever one happened to be first would
 * blame a healthy model. Those land in `ignored` and never enter the ratio.
 *
 * ## Lifetime
 *
 * Lifetime aggregates live in memory; since 0.5.0 the daily history is also
 * persisted by `lib/stats-store.js` (90-day retention, atomic 0600 writes,
 * 2s debounce). The same discipline as the round-robin cursor still holds:
 * statistics are observability, not configuration — they must not be able to
 * affect routing, and a statistics update must never be able to fail a
 * request or delay a settings save.
 *
 * @module dsh-model-gateway/stats
 */

/** Most recent outcomes retained per candidate, for the recent-window ratio. */
export const RECENT_WINDOW = 20

/** How many groups the table tracks before ignoring new ones. */
export const MAX_TRACKED_GROUPS = 200

/**
 * Failure codes that are NOT the candidate's fault.
 *
 * Mirrors the "do not count, do not cool down" row of dsh-router-core's
 * account-pool table. Every one of these answers identically on the next
 * candidate, so attributing it to one of them is noise at best.
 *
 * Keyed by CODE, not by HTTP status: `statusForCode` maps both
 * `CONTEXT_WINDOW_EXCEEDED` and `RATE_LIMIT` to a 4xx, but only the latter is
 * the candidate's problem.
 */
const NOT_THE_CANDIDATES_FAULT = new Set([
  'ABORTED',
  'CONTEXT_WINDOW_EXCEEDED',
  'INVALID_REQUEST',
  'INVALID_PREPARED_CALL',
  'UNSUPPORTED_CONTENT',
  'UNSUPPORTED_OPTION',
  'UNSUPPORTED_REASONING_EFFORT',
])

/**
 * Whether a failure should be charged to the candidate that produced it.
 *
 * Unknown codes are charged to the candidate: an unrecognized failure is more
 * likely to be a genuine upstream problem than a caller mistake, and the code
 * catalog is open (`default: 502` in `statusForCode`).
 * @param code - the normalized failure code, when one was reported.
 * @returns whether the candidate should be blamed.
 */
export function blamesCandidate(code) {
  return !NOT_THE_CANDIDATES_FAULT.has(code)
}

/** One candidate's counters. */
function emptyCandidate() {
  return {
    attempts: 0,
    answered: 0,
    refused: 0,
    retry429: 0,
    ignored: 0,
    lastCode: undefined,
    lastAt: undefined,
    lastOkAt: undefined,
    recent: [],
    // Token / latency accumulators (0.5.0). All of them are lifetime sums; the
    // per-day breakdown lives in the persisted store, not here.
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    callsWithUsage: 0,
    ttftMsSum: 0,
    ttftSamples: 0,
    ttftMax: 0,
  }
}

/**
 * Collapse one usage field to a safe non-negative finite integer.
 *
 * A missing field is 0; a non-numeric or non-finite field (NaN, Infinity) is
 * poisoned data — the sibling accumulator must not absorb it, because
 * `Math.max(x, NaN) === NaN` and one NaN multiply-poisons every downstream
 * average. This is the write-side discipline dsh-router-core learned the hard
 * way: normalize BEFORE adding, never after.
 */
function usageField(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0
  return Math.floor(value)
}

/**
 * Merge one usage frame into the pending accumulator, field by field.
 *
 * Streaming usage often arrives split across frames (an input frame early, an
 * output frame at the end). Later frames REPLACE their field rather than adding
 * to it — but a frame may legitimately carry a HIGHER value than an earlier
 * one, and must never lower the total, so each field takes the max. Adding
 * instead of max-merging double-counts multi-frame usage.
 */
function mergePendingUsage(pending, usage) {
  if (usage === undefined || usage === null || typeof usage !== 'object') return
  for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'reasoningTokens']) {
    const value = usageField(usage[field])
    pending[field] = Math.max(pending[field], value)
  }
}

/** One group's counters. */
function emptyGroup() {
  return { requests: 0, allFailed: 0, candidates: new Map() }
}

/**
 * Record one attempt's outcome, keeping the recent window bounded.
 * @param entry - the candidate entry to update.
 * @param outcome - `'answered'` or `'refused'`.
 * @param at - timestamp, injectable for tests.
 */
function pushOutcome(entry, outcome, at) {
  entry.recent.push(outcome)
  if (entry.recent.length > RECENT_WINDOW) entry.recent.shift()
  if (outcome === 'answered') entry.lastOkAt = at
  else entry.lastAt = at
}

/**
 * The in-memory scoreboard.
 *
 * Mutating methods are synchronous and free of `await`, which is what makes
 * them safe without a lock: Node runs each to completion between stream pulls,
 * so two concurrent requests cannot interleave a read-modify-write here.
 */
export class GroupStats {
  /** @param options - `{ maxGroups }`, for tests that need a small table. */
  constructor({ maxGroups = MAX_TRACKED_GROUPS } = {}) {
    /** @type {Map<string, object>} */
    this.groups = new Map()
    this.maxGroups = maxGroups
  }

  /** The group's entry, created on first use. Undefined once the table is full. */
  #group(name) {
    let group = this.groups.get(name)
    if (group !== undefined) return group
    if (this.groups.size >= this.maxGroups) return undefined
    group = emptyGroup()
    this.groups.set(name, group)
    return group
  }

  /** The candidate's entry inside a group, created on first use. */
  #candidate(group, model) {
    let entry = group.candidates.get(model)
    if (entry === undefined) {
      entry = emptyCandidate()
      group.candidates.set(model, entry)
    }
    return entry
  }

  /**
   * One request entered this group.
   * @param groupName - the group being served.
   */
  request(groupName) {
    const group = this.#group(groupName)
    if (group !== undefined) group.requests += 1
  }

  /**
   * Every candidate failed and the request is about to fail.
   * @param groupName - the group being served.
   */
  allFailed(groupName) {
    const group = this.#group(groupName)
    if (group !== undefined) group.allFailed += 1
  }

  /**
   * One attempt against one candidate started.
   *
   * A retry of the same candidate is a separate attempt, which is the point:
   * "needed three asks to answer" should look worse than "answered first try".
   * @param groupName - the group being served.
   * @param model - the candidate, in exposed spelling.
   */
  attempt(groupName, model) {
    const group = this.#group(groupName)
    if (group === undefined) return
    this.#candidate(group, model).attempts += 1
  }

  /**
   * The candidate produced output, or ran to completion without failing.
   * @param groupName - the group being served.
   * @param model - the candidate that answered.
   * @param at - timestamp, injectable for tests.
   */
  answered(groupName, model, at = Date.now()) {
    const group = this.#group(groupName)
    if (group === undefined) return
    const entry = this.#candidate(group, model)
    entry.answered += 1
    pushOutcome(entry, 'answered', at)
  }

  /**
   * Commit accumulated usage to the candidate that finally served the call.
   *
   * Usage observed on FAILED attempts is deliberately not committed (the
   * pending accumulator died with that attempt). Called once per call, on the
   * attempt that produced the caller's answer — never at first output time,
   * which would charge the usage of a later failure to the wrong candidate.
   * @param groupName - the group being served.
   * @param model - the candidate that finally served, in stored spelling.
   * @param usage - the merged usage frames, or undefined when none arrived.
   */
  recordUsage(groupName, model, usage) {
    if (usage === undefined || usage === null || typeof usage !== 'object') return
    const group = this.#group(groupName)
    if (group === undefined) return
    const entry = this.#candidate(group, model)
    entry.inputTokens += usageField(usage.inputTokens)
    entry.outputTokens += usageField(usage.outputTokens)
    entry.cacheReadTokens += usageField(usage.cacheReadTokens)
    entry.reasoningTokens += usageField(usage.reasoningTokens)
    if (entry.inputTokens + entry.outputTokens > 0) entry.callsWithUsage += 1
  }

  /**
   * Record one time-to-first-text measurement.
   *
   * Timed on the first text/reasoning delta, NOT on `answered`: a stream that
   * opens with a block-start would otherwise clock a near-zero TTFT that
   * measures the chunk pipeline, not the model. `ttftMax` exists because a
   * sum alone hides the one 30-second leg behind a sea of fast ones.
   * @param groupName - the group being served.
   * @param model - the candidate that produced the first text.
   * @param ms - the measured milliseconds, already sanity-checked by the caller.
   */
  recordTtft(groupName, model, ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return
    const group = this.#group(groupName)
    if (group === undefined) return
    const entry = this.#candidate(group, model)
    entry.ttftMsSum += ms
    entry.ttftSamples += 1
    if (ms > entry.ttftMax) entry.ttftMax = ms
  }

  /**
   * The candidate failed before producing output.
   *
   * A failure the candidate is not responsible for is diverted to `ignored`
   * and does not enter the ratio at all.
   * @param groupName - the group being served.
   * @param model - the candidate that failed.
   * @param code - the normalized failure code, when one was reported.
   * @param at - timestamp, injectable for tests.
   */
  refused(groupName, model, code, at = Date.now()) {
    const group = this.#group(groupName)
    if (group === undefined) return
    const entry = this.#candidate(group, model)
    if (!blamesCandidate(code)) {
      entry.ignored += 1
      return
    }
    entry.refused += 1
    entry.lastCode = code
    pushOutcome(entry, 'refused', at)
  }

  /**
   * The candidate was rate limited and will be asked again.
   * @param groupName - the group being served.
   * @param model - the candidate that was rate limited.
   */
  rateLimited(groupName, model) {
    const group = this.#group(groupName)
    if (group === undefined) return
    this.#candidate(group, model).retry429 += 1
  }

  /**
   * The call was cancelled by the caller, so no candidate is at fault.
   *
   * Shares the `ignored` bucket with {@link GroupStats#unresolved}: both mean
   * "this attempt produced no evidence about the candidate". They stay separate
   * methods because the causes are different and the call sites should say
   * which one they mean.
   * @param groupName - the group being served.
   * @param model - the candidate whose attempt was cancelled.
   */
  excused(groupName, model) {
    const group = this.#group(groupName)
    if (group === undefined) return
    this.#candidate(group, model).ignored += 1
  }

  /**
   * A candidate could not even be resolved.
   *
   * A configuration problem — a typo, or a provider that went away — not an
   * upstream failure. Recorded against the candidate that names it, but never
   * entering the ratio.
   * @param groupName - the group being served.
   * @param model - the candidate that would not resolve.
   */
  unresolved(groupName, model) {
    const group = this.#group(groupName)
    if (group === undefined) return
    this.#candidate(group, model).ignored += 1
  }

  /**
   * A group was renamed: carry its history over.
   *
   * Deliberately not a reset. The same members are still being called; only the
   * name the caller uses has changed, and discarding the scoreboard would erase
   * the evidence the rename was made on.
   * @param from - the previous name.
   * @param to - the new name.
   */
  rename(from, to) {
    if (from === to) return
    const group = this.groups.get(from)
    if (group === undefined) return
    this.groups.delete(from)
    this.groups.set(to, group)
  }

  /**
   * A group's candidate list changed: drop the members that are gone.
   *
   * Kept candidates keep their history — changing a group's scheduling is not a
   * reason to forget that one member has been failing all along.
   * @param groupName - the group that changed.
   * @param models - the candidates it now holds.
   */
  reconcile(groupName, models) {
    const group = this.groups.get(groupName)
    if (group === undefined) return
    const keep = new Set(Array.isArray(models) ? models : [])
    for (const model of [...group.candidates.keys()]) {
      if (!keep.has(model)) group.candidates.delete(model)
    }
  }

  /**
   * A group was removed: forget everything about it.
   * @param groupName - the group that is gone.
   */
  forget(groupName) {
    this.groups.delete(groupName)
  }

  /** Drop every group. */
  clear() {
    this.groups.clear()
  }

  /**
   * The share of counted attempts that were answered.
   *
   * `ignored` outcomes are excluded from both the numerator and the
   * denominator, so a burst of oversized requests cannot drag a healthy
   * candidate's ratio down.
   * @param entry - a candidate entry.
   * @returns a number in `[0, 1]`, or undefined when nothing was counted.
   */
  static ratioOf(entry) {
    const counted = entry.answered + entry.refused
    if (counted === 0) return undefined
    return entry.answered / counted
  }

  /**
   * The same ratio over only the most recent outcomes.
   *
   * A candidate that was broken this morning and is fine now still has a poor
   * lifetime ratio, and no amount of health will pull it back. The recent
   * window is what makes a recovery visible.
   * @param entry - a candidate entry.
   * @returns a number in `[0, 1]`, or undefined when the window is empty.
   */
  static recentRatioOf(entry) {
    const window = entry.recent
    if (window.length === 0) return undefined
    let answered = 0
    for (const outcome of window) if (outcome === 'answered') answered += 1
    return answered / window.length
  }

  /**
   * A JSON-safe snapshot for the settings page.
   *
   * `answered`/`refused` and their ratios are what the UI renders; `ignored`
   * travels too, so the page can explain why a candidate with failures shows
   * none, rather than looking broken.
   * @returns one entry per group, with one row per candidate.
   */
  snapshot() {
    const out = {}
    for (const [name, group] of this.groups) {
      const candidates = {}
      for (const [model, entry] of group.candidates) {
        candidates[model] = {
          attempts: entry.attempts,
          answered: entry.answered,
          refused: entry.refused,
          retry429: entry.retry429,
          ignored: entry.ignored,
          ratio: GroupStats.ratioOf(entry),
          recentRatio: GroupStats.recentRatioOf(entry),
          inputTokens: entry.inputTokens,
          outputTokens: entry.outputTokens,
          cacheReadTokens: entry.cacheReadTokens,
          reasoningTokens: entry.reasoningTokens,
          callsWithUsage: entry.callsWithUsage,
          ttftMsSum: entry.ttftMsSum,
          ttftSamples: entry.ttftSamples,
          ttftMax: entry.ttftMax,
          ...(entry.lastCode === undefined ? {} : { lastCode: entry.lastCode }),
          ...(entry.lastAt === undefined ? {} : { lastAt: entry.lastAt }),
          ...(entry.lastOkAt === undefined ? {} : { lastOkAt: entry.lastOkAt }),
        }
      }
      out[name] = {
        requests: group.requests,
        allFailed: group.allFailed,
        candidates,
      }
    }
    return out
  }
}
