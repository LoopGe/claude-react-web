// Auto-compact window math — single source of truth shared by the server
// pump (deriving the threshold from a model's context window) and the client
// ContextBar (inverting a marker position back into a Settings.autoCompactWindow).
//
// The CLI computes the auto-compact trigger point as:
//   threshold = contextWindow - min(maxOutputTokens, 20000) - 13000
// so the marker on the ContextBar track represents the THRESHOLD position,
// and dragging it to pct% must set `Settings.autoCompactWindow` to the window
// that makes that threshold land on pct% — the threshold PLUS the same headroom.

/** Buffer the SDK reserves before triggering auto-compact. Matches the
 *  CLI's AUTOCOMPACT_BUFFER_TOKENS in src/services/compact/autoCompact.ts. */
export const AUTOCOMPACT_BUFFER_TOKENS = 13000
/** The CLI subtracts at most this many tokens of output headroom when
 *  computing the effective context window for the auto-compact threshold. */
export const AUTOCOMPACT_MAX_OUTPUT_FLOOR = 20000

/** Inverse of the CLI's threshold formula: the Settings.autoCompactWindow
 *  value that makes auto-compact trigger at `threshold` tokens. When
 *  maxOutputTokens is absent we assume the floor, matching the server's
 *  graceful degradation in computeAutoCompactThreshold. */
export function windowForAutoCompactThreshold(
  threshold: number,
  maxOutputTokens?: number,
): number {
  const headroom =
    Math.min(maxOutputTokens ?? AUTOCOMPACT_MAX_OUTPUT_FLOOR, AUTOCOMPACT_MAX_OUTPUT_FLOOR) +
    AUTOCOMPACT_BUFFER_TOKENS
  return Math.max(0, threshold + headroom)
}
