/**
 * Pre-create capability source for locked-feature gating.
 *
 * A session being created has no `SessionInfo`/provider handle yet — only a
 * draft provider name — so the New Session dialog cannot read the post-create
 * capability booleans (`pluginsSupported`, …) that `projectSharedSessionFields`
 * projects for existing sessions. This module is the SAME capability mechanism
 * sourced before create: a provider-name → locked-feature map the browser can
 * read directly (no endpoint, no node imports).
 *
 * The map MUST agree with the server's `ProviderCapabilities` flags
 * (`server/providers/types.ts`) — native locks all five, claude supports all
 * five. Agreement is guarded by a server-side pin
 * (`server/providers/provider-capabilities-pin.test.ts`) that compares this map
 * against the real provider capability literals, so the two cannot drift
 * unnoticed. The post-create `SessionInfo` booleans remain the source for
 * existing sessions; this map is only for the pre-create draft.
 */

/** The locked features gated pre-create, in presentation order. */
export const LOCKED_FEATURES = ['plugins', 'hooks', 'memory', 'sandbox', 'account'] as const

export type LockedFeature = (typeof LOCKED_FEATURES)[number]

/**
 * Per-provider support for each locked feature, mirroring the
 * `ProviderCapabilities` flags `supportsPlugins` / `supportsHooks` /
 * `supportsMemory` / `supportsSandbox` / `supportsAccountInfo`.
 */
const PROVIDER_LOCKED_FEATURE_SUPPORT = new Map<string, Record<LockedFeature, boolean>>([
  ['claude', { plugins: true, hooks: true, memory: true, sandbox: true, account: true }],
  ['native', { plugins: false, hooks: false, memory: false, sandbox: false, account: false }],
])

/**
 * Whether `provider` supports `feature`, for pre-create gating.
 *
 * An unknown or undefined provider defaults claude-compatible (true) for legacy
 * safety: frames/drafts that predate a provider name keep the full surface
 * rather than silently locking it. Only an explicit known-unsupported provider
 * (native) locks a feature.
 */
export function providerSupports(provider: string | undefined, feature: LockedFeature): boolean {
  return PROVIDER_LOCKED_FEATURE_SUPPORT.get(provider ?? 'claude')?.[feature] ?? true
}
