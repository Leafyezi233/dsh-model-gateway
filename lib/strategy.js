/**
 * Group scheduling: the order a group's candidates are tried in, and how many
 * times one candidate is retried after a rate limit.
 *
 * Two orthogonal axes, deliberately not four enum values:
 *
 *  - `strategy` orders the candidates.
 *  - `retry429` decides how many times ONE candidate is retried before the
 *    next is tried.
 *
 * The settings page offers four presets, which are just combinations:
 *
 *   A sequential          = { strategy: 'sequential',  retry429: 0 }
 *   B balanced            = { strategy: 'round-robin', retry429: 0 }
 *   C random              = { strategy: 'random',      retry429: 0 }
 *   D sequential + retry  = { strategy: 'sequential',  retry429: N }
 *
 * Keeping them apart is what lets "balanced, plus retry" exist at all; folding
 * them into one enum would force every ordering branch to duplicate the retry
 * logic, and would make that combination unrepresentable.
 *
 * Every ordering returns a PERMUTATION of the candidate list, never a subset.
 * A member that is merely deprioritized stays reachable, so a scheduling
 * choice can never shorten a group's fallback chain.
 *
 * @module dsh-model-gateway/strategy
 */

/** Every accepted ordering. Anything else degrades to `sequential`. */
export const STRATEGIES = ['sequential', 'round-robin', 'random']

/** The ordering that is also the default, and the one existing groups get. */
export const DEFAULT_STRATEGY = 'sequential'

/** Most retries one candidate may get after a rate limit. */
export const MAX_RETRY_429 = 3

/** Wait before the first retry, doubled per attempt. */
export const RETRY_BASE_DELAY_MS = 250

/** Ceiling for a single backoff wait. */
export const RETRY_MAX_DELAY_MS = 1000

/**
 * Total time one candidate may spend waiting between retries.
 *
 * Without a budget a retry chain is paid for by the caller: a member that is
 * simply gone would be re-asked three times before the next member — which
 * could have answered immediately — was ever tried.
 */
export const RETRY_BUDGET_MS = 2000

/**
 * Coerce a stored ordering to one this module implements.
 * @param value - whatever the group document held.
 * @returns a member of {@link STRATEGIES}.
 */
export function normalizeStrategy(value) {
  return STRATEGIES.includes(value) ? value : DEFAULT_STRATEGY
}

/**
 * Coerce a stored retry count to an accepted one.
 *
 * Out-of-range degrades to 0 rather than rejecting the group: a scheduling
 * preference is not worth losing a working candidate list over.
 * @param value - whatever the group document held.
 * @returns an integer in `[0, MAX_RETRY_429]`.
 */
export function normalizeRetry429(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return 0
  return Math.min(value, MAX_RETRY_429)
}

/**
 * Order one group's candidates for a single request.
 *
 * @param strategy - one of {@link STRATEGIES}; anything else is sequential.
 * @param models - the candidates, in stored order.
 * @param cursor - the rotation position for `round-robin`.
 * @param random - the randomness source for `random`; injectable for tests.
 * @returns `{ legs, nextCursor }` — the order to try, and where the rotation
 *   should resume next time. `nextCursor` is 0 for every non-rotating order.
 */
export function orderLegs(strategy, models, cursor = 0, random = Math.random) {
  const list = Array.isArray(models) ? [...models] : []
  if (list.length <= 1) return { legs: list, nextCursor: 0 }

  if (strategy === 'round-robin') {
    const size = list.length
    const start = ((Math.trunc(cursor) % size) + size) % size
    // A full rotation, not just a new head: the tail is still the fallback
    // chain, so wrapping must keep every member reachable.
    return {
      legs: [...list.slice(start), ...list.slice(0, start)],
      nextCursor: (start + 1) % size,
    }
  }

  if (strategy === 'random') {
    const legs = [...list]
    for (let index = legs.length - 1; index > 0; index -= 1) {
      // Clamped because the source is injectable: a stub returning exactly 1
      // would otherwise index one past the end.
      const target = Math.min(index, Math.floor(random() * (index + 1)))
      const swap = legs[index]
      legs[index] = legs[target]
      legs[target] = swap
    }
    return { legs, nextCursor: 0 }
  }

  return { legs: list, nextCursor: 0 }
}

/**
 * Whether a failed attempt may be retried on the SAME candidate.
 *
 * The judgement is by failure CODE, not by the HTTP status the gateway would
 * answer with. `statusForCode` maps `RATE_LIMIT`, `QUOTA` and
 * `QUOTA_EXCEEDED` all to 429, but an exhausted quota is not a
 * wait-and-retry condition: re-asking spends the caller's time for the same
 * answer. Only a genuine rate limit is worth waiting out.
 *
 * @param failure - `{ code }` from a normalized DSH failure.
 * @returns whether the same candidate should be tried again.
 */
export function isRetryableRateLimit(failure) {
  return failure?.code === 'RATE_LIMIT'
}

/**
 * How long to wait before retrying one candidate.
 *
 * The wait is the larger of the upstream's own `Retry-After` hint and an
 * exponential backoff, so the gateway never retries inside a window the
 * provider explicitly asked it to respect.
 *
 * @param attempt - the 1-based retry number about to be waited for.
 * @param providerRetryAfterMs - the upstream hint, when it sent one.
 * @param spentMs - time this candidate has already spent waiting.
 * @returns the wait in milliseconds, or undefined when honouring it would
 *   exceed {@link RETRY_BUDGET_MS} — the caller then moves to the next
 *   candidate instead of sleeping past a hint the provider asked for.
 */
export function retryDelayMs(attempt, providerRetryAfterMs, spentMs = 0) {
  const hinted = Number.isFinite(providerRetryAfterMs) && providerRetryAfterMs > 0 ? providerRetryAfterMs : 0
  const backoff = Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS)
  const wait = Math.max(hinted, backoff)
  if (spentMs + wait > RETRY_BUDGET_MS) return undefined
  return wait
}

/**
 * Wait, but wake up immediately when the caller cancels.
 *
 * Resolves rather than rejects on abort: the caller re-checks the signal and
 * stops, which keeps cancellation a normal control-flow branch instead of an
 * exception every retry site has to catch.
 * @param ms - how long to wait.
 * @param signal - caller cancellation.
 */
export function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve()
      return
    }
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener?.('abort', done, { once: true })
  })
}
