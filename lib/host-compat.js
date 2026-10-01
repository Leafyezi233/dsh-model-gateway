/**
 * Host-generation probes for the settings integration.
 *
 * dsh 0.1.7 replaced the plugin-owned settings namespace with the profile
 * entry id: the namespace IS the entry id and the schema IS the exported
 * `Config`, while `settings.register()` — and `installSection()`, its thin
 * wrapper — was removed. One build must run on both generations, so the
 * wiring picks its path at runtime from capabilities it can observe without
 * ever touching the removed APIs.
 *
 * Probes, in the order the wiring uses them:
 *  1. `peekService` + `isLegacySettings` — when the settings service is
 *     already up, its own shape is the authoritative answer.
 *  2. `supportsVolatile` — when the service is not up yet, the schemastery
 *     generation the host bundles answers instead: `.volatile()` only exists
 *     on 0.1.7, whose settings service is always the entry-id model.
 *
 * `entryIdOf` implements the migration's entry-id rule: the 0.1.7 loader
 * reports entry ids with their composition kind prefixed
 * (`include:dsh-model-gateway`), while the settings service indexes the bare
 * id — using the prefixed form is a 409 settings-conflict on every write.
 */

/** Fallback entry id, matching the bundle patch insert in cordis.patch.yml. */
export const ENTRY_ID_FALLBACK = 'dsh-model-gateway'

/**
 * The bare id of this plugin's composition entry.
 * @param ctx - the plugin context; only `ctx.fiber.entry.id` is consulted.
 * @param fallback - used when no entry id is reachable (unit tests, embedded
 *   compositions). Defaults to the id the bundle patch declares.
 * @returns the id with any `<kind>:` prefix stripped.
 */
export function entryIdOf(ctx, fallback = ENTRY_ID_FALLBACK) {
  const id = ctx?.fiber?.entry?.id
  if (typeof id === 'string' && id !== '') {
    const colon = id.lastIndexOf(':')
    return colon === -1 ? id : id.slice(colon + 1)
  }
  return fallback
}

/**
 * Whether the host's schemastery knows `.volatile()`.
 *
 * Probing (instead of calling) is what keeps module top-level schema building
 * safe on every generation: a pre-0.1.7 host must never see a `.volatile()`
 * call, not even inside a branch that "will not run" — a load-time TypeError
 * takes the whole plugin down.
 * @param Schema - the schemastery module as imported by this plugin.
 * @returns true only on a 0.1.7-generation host.
 */
export function supportsVolatile(Schema) {
  try {
    return typeof Schema.boolean().volatile === 'function'
  } catch {
    return false
  }
}

/**
 * Whether a settings service speaks the pre-0.1.7 register-by-name model.
 *
 * 0.1.5 exposes `register` (with `installSection` built on top of it); 0.1.7
 * removed `register`, leaving the entry-id model where the namespace already
 * exists and needs nothing installed. `register` is the discriminator — not
 * `installSection`, which a transitional host could keep while its
 * `register` is gone.
 * @param settings - the settings service, or undefined.
 * @returns true when the service owns namespaces by registration.
 */
export function isLegacySettings(settings) {
  return settings !== undefined
    && settings !== null
    && typeof settings.register === 'function'
}

/**
 * Read a service synchronously if it is already up, undefined otherwise.
 *
 * Registration-time probing only — anything that must wait for a service
 * belongs in `ctx.inject`, not here. `ctx.get` is the same accessor the
 * inject callback uses; the guard and catch just accept contexts that never
 * grew one (unit tests, embedded compositions).
 * @param ctx - the plugin context.
 * @param key - service name.
 * @returns the service, or undefined when absent or unreadable.
 */
export function peekService(ctx, key) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(key) : undefined
  } catch {
    return undefined
  }
}
