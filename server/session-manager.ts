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
  type SDKMessage,
  type SDKUserMessage,
  type Settings,
} from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import { createPushable } from './pushable.js'
import type { SessionMeta, SessionStore } from './persistence.js'
import type { McpConfigStore } from './mcp-config.js'
import { invalidateRecapCache } from './recap.js'
import { config as defaultConfig } from './config.js'
import { createAsyncSubscription } from './async-subscription.js'
import { pump as pumpSession } from './session-pump.js'
import {
  type Subscriber,
  type PermissionEvent,
  type PermissionSubscriber,
  type PermissionRequestSnapshot,
  type PermissionDecisionSummary,
  type QuestionAnswer,
  type PendingPermission,
  type SessionInfo,
  type Session,
  type SessionManagerOptions,
  type GlobalSessionEvent,
  type GlobalSubscriber,
  HttpError,
} from './session-types.js'
import { toSnapshot, sanitizeQuestions, formatQuestionAnswers, promoteToSession } from './permission-helpers.js'

// Re-export all types so existing importers (ws-protocol.ts, routes.ts, etc.) continue to work.
export {
  type PermissionEvent,
  type QuestionSpec,
  type PermissionRequestSnapshot,
  type PermissionDecisionSummary,
  type QuestionAnswer,
  type SessionInfo,
  type SessionManagerOptions,
  type GlobalSessionEvent,
  HttpError,
} from './session-types.js'

/** How long after firing an auto-interrupt we give the SDK subprocess to
 *  respond before either (a) skipping the next GC tick or (b) escalating
 *  to a force-unload. Sized to be longer than typical interrupt round-trip
 *  but short enough that escalation kicks in within a couple of GC ticks. */
const AUTO_INTERRUPT_DEDUP_MS = 2 * 60 * 1000

export class SessionManager {
  private sessions = new Map<string, Session>()
  private idleMs: number
  private historyCap: number
  private permissionTimeoutMs: number
  private workingStuckMs: number
  private gcTimer?: NodeJS.Timeout
  private store?: SessionStore
  private mcpStore?: McpConfigStore
  private claudeBinary?: string
  private globalSubscribers = new Map<string, GlobalSubscriber>()

  constructor(opts: SessionManagerOptions = {}) {
    this.idleMs = opts.idleMs ?? defaultConfig.sessionIdleMs
    this.claudeBinary = opts.claudeBinary
    this.historyCap = opts.historyCap ?? defaultConfig.historyCap
    this.permissionTimeoutMs = opts.permissionTimeoutMs ?? defaultConfig.permissionTimeoutMs
    this.workingStuckMs = opts.workingStuckMs ?? defaultConfig.workingStuckMs
    this.store = opts.store
    this.mcpStore = opts.mcpConfigStore
    this.gcTimer = setInterval(() => this.gc(), 60_000)
    // Don't keep the Node process alive just for GC
    this.gcTimer.unref?.()
    console.log(`[session-manager] initialized — idleMs=${this.idleMs}, permissionTimeoutMs=${this.permissionTimeoutMs}, workingStuckMs=${this.workingStuckMs}`)
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
    const sub = createAsyncSubscription<GlobalSessionEvent>(() => {
      this.globalSubscribers.delete(subId)
    })
    const globalSub: GlobalSubscriber = { id: subId, push: sub.push, end: sub.end }
    this.globalSubscribers.set(subId, globalSub)

    return {
      iterable: sub.iterable,
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
    const input = createPushable<SDKUserMessage>(`input-${id.slice(0, 8)}`)
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

    // Inject auth from config.json into the SDK subprocess. The SDK
    // defaults `Options.env` to `process.env`; by passing an explicit
    // object we sever that implicit dependency and make config.json the
    // single source of truth for API credentials.
    if (!fullOpts.env) {
      fullOpts.env = {
        ...process.env,
        ANTHROPIC_AUTH_TOKEN: defaultConfig.authToken,
        ANTHROPIC_BASE_URL: defaultConfig.baseUrl,
        // Strip the legacy x-api-key variable — we standardised on Bearer.
        ANTHROPIC_API_KEY: undefined,
      }
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
          console.log(`[session ${session.id}] AskUserQuestion permission request ${pid} — ${questions.length} question(s)`)
          const abortHandler = () => {
            if (!session.pending.has(pid)) return
            session.pending.delete(pid)
            console.log(`[session ${session.id}] permission ${pid} aborted (interrupt)`)
            resolve({ behavior: 'deny', message: 'aborted', interrupt: false, toolUseID: ctx.toolUseID })
            this.broadcastPermissionResolved(session, pid, {
              behavior: 'deny',
              persisted: false,
              message: 'aborted',
            })
          }
          const timeoutTimer = this.permissionTimeoutMs > 0
            ? setTimeout(() => {
                if (!session.pending.has(pid)) return
                session.pending.delete(pid)
                try { ctx.signal.removeEventListener('abort', abortHandler) } catch { /* */ }
                console.warn(`[session ${session.id}] permission ${pid} timed out after ${this.permissionTimeoutMs}ms — auto-denying`)
                resolve({ behavior: 'deny', message: 'Permission request timed out — no user response.', interrupt: false, toolUseID: ctx.toolUseID })
                this.broadcastPermissionResolved(session, pid, {
                  behavior: 'deny',
                  persisted: false,
                  message: 'Permission request timed out.',
                })
              }, this.permissionTimeoutMs)
            : null
          const wrappedResolve = (result: PermissionResult) => {
            if (timeoutTimer) clearTimeout(timeoutTimer)
            resolve(result)
          }
          const pending: PendingPermission = {
            kind: 'question',
            id: pid,
            toolName: 'AskUserQuestion',
            questions,
            toolUseID: ctx.toolUseID,
            createdAt: Date.now(),
            resolve: wrappedResolve,
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
        console.log(`[session ${session.id}] tool permission request ${pid} — ${toolName}`)
        const abortHandler = () => {
          if (!session.pending.has(pid)) return
          session.pending.delete(pid)
          console.log(`[session ${session.id}] permission ${pid} aborted (interrupt)`)
          // Aborted means the enclosing turn was interrupted — return a deny
          // that does NOT cascade (interrupt: false), SDK will unwind anyway.
          resolve({ behavior: 'deny', message: 'aborted', interrupt: false, toolUseID: ctx.toolUseID })
          this.broadcastPermissionResolved(session, pid, {
            behavior: 'deny',
            persisted: false,
            message: 'aborted',
          })
        }
        const timeoutTimer = this.permissionTimeoutMs > 0
          ? setTimeout(() => {
              if (!session.pending.has(pid)) return
              session.pending.delete(pid)
              try { ctx.signal.removeEventListener('abort', abortHandler) } catch { /* */ }
              console.warn(`[session ${session.id}] permission ${pid} (${toolName}) timed out after ${this.permissionTimeoutMs}ms — auto-denying`)
              resolve({ behavior: 'deny', message: 'Permission request timed out — no user response.', interrupt: false, toolUseID: ctx.toolUseID })
              this.broadcastPermissionResolved(session, pid, {
                behavior: 'deny',
                persisted: false,
                message: 'Permission request timed out.',
              })
            }, this.permissionTimeoutMs)
          : null
        const wrappedResolve = (result: PermissionResult) => {
          if (timeoutTimer) clearTimeout(timeoutTimer)
          resolve(result)
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
          resolve: wrappedResolve,
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
      input,
      query: q,
      subscribers: new Map(),
      permissionSubscribers: new Map(),
      pending: new Map(),
      history: [],
      contextUsagePushable: createPushable<unknown>(`ctx-${id.slice(0, 8)}`),
      abortController: new AbortController(),
      pumpTask: Promise.resolve(),
      running: true,
      terminated: false,
      pendingTurns: 0,
    }

    session.pumpTask = this.pump(session)
    this.sessions.set(id, session)
    console.log(`[session ${id}] spawned — model=${fullOpts.model ?? 'default'}, permissionMode=${requestedMode ?? 'default'}, resume=${!!fullOpts.resume}`)
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
      console.warn(`[session ${id}] send rejected — session is terminated`)
      throw new HttpError(410, `session ${id} is terminated`)
    }
    if (!s.running) {
      console.warn(`[session ${id}] send rejected — session is not running`)
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
    const pushableClosed = s.input.closed
    console.log(
      `[session ${id}] send PRE-PUSH — ${text.length} chars, uuid=${userMsg.uuid}, ` +
      `pendingTurns=${s.pendingTurns}, input.closed=${pushableClosed}, ` +
      `input.hasWaiter=${s.input.hasWaiter}, input.queueDepth=${s.input.queueDepth}, ` +
      `running=${s.running}, terminated=${s.terminated}`,
    )
    s.input.push(userMsg)
    console.log(
      `[session ${id}] send POST-PUSH — pushable.closed=${s.input.closed}, ` +
      `hasWaiter=${s.input.hasWaiter}, queueDepth=${s.input.queueDepth}`,
    )
    // 2. Also broadcast + record locally — the SDK's output stream doesn't
    //    echo user messages back, so without this step the client would
    //    never see its own sent text.
    s.history.push(userMsg)
    if (s.history.length > this.historyCap) {
      s.history.splice(0, s.history.length - this.historyCap)
    }
    for (const sub of s.subscribers.values()) sub.push(userMsg)
    s.lastActivityAt = Date.now()
    // Mark the session as mid-turn. We cap at 1 (not a true counter)
    // because the SDK may merge multiple queued user messages into fewer
    // assistant turns — a true count would inflate permanently. The pump
    // resets to 1 after each result if more items are still queued.
    if (s.pendingTurns === 0) s.workingSince = Date.now()
    if (s.pendingTurns < 1) s.pendingTurns = 1
    // Invalidate the recap cache — a new message means the cached
    // summary is stale.
    invalidateRecapCache(s.id)
    this.persist(s)
  }

  /** Interrupt the current assistant turn. */
  async interrupt(id: string): Promise<void> {
    const s = this.requireLive(id)
    const startedAt = Date.now()
    console.log(
      `[session ${id}] interrupt requested — pendingTurns=${s.pendingTurns}, ` +
      `pending perms=${s.pending.size}, ` +
      `workingFor=${s.workingSince ? Date.now() - s.workingSince : 0}ms`,
    )
    try {
      await s.query.interrupt()
      console.log(`[session ${id}] interrupt() resolved in ${Date.now() - startedAt}ms`)
    } catch (err) {
      console.error(`[session ${id}] interrupt() threw after ${Date.now() - startedAt}ms:`, err)
      throw err
    }
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

  /** Shared mutator for pure-metadata changes (rename). Works on both
   *  live and dormant sessions — the UI treats the two the same, and
   *  the transform needs to land in both in-memory state and persisted
   *  meta regardless. */
  private mutateMeta(
    id: string,
    transform: (draft: {
      cwd?: string
      model?: string
      permissionMode?: PermissionMode
      title?: string
    }) => {
      cwd?: string
      model?: string
      permissionMode?: PermissionMode
      title?: string
    },
  ): SessionInfo {
    const live = this.sessions.get(id)
    if (live) {
      const draft = transform({
        cwd: live.cwd,
        model: live.model,
        permissionMode: live.permissionMode,
        title: live.title,
      })
      live.title = draft.title
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
    })
    const nextMeta: SessionMeta = {
      ...meta,
      title: draft.title,
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

  /** Add/remove MCP servers on a live session via the SDK's setMcpServers API. */
  async setMcpServers(id: string, servers: Record<string, unknown>) {
    const s = this.requireLive(id)
    return s.query.setMcpServers(servers as Parameters<typeof s.query.setMcpServers>[0])
  }

  /** Merge global MCP configs with session-specific overrides.
   *  enabledGlobal: names of global servers the user selected.
   *  sessionMcp: session-specific overrides (win on name collision).
   *  Returns undefined if the merged result is empty. */
  mergeMcpServers(
    enabledGlobal?: string[],
    sessionMcp?: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    const global = this.mcpStore?.toSdkConfig() ?? {}
    const result: Record<string, unknown> = {}

    // Add enabled global servers
    if (enabledGlobal) {
      for (const name of enabledGlobal) {
        if (global[name]) result[name] = global[name]
      }
    }

    // Session overrides replace or add
    if (sessionMcp) {
      Object.assign(result, sessionMcp)
    }

    return Object.keys(result).length > 0 ? result : undefined
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
    console.log(`[session ${sid}] decide ${pid} — ${decision.behavior} (${p.toolName})`)
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
    const sub = createAsyncSubscription<PermissionEvent>(() => {
      s.permissionSubscribers.delete(subId)
    })
    const permSub: PermissionSubscriber = { id: subId, push: sub.push, end: sub.end }
    s.permissionSubscribers.set(subId, permSub)

    return {
      iterable: sub.iterable,
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
    const sub = createAsyncSubscription<SDKMessage>(() => {
      s.subscribers.delete(subId)
    })
    const sdkSub: Subscriber = {
      id: subId,
      push: sub.push,
      // Named-event channel (e.g. context_usage) isn't wired into this
      // iterable-based path yet — the routes layer will want to read
      // such events directly. Stubbed to satisfy the Subscriber type.
      pushEvent: () => { /* intentionally empty */ },
      end: sub.end,
      get closed() { return sub.closed },
    }
    s.subscribers.set(subId, sdkSub)

    return {
      iterable: sub.iterable,
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
      try {
        p.resolve({ behavior: 'deny', message: 'session closed', interrupt: false, toolUseID: p.toolUseID })
        this.broadcastPermissionResolved(session, pid, {
          behavior: 'deny',
          persisted: false,
          message: 'session closed',
        })
      } catch (err) {
        console.error(`[session ${session.id}] failed to deny permission ${pid}:`, err)
      }
    }
    session.pending.clear()
  }

  /** Delete a session for good: close its Query AND erase its persistence
   *  entry. Use when the user explicitly clicks "delete" in the UI. */
  async delete(id: string): Promise<void> {
    await this.unload(id, { terminate: true })
    this.store?.remove(id)
    // Drop any cached recap — otherwise a new session that happens to
    // reuse this id (rare, but possible under --state-dir swaps) would
    // see the old summary.
    invalidateRecapCache(id)
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
    // Signal the pump to stop waiting on iter.next(). Without this,
    // a wedged SDK generator keeps the pump's 60s idle watchdog firing
    // indefinitely even after the session has been removed.
    s.abortController.abort()
    s.input.end()
    // When terminating (explicit delete or graceful shutdown), await the
    // pump so the SDK subprocess has time to exit cleanly. On idle GC we
    // skip the await — the pump will finish on its own and the session
    // map entry is removed immediately to free memory.
    if (opts.terminate) {
      try {
        await Promise.race([
          s.pumpTask,
          new Promise<void>((r) => setTimeout(r, 1000)),
        ])
      } catch { /* pump swallows errors internally */ }
    }
    this.denyPendingPermissions(s)
    for (const sub of s.subscribers.values()) sub.end()
    s.subscribers.clear()
    for (const sub of s.permissionSubscribers.values()) sub.end()
    s.permissionSubscribers.clear()
    s.contextUsagePushable.end()
    // Broadcast the running=false / terminated state BEFORE removing
    // from the map. Without this, the client's copy stays stale at
    // `running: true` — handleSelect then skips resume, and the user
    // hits a 409 on their next send. The session is still in the live
    // map at this point so info(s) works correctly.
    if (!opts.terminate) {
      this.broadcastGlobal({ kind: 'update', session: this.info(s) })
    }
    this.sessions.delete(id)
    invalidateRecapCache(id)
    this.writeStore(s)
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
    // Collect pump tasks before unload removes sessions from the map.
    const pumpTasks = ids
      .map((id) => this.sessions.get(id)?.pumpTask)
      .filter(Boolean) as Promise<void>[]
    // Unload without terminating: the user may have exited cleanly and
    // will want to resume on next launch. Only Query-ended sessions stay
    // terminated (that flag was already set by the pump's finally block).
    await Promise.all(ids.map((id) => this.unload(id)))
    // Await remaining pump tasks so SDK subprocesses exit cleanly.
    // unload() without terminate doesn't await the pump (GC speed), but
    // on shutdown we want a clean exit — give each pump up to 5 s.
    if (pumpTasks.length > 0) {
      await Promise.race([
        Promise.allSettled(pumpTasks),
        new Promise((r) => setTimeout(r, 5000)),
      ])
    }
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
    }
  }

  private async pump(session: Session): Promise<void> {
    return pumpSession(session, {
      historyCap: this.historyCap,
      persist: (s) => this.persist(s),
      denyPendingPermissions: (s) => this.denyPendingPermissions(s),
      isLive: (id) => this.sessions.has(id),
    })
  }

  /** Idle GC: drop in-memory Query for sessions nobody is watching and
   *  whose last activity is older than idleMs. Metadata stays on disk so
   *  the session can be resumed later. Terminated sessions are also
   *  evicted from memory the same way. */
  private gc() {
    const now = Date.now()
    // Collect IDs first, then unload in a separate pass. unload()
    // deletes from `this.sessions` synchronously (no await hit on the
    // idle-GC path), which would mutate the Map during for...of
    // iteration — the ECMAScript spec says iteration results are
    // undefined when entries are deleted mid-iteration.
    const toUnload: string[] = []
    for (const [id, s] of this.sessions) {
      if (now - s.lastActivityAt > this.idleMs && s.subscribers.size === 0) {
        toUnload.push(id)
      }
      this.checkStuck(id, s, now)
    }
    for (const id of toUnload) void this.unload(id)
  }

  /** Detect sessions that have made no progress for too long and try to
   *  shake them loose. Three flavours:
   *
   *  1. Mid-turn silence: pump received SOME messages but none recently.
   *     Measured by `lastActivityAt` — moves on every SDK message of any
   *     type (assistant, stream_event, task_progress, etc), so a session
   *     legitimately producing a long stream of progress events resets
   *     the clock and is never falsely classified as stuck. Only sessions
   *     that have actually gone silent get caught.
   *
   *  2. Init silence: session was spawned but NO messages have arrived
   *     yet. Common with proxy backends whose init handshake hangs. We
   *     can't interrupt() these usefully (the SDK subprocess hasn't
   *     wired up control yet), so we force-unload instead.
   *
   *  3. Already-interrupted: don't re-fire auto-interrupt every 60s.
   *     Once we've kicked a session, give it AUTO_INTERRUPT_DEDUP_MS to
   *     respond before kicking again. After that escalate to unload. */
  private checkStuck(id: string, s: Session, now: number): void {
    if (this.workingStuckMs <= 0) return
    if (!s.running || s.terminated) return

    const idleSince = now - s.lastActivityAt
    if (idleSince <= this.workingStuckMs) return

    // Init never landed: no point sending interrupt control frames into a
    // half-spawned subprocess. Schedule unload directly.
    if (s.history.length === 0) {
      console.warn(
        `[session ${id}] init never completed — no messages after ${idleSince}ms ` +
        `(pendingTurns=${s.pendingTurns}, subscribers=${s.subscribers.size}). Force-unloading.`,
      )
      void this.unload(id, { terminate: true })
      return
    }

    // Mid-turn but truly stuck (lastActivityAt is older than threshold).
    // De-dup repeated kicks: if we already fired an interrupt recently,
    // wait it out before deciding what to do next.
    if (s.autoInterruptedAt && now - s.autoInterruptedAt < AUTO_INTERRUPT_DEDUP_MS) {
      return
    }

    // If we ALREADY tried interrupt once and it didn't break the silence
    // (autoInterruptedAt was set, dedup window has now passed, AND we're
    // still stuck), the SDK subprocess is wedged. Escalate to unload.
    if (s.autoInterruptedAt) {
      console.error(
        `[session ${id}] still silent ${now - s.autoInterruptedAt}ms after auto-interrupt — escalating to unload`,
      )
      void this.unload(id, { terminate: true })
      return
    }

    const startedAt = Date.now()
    console.warn(
      `[session ${id}] no SDK message for ${idleSince}ms — auto-interrupting ` +
      `(pendingTurns=${s.pendingTurns}, pending perms=${s.pending.size}, ` +
      `subscribers=${s.subscribers.size}, history=${s.history.length})`,
    )
    s.autoInterruptedAt = now
    s.query.interrupt().then(
      () => console.warn(`[session ${id}] auto-interrupt() resolved in ${Date.now() - startedAt}ms`),
      (err) => console.error(`[session ${id}] auto-interrupt() rejected after ${Date.now() - startedAt}ms:`, err),
    )
  }
}

