/**
 * Verifies that the DSH provider registration is wired correctly.
 *
 * The gateway registers itself as a provider so a model group is selectable
 * inside DSH. That registration touches three separate APIs, and getting any
 * one of them wrong fails silently — the card simply does not appear. This test
 * supplies a fake `llm` that records what was registered, so the wiring is
 * checked without a running harness.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-reg-'))
let seq = 0
const files = () => ({ keysFile: join(dir, `k${seq}.json`), groupsFile: join(dir, `g${seq++}.json`) })

/**
 * A fake context whose llm service records registration calls.
 *
 * `settingsShape` picks which settings service the host pretends to be:
 *  - 'legacy' (default): 0.1.5-shaped — `register` plus `installSection`,
 *    recording the namespaces sections were installed under;
 *  - 'entry-id': 0.1.7-shaped — no `register`, only `configure`, recording
 *    the policy calls;
 *  - 'empty': a service speaking neither model.
 *
 * The 0.1.5 fake carries `register` on purpose: it is the discriminator the
 * wiring probes, and `installSection` alone would describe a transitional
 * host the real harness never produces. `fiber` stands in for the composition
 * entry the 0.1.7 loader reports (with its kind prefix).
 */
function makeCtx({ withLlm = true, withSettings = true, settingsShape = 'legacy', fiber, efforts, window, streamFor } = {}) {
  const registered = { providers: [], adapters: [], sections: [], configured: [], disposed: 0 }
  const infos = []
  const warnings = []
  const capabilityReads = []
  /** Every dispatch the gateway made, in order, as `provider/model`. */
  const streamCalls = []
  const settingsService = !withSettings
    ? undefined
    : settingsShape === 'legacy'
      ? {
          register: () => ({}),
          installSection: (_c, ns, _schema, _value, _hooks) => {
            registered.sections.push(ns)
          },
        }
      : settingsShape === 'entry-id'
        ? {
            configure: (policy) => {
              registered.configured.push(policy)
            },
          }
        : {}
  const ctx = {
    logger: { info: (m) => infos.push(m), warn: (m) => warnings.push(m) },
    ...(fiber === undefined ? {} : { fiber }),
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') ctx.__disposers.push(dispose)
      return () => {}
    },
    __disposers: [],
    get: (key) => (key === 'settings' ? settingsService : undefined),
    inject: (services, callback) => {
      callback({
        get: (key) => {
          if (key === 'settings') {
            return settingsService
          }
          if (key === 'connection') {
            return { fetch: { register: async () => () => {} } }
          }
          return undefined
        },
      })
      return Promise.resolve()
    },
    webServer: { port: 3080, host: '127.0.0.1', register: () => () => {} },
  }
  if (withLlm) {
    ctx.llm = {
      listProviders: () => [{ id: 'codebuddy', name: 'CodeBuddy' }],
      listModels: async (provider) => [{ provider, id: 'glm-5.2', name: 'GLM' }],
      stream: (options) => {
        streamCalls.push(`${options.provider}/${options.model}`)
        const scripted = streamFor?.(options)
        if (scripted !== undefined) return scripted
        return (async function* generate() { yield { type: 'text-delta', index: 0, text: 'x' } })()
      },
      /**
       * Per-member capability, so the group's intersection is observable here.
       * `efforts` maps a model id to that member's declared list; an id absent
       * from the map stands for a member that declares no reasoning at all.
       * `window` overrides a member's capacity, including to undefined.
       */
      resolveModelInfo: async (provider, model) => {
        capabilityReads.push(`${provider}_${model}`)
        const contextWindow = window !== undefined && model in window ? window[model] : 128000
        return {
          provider,
          id: model,
          ...(contextWindow === undefined ? {} : { context: { contextWindow } }),
          ...(efforts?.[model] === undefined ? {} : { reasoning: { efforts: efforts[model] } }),
        }
      },
      registerConfigurableProviders: (entries) => {
        registered.providers.push(...entries)
        return () => { registered.disposed += 1 }
      },
      registerAdapter: (providers, adapter) => {
        registered.adapters.push({ providers, adapter })
        return () => { registered.disposed += 1 }
      },
    }
  }
  return { ctx, registered, infos, warnings, capabilityReads, streamCalls, settingsService }
}

/** Write a groups file naming the given members, and return the mount config. */
function groupsWith(members, scheduling = {}) {
  const config = files()
  writeFileSync(config.groupsFile, JSON.stringify({
    version: 2,
    groups: [{ id: 'g', name: 'g', models: members, enabled: true, ...scheduling }],
  }))
  return config
}

/** A terminal failure chunk, in the shape `dsh-llm` actually produces. */
const failureChunk = (code, message, providerRetryAfterMs) => ({
  type: 'finish',
  reason: {
    kind: 'error',
    failure: { code, message, ...(providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs }) },
  },
})

/** Drain one adapter stream into an array of chunks. */
async function drain(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

await test('the gateway registers itself as a DSH provider', async () => {
  const { ctx, registered } = makeCtx()
  apply(ctx, files())
  assert.equal(registered.providers.length, 1)
  const entry = registered.providers[0]
  assert.equal(entry.provider, 'dsh-model-relay')
  assert.equal(entry.displayName, 'dsh-model-relay')
  assert.equal(entry.settingsNs, 'llm-dsh-model-relay')
  assert.deepEqual(entry.settingsPath, [])
})

await test('the adapter is bound to that exact route and preserves the id', async () => {
  const { ctx, registered } = makeCtx()
  apply(ctx, files())
  assert.equal(registered.adapters.length, 1)
  const { providers, adapter } = registered.adapters[0]
  assert.deepEqual(providers, ['dsh-model-relay'])
  // The runtime compares these; a mismatch throws INVALID_ADAPTER at load.
  assert.deepEqual(adapter.providerInfo('dsh-model-relay'), { id: 'dsh-model-relay', name: 'dsh-model-relay' })
})

await test('a settings section is installed under the provider namespace', async () => {
  const { ctx, registered } = makeCtx()
  apply(ctx, files())
  // Without this the Models page silently omits the card: it renders a row
  // only when the namespace resolves in the settings mirror.
  assert.deepEqual(registered.sections, ['llm-dsh-model-relay'])
})

await test('both registrations are released together on dispose', async () => {
  const { ctx, registered } = makeCtx()
  apply(ctx, files())
  for (const dispose of ctx.__disposers) dispose()
  assert.equal(registered.disposed, 2, 'provider and adapter registrations both released')
})

await test('a composition without llm still serves /v1', async () => {
  const { ctx, infos, warnings } = makeCtx({ withLlm: false })
  apply(ctx, files())
  assert.equal(infos.some((line) => line.includes('llm service not available')), true)
  assert.equal(warnings.length, 0, 'this is expected, not a warning')
})

await test('a missing settings service does not break registration', async () => {
  const { ctx, registered, warnings } = makeCtx({ withSettings: false })
  apply(ctx, files())
  assert.equal(registered.adapters.length, 1, 'the provider still registers')
  assert.equal(warnings.some((line) => typeof line === 'string' && line.includes('settings service absent')), true)
})

await test('a registration failure is contained and reported', async () => {
  const { ctx, infos } = makeCtx()
  ctx.llm.registerAdapter = () => { throw new Error('DUPLICATE_ADAPTER') }
  apply(ctx, files())
  assert.equal(infos.length > 0, true)
  // The gateway must keep working over /v1 even when the provider is refused.
  assert.equal(ctx.llm.listProviders().length, 1)
})

/**
 * The settings integration has two generations, and the wiring picks its path
 * from what the host can do — never from a version literal. These cases pin
 * both paths and the transitions between them.
 */

await test('a 0.1.7 host keys the provider card by the bare entry id', async () => {
  const { ctx, registered } = makeCtx({
    settingsShape: 'entry-id',
    fiber: { entry: { id: 'include:dsh-model-relay' } },
  })
  apply(ctx, files())
  assert.equal(registered.providers.length, 1)
  // The kind prefix the 0.1.7 loader reports must not leak into the namespace:
  // the settings service indexes the bare id, and the prefixed form 409s.
  assert.equal(registered.providers[0].settingsNs, 'dsh-model-relay')
  assert.deepEqual(registered.sections, [], 'nothing to install — the namespace is the entry id')
  assert.deepEqual(registered.configured, [{ auto: false }], 'the host-generated page is suppressed; the plugin has its own')
})

await test('a 0.1.7 host without a reachable entry id falls back to the declared id', async () => {
  const { ctx, registered } = makeCtx({ settingsShape: 'entry-id' })
  apply(ctx, files())
  assert.equal(registered.providers[0].settingsNs, 'dsh-model-relay')
})

await test('a pre-0.1.7 host ignores the entry id even when one is present', async () => {
  const { ctx, registered } = makeCtx({
    settingsShape: 'legacy',
    fiber: { entry: { id: 'include:dsh-model-relay' } },
  })
  apply(ctx, files())
  // The legacy service owns namespaces by registration; the entry id plays no
  // part there, and switching it would silently orphan every existing install.
  assert.equal(registered.providers[0].settingsNs, 'llm-dsh-model-relay')
  assert.deepEqual(registered.sections, ['llm-dsh-model-relay'])
  assert.deepEqual(registered.configured, [])
})

await test('a settings service speaking neither model still registers the provider', async () => {
  const { ctx, registered, warnings } = makeCtx({ settingsShape: 'empty' })
  apply(ctx, files())
  assert.equal(registered.providers.length, 1)
  assert.deepEqual(registered.sections, [])
  assert.equal(warnings.some((line) => typeof line === 'string' && line.includes('settings integration failed')), false)
})

await test('a 0.1.7 configure failure is contained and reported', async () => {
  const { ctx, registered, warnings, settingsService } = makeCtx({ settingsShape: 'entry-id' })
  settingsService.configure = () => { throw new Error('NO_POLICY') }
  apply(ctx, files())
  // The card is served by the entry-id join alone; a refused policy call must
  // not take the registration down with it.
  assert.equal(registered.providers.length, 1)
  assert.equal(warnings.some((line) => typeof line === 'string' && line.includes('settings integration failed')), true)
})

/**
 * The group's advertised efforts are computed by the gateway and handed to the
 * adapter, so these cases drive the real `groupCapabilities` walk through the
 * registered adapter rather than testing the adapter in isolation.
 */
const FOUR = [
  { id: 'off', name: 'Off' },
  { id: 'low', name: 'Low' },
  { id: 'high', name: 'High' },
  { id: 'max', name: 'Max' },
]

await test('a group advertises the intersection of its members, never the union', async () => {
  const { ctx, registered } = makeCtx({
    efforts: {
      'glm-5.2': FOUR,
      'chat': [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
    },
  })
  apply(ctx, groupsWith(['codebuddy_glm-5.2', 'codebuddy_chat']))
  const adapter = registered.adapters[0].adapter
  const resolved = await adapter.resolveModel('dsh-model-relay', 'g')
  // `off` and `max` are offered by only one member: advertising them would let
  // a caller pick a level the other member rejects mid-request.
  assert.deepEqual(resolved.reasoning.efforts.map((e) => e.id), ['low', 'high'])
  assert.equal('defaultEffort' in resolved.reasoning, false)
})

await test('a member with no reasoning collapses the group to no choice at all', async () => {
  const { ctx, registered } = makeCtx({
    efforts: { 'glm-5.2': FOUR },
    // `chat` is absent from the map, so it declares no reasoning block — which
    // is a different statement from "supports none of these levels".
  })
  apply(ctx, groupsWith(['codebuddy_glm-5.2', 'codebuddy_chat']))
  const adapter = registered.adapters[0].adapter
  const resolved = await adapter.resolveModel('dsh-model-relay', 'g')
  assert.equal('reasoning' in resolved, false)
  // Losing the effort choice must NOT cost the group its capacity: the two
  // facts are independent, and dropping capacity would silently switch
  // auto-compaction off for a long session over an unrelated field.
  assert.deepEqual(resolved.context, { contextWindow: 128000 })
})

await test('an unreadable member capacity does not erase a known effort set', async () => {
  const { ctx, registered } = makeCtx({
    efforts: { 'glm-5.2': FOUR, 'chat': FOUR },
    window: { 'chat': undefined },
  })
  apply(ctx, groupsWith(['codebuddy_glm-5.2', 'codebuddy_chat']))
  const adapter = registered.adapters[0].adapter
  const resolved = await adapter.resolveModel('dsh-model-relay', 'g')
  // The minimum over a partial walk is not the group's capacity, so it must be
  // omitted — but the reasoning answer is unaffected and still valid.
  assert.equal('context' in resolved, false)
  assert.deepEqual(resolved.reasoning.efforts.map((e) => e.id), ['off', 'low', 'high', 'max'])
})

await test('a group whose members all agree keeps the shared levels', async () => {
  const { ctx, registered } = makeCtx({ efforts: { 'glm-5.2': FOUR, 'chat': FOUR } })
  apply(ctx, groupsWith(['codebuddy_glm-5.2', 'codebuddy_chat']))
  const adapter = registered.adapters[0].adapter
  const resolved = await adapter.resolveModel('dsh-model-relay', 'g')
  assert.deepEqual(resolved.reasoning.efforts.map((e) => e.id), ['off', 'low', 'high', 'max'])
  assert.equal('defaultEffort' in resolved.reasoning, false)
})

await test('capacity and efforts come from the same single member walk', async () => {
  const { ctx, registered, capabilityReads } = makeCtx({
    efforts: { 'glm-5.2': FOUR, 'chat': FOUR },
  })
  apply(ctx, groupsWith(['codebuddy_glm-5.2', 'codebuddy_chat']))
  const adapter = registered.adapters[0].adapter
  const resolved = await adapter.resolveModel('dsh-model-relay', 'g')
  assert.deepEqual(resolved.context, { contextWindow: 128000 })
  // One read per member, not one per fact: the two answers are gathered
  // together, and the result is cached for the next catalog build.
  assert.equal(capabilityReads.length, 2, `expected one read per member, got ${capabilityReads.join(', ')}`)
})

await test('a group naming an unreachable member advertises nothing rather than guessing', async () => {
  const { ctx, registered } = makeCtx({ efforts: { 'glm-5.2': FOUR } })
  apply(ctx, groupsWith(['codebuddy_glm-5.2', 'nosuch_glm-5.2']))
  const adapter = registered.adapters[0].adapter
  const resolved = await adapter.resolveModel('dsh-model-relay', 'g')
  assert.equal('reasoning' in resolved, false)
  assert.equal('context' in resolved, false)
})

/**
 * Scheduling on the DSH-side path.
 *
 * These drive the adapter the gateway actually registered, so the ordering and
 * the rate-limit retry are exercised through `streamGroup` — the same walk
 * `/v1` uses. The two entry points must not drift, and this is what pins the
 * DSH half of that.
 */

await test('the DSH-side stream tries candidates in the stored order', async () => {
  const { ctx, registered, streamCalls } = makeCtx()
  apply(ctx, groupsWith(['codebuddy_glm-5.2', 'codebuddy_chat']))
  const adapter = registered.adapters[0].adapter
  await drain(adapter.stream({ model: 'g' }))
  assert.deepEqual(streamCalls, ['codebuddy/glm-5.2'])
})

await test('the DSH-side stream rotates a balanced group between calls', async () => {
  const { ctx, registered, streamCalls } = makeCtx()
  apply(ctx, groupsWith(['codebuddy_glm-5.2', 'codebuddy_chat'], { strategy: 'round-robin' }))
  const adapter = registered.adapters[0].adapter
  for (let call = 0; call < 3; call += 1) await drain(adapter.stream({ model: 'g' }))
  // Two members, so the head alternates instead of sticking.
  assert.deepEqual(streamCalls, ['codebuddy/glm-5.2', 'codebuddy/chat', 'codebuddy/glm-5.2'])
})

await test('the DSH-side stream fails over when the first member dies before output', async () => {
  const { ctx, registered, streamCalls, warnings } = makeCtx({
    streamFor: (options) => {
      if (options.model !== 'glm-5.2') return undefined
      return (async function* failing() { throw Object.assign(new Error('gone'), { code: 'MISSING_CREDENTIAL' }) })()
    },
  })
  apply(ctx, groupsWith(['codebuddy_glm-5.2', 'codebuddy_chat']))
  const adapter = registered.adapters[0].adapter
  const chunks = await drain(adapter.stream({ model: 'g' }))
  // The healthy member served it; the caller never sees the dead one.
  assert.equal(chunks.some((chunk) => chunk.type === 'text-delta'), true)
  assert.deepEqual(streamCalls, ['codebuddy/glm-5.2', 'codebuddy/chat'])
  assert.equal(warnings.some((line) => typeof line === 'string' && line.includes('trying the next')), true)
})

await test('the DSH-side stream retries a rate-limited member on the same candidate', async () => {
  let attempts = 0
  const { ctx, registered, streamCalls } = makeCtx({
    streamFor: (options) => {
      if (options.model !== 'glm-5.2') return undefined
      attempts += 1
      if (attempts === 1) {
        return (async function* limited() { yield failureChunk('RATE_LIMIT', 'slow down') })()
      }
      return undefined
    },
  })
  apply(ctx, groupsWith(['codebuddy_glm-5.2', 'codebuddy_chat'], { strategy: 'sequential', retry429: 1 }))
  const adapter = registered.adapters[0].adapter
  const chunks = await drain(adapter.stream({ model: 'g' }))
  // This is the point of enabling the retry on the DSH path: the rate limit is
  // absorbed here instead of being handed to the agent loop, which would spend
  // one of its own five retries on it.
  assert.deepEqual(streamCalls, ['codebuddy/glm-5.2', 'codebuddy/glm-5.2'])
  assert.equal(attempts, 2)
  assert.equal(chunks.some((chunk) => chunk.type === 'text-delta'), true)
})

await test('the DSH-side stream does not retry an exhausted quota', async () => {
  const { ctx, registered, streamCalls } = makeCtx({
    streamFor: (options) => {
      if (options.model !== 'glm-5.2') return undefined
      return (async function* outOfQuota() { yield failureChunk('QUOTA', 'out of quota') })()
    },
  })
  apply(ctx, groupsWith(['codebuddy_glm-5.2', 'codebuddy_chat'], { strategy: 'sequential', retry429: 3 }))
  const adapter = registered.adapters[0].adapter
  await drain(adapter.stream({ model: 'g' }))
  assert.deepEqual(streamCalls, ['codebuddy/glm-5.2', 'codebuddy/chat'])
})

await test('the DSH-side stream never retries after output was yielded', async () => {
  const { ctx, registered, streamCalls } = makeCtx({
    streamFor: (options) => {
      if (options.model !== 'glm-5.2') return undefined
      return (async function* diesAfterOutput() {
        yield { type: 'text-delta', index: 0, text: 'partial' }
        yield failureChunk('RATE_LIMIT', 'slow down')
      })()
    },
  })
  apply(ctx, groupsWith(['codebuddy_glm-5.2', 'codebuddy_chat'], { strategy: 'sequential', retry429: 3 }))
  const adapter = registered.adapters[0].adapter
  const chunks = await drain(adapter.stream({ model: 'g' }))
  // Replaying would duplicate content the consumer already received.
  assert.deepEqual(streamCalls, ['codebuddy/glm-5.2'])
  assert.equal(chunks.some((chunk) => chunk.type === 'text-delta'), true)
})


if (failures > 0) {
  console.log(`\n${failures} failing`)
  process.exitCode = 1
} else {
  console.log('\nall registration tests passed')
}
