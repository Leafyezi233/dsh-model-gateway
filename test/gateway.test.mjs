/**
 * Protocol-translation test for dsh-model-relay.
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

/** Apply the plugin with an isolated key store unless the case overrides one. */
function mount(ctx, config = {}) {
  const { keysFile = nextKeysFile(), ...rest } = config
  apply(ctx, { keysFile, ...rest })
}

/** Build a fake Cordis context with a scripted llm service. */
function makeCtx(chunks, { onStream } = {}) {
  const routes = []
  const infos = []
  const warnings = []
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
      listProviders: () => [
        { id: 'codebuddy', name: 'CodeBuddy' },
        { id: 'deepseek', name: 'DeepSeek' },
      ],
      listModels: async (provider) => (provider === 'codebuddy'
        ? [{ provider, id: 'deepseek-v4.1-flash', name: 'Flash' }, { provider, id: 'glm-5.2', name: 'GLM' }]
        : [{ provider, id: 'deepseek-chat', name: 'Chat' }]),
      stream: (options) => {
        onStream?.(options)
        return (async function* generate() {
          for (const chunk of chunks) {
            if (typeof chunk === 'function') yield chunk(options)
            else yield chunk
          }
        })()
      },
    },
  }
  return { ctx, routes, infos, warnings, settingsRoutes, disposers }
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
  ctx.llm.listModels = async (provider) => [{ provider, id: 'deepseek-v4-flash', name: 'Flash' }]
  mount(ctx, {})
  await withServer(routes, async (base) => {
    const listed = await (await fetch(`${base}/v1/models`)).json()
    // Both providers are listed, each under its own namespace, with no duplicates.
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

console.log(failures === 0 ? '\nAll gateway translation tests passed.' : `\n${failures} test(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
