// Transport-agnostic bridge between one client connection and the
// SessionManager's fan-out iterables.
//
// This is the body that used to live inside `wss.on('connection', ...)` in
// ws.ts, extracted so a second transport (an Electron MessagePort, a Unix
// socket, …) can drive the exact same behavior. It owns:
//   - the global session-list channel + global permission/notification mirror
//   - the app-plugin channel
//   - per-session subscribe/unsubscribe: replay, ack, live drivers, teardown
//   - client-frame validation (subscribe / unsubscribe / ping)
// and it writes through a {@link FrameSink}, which owns queueing/backpressure.
//
// The SessionManager already publishes everything through its
// `subscribeGlobal / subscribe / subscribePermissions / …` iterables; this
// module is a thin fan-out bridge and never calls a SessionManager mutator.
//
// History replay on subscribe is transactional: we fetch the snapshot, then
// the live iterable — in that order, synchronously — so there's no gap during
// which a newly-produced event could be missed.

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { SessionBroadcaster } from './session-types.js'
import type { AppPluginBroadcaster } from './app-plugins/event-bus.js'
import { shouldBroadcastMessage } from './history-utils.js'
import { planTailBackfillReplay } from './replay-plan.js'
import { createLogger } from './log.js'
import { metrics } from './metrics.js'
import type {
  WsClientFrame,
  WsGitSnapshot,
  WsMessageConsumed,
  WsMessagesWithdrawn,
  WsReplay,
  WsServerFrame,
  WsSubscribeResultReason,
} from './ws-protocol.js'
import type { HookRunRecord, HookRuntimeEvent } from '../shared/hooks.js'
import type { TaskRecordUi } from '../shared/tasks.js'

// Same scope as the old ws.ts logger so log output is unchanged.
const log = createLogger('ws')

/** Write endpoint for one client connection.
 *
 *  `send` takes a frame object; `sendRaw` takes an already-serialized frame
 *  string (the hot `message` path shares one JSON string across every
 *  subscribed connection). Implementations own their own queueing,
 *  backpressure and overflow policy — the bridge only ever calls these.
 *
 *  `close` stops accepting frames and releases resources; the bridge calls it
 *  exactly once on teardown. */
export interface FrameSink {
  send(frame: WsServerFrame): void
  sendRaw(data: string, kind?: string): void
  close(): void
}

export interface FrameBridgeDeps {
  sm: SessionBroadcaster
  appPlugins?: AppPluginBroadcaster
}

function hookSnapshotEvent(run: HookRunRecord): HookRuntimeEvent {
  if (run.status === 'started') return { kind: 'started', run }
  if (run.status === 'progress') return { kind: 'progress', run }
  return { kind: 'completed', run }
}

/** Shared cache of serialized `message` frames, keyed by the SDK message
 *  object identity. The pump pushes the SAME message object reference into
 *  every subscriber's async-subscription queue (no per-subscriber clone),
 *  so every connection subscribed to a session receives an identical
 *  `{ kind: 'message', sessionId, message }` frame. Without this cache each
 *  connection's `sendRaw()` would `JSON.stringify` that frame independently
 *  — M subscribed tabs means M× serialization of the same payload on every
 *  SDK message (the hot path during streaming). A given message object
 *  belongs to exactly one session, so baking `sessionId` into the cached
 *  string is safe. Entries are GC'd automatically when the history ring
 *  evicts the message object. */
const messageFrameJsonCache = new WeakMap<object, string>()

function messageFrameJson(sessionId: string, message: object): string {
  let json = messageFrameJsonCache.get(message)
  if (json === undefined) {
    json = JSON.stringify({ kind: 'message', sessionId, message })
    messageFrameJsonCache.set(message, json)
  }
  return json
}

/** Per-session subscription state held inside one connection. The cleanup
 *  fn lets us tear the session's driver down when the connection closes or
 *  the client unsubscribes. */
interface SessionSub {
  sessionId: string
  cleanup: () => void
}

/**
 * One client connection. Construct it, wire the transport's own inbound
 * handlers, then call {@link start} to begin the always-on channels.
 */
export class SessionConnection {
  private readonly sink: FrameSink
  private readonly sm: SessionBroadcaster
  private readonly appPlugins?: AppPluginBroadcaster

  private readonly subs = new Map<string, SessionSub>()
  /** Sessions whose subscribe-setup is mid-flight (waiting on the
   *  auto-resume await below). Guard: a second subscribe frame for the
   *  same session must not race the first through the await — subs.has()
   *  is only set after it completes. */
  private readonly starting = new Set<string>()

  private globalCleanup: (() => void) | null = null
  private appPluginCleanup: (() => void) | null = null
  private closed = false

  constructor(deps: FrameBridgeDeps, sink: FrameSink) {
    this.sm = deps.sm
    this.appPlugins = deps.appPlugins
    this.sink = sink
  }

  /** Begin the always-on channels (global session list + app plugins).
   *  Call once after the transport's inbound listeners are wired, so no
   *  client frame can race channel setup. */
  start(): void {
    this.startGlobal()
    this.startAppPlugins()
  }

  // --- global channel: sessions list + global permission mirror ----
  private startGlobal(): void {
    const global = this.sm.subscribeGlobal()
    this.globalCleanup = () => global.unsubscribe()
    this.sink.send({ kind: 'sessions-snapshot', sessions: global.snapshot })
    void (async () => {
      try {
        for await (const ev of global.iterable) {
          if (this.closed) return
          if (ev.kind === 'update') this.sink.send({ kind: 'session-update', session: ev.session })
          else if (ev.kind === 'created') this.sink.send({ kind: 'session-created', session: ev.session, joinGroupOf: ev.joinGroupOf, evictingSource: ev.evictingSource, replacesSource: ev.replacesSource })
          else if (ev.kind === 'removed') this.sink.send({ kind: 'session-removed', id: ev.id })
          else if (ev.kind === 'permission_request') {
            this.sink.send({
              kind: 'global-permission-request',
              sessionId: ev.sessionId,
              request: ev.request,
            })
          } else if (ev.kind === 'cli_notification') {
            this.sink.send({
              kind: 'cli-notification',
              sessionId: ev.sessionId,
              notification: ev.notification,
            })
          }
        }
      } catch (err) {
        if (!this.closed) {
          this.sink.send({ kind: 'error', message: `global channel: ${(err as Error).message}` })
        }
      }
    })()
  }

  // --- app-plugin channel (snapshot + state/contributions updates) ---
  // Only started when an AppPluginManager was wired in. Mirrors the global
  // channel: subscribe once per connection, fan every event into a frame.
  private startAppPlugins(): void {
    if (!this.appPlugins) return
    const sub = this.appPlugins.subscribeAppPlugins()
    this.appPluginCleanup = () => sub.unsubscribe()
    void (async () => {
      try {
        for await (const ev of sub.iterable) {
          if (this.closed) return
          if (ev.kind === 'snapshot') this.sink.send({ kind: 'app-plugins-snapshot', plugins: ev.plugins, widgetPayloads: ev.widgetPayloads })
          else if (ev.kind === 'state-changed') this.sink.send({ kind: 'app-plugin-state-changed', plugin: ev.plugin })
          else if (ev.kind === 'contributions-changed') {
            this.sink.send({
              kind: 'app-plugin-contributions-changed',
              pluginId: ev.pluginId,
              contributions: ev.contributions,
            })
          }
          else if (ev.kind === 'plugin-event') {
            this.sink.send({ kind: 'app-plugin-event', pluginId: ev.pluginId, widgetId: ev.widgetId, payload: ev.payload })
          }
        }
      } catch (err) {
        if (!this.closed) {
          this.sink.send({ kind: 'error', message: `app-plugins channel: ${(err as Error).message}` })
        }
      }
    })()
  }

  // --- inbound client frames ---------------------------------------
  /** Handle one client frame. `input` is a raw JSON string (WebSocket) or an
   *  already-decoded object (structured-clone transports like MessagePort). */
  handleClientFrame(input: string | object): void {
    let frame: WsClientFrame
    if (typeof input === 'string') {
      try {
        frame = JSON.parse(input) as WsClientFrame
      } catch {
        this.sink.send({ kind: 'error', message: 'invalid JSON frame' })
        return
      }
    } else {
      frame = input as WsClientFrame
    }
    if (!frame || typeof frame !== 'object' || typeof frame.kind !== 'string') {
      this.sink.send({ kind: 'error', message: 'frame missing kind' })
      return
    }
    switch (frame.kind) {
      case 'subscribe':
        if (typeof frame.sessionId === 'string' && frame.sessionId) {
          void this.startSession(
            frame.sessionId,
            frame.sinceUuid,
            frame.replayMode === 'tail-backfill' ? 'tail-backfill' : undefined,
          )
        }
        break
      case 'unsubscribe':
        if (typeof frame.sessionId === 'string' && frame.sessionId) this.stopSession(frame.sessionId)
        break
      case 'ping':
        this.sink.send({ kind: 'pong', nonce: frame.nonce })
        break
      default:
        // Exhaustiveness check — a new client-side kind we don't know.
        this.sink.send({ kind: 'error', message: `unknown kind: ${(frame as { kind: string }).kind}` })
    }
  }

  /** Tear the connection down: stop the sink, unsubscribe every session,
   *  detach the global + app-plugin listeners. Idempotent. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.sink.close()
    for (const s of this.subs.values()) s.cleanup()
    this.subs.clear()
    this.globalCleanup?.()
    this.globalCleanup = null
    this.appPluginCleanup?.()
    this.appPluginCleanup = null
  }

  // --- per-session channel (subscribe/unsubscribe) -----------------
  /** Answer one `subscribe` frame with the state of this connection's
   *  per-session channel. See WsSubscribeResult — the client keys its
   *  "do I need to ask again?" decision on this instead of inferring it
   *  from `replay` / `error` / the global session-update feed. */
  private ackSubscribe(
    sessionId: string,
    ok: boolean,
    reason: WsSubscribeResultReason,
  ): void {
    this.sink.send({ kind: 'subscribe-result', sessionId, ok, reason })
  }

  /** Build and send one replay burst for a session on THIS connection:
   *  the `sinceUuid`-sliced ring, filtered to what the live broadcast would
   *  send (shouldBroadcastMessage, matching session-pump.ts), chunked, then
   *  terminated by `replay-done`.
   *
   *  Shared by the establish path and the duplicate-subscribe path so the
   *  two can never drift. A duplicate IS re-served rather than dropped: the
   *  replay is per-connection and a listener may have attached after the
   *  first burst (a panel remount, StrictMode's double mount, or a resume
   *  whose replay landed before <Chat> existed), and only the server can
   *  know — so "I asked for this channel" always produces a replay.
   *  `pending` carries the permission/elicitation/dialog snapshots on the
   *  establish path; a re-serve omits them (the client re-reads that state
   *  over REST on mount, and a stale snapshot could resurrect an already
   *  resolved permission request). */
  private sendReplay(
    sessionId: string,
    history: SDKMessage[],
    sinceUuid: string | undefined,
    pending: Pick<WsReplay, 'permissions' | 'elicitations' | 'dialogs'> | null,
    replayMode?: 'tail-backfill',
  ): void {
    let replayHistory = history
    // If the client supplied `sinceUuid`, try to send only messages after
    // that point (incremental sync). Fall back to a full replay if the UUID
    // isn't in the ring (evicted by historyCap or the client cache is stale).
    if (sinceUuid) {
      const idx = history.findIndex((m) => (m as { uuid?: string }).uuid === sinceUuid)
      if (idx >= 0) {
        replayHistory = history.slice(idx + 1)
        log.info(
          `incremental sync for ${sessionId}: ` +
          `skipped ${idx + 1} msgs, sending ${replayHistory.length} new`,
        )
      } else {
        log.info(
          `sinceUuid ${sinceUuid} not found in ${sessionId} history ` +
          `(${history.length} msgs) — full replay`,
        )
      }
    }

    const replayStart = performance.now()
    // Filter out system messages that the frontend doesn't need. Matches
    // the live broadcast filter in session-pump.ts.
    replayHistory = replayHistory.filter(
      (m) => shouldBroadcastMessage(m as { type?: string; subtype?: string }),
    )
    const REPLAY_CHUNK_SIZE = 50
    // Key diagnostic: pairs with the client's replay-done handling. If the
    // server logs a non-zero count here but the client renders blank, the
    // loss is client-side (effect re-run discarded the buffer, or
    // REPLAY_REPLACE merge dropped everything).
    log.info(
      `replay for ${sessionId}: sending ${replayHistory.length} msgs ` +
      `(ring=${history.length}, sinceUuid=${sinceUuid ?? 'none'})`,
    )
    // Tail-first replay plan (no-cache cold start): the newest chunk is a
    // complete first screen, so send it first (tail: true — the client
    // applies it immediately) and the older chunks after it newest→oldest
    // (backfill: true — the client prepends each one, the same machinery the
    // scroll-up disk pager uses). Gated on the client opting in via
    // replayMode AND an absent sinceUuid: a sinceUuid implies a cached
    // client transcript, and backfill chunks are NEWER than a stale cache,
    // which would land above it on prepend, corrupting the ordering (see
    // replay-plan.ts). The plan doubles as the branch decider — a null plan
    // (payload fits one chunk) falls through to the ordinary paths below,
    // which is also the safe behavior should the planner's null contract
    // ever drift from the chunk-size check.
    const tailPlan =
      replayMode === 'tail-backfill' && !sinceUuid
        ? planTailBackfillReplay(replayHistory, REPLAY_CHUNK_SIZE)
        : null
    if (tailPlan) {
      log.info(
        `tail-first replay for ${sessionId}: tail=${tailPlan.tail.length} ` +
        `+ ${tailPlan.backfill.length} backfill chunks (${replayHistory.length} total)`,
      )
      // The pending-request snapshots ride the TAIL frame (same shape as the
      // ordinary single-frame replay), so a permission card appears with the
      // first paint instead of after the backfill drains — and a mid-burst
      // client effect re-run can never lose them at the terminator. The
      // trailing replay-done carries no payload; it only closes the burst.
      this.sink.send({
        kind: 'replay',
        sessionId,
        messages: tailPlan.tail,
        permissions: pending?.permissions ?? [],
        ...(pending?.elicitations ? { elicitations: pending.elicitations } : {}),
        ...(pending?.dialogs ? { dialogs: pending.dialogs } : {}),
        tail: true,
      })
      for (const chunk of tailPlan.backfill) {
        this.sink.send({
          kind: 'replay',
          sessionId,
          messages: chunk,
          permissions: [],
          backfill: true,
        })
      }
      this.sink.send({ kind: 'replay-done', sessionId })
    } else if (replayHistory.length <= REPLAY_CHUNK_SIZE) {
      this.sink.send({
        kind: 'replay',
        sessionId,
        messages: replayHistory,
        permissions: pending?.permissions ?? [],
        ...(pending?.elicitations ? { elicitations: pending.elicitations } : {}),
        ...(pending?.dialogs ? { dialogs: pending.dialogs } : {}),
      })
      this.sink.send({ kind: 'replay-done', sessionId })
    } else {
      for (let i = 0; i < replayHistory.length; i += REPLAY_CHUNK_SIZE) {
        this.sink.send({
          kind: 'replay',
          sessionId,
          messages: replayHistory.slice(i, i + REPLAY_CHUNK_SIZE),
          permissions: [],
        })
      }
      // Permissions arrive with the final replay-done frame. The
      // client merges them from whichever frame carries them.
      this.sink.send({
        kind: 'replay-done',
        sessionId,
        permissions: pending?.permissions ?? [],
        ...(pending?.elicitations ? { elicitations: pending.elicitations } : {}),
        ...(pending?.dialogs ? { dialogs: pending.dialogs } : {}),
      })
    }
    metrics.observe('replay_build_ms', performance.now() - replayStart)
    metrics.count('replay_messages', undefined, replayHistory.length)
  }

  private async startSession(
    sessionId: string,
    sinceUuid?: string,
    replayMode?: 'tail-backfill',
  ): Promise<void> {
    // A second subscribe on a connection that already holds this channel:
    // re-serve the replay rather than swallowing the frame. The replay is
    // per-connection and the caller's listener may have attached after the
    // first burst (panel remount, StrictMode's double mount, a resume whose
    // replay landed before <Chat> existed) — only the server can know, so
    // "I asked for the channel" must always produce one. No session
    // subscribers are wired here: the existing channel keeps streaming.
    if (this.subs.has(sessionId)) {
      // Wrapped because this branch runs before `starting.add` and outside
      // the try below: a throw here (a non-serializable ring entry reaching
      // JSON.stringify, say) would reject this un-awaited call instead of
      // being reported as a refusal, and nothing would answer the frame.
      try {
        const history = this.sm.getHistory(sessionId)
        if (history) {
          this.sendReplay(sessionId, history, sinceUuid, null, replayMode)
          this.ackSubscribe(sessionId, true, 'already-live')
        } else {
          // The connection still lists this session but the manager no
          // longer serves it — the window between a teardown ending the
          // queues and this driver's own cleanup. Say so: acking live here
          // would latch the client's channel state on a channel that is
          // about to send it nothing (`closed` follows from the teardown).
          this.ackSubscribe(sessionId, false, 'closed')
        }
      } catch (err) {
        log.error(`re-serve for ${sessionId} failed:`, err)
        this.ackSubscribe(sessionId, false, 'refused')
      }
      return
    }
    if (this.starting.has(sessionId)) {
      // An attempt is already in flight; it will answer with the real
      // outcome. Answering anything else here would be a guess.
      log.debug(`subscribe for ${sessionId} ignored — startSession already in flight`)
      this.ackSubscribe(sessionId, false, 'starting')
      return
    }
    this.starting.add(sessionId)
    let msgSub: { unsubscribe: () => void } | null = null
    let permSub: { unsubscribe: () => void } | null = null
    let elicitSub: { unsubscribe: () => void } | null = null
    let dialogSub: { unsubscribe: () => void } | null = null
    let ctxSub: { iterable: AsyncIterable<unknown>; snapshot?: unknown; unsubscribe: () => void } | null = null
    let ctxIter: AsyncIterator<unknown> | null = null
    let gitSub: { iterable: AsyncIterable<unknown>; unsubscribe: () => void } | null = null
    let gitIter: AsyncIterator<unknown> | null = null
    let msgStatSub: { iterable: AsyncIterable<unknown>; unsubscribe: () => void } | null = null
    let msgStatIter: AsyncIterator<unknown> | null = null
    let recapSub:
      | { iterable: AsyncIterable<unknown>; snapshot: unknown; unsubscribe: () => void }
      | null = null
    let recapIter: AsyncIterator<unknown> | null = null
    let clearedSub: { iterable: AsyncIterable<unknown>; unsubscribe: () => void } | null = null
    let clearedIter: AsyncIterator<unknown> | null = null
    let cmdSub: { iterable: AsyncIterable<unknown>; unsubscribe: () => void } | null = null
    let cmdIter: AsyncIterator<unknown> | null = null
    let hookSub: { iterable: AsyncIterable<unknown>; snapshot: unknown[]; unsubscribe: () => void } | null = null
    let hookIter: AsyncIterator<unknown> | null = null
    let psugSub: { iterable: AsyncIterable<unknown>; snapshot?: string | null; unsubscribe: () => void } | null = null
    let psugIter: AsyncIterator<unknown> | null = null
    let taskSub: { iterable: AsyncIterable<unknown>; snapshot: unknown; unsubscribe: () => void } | null = null
    let taskIter: AsyncIterator<unknown> | null = null
    let step = ''
    try {
      step = 'subscribe'
      // Ensure the session is loaded before wiring subscriptions. A WS
      // subscribe can legitimately land BEFORE a dormant session's resume
      // spawn completes: opening a dormant session mounts the Chat panel,
      // which subscribes immediately, while POST /resume is still in
      // flight. For a session absent from the in-memory map, sm.subscribe()
      // throws HttpError(404, "session X not found"); relaying that as an
      // `error` + empty `replay-done` left the client stuck — its hub only
      // re-subscribes on reconnect, so the resumed session's messages never
      // loaded (the reported white screen). Resume known-but-dormant
      // sessions first: sm.resume() is idempotent per session (concurrent
      // calls coalesce onto one promise) and a fast no-op while the session
      // is already live, so reconnect re-subscribes stay safe. Truly
      // unknown sessions (deleted, or never tracked) still throw 404 here
      // from sm.get() and fall through to the error path unchanged.
      const known = this.sm.get(sessionId)
      // A deliberately-slept session must not be woken behind the
      // user's back by a reconnecting subscriber — only an explicit
      // resume should wake it. It falls through to the error path
      // below, same as any other not-loaded session.
      //
      // A spawn_failed session is the same story, with higher stakes:
      // unloadSpawnFailed returns it to dormant, so without this guard
      // every subscribe (reconnect, panel remount, StrictMode) re-arms
      // resume() and the failed spawn loops — observed at 796 spawn
      // ENOENTs in one day. Only POST /resume may retry.
      const spawnFailed = known.terminatedReason === 'spawn_failed'
      if (spawnFailed && !known.running) {
        // Surface the recorded spawn error rather than the generic
        // "session not found" the subscribe path would produce for a
        // non-live session — the whole point of the guard is that this
        // session exists and its error is actionable.
        throw new Error(known.error || `session ${sessionId} failed to spawn`)
      }
      if (!known.running && !known.slept) {
        // Key diagnostic: this auto-resume runs BEFORE the replay is
        // built (the ring only exists after spawn seeds it). A slow
        // resume here delays replay-done, which widens the client-side
        // effect-rerun window that can discard an in-flight replay.
        const resumeStartedAt = Date.now()
        await this.sm.resume(sessionId)
        log.info(
          `subscribe auto-resumed dormant ${sessionId} in ${Date.now() - resumeStartedAt}ms`,
        )
      }
      // The socket may have closed while the spawn was in flight; don't
      // wire subscriptions onto a dead connection.
      if (this.closed) return
      const msg = this.sm.subscribe(sessionId)
      msgSub = msg
      step = 'subscribePermissions'
      const perms = this.sm.subscribePermissions(sessionId)
      permSub = perms
      step = 'subscribeElicitation'
      const elicits = this.sm.subscribeElicitation(sessionId)
      elicitSub = elicits
      step = 'subscribeDialog'
      const dialogs = this.sm.subscribeDialog(sessionId)
      dialogSub = dialogs
      step = 'subscribeContextUsage'
      ctxSub = this.sm.subscribeContextUsage(sessionId)
      ctxIter = ctxSub?.iterable[Symbol.asyncIterator]() ?? null
      step = 'subscribeGitStatus'
      gitSub = this.sm.subscribeGitStatus(sessionId)
      gitIter = gitSub?.iterable[Symbol.asyncIterator]() ?? null
      step = 'subscribeMessageStatus'
      msgStatSub = this.sm.subscribeMessageStatus(sessionId)
      msgStatIter = msgStatSub?.iterable[Symbol.asyncIterator]() ?? null
      step = 'subscribeSessionRecap'
      recapSub = this.sm.subscribeSessionRecap(sessionId)
      recapIter = recapSub?.iterable[Symbol.asyncIterator]() ?? null
      step = 'subscribeSessionCleared'
      clearedSub = this.sm.subscribeSessionCleared(sessionId)
      clearedIter = clearedSub?.iterable[Symbol.asyncIterator]() ?? null
      step = 'subscribeCommandChanges'
      cmdSub = this.sm.subscribeCommandChanges(sessionId)
      cmdIter = cmdSub?.iterable[Symbol.asyncIterator]() ?? null
      step = 'subscribeHookRuns'
      hookSub = this.sm.subscribeHookRuns(sessionId)
      hookIter = hookSub?.iterable[Symbol.asyncIterator]() ?? null
      step = 'subscribePromptSuggestion'
      psugSub = this.sm.subscribePromptSuggestion(sessionId)
      psugIter = psugSub?.iterable[Symbol.asyncIterator]() ?? null
      step = 'subscribeTasks'
      taskSub = this.sm.subscribeTasks(sessionId)
      taskIter = taskSub?.iterable[Symbol.asyncIterator]() ?? null

      // 1) Send replay. If the client supplied `sinceUuid`, try to
      //    send only messages after that point (incremental sync).
      //    Fall back to full replay if the UUID isn't in the ring
      //    (evicted by historyCap or client cache is stale).
      this.sendReplay(
        sessionId,
        msg.history,
        sinceUuid,
        {
          permissions: perms.snapshot,
          elicitations: elicits.snapshot,
          dialogs: dialogs.snapshot,
        },
        replayMode,
      )

      // 2.5) Send the current recap snapshot if there is one. The
      //      live iterable picks up future transitions; the snapshot
      //      covers the "tab opens after recap was generated" case
      //      so the user doesn't see an empty card.
      if (recapSub?.snapshot) {
        this.sink.send({
          kind: 'session-recap-update',
          sessionId,
          recap: recapSub.snapshot as never,
        })
      }

      // 2.6) Send the cached context-usage snapshot if there is one, so a
      //      tab that subscribes between turns (reconnect / new panel /
      //      refresh+resume) shows the Context bar immediately instead of
      //      waiting for the next `result` to land.
      if (ctxSub?.snapshot) {
        this.sink.send({ kind: 'context-usage', sessionId, usage: ctxSub.snapshot })
      }

      // 2.7) Send the cached prompt-suggestion snapshot if there is one.
      if (psugSub?.snapshot) {
        this.sink.send({ kind: 'prompt-suggestion', sessionId, suggestion: psugSub.snapshot })
      }

      // 2.8) Always send the task-list snapshot — even when empty — so a
      //      newly subscribed tab initializes its TasksPanel cleanly
      //      (stale rows from a previous session view are wiped).
      if (taskSub) {
        this.sink.send({ kind: 'tasks-snapshot', sessionId, tasks: taskSub.snapshot as TaskRecordUi[] })
      }

      for (const run of hookSub?.snapshot ?? []) {
        this.sink.send({ kind: 'hook-run', sessionId, event: hookSnapshotEvent(run as HookRunRecord) as never })
      }

      // 2) Drive the live iterables concurrently. Same Promise.race
      //    pattern as the SSE route — each iterator tagged so the loop
      //    knows which frame to emit.
      let stopped = false
      const _iterCleanup: AsyncIterator<unknown>[] = [ctxIter, gitIter, msgStatIter, recapIter, clearedIter, cmdIter, hookIter, psugIter, taskIter]
        .filter((it): it is AsyncIterator<unknown> => !!it)
      const stop = () => {
        if (stopped) return
        stopped = true
        for (const sub of [msgSub, permSub, elicitSub, dialogSub, ctxSub, gitSub, msgStatSub, recapSub, clearedSub, cmdSub, hookSub, psugSub, taskSub]) sub?.unsubscribe()
        for (const iter of _iterCleanup) void iter.return?.()
      }

      void (async () => {
        const msgIter = msg.iterable[Symbol.asyncIterator]()
        const permIter = perms.iterable[Symbol.asyncIterator]()
        const elicitIter = elicits.iterable[Symbol.asyncIterator]()
        const dialogIter = dialogs.iterable[Symbol.asyncIterator]()

        type Tagged =
          | { kind: 'msg'; result: IteratorResult<unknown> }
          | { kind: 'perm'; result: IteratorResult<unknown> }
          | { kind: 'elicit'; result: IteratorResult<unknown> }
          | { kind: 'dialog'; result: IteratorResult<unknown> }
          | { kind: 'ctx'; result: IteratorResult<unknown> }
          | { kind: 'git'; result: IteratorResult<unknown> }
          | { kind: 'msgstat'; result: IteratorResult<unknown> }
          | { kind: 'recap'; result: IteratorResult<unknown> }
          | { kind: 'cleared'; result: IteratorResult<unknown> }
          | { kind: 'cmd'; result: IteratorResult<unknown> }
          | { kind: 'hook'; result: IteratorResult<unknown> }
          | { kind: 'psug'; result: IteratorResult<unknown> }
          | { kind: 'task'; result: IteratorResult<unknown> }

        const tag = async (kind: Tagged['kind'], it: AsyncIterator<unknown>): Promise<Tagged> =>
          ({ kind, result: await it.next() })

        interface Channel {
          kind: Tagged['kind']
          iter: AsyncIterator<unknown>
          promise: Promise<Tagged> | null
        }

        const channels: Channel[] = [
          { kind: 'msg', iter: msgIter, promise: tag('msg', msgIter) },
          { kind: 'perm', iter: permIter, promise: tag('perm', permIter) },
          { kind: 'elicit', iter: elicitIter, promise: tag('elicit', elicitIter) },
          { kind: 'dialog', iter: dialogIter, promise: tag('dialog', dialogIter) },
          ...(ctxIter ? [{ kind: 'ctx' as const, iter: ctxIter, promise: tag('ctx', ctxIter) }] : []),
          ...(gitIter ? [{ kind: 'git' as const, iter: gitIter, promise: tag('git', gitIter) }] : []),
          ...(msgStatIter ? [{ kind: 'msgstat' as const, iter: msgStatIter, promise: tag('msgstat', msgStatIter) }] : []),
          ...(recapIter ? [{ kind: 'recap' as const, iter: recapIter, promise: tag('recap', recapIter) }] : []),
          ...(clearedIter ? [{ kind: 'cleared' as const, iter: clearedIter, promise: tag('cleared', clearedIter) }] : []),
          ...(cmdIter ? [{ kind: 'cmd' as const, iter: cmdIter, promise: tag('cmd', cmdIter) }] : []),
          ...(hookIter ? [{ kind: 'hook' as const, iter: hookIter, promise: tag('hook', hookIter) }] : []),
          ...(psugIter ? [{ kind: 'psug' as const, iter: psugIter, promise: tag('psug', psugIter) }] : []),
          ...(taskIter ? [{ kind: 'task' as const, iter: taskIter, promise: tag('task', taskIter) }] : []),
        ]

        try {
          while (!stopped && channels.some((c) => c.promise)) {
            const winner = await Promise.race(
              channels.filter((c): c is Channel & { promise: Promise<Tagged> } => c.promise != null)
                .map((c) => c.promise),
            )
            const ch = channels.find((c) => c.kind === winner.kind)!
            if (winner.result.done) {
              ch.promise = null
              // When the primary message channel ends (e.g. subscriber
              // queue overflow → end()), stop the entire session driver
              // so the write loop drains and closes — the client
              // detects the close and reconnects with a fresh replay.
              if (ch.kind === 'msg') stop()
              continue
            }
            // Dispatch per channel kind. Each branch maps the channel's value
            // to one or more frames; the retag happens once at the bottom.
            switch (winner.kind) {
              case 'msg':
                // The same message object reference is delivered to every
                // connection subscribed to this session, so serialize the
                // frame once and reuse across all of them (see
                // messageFrameJson). Falls back to send() if the value
                // isn't an object (defensive — it always is in practice).
                this.sink.sendRaw(
                  typeof winner.result.value === 'object' && winner.result.value !== null
                    ? messageFrameJson(sessionId, winner.result.value as object)
                    : JSON.stringify({ kind: 'message', sessionId, message: winner.result.value as never }),
                  'message',
                )
                break
              case 'perm': {
                const ev = winner.result.value as
                  | { kind: 'request'; payload: never }
                  | { kind: 'resolved'; pid: string; decision: never }
                if (ev.kind === 'request')
                  this.sink.send({ kind: 'permission-request', sessionId, payload: ev.payload })
                else
                  this.sink.send({ kind: 'permission-resolved', sessionId, id: ev.pid, decision: ev.decision })
                break
              }
              case 'elicit': {
                const ev = winner.result.value as
                  | { kind: 'request'; payload: never }
                  | { kind: 'resolved'; eid: string; decision: never }
                if (ev.kind === 'request')
                  this.sink.send({ kind: 'elicitation-request', sessionId, payload: ev.payload })
                else
                  this.sink.send({ kind: 'elicitation-resolved', sessionId, id: ev.eid, decision: ev.decision })
                break
              }
              case 'dialog': {
                const ev = winner.result.value as
                  | { kind: 'request'; payload: never }
                  | { kind: 'resolved'; did: string; decision: never; retractedMessageUuids?: string[] }
                if (ev.kind === 'request')
                  this.sink.send({ kind: 'dialog-request', sessionId, payload: ev.payload })
                else
                  this.sink.send({
                    kind: 'dialog-resolved',
                    sessionId,
                    id: ev.did,
                    decision: ev.decision,
                    ...(ev.retractedMessageUuids ? { retractedMessageUuids: ev.retractedMessageUuids } : {}),
                  })
                break
              }
              case 'ctx':
                this.sink.send({ kind: 'context-usage', sessionId, usage: winner.result.value })
                break
              case 'git':
                // The pushable carries the complete frame (broadcaster
                // constructed it with kind/cwd/repoRoot/payload); forward
                // verbatim. Seed frames for fresh subscribers ride the
                // same path.
                this.sink.send(winner.result.value as WsGitSnapshot)
                break
              case 'msgstat': {
                // Input-queue message status: either a consumed stamp
                // (queued → consumed flip) or a withdrawal batch (queued
                // messages removed by an interrupt with cancelQueued).
                // The channel is typed at the source (see
                // SessionManager.subscribeMessageStatus), so this is a
                // plain discriminated-union switch, not a defensive parse.
                const v = winner.result.value as WsMessageConsumed | WsMessagesWithdrawn
                if (v.kind === 'messages-withdrawn') {
                  this.sink.send({ kind: 'messages-withdrawn', sessionId, uuids: v.uuids })
                } else {
                  this.sink.send({ kind: 'message-consumed', sessionId, uuid: v.uuid, consumedAt: v.consumedAt })
                }
                break
              }
              case 'recap': {
                const v = winner.result.value as { recap?: unknown }
                this.sink.send({ kind: 'session-recap-update', sessionId, recap: v.recap as never })
                break
              }
              case 'cleared':
                this.sink.send({ kind: 'session-cleared', sessionId })
                break
              case 'cmd': {
                const v = winner.result.value as { commands: never[] }
                this.sink.send({ kind: 'commands-changed', sessionId, commands: Array.isArray(v.commands) ? v.commands : [] })
                break
              }
              case 'hook':
                this.sink.send({ kind: 'hook-run', sessionId, event: winner.result.value as never })
                break
              case 'psug':
                this.sink.send({ kind: 'prompt-suggestion', sessionId, suggestion: winner.result.value as string })
                break
              case 'task':
                this.sink.send({ kind: 'tasks-snapshot', sessionId, tasks: winner.result.value as TaskRecordUi[] })
                break
            }
            ch.promise = tag(ch.kind, ch.iter)
          }
        } catch (err) {
          if (!this.closed && !stopped) {
            this.sink.send({
              kind: 'error',
              sessionId,
              message: `subscription: ${(err as Error).message}`,
            })
          }
        } finally {
          stop()
          // Natural teardown (e.g. the session was unloaded / went
          // dormant, or the message channel ended from queue overflow):
          // the subscriber queues ended and this channel is done, but the
          // `subs` entry set below is still present. Leaving it means the
          // NEXT subscribe to this session is swallowed by the subs.has()
          // idempotency guard and never re-wires a fresh channel — so a
          // resume after dormancy keeps no live stream (and no replay) on
          // this connection. Delete the entry only if it is still OUR
          // cleanup (a newer subscribe that re-wired the channel replaced
          // it — that channel must survive).
          const entry = this.subs.get(sessionId)
          if (entry?.cleanup === stop) {
            this.subs.delete(sessionId)
            // Tell the client this connection's channel is gone: nothing
            // else on the per-connection wire says so (the global
            // session-update / session-removed frames are broadcast to
            // every tab and some teardowns send neither).
            //
            // A client-initiated `unsubscribe` never reaches here:
            // stopSession removes the entry before tearing the driver down,
            // so `entry` is undefined (a channel the client closed itself
            // needs no announcement).
            this.ackSubscribe(sessionId, false, 'closed')
          }
        }
      })()

      this.subs.set(sessionId, { sessionId, cleanup: stop })
      this.ackSubscribe(sessionId, true, 'served')
    } catch (err) {
      // SessionManager.require() throws HttpError for unknown sessions.
      // Relay that to the client rather than killing the connection;
      // the user might just have stale state after a session was
      // removed on another tab.
      log.error(`startSession(${sessionId}) failed at step "${step}":`, err)
      msgSub?.unsubscribe()
      permSub?.unsubscribe()
      elicitSub?.unsubscribe()
      dialogSub?.unsubscribe()
      ctxSub?.unsubscribe()
      gitSub?.unsubscribe()
      msgStatSub?.unsubscribe()
      recapSub?.unsubscribe()
      clearedSub?.unsubscribe()
      cmdSub?.unsubscribe()
      hookSub?.unsubscribe()
      psugSub?.unsubscribe()
      taskSub?.unsubscribe()
      this.sink.send({ kind: 'error', sessionId, message: (err as Error).message })
      // Always send replay-done so the client's replay state machine
      // terminates — without this, replayReady stays false forever and
      // the UI shows "Loading messages..." indefinitely.
      this.sink.send({ kind: 'replay-done', sessionId, permissions: [] })
      // …and the machine-readable half: nothing was established here, so
      // the client may ask again once the session is servable (`error`
      // above is prose, and is emitted for unrelated failures too).
      this.ackSubscribe(sessionId, false, 'refused')
    } finally {
      this.starting.delete(sessionId)
    }
  }

  private stopSession(sessionId: string): void {
    const s = this.subs.get(sessionId)
    if (!s) return
    // Drop the entry BEFORE tearing the driver down: the teardown's
    // `finally` acks `closed` only when the entry is still ours, so removing
    // it first is what tells the server not to answer a channel the client
    // is closing itself (it already knows).
    this.subs.delete(sessionId)
    s.cleanup()
  }
}
