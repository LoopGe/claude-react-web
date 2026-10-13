// Per-git-group debounce wrapper around SessionManager.broadcastGitStatusChanged.
//
// When Claude runs a tool that mutates the filesystem, the session-pump
// detects the matching tool_result and asks us to broadcast a
// `git-snapshot` frame fanned out by group key. A long-running plan can
// run 5+ Edit/Write calls back-to-back;
// if we broadcast each one immediately, the chip (which refetches `git
// status`) gets hammered with redundant requests.
//
// This module coalesces bursts *per git group* (sessions sharing the same
// repo root): every call within DEBOUNCE_MS resets the group's timer, so a
// streak of mutations produces one broadcast DEBOUNCE_MS after the last one
// settles — but never later than GIT_BROADCAST_MAX_WAIT_MS after the first
// schedule of the streak, so a continuous stream still refreshes every ≤ 3 s.
// When multiple sessions share a group key their schedules collapse onto a
// single timer. Timer state is per SessionBroadcaster (WeakMap), not
// module-global, so two managers (tests, embedded hosts) never share or
// clobber each other's timers.
//
// User-initiated writes (the POST routes in `routes/git-write.ts`) call
// `sm.broadcastGitStatusChanged` directly to keep their UX latency tight;
// only the auto-detection path pays the debounce.
//
// On session unload, `cancelGitBroadcast` checks whether a live peer still
// needs the pending broadcast: if so the timer survives and its origin
// re-points to the peer; otherwise the timer is cleared.

import type { SessionBroadcaster } from './session-types.js'
import { firstPartyRegistry } from './sdk-tools/registry.js'
import { isReadOnlyBash } from './readonly-bash.js'
import { DEBOUNCE_MS, GIT_BROADCAST_MAX_WAIT_MS } from './constants.js'

interface DebounceEntry {
  timer: NodeJS.Timeout
  /** The session whose schedule most recently (re)set this timer. The
   *  broadcast fires with this id — it only names the trigger for
   *  logging/frame.sessionId; fan-out is group-wide regardless. */
  originSessionId: string
  /** Date.now() of the first schedule since the group's last fire — the
   *  anchor of the max-wait cap. Carried across re-arms. */
  firstScheduledAt: number
}
/** Per manager, keyed by git group key (repoRoot ?? cwd ?? id), NOT
 *  sessionId: bursts from two sessions in the same repo coalesce into one
 *  compute+push. */
const stateByManager = new WeakMap<SessionBroadcaster, Map<string, DebounceEntry>>()

function timersOf(sm: SessionBroadcaster): Map<string, DebounceEntry> {
  let timers = stateByManager.get(sm)
  if (!timers) {
    timers = new Map()
    stateByManager.set(sm, timers)
  }
  return timers
}

export function scheduleGitBroadcast(sm: SessionBroadcaster, sessionId: string): void {
  // No subscribeGitStatus call here — the broadcast call inside the
  // timer is itself a no-op when no subscribers are attached, so there's
  // nothing to short-circuit.
  const timers = timersOf(sm)
  const key = sm.gitGroupKeyOf(sessionId) ?? sessionId
  const existing = timers.get(key)
  if (existing) clearTimeout(existing.timer)
  const now = Date.now()
  const firstScheduledAt = existing?.firstScheduledAt ?? now
  const delay = Math.max(0, Math.min(DEBOUNCE_MS, firstScheduledAt + GIT_BROADCAST_MAX_WAIT_MS - now))
  const t = setTimeout(() => {
    const entry = timers.get(key)
    timers.delete(key)
    // The broadcaster contract: if the session was unloaded between the
    // schedule call and the timer firing, this is a no-op. We don't need
    // to guard separately. Read originSessionId at fire time — cancel may
    // have re-pointed it to a live peer.
    sm.broadcastGitStatusChanged(entry?.originSessionId ?? sessionId)
  }, delay)
  // unref so a pending broadcast doesn't keep Node alive past server
  // shutdown. Some test harnesses run on Node ≥18 where timeout.unref
  // is always present, but guard for older typings.
  t.unref?.()
  timers.set(key, { timer: t, originSessionId: sessionId, firstScheduledAt })
}

/** Cancel the pending debounced broadcast *iff* `sessionId` is its origin
 *  AND no live peer shares the group — an unload must not kill a refresh
 *  peers still need. With a live peer the timer survives and its origin
 *  re-points to the peer so the broadcast still fires. */
export function cancelGitBroadcast(sm: SessionBroadcaster, sessionId: string): void {
  const timers = stateByManager.get(sm)
  if (!timers) return
  const key = sm.gitGroupKeyOf(sessionId) ?? sessionId
  const entry = timers.get(key)
  if (!entry || entry.originSessionId !== sessionId) return
  const peer = sm.gitGroupLivePeer(sessionId)
  if (peer) {
    entry.originSessionId = peer
    return
  }
  clearTimeout(entry.timer)
  timers.delete(key)
}

// ── Tool-use detection ─────────────────────────────────────────────────
// Pure helpers extracted so the session-pump's mutating-tool detection
// can be unit-tested without spinning up a Query.

/** The set of SDK tool names we treat as "filesystem-mutating". A
 *  tool_result for any of these triggers a debounced broadcast. Bash
 *  and PowerShell are included because their commands frequently touch
 *  files (`git` itself, `mv` / `Remove-Item`, `npm install`, etc.) —
 *  EXCEPT a command the fail-closed isReadOnlyBash classifier proves
 *  read-only (`ls`, `cat`, `git status`, …; see mutatingToolUseId), which
 *  would only buy a snapshot identical to the last one. PowerShell reuses
 *  the Bash classifier: its read-only set are PowerShell aliases too, and
 *  anything it can't prove (quotes, `$`, backslashes, pipes) still
 *  broadcasts, so a miss costs at worst a stale chip until the next
 *  mutation, never a missed refresh. */
export const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Edit',
  'Write',
  'NotebookEdit',
  'Bash',
  'PowerShell',
])

/** Built-in mutating tools ∪ first-party mutating tools (FQNs like
 *  `mcp__git-tools__git_stage`). The pump matches tool_use block names against
 *  this — FQN form, matching what the SDK reports for in-process MCP tools. */
/** Worktree entry/exit tools. EnterWorktree creates a linked worktree (a
 *  real filesystem + git mutation); ExitWorktree removes one (action
 *  'remove') or leaves it in place ('keep'). Either way the repo's
 *  worktree set can change, so a tool_result for these should also nudge
 *  git consumers — the chip reconciles EnterWorktree intent against
 *  `git worktree list`. */
const WORKTREE_CHANGE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'EnterWorktree',
  'ExitWorktree',
])

const ALL_MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...MUTATING_TOOL_NAMES,
  ...WORKTREE_CHANGE_TOOL_NAMES,
  ...firstPartyRegistry.mutatingToolFqns(),
])

interface ToolUseLike {
  type?: string
  name?: string
  id?: string
  input?: { command?: unknown } | null
}

/** Shell tools whose read-only commands are filtered out. */
const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set(['Bash', 'PowerShell'])

/** Returns the tool_use id when `block` is a mutating tool_use block,
 *  or null otherwise. Lets the pump scan an assistant message's content
 *  array and remember each id for later matching against tool_results. */
export function mutatingToolUseId(block: unknown): string | null {
  if (!block || typeof block !== 'object') return null
  const b = block as ToolUseLike
  if (b.type !== 'tool_use') return null
  if (typeof b.name !== 'string' || !ALL_MUTATING_TOOL_NAMES.has(b.name)) return null
  if (typeof b.id !== 'string') return null
  // A provably read-only shell command can't change git state. Missing /
  // non-string input fails closed (isReadOnlyBash → false → broadcast).
  if (SHELL_TOOL_NAMES.has(b.name) && isReadOnlyBash(b.input?.command)) return null
  return b.id
}
