/**
 * Validates the adapter against the REAL `dsh-llm` service, not a mock.
 *
 * This suite exists because a hand-written mock cannot catch the failure that
 * actually happened: `reasoning.efforts` was `['low', 'medium', 'high']`, and
 * `dsh-llm` rejects a bare string where it expects `{ id, name }` — throwing
 * INVALID_MODEL_REASONING and taking the whole provider offline. Every one of
 * our own tests passed, because our fake simply echoed the bad value back.
 *
 * So this file drives the genuine `LlmService` and lets its own validators
 * (`listModels`, `resolveModelInfo`) be the judge. It is the only test whose
 * verdict means "DSH will accept this".
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RelayAdapter } from '../lib/adapter.js'

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

const PROVIDER = 'dsh-model-gateway'

/** Build a real Cordis context with the real llm service mounted. */
async function makeRealLlm() {
  const { Context } = await import('@deepseek-ai/cordis')
  const LlmService = (await import('@deepseek-ai/dsh-llm')).default
  const ctx = new Context()
  const llm = new LlmService(ctx)
  return { ctx, llm }
}

const GROUPS = [{ name: 'hinds', models: ['a_b', 'c_d'], enabled: true }]

const EFFORTS = [
  { id: 'low', name: 'Low' },
  { id: 'high', name: 'High' },
]

/** Register the adapter under a real service and return that service. */
async function registered({ window, efforts = EFFORTS } = {}) {
  const { llm } = await makeRealLlm()
  const adapter = new RelayAdapter({
    providerId: PROVIDER,
    providerName: PROVIDER,
    listGroups: async () => GROUPS,
    groupCapabilities: async () => ({ contextWindow: window, efforts }),
    streamGroup: async function* () {},
    logger: { warn: () => {} },
  })
  llm.registerConfigurableProviders([{
    provider: PROVIDER, displayName: PROVIDER, settingsNs: 'llm-dsh-model-relay', settingsPath: [],
  }])
  llm.registerAdapter([PROVIDER], adapter)
  return { llm, adapter }
}

await test('the real service accepts reasoning metadata and lists the group', async () => {
  const { llm } = await registered({ window: 128000 })
  const models = await llm.listModels(PROVIDER)
  assert.deepEqual(models.map((entry) => entry.id), ['hinds'])
})

await test('every reasoning effort is a usable { id, name } object', async () => {
  const { llm } = await registered()
  const groups = await llm.listModels(PROVIDER)
  // The catalog strips reasoning, so re-read it through resolveModelInfo.
  const info = await llm.resolveModelInfo(PROVIDER, groups[0].id)
  assert.ok(Array.isArray(info.reasoning.efforts))
  for (const effort of info.reasoning.efforts) {
    assert.equal(typeof effort.id, 'string')
    assert.notEqual(effort.id, '')
    assert.equal(typeof effort.name, 'string')
    assert.notEqual(effort.name, '')
  }
})

await test('the real service keeps the intersection and reports no default', async () => {
  const { llm } = await registered({ window: 128000 })
  const info = await llm.resolveModelInfo(PROVIDER, 'hinds')
  assert.deepEqual(info.reasoning.efforts.map((effort) => effort.id), ['low', 'high'])
  // If this ever becomes a concrete id, DSH starts injecting it into every
  // request — which is the bug this suite exists to prevent returning.
  assert.equal(info.reasoning.defaultEffort, undefined)
})

await test('an empty intersection makes the real service report no reasoning at all', async () => {
  const { llm } = await registered({ window: 128000, efforts: [] })
  const info = await llm.resolveModelInfo(PROVIDER, 'hinds')
  // The regression this pins: returning `{ efforts: [] }` throws
  // INVALID_MODEL_REASONING inside `normalizeModelInfo`, and because
  // `buildModelCatalog` treats one throwing model as a failed provider, the
  // whole route disappears from the picker.
  assert.equal(info.reasoning, undefined)
})

await test('a group with no default never injects an effort into a call', async () => {
  const { llm } = await registered({ window: 128000 })
  // This is the exact mechanism behind "provider X does not support reasoning
  // effort high": `resolveCallWithInfo` fills the request in from
  // `defaultEffort` (dsh-llm:1572-1578). With no default declared, a caller that
  // names nothing must get nothing.
  const prepared = await llm.prepareCall({ provider: PROVIDER, model: 'hinds', messages: [] })
  assert.equal(prepared.config.reasoningEffort, undefined)
  // `adapterDefaults` is what DSH surfaces to the UI as "this value came from
  // the model, not from you" — an entry here would show a choice nobody made.
  assert.equal('reasoningEffort' in prepared.adapterDefaults, false)
})

await test('naming an advertised effort still reaches the member unchanged', async () => {
  const { llm } = await registered({ window: 128000 })
  // Dropping the default must not break an explicit choice.
  const prepared = await llm.prepareCall({ provider: PROVIDER, model: 'hinds', messages: [], reasoningEffort: 'low' })
  assert.equal(prepared.config.reasoningEffort, 'low')
})

await test('the real service rejects an effort the group does not advertise', async () => {
  const { llm } = await registered({ window: 128000, efforts: [{ id: 'low', name: 'Low' }] })
  // The intersection is enforced by DSH itself, which is the point of
  // advertising it: a caller cannot select an effort no member can honour.
  await assert.rejects(
    () => llm.prepareCall({ provider: PROVIDER, model: 'hinds', messages: [], reasoningEffort: 'high' }),
    (error) => error.code === 'UNSUPPORTED_REASONING_EFFORT',
  )
})

await test('efforts stay inside the set DeepSeek can actually translate', async () => {
  const { llm } = await registered()
  const info = await llm.resolveModelInfo(PROVIDER, 'hinds')
  // An invented effort is not rejected at registration; it fails much later,
  // mid-request, with UNSUPPORTED_REASONING_EFFORT. Keep them in the real set.
  const supported = new Set(['off', 'low', 'high', 'max'])
  for (const effort of info.reasoning.efforts) {
    assert.equal(supported.has(effort.id), true, `"${effort.id}" is not a DeepSeek effort`)
  }
})

await test('capacity reaches resolveModelInfo, which is what compaction reads', async () => {
  const { llm } = await registered({ window: 128000 })
  const info = await llm.resolveModelInfo(PROVIDER, 'hinds')
  assert.deepEqual(info.context, { contextWindow: 128000 })
})

await test('input modalities survive the service copy', async () => {
  const { llm } = await registered()
  const info = await llm.resolveModelInfo(PROVIDER, 'hinds')
  assert.deepEqual([...info.inputModalities], ['text', 'image'])
})

await test('the catalog carries exactly the fields the service forwards', async () => {
  const { llm } = await registered({ window: 128000 })
  const models = await llm.listModels(PROVIDER)
  // `contextWindow` must NOT be here: listModels drops unknown fields, so
  // attaching it would read as if it worked.
  assert.deepEqual(Object.keys(models[0]).sort(), ['id', 'inputModalities', 'name', 'provider'])
})

/**
 * The reported bug, reproduced end to end against a real service.
 *
 * The original failure was `provider "amd" model "DeepSeek-V4-Flash" does not
 * support reasoning effort "high"`. `amd` declares no reasoning block, so
 * `dsh-llm`'s `resolveCallWithInfo` takes its `reasoning === undefined` branch
 * and throws when the request carries ANY effort (dsh-llm:1570).
 *
 * A group containing such a member therefore cannot declare a default effort:
 * declaring one makes DSH materialize `reasoningEffort` into every request the
 * caller never asked about, and the member then rejects it. This case registers
 * a real member provider that declares no reasoning, builds a group over it,
 * and asserts the call the user reported failing now goes through.
 */
await test('a group over a member with no reasoning does not inject an effort', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const LlmService = (await import('@deepseek-ai/dsh-llm')).default
  const { LlmAdapter } = await import('@deepseek-ai/dsh-llm')
  const ctx = new Context()
  const llm = new LlmService(ctx)

  // A member that declares no reasoning at all — the `amd` shape. It extends
  // the real base class because the service calls inherited hooks such as
  // `providerRetryPolicy`; a hand-rolled object fails registration.
  class MemberAdapter extends LlmAdapter {
    providerInfo(provider) { return { id: provider, name: 'AMD' } }
    async listModels(provider) { return [{ provider, id: 'DeepSeek-V4-Flash', name: 'DeepSeek V4 Flash' }] }
    // No `reasoning` key: this model does not accept the parameter.
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, context: { contextWindow: 64000 } }
    }
    stream() {
      return (async function* generate() {
        yield { type: 'text-delta', index: 0, text: 'ok' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    }
  }
  llm.registerConfigurableProviders([{ provider: 'amd', displayName: 'AMD', settingsNs: 'llm-amd', settingsPath: [] }])
  llm.registerAdapter(['amd'], new MemberAdapter())

  const { RelayAdapter } = await import('../lib/adapter.js')
  const adapter = new RelayAdapter({
    providerId: PROVIDER,
    providerName: PROVIDER,
    listGroups: async () => [{ name: 'hinds', models: ['amd_DeepSeek-V4-Flash'], enabled: true }],
    // The gateway's real walk: one member, no reasoning declared, so the
    // intersection is empty and no effort may be advertised.
    groupCapabilities: async () => ({ contextWindow: 64000, efforts: [] }),
    streamGroup: async function* () {},
    logger: { warn: () => {} },
  })
  llm.registerConfigurableProviders([{
    provider: PROVIDER, displayName: PROVIDER, settingsNs: 'llm-dsh-model-relay', settingsPath: [],
  }])
  llm.registerAdapter([PROVIDER], adapter)

  const info = await llm.resolveModelInfo(PROVIDER, 'hinds')
  assert.equal(info.reasoning, undefined)
  assert.deepEqual(info.context, { contextWindow: 64000 })

  // The exact call that used to fail. Nothing is named, so nothing may be sent.
  const prepared = await llm.prepareCall({ provider: PROVIDER, model: 'hinds', messages: [] })
  assert.equal(prepared.config.reasoningEffort, undefined)

  // And the member's own resolution must now accept what the group would send.
  const memberPrepared = await llm.prepareCall({ provider: 'amd', model: 'DeepSeek-V4-Flash', messages: [] })
  assert.equal(memberPrepared.config.reasoningEffort, undefined)
})

await test('a group that DID declare a default would reproduce the reported failure', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const LlmService = (await import('@deepseek-ai/dsh-llm')).default
  const { LlmAdapter } = await import('@deepseek-ai/dsh-llm')
  const ctx = new Context()
  const llm = new LlmService(ctx)

  class MemberAdapter extends LlmAdapter {
    providerInfo(provider) { return { id: provider, name: 'AMD' } }
    async listModels(provider) { return [{ provider, id: 'DeepSeek-V4-Flash', name: 'Flash' }] }
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    stream() { return (async function* () {})() }
  }
  llm.registerConfigurableProviders([{ provider: 'amd', displayName: 'AMD', settingsNs: 'llm-amd', settingsPath: [] }])
  llm.registerAdapter(['amd'], new MemberAdapter())

  // A deliberately unfixed adapter: exactly what the plugin used to return.
  class UnfixedAdapter extends LlmAdapter {
    providerInfo(provider) { return { id: provider, name: PROVIDER } }
    async listModels(provider) { return [{ provider, id: 'hinds', name: 'hinds' }] }
    async resolveModel(provider, model) {
      return {
        provider, id: model, name: model,
        reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }], defaultEffort: 'high' },
      }
    }
    stream() { return (async function* () {})() }
  }
  llm.registerConfigurableProviders([{
    provider: PROVIDER, displayName: PROVIDER, settingsNs: 'llm-dsh-model-relay', settingsPath: [],
  }])
  llm.registerAdapter([PROVIDER], new UnfixedAdapter())

  // Naming no effort still materializes 'high' from the default...
  const prepared = await llm.prepareCall({ provider: PROVIDER, model: 'hinds', messages: [] })
  assert.equal(prepared.config.reasoningEffort, 'high', 'the default is injected although nobody asked')

  // ...and forwarding that to the member is the reported error, verbatim.
  await assert.rejects(
    () => llm.prepareCall({ provider: 'amd', model: 'DeepSeek-V4-Flash', messages: [], reasoningEffort: 'high' }),
    (error) => {
      assert.equal(error.code, 'UNSUPPORTED_REASONING_EFFORT')
      assert.equal(
        error.message,
        'provider "amd" model "DeepSeek-V4-Flash" does not support reasoning effort "high"',
      )
      return true
    },
  )
})

if (failures > 0) {
  console.log(`\n${failures} failing`)
  process.exitCode = 1
} else {
  console.log('\nall real-service adapter tests passed')
}
