// WebSocket multiplexer — ONE connection per client, fans out every
// session event (global list + per-session messages + permissions +
// context-usage) onto this single socket.
//
// The existing SSE routes in server/routes.ts are preserved as a
// fallback. This file is additive: it attaches a `ws`-backed
// WebSocketServer to the same Node http.Server that Hono runs on,
// handles /api/ws upgrades, and leaves all REST routes untouched.
//
// Design notes:
// - The SessionManager already publishes everything through its
//   subscribeGlobal / subscribe / subscribePermissions /
//   subscribeContextUsage iterables. This module is a thin fan-out
//   bridge; it never calls any SessionManager mutator.
// - Each subscribed session spawns a background driver task that
//   consumes the manager's iterables and writes onto the WS. Cleanup on
//   WS close tears every driver down via unsubscribe() so the
//   SessionManager doesn't leak subscribers.
// - History replay on subscribe is transactional: we fetch the
//   snapshot, then the live iterable — in that order, synchronously —
//   so there's no gap during which a newly-produced event could be
//   missed.

import type { IncomingMessage, Server as HttpServer } from 'node:http'
import type { Socket } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import { isUpgradeAuthorized } from './auth.js'
import type { SessionBroadcaster } from './session-types.js'
import type { AppPluginBroadcaster } from './app-plugins/event-bus.js'
import { shouldBroadcastMessage } from './history-utils.js'
import { createLogger } from './log.js'
import {
  WS_PATH,
  type WsClientFrame,
  type WsMessageConsumed,
  type WsMessagesWithdrawn,
  type WsServerFrame,
} from './ws-protocol.js'
import type { HookRunRecord, HookRuntimeEvent } from '../shared/hooks.js'
import type { TaskRecordUi } from '../shared/tasks.js'

const log = createLogger('ws')

function hookSnapshotEvent(run: HookRunRecord): HookRuntimeEvent {
  if (run.status === 'started') return { kind: 'started', run }
  if (run.status === 'progress') return { kind: 'progress', run }
  return { kind: 'completed', run }
}

/** Per-session subscription state held inside one WS connection. The
 *  driver promise lets us await its completion during teardown so we
 *  don't return from close() before every background task has settled. */
interface SessionSub {
  sessionId: string
  cleanup: () => void
}

/** Backpressure threshold: pause draining when the kernel socket buffer
 *  exceeds this many bytes. Prevents unbounded memory growth when the
 *  client is slow (e.g. rendering a large replay). */
const BACKPRESSURE_HIGH = 1_000_000

/** Hard cap on the total serialized chars buffered in a single
 *  WsWriteQueue. The backpressure mechanism (BACKPRESSURE_HIGH) suspends
 *  the drain loop when the kernel socket buffer is full, but while
 *  suspended the session drivers keep enqueuing — so a client that stays
 *  alive (TCP-wise) but never catches up could grow this buffer without
 *  bound. When the cap is exceeded we force-close the socket so the
 *  client reconnects and replays from the server's bounded history ring
 *  (mirrors the async-subscription overflow strategy). 8M chars is
 *  generous enough that it only trips on a pathologically slow client,
 *  not a transient slow spell. */
const MAX_QUEUE_CHARS = 8_000_000

/**
 * Async write queue with backpressure control for a single WebSocket.
 *
 * Replaces the old synchronous `send()` closure. All session drivers
 * call `enqueue()` which serializes the frame and appends it to an
 * in-memory buffer; a background drain loop sends frames one-by-one,
 * yielding via `setImmediate` between each so the event loop stays
 * responsive. When the kernel socket buffer exceeds
 * {@link BACKPRESSURE_HIGH} bytes, the drain loop suspends until the
 * `drain` event fires.
 *
 * This prevents a large replay frame from starving every other
 * session's live messages — the interleaving `setImmediate` gives
 * other drivers a chance to enqueue their (small) frames before the
 * next drain iteration.
 */
class WsWriteQueue {
  private queue: string[] = []
  private head = 0
  private draining = false
  private stopped = false
  private ws: WebSocket
  private totalChars = 0

  constructor(ws: WebSocket) {
    this.ws = ws
  }

  /** Enqueue a frame for async delivery. Drops silently if the socket
   *  has been stopped or is no longer OPEN — callers don't need to
   *  check readyState themselves. */
  enqueue(frame: WsServerFrame) {
    this.enqueueRaw(JSON.stringify(frame))
  }

  /** Enqueue an already-serialized frame string. Used by the broadcast
   *  path where one message is fanned out to many connections: the frame
   *  is stringified once (see `messageFrameJson`) and the same string is
   *  pushed into every subscribed connection's queue, avoiding M×
   *  JSON.stringify on the hot path. */
  enqueueRaw(data: string) {
    if (this.stopped || this.ws.readyState !== this.ws.OPEN) return
    this.queue.push(data)
    this.totalChars += data.length
    // Hard cap: a slow-but-alive client can keep this buffer growing
    // while the drain loop is suspended on backpressure. Force-close so
    // the client reconnects and replays from the bounded history ring.
    if (this.totalChars > MAX_QUEUE_CHARS) {
      log.warn(
        `WS write queue overflow (${this.totalChars} chars > ${MAX_QUEUE_CHARS}): ` +
        `force-closing socket to trigger reconnect + replay`,
      )
      this.stop()
      try { this.ws.close(1011, 'write queue overflow') } catch { /* socket may already be closing */ }
      return
    }
    if (!this.draining) void this.drain()
  }

  /** Signal that the socket is closing. Clears the queue and prevents
   *  any further drains from running. */
  stop() {
    this.stopped = true
    this.queue.length = 0
    this.head = 0
    this.totalChars = 0
  }

  private async drain() {
    this.draining = true
    let framesSinceYield = 0
    try {
      while (this.head < this.queue.length && !this.stopped) {
        const data = this.queue[this.head++]!
        // Backpressure: if the kernel socket buffer is full, send the
        // frame with a callback that fires when it has been flushed.
        // This is the idiomatic ws backpressure mechanism — the library
        // does NOT emit `drain` events, so we rely on the send callback.
        if (this.ws.bufferedAmount > BACKPRESSURE_HIGH) {
          await new Promise<void>((resolve) => {
            if (this.stopped) { resolve(); return }
            const onClose = () => { cleanup(); resolve() }
            const cleanup = () => { this.ws.off('close', onClose) }
            this.ws.on('close', onClose)
            this.ws.send(data, () => { cleanup(); resolve() })
          })
          // The await above already yielded to the event loop.
          framesSinceYield = 0
        } else {
          if (this.stopped) return
          this.ws.send(data)
        }
        // Yield to the event loop periodically (every 10 frames) so
        // other session drivers' synchronous enqueue() calls get a
        // chance to run. Batching reduces GC pressure from 1 Promise
        // per frame while still preserving cross-session fairness.
        if (++framesSinceYield >= 10) {
          framesSinceYield = 0
          await new Promise<void>((r) => setImmediate(r))
        }
      }
    } finally {
      // Compact the buffer: drop consumed entries so memory doesn't grow
      // unbounded when enqueue/drain cycles repeat.
      if (this.head > 0) {
        if (this.head >= this.queue.length) {
          // All entries consumed — release the backing store entirely
          // instead of splicing an empty tail (O(1) vs O(n)).
          this.queue.length = 0
        } else {
          this.queue.splice(0, this.head)
        }
        this.head = 0
      }
      // Recompute totalChars after compaction so the MAX_QUEUE_CHARS cap
      // reflects only buffered (unsent) data, not the running lifetime
      // total — otherwise a long-lived connection would trip the cap
      // even though its actual backlog is small.
      this.totalChars = 0
      for (let i = 0; i < this.queue.length; i++) this.totalChars += this.queue[i]!.length
      this.draining = false
    }
  }
}

/** Shared cache of serialized `message` frames, keyed by the SDK message
 *  object identity. The pump pushes the SAME message object reference into
 *  every subscriber's async-subscription queue (no per-subscriber clone),
 *  so every WS connection subscribed to a session receives an identical
 *  `{ kind: 'message', sessionId, message }` frame. Without this cache each
 *  connection's `enqueue()` would `JSON.stringify` that frame independently
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

/** Attach a WebSocket endpoint to an existing Node HTTP server. Returns
 *  a `shutdown()` function that closes every live socket — callers pass
 *  this into their SIGTERM handler so the process exits cleanly.
 *
 *  Intentionally NOT a Hono middleware — we need access to the raw
 *  Node server's `upgrade` event, which Hono doesn't expose. Mounting
 *  directly is simpler and avoids a two-layer handshake. */
export function attachWebSocket(
  httpServer: HttpServer,
  sm: SessionBroadcaster,
  appPlugins?: AppPluginBroadcaster,
): () => Promise<void> {
  // `noServer: true` means the WSS doesn't listen on its own port; it
  // only handles connections handed to it via `handleUpgrade()`. That's
  // how we share a port with Hono.
  const wss = new WebSocketServer({ noServer: true, path: WS_PATH })

  // All live sockets, so shutdown() can close them. A Set is enough —
  // per-connection state lives in closures below.
  const sockets = new Set<WebSocket>()

  httpServer.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    // Only hijack upgrades on our path; others (e.g. Vite HMR on a
    // different prefix, if reverse-proxied) can continue.
    const url = req.url ?? ''
    if (!url.startsWith(WS_PATH)) return
    // Web access gate: reject the upgrade before the handshake when the
    // request lacks a valid token. The browser WS carries the crw_token
    // cookie automatically (same-origin), so an authenticated page just
    // works; a direct connection without the token is refused.
    if (!isUpgradeAuthorized(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  })

  wss.on('connection', (ws) => {
    sockets.add(ws)
    const subs = new Map<string, SessionSub>()
    /** Sessions whose subscribe-setup is mid-flight (waiting on the
     *  auto-resume await below). Guard: a second subscribe frame for the
     *  same session must not race the first through the await — subs.has()
     *  is only set after it completes. */
    const starting = new Set<string>()
    let globalCleanup: (() => void) | null = null
    let appPluginCleanup: (() => void) | null = null
    let closed = false

    const queue = new WsWriteQueue(ws)

    // --- global channel: sessions list + global permission mirror ----
    // Started immediately on connection so the client receives the
    // initial snapshot without needing to subscribe to anything first.
    const startGlobal = () => {
      const global = sm.subscribeGlobal()
      globalCleanup = () => global.unsubscribe()
      queue.enqueue({ kind: 'sessions-snapshot', sessions: global.snapshot })
      void (async () => {
        try {
          for await (const ev of global.iterable) {
            if (closed) return
            if (ev.kind === 'update') queue.enqueue({ kind: 'session-update', session: ev.session })
            else if (ev.kind === 'created') queue.enqueue({ kind: 'session-created', session: ev.session, joinGroupOf: ev.joinGroupOf, evictingSource: ev.evictingSource, replacesSource: ev.replacesSource })
            else if (ev.kind === 'removed') queue.enqueue({ kind: 'session-removed', id: ev.id })
            else if (ev.kind === 'permission_request') {
              queue.enqueue({
                kind: 'global-permission-request',
                sessionId: ev.sessionId,
                request: ev.request,
              })
            } else if (ev.kind === 'cli_notification') {
              queue.enqueue({
                kind: 'cli-notification',
                sessionId: ev.sessionId,
                notification: ev.notification,
              })
            }
          }
        } catch (err) {
          if (!closed) {
            queue.enqueue({ kind: 'error', message: `global channel: ${(err as Error).message}` })
          }
        }
      })()
    }

    // --- app-plugin channel (snapshot + state/contributions updates) ---
    // Only started when an AppPluginManager was wired in. Mirrors the global
    // channel: subscribe once per connection, fan every event into a frame.
    const startAppPlugins = () => {
      if (!appPlugins) return
      const sub = appPlugins.subscribeAppPlugins()
      appPluginCleanup = () => sub.unsubscribe()
      void (async () => {
        try {
          for await (const ev of sub.iterable) {
            if (closed) return
            if (ev.kind === 'snapshot') queue.enqueue({ kind: 'app-plugins-snapshot', plugins: ev.plugins })
            else if (ev.kind === 'state-changed') queue.enqueue({ kind: 'app-plugin-state-changed', plugin: ev.plugin })
            else if (ev.kind === 'contributions-changed') {
              queue.enqueue({
                kind: 'app-plugin-contributions-changed',
                pluginId: ev.pluginId,
                contributions: ev.contributions,
              })
            }
            else if (ev.kind === 'plugin-event') {
              queue.enqueue({ kind: 'app-plugin-event', pluginId: ev.pluginId, widgetId: ev.widgetId, payload: ev.payload })
            }
          }
        } catch (err) {
          if (!closed) {
            queue.enqueue({ kind: 'error', message: `app-plugins channel: ${(err as Error).message}` })
          }
        }
      })()
    }

    // --- per-session channel (subscribe/unsubscribe) -----------------
    const startSession = async (sessionId: string, sinceUuid?: string) => {
      // Idempotent: re-subscribing is a no-op. The client can safely
      // emit duplicate subscribe frames (e.g. after a tab refresh sees a
      // panel already open).
      if (subs.has(sessionId)) return
      if (starting.has(sessionId)) return
      starting.add(sessionId)
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
        const known = sm.get(sessionId)
        // A deliberately-slept session must not be woken behind the
        // user's back by a reconnecting subscriber — only an explicit
        // resume should wake it. It falls through to the error path
        // below, same as any other not-loaded session.
        if (!known.running && !known.slept) await sm.resume(sessionId)
        // The socket may have closed while the spawn was in flight; don't
        // wire subscriptions onto a dead connection.
        if (closed) return
        const msg = sm.subscribe(sessionId)
        msgSub = msg
        step = 'subscribePermissions'
        const perms = sm.subscribePermissions(sessionId)
        permSub = perms
        step = 'subscribeElicitation'
        const elicits = sm.subscribeElicitation(sessionId)
        elicitSub = elicits
        step = 'subscribeDialog'
        const dialogs = sm.subscribeDialog(sessionId)
        dialogSub = dialogs
        step = 'subscribeContextUsage'
        ctxSub = sm.subscribeContextUsage(sessionId)
        ctxIter = ctxSub?.iterable[Symbol.asyncIterator]() ?? null
        step = 'subscribeGitStatus'
        gitSub = sm.subscribeGitStatus(sessionId)
        gitIter = gitSub?.iterable[Symbol.asyncIterator]() ?? null
        step = 'subscribeMessageStatus'
        msgStatSub = sm.subscribeMessageStatus(sessionId)
        msgStatIter = msgStatSub?.iterable[Symbol.asyncIterator]() ?? null
        step = 'subscribeSessionRecap'
        recapSub = sm.subscribeSessionRecap(sessionId)
        recapIter = recapSub?.iterable[Symbol.asyncIterator]() ?? null
        step = 'subscribeSessionCleared'
        clearedSub = sm.subscribeSessionCleared(sessionId)
        clearedIter = clearedSub?.iterable[Symbol.asyncIterator]() ?? null
        step = 'subscribeCommandChanges'
        cmdSub = sm.subscribeCommandChanges(sessionId)
        cmdIter = cmdSub?.iterable[Symbol.asyncIterator]() ?? null
        step = 'subscribeHookRuns'
        hookSub = sm.subscribeHookRuns(sessionId)
        hookIter = hookSub?.iterable[Symbol.asyncIterator]() ?? null
        step = 'subscribePromptSuggestion'
        psugSub = sm.subscribePromptSuggestion(sessionId)
        psugIter = psugSub?.iterable[Symbol.asyncIterator]() ?? null
        step = 'subscribeTasks'
        taskSub = sm.subscribeTasks(sessionId)
        taskIter = taskSub?.iterable[Symbol.asyncIterator]() ?? null

        // 1) Send replay. If the client supplied `sinceUuid`, try to
        //    send only messages after that point (incremental sync).
        //    Fall back to full replay if the UUID isn't in the ring
        //    (evicted by historyCap or client cache is stale).
        let replayHistory = msg.history
        if (sinceUuid) {
          const idx = msg.history.findIndex(
            (m) => (m as { uuid?: string }).uuid === sinceUuid,
          )
          if (idx >= 0) {
            replayHistory = msg.history.slice(idx + 1)
            log.info(
              `[ws] incremental sync for ${sessionId}: ` +
              `skipped ${idx + 1} msgs, sending ${replayHistory.length} new`,
            )
          } else {
            log.info(
              `[ws] sinceUuid ${sinceUuid} not found in ${sessionId} history ` +
              `(${msg.history.length} msgs) — full replay`,
            )
          }
        }

        // Filter out system messages that the frontend doesn't need.
        // Matches the live broadcast filter in session-pump.ts.
        replayHistory = replayHistory.filter(
          (m) => shouldBroadcastMessage(m as { type?: string; subtype?: string }),
        )
        const REPLAY_CHUNK_SIZE = 50
        if (replayHistory.length <= REPLAY_CHUNK_SIZE) {
          queue.enqueue({
            kind: 'replay',
            sessionId,
            messages: replayHistory,
            permissions: perms.snapshot,
            elicitations: elicits.snapshot,
            dialogs: dialogs.snapshot,
          })
          queue.enqueue({ kind: 'replay-done', sessionId })
        } else {
          for (let i = 0; i < replayHistory.length; i += REPLAY_CHUNK_SIZE) {
            queue.enqueue({
              kind: 'replay',
              sessionId,
              messages: replayHistory.slice(i, i + REPLAY_CHUNK_SIZE),
              permissions: [],
            })
          }
          // Permissions arrive with the final replay-done frame. The
          // client merges them from whichever frame carries them.
          queue.enqueue({
            kind: 'replay-done',
            sessionId,
            permissions: perms.snapshot,
            elicitations: elicits.snapshot,
            dialogs: dialogs.snapshot,
          })
        }

        // 2.5) Send the current recap snapshot if there is one. The
        //      live iterable picks up future transitions; the snapshot
        //      covers the "tab opens after recap was generated" case
        //      so the user doesn't see an empty card.
        if (recapSub?.snapshot) {
          queue.enqueue({
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
          queue.enqueue({ kind: 'context-usage', sessionId, usage: ctxSub.snapshot })
        }

        // 2.7) Send the cached prompt-suggestion snapshot if there is one.
        if (psugSub?.snapshot) {
          queue.enqueue({ kind: 'prompt-suggestion', sessionId, suggestion: psugSub.snapshot })
        }

        // 2.8) Always send the task-list snapshot — even when empty — so a
        //      newly subscribed tab initializes its TasksPanel cleanly
        //      (stale rows from a previous session view are wiped).
        if (taskSub) {
          queue.enqueue({ kind: 'tasks-snapshot', sessionId, tasks: taskSub.snapshot as TaskRecordUi[] })
        }

        for (const run of hookSub?.snapshot ?? []) {
          queue.enqueue({ kind: 'hook-run', sessionId, event: hookSnapshotEvent(run as HookRunRecord) as never })
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
                // so the WS write loop drains and closes — the client
                // detects the close and reconnects with a fresh replay.
                if (ch.kind === 'msg') stop()
                continue
              }
              // Dispatch per channel kind. Each branch maps the channel's value
              // to one or more WS frames; the retag happens once at the bottom.
              switch (winner.kind) {
                case 'msg':
                  // The same message object reference is delivered to every
                  // connection subscribed to this session, so serialize the
                  // frame once and reuse across all of them (see
                  // messageFrameJson). Falls back to enqueue() if the value
                  // isn't an object (defensive — it always is in practice).
                  queue.enqueueRaw(
                    typeof winner.result.value === 'object' && winner.result.value !== null
                      ? messageFrameJson(sessionId, winner.result.value as object)
                      : JSON.stringify({ kind: 'message', sessionId, message: winner.result.value as never }),
                  )
                  break
                case 'perm': {
                  const ev = winner.result.value as
                    | { kind: 'request'; payload: never }
                    | { kind: 'resolved'; pid: string; decision: never }
                  if (ev.kind === 'request')
                    queue.enqueue({ kind: 'permission-request', sessionId, payload: ev.payload })
                  else
                    queue.enqueue({ kind: 'permission-resolved', sessionId, id: ev.pid, decision: ev.decision })
                  break
                }
                case 'elicit': {
                  const ev = winner.result.value as
                    | { kind: 'request'; payload: never }
                    | { kind: 'resolved'; eid: string; decision: never }
                  if (ev.kind === 'request')
                    queue.enqueue({ kind: 'elicitation-request', sessionId, payload: ev.payload })
                  else
                    queue.enqueue({ kind: 'elicitation-resolved', sessionId, id: ev.eid, decision: ev.decision })
                  break
                }
                case 'dialog': {
                  const ev = winner.result.value as
                    | { kind: 'request'; payload: never }
                    | { kind: 'resolved'; did: string; decision: never; retractedMessageUuids?: string[] }
                  if (ev.kind === 'request')
                    queue.enqueue({ kind: 'dialog-request', sessionId, payload: ev.payload })
                  else
                    queue.enqueue({
                      kind: 'dialog-resolved',
                      sessionId,
                      id: ev.did,
                      decision: ev.decision,
                      ...(ev.retractedMessageUuids ? { retractedMessageUuids: ev.retractedMessageUuids } : {}),
                    })
                  break
                }
                case 'ctx':
                  queue.enqueue({ kind: 'context-usage', sessionId, usage: winner.result.value })
                  break
                case 'git':
                  queue.enqueue({ kind: 'git-status-changed', sessionId })
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
                    queue.enqueue({ kind: 'messages-withdrawn', sessionId, uuids: v.uuids })
                  } else {
                    queue.enqueue({ kind: 'message-consumed', sessionId, uuid: v.uuid, consumedAt: v.consumedAt })
                  }
                  break
                }
                case 'recap': {
                  const v = winner.result.value as { recap?: unknown }
                  queue.enqueue({ kind: 'session-recap-update', sessionId, recap: v.recap as never })
                  break
                }
                case 'cleared':
                  queue.enqueue({ kind: 'session-cleared', sessionId })
                  break
                case 'cmd': {
                  const v = winner.result.value as { commands: never[] }
                  queue.enqueue({ kind: 'commands-changed', sessionId, commands: Array.isArray(v.commands) ? v.commands : [] })
                  break
                }
                case 'hook':
                  queue.enqueue({ kind: 'hook-run', sessionId, event: winner.result.value as never })
                  break
                case 'psug':
                  queue.enqueue({ kind: 'prompt-suggestion', sessionId, suggestion: winner.result.value as string })
                  break
                case 'task':
                  queue.enqueue({ kind: 'tasks-snapshot', sessionId, tasks: winner.result.value as TaskRecordUi[] })
                  break
              }
              ch.promise = tag(ch.kind, ch.iter)
            }
          } catch (err) {
            if (!closed && !stopped) {
              queue.enqueue({
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
            if (subs.get(sessionId)?.cleanup === stop) subs.delete(sessionId)
          }
        })()

        subs.set(sessionId, { sessionId, cleanup: stop })
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
        queue.enqueue({ kind: 'error', sessionId, message: (err as Error).message })
        // Always send replay-done so the client's replay state machine
        // terminates — without this, replayReady stays false forever and
        // the UI shows "Loading messages..." indefinitely.
        queue.enqueue({ kind: 'replay-done', sessionId, permissions: [] })
      } finally {
        starting.delete(sessionId)
      }
    }

    const stopSession = (sessionId: string) => {
      const s = subs.get(sessionId)
      if (!s) return
      s.cleanup()
      subs.delete(sessionId)
    }

    ws.on('message', (raw) => {
      let frame: WsClientFrame
      try {
        frame = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf-8')) as WsClientFrame
      } catch {
        queue.enqueue({ kind: 'error', message: 'invalid JSON frame' })
        return
      }
      if (!frame || typeof frame !== 'object' || typeof frame.kind !== 'string') {
        queue.enqueue({ kind: 'error', message: 'frame missing kind' })
        return
      }
      switch (frame.kind) {
        case 'subscribe':
          if (typeof frame.sessionId === 'string' && frame.sessionId) startSession(frame.sessionId, frame.sinceUuid)
          break
        case 'unsubscribe':
          if (typeof frame.sessionId === 'string' && frame.sessionId) stopSession(frame.sessionId)
          break
        case 'ping':
          queue.enqueue({ kind: 'pong', nonce: frame.nonce })
          break
        default:
          // Exhaustiveness check — a new client-side kind we don't know.
          queue.enqueue({ kind: 'error', message: `unknown kind: ${(frame as { kind: string }).kind}` })
      }
    })

    ws.on('close', () => {
      closed = true
      queue.stop()
      for (const s of subs.values()) s.cleanup()
      subs.clear()
      globalCleanup?.()
      globalCleanup = null
      appPluginCleanup?.()
      appPluginCleanup = null
      sockets.delete(ws)
    })

    ws.on('error', (err) => {
      // Stock ws surfaces parser errors etc. here. Force-close so the
      // close handler fires and runs full cleanup (queue drain, session
      // unsubscribe, global listener detach). Without this, an error on
      // a half-open socket can leave sessions dangling until the next
      // GC cycle.
      log.error('socket error:', err.message)
      try { ws.close() } catch { /* already closing */ }
    })

    // Kick the global channel last so all listeners are wired before any
    // frame might arrive. The app-plugin channel follows the same rule.
    startGlobal()
    startAppPlugins()
  })

  const shutdown = async () => {
    // Send close frames to all connected clients. Some may never
    // acknowledge (e.g. backgrounded tabs), so we also set a hard
    // timeout to forcibly terminate stragglers.
    for (const ws of sockets) {
      try {
        ws.close(1001, 'server shutting down')
      } catch {
        /* ignore */
      }
    }
    const FORCE_CLOSE_MS = 2000
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        for (const ws of sockets) {
          try { ws.terminate() } catch { /* ignore */ }
        }
      }, FORCE_CLOSE_MS)
      wss.close(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
  return shutdown
}
