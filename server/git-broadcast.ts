// Per-git-group debounce wrapper around SessionManager.broadcastGitStatusChanged.
//
// When Claude runs a tool that mutates the filesystem, the session-pump
// detects the matching tool_result and asks us to broadcast a
// `git-status-changed` frame (now a full git-snapshot frame fanned out by
// group key). A long-running plan can run 5+ Edit/Write calls back-to-back;
// if we broadcast each one immediately, the chip (which refetches `git
// status`) gets hammered with redundant requests.
//
// This module coalesces bursts *per git group* (sessions sharing the same
// repo root): every call within DEBOUNCE_MS resets the group's timer, so a
// streak of mutations produces exactly one broadcast DEBOUNCE_MS after the
// last one settles. When multiple sessions share a group key their
// schedules collapse onto a single timer.
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

const DEBOUNCE_MS = 500
interface DebounceEntry {
  timer: NodeJS.Timeout
  /** The session whose schedule most recently (re)set this timer. The
   *  broadcast fires with this id — it only names the trigger for
   *  logging/frame.sessionId; fan-out is group-wide regardless. */
  originSessionId: string
}
/** Keyed by git group key (repoRoot ?? cwd ?? id), NOT sessionId: bursts
 *  from two sessions in the same repo coalesce into one compute+push. */
const timers = new Map<string, DebounceEntry>()

export function scheduleGitBroadcast(sm: SessionBroadcaster, sessionId: string): void {
  // No subscribeGitStatus call here — the broadcast call inside the
  // timer is itself a no-op when no subscribers are attached, so there's
  // nothing to short-circuit.
  const key = sm.gitGroupKeyOf(sessionId) ?? sessionId
  const existing = timers.get(key)
  if (existing) clearTimeout(existing.timer)
  const t = setTimeout(() => {
    const entry = timers.get(key)
    timers.delete(key)
    // The broadcaster contract: if the session was unloaded between the
    // schedule call and the timer firing, this is a no-op. We don't need
    // to guard separately. Read originSessionId at fire time — cancel may
    // have re-pointed it to a live peer.
    sm.broadcastGitStatusChanged(entry?.originSessionId ?? sessionId)
  }, DEBOUNCE_MS)
  // unref so a pending broadcast doesn't keep Node alive past server
  // shutdown. Some test harnesses run on Node ≥18 where timeout.unref
  // is always present, but guard for older typings.
  t.unref?.()
  timers.set(key, { timer: t, originSessionId: sessionId })
}

/** Cancel the pending debounced broadcast *iff* `sessionId` is its origin
 *  AND no live peer shares the group — an unload must not kill a refresh
 *  peers still need. With a live peer the timer survives and its origin
 *  re-points to the peer so the broadcast still fires. */
export function cancelGitBroadcast(sm: SessionBroadcaster, sessionId: string): void {
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

/** Test-only: clear all pending timers and any internal state.
 *  Real code should never call this. */
export function _resetGitBroadcastForTests(): void {
  for (const t of timers.values()) clearTimeout(t.timer)
  timers.clear()
}

// ── Tool-use detection ─────────────────────────────────────────────────
// Pure helpers extracted so the session-pump's mutating-tool detection
// can be unit-tested without spinning up a Query.

/** The set of SDK tool names we treat as "filesystem-mutating". A
 *  tool_result for any of these triggers a debounced broadcast. Bash
 *  and PowerShell are included because their commands frequently touch
 *  files (`git` itself, `mv` / `Remove-Item`, `npm install`, etc.);
 *  it's coarser than a per-command whitelist but the cost of an extra
 *  `git status` is negligible relative to false negatives. */
export const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Edit',
  'Write',
  'NotebookEdit',
  'Bash',
  'PowerShell',
])

/** Built-in mutating tools ∪ first-party mutating tools (FQNs like
 *  `mcp__apptools__git_stage`). The pump matches tool_use block names against
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
}

/** Returns the tool_use id when `block` is a mutating tool_use block,
 *  or null otherwise. Lets the pump scan an assistant message's content
 *  array and remember each id for later matching against tool_results. */
export function mutatingToolUseId(block: unknown): string | null {
  if (!block || typeof block !== 'object') return null
  const b = block as ToolUseLike
  if (b.type !== 'tool_use') return null
  if (typeof b.name !== 'string' || !ALL_MUTATING_TOOL_NAMES.has(b.name)) return null
  if (typeof b.id !== 'string') return null
  return b.id
}
