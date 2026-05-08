// Multi-session pool for @anthropic-ai/claude-agent-sdk Query instances.
//
// Each session holds:
//   - A pushable input iterable (queue of SDKUserMessage) — writers push turns,
//     the SDK reads them.
//   - The Query async generator returned by `query({ prompt, options })` — we
//     pump it in a background task and fan every message out to subscribers.
//   - Subscribers (Set<Subscriber>) — each SSE client has its own subscriber
//     queue so a slow client can't block the SDK pump.
//   - A small ring buffer of recent messages so a freshly-connected subscriber
//     can see the state of the world without missing live events.
//
// Control methods (interrupt / setModel / setPermissionMode / applyFlagSettings)
// are delegated straight to the underlying Query, which implements them as
// in-band control requests to the CLI subprocess.
//
// Idle GC runs every minute; any session whose last activity is older than
// `idleMs` AND has no live subscribers gets deleted.

import {
  query,
  type CanUseTool,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type Settings,
} from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import { createPushable, type Pushable } from './pushable.js'
import type { SessionMeta, SessionStore } from './persistence.js'

/** SSE subscriber — each EventSource client gets one of these. */
interface Subscriber {
  id: string
  push: (msg: SDKMessage) => void
  end: () => void
  closed: boolean
}

/** Permission-channel subscriber — separate from the SDK message channel so
 *  we don't have to widen the Subscriber type into a union. */
export type PermissionEvent =
  | { kind: 'request'; payload: PermissionRequestSnapshot }
  | { kind: 'resolved'; pid: string; decision: PermissionDecisionSummary }
interface PermissionSubscriber {
  id: string
  push: (ev: PermissionEvent) => void
  end: () => void
}

/** JSON-safe snapshot of a pending permission request. */
export interface PermissionRequestSnapshot {
  id: string
  toolName: string
  input: Record<string, unknown>
  title?: string
  displayName?: string
  description?: string
  suggestions?: PermissionUpdate[]
  toolUseID: string
  createdAt: number
}

/** Summary of how a pending request was resolved (broadcast to all tabs). */
export interface PermissionDecisionSummary {
  behavior: 'allow' | 'deny'
  persisted: boolean
  message?: string
}

/** Internal server-side state per pending request. */
interface PendingPermission extends PermissionRequestSnapshot {
  resolve: (r: PermissionResult) => void
  signal: AbortSignal
  abortHandler: () => void
}

/** Metadata returned by list() / get(). */
export interface SessionInfo {
  id: string
  createdAt: number
  lastActivityAt: number
  subscribers: number
  messageCount: number
  cwd?: string
  model?: string
  permissionMode?: PermissionMode
  title?: string
  running: boolean
  terminated: boolean
  error?: string
  /** True when the SDK is mid-turn (a user message has been sent and no
   *  matching `result` has arrived yet). Drives the "thinking" animation. */
  working: boolean
  /** Epoch ms of the last completed turn (last `result` message). The
   *  frontend diffs this against a locally-remembered value to decide
   *  whether to show an unread badge on non-focused sessions. */
  lastTurnAt?: number
}

interface Session {
  id: string
  createdAt: number
  lastActivityAt: number
  cwd?: string
  model?: string
  permissionMode?: PermissionMode
  title?: string
  input: Pushable<SDKUserMessage>
  query: Query
  subscribers: Map<string, Subscriber>
  permissionSubscribers: Map<string, PermissionSubscriber>
  /** Pending tool-use permission requests awaiting a user decision. */
  pending: Map<string, PendingPermission>
  history: SDKMessage[]
  pumpTask: Promise<void>
  running: boolean
  terminated: boolean
  error?: string
  /** Pending turns (user messages sent but no matching `result` yet). A
   *  simple counter rather than a set because we don't need to identify
   *  which specific turn is outstanding — just whether ANY is. */
  pendingTurns: number
  /** Timestamp of the last `result` message, used for the unread badge. */
  lastTurnAt?: number
}

const HISTORY_CAP = 500
const DEFAULT_IDLE_MS = 30 * 60 * 1000 // 30 min

export interface SessionManagerOptions {
  idleMs?: number
  historyCap?: number
  /** When set, session metadata is persisted here so dormant sessions
   *  survive restarts. See server/persistence.ts. */
  store?: SessionStore
}

export class SessionManager {
  private sessions = new Map<string, Session>()
  private idleMs: number
  private historyCap: number
  private gcTimer?: NodeJS.Timeout
  private store?: SessionStore

  constructor(opts: SessionManagerOptions = {}) {
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS
    this.historyCap = opts.historyCap ?? HISTORY_CAP
    this.store = opts.store
    this.gcTimer = setInterval(() => this.gc(), 60_000)
    // Don't keep the Node process alive just for GC
    this.gcTimer.unref?.()
  }

  /** Write the current in-memory state of a session into the persistence
   *  store. No-op when no store is configured. Debounced on the store side
   *  so calling this on every tiny state change is fine. */
  private persist(s: Session): void {
    if (!this.store) return
    this.store.upsert({
      id: s.id,
      createdAt: s.createdAt,
      lastActivityAt: s.lastActivityAt,
      cwd: s.cwd,
      model: s.model,
      permissionMode: s.permissionMode,
      title: s.title,
      messageCount: s.history.length,
      terminated: s.terminated,
      error: s.error,
      lastTurnAt: s.lastTurnAt,
    })
  }

  /** Options we store and expose on SessionInfo (subset of full SDK Options). */
  private snapshotMeta(opts: Options): { cwd?: string; model?: string; permissionMode?: PermissionMode; title?: string } {
    return {
      cwd: opts.cwd,
      model: opts.model,
      permissionMode: opts.permissionMode,
      title: opts.title,
    }
  }

  /** Create a brand-new session and start pumping.
   *
   *  For resume, use `resume()` instead — this path always allocates a
   *  fresh UUID and won't wire up SDK `resume`. */
  create(opts: Options): SessionInfo {
    return this.spawn(randomUUID(), opts)
  }

  /** Resume a previously-persisted session. The SDK loads conversation
   *  history from its own on-disk log (~/.claude/projects/...) using the
   *  session id. Returns the info for the freshly-spawned Query.
   *
   *  Behaviour:
   *  - If the session is already live in memory, returns its current info
   *    (idempotent — reconnecting from two tabs doesn't spawn twice).
   *  - If the session is in the persistence index and not terminated,
   *    spawns a new Query with `options.resume = id` and reuses the id.
   *  - Refuses to resume terminated sessions; the SDK can't continue past
   *    a `result` message anyway.
   */
  resume(id: string): SessionInfo {
    const live = this.sessions.get(id)
    if (live) return this.info(live)
    if (!this.store) {
      throw new HttpError(404, `session ${id} not found (no persistence configured)`)
    }
    const meta = this.store.get(id)
    if (!meta) throw new HttpError(404, `session ${id} not found`)
    if (meta.terminated) {
      throw new HttpError(410, `session ${id} has ended and cannot be resumed`)
    }
    const resumeOpts: Options = {
      resume: id,
      cwd: meta.cwd,
      model: meta.model,
      permissionMode: meta.permissionMode,
      title: meta.title,
    }
    return this.spawn(id, resumeOpts)
  }

  /** Shared spawn path for create() and resume(). */
  private spawn(id: string, opts: Options): SessionInfo {
    const input = createPushable<SDKUserMessage>()
    const fullOpts: Options = { ...opts }
    // includePartialMessages=true so clients can render streaming deltas; callers
    // can still override to false if they prefer batched messages only.
    if (fullOpts.includePartialMessages === undefined) {
      fullOpts.includePartialMessages = true
    }

    // The session struct needs to exist before canUseTool fires (the SDK can
    // request permission mid-turn), so we declare it here and wire up the
    // callback against the closure. prefer-const is a false positive —
    // the assignment happens below, after the canUseTool closure captures
    // the binding.
    // eslint-disable-next-line prefer-const
    let session: Session
    const canUseTool: CanUseTool = async (toolName, toolInput, ctx) => {
      // bypassPermissions shouldn't ever land here (we don't register the
      // callback in that mode), but guard anyway — the SDK could still invoke
      // it in some edge cases.
      return new Promise<PermissionResult>((resolve) => {
        const pid = randomUUID()
        const abortHandler = () => {
          if (!session.pending.has(pid)) return
          session.pending.delete(pid)
          // Aborted means the enclosing turn was interrupted — return a deny
          // that does NOT cascade (interrupt: false), SDK will unwind anyway.
          resolve({ behavior: 'deny', message: 'aborted', interrupt: false })
          this.broadcastPermissionResolved(session, pid, {
            behavior: 'deny',
            persisted: false,
            message: 'aborted',
          })
        }
        const pending: PendingPermission = {
          id: pid,
          toolName,
          input: toolInput,
          title: ctx.title,
          displayName: ctx.displayName,
          description: ctx.description,
          suggestions: ctx.suggestions,
          toolUseID: ctx.toolUseID,
          createdAt: Date.now(),
          resolve,
          signal: ctx.signal,
          abortHandler,
        }
        session.pending.set(pid, pending)
        ctx.signal.addEventListener('abort', abortHandler, { once: true })
        this.broadcastPermissionRequest(session, pending)
      })
    }

    // Only register canUseTool when the session is NOT in bypass mode — bypass
    // semantics mean "no prompts ever", so plumbing through our own callback
    // would defeat the user's choice.
    if (fullOpts.permissionMode !== 'bypassPermissions' && !fullOpts.canUseTool) {
      fullOpts.canUseTool = canUseTool
    }

    const q = query({ prompt: input.iterable, options: fullOpts })

    // When resuming we keep the original createdAt from the persisted meta
    // so the UI's "session age" doesn't reset each time the user clicks
    // "resume". New sessions start from now().
    const existingMeta = this.store?.get(id)
    const createdAt = existingMeta?.createdAt ?? Date.now()

    session = {
      id,
      createdAt,
      lastActivityAt: Date.now(),
      ...this.snapshotMeta(fullOpts),
      input,
      query: q,
      subscribers: new Map(),
      permissionSubscribers: new Map(),
      pending: new Map(),
      history: [],
      pumpTask: Promise.resolve(),
      running: true,
      terminated: false,
      pendingTurns: 0,
    }

    session.pumpTask = this.pump(session)
    this.sessions.set(id, session)
    this.persist(session)
    return this.info(session)
  }

  /** Send a user turn into an existing session. */
  send(id: string, text: string): void {
    const s = this.require(id)
    if (s.terminated) {
      throw new HttpError(410, `session ${id} is terminated`)
    }
    const userMsg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      uuid: randomUUID(),
      session_id: s.id,
    }
    // 1. Feed the SDK so it triggers an assistant turn.
    s.input.push(userMsg)
    // 2. Also broadcast + record locally — the SDK's output stream doesn't
    //    echo user messages back, so without this step the client would
    //    never see its own sent text.
    s.history.push(userMsg)
    if (s.history.length > this.historyCap) {
      s.history.splice(0, s.history.length - this.historyCap)
    }
    for (const sub of s.subscribers.values()) sub.push(userMsg)
    s.lastActivityAt = Date.now()
    // Mark the session as mid-turn. The matching `result` message in the
    // pump will decrement this; we track a count (not a bool) because the
    // UI allows queueing multiple user turns while one is in flight.
    s.pendingTurns += 1
    this.persist(s)
  }

  /** Interrupt the current assistant turn. */
  async interrupt(id: string): Promise<void> {
    const s = this.require(id)
    await s.query.interrupt()
    s.lastActivityAt = Date.now()
    this.persist(s)
  }

  async setModel(id: string, model?: string): Promise<SessionInfo> {
    const s = this.require(id)
    await s.query.setModel(model)
    s.model = model
    s.lastActivityAt = Date.now()
    this.persist(s)
    return this.info(s)
  }

  async setPermissionMode(id: string, mode: PermissionMode): Promise<SessionInfo> {
    const s = this.require(id)
    await s.query.setPermissionMode(mode)
    s.permissionMode = mode
    s.lastActivityAt = Date.now()
    this.persist(s)
    return this.info(s)
  }

  async applySettings(id: string, settings: Settings): Promise<SessionInfo> {
    const s = this.require(id)
    await s.query.applyFlagSettings(settings)
    s.lastActivityAt = Date.now()
    return this.info(s)
  }

  async supportedModels(id: string) {
    const s = this.require(id)
    return s.query.supportedModels()
  }

  async supportedCommands(id: string) {
    const s = this.require(id)
    return s.query.supportedCommands()
  }

  async supportedAgents(id: string) {
    const s = this.require(id)
    return s.query.supportedAgents()
  }

  async mcpServerStatus(id: string) {
    const s = this.require(id)
    return s.query.mcpServerStatus()
  }

  async contextUsage(id: string) {
    const s = this.require(id)
    return s.query.getContextUsage()
  }

  /** List pending tool-permission requests for a session. */
  listPending(id: string): PermissionRequestSnapshot[] {
    const s = this.require(id)
    return Array.from(s.pending.values()).map(toSnapshot)
  }

  /**
   * Resolve a pending tool-permission request.
   *
   * For "allow": `persistForSession=true` promotes the SDK-provided
   * suggestions to the current session scope, so the same tool+args won't
   * prompt again within this Query.
   *
   * For "deny": we always return interrupt=false, so the model sees the
   * deny result and can re-plan rather than aborting the whole turn.
   */
  decide(
    sid: string,
    pid: string,
    decision:
      | { behavior: 'allow'; persistForSession?: boolean }
      | { behavior: 'deny'; message?: string },
  ): void {
    const s = this.require(sid)
    const p = s.pending.get(pid)
    if (!p) throw new HttpError(404, `pending permission ${pid} not found`)
    // Detach abort handler so aborting an already-resolved promise is a no-op.
    try {
      p.signal.removeEventListener('abort', p.abortHandler)
    } catch {
      /* ignore */
    }
    s.pending.delete(pid)
    s.lastActivityAt = Date.now()

    if (decision.behavior === 'allow') {
      // The SDK's runtime Zod schema is stricter than the TypeScript type:
      // `updatedInput` is required (not optional) and `undefined` fields on
      // the object also trip it. We build the payload incrementally and
      // echo the tool's original input — a plain approval with no argument
      // rewriting.
      const updatedPermissions = decision.persistForSession ? promoteToSession(p.suggestions) : undefined
      const result: PermissionResult = {
        behavior: 'allow',
        updatedInput: p.input,
        toolUseID: p.toolUseID,
      }
      if (updatedPermissions && updatedPermissions.length > 0) {
        result.updatedPermissions = updatedPermissions
      }
      p.resolve(result)
      this.broadcastPermissionResolved(s, pid, {
        behavior: 'allow',
        persisted: !!decision.persistForSession,
      })
    } else {
      const message = decision.message?.trim() || 'User denied the tool request.'
      p.resolve({
        behavior: 'deny',
        message,
        interrupt: false,
        toolUseID: p.toolUseID,
      })
      this.broadcastPermissionResolved(s, pid, {
        behavior: 'deny',
        persisted: false,
        message,
      })
    }
  }

  /** SSE subscription for permission-channel events. */
  subscribePermissions(id: string): {
    iterable: AsyncIterable<PermissionEvent>
    snapshot: PermissionRequestSnapshot[]
    unsubscribe: () => void
  } {
    const s = this.require(id)
    const subId = randomUUID()
    const queue: PermissionEvent[] = []
    let waiter: ((v: IteratorResult<PermissionEvent>) => void) | null = null
    let closed = false

    const sub: PermissionSubscriber = {
      id: subId,
      push: (ev) => {
        if (closed) return
        if (waiter) {
          const w = waiter
          waiter = null
          w({ value: ev, done: false })
        } else {
          queue.push(ev)
        }
      },
      end: () => {
        if (closed) return
        closed = true
        if (waiter) {
          const w = waiter
          waiter = null
          w({ value: undefined as unknown as PermissionEvent, done: true })
        }
      },
    }
    s.permissionSubscribers.set(subId, sub)

    const iterable: AsyncIterable<PermissionEvent> = {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<PermissionEvent>> {
            if (queue.length) {
              return Promise.resolve({ value: queue.shift()!, done: false })
            }
            if (closed) {
              return Promise.resolve({ value: undefined as unknown as PermissionEvent, done: true })
            }
            return new Promise((r) => {
              waiter = r
            })
          },
          return: (): Promise<IteratorResult<PermissionEvent>> => {
            sub.end()
            s.permissionSubscribers.delete(subId)
            return Promise.resolve({ value: undefined as unknown as PermissionEvent, done: true })
          },
        }
      },
    }

    return {
      iterable,
      snapshot: Array.from(s.pending.values()).map(toSnapshot),
      unsubscribe: () => {
        sub.end()
        s.permissionSubscribers.delete(subId)
      },
    }
  }

  private broadcastPermissionRequest(session: Session, p: PendingPermission): void {
    const snapshot = toSnapshot(p)
    for (const sub of session.permissionSubscribers.values()) {
      sub.push({ kind: 'request', payload: snapshot })
    }
  }

  private broadcastPermissionResolved(
    session: Session,
    pid: string,
    decision: PermissionDecisionSummary,
  ): void {
    for (const sub of session.permissionSubscribers.values()) {
      sub.push({ kind: 'resolved', pid, decision })
    }
  }

  /**
   * Subscribe to live events. Returns (1) an AsyncIterable the caller can
   * stream to SSE, and (2) a snapshot of history so the caller can replay
   * past messages before entering the live loop.
   */
  subscribe(id: string): { iterable: AsyncIterable<SDKMessage>; history: SDKMessage[]; unsubscribe: () => void } {
    const s = this.require(id)
    const subId = randomUUID()
    const queue: SDKMessage[] = []
    let waiter: ((v: IteratorResult<SDKMessage>) => void) | null = null
    let closed = false

    const sub: Subscriber = {
      id: subId,
      push: (msg) => {
        if (closed) return
        if (waiter) {
          const w = waiter
          waiter = null
          w({ value: msg, done: false })
        } else {
          queue.push(msg)
        }
      },
      end: () => {
        if (closed) return
        closed = true
        if (waiter) {
          const w = waiter
          waiter = null
          w({ value: undefined as unknown as SDKMessage, done: true })
        }
      },
      get closed() {
        return closed
      },
    }
    s.subscribers.set(subId, sub)

    const iterable: AsyncIterable<SDKMessage> = {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<SDKMessage>> {
            if (queue.length) {
              return Promise.resolve({ value: queue.shift()!, done: false })
            }
            if (closed) {
              return Promise.resolve({ value: undefined as unknown as SDKMessage, done: true })
            }
            return new Promise((r) => {
              waiter = r
            })
          },
          return: (): Promise<IteratorResult<SDKMessage>> => {
            sub.end()
            s.subscribers.delete(subId)
            return Promise.resolve({ value: undefined as unknown as SDKMessage, done: true })
          },
        }
      },
    }

    return {
      iterable,
      history: s.history.slice(),
      unsubscribe: () => {
        sub.end()
        s.subscribers.delete(subId)
      },
    }
  }

  /** Delete a session for good: close its Query AND erase its persistence
   *  entry. Use when the user explicitly clicks "delete" in the UI. */
  async delete(id: string): Promise<void> {
    await this.unload(id, { terminate: true })
    this.store?.remove(id)
  }

  /** Close the Query and drop the in-memory session, but keep metadata on
   *  disk so the user can resume it later. Used by the idle GC and during
   *  graceful shutdown.
   *
   *  `terminate`: when true, the session is marked terminated in the
   *  persistence store (prevents future resume) — used on explicit delete
   *  and when the Query itself has ended. Default false. */
  async unload(id: string, opts: { terminate?: boolean } = {}): Promise<void> {
    const s = this.sessions.get(id)
    if (!s) return
    if (opts.terminate) s.terminated = true
    s.running = false
    s.input.end()
    // Resolve every still-pending permission as a deny so no SDK awaiter
    // stays hanging forever.
    for (const [pid, p] of s.pending) {
      try {
        p.signal.removeEventListener('abort', p.abortHandler)
      } catch {
        /* ignore */
      }
      p.resolve({ behavior: 'deny', message: 'session closed', interrupt: false })
      this.broadcastPermissionResolved(s, pid, {
        behavior: 'deny',
        persisted: false,
        message: 'session closed',
      })
    }
    s.pending.clear()
    for (const sub of s.subscribers.values()) sub.end()
    s.subscribers.clear()
    for (const sub of s.permissionSubscribers.values()) sub.end()
    s.permissionSubscribers.clear()
    // Let the pump exit on its own (the iterable is now drained). We don't
    // await it indefinitely — the SDK occasionally holds connections open.
    this.sessions.delete(id)
    // Persist the final state (terminated flag, messageCount, etc.) before
    // dropping the in-memory struct.
    this.persist(s)
  }

  /** List sessions: everything currently live + everything in the store
   *  that isn't live (as "hibernated" entries). */
  list(): SessionInfo[] {
    const out: SessionInfo[] = []
    const seen = new Set<string>()
    for (const s of this.sessions.values()) {
      out.push(this.info(s))
      seen.add(s.id)
    }
    if (this.store) {
      for (const meta of this.store.list()) {
        if (seen.has(meta.id)) continue
        out.push(this.infoFromMeta(meta))
      }
    }
    // Most recent activity first — matches the old behaviour of live-only
    // sessions sitting at the top while the user works on them.
    out.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    return out
  }

  get(id: string): SessionInfo {
    const live = this.sessions.get(id)
    if (live) return this.info(live)
    const meta = this.store?.get(id)
    if (meta) return this.infoFromMeta(meta)
    throw new HttpError(404, `session ${id} not found`)
  }

  async shutdown(): Promise<void> {
    if (this.gcTimer) clearInterval(this.gcTimer)
    const ids = Array.from(this.sessions.keys())
    // Unload without terminating: the user may have exited cleanly and
    // will want to resume on next launch. Only Query-ended sessions stay
    // terminated (that flag was already set by the pump's finally block).
    await Promise.all(ids.map((id) => this.unload(id)))
    await this.store?.flush()
  }

  // --- internals ---

  private require(id: string): Session {
    const s = this.sessions.get(id)
    if (!s) throw new HttpError(404, `session ${id} not found`)
    return s
  }

  private info(s: Session): SessionInfo {
    return {
      id: s.id,
      createdAt: s.createdAt,
      lastActivityAt: s.lastActivityAt,
      subscribers: s.subscribers.size,
      messageCount: s.history.length,
      cwd: s.cwd,
      model: s.model,
      permissionMode: s.permissionMode,
      title: s.title,
      running: s.running,
      terminated: s.terminated,
      error: s.error,
      working: s.running && s.pendingTurns > 0,
      lastTurnAt: s.lastTurnAt,
    }
  }

  /** Project a persisted meta into the SessionInfo shape. Dormant sessions
   *  have running=false and no live subscribers; messageCount is the last
   *  known value from before the Query was unloaded. */
  private infoFromMeta(meta: SessionMeta): SessionInfo {
    return {
      id: meta.id,
      createdAt: meta.createdAt,
      lastActivityAt: meta.lastActivityAt,
      subscribers: 0,
      messageCount: meta.messageCount,
      cwd: meta.cwd,
      model: meta.model,
      permissionMode: meta.permissionMode,
      title: meta.title,
      running: false,
      terminated: meta.terminated,
      error: meta.error,
      working: false,
      lastTurnAt: meta.lastTurnAt,
    }
  }

  private async pump(session: Session): Promise<void> {
    try {
      for await (const msg of session.query) {
        session.lastActivityAt = Date.now()
        session.history.push(msg)
        if (session.history.length > this.historyCap) {
          session.history.splice(0, session.history.length - this.historyCap)
        }
        for (const sub of session.subscribers.values()) sub.push(msg)
        // `result` marks a completed turn. Decrement the pending counter
        // and stamp lastTurnAt so the frontend can flag unread. Clamped
        // at 0 in case the SDK emits spurious results (shouldn't happen
        // but cheap insurance).
        if (msg.type === 'result') {
          session.pendingTurns = Math.max(0, session.pendingTurns - 1)
          session.lastTurnAt = Date.now()
          this.persist(session)
        }
      }
    } catch (err) {
      session.error = err instanceof Error ? err.message : String(err)
      // Broadcast a synthetic error message so subscribers know what happened.
      const synthetic: SDKMessage = {
        type: 'system',
        subtype: 'error',
        error: session.error,
        uuid: randomUUID(),
        session_id: session.id,
      } as unknown as SDKMessage
      for (const sub of session.subscribers.values()) sub.push(synthetic)
    } finally {
      session.running = false
      session.terminated = true
      for (const sub of session.subscribers.values()) sub.end()
      session.subscribers.clear()
      // Persist the terminal state so the UI shows the transcript as
      // "ended" after a reload, and resume() can refuse to re-spawn it.
      this.persist(session)
    }
  }

  /** Idle GC: drop in-memory Query for sessions nobody is watching and
   *  whose last activity is older than idleMs. Metadata stays on disk so
   *  the session can be resumed later. Terminated sessions are also
   *  evicted from memory the same way. */
  private gc() {
    const now = Date.now()
    for (const [id, s] of this.sessions) {
      const idle = now - s.lastActivityAt > this.idleMs
      if (idle && s.subscribers.size === 0) {
        void this.unload(id)
      }
    }
  }
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

/** Strip the non-serializable fields (resolve/signal) before JSON. */
function toSnapshot(p: PendingPermission): PermissionRequestSnapshot {
  return {
    id: p.id,
    toolName: p.toolName,
    input: p.input,
    title: p.title,
    displayName: p.displayName,
    description: p.description,
    suggestions: p.suggestions,
    toolUseID: p.toolUseID,
    createdAt: p.createdAt,
  }
}

/**
 * Rewrite SDK-provided suggestions to target the current session scope.
 *
 * The SDK hands us `suggestions: PermissionUpdate[]` with whatever destination
 * it picked (often 'userSettings' or 'projectSettings'). For session-scoped
 * allow-always, we force every addRules/setMode/addDirectories update to
 * `destination: 'session'`, so the change only lives as long as this Query.
 */
function promoteToSession(
  suggestions: PermissionUpdate[] | undefined,
): PermissionUpdate[] | undefined {
  if (!suggestions?.length) return undefined
  return suggestions.map((s) => ({ ...s, destination: 'session' as const }))
}
