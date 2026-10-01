/**
 * The DSH-facing half of dsh-model-gateway: a provider whose models are groups.
 *
 * Registering this adapter is what makes a group selectable inside DSH itself,
 * not just over `/v1`. The adapter's model list *is* the group list, and a
 * stream for one of those models walks the group's candidates in order.
 *
 * It deliberately does not call the gateway's own `/v1` over HTTP even though
 * that is a valid way to reach the same routing logic. Going through the
 * loopback port would add a round trip, require `webServer` to be up before a
 * call could be dispatched, make the internal path depend on whatever
 * authentication `/v1` is currently enforcing, and behave differently behind a
 * reverse proxy. Calling `ctx.llm` directly avoids all four, and lets the exact
 * same failover routine back both entry points.
 *
 * @module dsh-model-gateway/adapter
 */

import { LlmAdapter } from '@deepseek-ai/dsh-llm'

/**
 * Modalities every group advertises.
 *
 * Declared rather than omitted because the field's absence means "unknown"
 * while an explicit omission means "cannot" — and DSH refuses an image request
 * outright against a model that cannot take one. A group spans providers, so
 * whether an image is accepted depends on the member that answers; the gateway
 * verifies that at request time instead of refusing here. Serialization support
 * is already proven: the `/v1` path translates `image_url` parts today.
 */
const GROUP_MODALITIES = ['text', 'image']

/**
 * An `LlmAdapter` serving one provider route whose models are model groups.
 */
export class RelayAdapter extends LlmAdapter {
  /**
   * @param options - the gateway's own view of a group request.
   * @param options.providerId - the route this adapter owns; `providerInfo`
   *   must echo it exactly or the runtime rejects the registration.
   * @param options.providerName - display name for the provider.
   * @param options.listGroups - `() => Promise<Array<{ name, models, enabled }>>`.
   * @param options.groupCapabilities - `(models, signal, groupName) =>
   *   Promise<{ contextWindow, efforts }>`; resolves what a group can actually
   *   do, intersected across its members. `groupName` is passed so the gateway
   *   can key its cache on the group rather than only on its member list.
   * @param options.streamGroup - `(groupName, options) => AsyncIterable`; the
   *   shared failover routine, so both entry points route identically.
   * @param options.logger - diagnostic sink.
   */
  constructor({ providerId, providerName, listGroups, groupCapabilities, streamGroup, logger }) {
    super()
    this.providerId = providerId
    this.providerName = providerName
    this.listGroups = listGroups
    this.groupCapabilities = groupCapabilities
    this.streamGroup = streamGroup
    this.logger = logger
  }

  /**
   * Describe this provider route.
   *
   * `id` must be the route key verbatim: the runtime compares them and rejects
   * a registration whose metadata does not preserve the id.
   */
  providerInfo(provider) {
    return { id: provider, name: this.providerName }
  }

  /**
   * The model list DSH renders — every enabled group, under its own name.
   *
   * Capacity is deliberately absent. `llm.listModels()` copies only
   * `provider`, `id`, `name`, `description` and `inputModalities` out of every
   * entry, so a `contextWindow` attached here would be dropped before it
   * reached anything: it is not a field the catalog carries. Capacity travels
   * on `resolveModel()` instead, which is the only path that reads it.
   */
  async listModels(_provider) {
    const groups = await this.listGroups()
    const out = []
    for (const group of groups) {
      if (group.enabled === false) continue
      out.push({
        provider: this.providerId,
        id: group.name,
        name: group.name,
        inputModalities: GROUP_MODALITIES,
      })
    }
    return out
  }

  /**
   * Resolve one group's metadata.
   *
   * Two facts travel here and nowhere else, because this is the only adapter
   * answer whose extra fields DSH keeps:
   *
   *  - **Capacity.** Compaction sizes itself from this answer and explicitly
   *    does not consult `listModels()`. Omitting it is the difference between
   *    "DSH can compact a long session" and "DSH warns once and then lets the
   *    session run until the provider refuses it".
   *  - **Reasoning efforts.** See {@link RelayAdapter#reasoningFor}.
   */
  async resolveModel(_provider, model, signal) {
    const group = (await this.listGroups()).find((entry) => entry.name === model)
    const capabilities = group === undefined
      ? { contextWindow: undefined, efforts: [] }
      : await this.#capabilities(group, signal)
    const reasoning = reasoningFor(capabilities.efforts)
    return {
      provider: this.providerId,
      id: model,
      name: model,
      inputModalities: GROUP_MODALITIES,
      ...(capabilities.contextWindow === undefined
        ? {}
        : { context: { contextWindow: capabilities.contextWindow } }),
      // Omitted entirely when the group cannot offer a choice. An empty
      // `efforts` array is rejected outright by DSH ("invalid reasoning
      // metadata"), and a non-empty one makes DSH inject a default effort into
      // every request — so absence is the only honest way to say "no choice".
      ...(reasoning === undefined ? {} : { reasoning }),
    }
  }

  /**
   * Stream one group call.
   *
   * The request carries the group name in `options.model`; the body is already
   * assembled, so this only replaces the provider/model pair per candidate.
   */
  stream(options) {
    return this.streamGroup(options.model, options)
  }

  /**
   * What a group can actually do, or the empty answer when unknown.
   *
   * A capability failure is normally advisory and degrades to "unknown": a
   * group whose members cannot be measured is still perfectly callable, and
   * failing the listing over it would take the whole provider out of the model
   * picker.
   *
   * One failure is NOT advisory, and must be re-thrown: the gateway's own
   * recursion guard, raised when a composite cycle makes this walk unbounded.
   * Swallowing it would turn a cycle into a permanent "unknown capability" and
   * the next catalog build would walk into it again — so the guard would never
   * actually stop anything.
   */
  async #capabilities(group, signal) {
    if (typeof this.groupCapabilities !== 'function') return { contextWindow: undefined, efforts: [] }
    try {
      // The group's NAME travels too: the gateway keys its capability cache on
      // it, so an edit to an inner group can invalidate the composites that
      // point at it. A member list alone cannot express that dependency.
      const answer = await this.groupCapabilities(group.models, signal, group.name)
      return {
        contextWindow: answer?.contextWindow,
        efforts: Array.isArray(answer?.efforts) ? answer.efforts : [],
      }
    } catch (error) {
      if (error?.code === 'group_capability_cycle') throw error
      this.logger?.warn?.(`dsh-model-gateway: could not read the capabilities of group ${JSON.stringify(group.name)}`)
      this.logger?.warn?.(error)
      return { contextWindow: undefined, efforts: [] }
    }
  }
}

/**
 * Build the `reasoning` block for a group, or undefined when it must not exist.
 *
 * **No `defaultEffort` is ever declared.** Declaring one is not a hint: DSH
 * *materializes* it, rewriting every request that did not name an effort so
 * that it does. For a group that is actively harmful — the effort gets injected
 * on the way in and then forwarded verbatim to whichever member answers, so a
 * member that does not accept it fails with UNSUPPORTED_REASONING_EFFORT
 * without the caller ever having asked for anything. The group's members keep
 * their own defaults instead.
 *
 * The entries are re-validated here even though the caller computed them: this
 * is the exact boundary DSH checks, and its rejection is not survivable — a
 * malformed entry throws INVALID_MODEL_REASONING and removes the whole provider
 * from the model picker. DSH requires an object with non-empty string `id` and
 * `name`, and rejects duplicate ids.
 *
 * @param efforts - the intersected effort list, in the order to display.
 * @returns a validated `{ efforts }` block, or undefined when the list is empty.
 */
function reasoningFor(efforts) {
  const seen = new Set()
  const usable = []
  for (const effort of efforts ?? []) {
    if (typeof effort?.id !== 'string' || effort.id === '') continue
    if (typeof effort?.name !== 'string' || effort.name === '') continue
    if (seen.has(effort.id)) continue
    seen.add(effort.id)
    usable.push({
      id: effort.id,
      name: effort.name,
      ...(typeof effort.description === 'string' ? { description: effort.description } : {}),
    })
  }
  return usable.length === 0 ? undefined : { efforts: usable }
}
