/**
 * Protocol-translation test for dsh-model-gateway.
 *
 * Drives the real route handler with a fake `llm` service and a real
 * `node:http` server, so the OpenAI wire shape is exercised end to end without
 * a provider or a signed-in account.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

/**
 * A key store location unique to this test run.
 *
 * Tests must never touch the real DSH home: the gateway reads its key store on
 * every request to decide whether auth is required, so an ambient key file
 * would make these assertions depend on the machine.
 */
const keyDir = mkdtempSync(join(tmpdir(), 'dsh-gw-test-'))
let keySeq = 0
const nextKeysFile = () => join(keyDir, `keys-${keySeq++}.json`)

/** A group store location unique to this test case. */
const nextGroupsFile = () => join(keyDir, `groups-${keySeq++}.json`)

/**
 * Apply the plugin with isolated stores unless the case overrides them.
 *
 * Both stores must be isolated for the same reason: the gateway reads them per
 * request, so an ambient file would make these assertions depend on the machine
 * and on whatever the developer last configured.
 */
function mount(ctx, config = {}) {
  const { keysFile = nextKeysFile(), groupsFile = nextGroupsFile(), ...rest } = config
  apply(ctx, { keysFile, groupsFile, ...rest })
}

/** Build a fake Cordis context with a scripted llm service. */
function makeCtx(chunks, { onStream, streamFor, modelInfo, efforts } = {}) {
  const routes = []
  const infos = []
  const warnings = []
  const streamCalls = []
  /** Disposers returned by ctx.effect, so tests can release LAN listeners. */
  const disposers = []
  /** Settings Fetch routes registered by the plugin, keyed by path. */
  const settingsRoutes = new Map()
  const ctx = {
    logger: {
      info: (message) => infos.push(message),
      warn: (message) => warnings.push(message),
    },
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    get: (key) => (key === 'attachments' ? undefined : undefined),
    inject: (services, callback) => {
      // Mimic cordis: hand the callback a context exposing the required services.
      const connection = {
        fetch: {
          register: async (route) => {
            settingsRoutes.set(route.path, route)
            return () => {
              settingsRoutes.delete(route.path)
            }
          },
        },
      }
      callback({ get: (key) => (key === 'connection' ? connection : undefined) })
      return Promise.resolve()
    },
    webServer: {
      port: 3080,
      host: '127.0.0.1',
      register: (route) => {
        routes.push(route)
        return () => {}
      },
    },
    llm: {
      /**
       * The plugin registers itself as a provider, so the fake service reports
       * that route too. Leaving it out would hide the self-reference case and
       * make the gateway look like it cannot collide with its own names.
       *
       * It advertises no models of its own: in the real composition the
       * registration exists to carry the group list, and the underlying
       * provider models this service reports are what a group is built from.
       */
      listProviders: () => [
        { id: 'codebuddy', name: 'CodeBuddy' },
        { id: 'deepseek', name: 'DeepSeek' },
        { id: 'dsh-model-gateway', name: 'dsh-model-gateway' },
      ],
      listModels: async (provider) => {
        if (provider === 'codebuddy') {
          return [{ provider, id: 'deepseek-v4.1-flash', name: 'Flash' }, { provider, id: 'glm-5.2', name: 'GLM' }]
        }
        if (provider === 'dsh-model-gateway') return []
        return [{ provider, id: 'deepseek-chat', name: 'Chat' }]
      },
      /**
       * Capability lookup for one provider model.
       *
       * The gateway reads this to intersect a group's members, so the fake has
       * to answer it. `efforts` scripts the answer; `modelInfo` overrides the
       * whole object for a case that needs a different shape. The default is
       * "this member accepts no reasoning choice", which is what makes a group
       * advertise none.
       */
      resolveModelInfo: async (provider, model) => {
        if (modelInfo !== undefined) return modelInfo(provider, model)
        return {
          provider,
          id: model,
          context: { contextWindow: 128000 },
          ...(efforts === undefined ? {} : { reasoning: { efforts: efforts(provider, model) } }),
        }
      },
      stream: (options) => {
        streamCalls.push(options)
        onStream?.(options)
        // `streamFor` lets a case script per-target behaviour, e.g. make the
        // first group candidate fail before producing a chunk.
        const scripted = streamFor?.(options)
        if (scripted !== undefined) return scripted
        return (async function* generate() {
          for (const chunk of chunks) {
            if (typeof chunk === 'function') yield chunk(options)
            else yield chunk
          }
        })()
      },
    },
  }
  return { ctx, routes, infos, warnings, settingsRoutes, disposers, streamCalls }
}

/** Start a server around the registered prefix route and return helpers. */
async function withServer(routes, fn) {
  const server = createServer((req, res) => {
    const url = new URL(String(req.url), 'http://localhost')
    const route = routes.find((entry) => entry.kind === 'prefix' && url.pathname.startsWith(entry.path))
    if (route === undefined) {
      res.statusCode = 404
      res.end()
      return
    }
    Promise.resolve(route.handler(req, res)).catch(() => {
      if (!res.headersSent) res.statusCode = 500
      res.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    return await fn(base)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

const textChunks = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'Hello' },
  { type: 'text-delta', index: 0, text: ', world' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello, world' } },
  { type: 'usage', usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13, cacheReadTokens: 4 } },
  { type: 'finish', reason: { kind: 'stop' } },
]


/**
 * Call the settings endpoint the way the browser does: a POST of the
 * `{ rpcId, payload: { action, ... } }` envelope to its registered route.
 * @param settingsRoutes - registered settings routes keyed by path.
 * @param action - endpoint action.
 * @param payload - action payload.
 * @returns the decoded result envelope.
 */
/**
 * Poll the settings status until the LAN listener reports a bound port.
 *
 * `server.listen()` binds asynchronously, so a status read taken immediately
 * after `apply()` can still see the configured port rather than the real one.
 * @param settingsRoutes - registered settings routes.
 * @returns the status value once the listener is up.
 */
async function waitForLan(settingsRoutes) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await callSettings(settingsRoutes, 'status')
    if (status.ok && status.value.lan?.listening === true && status.value.lan.port > 0) return status.value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('the LAN listener never reported a bound port')
}

async function callSettings(settingsRoutes, action, payload = {}) {
  const route = settingsRoutes.get('/api/model-relay')
  if (route === undefined) throw new Error('settings route was not registered')
  const request = new Request('http://127.0.0.1:3080/api/model-relay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'test-1', payload: { action, ...payload } }),
  })
  const response = await route.fetch(request)
  const envelope = await response.json()
  return envelope.result
}

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

await test('GET /v1/models lists deduplicated models with ownership', async () => {
  const { ctx, routes } = makeCtx(textChunks)
  mount(ctx, {})
  await withServer(routes, async (base) => {
    const res = await fetch(`${base}/v1/models`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.object, 'list')
    const ids = body.data.map((entry) => entry.id).sort()
    // Every id is namespaced by provider, so two providers may safely serve
    // the same underlying model id without producing a duplicate listing.
    assert.deepEqual(ids, ['codebuddy_glm-5.2', 'codebuddy_deepseek-v4.1-flash', 'deepseek_deepseek-chat'].sort())
    assert.equal(body.data.find((entry) => entry.id === 'codebuddy_glm-5.2').owned_by, 'codebuddy')
  })
})

await test('POST /v1/chat/completions (non-streaming) returns a chat.completion', async () => {
  const { ctx, routes } = makeCtx(textChunks)
  mount(ctx, {})
  await withServer(routes, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.object, 'chat.completion')
    assert.equal(body.choices[0].message.content, 'Hello, world')
    assert.equal(body.choices[0].finish_reason, 'stop')
    // prompt_tokens folds cache reads back in: 10 uncached + 4 cached.
    assert.equal(body.usage.prompt_tokens, 14)
    assert.equal(body.usage.completion_tokens, 3)
    assert.equal(body.usage.total_tokens, 13)
    assert.equal(body.usage.prompt_tokens_details.cached_tokens, 4)
  })
})

await test('streaming emits SSE deltas terminating in [DONE]', async () => {
  const { ctx, routes } = makeCtx(textChunks)
  mount(ctx, {})
  await withServer(routes, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4.1-flash', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type'), /text\/event-stream/)
    const text = await res.text()
    const payloads = text.split('\n\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6))
    assert.equal(payloads.at(-1), '[DONE]')
    const chunks = payloads.slice(0, -1).map((payload) => JSON.parse(payload))
    const deltas = chunks.filter((chunk) => chunk.choices?.[0]?.delta?.content !== undefined)
    assert.deepEqual(deltas.map((chunk) => chunk.choices[0].delta.content), ['Hello', ', world'])
    const final = chunks.find((chunk) => chunk.choices?.[0]?.finish_reason === 'stop')
    assert.ok(final, 'a chunk carries finish_reason=stop')
    const usage = chunks.find((chunk) => chunk.usage !== undefined)
    assert.equal(usage.usage.prompt_tokens, 14)
  })
})

await test('reasoning and tool calls translate to their OpenAI shapes', async () => {
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'thinking' },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: 'call_1', name: 'bash', argumentsDelta: '{"cmd":' },
    { type: 'tool-call-delta', index: 1, id: 'call_1', argumentsDelta: '"ls"}' },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
  const { ctx, routes } = makeCtx(chunks)
  mount(ctx, {})
  await withServer(routes, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'run ls' }] }),
    })
    const body = await res.json()
    const message = body.choices[0].message
    assert.equal(message.reasoning_content, 'thinking')
    assert.equal(body.choices[0].finish_reason, 'tool_calls')
    assert.equal(message.tool_calls.length, 1)
    assert.equal(message.tool_calls[0].function.name, 'bash')
    assert.equal(message.tool_calls[0].function.arguments, '{"cmd":"ls"}')
  })
})

await test('a system message becomes options.system and a tool schema reaches the llm service intact', async () => {
  let seen
  const { ctx, routes } = makeCtx(textChunks, { onStream: (options) => { seen = options } })
  mount(ctx, {})
  await withServer(routes, async (base) => {
    await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'codebuddy/glm-5.2',
        messages: [{ role: 'system', content: 'be terse' }, { role: 'user', content: 'hi' }],
        tools: [{ type: 'function', function: { name: 'bash', description: 'run', parameters: { type: 'object' } } }],
        temperature: 0.5,
        max_tokens: 128,
        stop: 'END',
      }),
    })
  })
  assert.equal(seen.provider, 'codebuddy')
  assert.equal(seen.model, 'glm-5.2')
  // DSH models the system prompt as a request-level `options.system` string,
  // not as a member of `messages`, so it must NOT appear in the array.
  assert.equal(seen.system, 'be terse')
  assert.equal(seen.messages.length, 1)
  assert.equal(seen.messages[0].role, 'user')
  assert.equal(seen.messages[0].content[0].text, 'hi')
  assert.equal(seen.tools[0].name, 'bash')
  assert.equal(seen.temperature, 0.5)
  assert.equal(seen.maxTokens, 128)
  assert.deepEqual(seen.stop, ['END'])
})

await test('several system messages are joined into one options.system prefix', async () => {
  let seen
  const { ctx, routes } = makeCtx(textChunks, { onStream: (options) => { seen = options } })
  mount(ctx, {})
  await withServer(routes, async (base) => {
    await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'codebuddy/glm-5.2',
        messages: [
          { role: 'system', content: 'be terse' },
          { role: 'developer', content: 'prefer tables' },
          { role: 'user', content: 'hi' },
        ],
      }),
    })
  })
  assert.equal(seen.system, 'be terse\n\nprefer tables')
  assert.equal(seen.messages.length, 1)
  assert.equal(seen.messages[0].role, 'user')
})

await test('a request with no system message sends no options.system at all', async () => {
  let seen
  const { ctx, routes } = makeCtx(textChunks, { onStream: (options) => { seen = options } })
  mount(ctx, {})
  await withServer(routes, async (base) => {
    await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'codebuddy/glm-5.2', messages: [{ role: 'user', content: 'hi' }] }),
    })
  })
  // The key must be ABSENT rather than an empty string: an adapter maps a
  // present `system` to a provider system slot, so '' would emit an empty one.
  assert.equal('system' in seen, false)
  assert.equal(seen.messages.length, 1)
})

await test('a tool result message becomes a user-role tool-result block', async () => {
  let seen
  const { ctx, routes } = makeCtx(textChunks, { onStream: (options) => { seen = options } })
  mount(ctx, {})
  await withServer(routes, async (base) => {
    await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'glm-5.2',
        messages: [
          { role: 'user', content: 'run' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 'call_1', content: 'output' },
        ],
      }),
    })
  })
  const assistant = seen.messages.find((message) => message.role === 'assistant')
  assert.equal(assistant.content.find((block) => block.type === 'tool-call').name, 'bash')
  const tool = seen.messages.find((message) => message.content.some((block) => block.type === 'tool-result'))
  assert.equal(tool.role, 'user')
  assert.equal(tool.content[0].toolCallId, 'call_1')
  assert.equal(tool.content[0].content[0].text, 'output')
})

await test('an ambiguous bare model id is refused with guidance', async () => {
  const { ctx, routes } = makeCtx(textChunks)
  mount(ctx, {})
  await withServer(routes, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'nope', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(res.status, 404)
    const body = await res.json()
    assert.match(body.error.message, /does not exist/)
  })
})

await test('configured API keys are enforced, and omitted keys leave it open', async () => {
  const guarded = makeCtx(textChunks)
    mount(guarded.ctx, { apiKeys: ['sk-secret'] })
  await withServer(guarded.routes, async (base) => {
    const denied = await fetch(`${base}/v1/models`)
    assert.equal(denied.status, 401)
    const wrong = await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer sk-nope' } })
    assert.equal(wrong.status, 401)
    const allowed = await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer sk-secret' } })
    assert.equal(allowed.status, 200)
    const viaApiKey = await fetch(`${base}/v1/models`, { headers: { 'x-api-key': 'sk-secret' } })
    assert.equal(viaApiKey.status, 200)
  })

  const open = makeCtx(textChunks)
  mount(open.ctx, {})
  await withServer(open.routes, async (base) => {
    assert.equal((await fetch(`${base}/v1/models`)).status, 200)
  })
})

await test('model routing honours provider/model, defaultProvider, and providers filter', async () => {
  let seen
  const { ctx, routes } = makeCtx(textChunks, { onStream: (options) => { seen = options } })
  mount(ctx, { defaultProvider: 'deepseek', providers: ['deepseek'] })
  await withServer(routes, async (base) => {
    const listed = await (await fetch(`${base}/v1/models`)).json()
    assert.deepEqual(listed.data.map((entry) => entry.id), ['deepseek_deepseek-chat'])
    await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek_deepseek-chat', messages: [{ role: 'user', content: 'hi' }] }),
    })
  })
  assert.equal(seen.provider, 'deepseek')
  // The provider must receive its OWN model id, never the namespaced one.
  assert.equal(seen.model, 'deepseek-chat')
})

await test('a bare id shared by two providers is refused with the namespaced options', async () => {
  // `deepseek-v4-flash` is served by both deepseek-official and codebuddy in a
  // stock composition, so a bare id cannot be resolved safely.
  const { ctx, routes } = makeCtx(textChunks)
  ctx.llm.listModels = async (provider) => (provider === 'codebuddy'
    ? [{ provider, id: 'deepseek-v4-flash', name: 'Deepseek-V4-Flash' }]
    : [{ provider, id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' }])
  mount(ctx, {})
  await withServer(routes, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.equal(body.error.code, 'ambiguous_model')
    assert.match(body.error.message, /codebuddy_deepseek-v4-flash/)
    assert.match(body.error.message, /deepseek_deepseek-v4-flash/)
  })
})

await test('the namespaced id selects the intended provider for a shared model id', async () => {
  let seen
  const { ctx, routes } = makeCtx(textChunks, { onStream: (options) => { seen = options } })
  ctx.llm.listModels = async (provider) => (
    provider === 'dsh-model-gateway'
      ? []
      : [{ provider, id: 'deepseek-v4-flash', name: 'Flash' }]
  )
  mount(ctx, {})
  await withServer(routes, async (base) => {
    const listed = await (await fetch(`${base}/v1/models`)).json()
    // Both providers are listed, each under its own namespace, with no duplicates.
    // The gateway's own route advertises no models of its own: it exists to
    // carry the group list, and a group is listed under its plain name.
    const ids = listed.data.map((entry) => entry.id).sort()
    assert.deepEqual(ids, ['codebuddy_deepseek-v4-flash', 'deepseek_deepseek-v4-flash'])
    assert.equal(new Set(ids).size, ids.length, 'namespacing removes the collision')

    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'codebuddy_deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.model, 'codebuddy_deepseek-v4-flash', 'the response echoes the requested name')
  })
  assert.equal(seen.provider, 'codebuddy', 'the prefix chose the provider')
  assert.equal(seen.model, 'deepseek-v4-flash', 'the provider received its own id')
})

await test('the legacy provider/model spelling still routes', async () => {
  let seen
  const { ctx, routes } = makeCtx(textChunks, { onStream: (options) => { seen = options } })
  mount(ctx, {})
  await withServer(routes, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'codebuddy/glm-5.2', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    // The legacy spelling is normalised to the canonical namespaced name.
    assert.equal(body.model, 'codebuddy_glm-5.2')
  })
  assert.equal(seen.provider, 'codebuddy')
  assert.equal(seen.model, 'glm-5.2')
})

await test('a provider failure surfaces as an HTTP error before headers', async () => {
  const { ctx, routes } = makeCtx([])
  ctx.llm.stream = () => (async function* generate() {
    const error = new Error('CodeBuddy is not signed in')
    error.code = 'MISSING_CREDENTIAL'
    throw error
  })()
  mount(ctx, {})
  await withServer(routes, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5.2', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.match(body.error.message, /not signed in/)
  })
})

await test('unknown routes, bad JSON, and bad methods are refused cleanly', async () => {
  const { ctx, routes } = makeCtx(textChunks)
  mount(ctx, {})
  await withServer(routes, async (base) => {
    const unknown = await fetch(`${base}/v1/embeddings`, { method: 'POST' })
    assert.equal(unknown.status, 404)
    assert.equal((await unknown.json()).error.code, 'unknown_route')

    const badJson = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })
    assert.equal(badJson.status, 400)

    const wrongMethod = await fetch(`${base}/v1/models`, { method: 'POST' })
    assert.equal(wrongMethod.status, 405)
    assert.equal(wrongMethod.headers.get('allow'), 'GET, OPTIONS')

    const preflight = await fetch(`${base}/v1/chat/completions`, { method: 'OPTIONS' })
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*')
  })
})

await test('a mid-stream provider failure emits a terminal SSE error', async () => {
  const chunks = [
    { type: 'text-delta', index: 0, text: 'partial' },
    { type: 'finish', reason: { kind: 'error', failure: { message: 'upstream exploded', code: 'TRANSPORT' } } },
  ]
  const { ctx, routes } = makeCtx(chunks)
  mount(ctx, {})
  await withServer(routes, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5.2', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    })
    const text = await res.text()
    assert.match(text, /upstream exploded/)
    assert.match(text, /\[DONE\]/)
  })
})

await test('the request body being fully read does not abort the upstream call', async () => {
  // Regression guard: Node emits `close` on IncomingMessage once its body has
  // been consumed. Aborting upstream work on that event cancels every request
  // the moment the body is read, so this asserts the signal stays live across
  // an awaited generation.
  let signalDuringGeneration
  const { ctx, routes } = makeCtx(textChunks)
  const realStream = ctx.llm.stream
  ctx.llm.stream = (options) => (async function* generate() {
    await new Promise((resolve) => setTimeout(resolve, 50))
    signalDuringGeneration = options.signal
    yield* realStream(options)
  })()
  mount(ctx, {})
  await withServer(routes, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5.2', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.choices[0].message.content, 'Hello, world')
  })
  assert.ok(signalDuringGeneration, 'the upstream call received a signal')
  assert.equal(signalDuringGeneration.aborted, false, 'the signal was not aborted while generating')
})

await test('failure codes map to the right HTTP status and error type', async () => {
  const cases = [
    { code: 'MISSING_CREDENTIAL', status: 401 },
    { code: 'QUOTA', status: 429 },
    { code: 'INVALID_REQUEST', status: 400 },
    { code: 'TRANSPORT', status: 502 },
  ]
  for (const { code, status } of cases) {
    const { ctx, routes } = makeCtx([{ type: 'finish', reason: { kind: 'error', failure: { message: `boom ${code}`, code } } }])
    mount(ctx, {})
    await withServer(routes, async (base) => {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'glm-5.2', messages: [{ role: 'user', content: 'hi' }] }),
      })
      assert.equal(res.status, status, `${code} should map to ${status}`)
      const body = await res.json()
      assert.equal(body.error.code, code)
      assert.equal(body.error.type, 'upstream_error')
    })
  }
})

await test('a malformed JSON body is a client error, not an upstream error', async () => {
  const { ctx, routes } = makeCtx(textChunks)
  mount(ctx, {})
  await withServer(routes, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{oops',
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.equal(body.error.type, 'invalid_request_error')
    assert.equal(body.error.code, 'invalid_json')
  })
})

await test('the settings endpoint lives under /api so a reverse proxy forwards it', async () => {
  // Regression guard: a plugin-private channel like `/model-relay` is not on
  // a fronting gateway's rewrite list, so the browser's call never reached DSH
  // and the settings page failed with HTTP 404. `/api` is the one prefix every
  // deployment already routes.
  const { ctx, settingsRoutes } = makeCtx(textChunks)
  mount(ctx, {})
  assert.ok(
    settingsRoutes.has('/api/model-relay'),
    'the settings endpoint must be registered under the /api prefix',
  )
  for (const path of settingsRoutes.keys()) {
    assert.ok(path.startsWith('/api/'), `settings route ${path} must sit under /api`)
  }
})

await test('the settings endpoint rejects malformed bodies without throwing', async () => {
  const { ctx, settingsRoutes } = makeCtx(textChunks)
  mount(ctx, {})
  const route = settingsRoutes.get('/api/model-relay')
  const response = await route.fetch(new Request('http://127.0.0.1:3080/api/model-relay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  }))
  assert.equal(response.status, 400)
})

await test('the settings status reports the real listening port for direct calls', async () => {
  const { ctx, settingsRoutes } = makeCtx(textChunks)
  mount(ctx, {})
  const status = await callSettings(settingsRoutes, 'status')
  assert.equal(status.ok, true)
  assert.equal(status.value.port, 3080, 'the port comes from the web server, not the page origin')
  assert.equal(status.value.bindHost, '127.0.0.1')
})

await test('the settings RPC channel creates, lists, and revokes keys', async () => {
  const { ctx, routes, settingsRoutes } = makeCtx(textChunks)
  mount(ctx, {})
  assert.ok(settingsRoutes.get('/api/model-relay'), 'the plugin registered its settings endpoint')

  const before = await callSettings(settingsRoutes, 'status')
  assert.equal(before.ok, true)
  assert.equal(before.value.authRequired, false, 'no keys means no auth required')
  assert.deepEqual(before.value.keys, [])
  assert.equal(before.value.completionsPath, '/v1/chat/completions')

  const created = await callSettings(settingsRoutes, 'createKey', { label: 'ci' })
  assert.equal(created.ok, true)
  assert.match(created.value.key, /^sk-dshgw-/)
  assert.equal(created.value.label, 'ci')

  const after = await callSettings(settingsRoutes, 'status')
  assert.equal(after.value.authRequired, true, 'a stored key turns auth on')
  assert.equal(after.value.keys.length, 1)
  assert.equal('key' in after.value.keys[0], false, 'status must never return a plaintext key')
  assert.equal('hash' in after.value.keys[0], false, 'status must never return a hash')

  // A key minted from the settings page must actually authenticate /v1 calls.
  await withServer(routes, async (base) => {
    assert.equal((await fetch(`${base}/v1/models`)).status, 401, 'no key is now refused')
    const ok = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${created.value.key}` } })
    assert.equal(ok.status, 200, 'the minted key is accepted')
  })

  const revoked = await callSettings(settingsRoutes, 'revokeKey', { id: created.value.id })
  assert.equal(revoked.ok, true)
  const missing = await callSettings(settingsRoutes, 'revokeKey', { id: created.value.id })
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'NOT_FOUND')

  // Revoking the last key must NOT reopen the endpoint: deleting a key is a
  // cleanup action, and it silently widening access would be an escalation.
  const final = await callSettings(settingsRoutes, 'status')
  assert.equal(final.value.keys.length, 0)
  assert.equal(final.value.authRequired, true, 'the endpoint stays locked after the last key is removed')
  await withServer(routes, async (base) => {
    assert.equal((await fetch(`${base}/v1/models`)).status, 401, 'the revoked key is refused')
  })

  // Only an explicit toggle opens it again.
  const opened = await callSettings(settingsRoutes, 'setAuth', { locked: false })
  assert.equal(opened.ok, true)
  const reopened = await callSettings(settingsRoutes, 'status')
  assert.equal(reopened.value.authRequired, false)
  await withServer(routes, async (base) => {
    assert.equal((await fetch(`${base}/v1/models`)).status, 200)
  })
})

await test('setAuth cannot open an endpoint guarded by a fixed config key', async () => {
  const { ctx, settingsRoutes } = makeCtx(textChunks)
  mount(ctx, { apiKeys: ['sk-static'] })
  
  const result = await callSettings(settingsRoutes, 'setAuth', { locked: false })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'CONFLICT')
})

await test('the settings RPC channel rejects unknown endpoints and bad revoke payloads', async () => {
  const { ctx, settingsRoutes } = makeCtx(textChunks)
  mount(ctx, {})
  
  
  const unknown = await callSettings(settingsRoutes, 'nope')
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.code, 'UNKNOWN_ENDPOINT')

  const badRevoke = await callSettings(settingsRoutes, 'revokeKey')
  assert.equal(badRevoke.ok, false)
  assert.equal(badRevoke.error.code, 'INVALID_REQUEST')
})

await test('a config-supplied key keeps working alongside minted ones', async () => {
  const { ctx, routes, settingsRoutes } = makeCtx(textChunks)
  mount(ctx, { apiKeys: ['sk-static'] })
  
  const status = await callSettings(settingsRoutes, 'status')
  assert.equal(status.value.staticKeyCount, 1)

  const created = await callSettings(settingsRoutes, 'createKey')
  await withServer(routes, async (base) => {
    assert.equal((await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer sk-static' } })).status, 200)
    assert.equal((await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${created.value.key}` } })).status, 200)
    assert.equal((await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer sk-wrong' } })).status, 401)
  })
})

await test('the LAN listener serves the model API on its own port', async () => {
  // lanPort 0 asks the OS for a free port, so this test never collides with
  // whatever else runs on the machine.
  const { ctx, settingsRoutes, disposers } = makeCtx(textChunks)
  mount(ctx, { lanPort: 0, lanHost: '127.0.0.1' })
  try {
    const status = await waitForLan(settingsRoutes)
    const lan = status.lan
    assert.ok(lan, 'status reports the LAN listener')
    assert.ok(lan.port > 0, `expected a bound port, got ${String(lan.port)}`)
    assert.equal(lan.listening, true)

    const base = `http://127.0.0.1:${lan.port}`
    const models = await fetch(`${base}/v1/models`)
    assert.equal(models.status, 200)
    assert.equal((await models.json()).object, 'list')

    // The LAN listener serves the gateway API and nothing else of DSH.
    const ui = await fetch(`${base}/`)
    assert.equal(ui.status, 404, 'the DSH UI must not be reachable on the LAN port')
    const settings = await fetch(`${base}/api/model-relay`, { method: 'POST' })
    assert.equal(settings.status, 404, 'the settings endpoint must not be on the LAN port')

    // Completions work over the same listener.
    const completion = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5.2', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(completion.status, 200)
    assert.equal((await completion.json()).choices[0].message.content, 'Hello, world')
  } finally {
    for (const dispose of disposers) dispose()
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
})

await test('the LAN listener enforces the same API keys as the local route', async () => {
  const { ctx, settingsRoutes, disposers } = makeCtx(textChunks)
  mount(ctx, { lanPort: 0, lanHost: '127.0.0.1', apiKeys: ['sk-lan'] })
  try {
    const status = await waitForLan(settingsRoutes)
    const base = `http://127.0.0.1:${status.lan.port}`
    assert.equal((await fetch(`${base}/v1/models`)).status, 401, 'no key is refused')
    assert.equal(
      (await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer sk-wrong' } })).status,
      401,
      'a wrong key is refused',
    )
    assert.equal(
      (await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer sk-lan' } })).status,
      200,
      'the configured key is accepted',
    )
  } finally {
    for (const dispose of disposers) dispose()
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
})

await test('no LAN listener is started when lanPort is unset', async () => {
  const { ctx, infos, settingsRoutes } = makeCtx(textChunks)
  mount(ctx, {})
  const status = await callSettings(settingsRoutes, 'status')
  assert.equal(status.value.lan, null, 'status reports no LAN listener')
  assert.equal(
    infos.some((line) => line.includes('LAN listener')),
    false,
    'nothing is bound when the option is off',
  )
})

await test('an out-of-range lanPort is rejected at load time', () => {
  const { ctx } = makeCtx(textChunks)
  assert.throws(() => mount(ctx, { lanPort: 70000 }), /lanPort/)
  assert.throws(() => mount(ctx, { lanPort: 1.5 }), /lanPort/)
  assert.throws(() => mount(ctx, { lanPort: -1 }), /lanPort/)
})

await test('the LAN status lists only reachable addresses, never virtual bridges', async () => {
  // A NAS with Docker installed reports many private bridge addresses. Listing
  // them would bury the one address a LAN peer can use, so they are filtered
  // out and only counted.
  const { ctx, settingsRoutes, disposers } = makeCtx(textChunks)
  mount(ctx, { lanPort: 0, lanHost: '127.0.0.1' })
  try {
    const status = await waitForLan(settingsRoutes)
    const { addresses, hiddenCount } = status.lan
    assert.ok(Array.isArray(addresses), 'addresses is a list')
    assert.equal(typeof hiddenCount, 'number', 'hiddenCount is reported')
    assert.ok(hiddenCount >= 0)
    for (const entry of addresses) {
      assert.equal(typeof entry.address, 'string')
      assert.equal(typeof entry.iface, 'string')
      // No virtual interface may survive the filter.
      assert.equal(
        /^(?:docker|br-|veth|virbr|vmnet|vboxnet|tun|tap|wg|zt|tailscale|lo)/i.test(entry.iface),
        false,
        `virtual interface ${entry.iface} must not be listed`,
      )
      assert.equal(entry.address.startsWith('127.'), false, 'loopback must not be listed')
    }
    // When the host has a default route, that interface must lead the list.
    if (addresses.length > 1) {
      const table = readFileSync('/proc/net/route', 'utf8').split('\n')
      const defaultIface = table.slice(1)
        .map((line) => line.trim().split(/\s+/))
        .find((fields) => fields[1] === '00000000')?.[0]
      if (defaultIface !== undefined) {
        assert.equal(addresses[0].iface, defaultIface, 'the default-route interface is listed first')
      }
    }
  } finally {
    for (const dispose of disposers) dispose()
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
})

await test('the LAN listener still binds when no real interface is detectable', async () => {
  // Filtering must never make the feature unusable: the listener binds
  // regardless, and the page simply reports that it found no address.
  const { ctx, settingsRoutes, disposers } = makeCtx(textChunks)
  mount(ctx, { lanPort: 0, lanHost: '127.0.0.1' })
  try {
    const status = await waitForLan(settingsRoutes)
    assert.equal(status.lan.listening, true, 'the listener is up even with an empty address list')
    assert.equal(typeof status.lan.port, 'number')
    assert.ok(status.lan.port > 0)
  } finally {
    for (const dispose of disposers) dispose()
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
})

// ---------------------------------------------------------------------------
// Model groups
// ---------------------------------------------------------------------------

/** Create a group through the settings endpoint. */
async function createGroup(settingsRoutes, name, models) {
  return callSettings(settingsRoutes, 'createGroup', { name, models })
}

await test('a group name routes to its first candidate', async () => {
  const { ctx, routes, settingsRoutes, streamCalls } = makeCtx(textChunks)
  mount(ctx, {})
  await withServer(routes, async (base) => {
    const created = await createGroup(settingsRoutes, 'fast-chat', ['codebuddy_glm-5.2', 'deepseek_deepseek-chat'])
    assert.equal(created.ok, true, created.error?.message)

    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fast-chat', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    // The response echoes what the caller asked for, not the member that served it.
    assert.equal(body.model, 'fast-chat')
    // The head candidate is the one actually dispatched.
    assert.equal(streamCalls.at(-1).provider, 'codebuddy')
    assert.equal(streamCalls.at(-1).model, 'glm-5.2')
  })
})

await test('a group fails over to the next candidate when the first produces no chunk', async () => {
  const chunks = textChunks
  const { ctx, routes, settingsRoutes, warnings } = makeCtx(chunks, {
    streamFor: (options) => {
      // The first candidate fails before yielding anything, which is exactly
      // the case that must stay invisible to the client.
      if (options.provider === 'codebuddy') {
        return (async function* failing() {
          throw Object.assign(new Error('credential unavailable'), { code: 'MISSING_CREDENTIAL' })
        })()
      }
      return undefined
    },
  })
  mount(ctx, {})
  await withServer(routes, async (base) => {
    await createGroup(settingsRoutes, 'g', ['codebuddy_glm-5.2', 'deepseek_deepseek-chat'])
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'g', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(res.status, 200, 'the second candidate must serve the request')
    assert.equal((await res.json()).model, 'g')
    assert.equal(res.headers.get('x-relay-group'), 'g')
    assert.equal(res.headers.get('x-relay-model'), 'deepseek_deepseek-chat')
    assert.equal(warnings.some((line) => typeof line === 'string' && line.includes('trying the next')), true)
  })
})

await test('a group whose every candidate fails reports the upstream error', async () => {
  const { ctx, routes, settingsRoutes } = makeCtx(textChunks, {
    streamFor: () => (async function* failing() {
      throw Object.assign(new Error('nope'), { code: 'MISSING_CREDENTIAL', status: 502 })
    })(),
  })
  mount(ctx, {})
  await withServer(routes, async (base) => {
    await createGroup(settingsRoutes, 'g', ['codebuddy_glm-5.2', 'deepseek_deepseek-chat'])
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'g', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.notEqual(res.status, 200)
    assert.equal((await res.json()).error.code, 'MISSING_CREDENTIAL')
  })
})

await test('an abandoned candidate iterator is closed, not leaked', async () => {
  let closed = 0
  const { ctx, routes, settingsRoutes } = makeCtx(textChunks, {
    streamFor: (options) => {
      if (options.provider !== 'codebuddy') return undefined
      return {
        [Symbol.asyncIterator]() {
          return {
            next: async () => { throw new Error('unavailable') },
            return: async () => { closed += 1; return { done: true } },
          }
        },
      }
    },
  })
  mount(ctx, {})
  await withServer(routes, async (base) => {
    await createGroup(settingsRoutes, 'g', ['codebuddy_glm-5.2', 'deepseek_deepseek-chat'])
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'g', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(res.status, 200)
    assert.equal(closed, 1, 'the failed attempt must be closed before moving on')
  })
})

/**
 * The failure shape a real provider produces.
 *
 * `dsh-llm` does not let an adapter failure escape as a throw: `adapterStream`
 * catches it at its own boundary and yields a terminal `finish` chunk carrying
 * `reason.kind === 'error'` (dsh-llm:1692-1710, `adapterFailureChunk`). A fake
 * that only ever *throws* cannot exercise that, which is why the real failover
 * path was dead while every mock-based test passed.
 */
const failureChunk = (code, message, providerRetryAfterMs) => ({
  type: 'finish',
  reason: {
    kind: 'error',
    failure: {
      code,
      message,
      ...(providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs }),
    },
  },
})

/**
 * A caller-supplied `reasoning_effort` that the target member cannot accept.
 *
 * DSH itself rejects such a request with UNSUPPORTED_REASONING_EFFORT, which
 * would turn a stale preference into a hard failure — a session can easily hold
 * an effort chosen before the group's members changed. Dropping it and warning
 * is the agreed behaviour, so both halves are asserted here.
 */
await test('an unsupported reasoning_effort is dropped with a warning, not rejected', async () => {
  const { ctx, routes, settingsRoutes, warnings, streamCalls } = makeCtx(textChunks, {
    // Every member accepts only `low`.
    efforts: () => [{ id: 'low', name: 'Low' }],
  })
  mount(ctx, {})
  await withServer(routes, async (base) => {
    await createGroup(settingsRoutes, 'g', ['codebuddy_glm-5.2', 'deepseek_deepseek-chat'])
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'g',
        messages: [{ role: 'user', content: 'hi' }],
        reasoning_effort: 'max',
      }),
    })
    assert.equal(res.status, 200, 'the request still succeeds')
    assert.equal(streamCalls.at(-1).reasoningEffort, undefined, 'the unsupported effort was not forwarded')
    assert.equal(
      warnings.some((line) => typeof line === 'string' && line.includes('does not accept reasoning effort')),
      true,
      'the drop is reported rather than silent',
    )
  })
})

await test('a supported reasoning_effort is forwarded untouched', async () => {
  const { ctx, routes, settingsRoutes, warnings, streamCalls } = makeCtx(textChunks, {
    efforts: () => [{ id: 'low', name: 'Low' }, { id: 'max', name: 'Max' }],
  })
  mount(ctx, {})
  await withServer(routes, async (base) => {
    await createGroup(settingsRoutes, 'g', ['codebuddy_glm-5.2', 'deepseek_deepseek-chat'])
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'g',
        messages: [{ role: 'user', content: 'hi' }],
        reasoning_effort: 'max',
      }),
    })
    assert.equal(res.status, 200)
    assert.equal(streamCalls.at(-1).reasoningEffort, 'max')
    assert.equal(
      warnings.some((line) => typeof line === 'string' && line.includes('does not accept reasoning effort')),
      false,
      'nothing was dropped, so nothing is warned about',
    )
  })
})

await test('a member that declares no reasoning has the parameter dropped', async () => {
  const { ctx, routes, settingsRoutes, streamCalls } = makeCtx(textChunks, {
    // `efforts` omitted: the fake declares no reasoning block at all, which is
    // the shape that produced the reported UNSUPPORTED_REASONING_EFFORT error.
  })
  mount(ctx, {})
  await withServer(routes, async (base) => {
    await createGroup(settingsRoutes, 'g', ['codebuddy_glm-5.2', 'deepseek_deepseek-chat'])
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'g',
        messages: [{ role: 'user', content: 'hi' }],
        reasoning_effort: 'high',
      }),
    })
    assert.equal(res.status, 200)
    assert.equal(streamCalls.at(-1).reasoningEffort, undefined)
  })
})

await test('a caller that names no effort sends none', async () => {
  const { ctx, routes, settingsRoutes, streamCalls } = makeCtx(textChunks, {
    efforts: () => [{ id: 'low', name: 'Low' }],
  })
  mount(ctx, {})
  await withServer(routes, async (base) => {
    await createGroup(settingsRoutes, 'g', ['codebuddy_glm-5.2', 'deepseek_deepseek-chat'])
    await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'g', messages: [{ role: 'user', content: 'hi' }] }),
    })
    // Nothing is invented on the caller's behalf.
    assert.equal(streamCalls.at(-1).reasoningEffort, undefined)
  })
})

await test('a direct model call keeps the effort the caller chose, unsupported or not', async () => {
  const { ctx, routes, streamCalls } = makeCtx(textChunks, {
    efforts: () => [{ id: 'low', name: 'Low' }],
  })
  mount(ctx, {})
  await withServer(routes, async (base) => {
    // No group: the caller named both the model and the effort, so silently
    // discarding its instruction would be worse than letting the provider
    // reject it with a clear reason.
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'codebuddy_glm-5.2',
        messages: [{ role: 'user', content: 'hi' }],
        reasoning_effort: 'max',
      }),
    })
    assert.equal(res.status, 200)
    assert.equal(streamCalls.at(-1).reasoningEffort, 'max', 'the caller\'s explicit choice is forwarded')
  })
})

await test('a group fails over when a candidate fails via an error chunk, not a throw', async () => {
  const { ctx, routes, settingsRoutes, warnings } = makeCtx(textChunks, {
    streamFor: (options) => {
      if (options.provider !== 'codebuddy') return undefined
      // Yields, does not throw — exactly what `dsh-llm` produces.
      return (async function* failing() {
        yield failureChunk('MISSING_CREDENTIAL', 'credential unavailable')
      })()
    },
  })
  mount(ctx, {})
  await withServer(routes, async (base) => {
    await createGroup(settingsRoutes, 'g', ['codebuddy_glm-5.2', 'deepseek_deepseek-chat'])
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'g', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(res.status, 200, 'the second candidate must serve the request')
    assert.equal(res.headers.get('x-relay-model'), 'deepseek_deepseek-chat')
    assert.equal((await res.json()).model, 'g')
    assert.equal(warnings.some((line) => typeof line === 'string' && line.includes('trying the next')), true)
  })
})

await test('an error chunk from every candidate reports the upstream error, not success', async () => {
  const { ctx, routes, settingsRoutes } = makeCtx(textChunks, {
    streamFor: () => (async function* failing() {
      yield failureChunk('MISSING_CREDENTIAL', 'nope')
    })(),
  })
  mount(ctx, {})
  await withServer(routes, async (base) => {
    await createGroup(settingsRoutes, 'g', ['codebuddy_glm-5.2', 'deepseek_deepseek-chat'])
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'g', messages: [{ role: 'user', content: 'hi' }] }),
    })
    // Treating the chunk as an answer would make this a 200 with no content.
    assert.notEqual(res.status, 200)
    assert.equal((await res.json()).error.code, 'MISSING_CREDENTIAL')
  })
})

await test('a candidate that fails after emitting output is committed, not replaced', async () => {
  const { ctx, routes, settingsRoutes, streamCalls } = makeCtx(textChunks, {
    streamFor: (options) => {
      if (options.provider !== 'codebuddy') return undefined
      return (async function* halfThenFail() {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'partial' }
        yield failureChunk('UPSTREAM_ERROR', 'died mid-stream')
      })()
    },
  })
  mount(ctx, {})
  await withServer(routes, async (base) => {
    await createGroup(settingsRoutes, 'g', ['codebuddy_glm-5.2', 'deepseek_deepseek-chat'])
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'g', messages: [{ role: 'user', content: 'hi' }] }),
    })
    // The invariant: output was produced, so switching members would replay it.
    assert.equal(streamCalls.length, 1, 'no second candidate may be tried')
    // This is a buffered (non-streaming) call, so nothing has been written to
    // the client yet and the genuine failure is reported as an HTTP error
    // rather than a 200 carrying half an answer.
    assert.equal(res.status, 502)
    assert.equal((await res.json()).error.code, 'UPSTREAM_ERROR')
  })
})

await test('a committed failure mid-stream is reported, not retried', async () => {
  const { ctx, routes, settingsRoutes, streamCalls } = makeCtx(textChunks, {
    streamFor: (options) => {
      if (options.provider !== 'codebuddy') return undefined
      return (async function* halfThenFail() {
        yield { type: 'text-delta', index: 0, text: 'partial' }
        yield failureChunk('UPSTREAM_ERROR', 'died mid-stream')
      })()
    },
  })
  mount(ctx, {})
  await withServer(routes, async (base) => {
    await createGroup(settingsRoutes, 'g', ['codebuddy_glm-5.2', 'deepseek_deepseek-chat'])
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'g', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })
    const text = await res.text()
    assert.equal(streamCalls.length, 1, 'no second candidate may be tried')
    assert.equal(res.status, 200, 'headers were already committed by the first delta')
    assert.equal(text.includes('partial'), true, 'the delivered content is not replayed')
    assert.equal(text.includes('UPSTREAM_ERROR'), true, 'the failure is still surfaced')
  })
})

await test('usage alone does not commit an attempt', async () => {
  const { ctx, routes, settingsRoutes } = makeCtx(textChunks, {
    streamFor: (options) => {
      if (options.provider !== 'codebuddy') return undefined
      // Usage carries no model output, so the caller has still seen nothing.
      return (async function* usageThenFail() {
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 } }
        yield failureChunk('RATE_LIMIT', 'slow down')
      })()
    },
  })
  mount(ctx, {})
  await withServer(routes, async (base) => {
    await createGroup(settingsRoutes, 'g', ['codebuddy_glm-5.2', 'deepseek_deepseek-chat'])
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'g', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('x-relay-model'), 'deepseek_deepseek-chat')
  })
})

await test('an aborted candidate is never failed over', async () => {
  const { ctx, routes, settingsRoutes, streamCalls } = makeCtx(textChunks, {
    streamFor: (options) => {
      if (options.provider !== 'codebuddy') return undefined
      // A cancellation is the caller giving up, not a candidate failing.
      return (async function* aborted() {
        yield { type: 'finish', reason: { kind: 'aborted' } }
      })()
    },
  })
  mount(ctx, {})
  await withServer(routes, async (base) => {
    await createGroup(settingsRoutes, 'g', ['codebuddy_glm-5.2', 'deepseek_deepseek-chat'])
    await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'g', messages: [{ role: 'user', content: 'hi' }] }),
    })
    // Restarting work the caller just cancelled would be a correctness bug.
    assert.equal(streamCalls.length, 1, 'an abort must not start another candidate')
  })
})

await test('a disabled group is not routable', async () => {
  const { ctx, routes, settingsRoutes } = makeCtx(textChunks)
  mount(ctx, {})
  await withServer(routes, async (base) => {
    await createGroup(settingsRoutes, 'g', ['codebuddy_glm-5.2'])
    assert.equal((await callSettings(settingsRoutes, 'updateGroup', { id: 'g', enabled: false })).ok, true)
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'g', messages: [{ role: 'user', content: 'hi' }] }),
    })
    // Falls through to ordinary model resolution, which cannot find "g".
    assert.notEqual(res.status, 200)
  })
})

await test('a group naming this gateway is refused rather than recursing', async () => {
  const { ctx, routes, settingsRoutes } = makeCtx(textChunks)
  mount(ctx, {})
  await withServer(routes, async (base) => {
    // The gateway registers itself as a provider, so this spelling looks
    // legitimate; resolving it must stop instead of looping back into itself.
    const created = await createGroup(settingsRoutes, 'self', ['dsh-model-gateway_self'])
    assert.equal(created.ok, true, 'the store accepts it; resolution is where it is refused')
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'self', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.notEqual(res.status, 200)
    assert.equal((await res.json()).error.code, 'group_self_reference')
  })
})

await test('groups are visible in the model catalog alongside real models', async () => {
  const { ctx, routes, settingsRoutes } = makeCtx(textChunks)
  mount(ctx, {})
  await withServer(routes, async (base) => {
    await createGroup(settingsRoutes, 'fast-chat', ['codebuddy_glm-5.2'])
    const body = await (await fetch(`${base}/v1/models`)).json()
    const ids = body.data.map((entry) => entry.id)
    assert.equal(ids.includes('fast-chat'), true, 'an external caller must see the group')
    assert.equal(ids.includes('codebuddy_glm-5.2'), true, 'and the underlying models too')
  })
})

await test('the settings channel lists, updates, and removes groups', async () => {
  const { ctx, routes, settingsRoutes } = makeCtx(textChunks)
  mount(ctx, {})
  await withServer(routes, async () => {
    assert.equal((await createGroup(settingsRoutes, 'g', ['codebuddy_glm-5.2'])).ok, true)
    assert.equal((await createGroup(settingsRoutes, 'g', ['codebuddy_glm-5.2'])).ok, false, 'duplicate refused')

    const listed = await callSettings(settingsRoutes, 'listGroups')
    assert.equal(listed.ok, true)
    assert.deepEqual(listed.value.groups.map((group) => group.name), ['g'])

    assert.equal((await callSettings(settingsRoutes, 'updateGroup', { id: 'g', models: ['deepseek_deepseek-chat'] })).ok, true)
    assert.deepEqual((await callSettings(settingsRoutes, 'listGroups')).value.groups[0].models, ['deepseek_deepseek-chat'])

    assert.equal((await callSettings(settingsRoutes, 'removeGroup', { id: 'g' })).ok, true)
    assert.deepEqual((await callSettings(settingsRoutes, 'listGroups')).value.groups, [])
  })
})

await test('group names colliding with a model name are rejected by the store', async () => {
  const { ctx, routes, settingsRoutes } = makeCtx(textChunks)
  mount(ctx, {})
  await withServer(routes, async () => {
    // An underscore would make the name indistinguishable from `<provider>_<model>`.
    const bad = await createGroup(settingsRoutes, 'codebuddy_glm-5.2', ['codebuddy_glm-5.2'])
    assert.equal(bad.ok, false)
    assert.equal(bad.error.code, 'INVALID_GROUP')
    assert.match(bad.error.message, /下划线/)
  })
})

/**
 * An upstream `Retry-After` must survive to the HTTP client.
 *
 * `dsh-llm-deepseek` parses the header into `providerRetryAfterMs`, and
 * `dsh-llm-retry` prefers it over its own backoff. Dropping it makes the
 * gateway hammer a provider that explicitly asked for quiet.
 */
await test('an upstream retry hint becomes a Retry-After header', async () => {
  const { ctx, routes, settingsRoutes } = makeCtx(textChunks, {
    streamFor: (options) => {
      if (options.provider !== 'codebuddy') return undefined
      return (async function* rateLimited() {
        // 30s in ms, exactly as a provider adapter would report it.
        yield failureChunk('RATE_LIMIT', 'slow down', 30000)
      })()
    },
  })
  mount(ctx, {})
  await withServer(routes, async (base) => {
    await createGroup(settingsRoutes, 'g', ['codebuddy_glm-5.2'])
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'g', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(res.status, 429)
    assert.equal(res.headers.get('retry-after'), '30')
  })
})

await test('a sub-second retry hint rounds up to one second, never to zero', async () => {
  const { ctx, routes, settingsRoutes } = makeCtx(textChunks, {
    streamFor: (options) => {
      if (options.provider !== 'codebuddy') return undefined
      return (async function* brief() {
        yield failureChunk('RATE_LIMIT', 'slow down', 250)
      })()
    },
  })
  mount(ctx, {})
  await withServer(routes, async (base) => {
    await createGroup(settingsRoutes, 'g', ['codebuddy_glm-5.2'])
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'g', messages: [{ role: 'user', content: 'hi' }] }),
    })
    // Rounding down to 0 would mean "retry immediately", defeating the hint.
    assert.equal(res.headers.get('retry-after'), '1')
  })
})

await test('no retry hint means no Retry-After header', async () => {
  const { ctx, routes, settingsRoutes } = makeCtx(textChunks, {
    streamFor: (options) => {
      if (options.provider !== 'codebuddy') return undefined
      return (async function* noHint() {
        yield failureChunk('RATE_LIMIT', 'slow down')
      })()
    },
  })
  mount(ctx, {})
  await withServer(routes, async (base) => {
    await createGroup(settingsRoutes, 'g', ['codebuddy_glm-5.2'])
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'g', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(res.status, 429)
    assert.equal(res.headers.get('retry-after'), null)
  })
})

await test('the retry hint reaches the failing group member, not just the first', async () => {
  const { ctx, routes, settingsRoutes } = makeCtx(textChunks, {
    streamFor: (options) => {
      // The FIRST candidate fails without a hint; the second supplies one. The
      // hint must come from the candidate that actually ended the call.
      if (options.provider === 'codebuddy') {
        return (async function* first() {
          yield failureChunk('RATE_LIMIT', 'first leg busy')
        })()
      }
      return (async function* second() {
        yield failureChunk('RATE_LIMIT', 'second leg busy', 12000)
      })()
    },
  })
  mount(ctx, {})
  await withServer(routes, async (base) => {
    await createGroup(settingsRoutes, 'g', ['codebuddy_glm-5.2', 'deepseek_deepseek-chat'])
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'g', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(res.status, 429)
    assert.equal(res.headers.get('retry-after'), '12')
  })
})

await test('the internal retry hint never leaks into the SSE error payload', async () => {
  const { ctx, routes, settingsRoutes } = makeCtx(textChunks, {
    streamFor: (options) => {
      if (options.provider !== 'codebuddy') return undefined
      return (async function* diesAfterOutput() {
        yield { type: 'text-delta', index: 0, text: 'partial' }
        yield failureChunk('RATE_LIMIT', 'slow down', 30000)
      })()
    },
  })
  mount(ctx, {})
  await withServer(routes, async (base) => {
    await createGroup(settingsRoutes, 'g', ['codebuddy_glm-5.2'])
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'g', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })
    const body = await res.text()
    // `providerRetryAfterMs` is our internal name; OpenAI clients must not see it.
    assert.equal(body.includes('providerRetryAfterMs'), false)
    assert.equal(body.includes('slow down'), true, 'the failure itself is still reported')
  })
})

/**
 * A wrong credential must not be reported as a gateway fault.
 *
 * `dsh-llm-deepseek` reports `AUTH` for HTTP 401 AND 403
 * (dsh-llm-deepseek:1513). Answering 502 would tell the caller the gateway
 * broke, when the truth is that the credential is wrong — and a caller acts on
 * those two differently.
 */
await test('an AUTH failure answers 401, not a generic 502', async () => {
  const { ctx, routes, settingsRoutes } = makeCtx(textChunks, {
    streamFor: (options) => {
      if (options.provider !== 'codebuddy') return undefined
      return (async function* unauthorized() {
        yield failureChunk('AUTH', 'invalid api key')
      })()
    },
  })
  mount(ctx, {})
  await withServer(routes, async (base) => {
    await createGroup(settingsRoutes, 'g', ['codebuddy_glm-5.2'])
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'g', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(res.status, 401)
  })
})

/**
 * A provider that reports its own HTTP status must be believed.
 *
 * `dsh-llm-deepseek` attaches `status: response.status` to every HTTP failure,
 * which is finer-grained than the code: `AUTH` covers 401 and 403 alike, and a
 * provider-specific status such as 402 has no code mapping at all.
 */
await test("the provider's own HTTP status wins over the code's family", async () => {
  const { ctx, routes, settingsRoutes } = makeCtx(textChunks, {
    streamFor: (options) => {
      if (options.provider !== 'codebuddy') return undefined
      return (async function* forbidden() {
        // Code says AUTH (401 family); the provider actually said 403.
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'forbidden', status: 403 } } }
      })()
    },
  })
  mount(ctx, {})
  await withServer(routes, async (base) => {
    await createGroup(settingsRoutes, 'g', ['codebuddy_glm-5.2'])
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'g', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(res.status, 403)
  })
})

await test('a rejection of the request itself answers 400, not 502', async () => {
  const { ctx, routes, settingsRoutes } = makeCtx(textChunks, {
    streamFor: (options) => {
      if (options.provider !== 'codebuddy') return undefined
      return (async function* badEffort() {
        yield failureChunk('UNSUPPORTED_REASONING_EFFORT', 'no such effort')
      })()
    },
  })
  mount(ctx, {})
  await withServer(routes, async (base) => {
    await createGroup(settingsRoutes, 'g', ['codebuddy_glm-5.2'])
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'g', messages: [{ role: 'user', content: 'hi' }] }),
    })
    // The caller asked for something the target cannot do; that is their bug to
    // fix, not an upstream outage.
    assert.equal(res.status, 400)
  })
})

// ---------------------------------------------------------------------------
// Group scheduling: ordering strategies and the rate-limit retry
// ---------------------------------------------------------------------------

/** Create a group with an explicit scheduling pair. */
async function createScheduledGroup(settingsRoutes, name, models, strategy, retry429) {
  return callSettings(settingsRoutes, 'createGroup', { name, models, strategy, retry429 })
}

await test('a group defaults to sequential with no retry, exactly as before', async () => {
  const { ctx, routes, settingsRoutes } = makeCtx(textChunks)
  mount(ctx, {})
  await withServer(routes, async () => {
    await createGroup(settingsRoutes, 'g', ['codebuddy_glm-5.2', 'deepseek_deepseek-chat'])
    const stored = (await callSettings(settingsRoutes, 'listGroups')).value.groups[0]
    assert.equal(stored.strategy, 'sequential')
    assert.equal(stored.retry429, 0)
  })
})

await test('an unusable scheduling value is stored as the default, not rejected', async () => {
  const { ctx, routes, settingsRoutes } = makeCtx(textChunks)
  mount(ctx, {})
  await withServer(routes, async () => {
    const created = await createScheduledGroup(settingsRoutes, 'g', ['codebuddy_glm-5.2'], 'nonsense', 99)
    assert.equal(created.ok, true, 'a scheduling preference must never cost the group')
    assert.equal(created.value.group.strategy, 'sequential')
    assert.equal(created.value.group.retry429, 3, 'clamped to the accepted maximum')
  })
})

await test('round-robin advances the starting candidate across requests', async () => {
  const { ctx, routes, settingsRoutes, streamCalls } = makeCtx(textChunks)
  mount(ctx, {})
  await withServer(routes, async (base) => {
    await createScheduledGroup(settingsRoutes, 'rr', ['codebuddy_glm-5.2', 'deepseek_deepseek-chat'], 'round-robin', 0)
    const heads = []
    for (let request = 0; request < 3; request += 1) {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'rr', messages: [{ role: 'user', content: 'hi' }] }),
      })
      assert.equal(res.status, 200)
      heads.push(streamCalls.at(-1).provider)
    }
    // Two candidates, so the head alternates rather than staying put.
    assert.deepEqual(heads, ['codebuddy', 'deepseek', 'codebuddy'])
  })
})

await test('random picks a candidate that is actually in the group', async () => {
  const { ctx, routes, settingsRoutes, streamCalls } = makeCtx(textChunks)
  mount(ctx, {})
  await withServer(routes, async (base) => {
    await createScheduledGroup(settingsRoutes, 'rnd', ['codebuddy_glm-5.2', 'deepseek_deepseek-chat'], 'random', 0)
    const seen = new Set()
    for (let request = 0; request < 12; request += 1) {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'rnd', messages: [{ role: 'user', content: 'hi' }] }),
      })
      assert.equal(res.status, 200)
      seen.add(streamCalls.at(-1).provider)
    }
    for (const provider of seen) assert.equal(['codebuddy', 'deepseek'].includes(provider), true)
  })
})

await test('a rotating group still fails over, so the permutation keeps its fallback', async () => {
  const { ctx, routes, settingsRoutes, streamCalls } = makeCtx(textChunks, {
    streamFor: (options) => {
      if (options.provider !== 'codebuddy') return undefined
      return (async function* failing() {
        throw Object.assign(new Error('unavailable'), { code: 'MISSING_CREDENTIAL' })
      })()
    },
  })
  mount(ctx, {})
  await withServer(routes, async (base) => {
    await createScheduledGroup(settingsRoutes, 'rr', ['codebuddy_glm-5.2', 'deepseek_deepseek-chat'], 'round-robin', 0)
    // Whatever the rotation puts first, the dead member must not end the call.
    for (let request = 0; request < 4; request += 1) {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'rr', messages: [{ role: 'user', content: 'hi' }] }),
      })
      assert.equal(res.status, 200, `request ${request} must fail over to the healthy member`)
      assert.equal(res.headers.get('x-relay-model'), 'deepseek_deepseek-chat')
    }
  })
})

await test('retry429 re-asks the SAME candidate before moving on', async () => {
  let codebuddyAttempts = 0
  const { ctx, routes, settingsRoutes, streamCalls } = makeCtx(textChunks, {
    streamFor: (options) => {
      if (options.provider !== 'codebuddy') return undefined
      codebuddyAttempts += 1
      // Rate limited once, then healthy: a retry is what recovers this.
      if (codebuddyAttempts === 1) {
        return (async function* limited() {
          yield failureChunk('RATE_LIMIT', 'slow down')
        })()
      }
      return undefined
    },
  })
  mount(ctx, {})
  await withServer(routes, async (base) => {
    await createScheduledGroup(settingsRoutes, 'g', ['codebuddy_glm-5.2', 'deepseek_deepseek-chat'], 'sequential', 1)
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'g', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(res.status, 200)
    assert.equal(codebuddyAttempts, 2, 'the rate-limited candidate is asked exactly twice')
    assert.equal(res.headers.get('x-relay-model'), 'codebuddy_glm-5.2', 'the retry kept the same candidate')
  })
})

await test('retry429 stops after the configured number of retries', async () => {
  let attempts = 0
  const { ctx, routes, settingsRoutes } = makeCtx(textChunks, {
    streamFor: (options) => {
      if (options.provider !== 'codebuddy') return undefined
      attempts += 1
      return (async function* alwaysLimited() {
        yield failureChunk('RATE_LIMIT', 'slow down')
      })()
    },
  })
  mount(ctx, {})
  await withServer(routes, async (base) => {
    await createScheduledGroup(settingsRoutes, 'g', ['codebuddy_glm-5.2', 'deepseek_deepseek-chat'], 'sequential', 2)
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'g', messages: [{ role: 'user', content: 'hi' }] }),
    })
    // 1 initial + 2 retries, then the next candidate serves it.
    assert.equal(attempts, 3)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('x-relay-model'), 'deepseek_deepseek-chat')
  })
})

await test('retry429 does NOT retry an exhausted quota, which also answers 429', async () => {
  let attempts = 0
  const { ctx, routes, settingsRoutes } = makeCtx(textChunks, {
    streamFor: (options) => {
      if (options.provider !== 'codebuddy') return undefined
      attempts += 1
      return (async function* outOfQuota() {
        // QUOTA maps to HTTP 429 through statusForCode, so judging by status
        // instead of by code would retry this pointlessly.
        yield failureChunk('QUOTA', 'out of quota')
      })()
    },
  })
  mount(ctx, {})
  await withServer(routes, async (base) => {
    await createScheduledGroup(settingsRoutes, 'g', ['codebuddy_glm-5.2', 'deepseek_deepseek-chat'], 'sequential', 3)
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'g', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(attempts, 1, 'an exhausted quota must not be retried')
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('x-relay-model'), 'deepseek_deepseek-chat')
  })
})

await test('a retry hint longer than the budget moves on instead of sleeping', async () => {
  let attempts = 0
  const { ctx, routes, settingsRoutes, warnings } = makeCtx(textChunks, {
    streamFor: (options) => {
      if (options.provider !== 'codebuddy') return undefined
      attempts += 1
      return (async function* longQuiet() {
        // 30s, far past the per-candidate budget.
        yield failureChunk('RATE_LIMIT', 'slow down', 30000)
      })()
    },
  })
  mount(ctx, {})
  await withServer(routes, async (base) => {
    await createScheduledGroup(settingsRoutes, 'g', ['codebuddy_glm-5.2', 'deepseek_deepseek-chat'], 'sequential', 2)
    const started = Date.now()
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'g', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(attempts, 1, 'a hint past the budget is not waited out')
    assert.equal(res.status, 200)
    // The point of the budget: the caller is not made to sit through 30s.
    assert.equal(Date.now() - started < 5000, true, 'the request must not wait out the hint')
    assert.equal(warnings.some((line) => typeof line === 'string' && line.includes('budget exceeded')), true)
  })
})

await test('a failure after output is committed is never retried', async () => {
  let attempts = 0
  const { ctx, routes, settingsRoutes } = makeCtx(textChunks, {
    streamFor: (options) => {
      if (options.provider !== 'codebuddy') return undefined
      attempts += 1
      return (async function* diesAfterOutput() {
        yield { type: 'text-delta', index: 0, text: 'partial' }
        yield failureChunk('RATE_LIMIT', 'slow down')
      })()
    },
  })
  mount(ctx, {})
  await withServer(routes, async (base) => {
    await createScheduledGroup(settingsRoutes, 'g', ['codebuddy_glm-5.2'], 'sequential', 3)
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'g', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })
    const body = await res.text()
    // Replaying already-forwarded content would duplicate it in the client.
    assert.equal(attempts, 1)
    assert.equal(body.includes('slow down'), true)
  })
})

await test('a group whose FIRST candidate cannot be resolved still fails over', async () => {
  const { ctx, routes, settingsRoutes } = makeCtx(textChunks)
  mount(ctx, {})
  await withServer(routes, async (base) => {
    // A candidate naming this gateway is refused by resolveLeg. Writing it
    // directly is the only way to reach this: the settings UI only offers ids
    // that resolve. The failure must not escape and fail the whole request.
    const created = await createScheduledGroup(
      settingsRoutes,
      'g',
      ['dsh-model-gateway_ghost', 'deepseek_deepseek-chat'],
      'sequential',
      0,
    )
    assert.equal(created.ok, true)
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'g', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(res.status, 200, 'the healthy second candidate must serve the request')
    assert.equal(res.headers.get('x-relay-model'), 'deepseek_deepseek-chat')
  })
})

await test('a group whose only candidate cannot be resolved reports that failure', async () => {
  const { ctx, routes, settingsRoutes } = makeCtx(textChunks)
  mount(ctx, {})
  await withServer(routes, async (base) => {
    await createScheduledGroup(settingsRoutes, 'g', ['dsh-model-gateway_ghost'], 'sequential', 0)
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'g', messages: [{ role: 'user', content: 'hi' }] }),
    })
    // Nothing was usable, so the real reason must surface rather than a 503.
    assert.notEqual(res.status, 200)
    assert.equal((await res.json()).error.code, 'group_self_reference')
  })
})

await test('scheduling survives the settings round trip and is clamped on update', async () => {
  const { ctx, routes, settingsRoutes } = makeCtx(textChunks)
  mount(ctx, {})
  await withServer(routes, async () => {
    await createScheduledGroup(settingsRoutes, 'g', ['codebuddy_glm-5.2'], 'sequential', 0)
    assert.equal((await callSettings(settingsRoutes, 'updateGroup', { id: 'g', strategy: 'round-robin', retry429: 2 })).ok, true)
    const stored = (await callSettings(settingsRoutes, 'listGroups')).value.groups[0]
    assert.equal(stored.strategy, 'round-robin')
    assert.equal(stored.retry429, 2)

    // An update that omits the fields must not reset them.
    assert.equal((await callSettings(settingsRoutes, 'updateGroup', { id: 'g', models: ['deepseek_deepseek-chat'] })).ok, true)
    const after = (await callSettings(settingsRoutes, 'listGroups')).value.groups[0]
    assert.equal(after.strategy, 'round-robin')
    assert.equal(after.retry429, 2)
  })
})


await test('a stored pair reopens on the preset that preserves it', async () => {
  // The mapping lives in the browser half, but the failure it guards against
  // is a data-loss one: opening a group and pressing confirm must not rewrite
  // its scheduling. Reproduced here against the same preset table the client
  // uses, because a client-only mistake is invisible to every other suite.
  const PRESETS = [
    { id: 'sequential', strategy: 'sequential', retry429: 0 },
    { id: 'balanced', strategy: 'round-robin', retry429: 0 },
    { id: 'random', strategy: 'random', retry429: 0 },
    { id: 'retry', strategy: 'sequential', retry429: 1 },
  ]
  const presetOf = (strategy, retry429) => {
    if ((retry429 ?? 0) > 0) return 'retry'
    return PRESETS.find((preset) => preset.strategy === strategy && preset.retry429 === 0)?.id ?? 'sequential'
  }
  // A document that omits retry429 entirely — the shape a hand-written or
  // older file has — must still land on its own strategy.
  assert.equal(presetOf('random', undefined), 'random')
  assert.equal(presetOf('round-robin', undefined), 'balanced')
  assert.equal(presetOf('sequential', undefined), 'sequential')
  assert.equal(presetOf('random', 0), 'random')
  assert.equal(presetOf('round-robin', 0), 'balanced')
  // Any retry count belongs to the one preset that carries one.
  assert.equal(presetOf('sequential', 1), 'retry')
  assert.equal(presetOf('sequential', 3), 'retry')
  // An unknown strategy still opens somewhere editable.
  assert.equal(presetOf('nonsense', 0), 'sequential')
})

/** The stats row for one candidate, or a readable failure. */
const statsRow = (listed, group, model) => {
  const row = listed.value.stats?.[group]?.candidates?.[model]
  assert.ok(row !== undefined, `no stats row for ${group}/${model}`)
  return row
}

await test('failover charges the refusal to the candidate that actually failed', async () => {
  const { ctx, routes, settingsRoutes } = makeCtx(textChunks, {
    streamFor: (options) => {
      if (options.provider !== 'codebuddy') return undefined
      return (async function* failing() {
        throw Object.assign(new Error('credential unavailable'), { code: 'MISSING_CREDENTIAL' })
      })()
    },
  })
  mount(ctx, {})
  await withServer(routes, async (base) => {
    await createGroup(settingsRoutes, 'g', ['codebuddy_glm-5.2', 'deepseek_deepseek-chat'])
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'g', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(res.status, 200)
    await res.text()

    const listed = await callSettings(settingsRoutes, 'listGroups')
    const failed = statsRow(listed, 'g', 'codebuddy_glm-5.2')
    const served = statsRow(listed, 'g', 'deepseek_deepseek-chat')
    // The blame must land on the candidate that broke, not on the one that
    // rescued the request — that inversion is the whole risk of a scoreboard.
    assert.equal(failed.refused, 1)
    assert.equal(failed.answered, 0)
    assert.equal(failed.lastCode, 'MISSING_CREDENTIAL')
    assert.equal(failed.ratio, 0)
    assert.equal(served.answered, 1)
    assert.equal(served.refused, 0)
    assert.equal(served.ratio, 1)
    assert.equal(listed.value.stats.g.requests, 1)
    assert.equal(listed.value.stats.g.allFailed, 0)
  })
})

await test('a group whose every candidate fails records an all-failed request', async () => {
  const { ctx, routes, settingsRoutes } = makeCtx(textChunks, {
    streamFor: () => (async function* failing() {
      throw Object.assign(new Error('nope'), { code: 'MISSING_CREDENTIAL', status: 502 })
    })(),
  })
  mount(ctx, {})
  await withServer(routes, async (base) => {
    await createGroup(settingsRoutes, 'g', ['codebuddy_glm-5.2', 'deepseek_deepseek-chat'])
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'g', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.notEqual(res.status, 200)
    await res.text()

    const listed = await callSettings(settingsRoutes, 'listGroups')
    assert.equal(listed.value.stats.g.requests, 1)
    assert.equal(listed.value.stats.g.allFailed, 1)
    assert.equal(statsRow(listed, 'g', 'codebuddy_glm-5.2').refused, 1)
    assert.equal(statsRow(listed, 'g', 'deepseek_deepseek-chat').refused, 1)
  })
})

await test('a retried rate limit is counted, and the answer still counts as one', async () => {
  // The counter lives outside `streamFor`: a retry calls it again, so a
  // per-call closure would restart the script and never reach the answer.
  let asks = 0
  const { ctx, routes, settingsRoutes } = makeCtx(textChunks, {
    streamFor: (options) => {
      if (options.provider !== 'codebuddy') return undefined
      return (async function* limited() {
        asks += 1
        if (asks === 1) {
          yield failureChunk('RATE_LIMIT', 'slow down')
          return
        }
        yield* textChunks
      })()
    },
  })
  mount(ctx, {})
  await withServer(routes, async (base) => {
    await createScheduledGroup(settingsRoutes, 'g', ['codebuddy_glm-5.2'], 'sequential', 2)
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'g', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(res.status, 200)
    await res.text()

    const row = statsRow(await callSettings(settingsRoutes, 'listGroups'), 'g', 'codebuddy_glm-5.2')
    // Two attempts, one answer: "needed two asks" must not read as two
    // successes, nor as a failure.
    assert.equal(row.attempts, 2)
    assert.equal(row.retry429, 1)
    assert.equal(row.answered, 1)
    assert.equal(row.refused, 1, 'the rate-limited attempt itself was a refusal')
  })
})

await test('a failure the candidate is not responsible for is excused', async () => {
  const { ctx, routes, settingsRoutes } = makeCtx(textChunks, {
    streamFor: () => (async function* tooBig() {
      throw Object.assign(new Error('too long'), { code: 'CONTEXT_WINDOW_EXCEEDED' })
    })(),
  })
  mount(ctx, {})
  await withServer(routes, async (base) => {
    await createGroup(settingsRoutes, 'g', ['codebuddy_glm-5.2'])
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'g', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.notEqual(res.status, 200)
    await res.text()

    const row = statsRow(await callSettings(settingsRoutes, 'listGroups'), 'g', 'codebuddy_glm-5.2')
    // An oversized request fails identically on every candidate, so it must
    // not be held against this one.
    assert.equal(row.ignored, 1)
    assert.equal(row.refused, 0)
    assert.equal(row.ratio, undefined, 'nothing that blames the candidate was counted')
  })
})

await test('a committed failure mid-stream counts as answered, on purpose', async () => {
  // This pins a known, accepted loss of detail rather than a bug. On `/v1` the
  // committed attempt is handed off as `resume(...)` and `openStream` cannot
  // see the later failure, so "answered" is the only question both paths can
  // answer identically. If this assertion ever fails, the statistics were made
  // more precise — update the docs in `lib/stats.js` rather than reverting it.
  const { ctx, routes, settingsRoutes } = makeCtx(textChunks, {
    streamFor: (options) => {
      if (options.provider !== 'codebuddy') return undefined
      return (async function* halfThenFail() {
        yield { type: 'block-start', index: 0 }
        yield { type: 'text-delta', text: 'partial' }
        throw Object.assign(new Error('died mid-stream'), { code: 'SERVER' })
      })()
    },
  })
  mount(ctx, {})
  await withServer(routes, async (base) => {
    await createGroup(settingsRoutes, 'g', ['codebuddy_glm-5.2'])
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'g', messages: [{ role: 'user', content: 'hi' }] }),
    })
    await res.text()

    const row = statsRow(await callSettings(settingsRoutes, 'listGroups'), 'g', 'codebuddy_glm-5.2')
    assert.equal(row.answered, 1, 'output had already been produced')
    assert.equal(row.refused, 0)
  })
})

await test('a direct model call is never scored', async () => {
  const { ctx, routes, settingsRoutes } = makeCtx(textChunks)
  mount(ctx, {})
  await withServer(routes, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'codebuddy_glm-5.2', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(res.status, 200)
    await res.text()

    // A direct call has no candidate list to compare against, so the scoreboard
    // must stay empty rather than growing an entry per model name.
    const listed = await callSettings(settingsRoutes, 'listGroups')
    assert.deepEqual(listed.value.stats, {})
  })
})

await test('renaming a group carries its scoreboard over', async () => {
  const { ctx, routes, settingsRoutes } = makeCtx(textChunks, {
    streamFor: (options) => {
      if (options.provider !== 'codebuddy') return undefined
      return (async function* failing() {
        throw Object.assign(new Error('nope'), { code: 'SERVER' })
      })()
    },
  })
  mount(ctx, {})
  await withServer(routes, async (base) => {
    await createGroup(settingsRoutes, 'g', ['codebuddy_glm-5.2', 'deepseek_deepseek-chat'])
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'g', messages: [{ role: 'user', content: 'hi' }] }),
    })
    await res.text()
    assert.equal((await callSettings(settingsRoutes, 'updateGroup', { id: 'g', name: 'renamed' })).ok, true)

    const listed = await callSettings(settingsRoutes, 'listGroups')
    assert.equal(listed.value.stats.g, undefined, 'the old name is gone')
    assert.equal(statsRow(listed, 'renamed', 'codebuddy_glm-5.2').refused, 1, 'the history survived')
  })
})

await test('dropping a candidate forgets its row, and removing a group forgets all of it', async () => {
  const { ctx, routes, settingsRoutes } = makeCtx(textChunks, {
    // The FIRST candidate fails so the second is actually reached: both then
    // have a row, which is what makes the drop-one-keep-the-other assertion
    // meaningful.
    streamFor: (options) => {
      if (options.provider !== 'codebuddy') return undefined
      return (async function* failing() {
        throw Object.assign(new Error('nope'), { code: 'SERVER' })
      })()
    },
  })
  mount(ctx, {})
  await withServer(routes, async (base) => {
    await createGroup(settingsRoutes, 'g', ['codebuddy_glm-5.2', 'deepseek_deepseek-chat'])
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'g', messages: [{ role: 'user', content: 'hi' }] }),
    })
    await res.text()
    assert.equal(statsRow(await callSettings(settingsRoutes, 'listGroups'), 'g', 'codebuddy_glm-5.2').refused, 1)

    await callSettings(settingsRoutes, 'updateGroup', { id: 'g', models: ['deepseek_deepseek-chat'] })
    const afterEdit = await callSettings(settingsRoutes, 'listGroups')
    assert.equal(afterEdit.value.stats.g.candidates['codebuddy_glm-5.2'], undefined, 'the removed candidate is forgotten')
    assert.equal(statsRow(afterEdit, 'g', 'deepseek_deepseek-chat').answered, 1, 'the kept candidate keeps its history')

    await callSettings(settingsRoutes, 'removeGroup', { id: 'g' })
    assert.equal((await callSettings(settingsRoutes, 'listGroups')).value.stats.g, undefined)
  })
})

await test('the scoreboard survives an edit that does not change the members', async () => {
  const { ctx, routes, settingsRoutes } = makeCtx(textChunks)
  mount(ctx, {})
  await withServer(routes, async (base) => {
    await createGroup(settingsRoutes, 'g', ['codebuddy_glm-5.2'])
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'g', messages: [{ role: 'user', content: 'hi' }] }),
    })
    await res.text()

    // Changing the scheduling says nothing about the members, so it must not
    // erase what the scoreboard knows about them.
    assert.equal((await callSettings(settingsRoutes, 'updateGroup', { id: 'g', strategy: 'round-robin', retry429: 1 })).ok, true)
    assert.equal(statsRow(await callSettings(settingsRoutes, 'listGroups'), 'g', 'codebuddy_glm-5.2').answered, 1)
  })
})

await test('a group whose every candidate is unresolvable still records the attempt', async () => {
  // A self-referencing member cannot resolve, so this is the one group shape
  // that never reaches the failover loop. The request still happened, and a
  // scoreboard that silently drops it is worse than one that shows zeroes.
  const { ctx, routes, settingsRoutes } = makeCtx(textChunks)
  mount(ctx, {})
  await withServer(routes, async (base) => {
    await createGroup(settingsRoutes, 'g', ['dsh-model-gateway_a', 'dsh-model-gateway_b'])
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'g', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.notEqual(res.status, 200)
    await res.text()

    const listed = await callSettings(settingsRoutes, 'listGroups')
    assert.equal(listed.value.stats.g?.requests, 1, 'the request must be counted')
    assert.equal(listed.value.stats.g?.allFailed, 1, 'and recorded as having served nobody')
    assert.equal(statsRow(listed, 'g', 'dsh-model-gateway_a').ignored, 1, 'a misconfigured member is excused, not blamed')
    assert.equal(statsRow(listed, 'g', 'dsh-model-gateway_b').ignored, 1)
  })
})

await test('a legacy slash candidate is keyed the way the group stores it', async () => {
  // The stored spelling and the resolved one differ for the legacy
  // `provider/model` form. The settings page looks candidates up from the
  // stored list, so keying by the resolved spelling would show nothing.
  const { ctx, routes, settingsRoutes } = makeCtx(textChunks)
  mount(ctx, {})
  await withServer(routes, async (base) => {
    await createGroup(settingsRoutes, 'g', ['codebuddy/glm-5.2'])
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'g', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(res.status, 200)
    await res.text()

    const listed = await callSettings(settingsRoutes, 'listGroups')
    const stored = listed.value.groups[0].models[0]
    assert.equal(stored, 'codebuddy/glm-5.2', 'the group still stores the legacy spelling')
    assert.ok(listed.value.stats.g.candidates[stored] !== undefined,
      'the row must be keyed by the stored spelling, or the page finds nothing')
  })
})

await test('an attempt is answered at most once', async () => {
  // The DSH-side loop scores an attempt at its first committing chunk and then
  // returns through a second scoring site. Without a guard the same answer is
  // counted twice, which shows up as more answers than attempts.
  const { ctx, routes, settingsRoutes } = makeCtx(textChunks)
  mount(ctx, {})
  await withServer(routes, async (base) => {
    await createGroup(settingsRoutes, 'g', ['codebuddy_glm-5.2'])
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'g', messages: [{ role: 'user', content: 'hi' }] }),
    })
    await res.text()

    const row = statsRow(await callSettings(settingsRoutes, 'listGroups'), 'g', 'codebuddy_glm-5.2')
    assert.equal(row.answered, 1)
    assert.ok(row.answered <= row.attempts, 'an answer cannot outnumber its attempts')
  })
})

console.log(failures === 0 ? '\nAll gateway translation tests passed.' : `\n${failures} test(s) failed.`)
process.exit(failures === 0 ? 0 : 1)