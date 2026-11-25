// Auto-compact window math constants shared by the server pump (deriving the
// threshold from a model's context window) and anything that explains the
// derivation to the user.
//
// The CLI computes the auto-compact trigger point as:
//   threshold = contextWindow - min(maxOutputTokens, 20000) - 13000
// so the marker on the ContextBar track represents the THRESHOLD position.
// This formula is the CLAUDE provider's policy replica only: the native
// provider derives its threshold from `nativeAutoCompactRatio` on the
// effective window `min(modelWindow, pin)` and reports it authoritatively.
// The formula is CLI-internal and may drift across versions — the pump's
// drift warning (resolveAutoCompactThreshold) exists for exactly that, and a
// provider-reported value always wins over the replica.
//
// Setting the window itself is NOT this module's business: the compaction
// window rides `Options.settings.autoCompactWindow` at spawn (the New session
// form) for both providers, or the CLI's own `/autocompact` command for a
// running claude session — the SDK's applyFlagSettings channel is inert for
// that key (docs/research/2026-11-25-claude-cli-auto-compact.md §4.2.1; see
// also docs/research/2026-10-30-autocompact-semantics.md).

/** Buffer the SDK reserves before triggering auto-compact. Matches the
 *  CLI's AUTOCOMPACT_BUFFER_TOKENS in src/services/compact/autoCompact.ts. */
export const AUTOCOMPACT_BUFFER_TOKENS = 13000
/** The CLI subtracts at most this many tokens of output headroom when
 *  computing the effective context window for the auto-compact threshold. */
export const AUTOCOMPACT_MAX_OUTPUT_FLOOR = 20000
