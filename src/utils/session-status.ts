import type { SessionInfo } from '../types'

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
  if (s.error) return 'err'
  if (s.working) return 'working'
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
  if (s.running) return s.error ? `Errored: ${s.error}` : 'Live'
  return 'Dormant'
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
