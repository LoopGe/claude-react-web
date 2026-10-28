import type { SessionInfo } from '../types'

/** Pure predicate for the sidebar's "waiting" state — a running session whose
 *  parent turn has COMPLETED but which still has background (async) subagents
 *  in flight. Mirrors the per-card dot (SessionCard) exactly, so the
 *  collapsed-group badge and the card can never disagree; statusClass and
 *  statusLabel reuse it for the same signal. */
export function isWaiting(s: SessionInfo): boolean {
  return s.running && !s.working && (s.backgroundSubagentCount ?? 0) > 0
}

/** Distill a session's liveness/health into a single CSS class used by
 *  the header status dot. Kept separate from the label so colours and
 *  wording can evolve independently. */
export function statusClass(s: SessionInfo): string {
  if (s.recovering) return 'working'
  if (s.terminated) return 'terminated'
  // A dormant session (!running && !terminated) stays 'dormant' even when it
  // carries a stale error (e.g. a spawn_failed whose binary is now fixed) —
  // it's resumable, not dead. 'err' is reserved for a RUNNING session that
  // has nonetheless errored (rare; usually caught by `recovering` above).
  if (!s.running) return 'dormant'
  // Precedence deliberately matches the sidebar chip (SessionCard): an
  // actively-working turn beats a background subagent beats a stale error.
  // A running session with background work in flight is "waiting" even if it
  // also carries an error — the amber is more informative than the red here,
  // and the error text still surfaces in the card body / title tooltip.
  if (s.working) return 'working'
  if (isWaiting(s)) return 'waiting'
  if (s.error) return 'err'
  return 'live'
}

export function statusLabel(s: SessionInfo): string {
  if (s.recovering) return 'Recovering from crash'
  if (s.terminated) {
    const reason = s.terminatedReason
    if (reason === 'query_error') return 'Session ended: upstream error'
    if (reason === 'query_ended') return 'Session ended: connection closed'
    if (reason === 'process_killed') return 'Session ended: process killed'
    if (reason === 'process_exited') return 'Session ended: process exited'
    if (reason === 'spawn_failed') return 'Session ended: CLI failed to start'
    if (reason === 'init_stuck') return 'Session ended: init timed out'
    if (reason === 'stuck') return 'Session ended: unresponsive'
    if (reason === 'deleted') return 'Session deleted'
    if (reason === 'transcript_missing') return 'Session ended: transcript missing'
    if (reason === 'no_data') return 'Session ended: no conversation data on disk'
    if (reason === 'crash_recovered_fork') return 'Session ended: recovered to a fork'
    return 'Session ended'
  }
  // Dormant + stale error (e.g. spawn_failed): resumable, not dead — frame
  // it as a failed resume attempt so the user knows to retry after fixing
  // the underlying cause (missing CLI binary, etc.).
  if (!s.running && s.error) return `Resume failed: ${s.error}`
  if (s.working) return 'Working on a turn'
  if (isWaiting(s)) {
    const n = s.backgroundSubagentCount!
    return n === 1 ? 'Waiting for a background subagent' : `Waiting for ${n} background subagents`
  }
  if (s.running) return s.error ? `Errored: ${s.error}` : 'Live'
  return 'Dormant'
}

/** The status states a compact header tab (nav strip / titlebar tabs) can
 *  carry as a trailing dot. 'working' is included so the fold is TOTAL — a
 *  crash-recovering session (statusClass folds it into 'working') must pulse
 *  on a tab instead of falling through every branch and rendering unmarked.
 *  A plain live/idle session still yields null: dot-free reads as "normal",
 *  keeping the pulse and the unread badge as the only attention signals in
 *  the healthy case. */
export type TabDotStatus = 'working' | 'dormant' | 'ended' | 'waiting' | 'err'

/** Which status a header tab should surface, or null for none. Distilled
 *  through statusClass() — the shared pure fold behind the sidebar's status
 *  vocabulary — so a tab follows the same precedence as the sidebar chip.
 *  (SessionCard layers richer app-transient states on top: its 'resuming'
 *  comes from App's in-flight set, not SessionInfo, and its recovering
 *  session renders 'err' where statusClass says 'working' — a pre-existing
 *  divergence between card and fold, not one this function introduces.)
 *  Class names are the sidebar's `.session-status-dot.status-*` palette;
 *  statusClass's 'terminated' maps to that CSS vocabulary's 'ended' (same
 *  signal, the sidebar's class name). Resume-in-flight is folded by the
 *  components (they hold App's resuming set; SessionInfo does not carry it). */
export function tabDotStatus(s: SessionInfo): TabDotStatus | null {
  const cls = statusClass(s)
  if (cls === 'terminated') return 'ended'
  if (cls === 'working' || cls === 'dormant' || cls === 'waiting' || cls === 'err') return cls
  return null
}

/** Tooltip for a compact header tab: the label, plus the status text only
 *  when it explains something ("Dormant", "Session ended: process killed").
 *  A plain live session's tooltip stays the bare label — "Live" adds nothing
 *  over the dot-free normal look. Gated on the statusClass fold (the stable
 *  vocabulary), not on statusLabel's wording, so rewording the label can't
 *  silently push '— <new text>' onto every healthy tab. */
export function tabTitle(label: string, s: SessionInfo): string {
  if (statusClass(s) === 'live') return label
  return `${label} — ${statusLabel(s)}`
}

/** Trim namespace prefixes and long version tails so a model name fits
 *  in a tight header chip. "claude-sonnet-4-5-20251101" → "sonnet-4-5";
 *  "xiaomi/mimo-v2.5-pro" → "mimo-v2.5-pro". Undefined → "default". */
export function shortenModel(name: string | undefined): string {
  if (!name) return 'default'
  const bare = name.split('/').pop() ?? name
  const stripped = bare
    .replace(/^claude-/, '')
    // Strip trailing YYYYMMDD release dates ("-20251101").
    .replace(/-\d{8}$/, '')
  return stripped.length > 22 ? stripped.slice(0, 20) + '…' : stripped
}
