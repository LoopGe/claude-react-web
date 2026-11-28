/**
 * Pre-create capability source for provider-gated features.
 *
 * A session being created has no `SessionInfo`/provider handle yet — only a
 * draft provider name — so the New Session dialog cannot read the post-create
 * capability booleans (`pluginsSupported`, …) that `projectSharedSessionFields`
 * projects for existing sessions. This module is the SAME capability mechanism
 * sourced before create: a provider-name → feature-support map the browser can
 * read directly (no endpoint, no node imports).
 *
 * The map MUST agree with the server's `ProviderCapabilities` flags
 * (`server/providers/types.ts`) — claude supports all six; native supports
 * plugins and pluginSkills and locks hooks/memory/sandbox/account. Agreement
 * is guarded by a server-side pin
 * (`server/providers/provider-capabilities-pin.test.ts`) that compares this map
 * against the real provider capability literals, so the two cannot drift
 * unnoticed. The post-create `SessionInfo` booleans remain the source for
 * existing sessions; this map is only for the pre-create draft.
 */

/** The provider-gated features, in presentation order. hooks/memory/sandbox/
 *  account are locked on native (claude-only CLI features); plugins (agent
 *  extensions: commands/agents/hooks/MCP/skills) and pluginSkills (selective
 *  plugin-skill discovery via enabledPlugins) are functional on both providers. */
export const GATED_FEATURES = ['plugins', 'hooks', 'memory', 'sandbox', 'account', 'pluginSkills'] as const

export type GatedFeature = (typeof GATED_FEATURES)[number]

/**
 * Per-provider support for each gated feature, mirroring the
 * `ProviderCapabilities` flags `supportsPlugins` / `supportsHooks` /
 * `supportsMemory` / `supportsSandbox` / `supportsAccountInfo` /
 * `supportsPluginSkills`.
 */
const PROVIDER_GATED_FEATURE_SUPPORT = new Map<string, Record<GatedFeature, boolean>>([
  ['claude', { plugins: true, hooks: true, memory: true, sandbox: true, account: true, pluginSkills: true }],
  ['native', { plugins: true, hooks: false, memory: false, sandbox: false, account: false, pluginSkills: true }],
])

/**
 * Whether `provider` supports `feature`, for pre-create gating.
 *
 * An unknown or undefined provider defaults claude-compatible (true) for legacy
 * safety: frames/drafts that predate a provider name keep the full surface
 * rather than silently locking it. Only an explicit known-unsupported provider
 * locks a feature.
 */
export function providerSupports(provider: string | undefined, feature: GatedFeature): boolean {
  return PROVIDER_GATED_FEATURE_SUPPORT.get(provider ?? 'claude')?.[feature] ?? true
}
