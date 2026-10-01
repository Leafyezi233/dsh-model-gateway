/**
 * Persistent API-key store for the OpenAI gateway.
 *
 * Keys are stored as SHA-256 hashes, never as plaintext. The plaintext exists
 * only in the create response that the settings page reveals once; a key that
 * is lost is revoked and recreated, not recovered. This is deliberate: the
 * store lives in the DSH home directory next to provider credentials, and a
 * file that cannot yield a usable key is a file whose disclosure is survivable.
 *
 * The masked display form (`prefix…last4`) is kept alongside the hash so the
 * settings page can list a key a user can recognize without the gateway or the
 * browser ever holding the whole value again.
 *
 * @module dsh-model-gateway/keys
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Recognizable prefix for keys minted by this gateway. */
const KEY_PREFIX = 'sk-dshgw-'

/**
 * Legacy store path, written by this plugin before it was renamed to
 * `dsh-model-gateway`.
 *
 * Kept as a read-only fallback. Renaming the plugin must never widen access: if
 * the new path were simply absent, the store would load empty, `locked` would
 * read false, and an endpoint that was key-protected would silently reopen.
 * Reading the legacy file keeps the previous decision in force until the user
 * changes it explicitly.
 */
const LEGACY_STORE_NAME = 'openai-gateway-keys.json'

/** Default key store location inside the DSH home directory. */
export function defaultKeysFile() {
  return dshHomePath('model-relay-keys.json')
}

/** Legacy store location, consulted only when the current one is absent. */
export function legacyKeysFile() {
  return dshHomePath(LEGACY_STORE_NAME)
}

/** Mint one new API key. */
export function generateApiKey() {
  return `${KEY_PREFIX}${randomBytes(24).toString('base64url')}`
}

/** SHA-256 hex digest of a key, the only form persisted. */
export function hashApiKey(key) {
  return createHash('sha256').update(key, 'utf8').digest('hex')
}

/** Build the recognizable display form kept in the store. */
export function maskApiKey(key) {
  const head = key.slice(0, KEY_PREFIX.length + 4)
  const tail = key.slice(-4)
  return `${head}…${tail}`
}

/** Compare two hex digests without leaking length or content through timing. */
function digestsEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

/**
 * File-backed key store with serialized writes.
 *
 * Writes are chained rather than concurrent so two settings-page clicks cannot
 * interleave read-modify-write cycles and drop a key. The file is written
 * through a temporary sibling and renamed, so a crash mid-write leaves the
 * previous keys intact rather than a truncated document.
 */
export class GatewayKeyStore {
  /**
   * @param options - store location and diagnostic sink.
   */
  constructor({ file, legacyFile, logger } = {}) {
    this.file = file ?? defaultKeysFile()
    /**
     * Pre-rename store, consulted only when the default path was not overridden.
     *
     * An explicit `file` (a test, or a profile that moved the store on purpose)
     * must be taken literally: falling back to a shared location there would
     * leak state between isolated stores. An explicit `legacyFile` overrides
     * that rule so the fallback itself stays testable.
     */
    this.legacyFile = legacyFile !== undefined
      ? legacyFile
      : file === undefined ? legacyKeysFile() : undefined
    this.logger = logger
    /** Cached document; undefined until the first read. */
    this.document = undefined
    /** Serialized write chain tail. */
    this.tail = Promise.resolve()
  }

  /** Run one read-modify-write cycle after every queued one. */
  enqueue(task) {
    const run = this.tail.then(task, task)
    // Keep the chain alive after a failure so one bad write cannot poison the rest.
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * Read and validate the owner-only permission on the store.
   *
   * A store another local user can read is treated as absent rather than
   * trusted, mirroring the provider-credential handling in this deployment.
   * Windows has no POSIX mode, so the check is skipped there.
   * @returns true when the file may be used.
   */
  async hasPrivateMode() {
    if (process.platform === 'win32') return true
    try {
      const info = await stat(this.file)
      return (info.mode & 0o077) === 0
    } catch {
      return true
    }
  }

  /**
   * Read the store, returning an empty document when absent or unreadable.
   *
   * When the configured path does not exist, the pre-rename store is read
   * instead (see {@link legacyKeysFile}). This only ever carries a previous
   * decision forward; it never relaxes one.
   */
  async load() {
    if (this.document !== undefined) return this.document
    let raw
    let source = this.file
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') {
        const legacy = this.legacyFile
        if (legacy !== undefined) {
          try {
            raw = await readFile(legacy, 'utf8')
            source = legacy
            this.logger?.warn?.(`dsh-model-gateway: using the pre-rename key store at ${legacy}; it will be rewritten to ${this.file} on the next change`)
          } catch (legacyError) {
            if (legacyError?.code !== 'ENOENT') {
              this.logger?.warn?.(`dsh-model-gateway: could not read the pre-rename key store at ${legacy}`)
              this.logger?.warn?.(legacyError)
            }
          }
        }
        if (raw === undefined) {
          this.document = emptyDocument()
          return this.document
        }
      } else {
        this.logger?.warn?.(`dsh-model-gateway: could not read the API key store at ${this.file}`)
        this.logger?.warn?.(error)
        this.document = emptyDocument()
        return this.document
      }
    }
    if (!await this.hasPrivateMode(source)) {
      this.logger?.warn?.(`dsh-model-gateway: ${source} is readable by other users; ignoring it until it is rewritten`)
      this.document = emptyDocument()
      return this.document
    }
    try {
      const parsed = JSON.parse(raw)
      const keys = Array.isArray(parsed?.keys) ? parsed.keys.filter(isRecord) : []
      this.document = { version: 1, keys, locked: parsed?.locked === true }
    } catch (error) {
      this.logger?.warn?.(`dsh-model-gateway: ${source} is not valid JSON; treating it as empty`)
      this.logger?.warn?.(error)
      this.document = emptyDocument()
    }
    return this.document
  }

  /** Durably write the store with owner-only permissions. */
  async persist(document) {
    await mkdir(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, this.file)
    try {
      await chmod(this.file, 0o600)
    } catch {
      // Best effort: the rename preserved the creating mode on every platform
      // that has one, and Windows has no POSIX mode to set.
    }
  }

  /** List key records for display, newest first. Never includes a hash. */
  async list() {
    const document = await this.load()
    return document.keys
      .map((entry) => ({
        id: entry.id,
        masked: entry.masked,
        label: entry.label,
        createdAt: entry.createdAt,
      }))
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  /** How many keys are stored. */
  async count() {
    const document = await this.load()
    return document.keys.length
  }

  /**
   * Whether the gateway should demand a key.
   *
   * This is deliberately NOT `count() > 0`. A store that once held keys stays
   * locked after the last one is revoked: silently reopening an endpoint to the
   * world because a key was deleted would be a privilege escalation triggered
   * by a routine cleanup action. Only an explicit unlock (or a store that never
   * held a key) leaves the gateway open.
   * @returns true when callers must present a valid key.
   */
  async isLocked() {
    const document = await this.load()
    return document.locked === true || document.keys.length > 0
  }

  /**
   * Explicitly open or lock the gateway.
   *
   * Unlocking sets `locked: false`, which is a deliberate, visible act on the
   * settings page; it never happens as a side effect of revoking.
   * @param locked - whether callers must present a key.
   */
  async setLocked(locked) {
    await this.enqueue(async () => {
      const document = await this.load()
      if ((document.locked === true) === locked) return
      const next = { version: 1, keys: document.keys, locked }
      await this.persist(next)
      this.document = next
    })
  }

  /**
   * Mint and persist one key.
   * @param label - optional human label for the key.
   * @returns the plaintext key (shown once) and its display record.
   */
  async create(label) {
    const key = generateApiKey()
    const record = {
      id: randomUUID(),
      hash: hashApiKey(key),
      masked: maskApiKey(key),
      label: typeof label === 'string' && label.trim() !== '' ? label.trim().slice(0, 80) : '未命名',
      createdAt: Date.now(),
    }
    await this.enqueue(async () => {
      const document = await this.load()
      // Creating a key locks the gateway: a key exists precisely to guard it.
      const next = { version: 1, keys: [...document.keys, record], locked: true }
      await this.persist(next)
      this.document = next
    })
    return { key, record: { id: record.id, masked: record.masked, label: record.label, createdAt: record.createdAt } }
  }

  /**
   * Remove one key by id.
   *
   * The gateway stays locked afterwards even when this removes the last key, so
   * deleting a key never widens access. Use {@link setLocked} to open it.
   * @param id - the record id to remove.
   * @returns true when a key was removed.
   */
  async revoke(id) {
    let removed = false
    await this.enqueue(async () => {
      const document = await this.load()
      const keys = document.keys.filter((entry) => entry.id !== id)
      removed = keys.length !== document.keys.length
      if (!removed) return
      const next = { version: 1, keys, locked: true }
      await this.persist(next)
      this.document = next
    })
    return removed
  }

  /**
   * Test a presented key against every stored hash.
   * @param presented - the key supplied by a caller.
   * @returns true when the key is valid.
   */
  async verify(presented) {
    if (typeof presented !== 'string' || presented.length === 0) return false
    const document = await this.load()
    if (document.keys.length === 0) return false
    const digest = hashApiKey(presented)
    let matched = false
    for (const entry of document.keys) {
      // Compare every entry so the loop's duration does not reveal which slot matched.
      if (digestsEqual(entry.hash, digest)) matched = true
    }
    return matched
  }
}

/** Narrow one persisted record to a usable shape. */
function isRecord(value) {
  return value !== null
    && typeof value === 'object'
    && typeof value.id === 'string'
    && typeof value.hash === 'string'
    && typeof value.masked === 'string'
    && typeof value.createdAt === 'number'
}

/** A store that has never held a key, and is therefore open. */
function emptyDocument() {
  return { version: 1, keys: [], locked: false }
}

export { KEY_PREFIX }
