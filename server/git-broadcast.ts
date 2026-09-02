// Per-session debounce wrapper around SessionManager.broadcastGitStatusChanged.
//
// When Claude runs a tool that mutates the filesystem, the session-pump
// detects the matching tool_result and asks us to broadcast a
// `git-status-changed` frame. A long-running plan can run 5+ Edit/Write
// calls back-to-back; if we broadcast each one immediately, the chip
// (which refetches `git status`) gets hammered with redundant requests.
//
// This module coalesces bursts: every call within DEBOUNCE_MS resets the
// timer, so a streak of mutations produces exactly one broadcast `DEBOUNCE_MS`
// after the last one settles. User-initiated writes (the POST routes in
// `routes/git-write.ts`) call `sm.broadcastGitStatusChanged` directly to
// keep their UX latency tight; only the auto-detection path pays the
// debounce.

import type { SessionBroadcaster } from './session-types.js'
import { firstPartyRegistry } from './sdk-tools/registry.js'

const DEBOUNCE_MS = 500
const timers = new Map<string, NodeJS.Timeout>()

export function scheduleGitBroadcast(sm: SessionBroadcaster, sessionId: string): void {
  // No subscribeGitStatus call here — the broadcast call inside the
  // timer is itself a no-op when no subscribers are attached, so there's
  // nothing to short-circuit.
  const existing = timers.get(sessionId)
  if (existing) clearTimeout(existing)
  const t = setTimeout(() => {
    timers.delete(sessionId)
    // The broadcaster contract: if the session was unloaded between the
    // schedule call and the timer firing, this is a no-op. We don't need
    // to guard separately.
    sm.broadcastGitStatusChanged(sessionId)
  }, DEBOUNCE_MS)
  // unref so a pending broadcast doesn't keep Node alive past server
  // shutdown. Some test harnesses run on Node ≥18 where timeout.unref
  // is always present, but guard for older typings.
  t.unref?.()
  timers.set(sessionId, t)
}

/** Cancel any pending broadcast for the given session. Call this from
 *  session unload paths so we don't fire a stale event after the
 *  session has been removed. */
export function cancelGitBroadcast(sessionId: string): void {
  const existing = timers.get(sessionId)
  if (existing) {
    clearTimeout(existing)
    timers.delete(sessionId)
  }
}

/** Test-only: clear all pending timers and any internal state.
 *  Real code should never call this. */
export function _resetGitBroadcastForTests(): void {
  for (const t of timers.values()) clearTimeout(t)
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
const ALL_MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...MUTATING_TOOL_NAMES,
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
