// Multi-session pool for @anthropic-ai/claude-agent-sdk Query instances.
//
// Each session holds:
//   - A pushable input iterable (queue of SDKUserMessage) — writers push turns,
//     the SDK reads them.
//   - The Query async generator returned by `query({ prompt, options })` — we
//     pump it in a background task and fan every message out to subscribers.
//   - Subscribers (Set<Subscriber>) — each connected client has its own subscriber
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
import { invalidateRecapCache } from './recap.js'

/** Subscriber — each connected client gets one of these. */
interface Subscriber {
  id: string
  push: (msg: SDKMessage) => void
  /** Push a named event that bypasses message history (e.g. context_usage). */
  pushEvent: (name: string, data: unknown) => void
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

/** One question within an AskUserQuestion tool_use. Mirrors the SDK's
 *  internal shape but narrowed so the frontend can rely on it. */
export interface QuestionSpec {
  question: string
  /** Short header/label for the question, shown as a chip in the UI. */
  header?: string
  multiSelect?: boolean
  options: Array<{
    label: string
    description?: string
    /** Preview body (markdown by default). SDK's toolConfig.askUserQuestion
     *  can flip this to HTML, but we don't set that option. */
    preview?: string
  }>
}

/** JSON-safe snapshot of a pending permission request OR interactive
 *  question. Permissions and questions ride on the same channel and
 *  the same pending map — they're both "SDK waiting on the user" events
 *  — but the frontend renders them with different components, so the
 *  `kind` discriminator matters. */
export type PermissionRequestSnapshot =
  | {
      kind: 'permission'
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
  | {
      kind: 'question'
      id: string
      toolName: 'AskUserQuestion'
      /** Raw questions array as handed to the tool. The frontend renders
       *  one form per element; each is single- or multi-select. */
      questions: QuestionSpec[]
      toolUseID: string
      createdAt: number
    }

/** Summary of how a pending request was resolved (broadcast to all tabs). */
export interface PermissionDecisionSummary {
  behavior: 'allow' | 'deny'
  persisted: boolean
  message?: string
}

/** Answer submitted for a pending AskUserQuestion. Indices align with
 *  the `questions` array. Each entry is either a single option label
 *  (single-select) or an array of labels (multi-select), or null when
 *  the user skipped (we forward a "user skipped" note to the model). */
export type QuestionAnswer = string | string[] | null

/** Internal server-side state per pending request. Carries the SDK
 *  resolver + signal alongside the JSON-serializable snapshot so the
 *  single `pending` map can hold both flavours. */
type PendingPermission = PermissionRequestSnapshot & {
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
  /** Epoch ms when the current turn started (first pending turn). Only set
   *  while `working` is true; allows the client to compute an accurate
   *  elapsed timer that survives component remounts. */
  workingSince?: number
  /** Epoch ms of the last completed turn (last `result` message). The
   *  frontend diffs this against a locally-remembered value to decide
   *  whether to show an unread badge on non-focused sessions. */
  lastTurnAt?: number
  /** User pinned this session — sticks to the top of the sidebar and
   *  survives the 3-panel eviction rule. */
  pinned?: boolean
}

interface Session {
  id: string
  createdAt: number
  lastActivityAt: number
  cwd?: string
  model?: string
  permissionMode?: PermissionMode
  title?: string
  pinned?: boolean
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
  /** Epoch ms when the first pending turn started. Cleared when all turns
   *  complete (pendingTurns drops to 0) or the session terminates. */
  workingSince?: number
  /** Timestamp of the last `result` message, used for the unread badge. */
  lastTurnAt?: number
  /** Pushable for context_usage events — separate from message history
   *  so reconnects don't replay stale usage snapshots. */
  contextUsagePushable: Pushable<unknown>
}

const HISTORY_CAP = 500
const SUBSCRIBER_QUEUE_CAP = 500
const DEFAULT_IDLE_MS = 30 * 60 * 1000 // 30 min

export interface SessionManagerOptions {
  idleMs?: number
  historyCap?: number
  /** When set, session metadata is persisted here so dormant sessions
   *  survive restarts. See server/persistence.ts. */
  store?: SessionStore
  /** Absolute path to the `claude` CLI binary, injected into every
   *  Query's Options.pathToClaudeCodeExecutable. Bypasses the SDK's
   *  internal platform-native-package resolution, which can pick a
   *  wrong libc variant on some systems. */
  claudeBinary?: string
}

/** Global session-list update event. Broadcast whenever a session's
 *  info changes (working toggled, turn completed, error set, etc.) so
 *  the frontend sidebar can replace 5-second polling with a push feed. */
export type GlobalSessionEvent =
  | { kind: 'update'; session: SessionInfo }
  | { kind: 'created'; session: SessionInfo }
  | { kind: 'removed'; id: string }
  /** A tool-permission request arrived for a session. Mirrored onto the
   *  global channel so that App-level code can fire a desktop notification
   *  even when the
   *  session's Chat panel isn't mounted. `sessionId` lets the frontend
   *  route-to-session on click. */
  | { kind: 'permission_request'; sessionId: string; request: PermissionRequestSnapshot }

interface GlobalSubscriber {
  id: string
  push: (ev: GlobalSessionEvent) => void
  end: () => void
}

export class SessionManager {
  private sessions = new Map<string, Session>()
  private idleMs: number
  private historyCap: number
  private gcTimer?: NodeJS.Timeout
  private store?: SessionStore
  private claudeBinary?: string
  private globalSubscribers = new Map<string, GlobalSubscriber>()

  constructor(opts: SessionManagerOptions = {}) {
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS
    this.claudeBinary = opts.claudeBinary
    this.historyCap = opts.historyCap ?? HISTORY_CAP
    this.store = opts.store
    this.gcTimer = setInterval(() => this.gc(), 60_000)
    // Don't keep the Node process alive just for GC
    this.gcTimer.unref?.()
  }

  /** Write the current in-memory state of a session into the persistence
   *  store and broadcast an update to global subscribers. No-op when no
   *  store is configured. Debounced on the store side so calling this on
   *  every tiny state change is fine. */
  private persist(s: Session): void {
    this.writeStore(s)
    this.broadcastGlobal({ kind: 'update', session: this.info(s) })
  }

  /** Write a session's metadata to the persistence store without
   *  broadcasting on the global channel. Use from spawn() so the
   *  subsequent `created` event is the only thing the frontend sees for
   *  a brand-new session — if we also sent an `update` the client can't
   *  tell which arrives first, which races with the optimistic POST
   *  response and produces duplicate cards. */
  private writeStore(s: Session): void {
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
      pinned: s.pinned,
    })
  }

  private broadcastGlobal(ev: GlobalSessionEvent): void {
    for (const sub of this.globalSubscribers.values()) sub.push(ev)
  }

  /** Subscribe to global session list changes. The returned iterable emits
   *  {kind:update,session} on every persist() call and {kind:removed,id} on
   *  delete(). Intended for a single fan-out endpoint that replaces
   *  periodic GET /sessions polling. */
  subscribeGlobal(): {
    iterable: AsyncIterable<GlobalSessionEvent>
    snapshot: SessionInfo[]
    unsubscribe: () => void
  } {
    const subId = randomUUID()
    const queue: GlobalSessionEvent[] = []
    let waiter: ((v: IteratorResult<GlobalSessionEvent>) => void) | null = null
    let closed = false

    const sub: GlobalSubscriber = {
      id: subId,
      push: (ev) => {
        if (closed) return
        if (waiter) {
          const w = waiter
          waiter = null
          w({ value: ev, done: false })
        } else {
          queue.push(ev)
          if (queue.length > SUBSCRIBER_QUEUE_CAP) {
            queue.splice(0, queue.length - SUBSCRIBER_QUEUE_CAP)
          }
        }
      },
      end: () => {
        if (closed) return
        closed = true
        if (waiter) {
          const w = waiter
          waiter = null
          w({ value: undefined as unknown as GlobalSessionEvent, done: true })
        }
      },
    }
    this.globalSubscribers.set(subId, sub)

    const iterable: AsyncIterable<GlobalSessionEvent> = {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<GlobalSessionEvent>> => {
          if (queue.length) return Promise.resolve({ value: queue.shift()!, done: false })
          if (closed) return Promise.resolve({ value: undefined as unknown as GlobalSessionEvent, done: true })
          return new Promise((r) => {
            waiter = r
          })
        },
        return: (): Promise<IteratorResult<GlobalSessionEvent>> => {
          sub.end()
          this.globalSubscribers.delete(subId)
          return Promise.resolve({ value: undefined as unknown as GlobalSessionEvent, done: true })
        },
      }),
    }

    return {
      iterable,
      snapshot: this.list(),
      unsubscribe: () => {
        sub.end()
        this.globalSubscribers.delete(subId)
      },
    }
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

  /** Fork a session: spawn a new session whose transcript is initialised
   *  from the source session's on-disk log, but which gets a fresh UUID
   *  so future turns diverge. Implemented via SDK's `options.resume` +
   *  `forkSession: true`. Uses the source's cwd/model/permissionMode by
   *  default; the title is suffixed " (fork)" so sidebars can tell the
   *  two apart at a glance.
   *
   *  Source can be live OR dormant — we pull metadata from memory first,
   *  persistence second. Terminated sessions can still be forked (their
   *  transcript lives in ~/.claude/projects/ regardless).
   *
   *  Refuses to fork a source whose SDK hasn't completed a turn yet: the
   *  SDK only writes ~/.claude/projects/<cwd>/<id>.jsonl after the first
   *  `result` message, so forking earlier fails with `No conversation
   *  found with session ID: <uuid>` from the CLI. `lastTurnAt` is our
   *  ground-truth signal (set only by the pump on a real `result`). */
  fork(id: string): SessionInfo {
    const live = this.sessions.get(id)
    const meta = live ?? this.store?.get(id)
    if (!meta) throw new HttpError(404, `session ${id} not found`)
    if (!meta.lastTurnAt) {
      throw new HttpError(
        400,
        `session ${id} has no completed turns yet — send at least one message and wait for the reply before forking`,
      )
    }
    const title = meta.title ? `${meta.title} (fork)` : undefined
    const forkOpts: Options = {
      resume: id,
      forkSession: true,
      cwd: meta.cwd,
      model: meta.model,
      permissionMode: meta.permissionMode,
      title,
    }
    return this.spawn(randomUUID(), forkOpts)
  }

  /** Shared spawn path for create() and resume(). */
  private spawn(id: string, opts: Options): SessionInfo {
    const input = createPushable<SDKUserMessage>()
    const fullOpts: Options = { ...opts }
    // Remember the user-requested permission mode before we strip it
    // from the SDK options. The session's own state ends up holding it.
    const requestedMode = opts.permissionMode
    // includePartialMessages=true so clients can render streaming deltas; callers
    // can still override to false if they prefer batched messages only.
    if (fullOpts.includePartialMessages === undefined) {
      fullOpts.includePartialMessages = true
    }
    // Inject the server-wide `claude` binary path unless the caller has
    // already specified one. This is the fix for the SDK's musl/glibc
    // resolution bug on Linux: the native binary subpackage can be
    // resolved to the wrong libc flavour, and the process would then
    // fail to exec. Passing an explicit path side-steps the lookup.
    if (!fullOpts.pathToClaudeCodeExecutable && this.claudeBinary) {
      fullOpts.pathToClaudeCodeExecutable = this.claudeBinary
    }

    // The session struct needs to exist before canUseTool fires (the SDK can
    // request permission mid-turn), so we declare it here and wire up the
    // callback against the closure. prefer-const is a false positive —
    // the assignment happens below, after the canUseTool closure captures
    // the binding.
    // eslint-disable-next-line prefer-const
    let session: Session
    const canUseTool: CanUseTool = async (toolName, toolInput, ctx) => {
      // `AskUserQuestion` is an interactive tool (not a permission check)
      // but it still routes through canUseTool. Intercepting here is the
      // only reliable way to override its output — PreToolUse.block and
      // PostToolUse.updatedToolOutput were tested against SDK 2.1.133
      // and neither actually short-circuits the built-in "no interactive
      // UI" placeholder handler. canUseTool deny+message DOES short-
      // circuit it: the model sees our `message` as the tool_result and
      // proceeds as if it got a real answer. See docs in README.
      if (toolName === 'AskUserQuestion') {
        const questions = sanitizeQuestions(toolInput)
        // If the model sent completely malformed input (no valid questions),
        // resolve immediately instead of showing an empty dialog.
        if (questions.length === 0) {
          return {
            behavior: 'deny',
            message: JSON.stringify({
              note: 'AskUserQuestion input was malformed — no valid questions found.',
              answers: [],
            }),
            interrupt: false,
            toolUseID: ctx.toolUseID,
          }
        }
        return new Promise<PermissionResult>((resolve) => {
          const pid = randomUUID()
          const abortHandler = () => {
            if (!session.pending.has(pid)) return
            session.pending.delete(pid)
            resolve({ behavior: 'deny', message: 'aborted', interrupt: false, toolUseID: ctx.toolUseID })
            this.broadcastPermissionResolved(session, pid, {
              behavior: 'deny',
              persisted: false,
              message: 'aborted',
            })
          }
          const pending: PendingPermission = {
            kind: 'question',
            id: pid,
            toolName: 'AskUserQuestion',
            questions,
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
      // `bypassPermissions` is implemented here rather than via the SDK's
      // own permissionMode flag. That flag is set at spawn time and the
      // SDK then refuses to transition into it mid-session, which makes
      // the UI toggle unreliable. By routing every tool call through our
      // own callback we can flip the behaviour on the fly — session state
      // (`permissionMode`) is the single source of truth, no CLI-side
      // --dangerously-skip-permissions plumbing required.
      if (session.permissionMode === 'bypassPermissions') {
        return {
          behavior: 'allow',
          updatedInput: toolInput,
          toolUseID: ctx.toolUseID,
        } satisfies PermissionResult
      }
      return new Promise<PermissionResult>((resolve) => {
        const pid = randomUUID()
        const abortHandler = () => {
          if (!session.pending.has(pid)) return
          session.pending.delete(pid)
          // Aborted means the enclosing turn was interrupted — return a deny
          // that does NOT cascade (interrupt: false), SDK will unwind anyway.
          resolve({ behavior: 'deny', message: 'aborted', interrupt: false, toolUseID: ctx.toolUseID })
          this.broadcastPermissionResolved(session, pid, {
            behavior: 'deny',
            persisted: false,
            message: 'aborted',
          })
        }
        const pending: PendingPermission = {
          kind: 'permission',
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

    // Always register canUseTool. Previously we skipped it for
    // bypassPermissions, but now the callback itself short-circuits that
    // mode — meaning mode swaps at runtime (handled in setPermissionMode
    // below) take effect immediately without needing a session restart.
    if (!fullOpts.canUseTool) {
      fullOpts.canUseTool = canUseTool
    }
    // Don't forward permissionMode to the SDK. We enforce it ourselves via
    // canUseTool, and the SDK's built-in flag would just add a brittle
    // "can't transition into bypassPermissions" constraint on top.
    fullOpts.permissionMode = undefined

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
      // Restore the user-requested mode we stashed before clearing the
      // SDK-side flag. fullOpts.permissionMode was set to undefined so the
      // spread above would leave it unset otherwise.
      permissionMode: requestedMode,
      // Carry pinned from the persisted meta on resume — a pinned
      // dormant session should stay pinned after it wakes up. New
      // (non-resumed) sessions start unpinned.
      pinned: existingMeta?.pinned ?? undefined,
      input,
      query: q,
      subscribers: new Map(),
      permissionSubscribers: new Map(),
      pending: new Map(),
      history: [],
      contextUsagePushable: createPushable<unknown>(),
      pumpTask: Promise.resolve(),
      running: true,
      terminated: false,
      pendingTurns: 0,
    }

    session.pumpTask = this.pump(session)
    this.sessions.set(id, session)
    // Brand-new session (or a resume, which also "creates" as far as the
    // UI list is concerned): persist to disk, then broadcast `created`
    // instead of `update`. The frontend `created` handler is the one
    // that knows how to insert, so there's a single canonical origin
    // for the row — no races with the POST /sessions response.
    this.writeStore(session)
    this.broadcastGlobal({ kind: 'created', session: this.info(session) })
    return this.info(session)
  }

  /** Send a user turn into an existing session. */
  send(id: string, text: string): void {
    const s = this.require(id)
    if (s.terminated) {
      throw new HttpError(410, `session ${id} is terminated`)
    }
    if (!s.running) {
      // The Query has been unloaded (idle GC or graceful shutdown). The
      // caller should POST /resume first rather than retrying send().
      throw new HttpError(409, `session ${id} is not running; resume it first`)
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
    if (s.pendingTurns === 0) s.workingSince = Date.now()
    s.pendingTurns += 1
    this.persist(s)
  }

  /** Interrupt the current assistant turn. */
  async interrupt(id: string): Promise<void> {
    const s = this.requireLive(id)
    await s.query.interrupt()
    s.lastActivityAt = Date.now()
    this.persist(s)
  }

  async setModel(id: string, model?: string): Promise<SessionInfo> {
    const s = this.requireLive(id)
    await s.query.setModel(model)
    s.model = model
    s.lastActivityAt = Date.now()
    this.persist(s)
    return this.info(s)
  }

  /** Rename a session. Accepts both live and dormant sessions (title is
   *  pure UI metadata — no SDK call needed). Empty string / whitespace
   *  clears the title so the UI falls back to the id prefix. */
  rename(id: string, title: string): SessionInfo {
    const trimmed = title.trim() || undefined
    return this.mutateMeta(id, (draft) => ({ ...draft, title: trimmed }))
  }

  /** Toggle the pinned flag. Pure UI metadata, no SDK call. */
  setPinned(id: string, pinned: boolean): SessionInfo {
    return this.mutateMeta(id, (draft) => ({ ...draft, pinned: pinned || undefined }))
  }

  /** Shared mutator for pure-metadata changes (rename / setPinned). Works
   *  on both live and dormant sessions — the UI treats the two the same,
   *  and the transform needs to land in both in-memory state and
   *  persisted meta regardless. */
  private mutateMeta(
    id: string,
    transform: (draft: {
      cwd?: string
      model?: string
      permissionMode?: PermissionMode
      title?: string
      pinned?: boolean
    }) => {
      cwd?: string
      model?: string
      permissionMode?: PermissionMode
      title?: string
      pinned?: boolean
    },
  ): SessionInfo {
    const live = this.sessions.get(id)
    if (live) {
      const draft = transform({
        cwd: live.cwd,
        model: live.model,
        permissionMode: live.permissionMode,
        title: live.title,
        pinned: live.pinned,
      })
      live.title = draft.title
      live.pinned = draft.pinned
      live.lastActivityAt = Date.now()
      this.persist(live)
      return this.info(live)
    }
    if (!this.store) throw new HttpError(404, `session ${id} not found`)
    const meta = this.store.get(id)
    if (!meta) throw new HttpError(404, `session ${id} not found`)
    const draft = transform({
      cwd: meta.cwd,
      model: meta.model,
      permissionMode: meta.permissionMode,
      title: meta.title,
      pinned: meta.pinned,
    })
    const nextMeta: SessionMeta = {
      ...meta,
      title: draft.title,
      pinned: draft.pinned,
      lastActivityAt: Date.now(),
    }
    this.store.upsert(nextMeta)
    const info = this.infoFromMeta(nextMeta)
    this.broadcastGlobal({ kind: 'update', session: info })
    return info
  }

  async setPermissionMode(id: string, mode: PermissionMode): Promise<SessionInfo> {
    // Permission mode is entirely client-side state now: we enforce it
    // in the canUseTool callback (see spawn). That means transitions
    // never fail, including the previously-blocked "→ bypassPermissions"
    // case that used to require --dangerously-skip-permissions at
    // launch. No SDK round-trip needed.
    const s = this.requireLive(id)
    s.permissionMode = mode
    s.lastActivityAt = Date.now()
    this.persist(s)
    return this.info(s)
  }

  async applySettings(id: string, settings: Settings): Promise<SessionInfo> {
    const s = this.requireLive(id)
    await s.query.applyFlagSettings(settings)
    s.lastActivityAt = Date.now()
    this.persist(s)
    return this.info(s)
  }

  async supportedModels(id: string) {
    const s = this.requireLive(id)
    return s.query.supportedModels()
  }

  async supportedCommands(id: string) {
    const s = this.requireLive(id)
    return s.query.supportedCommands()
  }

  async supportedAgents(id: string) {
    const s = this.requireLive(id)
    return s.query.supportedAgents()
  }

  async mcpServerStatus(id: string) {
    const s = this.requireLive(id)
    return s.query.mcpServerStatus()
  }

  async reconnectMcpServer(id: string, serverName: string): Promise<void> {
    const s = this.requireLive(id)
    await s.query.reconnectMcpServer(serverName)
  }

  async toggleMcpServer(id: string, serverName: string, enabled: boolean): Promise<void> {
    const s = this.requireLive(id)
    await s.query.toggleMcpServer(serverName, enabled)
  }

  async reloadPlugins(id: string) {
    const s = this.requireLive(id)
    return s.query.reloadPlugins()
  }

  async contextUsage(id: string) {
    const s = this.requireLive(id)
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
    if (p.kind === 'question') {
      throw new HttpError(
        400,
        `pending ${pid} is an interactive question, use /answer-question instead`,
      )
    }
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

  /**
   * Resolve a pending AskUserQuestion with user-selected answers.
   *
   * The SDK's built-in AskUserQuestion handler is bypassed via canUseTool
   * deny+message: the `message` ends up in the tool_result block the model
   * sees, so it reads the user's answer as if the tool had produced it.
   *
   * `answers[i]` aligns with the `questions[i]` of the pending request.
   * Each entry is a chosen label (single-select), array of labels
   * (multi-select), or null (skipped).
   */
  answerQuestion(sid: string, pid: string, answers: QuestionAnswer[]): void {
    const s = this.require(sid)
    const p = s.pending.get(pid)
    if (!p) throw new HttpError(404, `pending ${pid} not found`)
    if (p.kind !== 'question') {
      throw new HttpError(400, `pending ${pid} is not an interactive question`)
    }
    try {
      p.signal.removeEventListener('abort', p.abortHandler)
    } catch {
      /* ignore */
    }
    s.pending.delete(pid)
    s.lastActivityAt = Date.now()

    const message = formatQuestionAnswers(p.questions, answers)
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

  /** Subscription for permission-channel events. */
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
          if (queue.length > SUBSCRIBER_QUEUE_CAP) {
            queue.splice(0, queue.length - SUBSCRIBER_QUEUE_CAP)
          }
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

  /** AsyncIterable of context-usage snapshots for one session.
   *  Returns null if the session doesn't exist (caller should treat
   *  as "no context data available"). */
  subscribeContextUsage(id: string): AsyncIterable<unknown> | null {
    const s = this.sessions.get(id)
    return s?.contextUsagePushable.iterable ?? null
  }

  private broadcastPermissionRequest(session: Session, p: PendingPermission): void {
    const snapshot = toSnapshot(p)
    for (const sub of session.permissionSubscribers.values()) {
      sub.push({ kind: 'request', payload: snapshot })
    }
    // Also fan out to the global session channel so App-level code can
    // notify even when the Chat panel isn't mounted (e.g. the session
    // is dormant or open in a panel the user isn't looking at).
    this.broadcastGlobal({ kind: 'permission_request', sessionId: session.id, request: snapshot })
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
   * stream to clients, and (2) a snapshot of history so the caller can replay
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
          if (queue.length > SUBSCRIBER_QUEUE_CAP) {
            queue.splice(0, queue.length - SUBSCRIBER_QUEUE_CAP)
          }
        }
      },
      // Named-event channel (e.g. context_usage) isn't wired into this
      // iterable-based path yet — the routes layer will want to read
      // such events directly. Stubbed to satisfy the Subscriber type.
      pushEvent: () => {
        /* intentionally empty */
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

  /** Deny all still-pending tool-permission requests so no SDK awaiter
   *  stays hanging forever. Called from both unload() (explicit teardown)
   *  and the pump() finally block (Query ended or crashed). */
  private denyPendingPermissions(session: Session) {
    for (const [pid, p] of session.pending) {
      try {
        p.signal.removeEventListener('abort', p.abortHandler)
      } catch {
        /* ignore */
      }
      p.resolve({ behavior: 'deny', message: 'session closed', interrupt: false, toolUseID: p.toolUseID })
      this.broadcastPermissionResolved(session, pid, {
        behavior: 'deny',
        persisted: false,
        message: 'session closed',
      })
    }
    session.pending.clear()
  }

  /** Delete a session for good: close its Query AND erase its persistence
   *  entry. Use when the user explicitly clicks "delete" in the UI. */
  async delete(id: string): Promise<void> {
    await this.unload(id, { terminate: true })
    this.store?.remove(id)
    this.broadcastGlobal({ kind: 'removed', id })
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
    this.denyPendingPermissions(s)
    for (const sub of s.subscribers.values()) sub.end()
    s.subscribers.clear()
    for (const sub of s.permissionSubscribers.values()) sub.end()
    s.permissionSubscribers.clear()
    s.contextUsagePushable.end()
    // Let the pump exit on its own (the iterable is now drained). We don't
    // await it indefinitely — the SDK occasionally holds connections open.
    this.sessions.delete(id)
    invalidateRecapCache(id)
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

  /** Snapshot of the in-memory message history for a live session.
   *  Returns null for dormant (not-in-memory) sessions. */
  getHistory(id: string): SDKMessage[] | null {
    const s = this.sessions.get(id)
    return s ? s.history.slice() : null
  }

  async shutdown(): Promise<void> {
    if (this.gcTimer) clearInterval(this.gcTimer)
    // End all global subscribers so their iterators resolve and
    // don't hang waiting for events that will never arrive.
    for (const sub of this.globalSubscribers.values()) sub.end()
    this.globalSubscribers.clear()
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

  /** Like require(), but additionally insists the Query is still live.
   *  Use for any method that forwards a control request to the SDK — the
   *  subprocess's stdin is closed once `running` flips to false, so a
   *  subsequent `supportedModels` / `getContextUsage` / etc. would otherwise
   *  throw `ProcessTransport is not ready for writing` from deep in the
   *  SDK and end up as an unhandled error in the Hono router. */
  private requireLive(id: string): Session {
    const s = this.require(id)
    if (!s.running) {
      throw new HttpError(410, `session ${id} is not running`)
    }
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
      workingSince: s.running && s.pendingTurns > 0 ? s.workingSince : undefined,
      lastTurnAt: s.lastTurnAt,
      pinned: s.pinned,
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
      workingSince: undefined,
      lastTurnAt: meta.lastTurnAt,
      pinned: meta.pinned,
    }
  }

  private async pump(session: Session): Promise<void> {
    try {
      let msgCount = 0
      for await (const msg of session.query) {
        session.lastActivityAt = Date.now()
        session.history.push(msg)
        if (session.history.length > this.historyCap) {
          session.history.splice(0, session.history.length - this.historyCap)
        }
        for (const sub of session.subscribers.values()) sub.push(msg)
        // Fire a non-blocking context-usage fetch every 10 messages AND
        // on every `result` so the client always has a fresh snapshot at
        // turn boundaries (the count may not land on a multiple of 10).
        if (
          (++msgCount % 10 === 0 || msg.type === 'result') &&
          session.subscribers.size > 0
        ) {
          void session.query.getContextUsage().then(
            (usage) => session.contextUsagePushable.push(usage),
            () => { /* ignore — session may have ended between fire and resolve */ },
          )
        }
        // `result` marks a completed turn. Decrement the pending counter
        // and stamp lastTurnAt so the frontend can flag unread. Clamped
        // at 0 in case the SDK emits spurious results (shouldn't happen
        // but cheap insurance).
        if (msg.type === 'result') {
          session.pendingTurns = Math.max(0, session.pendingTurns - 1)
          if (session.pendingTurns === 0) session.workingSince = undefined
          session.lastTurnAt = Date.now()
          this.persist(session)
        }
      }
    } catch (err) {
      session.error = err instanceof Error ? err.message : String(err)
      // Log with full context — the message alone often omits the stack
      // frame that points at the real culprit (e.g. missing API key,
      // model name typo, CLI subprocess failed to spawn). Without this
      // the frontend just shows a generic "err" badge with no clue.
      console.error(`[session ${session.id}] pump error:`, err)
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
      // Wrap in its own try/catch so a failure in cleanup (e.g.
      // subscriber.push() throwing, persist() failing) doesn't escape
      // as an unhandledRejection from the pumpTask promise.
      try {
        session.running = false
        session.terminated = true
        // Reset pending turns so the UI doesn't stay stuck in "working"
        // when the SDK merged queued messages into fewer turns than were
        // sent, or the session ended before emitting a result for every
        // queued turn.
        session.pendingTurns = 0
        session.workingSince = undefined
        this.denyPendingPermissions(session)
        for (const sub of session.subscribers.values()) sub.end()
        session.subscribers.clear()
        session.contextUsagePushable.end()
        // Persist the terminal state so the UI shows the transcript as
        // "ended" after a reload, and resume() can refuse to re-spawn it.
        this.persist(session)
      } catch (cleanupErr) {
        console.error(`[session ${session.id}] pump cleanup error:`, cleanupErr)
      }
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
  if (p.kind === 'question') {
    return {
      kind: 'question',
      id: p.id,
      toolName: p.toolName,
      questions: p.questions,
      toolUseID: p.toolUseID,
      createdAt: p.createdAt,
    }
  }
  return {
    kind: 'permission',
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

/** Defensive parse of AskUserQuestion's `input.questions` array. Drops
 *  malformed entries rather than throwing — we'd rather forward a
 *  slimmed-down list than abort the tool call. */
function sanitizeQuestions(input: Record<string, unknown>): QuestionSpec[] {
  const raw = input?.questions
  if (!Array.isArray(raw)) return []
  const out: QuestionSpec[] = []
  for (const q of raw) {
    if (!q || typeof q !== 'object') continue
    const obj = q as Record<string, unknown>
    if (typeof obj.question !== 'string') continue
    if (!Array.isArray(obj.options)) continue
    const options: QuestionSpec['options'] = []
    for (const opt of obj.options) {
      if (!opt || typeof opt !== 'object') continue
      const o = opt as Record<string, unknown>
      if (typeof o.label !== 'string') continue
      options.push({
        label: o.label,
        description: typeof o.description === 'string' ? o.description : undefined,
        preview: typeof o.preview === 'string' ? o.preview : undefined,
      })
    }
    if (options.length === 0) continue
    out.push({
      question: obj.question,
      header: typeof obj.header === 'string' ? obj.header : undefined,
      multiSelect: obj.multiSelect === true,
      options,
    })
  }
  return out
}

/** Build the tool_result payload the model will see. We use JSON because
 *  it's unambiguous and the model parses it reliably; plain text also
 *  works but is ambiguous when answers contain commas or colons.
 *
 *  Null entries in `answers` mean the user skipped that question — we
 *  encode that as `answer: null` with a note, so the model can decide
 *  how to proceed (often: continue with a default).
 */
function formatQuestionAnswers(questions: QuestionSpec[], answers: QuestionAnswer[]): string {
  const payload = {
    note: 'User answers from AskUserQuestion (single-select is a string, multi-select is an array, null means skipped).',
    answers: questions.map((q, i) => ({
      question: q.question,
      answer: answers[i] ?? null,
    })),
  }
  return JSON.stringify(payload)
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
