// Pure context-usage math shared by every context-usage surface (ContextBar,
// ContextOrb, the settings panel's composition table). Lives in its own
// module — not inside a component file — so consumers don't pull the whole
// component graph and react-refresh keeps working for all of them.

import type { ContextUsage } from '../hooks/useChatStream'
import { clamp } from './clamp'

/** The model's real advertised context window: rawMaxTokens preferred over
 *  maxTokens (which may be reduced by compaction headroom reserves). One
 *  owner for the preference — share-of-window math elsewhere (e.g. the
 *  composition table) must use this, not re-derive it. */
export function contextWindowTokens(usage: ContextUsage | null | undefined): number | null {
  return usage?.rawMaxTokens ?? usage?.maxTokens ?? null
}

/** Shared used%/threshold/level math for every context-usage surface
 *  (the bar itself and the composer's ContextOrb ring). One ladder so the
 *  resting ring tint can never drift from the panel it opens. */
export function contextUsageStats(usage: ContextUsage | null | undefined) {
  const max = contextWindowTokens(usage)
  const hasData = usage != null && max != null && max > 0
  const usedTokens = hasData && usage ? (usage.totalTokens ?? 0) : null
  // Prefer SDK's percentage (it may weigh differently than raw tokens / max)
  // but fall back to a straight division if absent.
  const bounded =
    hasData && usage && usedTokens != null && max != null
      ? clamp(usage.percentage ?? (usedTokens / max) * 100, 0, 100)
      : null
  const level: 'ok' | 'warn' | 'danger' =
    bounded == null ? 'ok' : bounded >= 90 ? 'danger' : bounded >= 70 ? 'warn' : 'ok'
  const threshold = hasData && usage ? usage.autoCompactThreshold : undefined
  const thresholdPct =
    typeof threshold === 'number' && threshold > 0 && max != null
      ? (threshold / max) * 100
      : null
  return { max, hasData, usedTokens, bounded, level, threshold, thresholdPct }
}
