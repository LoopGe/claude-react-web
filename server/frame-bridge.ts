// Transport-agnostic bridge between one client connection and the
// SessionManager's fan-out iterables.
//
// This is the body that used to live inside `wss.on('connection', ...)` in
// ws.ts, extracted so a second transport (an Electron MessagePort, a Unix
// socket, …) can drive the exact same behavior. It owns:
//   - the global session-list channel + global permission/notification mirror
//   - the app-plugin channel
//   - per-session subscribe/unsubscribe: ack + attached handshake, pending
//     request re-broadcast, live drivers, teardown
//   - client-frame validation (subscribe / unsubscribe / ping)
// and it writes through a {@link FrameSink}, which owns queueing/backpressure.
//
// The SessionManager already publishes everything through its
// `subscribeGlobal / subscribe / subscribePermissions / …` iterables; this
// module is a thin fan-out bridge and never calls a SessionManager mutator.
//
// Subscribe is transactional: we fetch the pending-request snapshots, then
// the live iterable — in that order, synchronously — so there's no gap during
// which a newly-produced event could be missed. Transcript history is NOT
// served here (the seq-window protocol pages it over REST).

import type { SessionBroadcaster } from './session-types.js'
import type { AppPluginBroadcaster } from './app-plugins/event-bus.js'
import type { SubagentTranscriptHub } from './subagent-transcript-hub.js'
import { createLogger } from './log.js'
import type {
  WsClientFrame,
  WsGitSnapshot,
  WsMessageConsumed,
  WsMessageSteered,
  WsMessagesEvicted,
  WsMessagesWithdrawn,
  WsServerFrame,
  WsSubscribeResultReason,
  WsSubagentTranscriptSubscribe,
  WsSubagentTranscriptUnsubscribe,
  WsTasklistSnapshot,
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
  /** Optional subagent on-disk transcript hub. When absent, a
   *  `subagent-transcript-subscribe` frame is answered with an `error`. */
  subagentTranscripts?: SubagentTranscriptHub
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

function messageFrameJson(
  sessionId: string,
  message: object,
  seq: number | undefined,
  generation: number | undefined,
): string {
  let json = messageFrameJsonCache.get(message)
  if (json === undefined) {
    // seq + generation ride INSIDE the cached string rather than on the
    // message object: stamping a property on the SDK message would leak it
    // into the ring entry, paged-history JSON and any equality/identity checks; a
    // NON-enumerable property would not work at all (JSON.stringify only
    // serializes enumerable own properties). Seq is append-stable and
    // assigned BEFORE the pump broadcasts (recordTranscriptFor runs ahead of
    // every subscriber push), so the first serialization already sees the
    // final value — caching it per message object is safe. The same holds
    // for `generation` only under an invariant: the generation can change
    // solely via TranscriptStore.reset() (the /clear path), which has no
    // live caller today — a future reset() caller that keeps the session
    // broadcasting MUST invalidate messageFrameJsonCache (or re-derive the
    // generation per serialization), or cached frames would carry a stale
    // generation and clients would misjudge the seq-space handshake.
    json = JSON.stringify(
      seq === undefined
        ? { kind: 'message', sessionId, message }
        : { kind: 'message', sessionId, seq, generation, message },
    )
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
  private readonly subagentTranscripts?: SubagentTranscriptHub

  private readonly subs = new Map<string, SessionSub>()
  /** Live subagent-transcript subscriptions keyed by `sessionId::agentId`. */
  private readonly subagentSubs = new Map<string, { unsubscribe: () => void }>()
  /** Sessions whose subscribe-setup is mid-flight (waiting on the
   *  auto-resume await below). Guard: a second subscribe frame for the
   *  same session must not race the first through the await — subs.has()
   *  is only set after it completes. */
  private readonly starting = new Set<string>()

  private globalCleanup: (() => void) | null = null
  private appPluginCleanup: (() => void) | null = null
  private clientDebugCleanup: (() => void) | null = null
  private closed = false

  constructor(deps: FrameBridgeDeps, sink: FrameSink) {
    this.sm = deps.sm
    this.appPlugins = deps.appPlugins
    this.subagentTranscripts = deps.subagentTranscripts
    this.sink = sink
  }

  /** Begin the always-on channels (global session list + app plugins +
   *  client-debug). Call once after the transport's inbound listeners are
   *  wired, so no client frame can race channel setup. */
  start(): void {
    this.startGlobal()
    this.startAppPlugins()
    this.startClientDebug()
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

  // --- client-debug channel (dev-only client-debug-request frames) ---
  // Subscribed unconditionally: only a dev-mode SessionManager ever
  // broadcasts here, and SessionBroadcaster guarantees the method. Frames
  // are forwarded verbatim — no per-session routing, no replay.
  private startClientDebug(): void {
    const sub = this.sm.subscribeClientDebug()
    this.clientDebugCleanup = () => sub.unsubscribe()
    void (async () => {
      try {
        for await (const frame of sub.iterable) {
          if (this.closed) return
          this.sink.send(frame)
        }
      } catch (err) {
        if (!this.closed) {
          this.sink.send({ kind: 'error', message: `client-debug channel: ${(err as Error).message}` })
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
          void this.startSession(frame.sessionId)
        }
        break
      case 'unsubscribe':
        if (typeof frame.sessionId === 'string' && frame.sessionId) this.stopSession(frame.sessionId)
        break
      case 'ping':
        this.sink.send({ kind: 'pong', nonce: frame.nonce })
        break
      case 'subagent-transcript-subscribe': {
        const f = frame as WsSubagentTranscriptSubscribe
        if (typeof f.sessionId !== 'string' || typeof f.agentId !== 'string' || !f.sessionId || !f.agentId) {
          this.sink.send({ kind: 'error', message: 'subagent-transcript-subscribe: sessionId/agentId required' })
          return
        }
        if (!this.subagentTranscripts) {
          this.sink.send({ kind: 'error', message: 'subagent transcript streaming unavailable' })
          return
        }
        const key = `${f.sessionId}::${f.agentId}`
        if (this.subagentSubs.has(key)) return // duplicate subscribe — snapshot already streaming
        const sub = this.subagentTranscripts.subscribeSubagentTranscript(f.sessionId, f.agentId)
        this.subagentSubs.set(key, sub)
        void (async () => {
          try {
            for await (const ev of sub.iterable) {
              if (this.closed) return
              this.sink.send({ kind: 'subagent-transcript', sessionId: ev.sessionId, agentId: ev.agentId, reset: ev.reset, frames: ev.frames })
            }
          } catch (err) {
            if (!this.closed) this.sink.send({ kind: 'error', message: `subagent-transcript channel: ${(err as Error).message}` })
          }
        })()
        return
      }
      case 'subagent-transcript-unsubscribe': {
        const f = frame as WsSubagentTranscriptUnsubscribe
        const key = `${f.sessionId}::${f.agentId}`
        const sub = this.subagentSubs.get(key)
        if (sub) {
          sub.unsubscribe()
          this.subagentSubs.delete(key)
        }
        return
      }
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
    for (const sub of this.subagentSubs.values()) sub.unsubscribe()
    this.subagentSubs.clear()
    this.globalCleanup?.()
    this.globalCleanup = null
    this.appPluginCleanup?.()
    this.appPluginCleanup = null
    this.clientDebugCleanup?.()
    this.clientDebugCleanup = null
  }

  // --- per-session channel (subscribe/unsubscribe) -----------------
  /** Answer one `subscribe` frame with the state of this connection's
   *  per-session channel. See WsSubscribeResult — the client keys its
   *  "do I need to ask again?" decision on this instead of inferring it
   *  from `subscribe-result` / `error` / the global session-update feed. */
  private ackSubscribe(
    sessionId: string,
    ok: boolean,
    reason: WsSubscribeResultReason,
  ): void {
    this.sink.send({ kind: 'subscribe-result', sessionId, ok, reason })
  }

  /** Seq-space handshake (transcript seq refactor, Task 5): right after a
   *  successful subscribe-result, hand the client the session's current seq
   *  cursor ({generation, headSeq}) so it can anchor seq-window paging and
   *  hole detection. Sent on BOTH success paths ('served' and
   *  'already-live') — a re-serve re-attaches the listener just as much.
   *  Absent when the session has no seq store yet (never ingested / never
   *  read); clients treat that as "uuid semantics only". Server-side the
   *  frame has no side effects — the client (P2) starts consuming it. */
  private sendAttached(sessionId: string): void {
    const head = this.sm.transcriptHead?.(sessionId)
    if (head) {
      this.sink.send({ kind: 'attached', sessionId, generation: head.generation, headSeq: head.headSeq })
    }
  }

  /** Re-broadcast the session's still-outstanding permission / elicitation /
   *  dialog requests to THIS connection as their ordinary request frames.
   *
   *  Formerly the replay burst carried these as payload snapshots; with
   *  replay retired (the seq-window protocol serves transcript history over
   *  REST) the pending-request re-broadcast is the one piece of subscribe-
   *  time state that must survive: a reconnecting tab whose panel stayed
   *  mounted has no other way to relearn a request that was broadcast before
   *  the connection dropped (the REST seeds in usePermissionChannel /
   *  useElicitationChannel / useUserDialogChannel run once per mount).
   *  Duplicate-tolerant by construction: the client-side merge keys on the
   *  request id, so a re-broadcast that races a REST seed folds into it.
   *  Shared by the establish path and the duplicate-subscribe path so the
   *  two can never drift; the re-serve path reads them FRESH from the
   *  brokers rather than reusing a cached snapshot — a stale one could
   *  resurrect an already resolved request. */
  private sendPendingRequests(
    sessionId: string,
    permissions: ReturnType<SessionBroadcaster['listPending']>,
    elicitations: ReturnType<SessionBroadcaster['listPendingElicitation']>,
    dialogs: ReturnType<SessionBroadcaster['listPendingDialogs']>,
  ): void {
    for (const req of permissions) {
      this.sink.send({ kind: 'permission-request', sessionId, payload: req })
    }
    for (const req of elicitations) {
      this.sink.send({ kind: 'elicitation-request', sessionId, payload: req })
    }
    for (const req of dialogs) {
      this.sink.send({ kind: 'dialog-request', sessionId, payload: req })
    }
  }

  private async startSession(sessionId: string): Promise<void> {
    // A second subscribe on a connection that already holds this channel:
    // re-attach the caller's listener rather than swallowing the frame. The
    // channel is per-connection and the caller's listener may have mounted
    // after the first subscribe (panel remount, StrictMode's double mount, a
    // resume whose ack landed before <Chat> existed) — only the server can
    // know, so "I asked for this channel" always gets the handshake + the
    // pending-request re-broadcast. No session subscribers are wired here:
    // the existing channel keeps streaming.
    if (this.subs.has(sessionId)) {
      // Wrapped because this branch runs before `starting.add` and outside
      // the try below: a throw here would reject this un-awaited call
      // instead of being reported as a refusal, and nothing would answer
      // the frame.
      try {
        if (this.sm.getHistory(sessionId)) {
          // Pending requests read FRESH, not from a cached snapshot — a
          // stale one could resurrect an already resolved request.
          this.sendPendingRequests(
            sessionId,
            this.sm.listPending(sessionId),
            this.sm.listPendingElicitation(sessionId),
            this.sm.listPendingDialogs(sessionId),
          )
          this.ackSubscribe(sessionId, true, 'already-live')
          this.sendAttached(sessionId)
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
    let tasklistSub: { iterable: AsyncIterable<unknown>; unsubscribe: () => void } | null = null
    let tasklistIter: AsyncIterator<unknown> | null = null
    let step = ''
    try {
      step = 'subscribe'
      // Ensure the session is loaded before wiring subscriptions. A WS
      // subscribe can legitimately land BEFORE a dormant session's resume
      // spawn completes: opening a dormant session mounts the Chat panel,
      // which subscribes immediately, while POST /resume is still in
      // flight. For a session absent from the in-memory map, sm.subscribe()
      // throws HttpError(404, "session X not found"); relaying that as an
      // `error` frame left the client stuck — its hub only
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
      // resume should wake it. But it must not be reported as "not
      // found" either: get() found it in the store, the user has it in
      // their sidebar, and the 404 from subscribe()→require() (live map
      // only) reads as "the session vanished". Same trap door as the
      // spawn_failed guard below: say what actually happened.
      if (known.slept && !known.running) {
        throw new Error(
          `session ${sessionId} is asleep — resume it to continue`,
        )
      }
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
        // Key diagnostic: this auto-resume runs BEFORE the subscribe ack.
        // A slow resume here delays the `attached` handshake, which widens
        // the client-side window before the transcript settles.
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
      step = 'subscribeTaskList'
      tasklistSub = this.sm.subscribeTaskList(sessionId)
      tasklistIter = tasklistSub?.iterable[Symbol.asyncIterator]() ?? null

      // 1) Re-broadcast still-outstanding permission / elicitation / dialog
      //    requests so a reconnecting tab relearns state that predates the
      //    connection (transcript history itself is NOT served here — the
      //    seq-window protocol pages it over REST).
      this.sendPendingRequests(sessionId, perms.snapshot, elicits.snapshot, dialogs.snapshot)

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
      //      waiting for the next `result` to land. With NO cached snapshot
      //      (fresh spawn under a slow-init backend, or a server restart
      //      that wiped the cache) ask for a zero-turn seed instead — this
      //      is the self-heal trigger; the manager dedups/guards it.
      if (ctxSub?.snapshot) {
        this.sink.send({ kind: 'context-usage', sessionId, usage: ctxSub.snapshot })
      } else {
        this.sm.ensureContextUsageSeed?.(sessionId)
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

      // 2) Drive the live iterables: one independent pull loop per channel,
      //    all writing into this connection's sink. A single race (the old
      //    driver) over every channel's pending next() re-attached a reaction to
      //    each idle channel's long-pending promise once per frame (an
      //    unbounded leak on a busy session); a loop that awaits its own
      //    pull attaches exactly one. Each loop emits synchronously after
      //    its own await, so per-channel order is preserved.
      let stopped = false
      const isStopped = () => stopped
      const _iterCleanup: AsyncIterator<unknown>[] = [ctxIter, gitIter, msgStatIter, recapIter, clearedIter, cmdIter, hookIter, psugIter, taskIter, tasklistIter]
        .filter((it): it is AsyncIterator<unknown> => !!it)
      const stop = () => {
        if (stopped) return
        stopped = true
        for (const sub of [msgSub, permSub, elicitSub, dialogSub, ctxSub, gitSub, msgStatSub, recapSub, clearedSub, cmdSub, hookSub, psugSub, taskSub, tasklistSub]) sub?.unsubscribe()
        for (const iter of _iterCleanup) void iter.return?.()
      }

      // Session-channel teardown. Runs once: when the MESSAGE loop ends
      // (done or throw) or when any loop throws.
      let finished = false
      const finish = () => {
        if (finished) return
        finished = true
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
      const onLoopError = (err: unknown) => {
        // The first failing loop reports; stop() below silences the rest.
        if (!this.closed && !stopped) {
          this.sink.send({
            kind: 'error',
            sessionId,
            message: `subscription: ${(err as Error).message}`,
          })
        }
        finish()
      }
      /** Launch one channel's loop. Only the message channel's end tears
       *  the session channel down (e.g. subscriber queue overflow → end():
       *  the client sees `closed` and re-subscribes for a fresh replay); a
       *  side channel ending alone just stops that loop. */
      const drive = <T>(iter: AsyncIterator<T> | null, emit: (v: T) => void, primary = false) => {
        if (!iter) return
        void this.driveChannel(iter, emit, isStopped).then(
          () => { if (primary) finish() },
          onLoopError,
        )
      }

      drive(msg.iterable[Symbol.asyncIterator](), (value: unknown) => {
        // The same message object reference is delivered to every
        // connection subscribed to this session, so serialize the
        // frame once and reuse across all of them (see
        // messageFrameJson). Falls back to send() if the value
        // isn't an object (defensive — it always is in practice).
        const msgObj = typeof value === 'object' && value !== null
          ? (value as object)
          : null
        const seq = msgObj ? this.sm.transcriptSeqOf?.(sessionId, msgObj) : undefined
        // Generation rides alongside seq (spec §4: live `message`
        // frames carry { seq, generation } — the client's WINDOW_LIVE
        // path requires BOTH non-null). Same source as the attached
        // handshake. Only stamped when a seq exists, matching the
        // wire contract (`generation` is omitted when `seq` is) and
        // the frame-cache invariant documented in messageFrameJson.
        const generation = seq !== undefined
          ? this.sm.transcriptHead?.(sessionId)?.generation
          : undefined
        this.sink.sendRaw(
          msgObj
            ? messageFrameJson(sessionId, msgObj, seq, generation)
            : JSON.stringify({ kind: 'message', sessionId, message: value as never }),
          'message',
        )
      }, true)
      drive(perms.iterable[Symbol.asyncIterator](), (value: unknown) => {
        const ev = value as
          | { kind: 'request'; payload: never }
          | { kind: 'resolved'; pid: string; decision: never }
        if (ev.kind === 'request')
          this.sink.send({ kind: 'permission-request', sessionId, payload: ev.payload })
        else
          this.sink.send({ kind: 'permission-resolved', sessionId, id: ev.pid, decision: ev.decision })
      })
      drive(elicits.iterable[Symbol.asyncIterator](), (value: unknown) => {
        const ev = value as
          | { kind: 'request'; payload: never }
          | { kind: 'resolved'; eid: string; decision: never }
        if (ev.kind === 'request')
          this.sink.send({ kind: 'elicitation-request', sessionId, payload: ev.payload })
        else
          this.sink.send({ kind: 'elicitation-resolved', sessionId, id: ev.eid, decision: ev.decision })
      })
      drive(dialogs.iterable[Symbol.asyncIterator](), (value: unknown) => {
        const ev = value as
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
      })
      drive(ctxIter, (value) => {
        this.sink.send({ kind: 'context-usage', sessionId, usage: value })
      })
      drive(gitIter, (value) => {
        // The pushable carries the complete frame (broadcaster
        // constructed it with kind/cwd/repoRoot/payload); forward
        // verbatim. Seed frames for fresh subscribers ride the
        // same path.
        this.sink.send(value as WsGitSnapshot)
      })
      drive(msgStatIter, (value) => {
        // Input-queue message status: a consumed stamp (queued → consumed
        // flip), a steering delivery transition (injected/requeued), a
        // withdrawal batch (queued messages removed by an interrupt with
        // cancelQueued) or an eviction batch (seq-window tombstones).
        // The channel is typed at the source (see
        // SessionManager.subscribeMessageStatus), so this is a
        // plain discriminated-union switch, not a defensive parse.
        const v = value as WsMessageConsumed | WsMessageSteered | WsMessagesWithdrawn | WsMessagesEvicted
        if (v.kind === 'messages-withdrawn') {
          this.sink.send({ kind: 'messages-withdrawn', sessionId, uuids: v.uuids })
        } else if (v.kind === 'messages-evicted') {
          this.sink.send({ kind: 'messages-evicted', sessionId, seqs: v.seqs, generation: v.generation })
        } else if (v.kind === 'message-steered') {
          this.sink.send({ kind: 'message-steered', sessionId, uuid: v.uuid, state: v.state })
        } else {
          this.sink.send({ kind: 'message-consumed', sessionId, uuid: v.uuid, consumedAt: v.consumedAt })
        }
      })
      drive(recapIter, (value) => {
        const v = value as { recap?: unknown }
        this.sink.send({ kind: 'session-recap-update', sessionId, recap: v.recap as never })
      })
      drive(clearedIter, () => {
        this.sink.send({ kind: 'session-cleared', sessionId })
      })
      drive(cmdIter, (value) => {
        const v = value as { commands: never[] }
        this.sink.send({ kind: 'commands-changed', sessionId, commands: Array.isArray(v.commands) ? v.commands : [] })
      })
      drive(hookIter, (value) => {
        this.sink.send({ kind: 'hook-run', sessionId, event: value as never })
      })
      drive(psugIter, (value) => {
        this.sink.send({ kind: 'prompt-suggestion', sessionId, suggestion: value as string })
      })
      drive(taskIter, (value) => {
        this.sink.send({ kind: 'tasks-snapshot', sessionId, tasks: value as TaskRecordUi[] })
      })
      drive(tasklistIter, (value) => {
        // Complete frame from the broadcaster (seed frames ride the
        // same path). Forward verbatim.
        this.sink.send(value as WsTasklistSnapshot)
      })

      this.subs.set(sessionId, { sessionId, cleanup: stop })
      this.ackSubscribe(sessionId, true, 'served')
      this.sendAttached(sessionId)
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
      tasklistSub?.unsubscribe()
      this.sink.send({ kind: 'error', sessionId, message: (err as Error).message })
      // …and the machine-readable half: nothing was established here, so
      // the client may ask again once the session is servable (`error`
      // above is prose, and is emitted for unrelated failures too).
      this.ackSubscribe(sessionId, false, 'refused')
    } finally {
      this.starting.delete(sessionId)
    }
  }

  /** Pull one channel until it ends or its session channel stops, handing
   *  each value to `emit`. Awaiting its own `next()` keeps exactly one
   *  reaction on the pending pull however long the channel stays idle.
   *  `isStopped` is re-checked after every await so a loop woken after
   *  teardown never emits. Rejects if `next()` or `emit` throws. */
  private async driveChannel<T>(
    iter: AsyncIterator<T>,
    emit: (v: T) => void,
    isStopped: () => boolean,
  ): Promise<void> {
    while (!isStopped()) {
      const r = await iter.next()
      if (r.done || isStopped()) return
      emit(r.value)
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
