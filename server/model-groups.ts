import type { ModelGroupConfig } from './config.js'

export interface ResolvedGroup {
  main: string
  tiers: { opus: string; sonnet: string; haiku: string }
}

/** Map a model id to the configured model list using the same resolution
 *  the manager applies to the main model: a BARE short name (no `/`) maps
 *  to the unique configured model whose last `/`-segment matches; a
 *  provider-prefixed id or an ambiguous short name is returned unchanged.
 *  Extracted here so the provider and the manager share one pure
 *  implementation (the manager's private resolveConfiguredModel keeps its
 *  existing behavior; this is the provider's entry point). */
export function resolveConfiguredModelId(
  model: string | undefined,
  modelList: readonly string[],
): string | undefined {
  if (!model) return undefined
  if (model.includes('/')) return model
  if (modelList.includes(model)) return model
  const matches = modelList.filter((m) => m.slice(m.lastIndexOf('/') + 1) === model)
  return matches.length === 1 ? matches[0] : model
}

/** Resolve a group to its main model + three concrete tier models. Empty
 *  slots fall back to the main model. Bare names are run through `resolve`. */
export function resolveGroup(
  group: ModelGroupConfig,
  resolve: (id: string) => string | undefined,
): ResolvedGroup {
  const slot = (t: 'opus' | 'sonnet' | 'haiku'): string | undefined => {
    const raw = group[t]
    if (!raw) return undefined
    return resolve(raw) ?? raw
  }
  const mainSlot = group.main ?? 'opus'
  // Config validation guarantees at least one non-empty slot, so the final
  // `?? ''` never triggers in practice — it only keeps the type non-optional.
  const main = slot(mainSlot) ?? slot('opus') ?? slot('sonnet') ?? slot('haiku') ?? ''
  return {
    main,
    tiers: {
      opus: slot('opus') ?? main,
      sonnet: slot('sonnet') ?? main,
      haiku: slot('haiku') ?? main,
    },
  }
}

/** True when the model id does NOT keyword-match a recognizable Claude class
 *  (no 'opus' / 'sonnet' / 'haiku' token) — i.e. an opaque gateway id that
 *  needs an explicit capability declaration. */
export function isOpaqueModel(model: string): boolean {
  const id = model.toLowerCase()
  return !(id.includes('opus') || id.includes('sonnet') || id.includes('haiku'))
}

/** Capability tokens for a tier slot, used only for opaque models. The slot
 *  position IS the class signal (putting a model in the opus slot declares
 *  opus-class capabilities). haiku → [] (skip the declaration). */
export function capabilitiesForTier(
  tier: 'opus' | 'sonnet' | 'haiku',
  model: string,
): string[] {
  if (!isOpaqueModel(model)) return []
  switch (tier) {
    case 'opus':
      return ['effort', 'xhigh_effort', 'max_effort', 'thinking', 'adaptive_thinking', 'interleaved_thinking']
    case 'sonnet':
      return ['effort', 'max_effort', 'thinking', 'adaptive_thinking', 'interleaved_thinking']
    case 'haiku':
      return []
  }
}

/** Fallback model for a session-scoped auxiliary LLM call — session recaps,
 *  AI commit messages, and the auto-mode permission classifier — for when the
 *  per-field config override (recapModel / commitMessageModel /
 *  autoClassifierModel) is empty.
 *
 *  A session with an active model group uses that group's HAIKU tier: it is
 *  the same slot the CLI routes its own internal queries to (title
 *  generation, background subagents, `ANTHROPIC_SMALL_FAST_MODEL`), and the
 *  cheap/fast class these three tasks are sized for. (The group's `main` slot
 *  — which is what `session.model` holds for a group session — would put
 *  recaps and a 5s-budget classifier on the flagship model.) Without a group
 *  the session's own model is the answer. */
export function auxFallbackModel(
  sessionModel: string | undefined,
  group: ModelGroupConfig | undefined,
  resolve: (id: string) => string | undefined,
): string | undefined {
  if (group) {
    const haiku = resolveGroup(group, resolve).tiers.haiku
    if (haiku) return haiku
  }
  return sessionModel
}

/** The fallback degradation chain for a group session: tier aliases BELOW the
 *  main slot, resolved by the CLI through the tier env vars. */
export function fallbackAliasesFor(main: 'opus' | 'sonnet' | 'haiku'): string[] {
  switch (main) {
    case 'opus': return ['sonnet', 'haiku']
    case 'sonnet': return ['haiku']
    case 'haiku': return []
  }
}
