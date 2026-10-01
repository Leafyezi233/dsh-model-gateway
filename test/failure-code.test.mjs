/**
 * Does a group failure reach the agent loop with a retryable code?
 *
 * This suite pins the second mock blindspot. `dsh-llm-retry` — which IS mounted
 * in `dsh-base` — decides whether to retry from the failure code that arrives
 * at the agent loop:
 *
 *     policy.retryableCodes.includes(failure.code)
 *
 * against `EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`.
 *
 * The gateway's failover loop ends by THROWING a `GatewayError` once every
 * member has failed. That throw crosses `dsh-llm`'s adapter boundary, where
 * `normalizeLlmFailure` (dsh-llm:367-436) trusts a code ONLY from a
 * `HarnessError`, or from an own `failure` data property whose `code` matches
 * the error's own `code`. A plain `Error` subclass therefore reports `UNKNOWN`
 * — and with it silently loses all retryability.
 *
 * No mock-based suite can see this, because a fake `llm` never runs the real
 * boundary. This file mounts the REAL plugin onto a REAL `LlmService` and reads
 * the terminal chunk the agent loop would act on.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmService, { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import { apply } from '../lib/index.js'

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

/** The codes `dsh-llm-retry` acts on by default. */
const RETRYABLE = ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']

const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-code-'))
let seq = 0

/**
 * A member adapter whose every call fails the given way.
 *
 * `fail` is a GENERATOR FACTORY, not an async function: a generator factory
 * returned straight from `stream()` is what an adapter really does. Awaiting
 * one instead would hand back the function itself and yield nothing.
 */
class MemberAdapter extends LlmAdapter {
  constructor(fail) {
    super()
    this.fail = fail
  }
  providerInfo(provider) { return { id: provider, name: 'Member' } }
  async listModels(provider) { return [{ provider, id: 'm', name: 'm' }] }
  async resolveModel(provider, model) {
    return { provider, id: model, name: model, context: { contextWindow: 128000 } }
  }
  stream() { return this.fail() }
}

/** Fail the way a real provider adapter does: a terminal error CHUNK. */
const yieldsError = (code, message = 'slow down', providerRetryAfterMs) => async function* () {
  yield {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: {
        code,
        message,
        ...(providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs }),
      },
    },
  }
}

/** Fail the way a real adapter does when it rejects the request outright. */
const throwsLlmError = (code, message = 'slow down') => async function* () {
  throw new LlmError(message, code)
}

/** Emit real output, then fail — the attempt is committed and must not move on. */
const yieldsThenFails = (code) => async function* () {
  yield { type: 'text-delta', index: 0, text: 'partial' }
  yield { type: 'finish', reason: { kind: 'error', failure: { code, message: 'cut off' } } }
}

const healthy = async function* () {
  yield { type: 'text-delta', index: 0, text: 'hi' }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

/**
 * Mount the real plugin over a real `LlmService` and one member provider.
 * @param fail - generator factory describing how the member fails.
 * @param members - the group's candidate list.
 * @returns the live service, so the caller can stream the group.
 */
async function mounted(fail, members = ['member_m']) {
  const ctx = new Context()
  const llm = new LlmService(ctx)
  ctx.llm = llm
  // The plugin mounts HTTP routes; a recording stub is enough because this
  // suite exercises the DSH-facing adapter path, not the wire protocol.
  ctx.webServer = { port: 3080, host: '127.0.0.1', register: () => () => {} }

  llm.registerConfigurableProviders([{ provider: 'member', displayName: 'Member', settingsNs: 'llm-member', settingsPath: [] }])
  llm.registerAdapter(['member'], new MemberAdapter(fail))

  const groupsFile = join(dir, `g${seq++}.json`)
  writeFileSync(groupsFile, JSON.stringify({
    version: 1,
    groups: [{ id: 'g', name: 'g', models: members, enabled: true }],
  }))
  apply(ctx, { keysFile: join(dir, `k${seq++}.json`), groupsFile })
  return { llm, ctx }
}

/** Stream a group and return its terminal reason, plus every chunk seen. */
async function terminalOf(llm, model = 'g') {
  const chunks = []
  for await (const chunk of llm.stream({ provider: 'dsh-model-gateway', model, messages: [] })) {
    chunks.push(chunk)
  }
  return { reason: chunks.find((chunk) => chunk.type === 'finish')?.reason, chunks }
}

await test('a rate-limited member reaches the agent loop as RATE_LIMIT', async () => {
  const { llm } = await mounted(yieldsError('RATE_LIMIT'))
  const { reason } = await terminalOf(llm)
  assert.equal(reason.kind, 'error')
  // Without the fix this is UNKNOWN, so a transient 429 becomes a dead turn.
  assert.equal(reason.failure.code, 'RATE_LIMIT')
  assert.equal(RETRYABLE.includes(reason.failure.code), true)
})

await test('a member that throws a typed error keeps its code too', async () => {
  const { llm } = await mounted(throwsLlmError('SERVER'))
  const { reason } = await terminalOf(llm)
  assert.equal(reason.kind, 'error')
  assert.equal(reason.failure.code, 'SERVER')
  assert.equal(RETRYABLE.includes(reason.failure.code), true)
})

await test('the upstream HTTP status survives as well', async () => {
  const { llm } = await mounted(yieldsError('RATE_LIMIT'))
  const { reason } = await terminalOf(llm)
  // `statusForCode` maps RATE_LIMIT to 429, which lets the `/v1` envelope and
  // the caller report the real upstream condition.
  assert.equal(reason.failure.status, 429)
})

await test('every retryable code survives, not just one', async () => {
  for (const code of RETRYABLE) {
    const { llm } = await mounted(yieldsError(code))
    const { reason } = await terminalOf(llm)
    assert.equal(reason.failure.code, code, `${code} was downgraded to ${reason.failure.code}`)
  }
})

await test('a non-retryable failure keeps its own code rather than becoming UNKNOWN', async () => {
  const { llm } = await mounted(yieldsError('MISSING_CREDENTIAL'))
  const { reason } = await terminalOf(llm)
  // A missing key must not be retried, but it also must not be reported as an
  // opaque UNKNOWN — the user needs to know a credential is absent.
  assert.equal(reason.failure.code, 'MISSING_CREDENTIAL')
  assert.equal(RETRYABLE.includes(reason.failure.code), false)
})

await test('the failure message survives', async () => {
  const { llm } = await mounted(yieldsError('RATE_LIMIT'))
  const { reason } = await terminalOf(llm)
  assert.equal(reason.failure.message, 'slow down')
})

await test('a committed failure after real output keeps its code', async () => {
  const { llm } = await mounted(yieldsThenFails('RATE_LIMIT'))
  const { reason, chunks } = await terminalOf(llm)
  // The member already emitted text, so failing over would replay content the
  // caller has seen; the failure is reported instead — still with its code.
  assert.equal(chunks.some((chunk) => chunk.type === 'text-delta'), true)
  assert.equal(reason.kind, 'error')
  assert.equal(reason.failure.code, 'RATE_LIMIT')
})

await test('a healthy group is untouched', async () => {
  const { llm } = await mounted(healthy)
  const { reason, chunks } = await terminalOf(llm)
  assert.equal(reason.kind, 'stop')
  assert.equal(chunks.some((chunk) => chunk.type === 'text-delta' && chunk.text === 'hi'), true)
})

/**
 * The upstream's own backoff hint must reach `dsh-llm-retry`.
 *
 * That executor prefers `failure.providerRetryAfterMs` over its local backoff
 * (dsh-llm-retry:168-172), so losing it makes the harness hammer a provider
 * that just asked for quiet — the opposite of what the header is for.
 */
await test("the provider's retry hint survives to the agent loop", async () => {
  const { llm } = await mounted(yieldsError('RATE_LIMIT', 'slow down', 30000))
  const { reason } = await terminalOf(llm)
  assert.equal(reason.failure.providerRetryAfterMs, 30000)
})

await test('the retry hint survives alongside a non-429 status mapping', async () => {
  // A hint is not exclusive to rate limiting: any retryable failure may carry
  // one. `SERVER` maps to 502, so this also pins that the hint does not depend
  // on the code being RATE_LIMIT. (Which member's hint wins when several fail
  // is covered end-to-end in `gateway.test.mjs`.)
  const { llm } = await mounted(yieldsError('SERVER', 'upstream fell over', 12000))
  const { reason } = await terminalOf(llm)
  assert.equal(reason.failure.code, 'SERVER')
  assert.equal(reason.failure.providerRetryAfterMs, 12000)
})

/**
 * A malformed hint must not cost the failure its CODE.
 *
 * `failureSnapshot` (dsh-llm:404-424) rejects the ENTIRE snapshot — code
 * included — when any single field is invalid, so attaching a bad
 * `providerRetryAfterMs` would silently reintroduce the UNKNOWN bug. The
 * gateway therefore only attaches it when it is a positive finite number.
 */
await test('a nonsensical retry hint is dropped without losing the code', async () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const { llm } = await mounted(yieldsError('RATE_LIMIT', 'slow down', bad))
    const { reason } = await terminalOf(llm)
    assert.equal(reason.failure.code, 'RATE_LIMIT', `hint ${bad} cost us the code`)
    assert.equal(reason.failure.providerRetryAfterMs, undefined, `hint ${bad} should not survive`)
  }
})

await test('a failure with no hint carries none', async () => {
  const { llm } = await mounted(yieldsError('RATE_LIMIT'))
  const { reason } = await terminalOf(llm)
  assert.equal(reason.failure.providerRetryAfterMs, undefined)
  // ...and the absence must not disturb the code, which is the retry decider.
  assert.equal(reason.failure.code, 'RATE_LIMIT')
})

if (failures > 0) {
  console.log(`\n${failures} failing`)
  process.exitCode = 1
} else {
  console.log('\nall failure-code tests passed')
}
