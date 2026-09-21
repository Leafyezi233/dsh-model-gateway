/**
 * dsh-model-relay — an OpenAI-compatible `/v1` gateway for DeepSeek Harness.
 *
 * The plugin mounts `GET /v1/models` and `POST /v1/chat/completions` on the
 * existing DSH Web server and answers every call through the `llm` service.
 * That indirection is the whole design: the gateway never reads, stores, or
 * refreshes a provider credential itself. It asks `ctx.llm` to route a call,
 * so whatever provider plugins are registered — typically
 * `@tnnevol/dsh-codebuddy` — serve the request with their own session,
 * token-refresh single-flight, account failover, and image serialization.
 *
 * Keeping one credential owner matters: CodeBuddy rotates refresh tokens. A
 * second independent session in this plugin would race that single-flight and
 * invalidate the Web UI's sign-in. Routing through `ctx.llm` makes that
 * impossible.
 *
 * @module dsh-model-relay
 */

import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import {
  ToolCallId,
  createMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import { GatewayKeyStore, defaultKeysFile } from './keys.js'

/** Cordis plugin name. */
export const name = 'dsh-model-relay'

/** The two services the gateway cannot work without. */
export const inject = ['llm', 'webServer']

/**
 * Settings-page endpoint, mounted under Connection's shared `/api` prefix.
 *
 * The path matters for reverse-proxy deployments. A fronting gateway (the fnOS
 * unified gateway, for one) only rewrites the request paths it knows belong to
 * the application: DSH's own `/api`, `/plugins`, and a few other prefixes. A
 * plugin-private channel such as `/model-relay` is not on that list, so the
 * browser's request never reaches DSH and the settings page dies with a 404.
 *
 * Mounting under `/api` reuses the one prefix every deployment already routes,
 * and keeps the existing Connection trust fence and browser authentication.
 */
const SETTINGS_ROUTE = '/api/model-relay'

/** Default mount point; every route lives under it. */
const DEFAULT_PATH = '/v1'

/**
 * Separator between the provider prefix and the model id in an exposed name.
 *
 * Provider model ids collide across providers: `deepseek-v4-flash` is served by
 * both `deepseek-official` and `codebuddy` in a stock composition. A bare id is
 * therefore ambiguous, so every exposed model is named `<provider>_<model>`
 * (e.g. `codebuddy_deepseek-v4-flash`).
 *
 * An underscore is used rather than a slash so the name stays a single opaque
 * token for clients: some OpenAI-compatible tools treat `/` as a path segment
 * or a namespace separator, and a slash would also collide with the legacy
 * `provider/model` spelling this gateway still accepts.
 */
const PROVIDER_SEPARATOR = '_'

/**
 * Build the exposed model id for one provider/model pair.
 * @param provider - provider route id.
 * @param model - provider-side model id.
 * @returns the namespaced id clients pass as `model`.
 */
function exposedModelId(provider, model) {
  return `${provider}${PROVIDER_SEPARATOR}${model}`
}

/**
 * Split an exposed model id back into its provider and model parts.
 *
 * The provider list is searched longest-first so a provider whose own id
 * contains the separator still wins over a shorter accidental prefix.
 * @param raw - the requested model id.
 * @param providers - every known provider route id.
 * @returns the split parts, or undefined when no provider prefixes the id.
 */
function splitExposedModelId(raw, providers) {
  const candidates = [...providers].sort((a, b) => b.length - a.length)
  for (const provider of candidates) {
    const prefix = `${provider}${PROVIDER_SEPARATOR}`
    if (raw.startsWith(prefix) && raw.length > prefix.length) {
      return { provider, model: raw.slice(prefix.length) }
    }
  }
  return undefined
}

/** Request-body ceiling. Generous enough for base64 images, bounded regardless. */
const MAX_BODY_BYTES = 32 * 1024 * 1024

/** How long a provider model listing is reused before re-reading the adapter. */
const CATALOG_TTL_MS = 30_000

/** Image media types the attachment service accepts. */
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/**
 * Validate and normalize the plugin config.
 *
 * Deliberately hand-rolled rather than expressed as a Schemastery schema: the
 * plugin then has no runtime dependency beyond its injected peers, which keeps
 * a `file:`-linked install self-contained.
 *
 * @param config - raw config object from the profile patch layer.
 * @returns normalized configuration.
 */
function resolveConfig(config = {}) {
  const path = config.path ?? DEFAULT_PATH
  if (typeof path !== 'string' || !path.startsWith('/') || path === '/' || path.endsWith('/')) {
    throw new Error('dsh-model-relay: path must be an absolute non-root pathname without a trailing slash')
  }
  const apiKeys = config.apiKeys ?? []
  if (!Array.isArray(apiKeys) || apiKeys.some((key) => typeof key !== 'string' || key.length === 0)) {
    throw new Error('dsh-model-relay: apiKeys must be an array of non-empty strings')
  }
  const providers = config.providers ?? []
  if (!Array.isArray(providers) || providers.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    throw new Error('dsh-model-relay: providers must be an array of non-empty provider ids')
  }
  if (config.defaultProvider !== undefined && typeof config.defaultProvider !== 'string') {
    throw new Error('dsh-model-relay: defaultProvider must be a string')
  }
  if (config.cors !== undefined && typeof config.cors !== 'boolean') {
    throw new Error('dsh-model-relay: cors must be a boolean')
  }
  if (config.keysFile !== undefined && (typeof config.keysFile !== 'string' || config.keysFile.length === 0)) {
    throw new Error('dsh-model-relay: keysFile must be a non-empty path string')
  }
  /**
   * Optional second listener for LAN clients.
   *
   * `false` (the default) keeps the gateway reachable only where the DSH Web
   * server itself is bound. A number binds an additional standalone HTTP
   * server on `0.0.0.0` at that port, serving the same `/v1` API without
   * exposing the Web UI, its session cookies, or any other DSH route.
   */
  let lanPort = false
  if (config.lanPort !== undefined && config.lanPort !== false) {
    // 0 is allowed and asks the OS for a free port, which avoids collisions
    // with whatever else the host already runs.
    if (!Number.isInteger(config.lanPort) || config.lanPort < 0 || config.lanPort > 65535) {
      throw new Error('dsh-model-relay: lanPort must be false or an integer from 0 through 65535')
    }
    lanPort = config.lanPort
  }
  if (config.lanHost !== undefined && typeof config.lanHost !== 'string') {
    throw new Error('dsh-model-relay: lanHost must be a string')
  }
  return {
    path,
    apiKeys,
    providers,
    defaultProvider: config.defaultProvider,
    cors: config.cors ?? true,
    keysFile: config.keysFile,
    lanPort,
    lanHost: config.lanHost ?? '0.0.0.0',
  }
}

/** An HTTP-shaped failure carrying the status the gateway should answer with. */
class GatewayError extends Error {
  constructor(status, message, type = 'invalid_request_error', code) {
    super(message)
    this.status = status
    this.type = type
    this.code = code
  }
}

/** Read one request body as bounded UTF-8 text. */
async function readBody(req) {
  const declared = req.headers['content-length']
  if (declared !== undefined && Number(declared) > MAX_BODY_BYTES) {
    req.resume()
    throw new GatewayError(413, 'request body is too large', 'invalid_request_error', 'payload_too_large')
  }
  const chunks = []
  let size = 0
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      req.resume()
      throw new GatewayError(413, 'request body is too large', 'invalid_request_error', 'payload_too_large')
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/** Read and parse a JSON request body. */
async function readJson(req) {
  const text = await readBody(req)
  if (text.trim() === '') return {}
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    throw new GatewayError(400, `request body is not valid JSON: ${cause.message}`, 'invalid_request_error', 'invalid_json')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GatewayError(400, 'request body must be a JSON object', 'invalid_request_error', 'invalid_json')
  }
  return parsed
}

/** Write one JSON response. */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('content-length', Buffer.byteLength(body))
  res.end(body)
}

/** Write one OpenAI-shaped error envelope. */
function sendError(res, status, message, type = 'invalid_request_error', code) {
  sendJson(res, status, { error: { message, type, code: code ?? null, param: null } })
}

/** Apply permissive CORS headers so browser-based clients work. */
function applyCors(res) {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
  res.setHeader('access-control-allow-headers', 'authorization, content-type, x-api-key, openai-organization, openai-project')
  res.setHeader('access-control-max-age', '86400')
}

/** Compare a presented key against the config-supplied key list. */
function matchesStaticKey(presented, configured) {
  if (presented === undefined) return false
  const a = Buffer.from(presented)
  let ok = false
  for (const key of configured) {
    const b = Buffer.from(key)
    if (a.length !== b.length) continue
    let diff = 0
    for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i]
    if (diff === 0) ok = true
  }
  return ok
}

/** Extract a bearer token from either accepted header. */
function presentedKey(req) {
  const header = req.headers['authorization']
  if (typeof header === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (match !== null) return match[1]
  }
  const apiKey = req.headers['x-api-key']
  if (typeof apiKey === 'string' && apiKey.length > 0) return apiKey
  return undefined
}

/** Map a DSH provider-neutral failure code to an HTTP status. */
function statusForCode(code) {
  switch (code) {
    case 'MISSING_CREDENTIAL':
    case 'INVALID_CREDENTIAL':
      return 401
    case 'QUOTA_EXCEEDED':
    case 'QUOTA':
    case 'RATE_LIMIT':
      return 429
    case 'UNSUPPORTED_CONTENT':
    case 'UNSUPPORTED_OPTION':
    case 'INVALID_REQUEST':
    case 'INVALID_PREPARED_CALL':
    case 'CONTEXT_WINDOW_EXCEEDED':
      return 400
    case 'ABORTED':
      return 499
    default:
      return 502
  }
}

/** Map a DSH failure to an HTTP status, preferring the provider's own status. */
function statusForError(error) {
  if (error instanceof GatewayError) return error.status
  if (Number.isInteger(error?.status)) return error.status
  return statusForCode(error?.code)
}

/** Collapse an unknown thrown value into a message. */
function errorMessage(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Parse a `data:` URL into bytes and a declared media type.
 * @param url - the full data URL.
 * @returns bytes and media type, or undefined when it is not a decodable image data URL.
 */
function parseDataUrl(url) {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url)
  if (match === null) return undefined
  const mediaType = match[1].toLowerCase()
  const isBase64 = match[2] !== undefined
  const payload = match[3]
  const data = isBase64
    ? Buffer.from(payload, 'base64')
    : Buffer.from(decodeURIComponent(payload), 'utf8')
  return { data, mediaType }
}

/**
 * Turn one OpenAI `image_url` part into a durable DSH image attachment.
 *
 * Remote URLs are fetched here because the provider adapters read images from
 * the attachment store, not from the wire. A fetched response must declare an
 * accepted media type; the attachment service re-validates the decoded bytes.
 *
 * @param part - the OpenAI content part.
 * @param attachments - the attachment service, when present.
 * @returns an image content block.
 */
async function imageBlockFromPart(part, attachments, signal) {
  if (attachments === undefined) {
    throw new GatewayError(400, 'image input requires the DSH attachment service, which is not mounted', 'invalid_request_error', 'unsupported_content')
  }
  const url = typeof part.image_url?.url === 'string' ? part.image_url.url : undefined
  if (url === undefined || url.length === 0) {
    throw new GatewayError(400, 'image_url part is missing image_url.url', 'invalid_request_error', 'invalid_image')
  }
  let data
  let mediaType
  if (url.startsWith('data:')) {
    const parsed = parseDataUrl(url)
    if (parsed === undefined) {
      throw new GatewayError(400, 'image_url data URL could not be decoded', 'invalid_request_error', 'invalid_image')
    }
    data = parsed.data
    mediaType = parsed.mediaType
  } else {
    let response
    try {
      response = await fetch(url, signal === undefined ? {} : { signal })
    } catch (cause) {
      throw new GatewayError(400, `could not fetch image_url: ${errorMessage(cause)}`, 'invalid_request_error', 'invalid_image')
    }
    if (!response.ok) {
      throw new GatewayError(400, `could not fetch image_url (HTTP ${response.status})`, 'invalid_request_error', 'invalid_image')
    }
    mediaType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    data = new Uint8Array(await response.arrayBuffer())
  }
  if (!IMAGE_MEDIA_TYPES.has(mediaType)) {
    throw new GatewayError(400, `unsupported image media type "${mediaType}"; expected one of ${[...IMAGE_MEDIA_TYPES].join(', ')}`, 'invalid_request_error', 'invalid_image')
  }
  const ref = await attachments.saveImage({ data, mediaType })
  return { type: 'image', attachment: ref }
}

/**
 * Translate one OpenAI message into zero or more DSH messages.
 *
 * OpenAI's `tool` role becomes a DSH tool-result message on the user role; an
 * assistant turn carrying `tool_calls` becomes tool-call blocks.
 *
 * A `system` (or `developer`) message yields NO message here. DSH models the
 * system prompt as `GenerateOptions.system` — a request-level string that
 * adapters map to the provider's own system slot — not as a member of the
 * `messages` array. Returning one would mean fabricating a `Message` whose
 * `source.kind` has no system value in the message-source union, and the
 * adapter would then have to be trusted to re-split it out of the history.
 * The caller collects these into `options.system` instead; see
 * {@link buildOptions}.
 *
 * (The provider adapter does also tolerate a `system`-role message arriving in
 * the array, so this is not the only implementation that would run — it is the
 * one that matches the request shape DSH actually documents and the one
 * `dsh-agent-loop` itself produces.)
 *
 * @param message - the OpenAI message.
 * @param attachments - optional attachment service for image parts.
 * @returns `{ messages, system }` — the messages this input contributed, plus
 *   any system-prompt text it carried.
 */
async function toDshMessages(message, attachments, signal) {
  const role = message?.role
  if (role === 'system' || role === 'developer') {
    const text = typeof message.content === 'string' ? message.content : flattenTextParts(message.content)
    return { messages: [], system: text }
  }
  if (role === 'tool') {
    const callId = ToolCallId(String(message.tool_call_id ?? ''))
    const text = typeof message.content === 'string' ? message.content : flattenTextParts(message.content)
    return {
      messages: [createToolResultMessage({
        callId,
        content: [{ type: 'text', text: text === '' ? '(no output)' : text }],
        isError: false,
      })],
    }
  }
  if (role === 'assistant') {
    const content = []
    if (typeof message.reasoning_content === 'string' && message.reasoning_content.length > 0) {
      content.push({ type: 'reasoning', text: message.reasoning_content })
    }
    if (typeof message.content === 'string') {
      if (message.content.length > 0) content.push({ type: 'text', text: message.content })
    } else if (Array.isArray(message.content)) {
      content.push(...await partsToBlocks(message.content, attachments, signal))
    }
    for (const call of message.tool_calls ?? []) {
      const fn = call?.function ?? {}
      content.push({
        type: 'tool-call',
        id: ToolCallId(String(call?.id ?? '')),
        name: String(fn.name ?? ''),
        arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
      })
    }
    if (content.length === 0) content.push({ type: 'text', text: '' })
    return {
      messages: [createMessage({
        role: 'assistant',
        content,
        source: { kind: 'model', provider: 'dsh-model-relay', model: String(message.model ?? 'unknown') },
      })],
    }
  }
  // Default: user.
  const content = []
  if (typeof message.content === 'string') {
    if (message.content.length > 0) content.push({ type: 'text', text: message.content })
  } else if (Array.isArray(message.content)) {
    content.push(...await partsToBlocks(message.content, attachments, signal))
  }
  if (content.length === 0) content.push({ type: 'text', text: '' })
  return { messages: [createUserMessage({ content, source: { kind: 'user' } })] }
}

/** Flatten OpenAI text parts to a plain string. */
function flattenTextParts(parts) {
  if (!Array.isArray(parts)) return ''
  return parts
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
}

/** Translate an ordered OpenAI content-part list into DSH content blocks. */
async function partsToBlocks(parts, attachments, signal) {
  const blocks = []
  for (const part of parts) {
    if (part?.type === 'text' && typeof part.text === 'string') {
      if (part.text.length > 0) blocks.push({ type: 'text', text: part.text })
      continue
    }
    if (part?.type === 'image_url') {
      blocks.push(await imageBlockFromPart(part, attachments, signal))
      continue
    }
  }
  return blocks
}

/** Translate OpenAI tool declarations into DSH tool schemas. */
function toToolSchemas(tools) {
  if (!Array.isArray(tools)) return undefined
  const schemas = []
  for (const tool of tools) {
    const fn = tool?.function ?? tool
    if (typeof fn?.name !== 'string' || fn.name.length === 0) continue
    schemas.push({
      name: fn.name,
      description: typeof fn.description === 'string' ? fn.description : '',
      parameters: fn.parameters ?? { type: 'object', properties: {} },
    })
  }
  return schemas.length > 0 ? schemas : undefined
}

/** Normalize the OpenAI `stop` field, which may be a string or a list. */
function toStopSequences(stop) {
  if (typeof stop === 'string') return stop.length > 0 ? [stop] : undefined
  if (Array.isArray(stop) && stop.every((entry) => typeof entry === 'string')) {
    return stop.length > 0 ? stop : undefined
  }
  return undefined
}

/** Map a DSH finish reason to the OpenAI vocabulary. */
function toOpenAiFinishReason(reason) {
  switch (reason?.kind) {
    case 'tool-calls':
      return 'tool_calls'
    case 'max-tokens':
      return 'length'
    default:
      return 'stop'
  }
}

/** Map DSH token usage to the OpenAI usage object. */
function toOpenAiUsage(usage, model) {
  if (usage === undefined) return undefined
  const prompt = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  const completion = usage.outputTokens ?? 0
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: usage.totalTokens ?? prompt + completion,
    ...(usage.cacheReadTokens === undefined
      ? {}
      : { prompt_tokens_details: { cached_tokens: usage.cacheReadTokens } }),
    ...(usage.reasoningTokens === undefined
      ? {}
      : { completion_tokens_details: { reasoning_tokens: usage.reasoningTokens } }),
    model,
  }
}

/** Build the OpenAI error payload for a DSH failure chunk. */
function chunkFailure(error) {
  const failure = error?.failure ?? {}
  const status = statusForCode(failure.code)
  return {
    message: failure.message ?? 'the provider stream failed',
    type: 'upstream_error',
    code: failure.code ?? 'UPSTREAM_ERROR',
    status,
  }
}

/**
 * Mount the gateway.
 * @param ctx - Cordis context carrying the `llm` and `webServer` services.
 * @param config - optional plugin configuration.
 */
export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config)
  const base = resolved.path
  const completionsPath = `${base}/chat/completions`
  const modelsPath = `${base}/models`
  const keysFile = resolved.keysFile ?? defaultKeysFile()

  /** Keys minted from the settings page. */
  const keyStore = new GatewayKeyStore({ file: keysFile, logger: ctx.logger })

  /** Short-lived model catalog shared by both routes. */
  let catalog = { readAt: 0, models: [] }

  /**
   * Whether requests must present a key.
   *
   * The store's explicit lock is honoured rather than inferring from the key
   * count, so revoking the last key cannot silently reopen the endpoint.
   */
  const authRequired = async () => resolved.apiKeys.length > 0 || await keyStore.isLocked()

  /** Accept a key that matches either the config list or the persistent store. */
  const authorize = async (presented) => {
    if (matchesStaticKey(presented, resolved.apiKeys)) return true
    return keyStore.verify(presented)
  }

  /** List provider/models the gateway is willing to expose. */
  const listCatalog = async (signal) => {
    if (Date.now() - catalog.readAt < CATALOG_TTL_MS && catalog.models.length > 0) return catalog.models
    const providers = ctx.llm
      .listProviders()
      .map((provider) => provider.id)
      .filter((id) => resolved.providers.length === 0 || resolved.providers.includes(id))
    const models = []
    for (const provider of providers) {
      let entries = []
      try {
        entries = await ctx.llm.listModels(provider)
      } catch (error) {
        ctx.logger.warn(`dsh-model-relay: could not list models for provider "${provider}"`)
        ctx.logger.warn(error)
        continue
      }
      for (const entry of entries) {
        models.push({
          /**
           * The provider-side id, which is what a request must ultimately name.
           * Kept separate from {@link id} so routing never has to re-parse the
           * exposed name.
           */
          rawId: entry.id,
          /** Namespaced id the client sees and sends back. */
          id: exposedModelId(provider, entry.id),
          provider,
          name: entry.name ?? entry.id,
          description: entry.description,
          modalities: entry.inputModalities,
        })
      }
    }
    if (models.length > 0) catalog = { readAt: Date.now(), models }
    return catalog.models
  }

  /**
   * Resolve the provider route for a requested model id.
   *
   * Accepted spellings, in precedence order:
   *  1. `<provider>_<model>` — the canonical exposed form, and the only one
   *     that is unambiguous when two providers serve the same model id.
   *  2. `<provider>/<model>` — the legacy spelling, still accepted.
   *  3. a bare `<model>` — resolved through `defaultProvider`, then a unique
   *     catalog match, then the sole registered provider.
   *
   * A bare id that several providers serve is refused rather than guessed: the
   * whole point of namespacing is that the caller says which one it meant.
   * @param requested - the `model` field from the request body.
   * @param signal - caller cancellation for the catalog read.
   * @returns the resolved provider and provider-side model id.
   */
  const resolveRoute = async (requested, signal) => {
    const raw = String(requested ?? '')
    if (raw === '') throw new GatewayError(400, 'you must provide a model parameter', 'invalid_request_error', 'missing_model')
    const knownProviders = ctx.llm.listProviders().map((entry) => entry.id)

    // 1. Canonical `<provider>_<model>`.
    const namespaced = splitExposedModelId(raw, knownProviders)
    if (namespaced !== undefined) return { ...namespaced, exposed: raw }

    // 2. Legacy `<provider>/<model>`.
    const slash = raw.indexOf('/')
    if (slash > 0) {
      const provider = raw.slice(0, slash)
      const model = raw.slice(slash + 1)
      if (knownProviders.includes(provider) && model.length > 0) {
        return { provider, model, exposed: exposedModelId(provider, model) }
      }
    }

    // 3. A bare model id.
    const models = await listCatalog(signal)
    if (resolved.defaultProvider !== undefined) {
      const hit = models.find((entry) => entry.provider === resolved.defaultProvider && entry.rawId === raw)
      if (hit !== undefined) return { provider: hit.provider, model: hit.rawId, exposed: hit.id }
      // An unlisted id is still legitimate: the catalog is advisory.
      if (resolved.providers.length === 0 || resolved.providers.includes(resolved.defaultProvider)) {
        return { provider: resolved.defaultProvider, model: raw, exposed: exposedModelId(resolved.defaultProvider, raw) }
      }
    }
    const matches = models.filter((entry) => entry.rawId === raw)
    if (matches.length === 1) return { provider: matches[0].provider, model: matches[0].rawId, exposed: matches[0].id }
    if (matches.length > 1) {
      const options = matches.map((entry) => entry.id).join(', ')
      throw new GatewayError(
        400,
        `model "${raw}" is served by several providers; use a namespaced id such as ${options}`,
        'invalid_request_error',
        'ambiguous_model',
      )
    }
    if (knownProviders.length === 1) {
      return { provider: knownProviders[0], model: raw, exposed: exposedModelId(knownProviders[0], raw) }
    }
    throw new GatewayError(404, `the model \`${raw}\` does not exist or you do not have access to it`, 'invalid_request_error', 'model_not_found')
  }

  /** Build the DSH generation request from an OpenAI chat-completions body. */
  const buildOptions = async (body, signal) => {
    const route = await resolveRoute(body.model, signal)
    const rawMessages = Array.isArray(body.messages) ? body.messages : []
    if (rawMessages.length === 0) {
      throw new GatewayError(400, "'messages' must be a non-empty array", 'invalid_request_error', 'invalid_messages')
    }
    const attachments = ctx.get('attachments')
    const messages = []
    /**
     * System-prompt text gathered from `system`/`developer` messages.
     *
     * DSH carries the system prompt as a request-level `options.system`
     * string, so these never enter the message list. Several system messages
     * are joined in encounter order, which is also what OpenAI's own
     * semantics imply: the system instruction is a single prefix, not a
     * turn in the conversation.
     */
    const systemParts = []
    for (const message of rawMessages) {
      const translated = await toDshMessages(message, attachments, signal)
      messages.push(...translated.messages)
      if (translated.system !== undefined && translated.system !== '') systemParts.push(translated.system)
    }
    const system = systemParts.length === 0 ? undefined : systemParts.join('\n\n')
    const maxTokens = body.max_tokens ?? body.max_completion_tokens
    return {
      route,
      options: {
        provider: route.provider,
        model: route.model,
        messages,
        ...(system === undefined ? {} : { system }),
        ...(toToolSchemas(body.tools) === undefined ? {} : { tools: toToolSchemas(body.tools) }),
        ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
        ...(typeof maxTokens === 'number' ? { maxTokens } : {}),
        ...(toStopSequences(body.stop) === undefined ? {} : { stop: toStopSequences(body.stop) }),
        ...(body.reasoning_effort === undefined ? {} : { reasoningEffort: body.reasoning_effort }),
        ...(signal === undefined ? {} : { signal }),
      },
    }
  }

  /** Handle `GET <base>/models`. */
  const handleModels = async (req, res, signal) => {
    const models = await listCatalog(signal)
    const data = []
    const seen = new Set()
    for (const entry of models) {
      if (seen.has(entry.id)) continue
      seen.add(entry.id)
      data.push({
        id: entry.id,
        object: 'model',
        created: Math.floor(catalog.readAt / 1000),
        owned_by: entry.provider,
      })
    }
    sendJson(res, 200, { object: 'list', data })
  }

  /** Handle `POST <base>/chat/completions`, streaming or buffered. */
  const handleCompletions = async (req, res, signal) => {
    const body = await readJson(req)
    const { route, options } = await buildOptions(body, signal)
    const stream = body.stream === true
    const id = `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`
    const created = Math.floor(Date.now() / 1000)

    const iterator = ctx.llm.stream(options)[Symbol.asyncIterator]()

    // Pull the first chunk before committing to a status, so an immediate
    // credential or routing failure still answers with a real HTTP error.
    let first
    try {
      first = await iterator.next()
    } catch (error) {
      sendError(res, statusForError(error), errorMessage(error), 'upstream_error', error?.code)
      return
    }

    if (!stream) {
      const accumulated = await accumulate(iterator, first, route.exposed)
      if (accumulated.error !== undefined) {
        sendError(res, accumulated.error.status, accumulated.error.message, 'upstream_error', accumulated.error.code)
        return
      }
      const message = { role: 'assistant', content: accumulated.text === '' ? null : accumulated.text }
      if (accumulated.reasoning !== '') message.reasoning_content = accumulated.reasoning
      if (accumulated.toolCalls.length > 0) {
        message.tool_calls = accumulated.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        }))
      }
      sendJson(res, 200, {
        id,
        object: 'chat.completion',
        created,
        model: route.exposed,
        choices: [{ index: 0, message, finish_reason: accumulated.finishReason, logprobs: null }],
        ...(accumulated.usage === undefined ? {} : { usage: accumulated.usage }),
      })
      return
    }

    // Streaming: headers now, then translate each chunk to an SSE delta.
    res.statusCode = 200
    res.setHeader('content-type', 'text/event-stream; charset=utf-8')
    res.setHeader('cache-control', 'no-cache, no-transform')
    res.setHeader('connection', 'keep-alive')
    res.setHeader('x-accel-buffering', 'no')
    if (typeof res.flushHeaders === 'function') res.flushHeaders()

    const write = (payload) => {
      if (res.writableEnded) return
      res.write(`data: ${JSON.stringify(payload)}\n\n`)
    }
    const envelope = (delta, finishReason, extra) => ({
      id,
      object: 'chat.completion.chunk',
      created,
      model: route.exposed,
      choices: [{ index: 0, delta, finish_reason: finishReason ?? null, logprobs: null, ...extra }],
    })

    let toolOrdinal = new Map()
    let nextToolIndex = 0
    let usage
    let finishReason = 'stop'
    let failed

    const consume = async (chunk) => {
      switch (chunk.type) {
        case 'text-delta':
          write(envelope({ content: chunk.text }, null))
          break
        case 'reasoning-delta':
          write(envelope({ reasoning_content: chunk.text }, null))
          break
        case 'tool-call-delta': {
          if (!toolOrdinal.has(chunk.index)) toolOrdinal.set(chunk.index, nextToolIndex++)
          const ordinal = toolOrdinal.get(chunk.index)
          write(envelope({
            tool_calls: [{
              index: ordinal,
              ...(chunk.id === undefined || chunk.id === '' ? {} : { id: chunk.id }),
              type: 'function',
              function: {
                ...(chunk.name === undefined ? {} : { name: chunk.name }),
                arguments: chunk.argumentsDelta,
              },
            }],
          }, null))
          break
        }
        case 'usage':
          usage = toOpenAiUsage(chunk.usage, route.exposed)
          break
        case 'finish':
          finishReason = toOpenAiFinishReason(chunk.reason)
          if (chunk.reason?.kind === 'error') failed = chunkFailure(chunk.reason)
          if (chunk.reason?.kind === 'aborted') failed = chunkFailure(chunk.reason)
          break
        default:
          break
      }
    }

    try {
      for (;;) {
        if (first.done === true) break
        await consume(first.value)
        first = await iterator.next()
      }
      write(envelope({}, finishReason))
      if (usage !== undefined) write({ id, object: 'chat.completion.chunk', created, model: route.exposed, choices: [], usage })
      if (failed !== undefined) write({ error: failed })
      if (!res.writableEnded) res.write('data: [DONE]\n\n')
    } catch (error) {
      // Headers are already sent; surface the failure as a terminal SSE error.
      write({ error: { message: errorMessage(error), type: 'upstream_error', code: error?.code ?? 'UPSTREAM_ERROR' } })
      if (!res.writableEnded) res.write('data: [DONE]\n\n')
    } finally {
      if (!res.writableEnded) res.end()
    }
  }

  /**
   * The one request handler both listeners share.
   *
   * The DSH Web route and the optional LAN listener differ only in where they
   * accept connections, so they must not drift in behavior: authentication,
   * routing, error mapping, and CORS all live here once.
   */
  const serveApi = async (req, res) => {
    const controller = new AbortController()
    /**
     * Abort upstream work when the client goes away.
     *
     * This must listen on the RESPONSE, not the request: Node emits `close`
     * on an IncomingMessage as soon as its body has been fully read, which is
     * long before generation finishes, so aborting there would cancel every
     * request. The response `close` fires on a real client disconnect (and
     * after a normal `end()`, where the guard below makes it a no-op).
     */
    res.on('close', () => {
      if (!res.writableEnded) controller.abort()
    })
    if (resolved.cors) applyCors(res)
    try {
      const pathname = new URL(String(req.url), 'http://localhost').pathname
      if (req.method === 'OPTIONS') {
        res.statusCode = 204
        res.end()
        return
      }
      if (await authRequired() && !await authorize(presentedKey(req))) {
        sendError(res, 401, 'missing or invalid API key', 'invalid_request_error', 'invalid_api_key')
        return
      }
      if (pathname === modelsPath) {
        if (req.method !== 'GET') {
          res.setHeader('allow', 'GET, OPTIONS')
          sendError(res, 405, 'method not allowed', 'invalid_request_error', 'method_not_allowed')
          return
        }
        await handleModels(req, res, controller.signal)
        return
      }
      if (pathname === completionsPath) {
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST, OPTIONS')
          sendError(res, 405, 'method not allowed', 'invalid_request_error', 'method_not_allowed')
          return
        }
        await handleCompletions(req, res, controller.signal)
        return
      }
      sendError(res, 404, `unknown route ${pathname}; this gateway serves GET ${modelsPath} and POST ${completionsPath}`, 'invalid_request_error', 'unknown_route')
    } catch (error) {
      if (res.headersSent) {
        if (!res.writableEnded) res.end()
        return
      }
      if (error instanceof GatewayError) {
        sendError(res, error.status, error.message, error.type, error.code)
        return
      }
      ctx.logger.warn('dsh-model-relay: request failed')
      ctx.logger.warn(error)
      sendError(res, statusForError(error), errorMessage(error), 'upstream_error', error?.code)
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: base,
    handler: serveApi,
  }), `dsh-model-relay: ${base}`)

  /**
   * Live state of the optional LAN listener.
   *
   * `port` is resolved from the socket after binding, because `lanPort: 0`
   * asks the OS for a free port and the configured value is then not the real
   * one. `listening` lets the settings page distinguish "configured" from
   * "actually accepting connections".
   */
  const lanState = { configured: resolved.lanPort !== false, port: resolved.lanPort, host: resolved.lanHost, listening: false, error: undefined }

  /**
   * Optional standalone LAN listener.
   *
   * A second `node:http` server on its own port, serving only the gateway's own
   * routes. It deliberately does NOT proxy the DSH Web UI: binding the Web
   * server to all interfaces would also expose the session-cookie login, the
   * settings API, and every other DSH route to the network. This listener has
   * no access to any of that — an unknown path here is a 404.
   */
  if (resolved.lanPort !== false) {
    ctx.effect(() => {
      const server = createServer((req, res) => {
        serveApi(req, res).catch((error) => {
          ctx.logger.warn('dsh-model-relay: LAN request failed')
          ctx.logger.warn(error)
          if (!res.headersSent) sendError(res, 500, 'internal error', 'upstream_error', 'INTERNAL')
          else if (!res.writableEnded) res.end()
        })
      })
      // Long-lived SSE responses must not be cut short by a socket timeout.
      server.requestTimeout = 0
      server.headersTimeout = 60_000
      server.on('clientError', (error, socket) => {
        if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
        ctx.logger.warn(`dsh-model-relay: LAN client error: ${error.message}`)
      })
      server.on('error', (error) => {
        lanState.listening = false
        lanState.error = error.message
        ctx.logger.warn(`dsh-model-relay: LAN listener on ${resolved.lanHost}:${resolved.lanPort} failed: ${error.message}`)
      })
      server.listen(resolved.lanPort, resolved.lanHost, () => {
        const address = server.address()
        if (address !== null && typeof address === 'object') lanState.port = address.port
        lanState.listening = true
        lanState.error = undefined
        ctx.logger.info(`dsh-model-relay: LAN listener on http://${resolved.lanHost}:${lanState.port}${base}`)
        // Warn when the new listener is reachable by the whole network with no
        // key required, which is the one way this feature is unsafe.
        authRequired().then((required) => {
          if (!required) {
            ctx.logger.warn('dsh-model-relay: the LAN listener accepts every device on this network because no API key is configured; create one in Settings -> Model Relay')
          }
        }).catch(() => {})
      })
      return () => {
        server.close()
      }
    }, 'dsh-model-relay: LAN listener')
  }

  ctx.logger.info(`dsh-model-relay: serving OpenAI-compatible API at ${base} (GET ${modelsPath}, POST ${completionsPath})${resolved.apiKeys.length > 0 ? ' with API-key auth' : ' without API-key auth'}`)

  /**
   * Settings-page RPC channel.
   *
   * The channel rides the existing Connection service, so every call is already
   * authenticated by the browser-token carrier that guards the rest of the Web
   * UI: key management is reachable only from a signed-in DSH page, and never
   * from the `/v1` route itself.
   */
  const dispatch = async (action, payload) => {
    switch (action) {
      case 'status': {
        return ok({
          path: base,
          modelsPath,
          completionsPath,
          keysFile,
          /**
           * The port the harness actually listens on.
           *
           * The model API is meant to be called directly on this port rather
           * than through a fronting reverse proxy: the proxy rewrites paths and
           * terminates the streaming responses this endpoint depends on, and a
           * port-based call avoids all of that.
           */
          port: ctx.webServer.port,
          bindHost: ctx.webServer.host,
          /** LAN listener facts, or null when the optional listener is off. */
          lan: lanState.configured
            ? {
                port: lanState.port,
                host: lanState.host,
                listening: lanState.listening,
                ...(lanState.error === undefined ? {} : { error: lanState.error }),
                ...lanAddresses(),
              }
            : null,
          authRequired: await authRequired(),
          staticKeyCount: resolved.apiKeys.length,
          keys: await keyStore.list(),
          providers: ctx.llm.listProviders().map((provider) => provider.id),
          models: (await listCatalog()).map((entry) => ({ id: entry.id, rawId: entry.rawId, provider: entry.provider, name: entry.name })),
        })
      }
      case 'createKey': {
        const label = typeof payload === 'object' && payload !== null && typeof payload.label === 'string'
          ? payload.label
          : undefined
        const created = await keyStore.create(label)
        ctx.logger.info(`dsh-model-relay: created API key ${created.record.masked}`)
        // The plaintext rides this response only; it is never stored or listed again.
        return ok({ ...created.record, key: created.key })
      }
      case 'revokeKey': {
        const id = typeof payload === 'object' && payload !== null && typeof payload.id === 'string' ? payload.id : ''
        if (id === '') return err('INVALID_REQUEST', 'revokeKey requires a key id')
        const removed = await keyStore.revoke(id)
        if (!removed) return err('NOT_FOUND', 'no such API key')
        ctx.logger.info(`dsh-model-relay: revoked API key ${id}`)
        return ok({ id })
      }
      case 'setAuth': {
        const locked = payload?.locked === true
        if (resolved.apiKeys.length > 0 && !locked) {
          return err('CONFLICT', 'a fixed key from the profile configuration is always enforced; remove it from the config to open the endpoint')
        }
        await keyStore.setLocked(locked)
        ctx.logger.info(`dsh-model-relay: authentication ${locked ? 'enabled' : 'disabled'} from the settings page`)
        return ok({ authRequired: await authRequired() })
      }
      default:
        return err('UNKNOWN_ENDPOINT', `unknown action "${action}"`)
    }
  }

  /**
   * Mount the settings endpoint as an exact Fetch route under Connection's
   * shared `/api` prefix.
   *
   * Why a Fetch route rather than `connection.rpc.handle('/model-relay')`:
   * a reverse-proxying gateway only forwards the request prefixes it knows
   * belong to DSH. `/api` is always one of them; a plugin-private channel is
   * not, so the browser's call would never arrive. The Fetch route also
   * inherits Connection's trust fence and browser authentication, so the
   * settings page is still reachable only from an authenticated DSH session.
   */
  ctx.inject(['connection', 'webServer'], (connectionCtx) => {
    const connection = connectionCtx.get('connection')
    if (connection === undefined) {
      ctx.logger.warn('dsh-model-relay: connection service unavailable; the settings page cannot manage keys')
      return
    }
    Promise.resolve(connection.fetch.register({
      path: SETTINGS_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let envelope
        try {
          envelope = await request.json()
        } catch {
          return jsonResponse({ error: 'request body is not JSON' }, 400)
        }
        const rpcId = typeof envelope?.rpcId === 'string' ? envelope.rpcId : ''
        const payload = envelope?.payload
        const action = typeof payload?.action === 'string' ? payload.action : ''
        const result = await dispatch(action, payload)
        return jsonResponse({ type: 'server-response', rpcId, result })
      },
    })).catch((error) => {
      ctx.logger.warn('dsh-model-relay: could not mount the settings endpoint')
      ctx.logger.warn(error)
    })
  })
}

/** One JSON response for the settings Fetch route. */
function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/**
 * Non-loopback IPv4 addresses this host currently has.
 *
 * Used only to show a ready-to-copy URL on the settings page. A machine can
 * have several (one per interface), and none of them is authoritative, so the
 * list is presented as candidates rather than as one "the" address.
 * @returns interface addresses in interface order.
 */
/**
 * Read the interface name owning the default IPv4 route, when one exists.
 *
 * This is the interface a LAN peer would actually reach, so its address is
 * ranked first. Read straight from `/proc/net/route` rather than shelling out
 * to `ip`, which may not exist and would be a per-render subprocess.
 * @returns the interface name, or undefined when it cannot be determined.
 */
function defaultRouteInterface() {
  let table
  try {
    table = readFileSync('/proc/net/route', 'utf8')
  } catch {
    return undefined
  }
  const lines = table.split('\n')
  for (const line of lines.slice(1)) {
    const fields = line.trim().split(/\s+/)
    // Destination 00000000 is the default route; its interface is column 0.
    if (fields.length >= 2 && fields[1] === '00000000' && fields[0] !== '') return fields[0]
  }
  return undefined
}

/**
 * Interface names that are almost never reachable from another LAN device.
 *
 * Docker, libvirt, and similar tooling create a bridge per network, each with
 * its own private address. On a typical NAS these outnumber the real interface
 * many times over, so they are excluded from the listed addresses rather than
 * merely sorted last: a wall of unreachable `172.17.0.1`-style entries is worse
 * than no list at all.
 *
 * Excluded rather than deleted outright — {@link lanAddresses} reports how many
 * were hidden, so an unusual setup where the only working address is on one of
 * these interfaces is still diagnosable instead of silently empty.
 */
const VIRTUAL_INTERFACE_PATTERN = /^(?:docker|br-|veth|virbr|vmnet|vboxnet|tun|tap|wg|zt|tailscale|lo)/i

/**
 * IPv4 addresses worth offering to a LAN client, most useful first.
 *
 * Only interfaces a peer can plausibly reach are returned. The default-route
 * interface leads because that is the address another device on the network
 * should actually use; any remaining real interfaces follow.
 * @returns `{ addresses, hiddenCount }` — listed entries and how many virtual
 *   interface addresses were left out.
 */
function lanAddresses() {
  const defaultIface = defaultRouteInterface()
  const listed = []
  let hiddenCount = 0
  let interfaces
  try {
    interfaces = networkInterfaces()
  } catch {
    return { addresses: [], hiddenCount: 0 }
  }
  for (const [iface, addresses] of Object.entries(interfaces)) {
    const virtual = VIRTUAL_INTERFACE_PATTERN.test(iface)
    for (const entry of addresses ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      if (virtual) {
        hiddenCount += 1
        continue
      }
      if (listed.some((candidate) => candidate.address === entry.address)) continue
      listed.push({ address: entry.address, iface })
    }
  }
  listed.sort((a, b) => (a.iface === defaultIface ? 0 : 1) - (b.iface === defaultIface ? 0 : 1))
  return { addresses: listed, hiddenCount }
}

/** Success envelope for the settings RPC channel. */
function ok(value) {
  return { ok: true, value }
}

/** Failure envelope for the settings RPC channel. */
function err(code, message) {
  return { ok: false, error: { code, message, details: {} } }
}

/** Draining helper for the non-streaming path. */
async function accumulate(iterator, first, model) {
  let text = ''
  let reasoning = ''
  const toolCalls = []
  const byIndex = new Map()
  let usage
  let finishReason = 'stop'
  let error

  const consume = (chunk) => {
    switch (chunk.type) {
      case 'text-delta':
        text += chunk.text
        break
      case 'reasoning-delta':
        reasoning += chunk.text
        break
      case 'tool-call-delta': {
        let entry = byIndex.get(chunk.index)
        if (entry === undefined) {
          entry = { id: chunk.id === undefined || chunk.id === '' ? `call_${byIndex.size}` : chunk.id, name: '', arguments: '' }
          byIndex.set(chunk.index, entry)
          toolCalls.push(entry)
        }
        if (chunk.id !== undefined && chunk.id !== '') entry.id = chunk.id
        if (chunk.name !== undefined) entry.name = chunk.name
        entry.arguments += chunk.argumentsDelta
        break
      }
      case 'usage':
        usage = toOpenAiUsage(chunk.usage, model)
        break
      case 'finish':
        finishReason = toOpenAiFinishReason(chunk.reason)
        if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') {
          error = chunkFailure(chunk.reason)
        }
        break
      default:
        break
    }
  }

  let current = first
  for (;;) {
    if (current.done === true) break
    consume(current.value)
    current = await iterator.next()
  }
  return { text, reasoning, toolCalls, usage, finishReason, error }
}

export { resolveConfig }
