/**
 * One-time sweep of the pre-seq-refactor transcript cache keys.
 *
 * The transcript-seq refactor (2026-10-13, P2) removed client-side transcript
 * persistence entirely: the seq-window store holds no cache, and the server's
 * seq sidecar + `/messages` tail page are the only read paths. The
 * `claude-web-session:<sessionId>` localStorage keys — per-session transcript
 * JSON written by pre-refactor builds — have no reader or writer left in the
 * codebase. They only ever get deleted, and pre-refactor the only deletion
 * trigger was session deletion, so long-lived orphans accumulated against the
 * fixed ~5MB per-origin quota until the small but critical setting keys
 * (session groups, sidebar order) started failing to persist — measured at
 * 2.5MB of orphans (one 2MB session alone) starving 15KB of live keys.
 *
 * This sweep removes every such key at app boot. It is NOT a migration and
 * the data is NOT migrated: the server's JSONL + seq sidecar hold the full
 * transcripts, so the client copies are redundant by design (that is exactly
 * what the refactor's "客户端零持久化" decision established). The P3 phase
 * of the refactor plan retires the last shims around these keys.
 */

const LEGACY_TRANSCRIPT_PREFIX = 'claude-web-session:'

/** Delete every legacy transcript-cache key. Returns how many were removed
 *  (0 in the steady state — every boot after the first). Never throws: a
 *  blocked/partially-broken localStorage must not take the app down, and the
 *  keys are dead weight, not live data. */
export function sweepLegacyTranscriptCache(): number {
  try {
    const doomed: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith(LEGACY_TRANSCRIPT_PREFIX)) doomed.push(key)
    }
    for (const key of doomed) localStorage.removeItem(key)
    return doomed.length
  } catch {
    return 0
  }
}
