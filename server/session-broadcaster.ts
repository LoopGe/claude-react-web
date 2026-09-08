// Per-session subscription + signal-broadcast plumbing: context usage,
// prompt suggestions, tasks, git status, message status, recap, slash
// command changes, hook runs, and session-cleared signals.
//
// Extracted from session-manager.ts for modularity. Every method here only
// touches a session's own Set<Pushable<T>> subscriber fields (or a small
// mirrored snapshot field like `lastContextUsage`/`recap`/`tasks`/`hookRuns`)
// — none of it depends on any other SessionManager state, so the whole
// family lifts out with a single dependency: the live sessions map.
//
// SessionEventBroadcaster owns:
//   - subscribeContextUsage / subscribePromptSuggestion / subscribeTasks /
//     subscribeGitStatus / subscribeMessageStatus / subscribeSessionRecap /
//     subscribeCommandChanges / subscribeHookRuns / subscribeSessionCleared
//   - recordHookRun / broadcastCommandsChanged / broadcastGitStatusChanged /
//     broadcastSessionCleared
//   - The shared subscribePushableSet helper backing all of the above
//
// SessionManager retains:
//   - Thin proxy methods (same names) so it keeps satisfying the
//     `SessionBroadcaster` interface (session-types.ts) structurally — `this`
//     is still handed to ws.ts / git-broadcast.ts / PumpDeps.broadcaster as
//     before, and `vi.spyOn(sm, 'broadcastGitStatusChanged')` in tests still
//     works since the method lives on the SessionManager instance.

import type { Session } from './session-types.js'
import type { SessionRecap } from './session-types.js'
import type { WsMessageConsumed, WsMessagesWithdrawn } from './ws-protocol.js'
import type { HookRunRecord, HookRuntimeEvent } from '../shared/hooks.js'
import type { Pushable } from './pushable.js'
import { createPushable } from './pushable.js'
import { invalidateStatusCache } from './git.js'

export class SessionEventBroadcaster {
  constructor(private sessions: Map<string, Session>) {}

  /** AsyncIterable of context-usage snapshots for one session.
   *  Returns null if the session doesn't exist (caller should treat
   *  as "no context data available").
   *  Each subscriber gets its own pushable to avoid waiter overwrite
   *  when multiple tabs are connected to the same session. */
  subscribeContextUsage(id: string): { iterable: AsyncIterable<unknown>; snapshot?: import('./session-pump.js').LiteContextUsage | undefined; unsubscribe: () => void } | null {
    const s = this.sessions.get(id)
    if (!s) return null
    const sub = this.subscribePushableSet(s, s.contextUsageSubscribers, 'ctx', 50)
    return { iterable: sub.iterable, snapshot: s.lastContextUsage, unsubscribe: sub.unsubscribe }
  }

  /** AsyncIterable of prompt-suggestion strings for one session.
   *  Mirrors subscribeContextUsage. Returns null when the session is
   *  unknown. Each subscriber gets its own pushable. */
  subscribePromptSuggestion(id: string): { iterable: AsyncIterable<unknown>; snapshot?: string | null; unsubscribe: () => void } | null {
    const s = this.sessions.get(id)
    if (!s) return null
    const sub = this.subscribePushableSet(s, s.promptSuggestionSubscribers, 'psug', 10)
    return { iterable: sub.iterable, snapshot: s.lastPromptSuggestion, unsubscribe: sub.unsubscribe }
  }

  /** AsyncIterable of full task-list snapshots for one session. Mirrors
   *  subscribeContextUsage. The snapshot is ALWAYS present (empty array
   *  when no tasks) so a freshly subscribed tab can initialize its
   *  TasksPanel unconditionally. Returns null when the session is
   *  unknown. */
  subscribeTasks(id: string): { iterable: AsyncIterable<unknown>; snapshot: import('../shared/tasks.js').TaskRecordUi[]; unsubscribe: () => void } | null {
    const s = this.sessions.get(id)
    if (!s) return null
    const sub = this.subscribePushableSet(s, s.taskSubscribers, 'tasks', 20)
    return { iterable: sub.iterable, snapshot: Array.from(s.tasks.values()), unsubscribe: sub.unsubscribe }
  }

  /** AsyncIterable of `git-status-changed` signal frames for one session.
   *  Mirrors subscribeContextUsage; returns null when the session is
   *  unknown so callers can short-circuit gracefully. */
  subscribeGitStatus(id: string): { iterable: AsyncIterable<unknown>; unsubscribe: () => void } | null {
    const s = this.sessions.get(id)
    if (!s) return null
    return this.subscribePushableSet(s, s.gitStatusSubscribers, 'git', 20)
  }

  /** AsyncIterable of `message-consumed` / `messages-withdrawn` signal
   *  frames for one session. Mirrors subscribeGitStatus. A `message-consumed`
   *  frame carries the uuid + consumedAt of a user message the SDK has just
   *  read off the input queue, so the client can flip its bubble from
   *  "queued" to "consumed"; a `messages-withdrawn` frame lists the queued
   *  turns an interrupt with cancelQueued removed. A small maxDepth is fine
   *  for consumed frames: the durable truth lives on the message object's
   *  `consumedAt` (replayed on reconnect), so a dropped live frame self-
   *  heals on the next replay. Withdrawals have no such replay mirror — the
   *  messages are GONE from the ring — so every new subscriber is seeded
   *  with the recorded withdrawal window instead. */
  subscribeMessageStatus(id: string): {
    iterable: AsyncIterable<WsMessageConsumed | WsMessagesWithdrawn>
    unsubscribe: () => void
  } | null {
    const s = this.sessions.get(id)
    if (!s) return null
    return this.subscribePushableSet(s, s.messageStatusSubscribers, 'msgstat', 50, () =>
      s.withdrawnUuids.length > 0
        ? [{ kind: 'messages-withdrawn' as const, sessionId: id, uuids: [...s.withdrawnUuids] }]
        : [],
    )
  }

  /** AsyncIterable of recap-update events for one session. Returns the
   *  current recap snapshot alongside the iterable so a freshly-attached
   *  tab sees existing state without having to wait for the next
   *  transition. Null when the session is unknown. */
  subscribeSessionRecap(id: string): {
    iterable: AsyncIterable<unknown>
    snapshot: SessionRecap | undefined
    unsubscribe: () => void
  } | null {
    const s = this.sessions.get(id)
    if (!s) return null
    const sub = this.subscribePushableSet(s, s.recapSubscribers, 'recap', 20)
    return {
      iterable: sub.iterable,
      snapshot: s.recap,
      unsubscribe: sub.unsubscribe,
    }
  }

  subscribeCommandChanges(id: string): { iterable: AsyncIterable<unknown>; unsubscribe: () => void } | null {
    const s = this.sessions.get(id)
    if (!s) return null
    return this.subscribePushableSet(s, s.commandSubscribers, 'cmds', 20)
  }

  subscribeHookRuns(id: string): {
    iterable: AsyncIterable<HookRuntimeEvent>
    snapshot: HookRunRecord[]
    unsubscribe: () => void
  } | null {
    const s = this.sessions.get(id)
    if (!s) return null
    const sub = this.subscribePushableSet<HookRuntimeEvent>(s, s.hookRunSubscribers, 'hooks', 100)
    return { iterable: sub.iterable, snapshot: s.hookRuns.slice(), unsubscribe: sub.unsubscribe }
  }

  recordHookRun(id: string, event: HookRuntimeEvent): void {
    const s = this.sessions.get(id)
    if (!s) return
    const idx = s.hookRuns.findIndex((run) => run.id === event.run.id)
    if (idx >= 0) s.hookRuns[idx] = event.run
    else s.hookRuns.push(event.run)
    while (s.hookRuns.length > 100) s.hookRuns.shift()
    for (const sub of s.hookRunSubscribers) {
      try { sub.push(event) } catch { /* subscriber dead - skip */ }
    }
  }

  broadcastCommandsChanged(id: string, commands: unknown[]): void {
    const s = this.sessions.get(id)
    if (!s || s.commandSubscribers.size === 0) return
    const payload = { commands }
    for (const sub of s.commandSubscribers) {
      try { sub.push(payload) } catch { /* subscriber dead - skip */ }
    }
  }

  /** AsyncIterable of `session-cleared` signal frames for one session.
   *  Mirrors subscribeGitStatus; returns null when the session is unknown.
   *  Small maxDepth — a clear is a rare, idempotent event and the durable
   *  truth (the truncated history ring) is replayed on reconnect, so a
   *  dropped live frame self-heals. */
  subscribeSessionCleared(id: string): { iterable: AsyncIterable<unknown>; unsubscribe: () => void } | null {
    const s = this.sessions.get(id)
    if (!s) return null
    return this.subscribePushableSet(s, s.sessionClearedSubscribers, 'cleared', 10)
  }

  /** Broadcast a `session-cleared` signal to every subscriber of the given
   *  session. No-op when the session is unknown or has no subscribers.
   *  Signal-only (bare sessionId) — the client resets its transcript store
   *  and drops its local cache in response. Called by the pump after a
   *  `/clear`-triggered context reset is confirmed (and the history ring
   *  has already been truncated). */
  broadcastSessionCleared(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    if (s.sessionClearedSubscribers.size === 0) return
    const frame = { kind: 'session-cleared' as const, sessionId: id }
    for (const sub of s.sessionClearedSubscribers) {
      try { sub.push(frame) } catch { /* subscriber dead — skip */ }
    }
  }

  /** Broadcast a `git-status-changed` signal to every subscriber of the
   *  given session. No-op when the session is unknown or has no
   *  subscribers. The payload is bare (signal-only) — the client side
   *  responds by re-fetching its useGitStatus endpoint. */
  broadcastGitStatusChanged(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    // Drop any cached read-route status for this cwd so the refetch the
    // clients are about to issue recomputes from ground truth (the cache
    // only exists to coalesce that refetch herd, never to hide a change).
    if (s.cwd) invalidateStatusCache(s.cwd)
    if (s.gitStatusSubscribers.size === 0) return
    const frame = { kind: 'git-status-changed' as const, sessionId: id }
    for (const sub of s.gitStatusSubscribers) {
      try { sub.push(frame) } catch { /* subscriber dead — skip */ }
    }
  }

  /** Shared implementation for subscribeContextUsage / subscribeGitStatus.
   *  Creates a per-subscriber pushable, registers it in the given set, and
   *  returns the iterable + cleanup function. */
  private subscribePushableSet<T = unknown>(
    s: Session,
    set: Set<Pushable<T>>,
    label: string,
    maxSize: number,
    /** Optional catch-up seed: frames pushed into the fresh pushable before
     *  the subscriber has a chance to iterate, so state that exists only
     *  server-side (no replay mirror) still reaches a freshly-attached
     *  client. Empty = nothing. */
    seed?: () => Iterable<T>,
  ): { iterable: AsyncIterable<T>; unsubscribe: () => void } {
    const pushable = createPushable<T>(`${label}-${s.id.slice(0, 8)}`, maxSize)
    if (seed) {
      for (const frame of seed()) pushable.push(frame)
    }
    set.add(pushable)
    return {
      iterable: pushable.iterable,
      unsubscribe: () => {
        set.delete(pushable)
        pushable.end()
      },
    }
  }
}
