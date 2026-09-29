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
import { AsyncLocalStorage } from 'node:async_hooks'
import Schema from '@deepseek-ai/schemastery'
import { RelayAdapter } from './adapter.js'
import {
  GatewayGroupStore,
  MEMBER_PREFIX,
  RELAY_MEMBER_PROVIDER,
  defaultGroupsFile,
  normalizeKind,
  referrersOf,
} from './groups.js'
import { GatewayKeyStore, defaultKeysFile } from './keys.js'
import { GroupStats } from './stats.js'
import { StatsStore } from './stats-store.js'
import {
  isRetryableRateLimit,
  normalizeRetry429,
  orderLegs,
  retryDelayMs,
  sleep,
} from './strategy.js'

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
 * Depth ceilings for the three recursion paths a group graph can create.
 *
 * They are three constants, not one, because the paths are genuinely different
 * and share no carrier:
 *
 *  - RESOLUTION: `resolveRoute` -> `resolveLeg` -> `resolveRoute`, entirely
 *    synchronous and BEFORE any request options exist. This is the path a
 *    plain group-name cycle takes, and it is reachable from the settings page
 *    today.
 *  - DISPATCH: `ctx.llm.stream` -> adapter -> `streamGroup` -> `ctx.llm.stream`.
 *    Reached only through a prefixed member, i.e. only for a composite.
 *  - CAPABILITY: `groupCapabilities` -> `resolveModelInfo` -> adapter ->
 *    `#capabilities` -> `groupCapabilities`. Triggered by building the model
 *    catalog, so merely OPENING the Models page walks it.
 *
 * A single shared ceiling would make tuning one path silently move the others,
 * and the paths' natural depths differ anyway (a capability walk nests one
 * level per group, a dispatch walk one per composite).
 */
const MAX_RESOLUTION_DEPTH = 8
const MAX_DISPATCH_DEPTH = 4
const MAX_CAPABILITY_DEPTH = 8

/**
 * Marks the dispatch-depth counter carried on a request's options.
 *
 * A Symbol, so it cannot collide with a field DSH itself sets and is invisible
 * to anything that enumerates or serializes the options object. DSH passes the
 * options it was handed straight through to the adapter, so a value attached
 * here survives the round trip back into `streamGroup`.
 */
const DISPATCH_DEPTH = Symbol('dsh-model-relay.dispatch-depth')

/**
 * Carries the capability-walk depth across `ctx.llm.resolveModelInfo`.
 *
 * The resolution and dispatch paths can pass their depth as an ordinary value,
 * but the capability path CANNOT: its recursion leaves this plugin entirely —
 * `groupCapabilities` calls DSH, DSH calls the adapter this plugin
 * registered, and the adapter calls back into `groupCapabilities`. There is no
 * argument slot of ours in that middle hop, so the depth rides an async-context
 * store instead, which is also what keeps two concurrent catalog builds from
 * seeing each other's counter.
 */
const capabilityDepth = new AsyncLocalStorage()

/** Error code for a cycle detected on the resolution path. */
const CODE_CYCLE = 'group_cycle'

/** Error code for a cycle (or excess depth) on the capability path. */
const CODE_CAPABILITY_CYCLE = 'group_capability_cycle'

/**
 * Whether a failure is one of this plugin's own recursion guards.
 *
 * The failover loops catch every error a member can raise and simply try the
 * next member. A guard error must NOT be swallowed that way: the request would
 * end as a bare `group_empty` and the actual cause would never reach the
 * caller or the log. Both loops consult this before deciding to continue.
 * @param error - whatever a member resolution threw.
 */
function isGuardError(error) {
  return error?.code === CODE_CYCLE
    || error?.code === CODE_CAPABILITY_CYCLE
    || error?.code === 'group_self_reference'
}

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

/**
 * The DSH provider route this plugin registers for itself.
 *
 * Registering a provider is what makes a model group selectable inside DSH
 * itself rather than only over `/v1`: the adapter's model list *is* the group
 * list. The route key doubles as the visible provider id, so it is the package
 * name — self-describing everywhere it surfaces (`GenerateOptions.provider`,
 * `owned_by` in a model listing, the Models settings page).
 *
 * This value must also be what `RelayAdapter.providerInfo()` returns as `id`:
 * the runtime rejects a route whose adapter metadata does not preserve it.
 */
const RELAY_PROVIDER_ID = RELAY_MEMBER_PROVIDER

/** Display name for that provider, in the Models settings page. */
const RELAY_PROVIDER_NAME = 'dsh-model-relay'

/**
 * Settings namespace the provider directory is keyed by.
 *
 * A configurable-provider entry is only rendered by the Models settings page
 * when its namespace resolves in the settings mirror, so a section must be
 * installed under this exact name. See {@link registerRelayProvider}.
 */
const RELAY_SETTINGS_NS = 'llm-dsh-model-relay'

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
  if (config.groupsFile !== undefined && (typeof config.groupsFile !== 'string' || config.groupsFile.length === 0)) {
    throw new Error('dsh-model-relay: groupsFile must be a non-empty path string')
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
    groupsFile: config.groupsFile,
    // 0.5.0 statistics persistence. Default ON per design decision 1; a
    // schema-mandatory key list means an unlisted key would silently vanish,
    // which is why all three are spelled out here.
    statsPersist: config.statsPersist ?? true,
    statsFile: config.statsFile,
    statsRetentionDays: clampRetentionDays(config.statsRetentionDays ?? 90),
    lanPort,
    lanHost: config.lanHost ?? '0.0.0.0',
  }
}

/**
 * Clamp the retention setting to a sane range.
 *
 * A user value of 0 or below would make the store prune everything the moment
 * it is written; an unbounded value defeats the "JSON needs a limit" rationale
 * the whole day-bucket design rests on. 1..365 covers every real answer.
 */
function clampRetentionDays(value) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return 90
  return Math.min(365, Math.max(1, n))
}

/** An HTTP-shaped failure carrying the status the gateway should answer with. */
class GatewayError extends Error {
  constructor(status, message, type = 'invalid_request_error', code, providerRetryAfterMs) {
    super(message)
    this.status = status
    this.type = type
    this.code = code
    /**
     * A detached provider-neutral failure snapshot.
     *
     * This is not decoration: `dsh-llm` normalizes anything an adapter throws
     * through `normalizeLlmFailure`, which trusts a code ONLY from a
     * `HarnessError` and otherwise reports `UNKNOWN`. A plain `Error` subclass
     * therefore loses its code at that boundary — and the code is exactly what
     * `dsh-llm-retry` matches against `retryableCodes`.
     *
     * Carrying an own `failure` data property is how a foreign adapter
     * preserves a code across that boundary, and the snapshot must be
     * consistent: `normalizeLlmFailure` uses it only when `failure.code` equals
     * the error's own `code`. Without this, a group whose every member was rate
     * limited reaches the agent loop as `UNKNOWN` and is silently never retried.
     *
     * `providerRetryAfterMs` rides along because it is the upstream's own
     * "come back in N ms" — `dsh-llm-retry` prefers it over its local backoff
     * (dsh-llm-retry:168-172), so dropping it makes the harness hammer a
     * provider that just asked for quiet. It is only attached when it is a
     * positive finite number: `failureSnapshot` rejects the WHOLE snapshot —
     * code included — if any single field is malformed, so a bad value here
     * would silently cost us retryability too.
     */
    if (typeof code === 'string' && code !== '' && typeof message === 'string' && message !== '') {
      const usable = Number.isFinite(providerRetryAfterMs) && providerRetryAfterMs > 0
      this.failure = { message, code, status, ...(usable ? { providerRetryAfterMs } : {}) }
      // Also exposed directly, because the `/v1` handler reads the hint off the
      // thrown error to set a `Retry-After` header, while DSH reads it from the
      // `failure` snapshot above. Same fact, two consumers, two shapes.
      if (usable) this.providerRetryAfterMs = providerRetryAfterMs
    }
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
function sendError(res, status, message, type = 'invalid_request_error', code, providerRetryAfterMs) {
  // A real `Retry-After` header, because that is what an HTTP client actually
  // reads. The header is whole seconds by spec (RFC 9110), so a millisecond
  // hint is rounded UP: rounding down would let a client retry inside the
  // window the upstream asked us to respect. A sub-second hint still becomes
  // one second rather than zero, which would mean "retry immediately".
  const retryAfterSeconds = retryAfterSecondsOf(providerRetryAfterMs)
  if (retryAfterSeconds !== undefined) res.setHeader('retry-after', retryAfterSeconds)
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
    case 'AUTH':
    case 'INVALID_CREDENTIAL':
    case 'MISSING_CREDENTIAL':
      // `AUTH` is what `dsh-llm-deepseek` reports for HTTP 401 AND 403
      // (dsh-llm-deepseek:1513). Answering 502 would tell the caller "the
      // gateway broke" when the truth is "your credential is wrong" — a
      // distinction the caller acts on differently.
      return 401
    case 'QUOTA_EXCEEDED':
    case 'QUOTA':
    case 'RATE_LIMIT':
      return 429
    case 'UNSUPPORTED_CONTENT':
    case 'UNSUPPORTED_OPTION':
    case 'UNSUPPORTED_REASONING_EFFORT':
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

/**
 * The HTTP status for a DSH failure, preferring the provider's own status.
 *
 * A code maps to a family, but the provider already told us the exact status —
 * `dsh-llm-deepseek` attaches `status: response.status` to every HTTP failure
 * it raises. Reusing that preserves detail a code loses: `AUTH` covers both 401
 * and 403, and a provider-specific `HTTP_402` has no code mapping at all.
 *
 * @param failure - a normalized `{code, status, ...}` failure.
 * @returns an HTTP status.
 */
function statusForFailure(failure) {
  const reported = failure?.status
  if (Number.isInteger(reported) && reported >= 100 && reported <= 599) return reported
  return statusForCode(failure?.code)
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
 * Convert an upstream retry hint into a whole-second `Retry-After` value.
 *
 * `dsh-llm` measures the hint in milliseconds while HTTP specifies whole
 * seconds, so this rounds UP: a client that retried inside the window the
 * provider asked for would be exactly the behavior the hint exists to prevent.
 *
 * @param providerRetryAfterMs - the upstream hint, if any.
 * @returns whole seconds, or undefined when there is no usable hint.
 */
function retryAfterSecondsOf(providerRetryAfterMs) {
  if (!Number.isFinite(providerRetryAfterMs) || providerRetryAfterMs <= 0) return undefined
  return Math.max(1, Math.ceil(providerRetryAfterMs / 1000))
}

/**
 * Drop the internal retry hint from an error payload bound for the wire.
 *
 * @param payload - an error object that may carry `providerRetryAfterMs`.
 * @returns the same fields minus the hint.
 */
function withoutRetryHint(payload) {
  const { providerRetryAfterMs: _internal, ...rest } = payload
  return rest
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
  return {
    message: failure.message ?? 'the provider stream failed',
    type: 'upstream_error',
    code: failure.code ?? 'UPSTREAM_ERROR',
    status: statusForFailure(failure),
    // Carried on the object so the caller can set a `Retry-After` header. The
    // SSE writer strips it before serializing, because an error envelope is not
    // where an OpenAI client looks for a retry hint.
    ...(Number.isFinite(failure.providerRetryAfterMs) && failure.providerRetryAfterMs > 0
      ? { providerRetryAfterMs: failure.providerRetryAfterMs }
      : {}),
  }
}

/**
 * Chunk types that mean the caller has already been shown something.
 *
 * Once one of these has been forwarded, switching members would replay content
 * the client already has — a duplicated `block-start`, or a second answer
 * appended to the first — so the attempt is committed and a later failure is
 * final.
 *
 * `usage` is deliberately absent: it carries no model output, so a stream that
 * fails after emitting only usage has still shown the caller nothing and may
 * safely fail over.
 */
const COMMITTING_CHUNK_TYPES = new Set([
  'block-start',
  'block-end',
  'text-delta',
  'reasoning-delta',
  'tool-call-delta',
])

/**
 * Read the terminal failure out of a stream chunk, if it carries one.
 *
 * This exists because `ctx.llm.stream()` does not throw on a provider failure:
 * `dsh-llm` catches adapter dispatch and iteration errors at its own boundary
 * and converts each into a terminal `finish` chunk whose `reason.kind` is
 * `'error'` (or `'aborted'`). A failover loop that only watched for `done`
 * would treat that chunk as a successful result and hand the error straight to
 * the caller, never trying the next candidate.
 *
 * `aborted` is reported separately rather than as a failure: it means the
 * *caller* cancelled, so failing over would resurrect work that was just
 * cancelled and would answer a request nobody is waiting for.
 *
 * @param chunk - one chunk from `ctx.llm.stream()`.
 * @returns `'aborted'`, a failure object, or undefined for a non-terminal chunk.
 */
function terminalOutcome(chunk) {
  if (chunk?.type !== 'finish') return undefined
  const reason = chunk.reason
  if (reason?.kind === 'aborted') return 'aborted'
  if (reason?.kind !== 'error') return undefined
  return {
    message: reason.failure?.message,
    code: reason.failure?.code,
    // The provider's own HTTP status, when it reported one. More precise than
    // the code's family: `AUTH` covers 401 and 403 alike.
    status: reason.failure?.status,
    // The upstream's own backoff hint, when it sent one. Carried through the
    // failover loop so a fully-failed group still tells the caller (and
    // `dsh-llm-retry`) how long the provider asked for.
    providerRetryAfterMs: reason.failure?.providerRetryAfterMs,
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
  const groupsFile = resolved.groupsFile ?? defaultGroupsFile()

  /** Keys minted from the settings page. */
  const keyStore = new GatewayKeyStore({ file: keysFile, logger: ctx.logger })

  /**
   * Named model groups, managed from the settings page.
   *
   * A group is an ordered candidate list; a request naming the group takes the
   * first candidate that answers. Groups are read on every request that might
   * name one, so the store keeps its document cached after the first read.
   */
  const groupStore = new GatewayGroupStore({ file: groupsFile, logger: ctx.logger })

  /** Short-lived model catalog shared by both routes. */
  let catalog = { readAt: 0, models: [] }

  /**
   * Short-lived per-group capability answers, keyed by group name.
   *
   * `resolveModel` is called once per group for every model-catalog build, and
   * each call fans out to `resolveModelInfo` for every member. Caching by name
   * keeps that from becoming a provider round trip per member per catalog
   * build. Entries are dropped whenever the group set changes, so an edit on
   * the settings page is visible immediately.
   */
  const capabilityCache = new Map()

  /**
   * Short-lived per-member effort lists, keyed by `provider\0model`.
   *
   * Read on the group dispatch path to check whether a caller's
   * `reasoning_effort` is one the member accepts, which would otherwise be a
   * provider round trip on every request that carries one.
   */
  const memberEffortCache = new Map()

  /**
   * Rotation positions for `round-robin` groups, keyed by group name.
   *
   * In memory only, and deliberately never persisted: the position belongs to
   * the live process, and writing it into the group document would turn every
   * request into a disk write (the store's `persist` is a full atomic
   * replace). A restart simply starts the rotation from the top again.
   *
   * Cleared alongside the capability caches whenever the group set changes:
   * resuming a rotation over a list that no longer exists means nothing.
   */
  const groupCursors = new Map()

  /**
   * Per-candidate call statistics, in memory only.
   *
   * Same discipline as {@link groupCursors} just above, and for the same
   * reason: a statistics update must never become a disk write, and must never
   * be able to fail a request. It is observability, not configuration —
   * nothing here may ever influence routing. See `lib/stats.js`.
   */
  const stats = new GroupStats()

  /**
   * Persistent day-bucket statistics (0.5.0). Loaded asynchronously; recording
   * before the load settles is safe — the buckets merge in memory and the
   * first flush lands after load because flush awaits the load promise.
   * Never constructed when `statsPersist` is off: zero I/O, zero timers.
   */
  const statsStore = resolved.statsPersist
    ? new StatsStore({ file: resolved.statsFile, logger: ctx.logger })
    : undefined
  if (statsStore !== undefined) {
    ctx.effect(() => () => { void statsStore.dispose() })
  }

  /**
   * Order one group's candidates for this request.
   *
   * The single place a strategy is applied, so the `/v1` route and DSH's own
   * adapter cannot drift apart on scheduling.
   * @param group - a stored group record.
   * @returns the candidates in the order they should be tried.
   */
  const scheduleGroup = (group) => {
    const { legs, nextCursor } = orderLegs(group.strategy, group.models, groupCursors.get(group.name) ?? 0)
    if (group.strategy === 'round-robin') groupCursors.set(group.name, nextCursor)
    return legs
  }

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

  /**
   * List provider/models the gateway is willing to expose.
   *
   * Groups are merged in on every call, outside the provider catalog's cache:
   * the provider list is expensive to read and effectively static, while a
   * group can be created or renamed from the settings page at any moment and
   * must be callable immediately afterwards.
   * @param signal - caller cancellation for the provider catalog read.
   */
  const listCatalog = async (signal) => {
    return [...await listProviderModels(signal), ...await listGroupEntries()]
  }

  /** The provider-owned half of the catalog, cached for {@link CATALOG_TTL_MS}. */
  const listProviderModels = async (signal) => {
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
          contextWindow: entry.contextWindow,
        })
      }
    }
    if (models.length > 0) catalog = { readAt: Date.now(), models }
    return catalog.models
  }

  /**
   * Every group, in the shape the catalog and the model listing use.
   *
   * A group is advertised exactly like a model: that is what makes it callable
   * from DSH's own model picker and from any external OpenAI client without
   * either of them knowing groups exist as a concept.
   */
  const listGroupEntries = async () => {
    const groups = await groupStore.all()
    return groups
      .filter((group) => group.enabled)
      .map((group) => ({
        id: group.name,
        rawId: group.name,
        provider: RELAY_PROVIDER_ID,
        name: group.name,
      }))
  }

  /**
   * What a group can actually do: the intersection of its members' abilities.
   *
   * Both facts are computed in one pass because both come from the same
   * `resolveModelInfo` call per member.
   *
   * **Capacity** is the smallest member window, not the largest. A group may
   * fail over to any member and DSH starts compacting at a fraction of this
   * number, so declaring the narrowest member is what keeps "nearly full" true
   * on every branch; a wider one would let a session overrun whichever member
   * actually answers. Undefined when any member's capacity is unknown —
   * guessing is worse than omitting, because DSH treats a missing capacity as
   * "cannot size a compaction" and keeps going, whereas a wrong one silently
   * mis-sizes every compaction until a request overflows.
   *
   * **Efforts** are the intersection, not the union. This is the whole reason
   * the parameter is safe to advertise: DSH validates a caller's effort against
   * this list and then forwards it to whichever member answers, so an effort
   * only some members honour would be accepted here and rejected there — mid
   * request, as UNSUPPORTED_REASONING_EFFORT. A member that declares no
   * reasoning at all, or whose capability cannot be read, collapses the
   * intersection to empty, which is the honest answer: the group cannot promise
   * any choice, so it advertises none.
   *
   * The two facts fail independently on purpose. A member that offers no
   * reasoning choice says nothing about how much context it holds, so it must
   * not cost the group its capacity — that would silently switch auto-compaction
   * off for a long session over an unrelated field.
   *
   * The order follows the first member's declaration, so the display order is
   * stable and reflects a real provider's own ordering rather than ours.
   * @param models - the group's candidate list in exposed spelling.
   * @param signal - caller cancellation for the capability reads.
   * ## The capability path is also a recursion path
   *
   * A composite's members are `dsh-model-relay_<group>`, so measuring one calls
   * `resolveModelInfo` for this gateway's own route — which DSH answers by
   * invoking the adapter this plugin registered, which walks the INNER group's
   * members and calls back here. A hand-edited file holding a capability cycle
   * therefore recurses without bound, and unlike the other two paths it is
   * triggered by BUILDING THE MODEL CATALOG: merely opening the Models page
   * walks it, with no request and no dispatch involved. Hence the depth guard,
   * which has to be consulted before anything else here.
   *
   * @returns `{ contextWindow, efforts }`; both may be empty/undefined.
   */
  const groupCapabilities = async (models, signal) => {
    const depth = capabilityDepth.getStore() ?? 0
    if (depth > MAX_CAPABILITY_DEPTH) {
      throw new GatewayError(
        500,
        `the model catalog nests more than ${MAX_CAPABILITY_DEPTH} levels deep; this is a capability cycle between groups`,
        'api_error',
        CODE_CAPABILITY_CYCLE,
      )
    }
    let smallest
    let intersection
    let effortless = false
    /**
     * Whether every member's capacity is known.
     *
     * The smallest window is only meaningful once every member has been
     * measured: one unknown member could be narrower than everything seen so
     * far, so the minimum over a partial walk is not the group's capacity.
     */
    let capacityKnown = true
    // Read once: the provider directory cannot change mid-walk in a way that
    // would matter, and this is called per member per catalog build.
    const providers = ctx.llm.listProviders().map((entry) => entry.id)
    for (const candidate of models) {
      const raw = String(candidate ?? '')
      const namespaced = splitExposedModelId(raw, providers)
      const slash = namespaced === undefined ? raw.indexOf('/') : -1
      const provider = namespaced !== undefined
        ? namespaced.provider
        : slash > 0 ? raw.slice(0, slash) : undefined
      const modelId = namespaced !== undefined
        ? namespaced.model
        : slash > 0 ? raw.slice(slash + 1) : raw
      if (provider === undefined || !providers.includes(provider)) {
        // A candidate that names no known provider cannot be measured, so
        // neither fact is knowable for the group.
        return { contextWindow: undefined, efforts: [] }
      }
      let info
      try {
        // A member served by this gateway is another group: recurse one level
        // deeper with the depth visible to the nested walk. Every other member
        // is a real provider model and cannot lead back here.
        info = provider === RELAY_PROVIDER_ID
          ? await capabilityDepth.run(depth + 1, () => ctx.llm.resolveModelInfo(provider, modelId, signal))
          : await ctx.llm.resolveModelInfo(provider, modelId, signal)
      } catch (error) {
        // The guard error must escape. Reporting it as "unknown capability"
        // would hide a cycle behind an ordinary `undefined`, and the walk
        // would then be restarted by the very next catalog build.
        if (error?.code === CODE_CAPABILITY_CYCLE) throw error
        // Nothing at all is known about this member, so neither fact can be
        // stated about the group.
        return { contextWindow: undefined, efforts: [] }
      }
      const window = info?.context?.contextWindow
      if (!Number.isInteger(window) || window <= 0) {
        // Capacity is unknown, but this says nothing about reasoning: keep
        // walking so a declared effort set is still intersected.
        smallest = undefined
        capacityKnown = false
      } else if (capacityKnown && (smallest === undefined || window < smallest)) {
        smallest = window
      }

      const efforts = declaredEfforts(info)
      if (efforts === undefined) {
        // This member accepts no effort parameter at all, which collapses the
        // group's choice. Its capacity remains valid and is still used.
        effortless = true
        continue
      }
      if (!effortless) {
        intersection = intersection === undefined
          ? efforts
          : intersection.filter((effort) => efforts.some((other) => other.id === effort.id))
      }
    }
    return { contextWindow: capacityKnown ? smallest : undefined, efforts: effortless ? [] : intersection ?? [] }
  }

  /**
   * One member's advertised efforts, or undefined when it offers no choice.
   *
   * A member with no `reasoning` block does not accept the parameter at all,
   * which is a different statement from "accepts none of the levels": it must
   * collapse the group's intersection rather than be skipped.
   * @param info - a resolved model info from `llm.resolveModelInfo`.
   */
  const declaredEfforts = (info) => {
    const efforts = info?.reasoning?.efforts
    if (!Array.isArray(efforts) || efforts.length === 0) return undefined
    const usable = efforts.filter((effort) => typeof effort?.id === 'string' && effort.id !== '')
    return usable.length === 0 ? undefined : usable
  }

  /**
   * A group's capabilities, memoized for {@link CATALOG_TTL_MS}.
   *
   * Keyed by name and invalidated whenever the group document changes, so the
   * cache never outlives an edit made on the settings page.
   */
  const cachedGroupCapabilities = async (models, signal, groupName) => {
    /**
     * The cache key includes the group NAME, not just its members.
     *
     * A composite's member list is `["dsh-model-relay_B"]` and never changes when
     * B itself is edited, so a member-only key would keep serving B's old
     * capabilities. Keying on the name lets an edit to B invalidate every
     * composite that points at it (see the settings handlers), which is the
     * only way the page can reflect a change one level down.
     */
    const key = groupName === undefined ? models.join('\u0000') : `${groupName}\u0000${models.join('\u0000')}`
    const hit = capabilityCache.get(key)
    if (hit !== undefined && Date.now() - hit.readAt < CATALOG_TTL_MS) return hit.value
    const value = await groupCapabilities(models, signal, groupName)
    capabilityCache.set(key, { readAt: Date.now(), value })
    return value
  }

  /**
   * Drop a `reasoningEffort` that a group member cannot accept, with a warning.
   *
   * Applies to **group** dispatch only, and that distinction matters. When a
   * caller names a group, the router picks the member — the caller cannot know
   * which one answers, so an effort it could not have checked must not be
   * allowed to fail the request. When a caller names a concrete model instead,
   * it chose both the model and the effort, and a clear rejection is the honest
   * answer; that path is left exactly as it was.
   *
   * The need arises because `/v1` callers pass `reasoning_effort` straight
   * through, and a session can still hold an effort chosen before the group's
   * members changed. DSH rejects such a request outright with
   * UNSUPPORTED_REASONING_EFFORT, turning a stale preference into a hard
   * failure.
   *
   * Dropping rather than rejecting is deliberate: the effort is a preference,
   * and the member's own default is a better answer than refusing to route at
   * all. The warning keeps it from being invisible.
   *
   * A member that declares no reasoning block accepts no effort parameter at
   * all, so the field is dropped for it too. A member whose capabilities cannot
   * be read is left alone: guessing there could strip a parameter that would
   * have worked.
   * @param bound - the resolved member about to be dispatched.
   * @param options - the assembled request, possibly carrying `reasoningEffort`.
   * @param signal - caller cancellation for the capability read.
   * @param isGroup - whether the router chose this member (rather than the caller).
   * @returns the options to dispatch, with the effort removed when unsupported.
   */
  const pruneUnsupportedEffort = async (bound, options, signal, isGroup) => {
    const effort = options.reasoningEffort
    // A caller that named a concrete model chose the effort deliberately;
    // a clear rejection beats silently discarding its instruction.
    if (effort === undefined || !isGroup) return options
    const key = `${bound.provider}\u0000${bound.model}`
    const hit = memberEffortCache.get(key)
    let efforts
    if (hit !== undefined && Date.now() - hit.readAt < CATALOG_TTL_MS) {
      efforts = hit.value
    } else {
      try {
        efforts = declaredEfforts(await ctx.llm.resolveModelInfo(bound.provider, bound.model, signal))
      } catch {
        // Unreadable is not the same as unsupported: leaving the parameter in
        // place risks a rejection, stripping it risks losing a setting the
        // member would have honoured. Keep the caller's request intact and let
        // the member decide.
        return options
      }
      memberEffortCache.set(key, { readAt: Date.now(), value: efforts })
    }
    if (efforts !== undefined && efforts.some((entry) => entry.id === effort)) return options
    ctx.logger.warn(`dsh-model-relay: member ${JSON.stringify(bound.exposed)} does not accept reasoning effort ${JSON.stringify(effort)}; dropping it`)
    const { reasoningEffort: _dropped, ...rest } = options
    return rest
  }

  /**
   * Resolve one group candidate into a concrete provider/model pair.
   *
   * A candidate is written in the gateway's own exposed spelling, which is
   * exactly what `/v1/models` advertises, so this is the same resolution any
   * explicit model id gets — a group member cannot drift from its own name.
   *
   * ## What may contain a group, and how
   *
   * A candidate that names this gateway's own route is normally REFUSED: the
   * gateway registers itself as a provider so DSH's picker can offer groups, so
   * its route id is a legal-looking prefix, and a group naming one of its own
   * members would resolve straight back into itself and recurse without bound.
   *
   * A `composite` is the one exception, and only through the PREFIXED spelling.
   * `allowGroupMember` lets `dsh-model-relay_<inner>` through as an ordinary
   * provider/model pair, which `ctx.llm.stream` then hands back to this
   * gateway's own adapter — so `streamGroup` runs the inner group with ITS
   * strategy and retry budget. A BARE inner name is still refused even for a
   * composite: resolving it here would take the group branch, return the inner
   * group's first leg, and silently discard the rest of its chain and all of
   * its scheduling.
   *
   * @param candidate - one entry from a group's candidate list.
   * @param signal - caller cancellation for the catalog read.
   * @param options - `{ depth, allowGroupMember }`. `depth` counts resolution
   *   nesting for the cycle guard; `allowGroupMember` is true only when the
   *   caller is a composite.
   */
  const resolveLeg = async (candidate, signal, options = {}) => {
    const raw = String(candidate ?? '')
    const depth = options.depth ?? 0
    const allowGroupMember = options.allowGroupMember === true
    /**
     * The resolution-path cycle guard.
     *
     * This is the path a plain group-name cycle takes, and it is entirely
     * synchronous and pre-dispatch: `ctx.llm.stream` is never reached, so no
     * request options exist to carry a counter on. The depth therefore travels
     * as an ordinary argument. Without this the cycle recurses until the
     * process runs out of heap — the settings page can build one in two clicks.
     */
    if (depth > MAX_RESOLUTION_DEPTH) {
      throw new GatewayError(
        500,
        `group member ${JSON.stringify(raw)} nests more than ${MAX_RESOLUTION_DEPTH} levels deep; this is a cycle or an accidentally nested group`,
        'api_error',
        CODE_CYCLE,
      )
    }
    const knownProviders = ctx.llm.listProviders().map((entry) => entry.id)

    /** Refuse a candidate that names this gateway's own group route. */
    const refuseSelfReference = () => {
      throw new GatewayError(
        500,
        `group member ${JSON.stringify(raw)} points back at this gateway; only a composite group may contain a group, and only as ${MEMBER_PREFIX}<name>`,
        'api_error',
        'group_self_reference',
      )
    }

    const namespaced = splitExposedModelId(raw, knownProviders)
    if (namespaced !== undefined) {
      if (namespaced.provider === RELAY_PROVIDER_ID) {
        if (!allowGroupMember) refuseSelfReference()
        // Handed through as a concrete pair on purpose: this is what makes the
        // inner group reachable through DSH's own dispatch and therefore run
        // its own scheduling, instead of being flattened here.
        return { ...namespaced, exposed: raw }
      }
      return { ...namespaced, exposed: raw }
    }

    const slash = raw.indexOf('/')
    if (slash > 0) {
      const provider = raw.slice(0, slash)
      const model = raw.slice(slash + 1)
      if (model.length > 0) {
        if (provider === RELAY_PROVIDER_ID) refuseSelfReference()
        if (knownProviders.includes(provider)) {
          return { provider, model, exposed: exposedModelId(provider, model) }
        }
      }
    }

    // A bare id: defer to the ordinary resolver, so an unnamespaced candidate
    // behaves exactly like the same name passed as the request's `model`.
    const resolvedLeg = await resolveRoute(raw, signal, depth + 1)
    if (resolvedLeg.group !== undefined) {
      // A bare name that IS a group. Refused for every kind: taking it would
      // return the inner group's first leg only, dropping its remaining
      // candidates and its scheduling. A composite must spell its members with
      // the prefix, which is validated on save and re-checked here for a
      // hand-edited file.
      throw new GatewayError(
        500,
        `group member ${JSON.stringify(raw)} is a group; write it as ${MEMBER_PREFIX}${JSON.stringify(raw)} so the inner group keeps its own scheduling`,
        'api_error',
        'group_self_reference',
      )
    }
    return resolvedLeg
  }

  /**
   * Resolve the provider route for a requested model id.
   *
   * Accepted spellings, in precedence order:
   *  0. a model-group name — expanded into its ordered candidate list.
   *  1. `<provider>_<model>` — the canonical exposed form, and the only one
   *     that is unambiguous when two providers serve the same model id.
   *  2. `<provider>/<model>` — the legacy spelling, still accepted.
   *  3. a bare `<model>` — resolved through `defaultProvider`, then a unique
   *     catalog match, then the sole registered provider.
   *
   * A bare id that several providers serve is refused rather than guessed: the
   * whole point of namespacing is that the caller says which one it meant.
   *
   * Group names are checked first and can never collide with the spellings
   * below: a group name may not contain an underscore (that is the provider
   * separator) and may not contain a slash.
   * @param requested - the `model` field from the request body.
   * @param signal - caller cancellation for the catalog read.
   * @param depth - resolution nesting, for the cycle guard. A caller outside a
   *   group omits it; {@BT}resolveLeg{@BT} increments it per level.
   * @returns the resolved provider and provider-side model id. A group request
   *   additionally carries `group`, holding the ordered candidate list.
   */
  const resolveRoute = async (requested, signal, depth = 0) => {
    const raw = String(requested ?? '')
    if (raw === '') throw new GatewayError(400, 'you must provide a model parameter', 'invalid_request_error', 'missing_model')

    // 0. A model group: expand to its ordered candidates and resolve the head.
    //
    // The head is resolved here purely so callers that only want "a provider
    // and a model" (the catalog, the echo, the usage record) keep working
    // unchanged. The full candidate list rides along in `group` for the
    // failover loop, which is the only place that needs it.
    const group = await groupStore.get(raw)
    if (group !== undefined && group.enabled) {
      /**
       * Whether this group is allowed to contain other groups.
       *
       * Only a composite is, and the distinction is what keeps every existing
       * group behaving exactly as it did: a `model` group still refuses a
       * candidate that names another group, so nothing that worked before can
       * start recursing because of this feature.
       */
      const allowGroupMember = normalizeKind(group.kind) === 'composite'
      const legs = scheduleGroup(group).filter((model) => model !== raw)
      if (legs.length === 0) {
        throw new GatewayError(500, `group "${raw}" has no usable candidates`, 'api_error', 'group_empty')
      }
      // The head is resolved here purely so callers that only want "a provider
      // and a model" (the catalog, the echo, the usage record) keep working.
      //
      // It is resolved through a loop rather than by taking `legs[0]` because
      // the failover loop tolerates a candidate that cannot be resolved, and
      // resolving only the first one here would not: its rejection would
      // escape and fail the whole request even when the group's other
      // candidates are perfectly healthy. Under a rotating strategy the dead
      // candidate leads a different request each time, so the symptom would be
      // a request that fails at random.
      let head
      let headError
      /** The first recursion-guard failure, kept so it can outrank a generic empty group. */
      let headGuardError
      /** The stored spelling of whichever candidate resolved, for the scoreboard. */
      let headCandidate
      for (const candidate of legs) {
        try {
          head = await resolveLeg(candidate, signal, { depth, allowGroupMember })
          headCandidate = candidate
          break
        } catch (error) {
          // A guard failure is kept aside rather than discarded. It still must
          // not abort the walk — the group's other candidates may be perfectly
          // healthy, and failing them because one entry is cyclic would be a
          // regression — but if NOTHING resolves, the guard reason is the one
          // worth reporting, not a generic "no usable candidates".
          if (isGuardError(error)) headGuardError = error
          headError = error
          ctx.logger.warn(`dsh-model-relay: group "${raw}" member ${JSON.stringify(candidate)} did not resolve`)
        }
      }
      if (head === undefined) {
        // This loop is itself a real attempt path. When no member resolves the
        // request dies here and never reaches the failover loop, so the request
        // and the per-member failures have to be recorded at this point —
        // otherwise the group would serve a failed request that the scoreboard
        // never saw. A member that cannot be resolved is a configuration
        // problem, so each one is excused rather than blamed.
        stats.request(raw)
        for (const candidate of legs) stats.unresolved(raw, candidate)
        stats.allFailed(raw)
        throw headGuardError ?? headError ?? new GatewayError(500, `group "${raw}" has no usable candidates`, 'api_error', 'group_empty')
      }
      return {
        ...head,
        exposed: raw,
        // `legs` carries the STORED spelling, while `head.exposed` is the
        // canonical one the two can differ on (`codebuddy/glm-5.2` resolves to
        // `codebuddy_glm-5.2`). The failover loop walks `legs`, so statistics
        // must be keyed by that same spelling or the settings page — which
        // looks candidates up from the stored list — would find nothing.
        group: {
          id: group.id,
          name: group.name,
          kind: normalizeKind(group.kind),
          legs,
          candidate: headCandidate,
          retry429: normalizeRetry429(group.retry429),
        },
      }
    }

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

  /**
   * Open a stream for one resolved route, failing over across a group's
   * candidates when the request named a group.
   *
   * The contract this relies on is the same one the non-group path always had:
   * a status is committed only after the upstream produces its first chunk. So
   * a candidate that fails before producing anything has left the response
   * untouched, and the next candidate can be tried. The moment a chunk arrives
   * the response is committed and there is no fallback — switching then would
   * replay content the client has already seen.
   *
   * "Fails" covers two shapes, and missing the second one is what made real
   * failover never happen. A candidate can *throw*, and it can also answer with
   * a terminal `finish` chunk carrying `reason.kind === 'error'`, because
   * `dsh-llm` catches adapter failures at its own boundary and converts them
   * into exactly that chunk. Both are uncommitted failures when nothing has
   * been yielded yet.
   *
   * Every abandoned iterator is closed explicitly. `ctx.llm.stream()` is lazy:
   * the call itself does not touch the network, and a failure surfaces from the
   * first `next()`. An iterator dropped without closing would leave its
   * upstream connection in flight, so a burst of failovers would leak one
   * connection per attempt.
   * @param route - the resolved route, carrying `group` when one was named.
   * @param baseOptions - the assembled request, before provider/model are bound.
   * @param signal - caller cancellation, forwarded to each attempt.
   * @returns the open iterator, its first chunk, the route actually served, and
   *   `leg` — the stored-spelling candidate key that served, for /v1 usage
   *   accounting (usage reaches handleCompletions, not this walk).
   */
  const openStream = async (route, baseOptions, signal) => {
    // A group attempt carries the STORED candidate spelling alongside the
    // resolved one, because the scoreboard is keyed by what the group holds.
    const attempts = route.group === undefined
      ? [{ provider: route.provider, model: route.model, exposed: route.exposed }]
      : route.group.legs.map((leg) => ({ leg }))
    // Which candidate finally served, in STORED spelling, so the /v1 layer can
    // charge usage to the scoreboard's key (the exposed spelling can differ —
    // see the attempt-keying note above).
    let servedLeg
    const noteServedLeg = (attempt) => { servedLeg = attempt?.leg }
    const retry429 = route.group?.retry429 ?? 0
    // Only groups are scored: a direct model call has no candidate list to
    // compare against, and is not what the scoreboard is for.
    if (route.group !== undefined) {
      stats.request(route.exposed)
      statsStore?.record({ groupName: route.exposed, request: true })
    }

    /**
     * Whether this group may name other groups. Carried into {@link resolveLeg}
     * because the walk here resolves members itself rather than reusing the
     * head that {@link resolveRoute} already found.
     */
    const allowGroupMember = route.group !== undefined
      && normalizeKind(route.group.kind) === 'composite'
    let lastError
    /** The first recursion-guard failure, so it can outrank a generic empty group. */
    let guardError
    for (const attempt of attempts) {
      let bound
      if (attempt.leg === undefined) {
        bound = attempt
      } else {
        try {
          bound = await resolveLeg(attempt.leg, signal, { allowGroupMember })
        } catch (error) {
          // A candidate that cannot even be resolved is a configuration
          // problem with that leg, not with the request: try the next one.
          // A guard failure is remembered separately — the walk continues, but
          // it is the honest answer if nothing at all resolves.
          if (isGuardError(error)) guardError = error
          lastError = error
          stats.unresolved(route.exposed, attempt.leg)
          ctx.logger.warn(`dsh-model-relay: group "${route.exposed}" member ${JSON.stringify(attempt.leg)} did not resolve`)
          continue
        }
      }
      /**
       * Time this candidate has already spent waiting between retries.
       *
       * Per candidate, not per request: the budget exists so one unreachable
       * member cannot delay the next member, which may answer immediately.
       */
      let spentMs = 0
      for (let retry = 0; ; retry += 1) {
        // One attempt against this candidate. A retry counts again, so
        // "needed three asks" reads worse than "answered first try".
        if (route.group !== undefined) stats.attempt(route.exposed, attempt.leg)
        const options = await pruneUnsupportedEffort(bound, {
          ...baseOptions,
          provider: bound.provider,
          model: bound.model,
          // Carried through the adapter round trip so a composite cycle is
          // caught at the depth it actually occurs.
          [DISPATCH_DEPTH]: (baseOptions?.[DISPATCH_DEPTH] ?? 0) + 1,
          ...(signal === undefined ? {} : { signal }),
        }, signal, route.group !== undefined)
        const iterator = ctx.llm.stream(options)[Symbol.asyncIterator]()
        /**
         * Chunks read before the attempt proved itself, to be replayed to the
         * caller once it has.
         *
         * Reading ahead is safe only because these chunks carry no model output:
         * a `usage` chunk says nothing the client can observe, so an attempt that
         * produced one and then failed has still shown the caller nothing.
         */
        const buffered = []
        let committed = false
        /** The failure this attempt ended on, when it ended on one. */
        let failure
        try {
          for (;;) {
            const next = await iterator.next()
            if (next.done === true) {
              if (route.group !== undefined) { stats.answered(route.exposed, attempt.leg); noteServedLeg(attempt) }
              return { stream: resume(buffered, iterator), served: bound, leg: servedLeg }
            }
            const outcome = terminalOutcome(next.value)
            if (outcome !== undefined) {
              if (outcome === 'aborted' || committed) {
                // Either the caller cancelled, or output was already forwarded:
                // both are terminal for this call, so hand the chunk over.
                buffered.push(next.value)
                if (route.group !== undefined) {
                  // A cancellation is the caller giving up, not a verdict on
                  // the candidate. A committed failure is counted as ANSWERED
                  // on purpose: this path hands the attempt off as `resume(...)`
                  // and cannot see what happens next, so "did it answer" is the
                  // only question both paths can answer identically. See
                  // `lib/stats.js` for why that trade was taken.
                  if (outcome === 'aborted') stats.excused(route.exposed, attempt.leg)
                  else stats.answered(route.exposed, attempt.leg)
                }
                noteServedLeg(attempt)
                return { stream: resume(buffered, iterator), served: bound, leg: servedLeg }
              }
              failure = outcome
              lastError = new GatewayError(
                statusForFailure(outcome),
                outcome.message ?? 'the provider stream failed',
                'upstream_error',
                outcome.code ?? 'UPSTREAM_ERROR',
                outcome.providerRetryAfterMs,
              )
              break
            }
            buffered.push(next.value)
            if (COMMITTING_CHUNK_TYPES.has(next.value?.type)) committed = true
            // Once output has been seen the response is committed and there is no
            // fallback. Without a group there is nothing to fall back to either,
            // so the first chunk is handed over as before.
            if (committed || route.group === undefined) {
              if (committed && route.group !== undefined) { stats.answered(route.exposed, attempt.leg); noteServedLeg(attempt) }
              return { stream: resume(buffered, iterator), served: bound, leg: servedLeg }
            }
          }
        } catch (error) {
          lastError = error
          failure = error
        }
        // Only reached when this attempt died before producing any output.
        // Release it so its upstream connection is not left dangling; a broken
        // `return` must not mask the original failure.
        try {
          await iterator.return?.()
        } catch {
          // Ignored: the attempt already failed.
        }

        // This attempt died before producing output, so the candidate is the
        // one being judged. A failure that was not its fault (an oversized
        // request, a malformed body, a cancellation) is diverted to `ignored`
        // inside `stats.refused` and never enters the ratio.
        if (route.group !== undefined && !committed) {
          stats.refused(route.exposed, attempt.leg, failure?.code)
          // The /v1 failure now lands in the persisted store too — previously
          // only the DSH path recorded refusals, so failed /v1 calls vanished
          // from every chart.
          statsStore?.record({
            groupName: route.exposed,
            leg: attempt.leg,
            refused: true,
            lastCode: failure?.code,
            attempt: true,
          })
        }

        /**
         * Retry the SAME candidate after a rate limit, up to `retry429`.
         *
         * Only an uncommitted rate limit qualifies. Anything else — a dead
         * credential, an exhausted quota, a bad request — answers the same on
         * the second ask, so retrying would spend the caller's time to reach
         * the identical failure.
         */
        if (retry < retry429 && !committed && isRetryableRateLimit(failure)) {
          const wait = retryDelayMs(retry + 1, failure?.providerRetryAfterMs, spentMs)
          if (wait !== undefined) {
            if (route.group !== undefined) stats.rateLimited(route.exposed, attempt.leg)
            ctx.logger.warn(`dsh-model-relay: group "${route.exposed}" member ${JSON.stringify(bound.exposed)} was rate limited; retrying in ${wait}ms (attempt ${retry + 2})`)
            await sleep(wait, signal)
            if (signal?.aborted === true) throw lastError
            spentMs += wait
            continue
          }
          // The provider asked for a longer quiet period than this candidate's
          // budget allows, so waiting would cost the caller more than moving on.
          ctx.logger.warn(`dsh-model-relay: group "${route.exposed}" member ${JSON.stringify(bound.exposed)} asked to wait ${failure?.providerRetryAfterMs}ms; budget exceeded, trying the next candidate`)
        }
        break
      }
      if (route.group !== undefined && route.group.legs.length > 1) {
        ctx.logger.warn(`dsh-model-relay: group "${route.exposed}" member ${JSON.stringify(bound.exposed)} failed; trying the next`)
      }
    }
    // Every candidate failed. `lastError` may be undefined when the only
    // candidates were ones that never resolved, so the counter is recorded
    // before the throw either way.
    if (route.group !== undefined) stats.allFailed(route.exposed)
    throw guardError ?? lastError ?? new GatewayError(503, `group ${JSON.stringify(route.exposed)} has no usable candidates`, 'api_error', 'group_empty')
  }

  /**
   * Stream a group as a plain chunk iterator, for callers that are not HTTP.
   *
   * This is the same walk as {@link openStream}, expressed as a generator so
   * the DSH adapter can return it directly. Keeping one implementation is the
   * point: `/v1` and DSH must fail over identically, and the only reason
   * {@link openStream} exists separately is that it must surface the first
   * chunk to the HTTP layer *before* that layer commits a status code.
   *
   * ## The dispatch path is the third recursion path
   *
   * A composite member is `dsh-model-relay_<inner>`, which `resolveLeg` passes
   * through as a concrete pair; `ctx.llm.stream` then hands it back to this
   * gateway's adapter, which calls this function again for the inner group.
   * That round trip is the feature — it is what lets the inner group keep its
   * own strategy and retry budget instead of being flattened — but it is also
   * a cycle waiting to happen, so the depth travels on the options object (DSH
   * passes it through untouched) and is re-read here.
   *
   * @param groupName - the group to serve.
   * @param options - the assembled request, minus provider/model.
   */
  async function* streamGroup(groupName, options) {
    const group = await groupStore.get(groupName)
    if (group === undefined || !group.enabled) {
      throw new GatewayError(404, `the group \`${groupName}\` does not exist`, 'invalid_request_error', 'group_not_found')
    }
    const dispatchDepth = options?.[DISPATCH_DEPTH] ?? 0
    if (dispatchDepth > MAX_DISPATCH_DEPTH) {
      throw new GatewayError(
        500,
        `group \`${groupName}\` nests more than ${MAX_DISPATCH_DEPTH} levels of composite groups; this is a cycle`,
        'api_error',
        CODE_CYCLE,
      )
    }
    const legs = scheduleGroup(group)
    const retry429 = normalizeRetry429(group.retry429)
    const signal = options.signal
    /**
     * Whether this group may name other groups, which decides whether a bare
     * inner name is a legal member or a mistake. Same rule as `resolveRoute`,
     * applied here because this walk resolves members itself.
     */
    const allowGroupMember = normalizeKind(group.kind) === 'composite'
    stats.request(groupName)
    statsStore?.record({ groupName, request: true })
    let lastError
    /** The first recursion-guard failure, so it can outrank a generic empty group. */
    let guardError
    for (const leg of legs) {
      let bound
      try {
        bound = await resolveLeg(leg, signal, { allowGroupMember })
      } catch (error) {
        // Kept rather than discarded: see {@link openStream}. The walk still
        // continues, because a guard failure on one member says nothing about
        // the others, but if every member fails the guard reason is the honest
        // answer instead of a bare `group_empty`.
        if (isGuardError(error)) guardError = error
        lastError = error
        stats.unresolved(groupName, leg)
        ctx.logger.warn(`dsh-model-relay: group "${groupName}" member ${JSON.stringify(leg)} did not resolve`)
        continue
      }
      /**
       * Time this candidate has already spent waiting between retries.
       *
       * On this path there is an outer retry too — `dsh-llm-retry` runs in
       * the agent loop with its own budget — so this one is bounded tightly
       * and the two multiply. See the README's retry-amplification note.
       */
      let spentMs = 0
      for (let retry = 0; ; retry += 1) {
        // A retry is a separate attempt, exactly as on the `/v1` path.
        stats.attempt(groupName, leg)
        const dispatched = await pruneUnsupportedEffort(
          bound,
          {
            ...options,
            provider: bound.provider,
            model: bound.model,
            // Carried through the adapter round trip so a composite cycle is
            // caught at the depth it actually occurs, not one level later.
            [DISPATCH_DEPTH]: dispatchDepth + 1,
          },
          signal,
          true,
        )
        const iterator = ctx.llm.stream(dispatched)[Symbol.asyncIterator]()
        /**
         * Whether the consumer has been shown model output on this attempt.
         *
         * Only content counts. A `usage` chunk carries no output, so an attempt
         * that produced nothing but usage has still shown the caller nothing and
         * may be replaced.
         */
        let started = false
        /** Set when the attempt ended in a terminal chunk instead of a throw. */
        let sawFailure
        /** The same failure in the shape the retry judgement reads. */
        let failure
        // Usage merged across this attempt's frames; committed only when this
        // attempt is the one that finally serves (or has already committed).
        // A failed attempt's usage dies here - charging a failed attempt would
        // blame the wrong candidate.
        let pendingUsage
        // TTFT: clocked on the first TEXT chunk, not on commit - a stream that
        // opens with block-start would clock the pipeline, not the model.
        let firstTextAt
        const attemptStartedAt = Date.now()
        try {
          for (;;) {
            const next = await iterator.next()
            if (next.done === true) {
              // Only when nothing was committed: a stream that produced output
              // was already scored at its first committing chunk, and scoring
              // it again here would report more answers than attempts.
              if (!started) stats.answered(groupName, leg)
              stats.recordUsage(groupName, leg, pendingUsage)
              statsStore?.record({ groupName, leg, answered: true, usage: pendingUsage, attempt: true })
              return
            }
            const outcome = terminalOutcome(next.value)
            if (outcome !== undefined) {
              // A cancellation, or a failure after output was already forwarded,
              // is terminal for this call: hand the chunk to the consumer and
              // stop. Failing over would restart work the caller just cancelled,
              // or replay content it has already seen.
              if (outcome === 'aborted' || started) {
                // Unlike `openStream`, this path CAN see a post-output failure,
                // because control returns here on the next pull. It is still
                // counted as answered — which already happened at the first
                // committing chunk — so both paths report one definition:
                // "did this candidate answer". See `lib/stats.js`.
                //
                // The only case left to score here is a cancellation that
                // arrived before any output, which blames nobody.
                if (!started) stats.excused(groupName, leg)
                if (outcome !== 'aborted') {
                  stats.recordUsage(groupName, leg, pendingUsage)
                  statsStore?.record({ groupName, leg, answered: true, usage: pendingUsage, attempt: true })
                }
                yield next.value
                return
              }
              sawFailure = outcome
              failure = outcome
              break
            }
            if (next.value?.type === 'usage') {
              // TEMP DIAGNOSTIC (remove with its /v1 sibling): DSH-path control
              // sample of the same chunk shape.
              if ((globalThis.__relayUsageDiagDsh = (globalThis.__relayUsageDiagDsh ?? 0)) < 10) {
                globalThis.__relayUsageDiagDsh += 1
                ctx.logger.warn(`dsh-model-relay DIAG(dsh usage) json=${JSON.stringify(next.value.usage)?.slice(0, 300)}`)
              }
              if (pendingUsage === undefined) pendingUsage = {}
              for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'reasoningTokens']) {
                const value = next.value.usage?.[field]
                if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
                  pendingUsage[field] = Math.max(pendingUsage[field] ?? 0, Math.floor(value))
                }
              }
            }
            if ((next.value?.type === 'text-delta' || next.value?.type === 'reasoning-delta') && firstTextAt === undefined) {
              firstTextAt = Date.now()
              // A window too short to time, or a rate no model could sustain,
              // means frames were merged - not a real measurement. Mirror of
              // our-free-model's decodeWindow guardrail.
              const elapsed = firstTextAt - attemptStartedAt
              if (elapsed >= 250) stats.recordTtft(groupName, leg, elapsed)
            }
            if (COMMITTING_CHUNK_TYPES.has(next.value?.type) && !started) {
              started = true
              stats.answered(groupName, leg)
            }
            yield next.value
          }
        } catch (error) {
          // A cancellation that arrives as a throw is not a candidate failure
          // either — it is the caller giving up.
          if (signal?.aborted === true) {
            if (!started) stats.excused(groupName, leg)
            throw error
          }
          lastError = error
          failure = error
          // Once a chunk has been yielded the consumer has seen output; changing
          // members now would replay content, so the failure is final.
          if (started) {
            // Already scored as answered at the first committing chunk. This
            // path CAN tell a post-output failure from a clean finish, but
            // `openStream` cannot, so both report the same definition: the
            // candidate answered. See `lib/stats.js` for the trade.
            throw error
          }
        } finally {
          // Closing the attempt is what releases its upstream connection.
          // `ctx.llm.stream()` is lazy, so an iterator dropped without this would
          // leak one connection per failover. A broken `return` must not mask the
          // original failure.
          try {
            await iterator.return?.()
          } catch {
            // Ignored: the attempt already failed or already finished.
          }
        }
        if (sawFailure !== undefined) {
          lastError = new GatewayError(
            statusForFailure(sawFailure),
            sawFailure.message ?? 'the provider stream failed',
            'upstream_error',
            sawFailure.code ?? 'UPSTREAM_ERROR',
            sawFailure.providerRetryAfterMs,
          )
        }

        // This attempt ended before producing output, so the candidate is the
        // one being judged. A failure that was not its fault is diverted to
        // `ignored` inside `stats.refused` and never enters the ratio.
        if (!started) {
          stats.refused(groupName, leg, failure?.code)
          statsStore?.record({ groupName, leg, refused: true, lastCode: failure?.code, attempt: true })
        }

        // Same candidate, same reasoning as {@link openStream}: only an
        // uncommitted rate limit is worth asking again.
        if (retry < retry429 && !started && isRetryableRateLimit(failure)) {
          const wait = retryDelayMs(retry + 1, failure?.providerRetryAfterMs, spentMs)
          if (wait !== undefined) {
            stats.rateLimited(groupName, leg)
            ctx.logger.warn(`dsh-model-relay: group "${groupName}" member ${JSON.stringify(bound.exposed)} was rate limited; retrying in ${wait}ms (attempt ${retry + 2})`)
            await sleep(wait, signal)
            if (signal?.aborted === true) throw lastError
            spentMs += wait
            continue
          }
          ctx.logger.warn(`dsh-model-relay: group "${groupName}" member ${JSON.stringify(bound.exposed)} asked to wait ${failure?.providerRetryAfterMs}ms; budget exceeded, trying the next candidate`)
        }
        break
      }
      ctx.logger.warn(`dsh-model-relay: group "${groupName}" member ${JSON.stringify(bound.exposed)} failed; trying the next`)
    }
    stats.allFailed(groupName)
    throw guardError ?? lastError ?? new GatewayError(503, `group ${JSON.stringify(groupName)} has no usable candidates`, 'api_error', 'group_empty')
  }

  /**
   * Replay already-read chunks, then continue from the live iterator.
   *
   * {@link openStream} has to read past the first chunk to tell "this candidate
   * produced output" from "this candidate produced only bookkeeping and then
   * died", but every consumer is written against a single iterator. This
   * stitches the buffered prefix back in front so no consumer needs to know.
   * @param buffered - chunks already pulled from the iterator, in order.
   * @param iterator - the live iterator, positioned just past `buffered`.
   */
  async function* resume(buffered, iterator) {
    for (const chunk of buffered) yield chunk
    for (;;) {
      const next = await iterator.next()
      if (next.done === true) return
      yield next.value
    }
  }

  /** Handle `POST <base>/chat/completions`, streaming or buffered. */
  const handleCompletions = async (req, res, signal) => {
    const body = await readJson(req)
    const { route, options } = await buildOptions(body, signal)
    const stream = body.stream === true
    const id = `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`
    const created = Math.floor(Date.now() / 1000)

    // Resolve the candidate before committing to a status, so an immediate
    // credential or routing failure still answers with a real HTTP error. For a
    // group this also walks the candidate list, so a dead first candidate is
    // invisible to the client.
    let source
    let served
    let servedLeg
    /** Field-level max-merged usage for THIS call (frames may split usage). */
    let pendingUsage
    try {
      ;({ stream: source, served, leg: servedLeg } = await openStream(route, options, signal))
    } catch (error) {
      sendError(res, statusForError(error), errorMessage(error), 'upstream_error', error?.code, error?.providerRetryAfterMs)
      return
    }
    const iterator = source[Symbol.asyncIterator]()
    // Which member actually answered, for callers that route on the response.
    if (route.group !== undefined) {
      res.setHeader('x-relay-group', route.group.name)
      res.setHeader('x-relay-model', served.exposed)
    }

    if (!stream) {
      const accumulated = await accumulate(iterator, route.exposed)
      if (accumulated.error === undefined && route.group !== undefined) {
        // Non-streaming /v1: accumulate already parsed the usage frame. Charge
        // it to the stored-spelling leg that openStream recorded — the same
        // key the scoreboard's attempt/answered counters use.
        stats.recordUsage(route.exposed, servedLeg, accumulated.usage)
        statsStore?.record({
          groupName: route.exposed,
          leg: servedLeg,
          answered: true,
          usage: accumulated.usage,
          attempt: true,
        })
      }
      if (accumulated.error !== undefined) {
        sendError(
          res,
          accumulated.error.status,
          accumulated.error.message,
          'upstream_error',
          accumulated.error.code,
          accumulated.error.providerRetryAfterMs,
        )
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
    // TTFT: clocked on the first TEXT chunk (text-delta or reasoning-delta),
    // not on the first committing chunk — a stream that opens with block-start
    // would otherwise clock the chunk pipeline, not the model (design doc §8.1).
    const requestStartedAt = Date.now()
    let firstTextAt
    /** The one TTFT measurement this call produced, if any — passed to the store. */
    let ttftForStore

    const consume = async (chunk) => {
      switch (chunk.type) {
        case 'text-delta':
        case 'reasoning-delta':
          if (firstTextAt === undefined) {
            firstTextAt = Date.now()
            // Same guardrail as the DSH path: a window too short to time means
            // frames were merged, not a real measurement (§8.2, MIN_DECODE-like
            // floor at 250ms).
            const elapsed = firstTextAt - requestStartedAt
            if (elapsed >= 250 && servedLeg !== undefined) {
              stats.recordTtft(route.exposed, servedLeg, elapsed)
              ttftForStore = elapsed
            }
          }
          write(chunk.type === 'text-delta'
            ? envelope({ content: chunk.text }, null)
            : envelope({ reasoning_content: chunk.text }, null))
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
        case 'usage': {
          // TEMP DIAGNOSTIC (remove after the outer-token bug is located):
          // captures the raw usage shape the /v1 consume actually receives.
          if ((globalThis.__relayUsageDiag = (globalThis.__relayUsageDiag ?? 0)) < 10) {
            globalThis.__relayUsageDiag += 1
            ctx.logger.warn(`dsh-model-relay DIAG(v1 usage) keys=${JSON.stringify(Object.keys(chunk.usage ?? {}))} json=${JSON.stringify(chunk.usage)?.slice(0, 300)}`)
          }
          usage = toOpenAiUsage(chunk.usage, route.exposed)
          // Field-level max merge: streaming usage arrives split across frames,
          // and a later frame must never LOWER an earlier field's value.
          if (pendingUsage === undefined) pendingUsage = {}
          for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'reasoningTokens']) {
            const value = chunk.usage?.[field]
            if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
              pendingUsage[field] = Math.max(pendingUsage[field] ?? 0, Math.floor(value))
            }
          }
          break
        }
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
        const next = await iterator.next()
        if (next.done === true) break
        await consume(next.value)
      }
      write(envelope({}, finishReason))
      if (usage !== undefined) write({ id, object: 'chat.completion.chunk', created, model: route.exposed, choices: [], usage })
      // Commit the call's merged usage to the candidate that finally served.
      // A stream that errored is charged too when usage arrived before the
      // failure: the tokens were really spent. NOT charged on abort — an abort
      // is "not the candidate's fault" by the scoreboard's own convention.
      if (route.group !== undefined && servedLeg !== undefined && failed === undefined) {
        // TEMP DIAGNOSTIC (remove with siblings): the value actually committed.
        if ((globalThis.__relayUsageDiagCommit = (globalThis.__relayUsageDiagCommit ?? 0)) < 10) {
          globalThis.__relayUsageDiagCommit += 1
          ctx.logger.warn(`dsh-model-relay DIAG(v1 commit) leg=${servedLeg} pendingUsage=${JSON.stringify(pendingUsage)}`)
        }
        stats.recordUsage(route.exposed, servedLeg, pendingUsage)
        statsStore?.record({
          groupName: route.exposed,
          leg: servedLeg,
          answered: true,
          usage: pendingUsage,
          ttft: ttftForStore,
          attempt: true,
        })
      }
      // `providerRetryAfterMs` is an internal routing hint, not an OpenAI field,
      // so it must not reach the wire. Streaming cannot carry the hint at all:
      // SSE commits a 200 with the first chunk, so `Retry-After` is impossible
      // here — and a client that already received part of a stream cannot
      // meaningfully retry this response anyway.
      if (failed !== undefined) write({ error: withoutRetryHint(failed) })
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
   * Register this gateway as a DSH provider, so a model group is selectable
   * inside DSH and not only over `/v1`.
   *
   * Three registrations are needed together, and the third is the one that is
   * easy to miss:
   *  1. the provider directory entry, which names the route;
   *  2. the adapter, which turns a group name into a stream;
   *  3. a settings section under the entry's namespace.
   *
   * Without (3) the Models settings page silently omits the card: it renders a
   * provider row only when that row's namespace resolves in the settings
   * mirror, joining `listProviders()` against the configurable directory by
   * namespace. The section is an empty schema on purpose — the real controls
   * live in this plugin's own settings page, not there.
   *
   * Everything here is best-effort. A composition without `llm` (a unit test,
   * or a headless host) must still get a working `/v1`, so a failure is logged
   * and the gateway carries on.
   */
  if (ctx.llm === undefined) {
    ctx.logger.info('dsh-model-relay: llm service not available — groups will not appear in DSH itself')
  } else {
    try {
      const adapter = new RelayAdapter({
        providerId: RELAY_PROVIDER_ID,
        providerName: RELAY_PROVIDER_NAME,
        listGroups: () => groupStore.all(),
        groupCapabilities: (models, signal, groupName) => cachedGroupCapabilities(models, signal, groupName),
        streamGroup: (groupName, options) => streamGroup(groupName, options),
        logger: ctx.logger,
      })
      const providerRegistration = ctx.llm.registerConfigurableProviders([{
        provider: RELAY_PROVIDER_ID,
        displayName: RELAY_PROVIDER_NAME,
        settingsNs: RELAY_SETTINGS_NS,
        settingsPath: [],
      }])
      const adapterRegistration = ctx.llm.registerAdapter([RELAY_PROVIDER_ID], adapter)
      ctx.effect(() => () => {
        adapterRegistration()
        providerRegistration()
      })
      ctx.inject(['settings'], (settingsCtx) => {
        const settings = settingsCtx.get('settings')
        if (settings === undefined) {
          ctx.logger.warn(`dsh-model-relay: settings service absent — the ${RELAY_PROVIDER_NAME} card may not render`)
          return
        }
        settings.installSection(ctx, RELAY_SETTINGS_NS, Schema.object({}), {}, {
          setSource: () => {},
          onChange: () => {},
        })
      })
      ctx.logger.info(`dsh-model-relay: registered DSH provider "${RELAY_PROVIDER_ID}" (models = model groups)`)
    } catch (error) {
      ctx.logger.warn(`dsh-model-relay: could not register the DSH provider; groups stay reachable over ${base} only`)
      ctx.logger.warn(error)
    }
  }

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
          groupsFile,
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
      case 'listGroups': {
        return ok({
          groups: await groupStore.all(),
          /**
           * Live per-candidate counters, keyed by group name.
           *
           * Rides the group listing rather than a channel of its own: the page
           * already fetches this on mount and after every edit, so the
           * scoreboard costs no extra round trip and needs no new transport.
           * The page's refresh button re-reads exactly this.
           */
          stats: stats.snapshot(),
        statsHistory: statsStore?.snapshot(),
          groupsFile,
          /**
           * Every model a group may name, in the same catalog the model
           * listing uses. The settings page renders its picker from this, so
           * a member is always spelled exactly as the gateway advertises it.
           *
           * `selectable` says which kind of group may name this entry, and it
           * has three values rather than two because the catalog carries a
           * group under BOTH spellings:
           *
           *  - `model` — a concrete provider model. A `model` group's member.
           *  - `composite-member` — `dsh-model-relay_<group>`, the spelling a
           *    composite must use. Only this one is selectable there.
           *  - `group-name` — the bare group name. Offered to NOBODY: as a
           *    member it would resolve to that group's first leg and drop its
           *    scheduling, which the runtime refuses anyway. Listing it as
           *    selectable would be offering a value guaranteed to be rejected.
           */
          models: (await listCatalog()).map((entry) => ({
            id: entry.id,
            name: entry.name,
            provider: entry.provider,
            selectable: entry.provider !== RELAY_PROVIDER_ID
              ? 'model'
              : entry.id.startsWith(MEMBER_PREFIX) ? 'composite-member' : 'group-name',
          })),
        })
      }
      case 'createGroup': {
        const name = typeof payload?.name === 'string' ? payload.name : ''
        const models = Array.isArray(payload?.models) ? payload.models : []
        const result = await groupStore.create(name, models, {
          ...(typeof payload?.kind === 'string' ? { kind: payload.kind } : {}),
          ...(typeof payload?.strategy === 'string' ? { strategy: payload.strategy } : {}),
          ...(typeof payload?.retry429 === 'number' ? { retry429: payload.retry429 } : {}),
        })
        if (!result.ok) return err('INVALID_GROUP', result.error)
        capabilityCache.clear()
        memberEffortCache.clear()
        groupCursors.clear()
        ctx.logger.info(`dsh-model-relay: created model group ${JSON.stringify(result.group.name)} (${result.group.kind}, ${result.group.models.length} candidates, ${result.group.strategy}, retry429=${result.group.retry429})`)
        return ok({ group: result.group })
      }
      case 'updateGroup': {
        const id = typeof payload?.id === 'string' ? payload.id : ''
        if (id === '') return err('INVALID_REQUEST', 'updateGroup requires a group id')
        const result = await groupStore.update(id, {
          ...(Array.isArray(payload?.models) ? { models: payload.models } : {}),
          ...(typeof payload?.name === 'string' ? { name: payload.name } : {}),
          ...(typeof payload?.enabled === 'boolean' ? { enabled: payload.enabled } : {}),
          ...(typeof payload?.strategy === 'string' ? { strategy: payload.strategy } : {}),
          ...(typeof payload?.retry429 === 'number' ? { retry429: payload.retry429 } : {}),
        })
        if (!result.ok) return err('INVALID_GROUP', result.error)
        capabilityCache.clear()
        memberEffortCache.clear()
        // A rotation over a candidate list that just changed means nothing.
        groupCursors.clear()
        // Renaming or deleting a group can invalidate a composite that points
        // at it, so the change is reported rather than silently leaving a
        // dangling reference for the next request to trip over.
        const staleNow = await groupStore.all()
        const stale = staleNow.filter((group) => group.dangling.length > 0)
        if (stale.length > 0) {
          ctx.logger.warn(`dsh-model-relay: ${stale.length} composite group(s) now reference a missing or non-model group: ${stale.map((group) => group.name).join(', ')}`)
        }
        // The scoreboard follows the group, not the name: a rename carries the
        // history over, and a changed candidate list drops only the members
        // that are gone. Editing a group is not evidence about its members, so
        // nothing here resets a counter.
        const renamed = typeof payload?.name === 'string' ? payload.name.trim() : undefined
        if (renamed !== undefined && renamed !== '' && renamed !== id) {
          stats.rename(id, renamed)
          statsStore?.renameGroup(id, renamed)
        }
        if (Array.isArray(payload?.models)) {
          stats.reconcile(renamed ?? id, payload.models)
          statsStore?.reconcileGroup(renamed ?? id, payload.models)
        }
        ctx.logger.info(`dsh-model-relay: updated model group ${JSON.stringify(id)}`)
        return ok({ id })
      }
      case 'removeGroup': {
        const id = typeof payload?.id === 'string' ? payload.id : ''
        if (id === '') return err('INVALID_REQUEST', 'removeGroup requires a group id')
        // Deleting a group that a composite points at is allowed — refusing
        // would make an inner group undeletable, which is worse than a visible
        // stale reference. The composites are reported instead, and the page
        // marks them so the user can fix them.
        const before = await groupStore.all()
        const referrers = referrersOf(id, before)
        const removed = await groupStore.remove(id)
        if (!removed) return err('NOT_FOUND', 'no such group')
        capabilityCache.clear()
        memberEffortCache.clear()
        groupCursors.delete(id)
        // The group is gone, so its scoreboard would never be read again.
        stats.forget(id)
        statsStore?.forgetGroup(id)
        if (referrers.length > 0) {
          ctx.logger.warn(`dsh-model-relay: removed model group ${JSON.stringify(id)}, which ${referrers.length} composite group(s) still reference: ${referrers.join(', ')}`)
        }
        ctx.logger.info(`dsh-model-relay: removed model group ${JSON.stringify(id)}`)
        return ok({ id, referrers })
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
async function accumulate(iterator, model) {
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

  for (;;) {
    const current = await iterator.next()
    if (current.done === true) break
    consume(current.value)
  }
  return { text, reasoning, toolCalls, usage, finishReason, error }
}

export { resolveConfig }
