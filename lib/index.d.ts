/**
 * dsh-model-relay (模型中转站) — type declarations.
 *
 * The plugin is plain JavaScript; these declarations cover the public surface a
 * profile author touches: the Cordis entry points and the config shape.
 */

import type { Context } from '@deepseek-ai/cordis'

/** Cordis plugin name. */
export declare const name: 'dsh-model-relay'

/** Services the plugin requires before it activates. */
export declare const inject: readonly ['llm', 'webServer']

/** Normalized plugin configuration. */
export interface GatewayConfig {
  /** Mount point for the OpenAI-compatible routes. @default '/v1' */
  path?: string
  /**
   * Fixed API keys enforced in addition to any created from the settings page.
   * When non-empty the settings page cannot turn authentication off.
   * @default []
   */
  apiKeys?: string[]
  /** Provider route ids to expose. Empty means every registered provider. @default [] */
  providers?: string[]
  /** Provider preferred for a bare (un-namespaced) model id. */
  defaultProvider?: string
  /** Send permissive CORS headers. @default true */
  cors?: boolean
  /** Key store path. @default '<DSH_HOME>/model-relay-keys.json' */
  keysFile?: string
  /** Model-group store path. @default '<DSH_HOME>/model-relay-groups.json' */
  groupsFile?: string
  /**
   * Optional second listener bound to the LAN, serving only the model API.
   * `false` disables it; `0` asks the OS for a free port.
   * @default false
   */
  lanPort?: number | false
  /** Bind address for the LAN listener. @default '0.0.0.0' */
  lanHost?: string
  /**
   * Persist per-day statistics to disk. Default on since 0.5.0; turning it
   * off restores the 0.4.x memory-only behavior (no file, no timers).
   * @default true
   */
  statsPersist?: boolean
  /** Statistics store path. @default '<DSH_HOME>/model-relay-stats.json' */
  statsFile?: string
  /** Days of per-day statistics retained. @default 90 */
  statsRetentionDays?: number
}

/**
 * Resolved configuration with every default applied.
 *
 * `defaultProvider`, `keysFile`, and `groupsFile` are omitted from `Required`
 * and re-declared as optional, because each has a runtime default that is
 * resolved lazily: an absent `keysFile` or `groupsFile` is filled in from the
 * DSH home directory, and an absent `defaultProvider` stays absent. Marking
 * them required would describe them as always present.
 */
export interface ResolvedGatewayConfig extends Required<Omit<GatewayConfig, 'defaultProvider' | 'keysFile' | 'groupsFile' | 'statsFile'>> {
  defaultProvider: string | undefined
  keysFile: string | undefined
  groupsFile: string | undefined
  statsFile: string | undefined
}

/**
 * Validate and normalize the plugin configuration.
 * @param config - raw config object from the profile patch layer.
 * @returns normalized configuration.
 * @throws when a field is present but malformed.
 */
export declare function resolveConfig(config?: GatewayConfig): ResolvedGatewayConfig

/**
 * Mount the gateway.
 * @param ctx - Cordis context carrying the `llm` and `webServer` services.
 * @param config - optional plugin configuration.
 */
export declare function apply(ctx: Context, config?: GatewayConfig): void
