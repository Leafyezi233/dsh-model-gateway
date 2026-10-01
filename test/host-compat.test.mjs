/**
 * Verifies the host-generation probes that pick the settings wiring path.
 *
 * These probes are the entire decision surface of the dual-version support:
 * one wrong answer either calls a removed API (plugin fails to load on 0.1.7)
 * or keys the provider card by a namespace the host does not know (card never
 * renders). Every probe is pure and dependency-free, so each case states the
 * host shape it stands for directly.
 */
import assert from 'node:assert/strict'
import Schema from '@deepseek-ai/schemastery'
import {
  ENTRY_ID_FALLBACK,
  entryIdOf,
  isLegacySettings,
  peekService,
  supportsVolatile,
} from '../lib/host-compat.js'

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

await test('entryIdOf strips the composition kind prefix', async () => {
  // The 0.1.7 loader reports `include:dsh-model-gateway`; the settings service
  // only ever indexes the bare id.
  assert.equal(entryIdOf({ fiber: { entry: { id: 'include:dsh-model-gateway' } } }), 'dsh-model-gateway')
  assert.equal(entryIdOf({ fiber: { entry: { id: 'plugin:ns:dsh-model-gateway' } } }), 'dsh-model-gateway', 'only the last segment is the kind prefix')
})

await test('entryIdOf keeps a bare id and falls back without an entry', async () => {
  assert.equal(entryIdOf({ fiber: { entry: { id: 'dsh-model-gateway' } } }), 'dsh-model-gateway')
  assert.equal(entryIdOf({ fiber: { entry: {} } }), ENTRY_ID_FALLBACK)
  assert.equal(entryIdOf({ fiber: { entry: { id: '' } } }), ENTRY_ID_FALLBACK)
  assert.equal(entryIdOf({ fiber: {} }), ENTRY_ID_FALLBACK)
  assert.equal(entryIdOf({}), ENTRY_ID_FALLBACK)
  assert.equal(entryIdOf(undefined), ENTRY_ID_FALLBACK)
  assert.equal(entryIdOf({ fiber: { entry: { id: 'dsh-model-gateway' } } }, 'other'), 'dsh-model-gateway', 'the fallback only covers an unreachable id')
})

await test('supportsVolatile is false on this generation and true on a 0.1.7-shaped schemastery', async () => {
  // The plugin resolves the host-pinned schemastery; on 0.1.5 that is 3.18.x,
  // whose schemas have no `.volatile`. A false here is what keeps the legacy
  // path selected while the settings service is still starting.
  assert.equal(supportsVolatile(Schema), false)
  assert.equal(supportsVolatile({ boolean: () => ({ volatile: () => {} }) }), true)
  // A probe must never be the thing that takes the plugin down.
  assert.equal(supportsVolatile({ boolean: () => { throw new Error('boom') } }), false)
  assert.equal(supportsVolatile({}), false)
})

await test('isLegacySettings keys on register, not installSection', async () => {
  assert.equal(isLegacySettings({ register: () => {} }), true)
  // A transitional host could keep `installSection` while `register` is gone;
  // keying on `installSection` would call straight into the removed API.
  assert.equal(isLegacySettings({ installSection: () => {} }), false)
  assert.equal(isLegacySettings({}), false)
  assert.equal(isLegacySettings(undefined), false)
  assert.equal(isLegacySettings(null), false)
})

await test('peekService reads an up service and survives a hostile context', async () => {
  assert.equal(peekService({ get: () => 'svc' }, 'settings'), 'svc')
  assert.equal(peekService({ get: () => undefined }, 'settings'), undefined, 'absent service, not an error')
  assert.equal(peekService({}, 'settings'), undefined)
  assert.equal(peekService({ get: () => { throw new Error('refused') } }, 'settings'), undefined)
  assert.equal(peekService(undefined, 'settings'), undefined)
})

if (failures > 0) {
  console.log(`\n${failures} failing`)
  process.exitCode = 1
} else {
  console.log('\nall host-compat tests passed')
}
