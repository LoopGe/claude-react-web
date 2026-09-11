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
import type { WsMessageConsumed, WsMessagesWithdrawn, WsGitSnapshot } from './ws-protocol.js'
import type { HookRunRecord, HookRuntimeEvent } from '../shared/hooks.js'
import type { Pushable } from './pushable.js'
import { createPushable } from './pushable.js'
import { createLogger } from './log.js'
import { getStatus, listBranches, listStashes } from './git.js'
import type { GitStatusResponse, GitBranch, GitStashEntry } from '../shared/git-types.js'

const log = createLogger('git-snapshot')

/** The three lists that make up one pushed git snapshot. */
export interface GitSnapshotPayload {
  status: GitStatusResponse
  branches: GitBranch[]
  stashes: GitStashEntry[]
}

/** Fan-out group key: spawn-captured work-tree top level, falling back to
 *  cwd string equality for non-repo sessions and pre-upgrade metas. The
 *  `?? s.id` last resort keeps cwd-less sessions in their own group. */
function gitGroupKey(s: Session): string {
  return s.repoRoot ?? s.cwd ?? s.id
}

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

  /** AsyncIterable of full `git-snapshot` frames for one session. A fresh
   *  subscriber is seeded with the group's most recent frame (when one
   *  exists) before live frames flow — a newly opened tab paints instantly
   *  without an HTTP round-trip. maxDepth 5: frames are fat but idempotent
   *  and droppable — a dropped frame self-heals on the next mutation, and
   *  the shallow queue keeps memory bounded. Returns null when the session
   *  is unknown. */
  subscribeGitStatus(id: string): { iterable: AsyncIterable<WsGitSnapshot>; unsubscribe: () => void } | null {
    const s = this.sessions.get(id)
    if (!s) return null
    const cached = this.gitSnapshots.get(gitGroupKey(s))
    this.pruneGitSnapshots()
    return this.subscribePushableSet<WsGitSnapshot>(s, s.gitStatusSubscribers as Set<Pushable<WsGitSnapshot>>, 'git', 5, () =>
      cached ? [cached] : [],
    )
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

  /** Most recent pushed snapshot per group key — seeds fresh subscribers
   *  (mirrors subscribeTasks' snapshot pattern, but via the pushable seed
   *  callback so ws.ts needs no special case). Pruned lazily: a key with
   *  no live session is dropped on the next emit or subscribe. */
  private gitSnapshots = new Map<string, WsGitSnapshot>()

  /** Compute (or adopt from opts) the group's git snapshot, cache it for
   *  subscriber seeding, and push a `git-snapshot` frame to every session
   *  sharing the trigger's group key — not just the trigger's own
   *  subscribers. Two sessions on the same repo therefore stay in sync:
   *  Claude's edits in A refresh B's chip/panel, and a commit in B's
   *  GitPanel refreshes A.
   *
   *  Fire-and-forget by design (call sites are sync): the async compute
   *  runs detached, failures log a warning and push nothing — clients
   *  keep their last known state and the next mutation retries. Write
   *  routes pass `opts.snapshot` with whatever they already computed
   *  (status for stage/commit, +branches for checkout, +stashes for
   *  stash ops); missing fields are computed here so a field is never
   *  git-spawned twice in one broadcast. */
  broadcastGitStatusChanged(id: string, opts?: { snapshot?: Partial<GitSnapshotPayload> }): void {
    void this.emitGitSnapshot(id, opts?.snapshot).catch((err: unknown) => {
      log.warn(`git snapshot compute failed session=${id}: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  private async emitGitSnapshot(id: string, partial?: Partial<GitSnapshotPayload>): Promise<void> {
    const s = this.sessions.get(id)
    if (!s || !s.cwd) return
    const key = gitGroupKey(s)
    const [status, branches, stashes] = await Promise.all([
      partial?.status ?? getStatus(s.cwd),
      partial?.branches ?? listBranches(s.cwd),
      partial?.stashes ?? listStashes(s.cwd),
    ])
    const frame: WsGitSnapshot = { kind: 'git-snapshot', sessionId: id, cwd: s.cwd, repoRoot: key, status, branches, stashes }
    this.gitSnapshots.set(key, frame)
    this.pruneGitSnapshots()
    for (const other of this.sessions.values()) {
      if (gitGroupKey(other) !== key) continue
      for (const sub of other.gitStatusSubscribers) {
        try { sub.push(frame) } catch { /* subscriber dead - skip */ }
      }
    }
  }

  /** Drop seed entries whose group no longer has a live session. Cheap
   *  (few keys); called after every emit and on subscribe. */
  private pruneGitSnapshots(): void {
    if (this.gitSnapshots.size === 0) return
    const live = new Set<string>()
    for (const s of this.sessions.values()) live.add(gitGroupKey(s))
    for (const k of this.gitSnapshots.keys()) {
      if (!live.has(k)) this.gitSnapshots.delete(k)
    }
  }

  /** The group key of one session, or null when unknown. Consumed by
   *  git-broadcast's per-group debounce. */
  gitGroupKeyOf(sessionId: string): string | null {
    const s = this.sessions.get(sessionId)
    return s ? gitGroupKey(s) : null
  }

  /** Another live session sharing this session's group key, or null when
   *  this is the only member. Consumed by cancelGitBroadcast: an unload
   *  must not kill a pending debounced broadcast that peers still need. */
  gitGroupLivePeer(sessionId: string): string | null {
    const s = this.sessions.get(sessionId)
    if (!s) return null
    const key = gitGroupKey(s)
    for (const other of this.sessions.values()) {
      if (other.id !== sessionId && gitGroupKey(other) === key) return other.id
    }
    return null
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
