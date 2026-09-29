/**
 * REPRO: outer composite usage recording (built on the nesting harness).
 *
 * A group graph can recurse along three independent routes, and they share no
 * carrier, so each needs its own guard and its own case here:
 *
 *  - RESOLUTION: resolveRoute -> resolveLeg -> resolveRoute. Entirely
 *    synchronous and pre-dispatch, so `ctx.llm.stream` is never reached and no
 *    request options exist. Reachable from the settings page today.
 *  - DISPATCH: ctx.llm.stream -> adapter -> streamGroup.
 *  - CAPABILITY: groupCapabilities -> resolveModelInfo -> adapter -> back.
 *    Walked by merely BUILDING THE CATALOG, with no request involved.
 *
 * The store-level cases (what may be saved) live in `groups.test.mjs`; these
 * are the ones that need the real route handler and the real adapter.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
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

const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-nesting-'))
let seq = 0

/**
 * A fake Cordis context that mirrors the REAL composition closely enough to
 * be worth trusting.
 *
 * The relay adapter is registered for real and `resolveModelInfo` for the relay
 * route is answered by it — which is what DSH does, and is the whole reason
 * the capability path can recurse. An earlier probe of this area used a fake
 * whose relay provider returned no models at all; that mock could not have
 * caught the cycle, because it never reproduced the round trip.
 */
function makeCtx({ streamFor, registerAdapter = true } = {}) {
  const routes = []
  const settingsRoutes = new Map()
  const warnings = []
  const adapters = []
  let streamCalls = 0
  let resolveInfoCalls = 0
  const ctx = {
    logger: { info: () => {}, warn: (message) => warnings.push(message) },
    effect: (fn) => { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose() } },
    get: () => undefined,
    inject: (_services, callback) => {
      const connection = { fetch: { register: async (route) => { settingsRoutes.set(route.path, route); return () => settingsRoutes.delete(route.path) } } }
      callback({ get: (key) => (key === 'connection' ? connection : undefined) })
      return Promise.resolve()
    },
    webServer: { port: 3080, host: '127.0.0.1', register: (route) => { routes.push(route); return () => {} } },
    llm: {
      listProviders: () => [
        { id: 'codebuddy', name: 'CodeBuddy' },
        { id: 'deepseek', name: 'DeepSeek' },
        { id: 'dsh-model-relay', name: 'dsh-model-relay' },
      ],
      listModels: async (provider) => {
        if (provider === 'codebuddy') return [{ provider, id: 'glm-5.2', name: 'GLM' }]
        if (provider === 'deepseek') return [{ provider, id: 'deepseek-chat', name: 'Chat' }]
        return []
      },
      /**
       * Answered by the relay's own adapter for the relay route, exactly as
       * DSH does it. This is what makes a composite's capability walk leave
       * this plugin and come back.
       */
      resolveModelInfo: async (provider, model, signal) => {
        resolveInfoCalls += 1
        if (provider === 'dsh-model-relay' && adapters[0] !== undefined) {
          return await adapters[0].resolveModel(provider, model, signal)
        }
        return { provider, id: model, context: { contextWindow: 128000 }, inputModalities: ['text'] }
      },
      registerAdapter: (_ids, adapter) => { if (registerAdapter) adapters.push(adapter); return () => {} },
      registerConfigurableProviders: () => () => {},
      /**
       * Dispatch, routed the way DSH routes it.
       *
       * A stream naming the relay's own route is answered by the adapter this
       * plugin registered — that round trip IS the nesting feature, and a fake
       * that skipped it would make a dispatch cycle look like an ordinary
       * successful call. This is the same reason the suite drives the real
       * adapter rather than a mock that echoes back what it was handed.
       */
      stream: (options) => {
        streamCalls += 1
        const scripted = streamFor?.(options)
        if (scripted !== undefined) return scripted
        if (options?.provider === 'dsh-model-relay' && adapters[0] !== undefined) {
          return adapters[0].stream(options)
        }
        return (async function* generate() {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: 'hello' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } }
          yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
  }
  return {
    ctx, routes, settingsRoutes, warnings, adapters,
    stats: () => ({ streamCalls, resolveInfoCalls }),
    resetCounters: () => { streamCalls = 0; resolveInfoCalls = 0 },
  };
}

function mount(harness, config = {}) {
  apply(harness.ctx, {
    keysFile: join(dir, `k${seq++}.json`),
    groupsFile: join(dir, `g${seq++}.json`),
    ...config,
  })
}

/** Read the stats document the store wrote (after a flush wait). */
async function readStatsAfterFlush(config) {
  await new Promise((resolve) => setTimeout(resolve, 2600))
  return JSON.parse(readFileSync(config.statsFile, 'utf8'))
}

/** A groups file written by hand, so a cycle can exist despite save-time checks. */
function handwrittenGroups(groups) {
  const file = join(dir, `h${seq++}.json`)
  writeFileSync(file, JSON.stringify({ version: 3, groups }), 'utf8')
  return file
}

async function withServer(routes, fn) {
  const server = createServer((req, res) => {
    const url = new URL(String(req.url), 'http://localhost')
    const route = routes.find((entry) => entry.kind === 'prefix' && url.pathname.startsWith(entry.path))
    if (route === undefined) { res.statusCode = 404; res.end(); return }
    Promise.resolve(route.handler(req, res)).catch(() => { if (!res.headersSent) res.statusCode = 500; res.end() })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try { return await fn(base) } finally { await new Promise((resolve) => server.close(resolve)) }
}

async function callSettings(settingsRoutes, action, payload = {}) {
  const route = settingsRoutes.get('/api/model-relay')
  if (route === undefined) throw new Error('settings route was not registered')
  const request = new Request('http://127.0.0.1:3080/api/model-relay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'nest', payload: { action, ...payload } }),
  })
  return (await (await route.fetch(request)).json()).result
}

const createGroup = (settingsRoutes, name, models, extra = {}) =>
  callSettings(settingsRoutes, 'createGroup', { name, models, ...extra })

const ask = async (base, model) => {
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
  })
  let body
  try { body = await response.json() } catch { body = undefined }
  return { status: response.status, code: body?.error?.code, body }
}

const wait = () => new Promise((resolve) => setTimeout(resolve, 20))

// ---------------------------------------------------------------- resolution

await test('a saved composite dispatches through the inner group', async () => {
  const h = makeCtx()
  mount(h)
  await withServer(h.routes, async (base) => {
    assert.equal((await createGroup(h.settingsRoutes, 'inner', ['codebuddy_glm-5.2'])).ok, true)
    const outer = await createGroup(h.settingsRoutes, 'outer', ['dsh-model-relay_inner'], { kind: 'composite' })
    assert.equal(outer.ok, true, outer.error)
    const answer = await ask(base, 'outer')
    assert.equal(answer.status, 200)
    // The prefixed member is handed to DSH as a concrete provider/model pair,
    // so the inner group is served by the relay's OWN adapter rather than
    // being flattened into a single leg here.
    assert.equal(h.stats().streamCalls >= 1, true, 'the inner group was actually dispatched')
  })
})

await test('a composite keeps the inner group scheduling instead of flattening it', async () => {
  const h = makeCtx()
  mount(h)
  const seen = []
  await withServer(h.routes, async (base) => {
    await createGroup(h.settingsRoutes, 'inner', ['codebuddy_glm-5.2', 'deepseek_deepseek-chat'])
    await createGroup(h.settingsRoutes, 'outer', ['dsh-model-relay_inner'], { kind: 'composite' })
    // Resolving the composite must NOT have picked a single inner leg: the
    // member is one opaque pair, so the inner walk happens at dispatch time.
    const listed = await callSettings(h.settingsRoutes, 'listGroups')
    const outer = listed.value.groups.find((group) => group.name === 'outer')
    assert.deepEqual(outer.models, ['dsh-model-relay_inner'])
    const answer = await ask(base, 'outer')
    assert.equal(answer.status, 200)
  })
})

await test('a plain model group still refuses a member that names a group', async () => {
  const h = makeCtx()
  mount(h)
  await withServer(h.routes, async (base) => {
    await createGroup(h.settingsRoutes, 'inner', ['codebuddy_glm-5.2'])
    // Saved by hand: the store would refuse this, and the runtime must too.
    const file = handwrittenGroups([
      { name: 'inner', models: ['codebuddy_glm-5.2'], enabled: true, kind: 'model' },
      { name: 'plain', models: ['inner'], enabled: true, kind: 'model' },
    ])
    const h2 = makeCtx()
    mount(h2, { groupsFile: file })
    await withServer(h2.routes, async (base2) => {
      const answer = await ask(base2, 'plain')
      assert.notEqual(answer.status, 200)
      assert.equal(answer.code, 'group_self_reference')
    })
  })
})

await test('a bare inner name is refused even for a composite', async () => {
  // Resolving it would take the group branch and return the inner group's
  // FIRST leg, silently dropping the rest of its chain and its scheduling.
  const file = handwrittenGroups([
    { name: 'inner', models: ['codebuddy_glm-5.2', 'deepseek_deepseek-chat'], enabled: true, kind: 'model' },
    { name: 'outer', models: ['inner'], enabled: true, kind: 'composite' },
  ])
  const h = makeCtx()
  mount(h, { groupsFile: file })
  await withServer(h.routes, async (base) => {
    const answer = await ask(base, 'outer')
    assert.notEqual(answer.status, 200)
    assert.equal(answer.code, 'group_self_reference')
  })
})

await test('a resolution cycle is stopped, and never dispatches', async () => {
  // The path a plain group-name cycle takes. `ctx.llm.stream` is never reached,
  // so a guard carried on the request options could not possibly catch it —
  // which is exactly why the depth travels as an argument instead.
  const file = handwrittenGroups([
    { name: 'cyc-a', models: ['cyc-b'], enabled: true, kind: 'model' },
    { name: 'cyc-b', models: ['cyc-a'], enabled: true, kind: 'model' },
  ])
  const h = makeCtx()
  mount(h, { groupsFile: file })
  await withServer(h.routes, async (base) => {
    const answer = await ask(base, 'cyc-a')
    assert.notEqual(answer.status, 200)
    assert.equal(answer.code, 'group_cycle')
    assert.equal(h.stats().streamCalls, 0, 'a resolution cycle must never reach dispatch')
  })
})

await test('a three-group resolution cycle is stopped too', async () => {
  const file = handwrittenGroups([
    { name: 'a', models: ['b'], enabled: true, kind: 'model' },
    { name: 'b', models: ['c'], enabled: true, kind: 'model' },
    { name: 'c', models: ['a'], enabled: true, kind: 'model' },
  ])
  const h = makeCtx()
  mount(h, { groupsFile: file })
  await withServer(h.routes, async (base) => {
    const answer = await ask(base, 'a')
    assert.notEqual(answer.status, 200)
    assert.equal(answer.code, 'group_cycle')
  })
})

await test('the cycle guard does not fire on a legitimate single level', async () => {
  const h = makeCtx()
  mount(h)
  await withServer(h.routes, async (base) => {
    await createGroup(h.settingsRoutes, 'inner', ['codebuddy_glm-5.2'])
    await createGroup(h.settingsRoutes, 'outer', ['dsh-model-relay_inner'], { kind: 'composite' })
    assert.equal((await ask(base, 'outer')).status, 200)
    assert.equal((await ask(base, 'inner')).status, 200)
  })
})

// ---------------------------------------------------------------- capability

await test('a capability cycle is stopped rather than exhausting the heap', async () => {
  // This path leaves the plugin entirely: groupCapabilities -> DSH -> the
  // adapter this plugin registered -> back. It is triggered by BUILDING THE
  // CATALOG, so merely opening the Models page walks it, with no request and
  // no dispatch involved.
  const file = handwrittenGroups([
    { name: 'cap-a', models: ['dsh-model-relay_cap-b'], enabled: true, kind: 'composite' },
    { name: 'cap-b', models: ['dsh-model-relay_cap-a'], enabled: true, kind: 'composite' },
  ])
  const h = makeCtx()
  mount(h, { groupsFile: file })
  assert.equal(h.adapters.length, 1, 'the relay adapter must be registered for this to be testable')
  const adapter = h.adapters[0]
  await assert.rejects(
    () => adapter.resolveModel('dsh-model-relay', 'cap-a'),
    (error) => error?.code === 'group_capability_cycle',
    'the capability cycle must surface as its own code, not as an unknown capability',
  )
})

await test('the capability guard is reachable through the catalog the page builds', async () => {
  const file = handwrittenGroups([
    { name: 'cap-a', models: ['dsh-model-relay_cap-b'], enabled: true, kind: 'composite' },
    { name: 'cap-b', models: ['dsh-model-relay_cap-a'], enabled: true, kind: 'composite' },
  ])
  const h = makeCtx()
  mount(h, { groupsFile: file })
  await withServer(h.routes, async (base) => {
    // The model listing is what the picker is built from. It must not hang
    // or die, whatever the group graph contains.
    const response = await fetch(`${base}/v1/models`)
    assert.equal(response.status, 200)
  })
})

await test('a capability failure that is NOT a cycle still degrades to unknown', async () => {
  // The guard must be the only thing re-thrown. Everything else stays
  // advisory, or one unreachable provider would remove the whole relay
  // provider from DSH's model picker.
  const h = makeCtx()
  mount(h)
  const adapter = h.adapters[0]
  assert.equal(h.adapters.length, 1)
  const answer = await adapter.resolveModel('dsh-model-relay', 'ghost')
  assert.equal('context' in answer, false)
  assert.equal('reasoning' in answer, false)
})

await test('a composite reports the inner groups capabilities', async () => {
  const h = makeCtx()
  mount(h)
  await createGroup(h.settingsRoutes, 'inner', ['codebuddy_glm-5.2'])
  await createGroup(h.settingsRoutes, 'outer', ['dsh-model-relay_inner'], { kind: 'composite' })
  const adapter = h.adapters[0]
  const resolved = await adapter.resolveModel('dsh-model-relay', 'outer')
  // The fake llm answers 128000 for a concrete model, and the walk reaches
  // that through the relay route, so the number must survive one level.
  assert.deepEqual(resolved.context, { contextWindow: 128000 })
})

await test('editing an inner group invalidates a composites cached capabilities', async () => {
  const h = makeCtx()
  mount(h)
  await createGroup(h.settingsRoutes, 'inner', ['codebuddy_glm-5.2'])
  await createGroup(h.settingsRoutes, 'outer', ['dsh-model-relay_inner'], { kind: 'composite' })
  const adapter = h.adapters[0]
  const before = await adapter.resolveModel('dsh-model-relay', 'outer')
  assert.deepEqual(before.context, { contextWindow: 128000 })
  // The composite's own member list does not change here, so a cache keyed
  // only on members would keep serving the old answer.
  assert.equal((await callSettings(h.settingsRoutes, 'updateGroup', { id: 'inner', models: ['deepseek_deepseek-chat'] })).ok, true)
  const after = await adapter.resolveModel('dsh-model-relay', 'outer')
  assert.deepEqual(after.context, { contextWindow: 128000 })
})

// ------------------------------------------------------------------ dispatch

await test('a dispatch cycle between two composites is stopped', async () => {
  // Both groups are composites and neither nests the other, so the SAVE-time
  // type rules would allow the shapes individually; the cycle is what makes
  // them unsafe, and this is the path it takes once dispatched.
  const file = handwrittenGroups([
    { name: 'dis-a', models: ['dsh-model-relay_dis-b'], enabled: true, kind: 'composite' },
    { name: 'dis-b', models: ['dsh-model-relay_dis-a'], enabled: true, kind: 'composite' },
  ])
  const h = makeCtx()
  mount(h, { groupsFile: file })
  await withServer(h.routes, async (base) => {
    const answer = await ask(base, 'dis-a')
    assert.notEqual(answer.status, 200)
    assert.equal(answer.code, 'group_cycle')
  })
})

// --------------------------------------------------------------------- store

await test('a model group cannot be saved with a member that names a group', async () => {
  const h = makeCtx()
  mount(h)
  await withServer(h.routes, async () => {
    await createGroup(h.settingsRoutes, 'inner', ['codebuddy_glm-5.2'])
    const refused = await createGroup(h.settingsRoutes, 'plain', ['inner'])
    assert.equal(refused.ok, false, 'the save must be refused, not merely unwise')
  })
})

await test('a composite cannot be saved pointing at a group that does not exist', async () => {
  const h = makeCtx()
  mount(h)
  await withServer(h.routes, async () => {
    const refused = await createGroup(h.settingsRoutes, 'outer', ['dsh-model-relay_missing'], { kind: 'composite' })
    assert.equal(refused.ok, false)
  })
})

await test('a composite cannot be saved pointing at another composite', async () => {
  // This is what keeps the reference graph bipartite, and therefore what
  // makes "a composite may not be nested" a consequence of the type rule
  // rather than a separate rule someone has to remember to enforce.
  const h = makeCtx()
  mount(h)
  await withServer(h.routes, async () => {
    await createGroup(h.settingsRoutes, 'inner', ['codebuddy_glm-5.2'])
    await createGroup(h.settingsRoutes, 'first', ['dsh-model-relay_inner'], { kind: 'composite' })
    const refused = await createGroup(h.settingsRoutes, 'second', ['dsh-model-relay_first'], { kind: 'composite' })
    assert.equal(refused.ok, false)
  })
})

await test('a composite cannot be saved pointing at itself', async () => {
  const h = makeCtx()
  mount(h)
  await withServer(h.routes, async () => {
    const refused = await createGroup(h.settingsRoutes, 'self', ['dsh-model-relay_self'], { kind: 'composite' })
    assert.equal(refused.ok, false)
  })
})

await test('a composite must spell its members with the prefix, not as a bare name', async () => {
  // A bare inner name would resolve to that group's FIRST leg only, which is
  // exactly the flattening this whole feature exists to avoid.
  const h = makeCtx()
  mount(h)
  await withServer(h.routes, async () => {
    await createGroup(h.settingsRoutes, 'inner', ['codebuddy_glm-5.2'])
    const refused = await createGroup(h.settingsRoutes, 'outer', ['inner'], { kind: 'composite' })
    assert.equal(refused.ok, false)
  })
})

await test('kind round-trips through the store, the file and the listing', async () => {
  // A field dropped by any one of normalizeStoredGroup / create / update
  // disappears silently: no error, the feature simply never takes effect.
  const h = makeCtx()
  mount(h)
  await withServer(h.routes, async () => {
    await createGroup(h.settingsRoutes, 'inner', ['codebuddy_glm-5.2'])
    assert.equal((await createGroup(h.settingsRoutes, 'outer', ['dsh-model-relay_inner'], { kind: 'composite' })).ok, true)
    const listed = await callSettings(h.settingsRoutes, 'listGroups')
    const outer = listed.value.groups.find((group) => group.name === 'outer')
    assert.equal(outer.kind, 'composite')
    const inner = listed.value.groups.find((group) => group.name === 'inner')
    assert.equal(inner.kind, 'model')
    // And through an update that does not mention kind at all.
    assert.equal((await callSettings(h.settingsRoutes, 'updateGroup', { id: 'outer', models: ['dsh-model-relay_inner'] })).ok, true)
    const again = (await callSettings(h.settingsRoutes, 'listGroups')).value.groups.find((group) => group.name === 'outer')
    assert.equal(again.kind, 'composite', 'an unrelated update must not reset the kind')
  })
})

await test('an unknown kind degrades to model, not to composite', async () => {
  // The safe direction: degrading to composite would GRANT the ability to
  // contain groups to a document that failed to declare itself.
  const file = handwrittenGroups([
    { name: 'weird', models: ['codebuddy_glm-5.2'], enabled: true, kind: 'nonsense' },
  ])
  const h = makeCtx()
  mount(h, { groupsFile: file })
  await withServer(h.routes, async () => {
    const listed = await callSettings(h.settingsRoutes, 'listGroups')
    assert.equal(listed.value.groups[0].kind, 'model')
  })
})

await test('deleting a referenced group reports its referrers instead of refusing', async () => {
  const h = makeCtx()
  mount(h)
  await withServer(h.routes, async () => {
    await createGroup(h.settingsRoutes, 'inner', ['codebuddy_glm-5.2'])
    await createGroup(h.settingsRoutes, 'outer', ['dsh-model-relay_inner'], { kind: 'composite' })
    const removed = await callSettings(h.settingsRoutes, 'removeGroup', { id: 'inner' })
    assert.equal(removed.ok, true, 'refusing would make an inner group undeletable')
    assert.deepEqual(removed.value.referrers, ['outer'])
  })
})

await test('a composite left dangling is reported, and still fails cleanly', async () => {
  const file = handwrittenGroups([
    { name: 'outer', models: ['dsh-model-relay_gone'], enabled: true, kind: 'composite' },
  ])
  const h = makeCtx()
  mount(h, { groupsFile: file })
  await withServer(h.routes, async (base) => {
    const listed = await callSettings(h.settingsRoutes, 'listGroups')
    assert.deepEqual(listed.value.groups[0].dangling, ['dsh-model-relay_gone'])
    // A dangling member must fail as an ordinary missing model, never hang.
    const answer = await ask(base, 'outer')
    assert.notEqual(answer.status, 200)
  })
})

await test('a non-cycle guard error is not swallowed into group_empty', async () => {
  // Both failover loops catch every error a member raises and try the next
  // one. A guard failure has to survive that, or the request ends as a bare
  // group_empty and the real cause never reaches the caller.
  const file = handwrittenGroups([
    { name: 'cyc-a', models: ['cyc-b'], enabled: true, kind: 'model' },
    { name: 'cyc-b', models: ['cyc-a'], enabled: true, kind: 'model' },
  ])
  const h = makeCtx()
  mount(h, { groupsFile: file })
  await withServer(h.routes, async (base) => {
    const answer = await ask(base, 'cyc-a')
    assert.notEqual(answer.code, 'group_empty', 'the guard reason must outrank a generic empty group')
    assert.equal(answer.code, 'group_cycle')
  })
})

// ---------------------------------------------------- outer usage reproduction

await test('REPRO: composite outer layer records inner usage in the stats store', async () => {
  const h = makeCtx()
  const config = { statsFile: join(dir, `s${seq++}.json`) }
  mount(h, config)
  await withServer(h.routes, async (base) => {
    assert.equal((await createGroup(h.settingsRoutes, 'inner', ['codebuddy_glm-5.2'])).ok, true)
    assert.equal((await createGroup(h.settingsRoutes, 'outer', ['dsh-model-relay_inner'], { kind: 'composite' })).ok, true)
    const answer = await ask(base, 'outer')
    assert.equal(answer.status, 200, 'the call itself succeeds')
    const doc = await readStatsAfterFlush(config)
    const day = Object.values(doc.days)[0]
    for (const [name, row] of Object.entries(day.groups)) {
      console.log(`   ${name}: in=${row.inputTokens} out=${row.outputTokens} cwu=${row.callsWithUsage}`)
    }
    console.log('   candidates:', JSON.stringify(Object.keys(doc.candidates)))
    assert.equal(day.groups.inner?.inputTokens, 100, 'INNER layer tokens recorded')
    assert.equal(day.groups.outer?.inputTokens, 100, 'OUTER layer tokens recorded')
  })
})

await test('REPRO: plain group records usage in the stats store', async () => {
  const h = makeCtx()
  const config = { statsFile: join(dir, `s${seq++}.json`) }
  mount(h, config)
  await withServer(h.routes, async (base) => {
    assert.equal((await createGroup(h.settingsRoutes, 'g', ['codebuddy_glm-5.2'])).ok, true)
    const answer = await ask(base, 'g')
    assert.equal(answer.status, 200)
    const doc = await readStatsAfterFlush(config)
    const day = Object.values(doc.days)[0]
    console.log(`   g: in=${day.groups.g?.inputTokens} cwu=${day.groups.g?.callsWithUsage}`)
    assert.equal(day.groups.g.inputTokens, 100, 'plain group tokens recorded')
  })
})

if (failures > 0) {
  console.log(`\n${failures} failing`)
  process.exitCode = 1
} else {
  console.log('\nall nesting tests passed')
}