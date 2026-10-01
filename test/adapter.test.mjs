/**
 * Tests for the DSH-facing adapter.
 *
 * The adapter is what makes a model group selectable inside DSH itself, so
 * these cases pin the three things DSH reads from it: the model list (groups),
 * the context capacity that decides whether long sessions get compacted, and
 * the reasoning efforts a group is allowed to offer.
 */
import assert from 'node:assert/strict'
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

const EFFORTS = [
  { id: 'low', name: 'Low' },
  { id: 'high', name: 'High' },
]

/** Build an adapter over a fixed group list. */
function makeAdapter(groups, { window, efforts } = {}) {
  const warnings = []
  return {
    warnings,
    adapter: new RelayAdapter({
      providerId: PROVIDER,
      providerName: PROVIDER,
      listGroups: async () => groups,
      groupCapabilities: async (models) => ({
        contextWindow: typeof window === 'function' ? window(models) : window,
        efforts: typeof efforts === 'function' ? efforts(models) : efforts ?? [],
      }),
      streamGroup: async function* (name) { yield { type: 'text-delta', text: name } },
      logger: { warn: (message) => warnings.push(message) },
    }),
  }
}

await test('providerInfo echoes the route id it was registered under', async () => {
  const { adapter } = makeAdapter([])
  // The runtime rejects a registration whose metadata does not preserve the id.
  assert.deepEqual(adapter.providerInfo(PROVIDER), { id: PROVIDER, name: PROVIDER })
})

await test('listModels exposes every enabled group under its own name', async () => {
  const { adapter } = makeAdapter([
    { name: 'fast-chat', models: ['codebuddy_glm-5.2'], enabled: true },
    { name: 'off', models: ['codebuddy_glm-5.2'], enabled: false },
  ])
  const models = await adapter.listModels(PROVIDER)
  assert.deepEqual(models.map((entry) => entry.id), ['fast-chat'])
  assert.equal(models[0].provider, PROVIDER)
})

await test('every group advertises text and image input', async () => {
  const { adapter } = makeAdapter([{ name: 'g', models: ['a_b'], enabled: true }])
  const models = await adapter.listModels(PROVIDER)
  // An explicit omission means "cannot", and DSH would refuse image requests.
  assert.deepEqual(models[0].inputModalities, ['text', 'image'])
})

await test('resolveModel reports capacity so DSH can compact long sessions', async () => {
  const { adapter } = makeAdapter(
    [{ name: 'g', models: ['a_b', 'c_d'], enabled: true }],
    { window: 128000, efforts: EFFORTS },
  )
  const resolved = await adapter.resolveModel(PROVIDER, 'g')
  assert.equal(resolved.provider, PROVIDER)
  assert.equal(resolved.id, 'g')
  assert.deepEqual(resolved.context, { contextWindow: 128000 })
  assert.deepEqual(resolved.inputModalities, ['text', 'image'])
})

await test('a group never declares a default effort', async () => {
  const { adapter } = makeAdapter(
    [{ name: 'g', models: ['a_b'], enabled: true }],
    { window: 128000, efforts: EFFORTS },
  )
  const resolved = await adapter.resolveModel(PROVIDER, 'g')
  // Declaring one is not a hint: DSH materializes it into EVERY request that
  // did not name an effort, and that value is then forwarded to whichever
  // member answers — so a member that does not accept it fails with
  // UNSUPPORTED_REASONING_EFFORT although the caller asked for nothing.
  assert.equal('defaultEffort' in resolved.reasoning, false)
})

await test('the advertised efforts are the intersection, in declaration order', async () => {
  const { adapter } = makeAdapter(
    [{ name: 'g', models: ['a_b', 'c_d'], enabled: true }],
    { window: 128000, efforts: EFFORTS },
  )
  const resolved = await adapter.resolveModel(PROVIDER, 'g')
  assert.deepEqual(resolved.reasoning.efforts.map((effort) => effort.id), ['low', 'high'])
  for (const effort of resolved.reasoning.efforts) {
    // DSH validates each entry as an object with non-empty string id and name,
    // and rejects the whole provider when one is a bare string.
    assert.equal(typeof effort.name, 'string')
    assert.notEqual(effort.name, '')
  }
})

await test('an empty intersection hides the effort picker instead of failing', async () => {
  const { adapter } = makeAdapter(
    [{ name: 'g', models: ['a_b'], enabled: true }],
    { window: 128000, efforts: [] },
  )
  const resolved = await adapter.resolveModel(PROVIDER, 'g')
  // An empty `efforts` array is rejected outright by DSH; omitting the whole
  // block is how a group says "no choice to offer".
  assert.equal('reasoning' in resolved, false)
})

await test('malformed effort entries are dropped rather than passed to DSH', async () => {
  const { adapter } = makeAdapter(
    [{ name: 'g', models: ['a_b'], enabled: true }],
    {
      window: 128000,
      efforts: [
        { id: 'low', name: 'Low' },
        { id: '', name: 'Nameless' },
        { id: 'dup', name: 'First' },
        { id: 'dup', name: 'Second' },
        { id: 'noname' },
      ],
    },
  )
  const resolved = await adapter.resolveModel(PROVIDER, 'g')
  // A duplicate id or a missing name throws INVALID_MODEL_REASONING inside
  // DSH and takes the entire provider out of the model picker.
  assert.deepEqual(resolved.reasoning.efforts.map((effort) => effort.id), ['low', 'dup'])
})

await test('a failing capability lookup degrades instead of failing the model', async () => {
  const { adapter, warnings } = makeAdapter(
    [{ name: 'g', models: ['a_b'], enabled: true }],
    { window: () => { throw new Error('provider unreachable') } },
  )
  const resolved = await adapter.resolveModel(PROVIDER, 'g')
  assert.equal('context' in resolved, false)
  assert.equal('reasoning' in resolved, false)
  assert.equal(warnings.length > 0, true)
})

await test('an unknown capacity is omitted rather than guessed', async () => {
  const { adapter } = makeAdapter(
    [{ name: 'g', models: ['a_b'], enabled: true }],
    { window: undefined },
  )
  const resolved = await adapter.resolveModel(PROVIDER, 'g')
  // Omitting it is survivable; a wrong number silently mis-sizes compaction.
  assert.equal('context' in resolved, false)
  const listed = await adapter.listModels(PROVIDER)
  assert.equal('contextWindow' in listed[0], false)
})

await test('listing never consults capacity, so an unreachable provider cannot stall it', async () => {
  let asked = 0
  const { adapter } = makeAdapter(
    [{ name: 'g', models: ['a_b'], enabled: true }],
    { window: () => { asked += 1; throw new Error('provider unreachable') } },
  )
  const models = await adapter.listModels(PROVIDER)
  assert.equal(models.length, 1, 'the group is still listed')
  // `llm.listModels` forwards only provider/id/name/description/inputModalities,
  // so a capacity read here would be discarded anyway — while turning a pure
  // listing into one that fails whenever a provider is down.
  assert.equal(asked, 0, 'capacity was not read on the listing path')
})

await test('stream delegates to the shared failover routine with the group name', async () => {
  const { adapter } = makeAdapter([])
  const chunks = []
  for await (const chunk of adapter.stream({ model: 'fast-chat', provider: PROVIDER })) {
    chunks.push(chunk)
  }
  assert.deepEqual(chunks, [{ type: 'text-delta', text: 'fast-chat' }])
})

if (failures > 0) {
  console.log(`\n${failures} failing`)
  process.exitCode = 1
} else {
  console.log('\nall adapter tests passed')
}
