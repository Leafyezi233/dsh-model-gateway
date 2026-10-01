/**
 * Persistent model-group store for the OpenAI gateway.
 *
 * A group is a named list of models the gateway already exposes. A caller that
 * names the group gets the first candidate that answers; the rest are
 * fallbacks. Routing *within* a group is the order of that list plus two
 * scheduling knobs. There are deliberately no conditions and no weights.
 *
 * ## Two kinds of group
 *
 * A group carries an explicit `kind`, and the kind decides what its candidate
 * list may hold:
 *
 *  - `model` (the default, and what every group written before this existed
 *    is): every candidate is a concrete model. A candidate that names another
 *    group is REFUSED, because resolving it would silently flatten that group
 *    to its first leg and drop its scheduling.
 *  - `composite`: every candidate is `dsh-model-gateway_<group>`, naming a
 *    `model` group. Dispatching such a candidate hands it back to this same
 *    gateway through DSH's own llm service, so the inner group runs its OWN
 *    strategy and retry budget rather than being flattened.
 *
 * The kind is a stored field rather than a naming convention on purpose. A name
 * prefix is a rule a user satisfies by accident — any group called
 * `nested-foo` would silently become able to contain groups — and it leaves
 * "is this a group or a model?" undecidable without a lookup. A field answers
 * that statically.
 *
 * Because a `composite` may only contain `model` groups, the reference graph
 * is bipartite and a cycle is a type error, not merely a runtime hazard. The
 * guards in `index.js` cover the paths a hand-edited file can still take.
 *
 * The two knobs are orthogonal (see `strategy.js`): `strategy` decides the
 * order candidates are tried in, and `retry429` decides how many times one
 * candidate is retried after a rate limit. Both default to today's behavior —
 * sequential, no retry — so a document written before they existed keeps
 * working unchanged.
 *
 * Model entries are stored in the gateway's own exposed spelling
 * (`<provider>_<model>`, see `exposedModelId` in `index.js`), not in some new
 * format. That is what lets the router resolve a group's candidates with the
 * exact same code path it uses for a directly-named model.
 *
 * Storage lives beside the key store but in its own file. The key store's
 * owner-only permission rule exists because that file is a credential store;
 * group definitions carry no such secret and folding them in would blur that
 * rule for no benefit.
 *
 * @module dsh-model-gateway/groups
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { DEFAULT_STRATEGY, normalizeRetry429, normalizeStrategy } from './strategy.js'

/**
 * Characters a group name may use.
 *
 * The underscore is deliberately excluded. Every exposed model id is
 * `<provider>_<model>`, so a name without an underscore can never collide with
 * a model id — the two namespaces stay disjoint without any precedence rule.
 * A leading character must be alphanumeric so a name is never mistakable for a
 * flag or a path fragment.
 */
const GROUP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]*$/

/** Longest accepted group name, so a listing stays readable. */
const MAX_NAME_LENGTH = 64

/** Most candidates one group may hold. */
const MAX_MODELS = 32

/**
 * The provider route this gateway registers for itself.
 *
 * Declared here, not in `index.js`, because this module has to recognise a group
 * reference inside a candidate list and `index.js` imports this module —
 * importing back would be a cycle. `index.js` uses THIS constant as its
 * `RELAY_PROVIDER_ID` rather than repeating the literal, so the two cannot drift.
 */
export const RELAY_MEMBER_PROVIDER = 'dsh-model-gateway'

/** Prefix that marks a candidate as "another group" rather than a concrete model. */
export const MEMBER_PREFIX = RELAY_MEMBER_PROVIDER + '_'

/** Every accepted group kind. Anything else degrades to `model`. */
export const GROUP_KINDS = ['model', 'composite']

/**
 * The kind a group gets when nothing usable was stored.
 *
 * `model` is the safe direction, and it is the same value a new group gets, so
 * there is no asymmetry to remember. Degrading to `composite` instead would
 * GRANT the ability to contain groups to a group whose kind could not be read —
 * which is exactly the capability a hand-edited file would want to abuse.
 */
export const DEFAULT_KIND = 'model'

/**
 * Coerce a stored kind to one this module implements.
 * @param value - whatever the group document held.
 * @returns a member of {@link GROUP_KINDS}.
 */
export function normalizeKind(value) {
  return GROUP_KINDS.includes(value) ? value : DEFAULT_KIND
}

/**
 * The group a candidate refers to, or undefined when it names no group.
 *
 * A group name may never contain an underscore and the prefix ends with one, so
 * a candidate starting with the prefix is unambiguous: it cannot also be a
 * legal group name.
 * @param candidate - one entry from a candidate list.
 */
export function innerGroupNameOf(candidate) {
  if (typeof candidate !== 'string' || !candidate.startsWith(MEMBER_PREFIX)) return undefined
  const inner = candidate.slice(MEMBER_PREFIX.length)
  return inner === '' ? undefined : inner
}

/**
 * Validate a candidate list against the kind of the group that would hold it.
 *
 * Called on both `create` and `update`, and that is the point: the reference
 * graph is built one edge at a time, so refusing a bad edge where it is saved
 * makes a cycle unreachable from the settings page. A hand-edited file can still
 * hold one, which is what the runtime guards in `index.js` are for.
 *
 * @param kind - the kind of the group being saved.
 * @param candidates - the candidate list, already trimmed.
 * @param groups - every group currently stored.
 * @param selfName - the name being saved, so a self-reference is caught.
 * @returns a reason to refuse, or undefined when the list is acceptable.
 */
function validateMembers(kind, candidates, groups, selfName) {
  for (const candidate of candidates) {
    if (kind === 'composite') {
      const inner = innerGroupNameOf(candidate)
      if (inner === undefined) {
        return '组合分组的成员必须写成 ' + MEMBER_PREFIX + '<分组名>，收到 ' + JSON.stringify(candidate) + '。裸名只会解析出那个分组的第一条腿，内层调度会丢'
      }
      if (inner === selfName) return '组合分组不能包含自己（' + JSON.stringify(selfName) + '）'
      const target = groups.find((group) => group.name === inner)
      if (target === undefined) {
        return '组合分组的成员 ' + JSON.stringify(inner) + ' 不是已存在的分组，请先创建它'
      }
      if (target.kind !== 'model') {
        return '组合分组的成员必须是普通分组，' + JSON.stringify(inner) + ' 本身是组合分组'
      }
      continue
    }
    // kind === 'model': a candidate naming any group is refused.
    if (groups.some((group) => group.name === candidate)) {
      return '普通分组的成员不能是分组名（' + JSON.stringify(candidate) + '）。要引用分组，请把它建成组合分组'
    }
  }
  return undefined
}

/**
 * The candidates of a composite that no longer resolve.
 *
 * A composite is not rewritten when the group it points at is renamed, deleted,
 * or turned into a composite, so it can go stale. Detecting that on read keeps
 * the document free of cross-references that could disagree with it, and lets
 * the settings page show the problem instead of the user meeting it as a
 * mysterious failover.
 *
 * @param group - one stored group.
 * @param groups - every group currently stored.
 * @returns the dangling candidates, in stored order; empty for a `model` group.
 */
export function danglingMembers(group, groups) {
  if (group?.kind !== 'composite') return []
  const byName = new Map(groups.map((entry) => [entry.name, entry]))
  return group.models.filter((candidate) => {
    const inner = innerGroupNameOf(candidate)
    if (inner === undefined) return true
    const target = byName.get(inner)
    return target === undefined || target.kind !== 'model'
  })
}

/**
 * Which composites point at one group.
 *
 * The store keeps no reverse index: a document is a list of groups and every
 * lookup is by name. Scanning is fine at this size (each group holds at most
 * `MAX_MODELS` candidates) and keeps the file free of derived state that could
 * disagree with it.
 *
 * @param name - the group being pointed at.
 * @param groups - every group currently stored.
 * @returns the names of the composites that reference it.
 */
export function referrersOf(name, groups) {
  const spelled = MEMBER_PREFIX + name
  return groups
    .filter((group) => group.kind === 'composite' && group.models.includes(spelled))
    .map((group) => group.name)
}

/** Default group store location inside the DSH home directory. */
export function defaultGroupsFile() {
  return dshHomePath('model-relay-groups.json')
}

/** Whether a string is usable as a group name. */
export function isValidGroupName(name) {
  return typeof name === 'string'
    && name.length > 0
    && name.length <= MAX_NAME_LENGTH
    && GROUP_NAME_PATTERN.test(name)
}

/**
 * Current document schema version.
 *
 * Purely descriptive: `load` never reads it, so an older plugin reading a
 * newer file ignores the extra fields and a newer plugin reading an older file
 * supplies the defaults. It is not a gate.
 */
const DOCUMENT_VERSION = 3

/** An empty document, used when the file is absent or unusable. */
function emptyDocument() {
  return { version: DOCUMENT_VERSION, groups: [] }
}

/** Whether a value is a plain object, so a parsed entry can be inspected. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Normalize one stored entry, or return undefined when it cannot be salvaged.
 *
 * A group whose name or candidate list is unusable is dropped rather than
 * repaired: inventing a name or an empty candidate list would produce a group
 * that can never serve a request, which is worse than its absence.
 */
function normalizeStoredGroup(raw) {
  if (!isRecord(raw)) return undefined
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!isValidGroupName(name)) return undefined
  const models = Array.isArray(raw.models)
    ? raw.models.filter((model) => typeof model === 'string' && model.trim() !== '').map((model) => model.trim())
    : []
  if (models.length === 0) return undefined
  return {
    id: name,
    name,
    models: models.slice(0, MAX_MODELS),
    enabled: raw.enabled !== false,
    /**
     * Which kind of group this is. Normalized rather than trusted: an unknown
     * value degrades to `model`, which is the direction that cannot grant the
     * ability to contain groups to a document that failed to declare itself.
     */
    kind: normalizeKind(raw.kind),
    // An unusable scheduling value degrades to the default rather than
    // discarding the group: the candidate list is the valuable part, and a
    // preference is not worth losing a working group over.
    strategy: normalizeStrategy(raw.strategy),
    retry429: normalizeRetry429(raw.retry429),
  }
}

/**
 * File-backed group store with serialized writes.
 *
 * Mirrors the key store's write discipline for the same reason: two settings
 * page clicks must not interleave read-modify-write cycles and drop a group,
 * and a crash mid-write must leave the previous definition intact rather than
 * a truncated document.
 */
export class GatewayGroupStore {
  /**
   * @param options - store location and diagnostic sink.
   */
  constructor({ file, logger } = {}) {
    this.file = file ?? defaultGroupsFile()
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
   * Read the store, returning an empty document when absent or unreadable.
   *
   * Unlike the key store this file is not permission-gated: it holds routing
   * preferences, and treating a group definition as hostile because another
   * local user can read it would disable the feature for no gain.
   */
  async load() {
    if (this.document !== undefined) return this.document
    let raw
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.logger?.warn?.(`dsh-model-gateway: could not read the group store at ${this.file}`)
        this.logger?.warn?.(error)
      }
      this.document = emptyDocument()
      return this.document
    }
    try {
      const parsed = JSON.parse(raw)
      const groups = Array.isArray(parsed?.groups)
        ? parsed.groups.map(normalizeStoredGroup).filter((group) => group !== undefined)
        : []
      this.document = { version: DOCUMENT_VERSION, groups }
    } catch (error) {
      this.logger?.warn?.(`dsh-model-gateway: ${this.file} is not valid JSON; treating it as empty`)
      this.logger?.warn?.(error)
      this.document = emptyDocument()
    }
    return this.document
  }

  /** Durably write the store. */
  async persist(document) {
    await mkdir(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    await rename(temporary, this.file)
  }

  /**
   * Every group, in insertion order, each carrying its stale references.
   *
   * `dangling` is derived on every read rather than stored, so it can never
   * disagree with the document it describes. It is part of the returned shape
   * (rather than something the caller computes) because both the settings page
   * and the gateway's own logging want it.
   */
  async all() {
    const document = await this.load()
    return document.groups.map((group) => ({
      ...group,
      models: [...group.models],
      dangling: danglingMembers(group, document.groups),
    }))
  }

  /**
   * Look one group up by name (a group's id is always its name).
   *
   * Carries `dangling` for the same reason {@link GatewayGroupStore#all}
   * does: the shape a caller gets must not depend on which accessor it used.
   */
  async get(name) {
    if (typeof name !== 'string' || name === '') return undefined
    const document = await this.load()
    const hit = document.groups.find((group) => group.name === name)
    if (hit === undefined) return undefined
    return { ...hit, models: [...hit.models], dangling: danglingMembers(hit, document.groups) }
  }

  /**
   * Create a group.
   *
   * Validation failures are reported rather than thrown so the settings page
   * can surface the reason; a caller that ignores the result still cannot store
   * an unusable group.
   * @param name - the group name, also its id.
   * @param models - ordered candidate list in exposed model spelling.
   * @param options - `{ kind, strategy, retry429 }`; `kind` defaults to `model`.
   * @returns `{ ok: true, group }` or `{ ok: false, error }`.
   */
  async create(name, models, options = {}) {
    const clean = typeof name === 'string' ? name.trim() : ''
    if (!isValidGroupName(clean)) {
      return { ok: false, error: '分组名只能含字母、数字、- 和 .，且不能含下划线（下划线是模型名的分隔符）' }
    }
    const kind = normalizeKind(options.kind)
    const candidates = Array.isArray(models)
      ? models.filter((model) => typeof model === 'string' && model.trim() !== '').map((model) => model.trim())
      : []
    if (candidates.length === 0) return { ok: false, error: '至少需要一个候选模型' }
    if (candidates.length > MAX_MODELS) return { ok: false, error: `候选模型最多 ${MAX_MODELS} 个` }
    let failure
    await this.enqueue(async () => {
      const document = await this.load()
      if (document.groups.some((group) => group.name === clean)) {
        failure = `分组 ${clean} 已存在`
        return
      }
      // Checked inside the queue, against the document this write will build
      // on: a composite may only point at a group that already exists, and a
      // concurrent create must not be able to invalidate that between the check
      // and the write.
      const invalid = validateMembers(kind, candidates, document.groups, clean)
      if (invalid !== undefined) {
        failure = invalid
        return
      }
      const group = {
        id: clean,
        name: clean,
        models: candidates,
        enabled: true,
        kind,
        strategy: normalizeStrategy(options.strategy),
        retry429: normalizeRetry429(options.retry429),
      }
      const next = { version: DOCUMENT_VERSION, groups: [...document.groups, group] }
      await this.persist(next)
      this.document = next
    })
    if (failure !== undefined) return { ok: false, error: failure }
    return {
      ok: true,
      group: {
        id: clean,
        name: clean,
        models: candidates,
        enabled: true,
        kind,
        strategy: normalizeStrategy(options.strategy),
        retry429: normalizeRetry429(options.retry429),
      },
    }
  }

  /**
   * Update a group's candidate list, and optionally rename it.
   *
   * `kind` is NOT updatable. Switching a `model` group into a `composite` would
   * have to decide what happens to its existing concrete candidates, and
   * switching the other way would have to strip the group references out — both
   * are edits the user should make by creating the group they actually want.
   * The field is therefore normalized from what is already stored, which also
   * makes it impossible for a caller to grant the capability by asking for it.
   *
   * @param id - the group's current name.
   * @param next - `{ models?, name?, enabled?, strategy?, retry429? }`.
   */
  async update(id, next = {}) {
    const candidates = Array.isArray(next.models)
      ? next.models.filter((model) => typeof model === 'string' && model.trim() !== '').map((model) => model.trim())
      : undefined
    if (candidates !== undefined && candidates.length === 0) return { ok: false, error: '至少需要一个候选模型' }
    if (candidates !== undefined && candidates.length > MAX_MODELS) return { ok: false, error: `候选模型最多 ${MAX_MODELS} 个` }
    const rename = typeof next.name === 'string' ? next.name.trim() : undefined
    if (rename !== undefined && rename !== id && !isValidGroupName(rename)) {
      return { ok: false, error: '分组名只能含字母、数字、- 和 .，且不能含下划线（下划线是模型名的分隔符）' }
    }
    let failure
    await this.enqueue(async () => {
      const document = await this.load()
      const index = document.groups.findIndex((group) => group.name === id)
      if (index === -1) {
        failure = '分组不存在'
        return
      }
      if (rename !== undefined && document.groups.some((group, at) => at !== index && group.name === rename)) {
        failure = `分组 ${rename} 已存在`
        return
      }
      const current = document.groups[index]
      const kind = normalizeKind(current.kind)
      const models = candidates ?? current.models
      // Validate against the document as it will be AFTER this write: a rename
      // changes what a composite's members resolve to, and the group being
      // edited must not be treated as its own referrer.
      const others = document.groups.filter((_group, at) => at !== index)
      const selfName = rename ?? current.name
      const invalid = validateMembers(kind, models, others, selfName)
      if (invalid !== undefined) {
        failure = invalid
        return
      }
      const updated = {
        id: rename ?? current.id,
        name: selfName,
        models,
        enabled: typeof next.enabled === 'boolean' ? next.enabled : current.enabled,
        kind,
        strategy: next.strategy === undefined
          ? normalizeStrategy(current.strategy)
          : normalizeStrategy(next.strategy),
        retry429: next.retry429 === undefined
          ? normalizeRetry429(current.retry429)
          : normalizeRetry429(next.retry429),
      }
      const groups = [...document.groups]
      groups[index] = updated
      const nextDocument = { version: DOCUMENT_VERSION, groups }
      await this.persist(nextDocument)
      this.document = nextDocument
    })
    if (failure !== undefined) return { ok: false, error: failure }
    return { ok: true }
  }

  /** Remove a group by name. */
  async remove(id) {
    let removed = false
    await this.enqueue(async () => {
      const document = await this.load()
      const groups = document.groups.filter((group) => group.name !== id)
      if (groups.length === document.groups.length) return
      const next = { version: DOCUMENT_VERSION, groups }
      await this.persist(next)
      this.document = next
      removed = true
    })
    return removed
  }
}
