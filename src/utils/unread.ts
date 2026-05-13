// Pure helpers behind the session unread badge.
//
// Extracted from App.tsx so the ruleset ("which sessions get a dot?", "when
// does a new turn clear the dot for a focused+visible session?") can be
// exercised in isolation. The App wires the state plumbing (useLocalStorage
// for lastSeenTurn, refs for focusedId + window.hasFocus) and forwards to
// these pure functions — keeps the hook body small and the rules testable
// without mounting the whole tree.

import type { SessionInfo } from '../types'

/** A minimal shape containing only the fields `computeUnread` looks at.
 *  Tests pass bare objects rather than synthesising full `SessionInfo`s. */
export type UnreadSessionInput = Pick<SessionInfo, 'id' | 'lastTurnAt'>

/**
 * Build a map of `{ sessionId: true }` for sessions with a newer
 * `lastTurnAt` than what's recorded in `lastSeenTurn`. Sessions with no
 * `lastTurnAt` (never completed a turn) are never unread.
 *
 * Intentionally does NOT exclude open or focused sessions — the decision
 * of "is the user actively watching this?" is upstream: the App's
 * session-update handler bumps `lastSeenTurn[focusedId]` while the window
 * is focused, so a focused+visible session never satisfies
 * `lastTurnAt > lastSeenTurn[id]` for long enough to render.
 */
export function computeUnread(
  sessions: readonly UnreadSessionInput[],
  lastSeenTurn: Readonly<Record<string, number>>,
): Record<string, true> {
  const out: Record<string, true> = {}
  for (const s of sessions) {
    if (!s.lastTurnAt) continue
    const seen = lastSeenTurn[s.id] ?? 0
    if (s.lastTurnAt > seen) out[s.id] = true
  }
  return out
}

/**
 * Advance `lastSeenTurn[id]` to `nextTs`, but only when strictly higher —
 * callers that race (WS session-update, window focus, user click) would
 * otherwise regress a forward-moving timestamp.
 *
 * Returns the original map reference when nothing changes, which keeps
 * React's useState bail-out working (same reference → no re-render).
 */
export function bumpLastSeen(
  prev: Readonly<Record<string, number>>,
  id: string,
  nextTs: number | undefined,
): Record<string, number> {
  if (!nextTs) return prev as Record<string, number>
  if ((prev[id] ?? 0) >= nextTs) return prev as Record<string, number>
  return { ...prev, [id]: nextTs }
}

/**
 * Drop entries for ids not present in `validIds`. Used when the server
 * sends a fresh session snapshot — prevents `lastSeenTurn` from growing
 * unbounded across the lifetime of the app (each completed-then-deleted
 * session would otherwise leak one entry). Returns the original reference
 * when the input already matches.
 */
export function pruneLastSeen(
  prev: Readonly<Record<string, number>>,
  validIds: ReadonlySet<string>,
): Record<string, number> {
  let changed = false
  const next: Record<string, number> = {}
  for (const [sid, ts] of Object.entries(prev)) {
    if (validIds.has(sid)) next[sid] = ts
    else changed = true
  }
  return changed ? next : (prev as Record<string, number>)
}
