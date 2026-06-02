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
// Sessions are only removed when explicitly deleted by the user or when the
// stuck-session detector fires. A periodic tick checks for stuck sessions
// (mid-turn silence exceeding workingStuckMs).

import {
  query,
  getSessionInfo,
  type Options,
  type PermissionMode,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type Settings,
} from '@anthropic-ai/claude-agent-sdk'
import { ProcessMonitor, type ProcessExitInfo } from './process-monitor.js'
import { randomUUID } from 'node:crypto'
import { createPushable, type Pushable } from './pushable.js'
import type { SessionMeta, SessionStore } from './persistence.js'
import type { McpConfigStore } from './mcp-config.js'
import type { MpStore } from './mp-store.js'
import { RecapManager } from './recap.js'
import type { SessionPhase, SessionRecap } from './session-types.js'
import { tryCaptureGitHead, invalidateStatusCache } from './git.js'
import { cancelGitBroadcast } from './git-broadcast.js'
import { invalidateClaudeHealth } from './routes/health-routes.js'
import { config as defaultConfig } from './config.js'
import { createAsyncSubscription } from './async-subscription.js'
import { pump as pumpSession, type PumpDeps } from './session-pump.js'
import {
  type Subscriber,
  type PermissionEvent,
  type PermissionRequestSnapshot,
  type QuestionAnswer,
  type SessionInfo,
  type Session,
  type SessionManagerOptions,
  type GlobalSessionEvent,
  type GlobalSubscriber,
  endAllSubscribers,
} from './session-types.js'
import { HttpError } from './errors.js'
import { PermissionBroker } from './permission-broker.js'
import { debugLog } from './debug.js'
import { pushBounded, stampReceivedAt, stampConsumedAt } from './history-utils.js'
import { readHistoryPage, type HistoryPage } from './history-reader.js'

// Re-export types so existing importers continue to work.
export {
  type PermissionEvent,
  type QuestionSpec,
  type PermissionRequestSnapshot,
  type PermissionDecisionSummary,
  type QuestionAnswer,
  type SessionInfo,
  type SessionManagerOptions,
  type GlobalSessionEvent,
} from './session-types.js'
export { HttpError } from './errors.js'

/** How long after firing an auto-interrupt we give the SDK subprocess to
 *  respond before either (a) skipping the next GC tick or (b) escalating
 *  to a force-unload. Sized to be longer than typical interrupt round-trip
 *  but short enough that escalation kicks in within a couple of GC ticks. */
const AUTO_INTERRUPT_DEDUP_MS = 2 * 60 * 1000

export class SessionManager {
  private sessions = new Map<string, Session>()
  private historyCap: number
  private permissionTimeoutMs: number
  private workingStuckMs: number
  private autoResumeEnabled: boolean
  private gcTimer?: NodeJS.Timeout
  private store?: SessionStore
  private mcpStore?: McpConfigStore
  private mpStore?: MpStore
  private claudeBinary?: string
  private globalSubscribers = new Map<string, GlobalSubscriber>()
  private processMonitor: ProcessMonitor
  private spawnWrapper?: (opts: import('@anthropic-ai/claude-agent-sdk').SpawnOptions) => import('@anthropic-ai/claude-agent-sdk').SpawnedProcess
  private permBroker: PermissionBroker
  /** Owns recap lifecycle for every session. Public so the recap route
   *  can call requestGenerate() without going through a wrapper method —
   *  the route is the only HTTP surface for recap, and proxying through
   *  SessionManager would just re-export the same throw semantics. */
  recapManager: RecapManager
  /** Cached result of buildAnthropicEnv(). Invalidated when config.authToken
   *  or config.baseUrl change (detected lazily on each call). */
  private cachedEnv?: NodeJS.ProcessEnv
  /** Cached PumpDeps — all fields reference stable `this` members,
   *  so the object is built once and reused. */
  private cachedPumpDeps?: PumpDeps
  private cachedAuthToken?: string
  private cachedBaseUrl?: string

  constructor(opts: SessionManagerOptions = {}) {
    this.claudeBinary = opts.claudeBinary
    this.historyCap = opts.historyCap ?? defaultConfig.historyCap
    this.permissionTimeoutMs = opts.permissionTimeoutMs ?? defaultConfig.permissionTimeoutMs
    this.permBroker = new PermissionBroker({ permissionTimeoutMs: this.permissionTimeoutMs })
    this.workingStuckMs = opts.workingStuckMs ?? defaultConfig.workingStuckMs
    this.autoResumeEnabled = opts.autoResume ?? false
    this.store = opts.store
    this.mcpStore = opts.mcpConfigStore
    this.mpStore = opts.mpStore
    this.gcTimer = setInterval(() => this.gc(), 60_000)
    // Don't keep the Node process alive just for GC
    this.gcTimer.unref?.()

    // Process monitor — real-time CLI exit detection
    this.processMonitor = new ProcessMonitor((info) => this.handleProcessExit(info))
    this.spawnWrapper = this.processMonitor.createSpawnWrapper()

    // RecapManager — owns the lifecycle (pending → ready/error) for the
    // session.recap field. Hooks back into this manager via the deps
    // interface so the module never imports SessionManager directly.
    this.recapManager = new RecapManager({
      getPhase: (id) => {
        const s = this.sessions.get(id)
        if (!s) return 'unknown'
        return this.phaseOf(s)
      },
      getHistory: (id) => this.getHistory(id),
      setRecap: (id, recap) => {
        const s = this.sessions.get(id)
        if (!s) return
        s.recap = recap
      },
      broadcastRecap: (id, recap) => this.broadcastSessionRecap(id, recap),
    })

    console.log(
      `[session-manager] initialized — permissionTimeoutMs=${this.permissionTimeoutMs}, ` +
      `workingStuckMs=${this.workingStuckMs}`,
    )
  }

  /** Construct the env object with API credentials from config.json.
   *  Shared by spawn and autoResume. The result is cached and only
   *  rebuilt when the auth token or base URL change. */
  private buildAnthropicEnv(): NodeJS.ProcessEnv {
    if (
      this.cachedEnv &&
      this.cachedAuthToken === defaultConfig.authToken &&
      this.cachedBaseUrl === defaultConfig.baseUrl
    ) {
      return this.cachedEnv
    }
    this.cachedAuthToken = defaultConfig.authToken
    this.cachedBaseUrl = defaultConfig.baseUrl
    // Forward only the env vars the CLI subprocess actually needs instead of
    // spreading all of process.env (which leaks server-side variables and
    // creates an unnecessarily large allocation).
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME ?? process.env.USERPROFILE,
      USERPROFILE: process.env.USERPROFILE,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
      TERM: process.env.TERM,
      SHELL: process.env.SHELL,
      ComSpec: process.env.ComSpec,
      NODE_PATH: process.env.NODE_PATH,
      ANTHROPIC_AUTH_TOKEN: defaultConfig.authToken,
      ANTHROPIC_BASE_URL: defaultConfig.baseUrl,
      // Strip the legacy x-api-key variable — we standardised on Bearer.
      ANTHROPIC_API_KEY: undefined,
    }
    // Forward any additional ANTHROPIC_* env vars (except API_KEY which we
    // intentionally strip) so callers can pass feature flags, debug toggles, etc.
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ANTHROPIC_') && key !== 'ANTHROPIC_API_KEY' && !(key in env)) {
        env[key] = process.env[key]
      }
    }
    this.cachedEnv = env
    return this.cachedEnv
  }

  /** Handle a CLI process exit detected by ProcessMonitor.
   *  This fires in real-time (ms) rather than waiting for the 60s GC.
   *
   *  For clean exits (code=0, not killed), we only abort the controller
   *  so the pump breaks out of iter.next(). The pump's cleanupPump then
   *  decides whether to auto-resume or terminate. This avoids a race
   *  where handleProcessExit sets terminated=true before cleanupPump gets
   *  a chance to try auto-resume.
   *
   *  For unexpected exits (non-zero code or killed), we terminate
   *  immediately — no auto-resume attempt. */
  private handleProcessExit(info: ProcessExitInfo): void {
    const { sessionId, code, signal, killed, spawnError } = info
    const s = this.sessions.get(sessionId)
    if (!s) return // Session already cleaned up (e.g. by unload)
    if (s.terminated) return // Already terminated — no action needed

    const cleanExit = !killed && code === 0 && !spawnError

    if (cleanExit) {
      // Normal exit (e.g. idle timeout). Abort the controller so the
      // pump breaks out of iter.next(), but DON'T set terminated — let
      // cleanupPump handle auto-resume or termination.
      console.log(`[session ${sessionId}] CLI exited cleanly (code=0) — deferring to pump cleanup`)
      // Mark as exiting so the GC timer's checkStuck() skips this session
      // during the window between abort and cleanupPump finishing.
      s.exiting = true
      s.abortController.abort()
      return
    }

    // Determine reason / message. spawnError takes priority — it's a
    // structured failure from ProcessMonitor's 'error' event and carries
    // the actual errno (ENOENT for "binary missing", EACCES for
    // "not executable", etc.) which is much more actionable than the
    // generic "code=null, signal=null" we'd otherwise produce.
    let reason: 'process_killed' | 'process_exited' | 'spawn_failed'
    let errorMsg: string
    if (spawnError) {
      reason = 'spawn_failed'
      // Any spawn-time failure proves the cached health snapshot is no
      // longer trustworthy — the binary may have been moved, replaced,
      // chmod-ed, or the host may have hit an fd-table cap (EMFILE) or a
      // sandbox policy (EPERM). Drop the cache unconditionally so the
      // next /health/claude probe re-runs --version and reports the real
      // current state. The previous narrow ENOENT/EACCES-only path
      // silently kept "ok: true" cached after EMFILE / EPERM / ELOOP
      // failures.
      invalidateClaudeHealth()
      const enoent = spawnError.code === 'ENOENT'
      const eacces = spawnError.code === 'EACCES'
      if (enoent) {
        errorMsg =
          'claude CLI binary not found (ENOENT). Install it ' +
          '(npm i -g @anthropic-ai/claude-code) or set CLAUDE_CODE_BINARY ' +
          'to the path of an existing binary.'
      } else if (eacces) {
        errorMsg =
          `claude CLI binary is not executable (EACCES${spawnError.message ? `: ${spawnError.message}` : ''}). ` +
          'Check file permissions or set CLAUDE_CODE_BINARY to a different path.'
      } else {
        errorMsg = `claude CLI failed to start: ${spawnError.message || spawnError.code || 'unknown'}`
      }
    } else if (killed) {
      reason = 'process_killed'
      errorMsg = `CLI process was killed (signal=${signal})`
    } else {
      reason = 'process_exited'
      errorMsg = `CLI process exited unexpectedly (code=${code}, signal=${signal})`
    }

    console.error(`[session ${sessionId}] ${errorMsg}`)

    // Abort the pump so it breaks out of iter.next()
    s.abortController.abort()
    s.running = false
    s.terminated = true
    s.terminatedReason = reason
    s.error = errorMsg
    s.pendingTurns = 0
    s.workingSince = undefined

    // Deny all pending permissions so SDK awaiters don't hang
    this.permBroker.denyAll(s)

    // Broadcast synthetic error to subscribers
    const synthetic: SDKMessage = {
      type: 'system',
      subtype: 'error',
      error: errorMsg,
      uuid: randomUUID(),
      session_id: sessionId,
      receivedAt: Date.now(),
    } as unknown as SDKMessage
    for (const sub of s.subscribers.values()) sub.push(synthetic)
    endAllSubscribers(s)

    this.persist(s)
    this.broadcastGlobal({ kind: 'update', session: this.info(s) })
  }

  /** Write the current in-memory state of a session into the persistence
   *  store and broadcast an update to global subscribers. No-op when no
   *  store is configured. Debounced on the store side so calling this on
   *  every tiny state change is fine. */
  private persist(s: Session): void {
    // Guard against concurrent unload(): if the session was removed from
    // the map between the initial running check and here, persisting would
    // overwrite the terminal state written by unload(). Same guard pattern
    // used in pushToSession() and cleanupPump.
    if (!this.sessions.has(s.id)) return
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
      betas: s.betas,
      messageCount: s.history.length,
      terminated: s.terminated,
      terminatedReason: s.terminatedReason,
      error: s.error,
      lastTurnAt: s.lastTurnAt,
      gitStartSha: s.gitStartSha,
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
  private snapshotMeta(opts: Options): { cwd?: string; model?: string; permissionMode?: PermissionMode; title?: string; betas?: string[] } {
    return {
      cwd: opts.cwd,
      model: opts.model,
      permissionMode: opts.permissionMode,
      title: opts.title,
      // `betas` carries flags like `context-1m-...` that change the
      // model's context window. Must survive restart / resume / fork
      // or the user's 1M session silently downgrades to 200k.
      betas: Array.isArray(opts.betas) ? opts.betas : undefined,
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
  async resume(id: string): Promise<SessionInfo> {
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
    // Guard: the SDK only writes session data to disk after the first
    // `result` message.  If no turn was completed there is nothing to
    // resume — the SDK would fail with
    //   "No conversation found with session ID: <uuid>"
    // Mark the session as terminated so the client can clean it up.
    if (!meta.lastTurnAt) {
      meta.terminated = true
      meta.terminatedReason = 'no_data'
      this.store.upsert(meta)
      // Broadcast so the client removes / dims the session immediately
      // instead of letting the user click it again and again.
      this.broadcastGlobal({ kind: 'update', session: this.infoFromMeta(meta) })
      throw new HttpError(
        410,
        `session ${id} has no conversation data on disk — it cannot be resumed (the first turn never completed)`,
      )
    }
    // Same disk-vs-memory mismatch as fork(): the persisted meta says
    // the session is resumable, but if the SDK's jsonl was deleted out
    // of band the CLI subprocess will error with "No conversation found
    // with session ID: <uuid>" the moment we hand it `resume: id`.
    // Catch it here, mark terminated, and let the user clean up.
    if (!(await this.hasSdkTranscript(meta))) {
      this.markTranscriptMissing(meta, 'resume')
      throw new HttpError(
        410,
        `session ${id}'s SDK transcript file is missing on disk — it cannot be resumed. The session has been marked terminated; delete it from the sidebar.`,
      )
    }
    const resumeOpts: Options = {
      resume: id,
      cwd: meta.cwd,
      model: meta.model,
      permissionMode: meta.permissionMode,
      title: meta.title,
      // Carry beta flags forward — without this, a 1M-context session
      // silently downgrades to the model's default window on resume.
      // Cast: SDK types this as a literal-string union of known flags,
      // but we store the user-supplied list as plain `string[]` so a
      // newer flag the SDK type hasn't learned about yet still survives.
      betas: meta.betas as Options['betas'],
    }
    return this.spawn(id, resumeOpts)
  }

  /** Probe the SDK's on-disk transcript for a session.
   *
   *  `lastTurnAt` only proves *we once observed a `result` for this id in
   *  this process*. It does NOT prove the SDK's `~/.claude/projects/<dir>/
   *  <id>.jsonl` is still on disk — the user could have deleted the file,
   *  switched machines via a synced sessions.json, etc. Both `fork()` and
   *  `resume()` will hand the SDK a `resume: id` and watch the CLI
   *  subprocess error out with "No conversation found with session ID:
   *  <uuid>" the moment the file is missing.
   *
   *  `getSessionInfo({ dir })` reads exactly the file the CLI would, so
   *  this is the authoritative probe — no need to recreate the SDK's
   *  cwd-encoding ourselves. When `dir` is omitted the SDK scans every
   *  project directory, which matches the CLI's own resume-by-id
   *  fallback. Returns false on any error (file missing, permission
   *  denied, etc.) so callers can refuse the operation uniformly. */
  private async hasSdkTranscript(meta: { id: string; cwd?: string }): Promise<boolean> {
    const opts = meta.cwd ? { dir: meta.cwd } : undefined
    try {
      const info = await getSessionInfo(meta.id, opts)
      if (!info) {
        // Distinguish "file genuinely missing" (info===undefined) from
        // "SDK threw" (caught below). The former is the common case
        // (user/tool deleted the jsonl); the latter is interesting
        // because it means the SDK itself misbehaved and we want a
        // breadcrumb to chase it. Including cwd in both — the SDK
        // encodes the cwd into the on-disk path, so a wrong cwd is the
        // first thing to check next time.
        console.warn(
          `[session ${meta.id}] hasSdkTranscript: getSessionInfo returned undefined ` +
          `(cwd=${meta.cwd ?? '<none>'}) — jsonl is missing on disk`,
        )
      }
      return !!info
    } catch (err) {
      console.warn(
        `[session ${meta.id}] hasSdkTranscript: getSessionInfo threw ` +
        `(cwd=${meta.cwd ?? '<none>'}):`,
        err,
      )
      return false
    }
  }

  /** Mark a persisted session as terminated due to a missing SDK
   *  transcript and broadcast the update. Used by `fork()` and
   *  `resume()` when the on-disk jsonl has gone away under our feet.
   *  `caller` is "fork" or "resume" so post-mortem log greps can tell
   *  which path tripped. */
  private markTranscriptMissing(meta: SessionMeta, caller: 'fork' | 'resume'): void {
    console.warn(
      `[session ${meta.id}] marking terminated:transcript_missing via ${caller} ` +
      `(cwd=${meta.cwd ?? '<none>'}, lastTurnAt=${meta.lastTurnAt ?? 'none'}, ` +
      `messageCount=${meta.messageCount})`,
    )
    meta.terminated = true
    meta.terminatedReason = 'transcript_missing'
    this.store?.upsert(meta)
    this.broadcastGlobal({ kind: 'update', session: this.infoFromMeta(meta) })
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
  async fork(id: string): Promise<SessionInfo> {
    const live = this.sessions.get(id)
    const meta = live ?? this.store?.get(id)
    if (!meta) throw new HttpError(404, `session ${id} not found`)
    if (!meta.lastTurnAt) {
      throw new HttpError(
        400,
        `session ${id} has no completed turns yet — send at least one message and wait for the reply before forking`,
      )
    }
    // The lastTurnAt guard above only proves we once saw a `result` in
    // memory; it doesn't prove the SDK's transcript file is still on
    // disk. Without this probe a missing jsonl spawns a doomed Query
    // whose CLI subprocess errors with "No conversation found with
    // session ID: <uuid>" — confusing for the user (the fork panel
    // opens, then crashes a beat later). Mark the source terminated so
    // the sidebar dims it and the user can clear it out.
    if (!(await this.hasSdkTranscript(meta))) {
      // Mark the persisted meta so reloads / sidebar refreshes show the
      // session as terminated. We don't unload a live source here: the
      // user might still want to scroll its in-memory history one more
      // time, and the next resume attempt will re-trip this same guard.
      const persisted: SessionMeta = this.store?.get(id) ?? {
        id: meta.id,
        createdAt: meta.createdAt,
        lastActivityAt: meta.lastActivityAt,
        cwd: meta.cwd,
        model: meta.model,
        permissionMode: meta.permissionMode,
        title: meta.title,
        betas: meta.betas,
        // SessionMeta tracks messageCount; the live Session tracks
        // history. Use whichever applies. (`meta` is one or the other.)
        messageCount: live ? live.history.length : (meta as SessionMeta).messageCount,
        terminated: true,
        terminatedReason: 'transcript_missing',
        lastTurnAt: meta.lastTurnAt,
        gitStartSha: meta.gitStartSha,
      }
      this.markTranscriptMissing(persisted, 'fork')
      throw new HttpError(
        410,
        `session ${id}'s SDK transcript file is missing on disk — it cannot be forked. The session has been marked terminated; delete it from the sidebar.`,
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
      // Same as resume: preserve `context-1m-...` etc. so the fork has
      // the same effective window as the source. See resume() for the cast rationale.
      betas: meta.betas as Options['betas'],
    }
    return this.spawn(randomUUID(), forkOpts)
  }

  /** Shared spawn path for create() and resume(). */
  private spawn(id: string, opts: Options): SessionInfo {
    // The consume hook looks the session up by id at call time rather than
    // closing over the `session` object — `session` is built a few lines
    // below, after the input pushable, so it isn't in scope here. By the
    // time the SDK actually reads a turn the session is long-since in the
    // map, so the lookup always resolves.
    const input = createPushable<SDKUserMessage>(
      `input-${id.slice(0, 8)}`,
      undefined,
      (msg) => this.onInputConsumed(id, msg),
    )
    const fullOpts: Options = { ...opts }
    // Remember the user-requested permission mode before we strip it
    // from the SDK options. The session's own state ends up holding it.
    const requestedMode = opts.permissionMode
    this.applyStandardQueryOpts(fullOpts)

    // Don't forward permissionMode to the SDK. We enforce it ourselves via
    // canUseTool, and the SDK's built-in flag would just add a brittle
    // "can't transition into bypassPermissions" constraint on top.
    fullOpts.permissionMode = undefined

    // Create the AbortController BEFORE query() so we can pass it to the
    // SDK. This ensures the same AbortSignal flows through to
    // spawnClaudeCodeProcess, allowing ProcessMonitor to correlate
    // spawned processes back to sessions via signal identity.
    const abortController = new AbortController()
    fullOpts.abortController = abortController

    // Inject the process monitor's spawn wrapper so we get real-time
    // exit/error notifications for this session's CLI subprocess.
    fullOpts.spawnClaudeCodeProcess = this.spawnWrapper

    // Register the signal with ProcessMonitor before query() — the
    // spawn wrapper needs the signal in its map when it fires.
    this.processMonitor.register(abortController.signal, id)

    // When resuming we keep the original createdAt from the persisted meta
    // so the UI's "session age" doesn't reset each time the user clicks
    // "resume". New sessions start from now().
    const existingMeta = this.store?.get(id)
    const createdAt = existingMeta?.createdAt ?? Date.now()

    // Build the session shell BEFORE query() so canUseTool can capture a
    // valid reference. `query` is filled in below, after the SDK call.
    // Order matters: the SDK reads options.canUseTool synchronously from
    // the options object passed to query(), so fullOpts.canUseTool MUST
    // be set before that call. Setting it afterwards is silently ignored
    // and the SDK never invokes our permission gate (manifested as the
    // permission dialog never appearing in the UI).
    const session: Session = {
      id,
      createdAt,
      lastActivityAt: Date.now(),
      ...this.snapshotMeta(fullOpts),
      // Restore the user-requested mode we stashed before clearing the
      // SDK-side flag. fullOpts.permissionMode was set to undefined so the
      // spread above would leave it unset otherwise.
      permissionMode: requestedMode,
      input,
      // Placeholder; assigned right after the query() call below.
      query: undefined as unknown as Query,
      subscribers: new Map(),
      permissionSubscribers: new Map(),
      pending: new Map(),
      history: [],
      contextUsageSubscribers: new Set(),
      gitStatusSubscribers: new Set(),
      messageStatusSubscribers: new Set(),
      recapSubscribers: new Set(),
      abortController,
      pumpTask: Promise.resolve(),
      running: true,
      terminated: false,
      pendingTurns: 0,
      // Preserve gitStartSha across resumes — the persisted meta carries
      // it forward so the "This session" anchor stays stable even if the
      // server restarts. New sessions get a fresh capture below.
      gitStartSha: existingMeta?.gitStartSha,
    }

    // Register canUseTool on fullOpts BEFORE query(). See note on
    // session.query above for why ordering matters.
    if (!fullOpts.canUseTool) {
      const canUseTool = this.permBroker.buildCanUseTool(
        session,
        (s, snapshot) => {
          // Global broadcast — for desktop notifications on dormant sessions
          this.broadcastGlobal({ kind: 'permission_request', sessionId: s.id, request: snapshot })
        },
        // Pending count changed (enqueue / timeout / abort). Rebroadcast
        // the SessionInfo so the sidebar's pendingPermissionCount badge
        // updates. Skip if the session was unloaded mid-flight — info(s)
        // would still work but the broadcast would race the `removed`.
        (s) => {
          if (!this.sessions.has(s.id)) return
          this.broadcastGlobal({ kind: 'update', session: this.info(s) })
        },
      )
      session.canUseTool = canUseTool
      fullOpts.canUseTool = canUseTool
    }

    // Create the Query — spawns the claude CLI subprocess.
    const q = query({ prompt: input.iterable, options: fullOpts })
    session.query = q

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
    // Fire-and-forget HEAD capture for new sessions. We don't block spawn
    // on this — even on a slow filesystem the rev-parse takes ms — but
    // running it inside spawn() would force the whole call chain to be
    // async, which ripples out to the route handler signature. Fire it
    // off and persist the resulting SHA on completion. Failure modes
    // (no git, not a repo) leave gitStartSha undefined and the UI hides
    // the "This session" section gracefully.
    if (!session.gitStartSha && session.cwd) {
      void tryCaptureGitHead(session.cwd).then((sha) => {
        // Skip if the session was unloaded between spawn and capture.
        if (!sha || session.terminated || !this.sessions.has(id)) return
        session.gitStartSha = sha
        this.writeStore(session)
        this.broadcastGlobal({ kind: 'update', session: this.info(session) })
      })
    }
    return this.info(session)
  }

  /** Send a user turn into an existing session. */
  send(id: string, text: string): void {
    const s = this.requireRunnable(id)
    const userMsg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      uuid: randomUUID(),
      session_id: s.id,
    }
    debugLog(
      `[session ${id}] send PRE-PUSH — ${text.length} chars, uuid=${userMsg.uuid}, ` +
      `pendingTurns=${s.pendingTurns}, input.closed=${s.input.closed}, ` +
      `input.hasWaiter=${s.input.hasWaiter}, input.queueDepth=${s.input.queueDepth}, ` +
      `running=${s.running}, terminated=${s.terminated}`,
    )
    this.dispatchUserMessage(s, userMsg)
  }

  /** Send a user turn with a content array (text + image blocks). */
  sendContent(id: string, content: Array<{ type: string; [k: string]: unknown }>): void {
    const s = this.requireRunnable(id)
    const userMsg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content } as unknown as SDKUserMessage['message'],
      parent_tool_use_id: null,
      uuid: randomUUID(),
      session_id: s.id,
    }
    const blockSummary = content.map((b) => b.type).join('+')
    debugLog(
      `[session ${id}] sendContent PRE-PUSH — blocks=[${blockSummary}], uuid=${userMsg.uuid}, ` +
      `pendingTurns=${s.pendingTurns}, input.closed=${s.input.closed}`,
    )
    this.dispatchUserMessage(s, userMsg)
  }

  /** Shared tail for send() and sendContent(): push into the SDK input
   *  queue and broadcast to live subscribers. */
  private dispatchUserMessage(s: Session, userMsg: SDKUserMessage): void {
    s.input.push(userMsg)
    this.pushToSession(s, userMsg)
  }

  /** Common bookkeeping after pushing a user message into a session:
   *  record in history, cap the ring buffer, broadcast to subscribers,
   *  update timestamps, reset auto-resume counter, and persist. */
  private pushToSession(s: Session, userMsg: SDKUserMessage): void {
    // Broadcast + record locally — the SDK's output stream doesn't echo
    // user messages back, so without this step the client would never
    // see its own sent text.
    stampReceivedAt(userMsg)
    pushBounded(s.history, userMsg, this.historyCap)
    for (const sub of s.subscribers.values()) sub.push(userMsg)
    s.lastActivityAt = Date.now()
    // Mark the session as mid-turn. We cap at 1 (not a true counter)
    // because the SDK may merge multiple queued user messages into fewer
    // assistant turns — a true count would inflate permanently. The pump
    // resets to 1 after each result if more items are still queued.
    if (s.pendingTurns === 0) s.workingSince = Date.now()
    if (s.pendingTurns < 1) s.pendingTurns = 1
    // User is actively interacting — reset the auto-resume counter so a
    // future idle timeout gets fresh attempts.
    this.autoResumeCounts.delete(s)
    // Invalidate the stored recap — a new message means it's stale.
    // The next idle window triggers a fresh generation.
    this.recapManager.invalidate(s.id)
    // Guard against concurrent unload(): if the session was removed from
    // the map between the initial running check and here, persisting would
    // overwrite the terminal state written by unload().
    if (this.sessions.has(s.id) && s.running) this.persist(s)
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
    const live = this.sessions.get(id)
    if (live) {
      live.title = trimmed
      live.lastActivityAt = Date.now()
      this.persist(live)
      return this.info(live)
    }
    if (!this.store) throw new HttpError(404, `session ${id} not found`)
    const meta = this.store.get(id)
    if (!meta) throw new HttpError(404, `session ${id} not found`)
    const nextMeta: SessionMeta = { ...meta, title: trimmed, lastActivityAt: Date.now() }
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

  async togglePlugin(id: string, pluginName: string, enabled: boolean): Promise<SessionInfo> {
    const s = this.requireLive(id)
    await s.query.applyFlagSettings({ enabledPlugins: { [pluginName]: enabled } })
    s.lastActivityAt = Date.now()
    this.persist(s)
    return this.info(s)
  }

  /** Run a delegated SDK control request and log how long it took.
   *
   *  These methods (supportedModels/Commands/Agents, mcpServerStatus,
   *  getContextUsage) all forward to the CLI subprocess over the in-band
   *  control channel. supportedModels/Commands/Agents await the one-time
   *  init handshake; the others await a fresh control_response. On proxy
   *  backends the init handshake can stall, and a busy/wedged subprocess
   *  can delay control_response — either way the call (and the HTTP
   *  request behind it) hangs with no SDK-side timeout. We don't time it
   *  out here (callers/UI handle that), but we DO measure every call so a
   *  slow init window or wedged subprocess is visible in the logs and can
   *  be correlated with a recent spawn / auto-resume. */
  private async timeSdkControl<T>(id: string, label: string, fn: () => Promise<T>): Promise<T> {
    const startedAt = Date.now()
    try {
      const result = await fn()
      const ms = Date.now() - startedAt
      // Only the slow ones are interesting — a healthy control round-trip
      // is single-digit ms. Warn above 1s so the noise floor stays low.
      if (ms >= 1000) {
        console.warn(`[session ${id}] SDK ${label} resolved in ${ms}ms (slow — check init handshake / subprocess)`)
      } else {
        debugLog(`[session ${id}] SDK ${label} resolved in ${ms}ms`)
      }
      return result
    } catch (err) {
      console.error(`[session ${id}] SDK ${label} rejected after ${Date.now() - startedAt}ms:`, err)
      throw err
    }
  }

  async supportedModels(id: string) {
    const s = this.requireLive(id)
    return this.timeSdkControl(id, 'supportedModels', () => s.query.supportedModels())
  }

  async supportedCommands(id: string) {
    const s = this.requireLive(id)
    return this.timeSdkControl(id, 'supportedCommands', () => s.query.supportedCommands())
  }

  async supportedAgents(id: string) {
    const s = this.requireLive(id)
    return this.timeSdkControl(id, 'supportedAgents', () => s.query.supportedAgents())
  }

  async mcpServerStatus(id: string) {
    const s = this.requireLive(id)
    return this.timeSdkControl(id, 'mcpServerStatus', () => s.query.mcpServerStatus())
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
    return this.timeSdkControl(id, 'getContextUsage', () => s.query.getContextUsage())
  }

  /** List pending tool-permission requests for a session. */
  listPending(id: string): PermissionRequestSnapshot[] {
    return this.permBroker.listPending(this.require(id))
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
    this.permBroker.decide(s, pid, decision)
    s.lastActivityAt = Date.now()
    this.persist(s)
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
    this.permBroker.answerQuestion(s, pid, answers)
    s.lastActivityAt = Date.now()
    this.persist(s)
  }

  /** Subscription for permission-channel events. */
  subscribePermissions(id: string): {
    iterable: AsyncIterable<PermissionEvent>
    snapshot: PermissionRequestSnapshot[]
    unsubscribe: () => void
  } {
    return this.permBroker.subscribePermissions(this.require(id))
  }

  /** AsyncIterable of context-usage snapshots for one session.
   *  Returns null if the session doesn't exist (caller should treat
   *  as "no context data available").
   *  Each subscriber gets its own pushable to avoid waiter overwrite
   *  when multiple tabs are connected to the same session. */
  subscribeContextUsage(id: string): { iterable: AsyncIterable<unknown>; unsubscribe: () => void } | null {
    const s = this.sessions.get(id)
    if (!s) return null
    return this.subscribePushableSet(s, s.contextUsageSubscribers, 'ctx', 50)
  }

  /** AsyncIterable of `git-status-changed` signal frames for one session.
   *  Mirrors subscribeContextUsage; returns null when the session is
   *  unknown so callers can short-circuit gracefully. */
  subscribeGitStatus(id: string): { iterable: AsyncIterable<unknown>; unsubscribe: () => void } | null {
    const s = this.sessions.get(id)
    if (!s) return null
    return this.subscribePushableSet(s, s.gitStatusSubscribers, 'git', 20)
  }

  /** AsyncIterable of `message-consumed` signal frames for one session.
   *  Mirrors subscribeGitStatus. Each frame carries the uuid + consumedAt
   *  of a user message the SDK has just read off the input queue, so the
   *  client can flip its bubble from "queued" to "consumed". A small
   *  maxDepth is fine: the durable truth lives on the message object's
   *  `consumedAt` (replayed on reconnect), so a dropped live frame self-
   *  heals on the next replay. */
  subscribeMessageStatus(id: string): { iterable: AsyncIterable<unknown>; unsubscribe: () => void } | null {
    const s = this.sessions.get(id)
    if (!s) return null
    return this.subscribePushableSet(s, s.messageStatusSubscribers, 'msgstat', 50)
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

  /** Shared implementation for subscribeContextUsage / subscribeGitStatus.
   *  Creates a per-subscriber pushable, registers it in the given set, and
   *  returns the iterable + cleanup function. */
  private subscribePushableSet(
    s: Session,
    set: Set<Pushable<unknown>>,
    label: string,
    maxSize: number,
  ): { iterable: AsyncIterable<unknown>; unsubscribe: () => void } {
    const pushable = createPushable<unknown>(`${label}-${s.id.slice(0, 8)}`, maxSize)
    set.add(pushable)
    return {
      iterable: pushable.iterable,
      unsubscribe: () => {
        set.delete(pushable)
        pushable.end()
      },
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

  /** Consume hook wired into each session's input pushable (see spawn /
   *  autoResume). Fires the instant the SDK reads a turn off the queue —
   *  either because it was buffered while a previous turn ran, or handed
   *  off directly to a blocked consumer. We:
   *    1. Filter to top-level user messages. Tool results and sub-agent
   *       outputs flow through the same Query stream but never through
   *       THIS pushable, so in practice everything here is a user turn;
   *       the guard is defence-in-depth and mirrors the pump's drop rule.
   *    2. Stamp `consumedAt` on the message object. Because the input
   *       pushable and the history ring hold the SAME object reference
   *       (dispatchUserMessage pushes one object to both), this stamp is
   *       immediately visible on the historical copy — so a reconnecting
   *       client replays it as already-consumed with zero extra storage.
   *    3. Broadcast a live `message-consumed` signal so currently-attached
   *       tabs flip the bubble without waiting for a replay. */
  private onInputConsumed(id: string, msg: SDKUserMessage): void {
    if (msg.type !== 'user') return
    if ((msg as { parent_tool_use_id?: string | null }).parent_tool_use_id != null) return
    const consumedAt = stampConsumedAt(msg)
    const uuid = (msg as { uuid?: string }).uuid
    if (typeof uuid !== 'string') return
    this.broadcastMessageConsumed(id, uuid, consumedAt)
  }

  /** Push a `message-consumed` signal to every subscriber of the session.
   *  No-op when the session is unknown or has no subscribers. The durable
   *  state lives on the message's `consumedAt` (replayed on reconnect);
   *  this frame only drives the live flip. */
  private broadcastMessageConsumed(id: string, uuid: string, consumedAt: number): void {
    const s = this.sessions.get(id)
    if (!s) return
    if (s.messageStatusSubscribers.size === 0) return
    const frame = { kind: 'message-consumed' as const, sessionId: id, uuid, consumedAt }
    for (const sub of s.messageStatusSubscribers) {
      try { sub.push(frame) } catch { /* subscriber dead — skip */ }
    }
  }

  /** Broadcast a recap-update payload to per-session subscribers AND
   *  fan out a global session-update so the sidebar (which mirrors
   *  SessionInfo.recap onto its session cards) stays in sync without
   *  needing a separate frame. Called by the RecapManager via the
   *  broadcastRecap dep. `recap` is undefined to mean "cleared" — both
   *  the per-session frame and the SessionInfo projection encode that
   *  as undefined. */
  private broadcastSessionRecap(id: string, recap: SessionRecap | undefined): void {
    const s = this.sessions.get(id)
    if (!s) return
    // Per-session recap channel — drives live UI on the active panel.
    if (s.recapSubscribers.size > 0) {
      const frame = { kind: 'session-recap-update' as const, sessionId: id, recap }
      for (const sub of s.recapSubscribers) {
        try { sub.push(frame) } catch { /* subscriber dead — skip */ }
      }
    }
    // Global session-update — sidebar / other tabs see the new recap
    // through the same SessionInfo projection used everywhere else.
    this.broadcastGlobal({ kind: 'update', session: this.info(s) })
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

  /** Delete a session for good: close its Query AND erase its persistence
   *  entry. Use when the user explicitly clicks "delete" in the UI. */
  async delete(id: string): Promise<void> {
    await this.unload(id, { terminate: true, reason: 'deleted' })
    this.store?.remove(id)
    // Drop any stored recap — otherwise a new session that happens to
    // reuse this id (rare, but possible under --state-dir swaps) would
    // see the old summary. unload() already calls invalidate() but we
    // do it again here as a safety net for delete-without-unload paths.
    this.recapManager.invalidate(id)
    this.broadcastGlobal({ kind: 'removed', id })
  }

  /** Close the Query and drop the in-memory session, but keep metadata on
   *  disk so the user can resume it later. Used for explicit deletion and
   *  during graceful shutdown.
   *
   *  `terminate`: when true, the session is marked terminated in the
   *  persistence store (prevents future resume) — used on explicit delete
   *  and when the Query itself has ended. Default false. */
  async unload(id: string, opts: { terminate?: boolean; reason?: string } = {}): Promise<void> {
    const s = this.sessions.get(id)
    if (!s) return
    if (opts.terminate) {
      s.terminated = true
      if (opts.reason) s.terminatedReason = opts.reason
    }
    s.running = false
    // Signal the pump to stop waiting on iter.next(). Without this,
    // a wedged SDK generator keeps the pump's 60s idle watchdog firing
    // indefinitely even after the session has been removed.
    s.abortController.abort()
    // Unregister from ProcessMonitor so we don't get a stale exit callback
    // for an intentionally-closed session.
    this.processMonitor.unregister(s.abortController.signal)
    s.input.end()
    // When terminating (explicit delete or graceful shutdown), await the
    // pump so the SDK subprocess has time to exit cleanly.
    if (opts.terminate) {
      try {
        await Promise.race([
          s.pumpTask,
          new Promise<void>((r) => setTimeout(r, 1000)),
        ])
      } catch { /* pump swallows errors internally */ }
    }
    this.permBroker.denyAll(s)
    // Cancel any pending git-status broadcast — without this, a timer
    // scheduled by the last mutating tool_use could still fire after the
    // session is removed (the broadcast itself is a no-op then, but the
    // timer is dead code that should be released up front).
    cancelGitBroadcast(id)
    endAllSubscribers(s)
    // Broadcast the running=false / terminated state BEFORE removing
    // from the map. Without this, the client's copy stays stale at
    // `running: true` — handleSelect then skips resume, and the user
    // hits a 409 on their next send. The session is still in the live
    // map at this point so info(s) works correctly.
    if (!opts.terminate) {
      this.broadcastGlobal({ kind: 'update', session: this.info(s) })
    }
    this.sessions.delete(id)
    // Clear the recap state. The session is no longer in the manager's
    // map so getPhase will return 'unknown' from inside the manager —
    // we still call invalidate() to end any subscribers and clear the
    // legacy in-flight slot. Recap is in-memory only, so dropping the
    // session here is the end of the line for it.
    this.recapManager.invalidate(id)
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

  /** Cheap count of all sessions (live + persisted) without allocating
   *  a full SessionInfo list. Use for health probes etc. */
  sessionCount(): number {
    if (!this.store) return this.sessions.size
    // Start with the store count, then add live sessions that are NOT
    // yet persisted (e.g. just created). This avoids allocating an array
    // from store.list() and is equivalent to the original
    // live + (store - overlap) formula.
    let count = this.store.count()
    for (const id of this.sessions.keys()) {
      if (!this.store.has(id)) count++
    }
    return count
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

  /** Offset-paginated read of a session's FULL transcript from disk, used by
   *  the frontend to lazy-load messages evicted from the in-memory ring.
   *  Works for dormant sessions too — reads the JSONL directly and does not
   *  require the session to be live. The session must exist in the store
   *  (404 otherwise); a session that never wrote a transcript returns an
   *  empty page. */
  async getHistoryPage(
    id: string,
    opts: { before?: number; beforeUuid?: string; limit: number },
  ): Promise<HistoryPage> {
    // Require the session to be known (live or persisted) so we don't serve
    // arbitrary uuids off disk.
    if (!this.sessions.has(id) && !this.store?.get(id)) {
      throw new HttpError(404, 'session not found')
    }
    return readHistoryPage(id, opts)
  }

  async shutdown(): Promise<void> {
    if (this.gcTimer) clearInterval(this.gcTimer)
    // End all global subscribers so their iterators resolve and
    // don't hang waiting for events that will never arrive.
    for (const sub of this.globalSubscribers.values()) sub.end()
    this.globalSubscribers.clear()
    const ids = Array.from(this.sessions.keys())
    // Collect pump tasks before unload removes sessions from the map.
    const pumpTasks: Promise<void>[] = []
    for (const id of ids) {
      const task = this.sessions.get(id)?.pumpTask
      if (task) pumpTasks.push(task)
    }
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

  /** Like require(), but additionally ensures the session is alive and
   *  the Query is still running — the precondition for send/sendContent. */
  private requireRunnable(id: string): Session {
    const s = this.require(id)
    if (s.terminated) {
      console.warn(`[session ${id}] send rejected — session is terminated`)
      throw new HttpError(410, `session ${id} is terminated`)
    }
    if (!s.running) {
      console.warn(`[session ${id}] send rejected — session is not running`)
      throw new HttpError(409, `session ${id} is not running; resume it first`)
    }
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
    const isWorking = s.running && s.pendingTurns > 0
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
      betas: s.betas,
      running: s.running,
      terminated: s.terminated,
      terminatedReason: s.terminatedReason,
      error: s.error,
      working: isWorking,
      workingSince: isWorking ? s.workingSince : undefined,
      lastTurnAt: s.lastTurnAt,
      gitStartSha: s.gitStartSha,
      pendingPermissionCount: s.pending.size,
      phase: this.phaseOf(s),
      recap: s.recap,
    }
  }

  /** Coarse-grained lifecycle phase. Single source of truth for
   *  client-side gates that today re-derive the same state from the
   *  primitives (working / running / terminated / queueDepth /
   *  pending permissions). The recap auto-fire timer is the first
   *  caller, but anything else that wants "is the session quiet right
   *  now?" should read `phase` rather than re-implementing the rule. */
  phaseOf(s: Session): SessionPhase {
    if (s.terminated) return 'terminated'
    if (!s.running) return 'dormant'
    // Any in-flight assistant turn, queued user input, or unanswered
    // tool-permission prompt counts as "working" — none of those are
    // safe moments to summarise the conversation.
    if (s.pendingTurns > 0) return 'working'
    if (s.input.queueDepth > 0) return 'working'
    if (s.pending.size > 0) return 'working'
    return 'idle'
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
      terminatedReason: meta.terminatedReason,
      error: meta.error,
      working: false,
      workingSince: undefined,
      lastTurnAt: meta.lastTurnAt,
      gitStartSha: meta.gitStartSha,
      // A dormant Query holds no canUseTool callbacks; pending is always 0.
      pendingPermissionCount: 0,
      // Terminated stays terminated; everything else is dormant. Recap
      // is in-memory only (per spec — no persistence), so dormant
      // sessions always come back without one until the user resumes
      // and the recapManager rebuilds it.
      phase: meta.terminated ? 'terminated' : 'dormant',
      recap: undefined,
    }
  }

  /** Inject standard options shared by spawn() and autoResume():
   *  includePartialMessages, pathToClaudeCodeExecutable, env, and the
   *  marketplace-enabled plugin paths. */
  private applyStandardQueryOpts(opts: Options): void {
    if (opts.includePartialMessages === undefined) {
      opts.includePartialMessages = true
    }
    if (!opts.pathToClaudeCodeExecutable && this.claudeBinary) {
      opts.pathToClaudeCodeExecutable = this.claudeBinary
    }
    if (!opts.env) {
      opts.env = this.buildAnthropicEnv()
    }
    // Merge marketplace-enabled plugin paths into Options.plugins. We
    // append rather than replace so a caller can pass its own plugins
    // through (e.g. tests or one-off ad-hoc spawns). Each entry is
    // `{ type: 'local', path }` — the only SdkPluginConfig variant the
    // SDK currently accepts. Plugins whose dirs disappeared since the
    // last enable are silently filtered by the store helper.
    if (this.mpStore) {
      const enabledPaths = this.mpStore.getEnabledPluginAbsolutePaths()
      if (enabledPaths.length > 0) {
        const existing = opts.plugins ?? []
        opts.plugins = [
          ...existing,
          ...enabledPaths.map((path) => ({ type: 'local' as const, path })),
        ]
      }
    }
  }

  /** Build (or return cached) PumpDeps shared by pump() and autoResume().
   *  All fields reference stable `this` members, so the object is built
   *  once and reused for the lifetime of the SessionManager. */
  private buildPumpDeps(): PumpDeps {
    if (!this.cachedPumpDeps) {
      this.cachedPumpDeps = {
        historyCap: this.historyCap,
        persist: (s) => this.persist(s),
        denyPendingPermissions: (s) => this.permBroker.denyAll(s),
        isLive: (id) => this.sessions.has(id),
        autoResume: this.autoResumeEnabled ? (s) => this.autoResume(s) : undefined,
        // The pump's mutating-tool detector calls broadcaster.broadcastGitStatusChanged
        // through the debounce helper. `this` satisfies the SessionBroadcaster
        // interface (subscribeContextUsage, subscribeGitStatus, etc.).
        broadcaster: this,
      }
    }
    return this.cachedPumpDeps
  }

  private async pump(session: Session): Promise<void> {
    return pumpSession(session, this.buildPumpDeps())
  }

  /** Max consecutive auto-resumes before giving up. Prevents infinite
   *  loops if the CLI subprocess keeps exiting immediately. */
  private static MAX_AUTO_RESUME = 3
  /** Tracks consecutive auto-resume attempts per session. */
  private autoResumeCounts = new WeakMap<Session, number>()

  /** Re-spawn a session's Query after a clean exit (idle timeout).
   *  Returns true if the session was successfully re-spawned. */
  private async autoResume(session: Session): Promise<boolean> {
    // Guard: session must still be live and not explicitly stopped
    if (!this.sessions.has(session.id)) return false
    if (session.terminated) return false

    // Guard: the SDK only writes session data to disk after the first
    // `result` message. If no turn was completed, resume would fail
    // with "No conversation found with session ID: <uuid>".
    if (!session.lastTurnAt) {
      console.warn(`[session ${session.id}] auto-resume skipped — no completed turns (no disk data)`)
      return false
    }

    // Track consecutive resumes to avoid infinite loops
    const resumeCount = this.autoResumeCounts.get(session) ?? 0
    if (resumeCount >= SessionManager.MAX_AUTO_RESUME) {
      console.warn(`[session ${session.id}] auto-resume limit reached (${resumeCount}), giving up`)
      return false
    }

    console.log(`[session ${session.id}] auto-resuming (attempt ${resumeCount + 1}/${SessionManager.MAX_AUTO_RESUME})`)

    // Close old input and abort controller
    session.input.end()
    session.abortController.abort()

    // Create fresh input and abort controller. Re-wire the same consume
    // hook so message-consumed frames keep flowing after an auto-resume.
    const newInput = createPushable<SDKUserMessage>(
      `input-${session.id.slice(0, 8)}`,
      undefined,
      (msg) => this.onInputConsumed(session.id, msg),
    )
    const newAbort = new AbortController()

    // Unregister old signal from ProcessMonitor, register new one
    this.processMonitor.unregister(session.abortController.signal)
    this.processMonitor.register(newAbort.signal, session.id)

    // Build resume options — loads conversation history from disk.
    // Don't forward permissionMode to the SDK (same as spawn()).
    // We enforce it ourselves via canUseTool, and the SDK's built-in
    // flag would add a brittle "can't transition into bypassPermissions"
    // constraint on top.
    const resumeOpts: Options = {
      resume: session.id,
      cwd: session.cwd,
      model: session.model,
      permissionMode: undefined,
      title: session.title,
      abortController: newAbort,
      // Carry beta flags forward — without this, a 1M-context session
      // silently downgrades to the model's default window on auto-resume.
      // See resume() for the cast rationale.
      betas: session.betas as Options['betas'],
    }

    // Inject standard options (same as spawn())
    this.applyStandardQueryOpts(resumeOpts)

    // Reuse the stored canUseTool callback from the original spawn
    if (session.canUseTool) {
      resumeOpts.canUseTool = session.canUseTool
    }
    resumeOpts.spawnClaudeCodeProcess = this.spawnWrapper

    // Create new Query
    const q = query({ prompt: newInput.iterable, options: resumeOpts })

    // Update session with new references
    session.input = newInput
    session.query = q
    session.abortController = newAbort
    session.running = true
    session.exiting = false
    // Clear any auto-interrupt flag from the previous pump so the GC
    // doesn't immediately escalate the freshly-resumed session to unload.
    session.autoInterruptedAt = undefined
    this.autoResumeCounts.set(session, resumeCount + 1)

    // Broadcast the session update so clients know it's alive again
    this.broadcastGlobal({ kind: 'update', session: this.info(session) })

    // Start new pump — returns immediately, runs in background
    session.pumpTask = pumpSession(session, this.buildPumpDeps())

    return true
  }

  /** Periodic check for stuck sessions. Idle sessions are no longer
   *  auto-unloaded — they persist until explicitly deleted by the user. */
  private gc() {
    const now = Date.now()
    for (const [id, s] of this.sessions) {
      this.checkStuck(id, s, now)
    }
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
    if (!s.running || s.terminated || s.exiting) return
    // Only check sessions that are actively working (mid-turn).
    // Idle sessions (pendingTurns=0, no pending permissions) are not stuck —
    // they are waiting for user input and should persist indefinitely.
    if (s.pendingTurns === 0 && s.pending.size === 0) return

    const idleSince = now - s.lastActivityAt
    if (idleSince <= this.workingStuckMs) return

    // Init never landed: no point sending interrupt control frames into a
    // half-spawned subprocess. Schedule unload directly.
    if (s.history.length === 0) {
      console.warn(
        `[session ${id}] init never completed — no messages after ${idleSince}ms ` +
        `(pendingTurns=${s.pendingTurns}, subscribers=${s.subscribers.size}). Force-unloading.`,
      )
      void this.unload(id, { terminate: true, reason: 'init_stuck' })
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
      void this.unload(id, { terminate: true, reason: 'stuck' })
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

