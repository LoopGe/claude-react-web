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

/** Default auto-compact threshold as a share of the model context window —
 *  what a brand-new session pins to once the window is known (config
 *  `autoCompactThresholdPct` overrides). Matches ContextBar's MIN_PCT..MAX_PCT
 *  marker range; the formula-derived ~97% is the fallback only when no pin
 *  has been applied. */
export const DEFAULT_AUTO_COMPACT_THRESHOLD_PCT = 85

/** Clamp a threshold percentage into the marker's 20–100 range; non-finite
 *  values fall back to the default so a corrupt config cannot disable the pin. */
export function clampAutoCompactThresholdPct(pct: number | undefined): number {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return DEFAULT_AUTO_COMPACT_THRESHOLD_PCT
  return Math.min(100, Math.max(20, Math.round(pct)))
}

/** The Settings.autoCompactWindow that makes the CLI's threshold land at
 *  `pct`% of `contextWindow`.
 *
 *  Default (no clamp): returns 0 when the inverse would need more tokens than
 *  the model holds (e.g. 85% on a 200k window) — callers should leave auto
 *  rather than pin the window itself, which would stick at ~83.5% across a
 *  later window switch.
 *  `clampToWindow: true` (the ContextBar drag path) instead clamps to the
 *  model window so the user can still commit the highest achievable marker. */
export function autoCompactWindowForPct(
  pct: number,
  contextWindow: number,
  maxOutputTokens?: number,
  opts?: { clampToWindow?: boolean },
): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 0
  const want = windowForAutoCompactThreshold((pct / 100) * contextWindow, maxOutputTokens)
  if (opts?.clampToWindow) return Math.round(Math.min(want, contextWindow))
  return want > 0 && want <= contextWindow ? Math.round(want) : 0
}

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
