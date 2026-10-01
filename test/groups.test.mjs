/**
 * Tests for the model-group store.
 *
 * Runs against a real temporary directory so atomic writes and the serialized
 * write queue are exercised for real rather than mocked.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GatewayGroupStore, isValidGroupName } from '../lib/groups.js'

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

/** Run one case against a fresh temp directory that is always cleaned up. */
async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-gw-groups-'))
  try {
    return await fn(join(dir, 'groups.json'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

await test('isValidGroupName accepts plain names and rejects underscores', () => {
  assert.equal(isValidGroupName('fast-chat'), true)
  assert.equal(isValidGroupName('g1'), true)
  assert.equal(isValidGroupName('a.b-c'), true)
  // An underscore would collide with the `<provider>_<model>` spelling.
  assert.equal(isValidGroupName('codebuddy_flash'), false)
  assert.equal(isValidGroupName('-leading'), false)
  assert.equal(isValidGroupName(''), false)
  assert.equal(isValidGroupName('a'.repeat(65)), false)
})

await test('a fresh store is empty and an absent file is not an error', async () => {
  await withStore(async (file) => {
    const store = new GatewayGroupStore({ file })
    assert.deepEqual(await store.all(), [])
    assert.equal(await store.get('nope'), undefined)
  })
})

await test('create persists a group and round-trips through a second store', async () => {
  await withStore(async (file) => {
    const store = new GatewayGroupStore({ file })
    const created = await store.create('fast-chat', ['codebuddy_deepseek-v4.1-flash', 'deepseek_deepseek-chat'])
    assert.equal(created.ok, true)
    assert.equal(created.group.id, 'fast-chat')

    const reopened = new GatewayGroupStore({ file })
    const hit = await reopened.get('fast-chat')
    assert.equal(hit.name, 'fast-chat')
    assert.deepEqual(hit.models, ['codebuddy_deepseek-v4.1-flash', 'deepseek_deepseek-chat'])
    assert.equal(hit.enabled, true)
  })
})

await test('create rejects a duplicate name, a bad name, and an empty candidate list', async () => {
  await withStore(async (file) => {
    const store = new GatewayGroupStore({ file })
    assert.equal((await store.create('g', ['a_b'])).ok, true)

    const duplicate = await store.create('g', ['c_d'])
    assert.equal(duplicate.ok, false)
    assert.match(duplicate.error, /已存在/)

    assert.equal((await store.create('bad_name', ['a_b'])).ok, false)
    assert.equal((await store.create('g2', [])).ok, false)
    assert.equal((await store.create('g3', ['  '])).ok, false)
  })
})

await test('concurrent creates do not drop each other', async () => {
  await withStore(async (file) => {
    const store = new GatewayGroupStore({ file })
    await Promise.all(
      Array.from({ length: 12 }, (_, index) => store.create(`g${index}`, ['a_b'])),
    )
    const all = await store.all()
    assert.equal(all.length, 12, 'every queued create must survive')
  })
})

await test('update replaces candidates, renames, and toggles enabled', async () => {
  await withStore(async (file) => {
    const store = new GatewayGroupStore({ file })
    await store.create('g', ['a_b'])

    assert.equal((await store.update('g', { models: ['c_d', 'e_f'] })).ok, true)
    assert.deepEqual((await store.get('g')).models, ['c_d', 'e_f'])

    assert.equal((await store.update('g', { name: 'h' })).ok, true)
    assert.equal(await store.get('g'), undefined)
    assert.notEqual(await store.get('h'), undefined)

    assert.equal((await store.update('h', { enabled: false })).ok, true)
    assert.equal((await store.get('h')).enabled, false)
  })
})

await test('update refuses an empty candidate list and a colliding rename', async () => {
  await withStore(async (file) => {
    const store = new GatewayGroupStore({ file })
    await store.create('a', ['m_n'])
    await store.create('b', ['m_n'])

    assert.equal((await store.update('a', { models: [] })).ok, false)
    assert.equal((await store.update('a', { name: 'b' })).ok, false)
    assert.equal((await store.update('missing', { models: ['x_y'] })).ok, false)
  })
})

await test('remove deletes exactly one group', async () => {
  await withStore(async (file) => {
    const store = new GatewayGroupStore({ file })
    await store.create('a', ['m_n'])
    await store.create('b', ['m_n'])
    assert.equal(await store.remove('a'), true)
    assert.equal(await store.remove('a'), false)
    assert.deepEqual((await store.all()).map((group) => group.name), ['b'])
  })
})

await test('a corrupt file degrades to empty instead of throwing', async () => {
  await withStore(async (file) => {
    await writeFile(file, '{ not json', 'utf8')
    const store = new GatewayGroupStore({ file })
    assert.deepEqual(await store.all(), [])
  })
})

await test('unusable stored entries are dropped rather than repaired', async () => {
  await withStore(async (file) => {
    await writeFile(file, JSON.stringify({
      version: 1,
      groups: [
        { name: 'good', models: ['a_b'], enabled: true },
        { name: 'bad_name', models: ['a_b'] },      // underscore
        { name: 'empty', models: [] },               // no candidates
        { name: 'notobject' },
        'garbage',
      ],
    }), 'utf8')
    const store = new GatewayGroupStore({ file })
    assert.deepEqual((await store.all()).map((group) => group.name), ['good'])
  })
})

await test('the persisted file is valid JSON with a versioned shape', async () => {
  await withStore(async (file) => {
    const store = new GatewayGroupStore({ file })
    await store.create('g', ['a_b'])
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    // Bumped when scheduling was added, and again when group kinds were. The
    // version is descriptive only — 'load' never reads it — so an older plugin
    // reading this file ignores the new fields rather than refusing it.
    assert.equal(parsed.version, 3)
    assert.equal(Array.isArray(parsed.groups), true)
    assert.equal(parsed.groups[0].name, 'g')
    assert.equal(parsed.groups[0].strategy, 'sequential')
    assert.equal(parsed.groups[0].retry429, 0)
    assert.equal(parsed.groups[0].kind, 'model')
  })
})

await test('a returned group is a copy, so mutating it cannot corrupt the store', async () => {
  await withStore(async (file) => {
    const store = new GatewayGroupStore({ file })
    await store.create('g', ['a_b'])
    const first = await store.get('g')
    first.models.push('injected')
    assert.deepEqual((await store.get('g')).models, ['a_b'])
  })
})

await test('a group created without scheduling defaults to sequential and no retry', async () => {
  await withStore(async (file) => {
    const store = new GatewayGroupStore({ file })
    const created = await store.create('g', ['a_b'])
    assert.equal(created.group.strategy, 'sequential')
    assert.equal(created.group.retry429, 0)
    const hit = await store.get('g')
    assert.equal(hit.strategy, 'sequential')
    assert.equal(hit.retry429, 0)
  })
})

await test('scheduling round-trips through the file', async () => {
  await withStore(async (file) => {
    const store = new GatewayGroupStore({ file })
    await store.create('g', ['a_b'], { strategy: 'round-robin', retry429: 2 })
    const reopened = new GatewayGroupStore({ file })
    const hit = await reopened.get('g')
    assert.equal(hit.strategy, 'round-robin')
    assert.equal(hit.retry429, 2)
  })
})

await test('an unusable scheduling value degrades instead of dropping the group', async () => {
  await withStore(async (file) => {
    const store = new GatewayGroupStore({ file })
    // A scheduling preference must never cost a working candidate list.
    const created = await store.create('g', ['a_b'], { strategy: 'nonsense', retry429: 99 })
    assert.equal(created.ok, true)
    assert.equal(created.group.strategy, 'sequential')
    assert.equal(created.group.retry429, 3)
  })
})

await test('a document written before scheduling existed still loads', async () => {
  await withStore(async (file) => {
    // The exact shape the previous version persisted: no strategy, no retry.
    await writeFile(file, JSON.stringify({
      version: 1,
      groups: [{ id: 'old', name: 'old', models: ['a_b'], enabled: true }],
    }), 'utf8')
    const store = new GatewayGroupStore({ file })
    const hit = await store.get('old')
    assert.equal(hit.name, 'old')
    assert.deepEqual(hit.models, ['a_b'])
    assert.equal(hit.strategy, 'sequential')
    assert.equal(hit.retry429, 0)
  })
})

await test('a stored but unusable scheduling value is normalized on read', async () => {
  await withStore(async (file) => {
    await writeFile(file, JSON.stringify({
      version: 2,
      groups: [
        { name: 'a', models: ['m_n'], strategy: 'wat', retry429: 'two' },
        { name: 'b', models: ['m_n'], strategy: 'random', retry429: -4 },
      ],
    }), 'utf8')
    const store = new GatewayGroupStore({ file })
    const a = await store.get('a')
    assert.equal(a.strategy, 'sequential')
    assert.equal(a.retry429, 0)
    const b = await store.get('b')
    assert.equal(b.strategy, 'random')
    assert.equal(b.retry429, 0)
  })
})

await test('update changes scheduling, and omitting it preserves the current pair', async () => {
  await withStore(async (file) => {
    const store = new GatewayGroupStore({ file })
    await store.create('g', ['a_b'], { strategy: 'random', retry429: 1 })

    assert.equal((await store.update('g', { models: ['c_d'] })).ok, true)
    const kept = await store.get('g')
    assert.equal(kept.strategy, 'random', 'an unrelated update must not reset scheduling')
    assert.equal(kept.retry429, 1)

    assert.equal((await store.update('g', { strategy: 'round-robin', retry429: 3 })).ok, true)
    const changed = await store.get('g')
    assert.equal(changed.strategy, 'round-robin')
    assert.equal(changed.retry429, 3)
  })
})

await test('a group defaults to the model kind, and composite is stored', async () => {
  await withStore(async (file) => {
    const store = new GatewayGroupStore({ file })
    const plain = await store.create('plain', ['a_b'])
    assert.equal(plain.group.kind, 'model', 'the default must not grant the ability to contain groups')
    assert.equal((await store.get('plain')).kind, 'model')

    await store.create('inner', ['a_b'])
    const composite = await store.create('outer', ['dsh-model-gateway_inner'], { kind: 'composite' })
    assert.equal(composite.ok, true, composite.error)
    assert.equal(composite.group.kind, 'composite')

    const reopened = new GatewayGroupStore({ file })
    assert.equal((await reopened.get('outer')).kind, 'composite', 'the kind must survive a reload')
  })
})

await test('an unusable stored kind degrades to model rather than to composite', async () => {
  await withStore(async (file) => {
    await writeFile(file, JSON.stringify({
      version: 3,
      groups: [{ name: 'a', models: ['m_n'], kind: 'nonsense' }, { name: 'b', models: ['m_n'] }],
    }), 'utf8')
    const store = new GatewayGroupStore({ file })
    // Degrading to composite would GRANT the capability to a document that
    // failed to declare itself, which is the direction an attacker would want.
    assert.equal((await store.get('a')).kind, 'model')
    assert.equal((await store.get('b')).kind, 'model')
  })
})

await test('a model group refuses a candidate that names an existing group', async () => {
  await withStore(async (file) => {
    const store = new GatewayGroupStore({ file })
    await store.create('inner', ['a_b'])
    const refused = await store.create('plain', ['inner'])
    assert.equal(refused.ok, false)
    assert.match(refused.error, /分组名/)
    // And an update cannot smuggle one in either.
    assert.equal((await store.update('plain', { models: ['inner'] })).ok, false)
  })
})

await test('a composite must point at an existing model group, with the prefix', async () => {
  await withStore(async (file) => {
    const store = new GatewayGroupStore({ file })
    await store.create('inner', ['a_b'])

    assert.equal((await store.create('missing', ['dsh-model-gateway_nope'], { kind: 'composite' })).ok, false)
    // A bare name would resolve to the inner group's FIRST leg only.
    assert.equal((await store.create('bare', ['inner'], { kind: 'composite' })).ok, false)
    // Self-reference.
    assert.equal((await store.create('self', ['dsh-model-gateway_self'], { kind: 'composite' })).ok, false)
    // A composite is not a legal member of a composite: this is what keeps the
    // reference graph bipartite, and therefore what makes "no nesting" follow
    // from the type rule instead of needing its own check.
    await store.create('first', ['dsh-model-gateway_inner'], { kind: 'composite' })
    assert.equal((await store.create('second', ['dsh-model-gateway_first'], { kind: 'composite' })).ok, false)

    assert.equal((await store.create('good', ['dsh-model-gateway_inner'], { kind: 'composite' })).ok, true)
  })
})

await test('kind is not updatable, so a caller cannot grant the capability by asking', async () => {
  await withStore(async (file) => {
    const store = new GatewayGroupStore({ file })
    await store.create('g', ['a_b'])
    await store.update('g', { kind: 'composite' })
    assert.equal((await store.get('g')).kind, 'model')
  })
})

await test('dangling members and referrers are reported without being stored', async () => {
  await withStore(async (file) => {
    const store = new GatewayGroupStore({ file })
    await store.create('inner', ['a_b'])
    await store.create('outer', ['dsh-model-gateway_inner'], { kind: 'composite' })
    assert.deepEqual((await store.get('outer')).dangling, [])

    await store.remove('inner')
    const stale = await store.get('outer')
    assert.deepEqual(stale.dangling, ['dsh-model-gateway_inner'])
    // Derived on read, so it never lands in the document.
    const onDisk = JSON.parse(await readFile(file, 'utf8'))
    assert.equal('dangling' in onDisk.groups.find((group) => group.name === 'outer'), false)
  })
})

await test('a rename carries scheduling along', async () => {
  await withStore(async (file) => {
    const store = new GatewayGroupStore({ file })
    await store.create('g', ['a_b'], { strategy: 'round-robin', retry429: 2 })
    await store.update('g', { name: 'h' })
    const renamed = await store.get('h')
    assert.equal(renamed.strategy, 'round-robin')
    assert.equal(renamed.retry429, 2)
  })
})


if (failures > 0) {
  console.log(`\n${failures} failing`)
  process.exitCode = 1
} else {
  console.log('\nall group-store tests passed')
}
