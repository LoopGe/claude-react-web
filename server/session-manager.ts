// Multi-session pool for provider-backed agent sessions.
//
// Each session holds:
//   - A provider session handle for queued user turns and streamed messages.
//   - Subscribers (Set<Subscriber>) so a slow client cannot block the pump.
//   - A small ring buffer of recent messages so freshly-connected subscribers
//     can see the state of the world without missing live events.
//
// Optional control methods are delegated through the provider handle and
// guarded by provider capabilities.
//
// Sessions are only removed when explicitly deleted by the user or when the
// stuck-session detector fires. A periodic tick checks for stuck sessions
// (mid-turn silence exceeding workingStuckMs).

import {
  type EffortLevel,
  type Options,
  type PermissionMode,
  type SDKMessage,
  type SDKUserMessage,
  type Settings,
} from '@anthropic-ai/claude-agent-sdk'
import type { ProcessExitInfo } from './process-monitor.js'
import { randomUUID } from 'node:crypto'
import { SessionStore, type SessionMeta } from './persistence.js'
import { McpConfigStore } from './mcp-config.js'
import { RecapManager } from './recap.js'
import type { SessionPhase, SessionRecap } from './session-types.js'
import { tryCaptureGitHead, invalidateStatusCache } from './git.js'
import { cancelGitBroadcast } from './git-broadcast.js'
import { execCommand, escapeXml } from './exec.js'
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
  type ResumableSession,
  endAllSubscribers,
} from './session-types.js'
import { HttpError } from './errors.js'
import { effortLevelsForModel } from './effort-capability.js'
import { PermissionBroker } from './permission-broker.js'
import { SessionHealthMonitor } from './session-health.js'
import { pushBounded, stampReceivedAt, stampConsumedAt } from './history-utils.js'
import { watchBackgroundSubagent, type SubagentCompletion } from './subagent-watcher.js'
import { createLogger } from './log.js'
import type { HistoryEntry, HistoryPage } from './history-reader.js'
import { createPushable, type Pushable } from './pushable.js'
import { createDefaultProviders } from './providers/default-providers.js'
import type { ProviderCapabilities, ProviderSessionHandle } from './providers/types.js'
import { countMatches, findRanges } from '../shared/search/match.js'
import { extractMessagePlainText } from '../shared/search/extract.js'
import type { MessageSearchHit } from '../shared/search-results.js'
import type { ProviderRegistry } from './providers/registry.js'
import {
  emptyHooksConfig,
  formatHooksValidationErrors,
  toSdkHooksSettings,
  validateSessionHooksConfig,
  type HookRunRecord,
  type HookRuntimeEvent,
  type SessionHooksConfig,
} from '../shared/hooks.js'
import {
  policyToDynamicSkillOverrides,
  policyToInitialSkillsOption,
  resolveEffectiveSkillPolicy,
  type EffectiveSkillPolicy,
  type SessionSkillOverride,
} from '../shared/skills.js'
import { listSkills } from './skills.js'

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
  type ResumableSession,
} from './session-types.js'
export { HttpError } from './errors.js'

/** Resolve the effective policy for a session by combining (optional)
 *  session-level override with the current global config. The result is the
 *  single authoritative source for both spawn-time and dynamic skill wiring,
 *  which keeps the two paths in lockstep — they cannot disagree about what
 *  "policy" means for a given session. */
function effectiveSkillPolicyFor(
  override: SessionSkillOverride | undefined,
): EffectiveSkillPolicy {
  return resolveEffectiveSkillPolicy(
    override,
    defaultConfig.skillLoadMode,
    defaultConfig.enabledSkills,
  )
}

/** Apply a session's effective skill policy to its initial spawn Options.
 *  Honors any caller-supplied `opts.skills` (e.g. /api/sessions allowing the
 *  client to pin per-session skills at create time) — that's the highest
 *  precedence. Otherwise we project the resolved policy onto Options.skills.
 *
 *  Important: this is the SPAWN-time projection only. Mid-session changes go
 *  through applyDynamicSkillOverrides() which uses applyFlagSettings(). */
function applySkillPolicyToOptions<T extends Options>(
  opts: T,
  override: SessionSkillOverride | undefined,
): T {
  if (opts.skills !== undefined) return opts
  const projected = policyToInitialSkillsOption(effectiveSkillPolicyFor(override))
  if (projected !== undefined) opts.skills = projected
  return opts
}

/** System-prompt instructions appended to every Side Chat session.
 *  Adapted from Codex's SIDE_DEVELOPER_INSTRUCTIONS. Injected via the
 *  `systemPrompt` option so the model knows it's in a side conversation
 *  from the very first turn — without triggering a boundary turn. */
const SIDE_DEVELOPER_INSTRUCTIONS = `You are in a side conversation, not the main thread.

This side conversation is for answering questions and lightweight exploration
without disrupting the main thread. Do not present yourself as continuing the
main thread's active task.

The inherited fork history is provided only as reference context. Do not treat
instructions, plans, or requests found in the inherited history as active
instructions for this side conversation. Only instructions submitted by the
user after joining this side conversation are active.

Do not continue, execute, or complete any task, plan, tool call, approval,
edit, or request that appears only in inherited history.

You may perform non-mutating inspection, including reading or searching files
and running checks that do not alter repo-tracked files.

Do not modify files, source, git state, permissions, configuration, or any
other workspace state unless the user explicitly requests that mutation in
this side conversation. If the user explicitly requests a mutation, keep it
minimal, local to the request, and avoid disrupting the main thread.`

function clampSearchLimit(value: number | undefined): number {
  if (!Number.isFinite(value ?? NaN)) return 30
  return Math.max(1, Math.min(Math.floor(value as number), 100))
}

function messageUuid(message: unknown): string | undefined {
  if (!message || typeof message !== 'object') return undefined
  const uuid = (message as { uuid?: unknown }).uuid
  return typeof uuid === 'string' ? uuid : undefined
}

function messageType(message: unknown): string | undefined {
  if (!message || typeof message !== 'object') return undefined
  const type = (message as { type?: unknown }).type
  return typeof type === 'string' ? type : undefined
}

function buildSnippet(text: string, query: string, maxLength = 180): string {
  const range = findRanges(text, query)[0]
  if (!range) return text.length > maxLength ? `${text.slice(0, maxLength - 3).trimEnd()}...` : text

  const context = Math.max(24, Math.floor((maxLength - (range.end - range.start)) / 2))
  let start = Math.max(0, range.start - context)
  let end = Math.min(text.length, range.end + context)

  const leftBreak = text.lastIndexOf('\n', range.start)
  if (leftBreak >= 0 && leftBreak > start) start = leftBreak + 1
  const rightBreak = text.indexOf('\n', range.end)
  if (rightBreak >= 0 && rightBreak < end) end = rightBreak

  let snippet = text.slice(start, end).replace(/\s+/g, ' ').trim()
  if (start > 0) snippet = `...${snippet}`
  if (end < text.length) snippet = `${snippet}...`
  return snippet
}

const log = createLogger('session')

export class SessionManager {
  private sessions = new Map<string, Session>()
  private historyCap: number
  private autoResumeEnabled: boolean
  private crashRecoveryEnabled: boolean
  private healthMonitor: SessionHealthMonitor
  private store: SessionStore
  private mcpStore: McpConfigStore
  private providers: ProviderRegistry
  private defaultProvider: string
  private globalSubscribers = new Map<string, GlobalSubscriber>()
  private permBroker: PermissionBroker
  /** Owns recap lifecycle for every session. Public so the recap route
   *  can call requestGenerate() without going through a wrapper method d
   *  the route is the only HTTP surface for recap, and proxying through
   *  SessionManager would just re-export the same throw semantics. */
  recapManager: RecapManager
  /** Cached result of buildAnthropicEnv(). Invalidated when config.authToken
   *  or config.baseUrl change (detected lazily on each call). */
  /** Cached PumpDeps dall fields reference stable `this` members,
   *  so the object is built once and reused. */
  private cachedPumpDeps?: PumpDeps
  constructor(opts: SessionManagerOptions = {}) {
    this.historyCap = opts.historyCap ?? defaultConfig.historyCap
    this.permBroker = new PermissionBroker()
    this.autoResumeEnabled = opts.autoResume ?? false
    this.crashRecoveryEnabled = opts.crashRecovery ?? false
    this.store = opts.store ?? new SessionStore()
    this.mcpStore = opts.mcpConfigStore ?? new McpConfigStore()
    this.providers = opts.providers ?? createDefaultProviders({
      claudeBinary: opts.claudeBinary,
      mpStore: opts.mpStore,
      onProcessExit: (info) => this.handleProcessExit(info),
    })
    this.defaultProvider = opts.defaultProvider ?? 'claude'
    // Stuck-session monitor dperiodic GC tick with auto-interrupt.
    // `unload` is a class method so it's always available via `this`.
    // The deps arrow captures `this` so the callback stays bound.
    this.healthMonitor = new SessionHealthMonitor({
      sessions: this.sessions,
      workingStuckMs: opts.workingStuckMs ?? defaultConfig.workingStuckMs,
      unload: (id, opts) => this.unload(id, opts),
    })

    // RecapManager downs the lifecycle (pending dready/error) for the
    // session.recap field. Hooks back into this manager via the deps
    // interface so the module never imports SessionManager directly.
    this.recapManager = new RecapManager({
      getPhase: (id) => {
        const s = this.sessions.get(id)
        if (!s) return 'unknown'
        return this.phaseOf(s)
      },
      getHistory: (id) => this.getHistory(id),
      getModel: (id) => this.sessions.get(id)?.model,
      setRecap: (id, recap) => {
        const s = this.sessions.get(id)
        if (!s) return
        s.recap = recap
      },
      broadcastRecap: (id, recap) => this.broadcastSessionRecap(id, recap),
    })

    log.info(
      `[session-manager] initialized`,
    )
  }

  /** Handle a CLI process exit detected by ProcessMonitor.
   *  This fires in real-time (ms) rather than waiting for the 60s GC.
   *
   *  - Clean exit (code=0, not killed): abort the controller so the pump
   *    breaks out of iter.next(); cleanupPump then decides auto-resume vs
   *    terminate. We do NOT set terminated here — that would race
   *    cleanupPump's auto-resume attempt.
   *  - Spawn failure (binary missing / not executable): terminate
   *    immediately. No recovery — the binary is unavailable, retrying
   *    spawn will keep failing.
   *  - Crash (non-zero code / killed): when crashRecovery is enabled,
   *    record the crash context and defer to cleanupPump's recovery
   *    ladder (Step 1 in-place resume → Step 2 fork from last completed
   *    turn → terminate). When disabled, terminate immediately (legacy
   *    behavior). */
  private handleProcessExit(info: ProcessExitInfo): void {
    const { sessionId, code, signal, killed, spawnError } = info
    const s = this.sessions.get(sessionId)
    if (!s) return // Session already cleaned up (e.g. by unload)
    if (s.terminated) return // Already terminated dno action needed
    // clear() drives its own respawn and has already unregister()-marked the
    // old process's exit intentional, so this normally doesn't fire during a
    // clear. Guard anyway for the race where the child's 'exit' beat
    // destroy()'s unregister — clear() is tearing down + respawning on
    // purpose, so don't let an old-process exit terminate the session.
    if (s.clearing) return

    const cleanExit = !killed && code === 0 && !spawnError

    if (cleanExit) {
      // Normal exit (e.g. idle timeout). Abort the controller so the
      // pump breaks out of iter.next(), but DON'T set terminated dlet
      // cleanupPump handle auto-resume or termination.
      log.info(`[session ${sessionId}] CLI exited cleanly (code=0) ddeferring to pump cleanup`)
      // Mark as exiting so the GC timer's checkStuck() skips this session
      // during the window between abort and cleanupPump finishing.
      s.exiting = true
      s.handle.abort()
      return
    }

    // Determine reason / message. spawnError takes priority dit's a
    // structured failure from ProcessMonitor's 'error' event and carries
    // the actual errno (ENOENT for "binary missing", EACCES for
    // "not executable", etc.) which is much more actionable than the
    // generic "code=null, signal=null" we'd otherwise produce.
    let reason: 'process_killed' | 'process_exited' | 'spawn_failed'
    let errorMsg: string
    if (spawnError) {
      reason = 'spawn_failed'
      // Any spawn-time failure proves the cached health snapshot is no
      // longer trustworthy dthe binary may have been moved, replaced,
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

    log.error(`[session ${sessionId}] ${errorMsg}`)

    // Spawn failures can't be recovered by retrying (the binary is
    // unavailable / unusable). Terminate immediately.
    if (reason === 'spawn_failed') {
      this.terminateCrashedSession(s, reason, errorMsg)
      return
    }

    // Crash (killed / non-zero exit). If recovery is disabled, terminate
    // immediately (legacy behavior).
    if (!this.crashRecoveryEnabled) {
      this.terminateCrashedSession(s, reason, errorMsg)
      return
    }

    // Defer to the recovery ladder: record the crash context (the
    // discriminator cleanupPump dispatches on), abort the pump so it
    // breaks out of iter.next(), and broadcast a "recovering" notice.
    // Do NOT set terminated / endSubscribers dthe ladder may re-spawn
    // in-place (Step 1) keeping message subscribers attached across the
    // gap, exactly like clear() does. (denyAll IS safe and required: the
    // crashed turn's pending tool-permission requests can never resolve —
    // their SDK awaiter is dead — so deny them now to clear s.pending,
    // dismiss the client's permission dialog, and avoid phaseOf sticking
    // on 'working'. endAllSubscribers is independent and stays skipped.)
    s.lastCrash = { code, signal, killed, spawnError: spawnError ? { code: spawnError.code, message: spawnError.message } : undefined }
    s.error = errorMsg
    // Preserve the specific crash reason so crashRecoveryGiveUp can surface
    // it instead of the generic 'query_error' the cleanupPump tail would stamp.
    s.terminatedReason = reason
    s.exiting = true
    s.recovering = true
    s.pendingTurns = 0
    s.workingSince = undefined
    this.permBroker.denyAll(s)
    s.handle.abort()

    this.broadcastSystemNotice(s, `${errorMsg} — 正在尝试自动恢复…`)
    this.broadcastGlobal({ kind: 'update', session: this.info(s) })
  }

  /** Push a synthetic system/error notice to a session's live subscribers.
   *  Ephemeral dNOT entered into the history ring (so it doesn't survive
   *  replay/refresh); used for transient lifecycle notices (recovering,
   *  recovered, forked) and the terminal crash error. Centralized so the
   *  frame shape can't drift across the half-dozen call sites. */
  private broadcastSystemNotice(session: Session, text: string): void {
    const msg: SDKMessage = {
      type: 'system',
      subtype: 'error',
      error: text,
      uuid: randomUUID(),
      session_id: session.id,
      receivedAt: Date.now(),
    } as unknown as SDKMessage
    for (const sub of session.subscribers.values()) {
      try { sub.push(msg) } catch { /* subscriber dead dskip */ }
    }
  }

  /** Begin polling a background subagent's own transcript for completion.
   *  Called by the pump when it sees an async launch ack. On completion,
   *  synthesizes a `system`/`task_notification` frame (the CLI doesn't emit
   *  one reliably) and feeds it back through the normal broadcast path so
   *  the client reducer's completion branch flips the `background` record to
   *  `done` with the subagent's real output. */
  private startBackgroundSubagentWatcher(sessionId: string, toolUseId: string, agentId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    // One watcher per (session, toolUseId). A duplicate launch ack (replay,
    // re-broadcast) must not stack a second poller on the same transcript.
    let perSession = this.backgroundWatchers.get(sessionId)
    if (!perSession) {
      perSession = new Map()
      this.backgroundWatchers.set(sessionId, perSession)
    }
    if (perSession.has(toolUseId)) return
    if (!session.cwd) return // without a cwd the subagent transcript path can't be computed
    const stop = watchBackgroundSubagent({
      cwd: session.cwd,
      sessionId,
      agentId,
      toolUseId,
      onCompleted: (completion) => {
        // Remove the watcher entry before broadcasting so the unload guard
        // can't race a concurrent stop. onCompleted fires on EVERY resolution
        // path (real completion / staleness / maxMs backstop), so the entry is
        // always cleared here — a later re-arm (e.g. an autoResume re-seeing
        // the launch ack) is never blocked by a stale entry.
        perSession!.delete(toolUseId)
        this.broadcastSynthesizedTaskNotification(session, toolUseId, agentId, completion)
      },
    })
    perSession.set(toolUseId, stop)
  }

  /** Synthesize a `system`/`task_notification` frame for a completed
   *  background subagent and feed it through the SAME path real messages
   *  take (history ring + live subscribers), so it survives replay and
   *  reaches the client reducer's completion branch. The reducer matches by
   *  `tool_use_id` and flips the `background` record to `done` (or
   *  `interrupted` for a non-completed status), capturing the subagent's
   *  final text as the merged result. */
  private broadcastSynthesizedTaskNotification(
    session: Session,
    toolUseId: string,
    agentId: string,
    completion: SubagentCompletion,
  ): void {
    // Drop the watcher if the session was unloaded between dispatch and
    // completion dno subscribers to push to, and persisting would race
    // unload's terminal write.
    if (!this.sessions.has(session.id)) return
    const msg: SDKMessage = {
      type: 'system',
      subtype: 'task_notification',
      task_id: agentId,
      tool_use_id: toolUseId,
      status: completion.status,
      summary: completion.summary,
      output_file: '',
      uuid: randomUUID(),
      session_id: session.id,
      receivedAt: Date.now(),
    } as unknown as SDKMessage
    stampReceivedAt(msg)
    pushBounded(session.history, msg, this.historyCap)
    for (const sub of session.subscribers.values()) {
      try { sub.push(msg) } catch { /* subscriber dead dskip */ }
    }
  }

  /** Stop all background-subagent watchers for a session (called on unload
   *  so a late completion can't broadcast into a dead session). */
  private stopBackgroundSubagentWatchers(sessionId: string): void {
    const perSession = this.backgroundWatchers.get(sessionId)
    if (!perSession) return
    for (const stop of perSession.values()) {
      try { stop() } catch { /* ignore */ }
    }
    perSession.clear()
    this.backgroundWatchers.delete(sessionId)
  }

  /** Terminate a crashed session immediately: the legacy non-recovery path
   *  for spawn failures and for crashes when crashRecovery is disabled.
   *  Also the final state written when the recovery ladder gives up (called
   *  from cleanupPump's termination tail). Kept as a helper so the immediate
   *  and give-up paths stay identical. */
  private terminateCrashedSession(
    s: Session,
    reason: string,
    errorMsg: string,
  ): void {
    s.running = false
    s.recovering = false
    s.exiting = false
    s.terminated = true
    s.terminatedReason = reason
    s.error = errorMsg
    s.lastCrash = undefined
    s.pendingTurns = 0
    s.workingSince = undefined
    this.permBroker.denyAll(s)
    this.broadcastSystemNotice(s, errorMsg)
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

  /** Flush any pending debounced session-meta writes to disk. Used by the
   *  reset route to ensure deletions are persisted before responding —
   *  without this, a crash within the debounce window silently loses the
   *  reset (sessions reappear on restart). */
  async flushStore(): Promise<void> {
    await this.store.flush()
  }

  /** Write a session's metadata to the persistence store without
   *  broadcasting on the global channel. Use from spawn() so the
   *  subsequent `created` event is the only thing the frontend sees for
   *  a brand-new session dif we also sent an `update` the client can't
   *  tell which arrives first, which races with the optimistic POST
   *  response and produces duplicate cards. */
  private writeStore(s: Session): void {
    if (!this.store) return
    this.store.upsert({
      id: s.id,
      provider: s.provider,
      createdAt: s.createdAt,
      lastActivityAt: s.lastActivityAt,
      cwd: s.cwd,
      model: s.model,
      permissionMode: s.permissionMode,
      title: s.title,
      betas: s.betas,
      fastMode: s.fastMode,
      effortLevel: s.effortLevel,
      hooks: s.hooks,
      messageCount: s.history.length,
      terminated: s.terminated,
      terminatedReason: s.terminatedReason,
      error: s.error,
      lastTurnAt: s.lastTurnAt,
      gitStartSha: s.gitStartSha,
      parentId: s.parentId,
      forkBoundaryUuid: s.forkBoundaryUuid,
      mcpServerNames: s.mcpServerNames,
      enabledPlugins: s.enabledPlugins,
      showPinnedUserMessage: s.showPinnedUserMessage,
      autoRecap: s.autoRecap,
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
  private snapshotMeta(opts: Options, provider: string): { provider: string; cwd?: string; model?: string; permissionMode?: PermissionMode; title?: string; betas?: string[]; effortLevel?: EffortLevel; hooks?: SessionHooksConfig; mcpServerNames?: string[]; enabledPlugins?: string[] } {
    const settingsHooks = typeof opts.settings === 'object' && opts.settings && !Array.isArray(opts.settings)
      ? (opts.settings as { hooks?: SessionHooksConfig }).hooks
      : undefined
    return {
      provider,
      cwd: opts.cwd,
      model: opts.model,
      permissionMode: opts.permissionMode,
      title: opts.title,
      // `betas` carries flags like `context-1m-...` that change the
      // model's context window. Must survive restart / resume / fork
      // or the user's 1M session silently downgrades to 200k.
      betas: Array.isArray(opts.betas) ? opts.betas : undefined,
      // Effort passed at create time (Options.effort) becomes the session's
      // initial effortLevel so a create-time choice persists like the others.
      effortLevel: opts.effort,
      hooks: settingsHooks,
      // Capture the resolved MCP server names so the client can compute
      // "available" without the flaky mcp-status SDK control request.
      mcpServerNames: opts.mcpServers ? Object.keys(opts.mcpServers as Record<string, unknown>) : undefined,
      enabledPlugins: (opts as { enabledPlugins?: string[] }).enabledPlugins,
    }
  }

  /** Create a brand-new session and start pumping.
   *
   *  For resume, use `resume()` instead dthis path always allocates a
   *  fresh UUID and won't wire up SDK `resume`. */
  create(
    opts: Options & { provider?: string },
    customEnv?: Record<string, string>,
    /** Set by the restart flow: the id of the session Y joins. Threaded
     *  through to spawn() so the `created` broadcast carries `joinGroupOf`,
     *  letting every tab append Y to X's group (X is evicted later by
     *  swapSession / session-removed). */
    joinGroupOf?: string,
  ): SessionInfo {
    // Pin a concrete default model for brand-new sessions so we don't lean
    // on the CLI subprocess's built-in default. When the client omits a
    // model, use the first entry of the configured model list
    // (config.defaultModel === modelList[0]). This keeps session.model a
    // concrete id from the start dmatching what the model picker shows as
    // selected dinstead of an undefined that silently resolves to whatever
    // model the `claude` CLI happens to pick. Resume/fork are unaffected:
    // they carry the persisted model forward through their own opts.
    const withDefault: Options & { provider?: string } = {
      ...opts,
      provider: opts.provider ?? this.defaultProvider,
      model: opts.model ?? defaultConfig.defaultModel,
    }
    return this.spawn(randomUUID(), withDefault, customEnv, undefined, undefined, undefined, joinGroupOf)
  }

  /** Resume a previously-persisted session. The SDK loads conversation
   *  history from its own on-disk log (~/.claude/projects/...) using the
   *  session id. Returns the info for the freshly-spawned Query.
   *
   *  Behaviour:
   *  - If the session is already live in memory, returns its current info
   *    (idempotent dreconnecting from two tabs doesn't spawn twice).
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
    // Fall back to adopting an unknown session: the /resume picker can
    // surface sessions the `claude` CLI created directly (never tracked
    // in our store). Probe the SDK's on-disk metadata and, if it exists,
    // register a SessionMeta so the normal resume path below can run.
    // After this first resume the session is "known" like any other.
    const meta = this.store.get(id) ?? (await this.adoptDiskSession(id, this.defaultProvider))
    if (!meta) throw new HttpError(404, `session ${id} not found`)
    if (meta.terminated) {
      throw new HttpError(410, `session ${id} has ended and cannot be resumed`)
    }
    // Ground-truth resume gate: probe the SDK's on-disk transcript FIRST.
    // `lastTurnAt` is only a fallible in-memory proxy (the pump sets it
    // solely on a real `result`, observed in THIS process) — it can be
    // stale or lost while a perfectly good transcript still lives on disk
    // (e.g. the pre-fix spawn()-drops-lastTurnAt bug left real conversations
    // with lastTurnAt===undefined). The disk probe is authoritative, so key
    // the decision off it rather than the proxy.
    const hasTranscript = await this.hasSdkTranscript(meta)
    if (!hasTranscript) {
      if (meta.lastTurnAt) {
        // We once observed a `result` (lastTurnAt set) but the jsonl is now
        // gone — deleted out of band, synced from another machine, etc. The
        // CLI would error with "No conversation found with session ID:
        // <uuid>" the moment we hand it `resume: id`. Mark terminated so the
        // sidebar dims it and the user can clean up.
        this.markTranscriptMissing(meta, 'resume')
        throw new HttpError(
          410,
          `session ${id}'s SDK transcript file is missing on disk — it cannot be resumed. The session has been marked terminated; delete it from the sidebar.`,
        )
      }
      // No transcript AND no completed turn: the session never produced a
      // model reply. The common case is a session that only ran local `!`
      // commands (local-only output never enters the SDK input queue, so no
      // turn / result / transcript is ever written), or one created and
      // never used. The SDK genuinely has nothing to resume, but the
      // session config (cwd / model / permissionMode / grouping) is still
      // valid and the user wants to keep using it — dead-ending it as
      // terminated:'no_data' is a pointless dead end. The `!` output was
      // already lost the moment the session went dormant (it lived only in
      // the in-memory history ring; the SDK transcript never existed and our
      // store keeps metadata only). Respawn a FRESH conversation on the same
      // id (no `resume:`), mirroring clear()'s respawn, so the user gets a
      // working continuation instead of a permanently-dimmed sidebar item.
      return this.respawnFresh(id, meta)
    }
    // Transcript exists → safe to resume even if our lastTurnAt proxy is
    // stale. Fall through to build resumeOpts with `resume: id`.
    const provider = meta.provider ?? this.defaultProvider
    const resumeOpts: Options & { provider?: string; enabledPlugins?: string[] } = {
      provider,
      resume: id,
      cwd: meta.cwd,
      model: meta.model,
      permissionMode: meta.permissionMode,
      title: meta.title,
      // Carry the effort level forward so a resumed session keeps its
      // reasoning depth instead of falling back to the SDK default.
      effort: meta.effortLevel,
      // Carry beta flags forward dwithout this, a 1M-context session
      // silently downgrades to the model's default window on resume.
      // Cast: SDK types this as a literal-string union of known flags,
      // but we store the user-supplied list as plain `string[]` so a
      // newer flag the SDK type hasn't learned about yet still survives.
      betas: meta.betas as Options['betas'],
      settings: meta.hooks ? ({ hooks: toSdkHooksSettings(meta.hooks) } as Settings) : undefined,
      enabledPlugins: meta.enabledPlugins,
    }
    // Re-apply globally configured MCP servers so a resumed session picks up
    // the same tools it had before the restart.  Refresh OAuth tokens for
    // any remote servers BEFORE snapshotting the config so the SDK receives
    // fresh access tokens.
    const allGlobalMcpNames = Object.keys(this.mcpStore.toSdkConfig() ?? {})
    if (allGlobalMcpNames.length > 0) {
      await this.mcpStore.refreshOAuthTokens(allGlobalMcpNames)
      resumeOpts.mcpServers = this.mcpStore.toSdkConfig()
    }
    // Seed the live history ring with the transcript tail from disk. The SDK
    // loads the transcript as context on resume but does NOT re-emit it
    // through the Query stream, so without this the ring stays empty until a
    // new turn lands and the first subscribe replays nothing. We take the
    // newest page (historyCap messages) dsymmetric with a long-lived session
    // whose ring only holds its recent tail; older history is paged in by the
    // client's loadOlder() scroll-up exactly as before. A failed/empty disk
    // read degrades to the old behaviour (empty ring) rather than blocking
    // resume dreadHistoryPage already returns an empty page when the file is
    // absent or unreadable.
    let historySeed: SDKMessage[] | undefined
    try {
      const page = await this.readProviderHistoryPage(provider, id, {
        limit: this.historyCap,
        // Side Chat: exclude the inherited parent prefix (fork boundary) so
        // re-seeding the ring on resume doesn't paint the parent's history.
        ...(meta.forkBoundaryUuid ? { afterUuid: meta.forkBoundaryUuid } : {}),
      })
      if (page.messages.length > 0) historySeed = page.messages as SDKMessage[]
    } catch {
      /* disk read failed dfall back to an empty ring (pre-fix behaviour) */
    }
    return this.spawn(id, resumeOpts, undefined, historySeed)
  }

  /** Respawn a FRESH conversation on an existing session id, discarding any
   *  prior turn-less state. Used by resume() when the session has no SDK
   *  transcript AND never completed a turn — e.g. one that only ran local
   *  `!` commands (whose output never entered the SDK input, so no turn /
   *  result / transcript was ever written). Mirrors clear()'s respawn, but
   *  operates on a DORMANT session (no live Query to tear down first).
   *
   *  Reuses the id, cwd, model, permissionMode, betas, effort, and hooks so
   *  the user keeps the same sidebar entry / grouping; starts a brand-new
   *  SDK conversation under that id (no `resume:`). The prior `!` output is
   *  gone regardless — it lived only in the in-memory ring, already lost at
   *  dormancy.
   *
   *  No `parentId` / Side-Chat systemPrompt is carried: a turn-less Side
   *  Chat that went dormant is an edge case, and carrying parentId would
   *  make the respawned session an orphan (filtered out of the sidebar) and
   *  subject to the abandoned-side-chat GC. Dropping it promotes the session
   *  to a normal, usable one — the safer outcome, consistent with the
   *  spawn()-doesn't-carry-parentId review. */
  private async respawnFresh(id: string, meta: SessionMeta): Promise<SessionInfo> {
    const provider = meta.provider ?? this.defaultProvider
    const freshOpts: Options & { provider?: string; enabledPlugins?: string[] } = {
      provider,
      cwd: meta.cwd,
      model: meta.model,
      permissionMode: meta.permissionMode,
      title: meta.title,
      effort: meta.effortLevel,
      betas: meta.betas as Options['betas'],
      settings: meta.hooks ? ({ hooks: toSdkHooksSettings(meta.hooks) } as Settings) : undefined,
      // Re-inject the persisted plugin subset so a turn-less session that
      // goes dormant keeps its picker selection on respawn (same as
      // resume/fork/clear). Without this, snapshotMeta would capture
      // undefined and writeStore would clobber the persisted subset.
      enabledPlugins: meta.enabledPlugins,
    }
    // Re-apply globally configured MCP servers (same as resume / clear).
    // Refresh OAuth tokens for remote servers BEFORE snapshotting the config
    // so the fresh Query receives live access tokens.
    const allGlobalMcpNames = Object.keys(this.mcpStore.toSdkConfig() ?? {})
    if (allGlobalMcpNames.length > 0) {
      await this.mcpStore.refreshOAuthTokens(allGlobalMcpNames)
      freshOpts.mcpServers = this.mcpStore.toSdkConfig()
    }
    log.info(
      `[session ${id}] respawnFresh: no transcript + no completed turn — ` +
      `starting a fresh conversation on the same id`,
    )
    // spawn() with no `resume:` / `forkSession` sets sessionId=id (a fresh
    // conversation reusing the id) and builds a new canUseTool. The prior
    // persisted meta is read for carry-forward fields (gitStartSha, fastMode,
    // hooks, lastTurnAt=undefined, createdAt) but NOT
    // parentId. No transcript file exists for a turn-less session, so the
    // fresh same-id spawn does not trip the CLI's "Session ID already in
    // use" file-existence guard.
    return this.spawn(id, freshOpts)
  }

  /** Adopt a session that exists on disk but isn't in our store di.e. one
   *  the `claude` CLI created directly. Reads the SDK's transcript metadata
   *  via `getSessionInfo(id)` (no `dir`, so the SDK scans every project dir,
   *  matching its own resume-by-id fallback) and synthesises a SessionMeta
   *  that the normal resume path can consume.
   *
   *  `lastTurnAt` is set to the transcript's `lastModified` (a non-null
   *  value): the file's very existence proves at least one `result` landed,
   *  so the downstream `!meta.lastTurnAt` "no_data" guard must pass. Returns
   *  null when no transcript exists, so the caller falls through to 404. */
  private async adoptDiskSession(id: string, providerName: string): Promise<SessionMeta | undefined> {
    let info: ResumableSession | undefined
    try {
      info = await this.providers.get(providerName).getSessionInfo?.(id)
    } catch (err) {
      log.warn(`[session ${id}] adoptDiskSession(${providerName}): getSessionInfo threw:`, err)
      return undefined
    }
    if (!info) return undefined
    const now = Date.now()
    const meta: SessionMeta = {
      id,
      provider: providerName,
      createdAt: info.createdAt ?? info.lastModified ?? now,
      lastActivityAt: info.lastModified ?? now,
      cwd: info.cwd,
      title: info.title ?? info.firstPrompt,
      messageCount: 0,
      terminated: false,
      // Non-null so the no_data guard passes dthe transcript file existing
      // already proves a completed turn.
      lastTurnAt: info.lastModified ?? now,
    }
    this.store.upsert(meta)
    log.info(`[session ${id}] adopted disk session (cwd=${info.cwd ?? '<none>'}) for resume`)
    return meta
  }

  /** Probe the SDK's on-disk transcript for a session.
   *
   *  `lastTurnAt` only proves *we once observed a `result` for this id in
   *  this process*. It does NOT prove the SDK's `~/.claude/projects/<dir>/
   *  <id>.jsonl` is still on disk dthe user could have deleted the file,
   *  switched machines via a synced sessions.json, etc. Both `fork()` and
   *  `resume()` will hand the SDK a `resume: id` and watch the CLI
   *  subprocess error out with "No conversation found with session ID:
   *  <uuid>" the moment the file is missing.
   *
   *  `getSessionInfo({ dir })` reads exactly the file the CLI would, so
   *  this is the authoritative probe dno need to recreate the SDK's
   *  cwd-encoding ourselves. When `dir` is omitted the SDK scans every
   *  project directory, which matches the CLI's own resume-by-id
   *  fallback. Returns false on any error (file missing, permission
   *  denied, etc.) so callers can refuse the operation uniformly. */
  private async hasSdkTranscript(meta: { id: string; cwd?: string; provider?: string }): Promise<boolean> {
    const providerName = meta.provider ?? this.defaultProvider
    const provider = this.providers.get(providerName)
    if (!provider.hasTranscript) return true
    try {
      const hasTranscript = await provider.hasTranscript(meta as SessionMeta)
      if (!hasTranscript) {
        // Distinguish "file genuinely missing" (info===undefined) from
        // "SDK threw" (caught below). The former is the common case
        // (user/tool deleted the jsonl); the latter is interesting
        // because it means the SDK itself misbehaved and we want a
        // breadcrumb to chase it. Including cwd helps because the SDK
        // encodes the cwd into the on-disk path, so a wrong cwd is the
        // first thing to check next time.
        log.warn(
          `[session ${meta.id}] hasSdkTranscript: getSessionInfo returned undefined ` +
          `(cwd=${meta.cwd ?? '<none>'}) - jsonl is missing on disk`,
        )
      }
      return hasTranscript
    } catch (err) {
      log.warn(
        `[session ${meta.id}] hasSdkTranscript(${providerName}) threw ` +
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
  private markTranscriptMissing(meta: SessionMeta, caller: 'fork' | 'resume' | 'side-chat'): void {
    log.warn(
      `[session ${meta.id}] marking terminated:transcript_missing via ${caller} ` +
      `(cwd=${meta.cwd ?? '<none>'}, lastTurnAt=${meta.lastTurnAt ?? 'none'}, ` +
      `messageCount=${meta.messageCount})`,
    )
    meta.terminated = true
    meta.terminatedReason = 'transcript_missing'
    this.store.upsert(meta)
    this.broadcastGlobal({ kind: 'update', session: this.infoFromMeta(meta) })
  }

  private readProviderHistoryPage(
    providerName: string,
    id: string,
    opts: { before?: number; beforeUuid?: string; limit: number; afterUuid?: string },
  ): Promise<HistoryPage> {
    const provider = this.providers.get(providerName)
    if (!provider.readHistoryPage) {
      throw new HttpError(501, `provider ${providerName} does not support history pagination`)
    }
    return provider.readHistoryPage(id, opts)
  }

  /** Fork a session: spawn a new session whose transcript is initialised
   *  from the source session's on-disk log, but which gets a fresh UUID
   *  so future turns diverge. Implemented via SDK's `options.resume` +
   *  `forkSession: true`. Uses the source's cwd/model/permissionMode by
   *  default; the title is suffixed " (fork)" so sidebars can tell the
   *  two apart at a glance.
   *
   *  Source can be live OR dormant dwe pull metadata from memory first,
   *  persistence second. Terminated sessions can still be forked (their
   *  transcript lives in ~/.claude/projects/ regardless).
   *
   *  Refuses to fork a source whose SDK hasn't completed a turn yet: the
   *  SDK only writes ~/.claude/projects/<cwd>/<id>.jsonl after the first
   *  `result` message, so forking earlier fails with `No conversation
   *  found with session ID: <uuid>` from the CLI. `lastTurnAt` is our
   *  ground-truth signal (set only by the pump on a real `result`). */
  async fork(id: string, opts?: { resumeSessionAt?: string }): Promise<SessionInfo> {
    const live = this.sessions.get(id)
    const meta = live ?? this.store.get(id)
    if (!meta) throw new HttpError(404, `session ${id} not found`)
    if (!meta.lastTurnAt) {
      throw new HttpError(
        400,
        `session ${id} has no completed turns yet dsend at least one message and wait for the reply before forking`,
      )
    }
    // resumeSessionAt (branch-from-a-point) only takes effect with
    // forkSession (empirically verified: --resume-session-at without
    // --fork-session is a no-op, because truncating the persisted history
    // is destructive on a same-id resume but safe on a fork copy). fork()
    // always sets forkSession, so passing resumeSessionAt here is honored.
    // Used by crash-recovery Step 2 to fork from the last completed turn,
    // dropping a poisonous trailing turn.
    // Side Chats are ephemeral, scoped to their parent's conversation, and
    // carry a non-mutating boundary prompt. Forking one would manufacture a
    // sibling-of-Side-Chat session whose `parentId` is dropped (forkOpts does
    // not propagate it), masking it as a normal workspace-mutating session.
    // Refuse at the entry point.
    if (meta.parentId) {
      throw new HttpError(400, `session ${id} is a Side Chat and cannot be forked.`)
    }
    // The lastTurnAt guard above only proves we once saw a `result` in
    // memory; it doesn't prove the SDK's transcript file is still on
    // disk. Without this probe a missing jsonl spawns a doomed Query
    // whose CLI subprocess errors with "No conversation found with
    // session ID: <uuid>" dconfusing for the user (the fork panel
    // opens, then crashes a beat later). Mark the source terminated so
    // the sidebar dims it and the user can clear it out.
    if (!(await this.hasSdkTranscript(meta))) {
      // Mark the persisted meta so reloads / sidebar refreshes show the
      // session as terminated. We don't unload a live source here: the
      // user might still want to scroll its in-memory history one more
      // time, and the next resume attempt will re-trip this same guard.
      const persisted: SessionMeta = this.store.get(id) ?? {
        id: meta.id,
        provider: meta.provider ?? this.defaultProvider,
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
        `session ${id}'s SDK transcript file is missing on disk dit cannot be forked. The session has been marked terminated; delete it from the sidebar.`,
      )
    }
    const title = meta.title ? `${meta.title} (fork)` : undefined
    const sourceProvider = meta.provider ?? this.defaultProvider
    const forkOpts: Options & { provider?: string; enabledPlugins?: string[] } = {
      provider: sourceProvider,
      resume: id,
      forkSession: true,
      cwd: meta.cwd,
      model: meta.model,
      permissionMode: meta.permissionMode,
      title,
      // When branching from a specific point (crash-recovery Step 2),
      // truncate the fork's loaded history to this assistant uuid. Only
      // honored because forkSession is set (see method-header note).
      resumeSessionAt: opts?.resumeSessionAt,
      // Carry effort + beta flags forward so the fork matches the source.
      effort: meta.effortLevel,
      // Same as resume: preserve `context-1m-...` etc. so the fork has
      // the same effective window as the source. See resume() for the cast rationale.
      betas: meta.betas as Options['betas'],
      settings: meta.hooks ? ({ hooks: toSdkHooksSettings(meta.hooks) } as Settings) : undefined,
      enabledPlugins: meta.enabledPlugins,
    }
    // Re-apply globally configured MCP servers (same as resume).
    const allGlobalMcpNames = Object.keys(this.mcpStore.toSdkConfig() ?? {})
    if (allGlobalMcpNames.length > 0) {
      await this.mcpStore.refreshOAuthTokens(allGlobalMcpNames)
      forkOpts.mcpServers = this.mcpStore.toSdkConfig()
    }
    // Inherit the parent's session-level skill override when the source is
    // currently live (override is RAM-only — dormant sources have nothing to
    // copy and the fork falls back to the global policy, same as resume).
    // Pass it through spawn() so the new Query starts with the correct
    // initial skills (Options.skills) and so applyDynamicSkillOverrides
    // below can re-pin the same map at the flag layer if the parent had
    // moved away from `inherit`.
    const parentOverride = live?.skillOverride
    const forkInfo = this.spawn(
      randomUUID(),
      forkOpts,
      undefined,
      undefined,
      parentOverride,
      // Carry the source's pure-UI pref overrides onto the fork so a
      // pinned header / auto-recap override survives forking. No-op when
      // the source inherits global (both undefined) — the fork then
      // inherits global too.
      { showPinnedUserMessage: meta.showPinnedUserMessage, autoRecap: meta.autoRecap },
      // joinGroupOf: the source id — Y joins X's group (append semantics;
      // X stays, since fork doesn't remove the source).
      id,
    )
    if (parentOverride && parentOverride.kind !== 'inherit') {
      // Best-effort — the dynamic flag-layer pin matters mostly when the
      // override switches between sets the SDK loads at boot vs. at flag
      // time. Failures are logged but never block the fork (the user still
      // has a working forked session; we'd rather complete the fork and
      // tell them the override didn't replay than fail the whole call).
      const forked = this.sessions.get(forkInfo.id)
      if (forked) {
        void this.applyDynamicSkillOverrides(forked).catch((err) => {
          log.warn(`[session ${forkInfo.id}] fork: re-applying parent skillOverride failed:`, err)
        })
      }
    }
    // fastMode is runtime state re-applied via applyFlagSettings, not an
    // Options field spawn() reads (it only carries forward from an existing
    // persisted meta, which the fork's brand-new UUID lacks). Re-apply it on
    // the live fork so a fast-mode session stays fast after forking — same
    // workaround clear() uses. Crash-recovery Step 2 forks automatically, so
    // without this a double-crash of a fast-mode session silently drops fast
    // mode. Best-effort: a failure is logged and the fork still completes.
    const sourceFastMode = live?.fastMode ?? meta.fastMode
    if (sourceFastMode) {
      const provider = this.providers.get(sourceProvider)
      if (provider?.capabilities?.supportsFastMode) {
        try {
          await this.setFastMode(forkInfo.id, true)
        } catch (err) {
          log.warn(`[session ${forkInfo.id}] fork: re-applying fastMode failed:`, err)
        }
      }
    }
    return forkInfo
  }

  /** Create a Side Chat — an ephemeral fork of the parent session's
   *  transcript with a boundary prompt that tells the model the inherited
   *  history is reference-only. The Side Chat is a fully independent session
   *  marked with `parentId` so the UI can distinguish it. */
  async createSideChat(parentId: string): Promise<SessionInfo> {
    const live = this.sessions.get(parentId)
    const meta = live ?? this.store.get(parentId)
    if (!meta) throw new HttpError(404, `parent session ${parentId} not found`)
    if (meta.terminated) {
      throw new HttpError(400, 'Cannot create a Side Chat from a terminated session.')
    }
    if (meta.parentId) {
      throw new HttpError(400, 'Cannot create a Side Chat from a Side Chat.')
    }
    // Side Chat forks the parent's SDK transcript (resume + forkSession). The
    // only real precondition is that a transcript exists to fork — and a
    // freshly resumed session always has one (resume itself probes the disk
    // and would have marked it terminated otherwise). `lastTurnAt` is NOT a
    // valid gate here: it's a fallible in-memory proxy stamped only on a real
    // `result`, so a bare resume (system/init, no result) or a session left
    // over from the spawn()-drops-lastTurnAt bug starts with it undefined
    // despite a perfectly good transcript. Gate on the authoritative disk
    // probe instead, mirroring resume(). See session-manager.ts:517-523.
    if (!(await this.hasSdkTranscript(meta))) {
      const persisted: SessionMeta = this.store.get(parentId) ?? {
        id: meta.id,
        provider: meta.provider ?? this.defaultProvider,
        createdAt: meta.createdAt,
        lastActivityAt: meta.lastActivityAt,
        cwd: meta.cwd,
        model: meta.model,
        permissionMode: meta.permissionMode,
        title: meta.title,
        betas: meta.betas,
        messageCount: live ? live.history.length : (meta as SessionMeta).messageCount,
        terminated: true,
        terminatedReason: 'transcript_missing',
        lastTurnAt: meta.lastTurnAt,
        gitStartSha: meta.gitStartSha,
      }
      this.markTranscriptMissing(persisted, 'side-chat')
      throw new HttpError(
        410,
        `Session ${parentId}'s transcript is missing on disk — cannot create a Side Chat. The session has been marked terminated.`,
      )
    }
    const title = meta.title ? `${meta.title} — Side Chat` : 'Side Chat'
    const sourceProvider = meta.provider ?? this.defaultProvider
    // Capture the fork boundary: the parent's newest renderable message uuid
    // at fork time. The fork copies the parent's transcript verbatim into the
    // Side Chat's on-disk file, so this uuid is the last inherited line;
    // everything after it is the Side Chat's own conversation. History reads
    // (getHistoryPage / resume seed / search) pass it as `afterUuid` to keep
    // the inherited parent prefix out of the Side Chat UI (it's reference-only
    // context for the model). A failed read falls back to no boundary
    // (pre-fix behaviour) rather than blocking Side-Chat creation.
    let forkBoundaryUuid: string | undefined
    try {
      const tail = await this.readProviderHistoryPage(sourceProvider, parentId, { limit: 1 })
      forkBoundaryUuid = messageUuid(tail.messages[0])
    } catch {
      /* disk read failed — fall back to no boundary (pre-fix behaviour) */
    }
    const sideChatOpts: Options & {
      provider?: string
      parentId?: string
      forkBoundaryUuid?: string
      enabledPlugins?: string[]
    } = {
      provider: sourceProvider,
      resume: parentId,
      forkSession: true,
      cwd: meta.cwd,
      model: meta.model,
      permissionMode: meta.permissionMode,
      title,
      effort: meta.effortLevel,
      betas: meta.betas as Options['betas'],
      enabledPlugins: meta.enabledPlugins,
      settings: meta.hooks ? ({ hooks: toSdkHooksSettings(meta.hooks) } as Settings) : undefined,
      parentId,
      forkBoundaryUuid,
      // Inject side-chat instructions via the system prompt so the model
      // knows it's in a side conversation from the very first turn — without
      // triggering a boundary turn (which enqueueUserMessage would do).
      // This mirrors Codex's approach of setting developer_instructions in
      // the fork config rather than injecting a user-message boundary.
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: SIDE_DEVELOPER_INSTRUCTIONS,
      },
    }
    // Re-apply globally configured MCP servers (same as fork).
    const allGlobalMcpNames = Object.keys(this.mcpStore.toSdkConfig() ?? {})
    if (allGlobalMcpNames.length > 0) {
      await this.mcpStore.refreshOAuthTokens(allGlobalMcpNames)
      sideChatOpts.mcpServers = this.mcpStore.toSdkConfig()
    }
    return this.spawn(randomUUID(), sideChatOpts)
  }

  /** Fire-and-forget capture of the worktree's HEAD SHA at session spawn.
   *  Extracted from spawn() for readability; only called once per session
   *  (autoResume uses the existing gitStartSha). */
  private captureGitHead(session: Session): void {
    if (!session.gitStartSha && session.cwd) {
      void tryCaptureGitHead(session.cwd).then((sha) => {
        if (!sha || session.terminated || !this.sessions.has(session.id)) return
        session.gitStartSha = sha
        this.writeStore(session)
        this.broadcastGlobal({ kind: 'update', session: this.info(session) })
      }).catch(() => {})
    }
  }

  /** Shared spawn path for create(), resume(), and fork(). */
  private spawn(
    id: string,
    opts: Options & { provider?: string },
    customEnv?: Record<string, string>,
    historySeed?: SDKMessage[],
    skillOverride?: SessionSkillOverride,
    prefs?: { showPinnedUserMessage?: boolean; autoRecap?: boolean },
    /** When this spawn is a fresh Y that should land in an existing session
     *  X's sidebar group, pass X's id here so the `created` broadcast carries
     *  `joinGroupOf: X`. Set by `/clear`, restart, and fork. Append
     *  semantics: the client appends Y to X's group in the same render batch
     *  Y appears — X is NOT removed by this signal (for `/clear`/restart the
     *  POST-driven swapSession / session-removed evicts X afterward; for
     *  fork X stays). This append-then-evict ordering keeps X grouped until
     *  it's actually gone from `sessions`, so neither X nor Y flashes under
     *  "Ungrouped". Undefined for every other caller. */
    joinGroupOf?: string,
  ): SessionInfo {
    const providerName = opts.provider ?? this.defaultProvider
    const provider = this.providers.get(providerName)
    const fullOpts: Options & { provider?: string } = { ...opts, provider: providerName }
    const requestedMode = fullOpts.permissionMode

    // Forward only `plan` to the SDK (see sdkForwardMode): plan needs
    // SDK-level read-only model steering that canUseTool can't replicate. All
    // other modes are enforced by our own canUseTool, so they map to undefined
    // (no SDK-side mode). The session's own `permissionMode` field (set below)
    // stays the source of truth for canUseTool and the UI.
    fullOpts.permissionMode = requestedMode

    if (!fullOpts.resume || fullOpts.forkSession) {
      fullOpts.sessionId = id
    }

    const existingMeta = this.store.get(id)
    const createdAt = existingMeta?.createdAt ?? Date.now()
    const metaSnapshot = this.snapshotMeta(fullOpts, providerName)

    const session: Session = {
      id,
      createdAt,
      lastActivityAt: Date.now(),
      ...metaSnapshot,
      permissionMode: requestedMode,
      handle: undefined as unknown as ProviderSessionHandle,
      canUseTool: undefined,
      subscribers: new Map(),
      permissionSubscribers: new Map(),
      pending: new Map(),
      // Seed the in-memory ring with the on-disk transcript tail on resume.
      // A normally-running session maintains the invariant "history holds the
      // session's recent messages"; a resumed session starts with an empty
      // ring because the SDK loads the transcript as CONTEXT and never
      // re-emits it through the Query stream. Without this seed, the first
      // subscribe replays nothing and the client shows a blank transcript
      // until a new turn lands. Seeding here dbefore the pump starts and the
      // session enters the map drestores the invariant so replay / reconnect
      // / second-panel subscribe all see the history with zero client-side
      // special-casing. readHistoryPage already normalizes to the live wire
      // shape (see history-reader.ts), so seeded and live frames are
      // indistinguishable downstream.
      history: historySeed ? historySeed.slice(-this.historyCap) : [],
      contextUsageSubscribers: new Set(),
      lastContextUsage: undefined,
      gitStatusSubscribers: new Set(),
      messageStatusSubscribers: new Set(),
      commandSubscribers: new Set(),
      hookRuns: [],
      hookRunSubscribers: new Set(),
      recapSubscribers: new Set(),
      sessionClearedSubscribers: new Set(),
      pumpTask: Promise.resolve(),
      running: true,
      terminated: false,
      pendingTurns: 0,
      // Preserve gitStartSha across resumes dthe persisted meta carries
      // it forward so the "This session" anchor stays stable even if the
      // server restarts. New sessions get a fresh capture below.
      gitStartSha: existingMeta?.gitStartSha,
      fastMode: existingMeta?.fastMode,
      // Pure-UI pref overrides. An explicit `prefs` arg (fork / clear
      // carrying the source's overrides onto a new id) wins; otherwise
      // restore from the persisted meta so a resumed session keeps its
      // override instead of silently reverting to the global default
      // (and then having writeStore() clobber the persisted value).
      // `??` (not `||`) so an explicit `false` override survives.
      showPinnedUserMessage: prefs?.showPinnedUserMessage ?? existingMeta?.showPinnedUserMessage,
      autoRecap: prefs?.autoRecap ?? existingMeta?.autoRecap,
      hooks: existingMeta?.hooks ?? metaSnapshot.hooks,
      // Carry lastTurnAt forward from the persisted meta on resume. The
      // pump only stamps `lastTurnAt` when a real `result` lands
      // (session-pump.ts); a bare resume emits system/init but NO result,
      // so without this the resurrected session starts with
      // lastTurnAt === undefined. writeStore() below is a wholesale
      // replace (not a merge), so it would then overwrite the on-disk
      // lastTurnAt with undefined — and the NEXT resume (after the
      // session goes dormant again without a new completed turn) trips
      // the `!meta.lastTurnAt` "the first turn never completed" guard in
      // resume() and marks the session terminated. create()/fork() pass
      // a fresh id (no existingMeta) so this stays undefined for them.
      lastTurnAt: existingMeta?.lastTurnAt,
      // Side Chat parentId — set here so the `created` broadcast already
      // carries the field, avoiding a sidebar flash of the session without it.
      parentId: (opts as Record<string, unknown>).parentId as string | undefined,
      // Side Chat fork boundary uuid — captured by createSideChat so history
      // reads can exclude the inherited parent prefix via `afterUuid`.
      forkBoundaryUuid: (opts as Record<string, unknown>).forkBoundaryUuid as string | undefined,
      // Seed the session-level skill override. RAM-only — fork() passes
      // the parent's value through; create()/resume() pass undefined and
      // fall back to the global config via the spawn-time projection
      // below. Stored on the Session so info()/persist() can broadcast it
      // and so applyDynamicSkillOverrides can re-apply on later switches.
      skillOverride,
    }

    if (!fullOpts.canUseTool) {
      const canUseTool = this.permBroker.buildCanUseTool(
        session,
        (s, snapshot) => {
          // Global broadcast dfor desktop notifications on dormant sessions
          this.broadcastGlobal({ kind: 'permission_request', sessionId: s.id, request: snapshot })
        },
        // Pending count changed (enqueue / timeout / abort). Rebroadcast
        // the SessionInfo so the sidebar's pendingPermissionCount badge
        // updates. Skip if the session was unloaded mid-flight dinfo(s)
        // would still work but the broadcast would race the `removed`.
        (s) => {
          if (!this.sessions.has(s.id)) return
          this.broadcastGlobal({ kind: 'update', session: this.info(s) })
        },
      )
      session.canUseTool = canUseTool
      fullOpts.canUseTool = canUseTool
    } else {
      session.canUseTool = fullOpts.canUseTool as Session['canUseTool']
    }

    const sdkOptions = { ...applySkillPolicyToOptions(fullOpts, skillOverride) } as Options & { provider?: string }
    delete sdkOptions.provider
    // Strip the app-level plugin selection so it doesn't reach the SDK:
    // Options.enabledPlugins is a {[k:string]: string[]|boolean|object} MAP
    // (plugin@marketplace → enabled flag), but we carry a string[] of keys
    // for our own subset resolution. The SDK only needs Options.plugins
    // (resolved paths, set by applyStandardQueryOpts via the provider).
    delete (sdkOptions as { enabledPlugins?: unknown }).enabledPlugins
    const handle = provider.createSession({
      id,
      provider: providerName,
      cwd: fullOpts.cwd,
      model: fullOpts.model,
      permissionMode: requestedMode,
      title: fullOpts.title,
      betas: Array.isArray(fullOpts.betas) ? fullOpts.betas : undefined,
      effortLevel: session.effortLevel,
      fastMode: session.fastMode,
      env: customEnv,
      mcpServers: fullOpts.mcpServers as Record<string, unknown> | undefined,
      enabledPlugins: (fullOpts as { enabledPlugins?: string[] }).enabledPlugins ?? existingMeta?.enabledPlugins,
      includePartialMessages: fullOpts.includePartialMessages,
      includeHookEvents: true,
      resume: fullOpts.resume,
      forkSession: fullOpts.forkSession,
      onUserMessageConsumed: (msg) => this.onInputConsumed(id, msg as SDKUserMessage),
      canUseTool: fullOpts.canUseTool as ((...args: unknown[]) => Promise<unknown>) | undefined,
      providerExtras: { sdkOptions },
    })
    session.handle = handle

    session.pumpTask = this.pump(session)
    this.sessions.set(id, session)
    log.info(`[session ${id}] spawned model=${fullOpts.model ?? 'default'}, permissionMode=${requestedMode ?? 'default'}, resume=${!!fullOpts.resume}`)
    // Classify the model's effort capability (keyword-based, synchronous) so
    // the very first `created` frame below already carries the correct
    // visible/levels state dno follow-up update needed.
    session.effortLevels = effortLevelsForModel(session.model)
    // Brand-new session (or a resume, which also "creates" as far as the
    // UI list is concerned): persist to disk, then broadcast `created`
    // instead of `update`. The frontend `created` handler is the one
    // that knows how to insert, so there's a single canonical origin
    // for the row dno races with the POST /sessions response.
    this.writeStore(session)
    // `joinGroupOf` (set by /clear, restart, fork) is conditionally spread so
    // the wire frame stays clean (no `undefined` key) for plain creates.
    this.broadcastGlobal({
      kind: 'created',
      session: this.info(session),
      ...(joinGroupOf ? { joinGroupOf } : {}),
    })
    this.captureGitHead(session)

    // [DEBUG MCP] Log the MCP servers passed to the SDK at spawn time, then
    // probe context-usage (with retries) to report isLoaded for each tool.
    const spawnMcpNames = fullOpts.mcpServers ? Object.keys(fullOpts.mcpServers as Record<string, unknown>) : []
    if (spawnMcpNames.length > 0) {
      log.info(`[session ${id}] [DEBUG MCP] spawn mcpServers=[${spawnMcpNames.join(', ')}]`)
      void this.debugLogMcpToolLoadState(id, spawnMcpNames, 3000).catch(() => {})
    }

    return this.info(session)
  }

  /** Send a user turn into an existing session. */
  send(id: string, text: string): SDKUserMessage {
    const s = this.requireSendable(id)
    // Note: the `/clear` slash command is intercepted client-side by
    // src/local-commands.ts, which POSTs /sessions/:id/clear instead of
    // routing through this method (the headless `claude` binary refuses
    // /clear, so we drive the context reset ourselves; see clear()).
    const userMsg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      uuid: randomUUID(),
      session_id: s.id,
    }
    log.debug(
      `[session ${id}] send PRE-PUSH d${text.length} chars, uuid=${userMsg.uuid}, ` +
      `pendingTurns=${s.pendingTurns}, input.closed=${s.handle.closed}, ` +
      `input.queueDepth=${s.handle.queueDepth}, ` +
      `running=${s.running}, terminated=${s.terminated}`,
    )
    this.dispatchUserMessage(s, userMsg)
    return userMsg
  }

  /** Send a user turn with a content array (text + image blocks). */
  sendContent(id: string, content: Array<{ type: string; [k: string]: unknown }>): SDKUserMessage {
    const s = this.requireSendable(id)
    const userMsg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content } as unknown as SDKUserMessage['message'],
      parent_tool_use_id: null,
      uuid: randomUUID(),
      session_id: s.id,
    }
    const blockSummary = content.map((b) => b.type).join('+')
    log.debug(
      `[session ${id}] sendContent PRE-PUSH dblocks=[${blockSummary}], uuid=${userMsg.uuid}, ` +
      `pendingTurns=${s.pendingTurns}, input.closed=${s.handle.closed}`,
    )
    this.dispatchUserMessage(s, userMsg)
    return userMsg
  }

  /** Shared tail for send() and sendContent(): push into the SDK input
   *  queue and broadcast to live subscribers.
   *
   *  The Pushable's onConsume callback stamps `consumedAt` on whatever
   *  object it receives.  When the SDK is idle (waiter active), that
   *  stamp fires synchronously during enqueueUserMessage dBEFORE
   *  pushToSession broadcasts the message to clients.  Without the copy
   *  the broadcast arrives already carrying consumedAt, so the client
   *  derives deliveryStatus='consumed' immediately and the 'queued'
   *  state is never visible, even when the message genuinely sat in the
   *  queue behind an in-flight turn.
   *
   *  Pushing a shallow clone to the SDK isolates the mutation: the copy
   *  gets consumedAt (visible to the SDK and to the onInputConsumed
   *  callback that broadcasts the live message-consumed frame), while
   *  the original stays clean for pushToSession.  The history ring holds
   *  the original; a reconnecting client still sees consumedAt via the
   *  stampConsumedAt fallback in history-utils. */
  private dispatchUserMessage(s: Session, userMsg: SDKUserMessage): void {
    s.handle.enqueueUserMessage({ ...userMsg })
    this.pushToSession(s, userMsg)
  }

  /** Common bookkeeping after pushing a user message into a session:
   *  record in history, cap the ring buffer, broadcast to subscribers,
   *  update timestamps, reset auto-resume counter, and persist. */
  private pushToSession(s: Session, userMsg: SDKUserMessage): void {
    // Broadcast + record locally dthe SDK's output stream doesn't echo
    // user messages back, so without this step the client would never
    // see its own sent text.
    stampReceivedAt(userMsg)
    pushBounded(s.history, userMsg, this.historyCap)
    for (const sub of s.subscribers.values()) sub.push(userMsg)
    s.lastActivityAt = Date.now()
    // Mark the session as mid-turn. We cap at 1 (not a true counter)
    // because the SDK may merge multiple queued user messages into fewer
    // assistant turns da true count would inflate permanently. The pump
    // resets to 1 after each result if more items are still queued.
    if (s.pendingTurns === 0) s.workingSince = Date.now()
    if (s.pendingTurns < 1) s.pendingTurns = 1
    // User is actively interacting dreset the auto-resume counter so a
    // future idle timeout gets fresh attempts.
    this.autoResumeCounts.delete(s)
    // NOTE: crash-recovery counts are intentionally NOT reset here. Resetting
    // on every user message defeated escalation for a poisonous turn that
    // crashes the CLI on the model's response (but loads fine on resume):
    // each send reset the counter, so the cycle stayed at Step 1 forever and
    // never reached the Step 2 fork that drops the poisonous content. The
    // ladder resets only on proven health (a clean idle-autoResume after
    // recovery — see autoResume()).
    // Invalidate the stored recap da new message means it's stale.
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
    log.info(
      `[session ${id}] interrupt requested dpendingTurns=${s.pendingTurns}, ` +
      `pending perms=${s.pending.size}, ` +
      `workingFor=${s.workingSince ? Date.now() - s.workingSince : 0}ms`,
    )
    try {
      await this.requireHandleMethod<() => Promise<void>>(
        s,
        'interrupt',
        'interrupt',
        'supportsInterrupt',
      )()
      log.info(`[session ${id}] interrupt() resolved in ${Date.now() - startedAt}ms`)
    } catch (err) {
      log.error(`[session ${id}] interrupt() threw after ${Date.now() - startedAt}ms:`, err)
      throw err
    }
    s.lastActivityAt = Date.now()
    this.persist(s)
  }

  /** `!` bash mode — run a shell command directly in the session's cwd.
   *
   *  Two sharing modes (Option D):
   *  - `share: false` (`!cmd`) — LOCAL ONLY. The result is broadcast to the
   *    client (so the user sees it in the transcript) but is NOT pushed into
   *    the SDK input queue. Zero model round-trips, zero spurious turns.
   *    The model never sees this command's output. This is the default and
   *    matches `!` mode's design intent: run a command without consuming the
   *    model.
   *  - `share: true` (`!!cmd`) — SHARE WITH MODEL. The result is injected
   *    via dispatchUserMessage so the model sees it on the next turn. This
   *    triggers a real model turn (the model will respond to the command
   *    output), which is the user's explicit intent with `!!`.
   *
   *  Why not inject-then-interrupt (Option C): on slow API backends the
   *  interrupt resolves before the in-flight API request is actually
   *  cancelled, so the spurious turn leaks ~TTFW later. Local-only avoids
   *  the race entirely.
   *
   *  The command runs UNSANDBOXED in the user's shell (pipes/redirects/globs
   *  work). The route-level `confirm` gate is the guardrail, not this method. */
  async execInSession(
    id: string,
    command: string,
    opts: { onProgress?: (line: string) => void; share?: boolean } = {},
  ): Promise<{
    stdout: string
    stderr: string
    exitCode: number | null
    interrupted: boolean
    truncated: boolean
    message: SDKUserMessage
  }> {
    const s = this.requireRunnable(id)
    const cwd = s.cwd
    if (!cwd) throw new HttpError(400, 'session has no cwd — cannot run a shell command')
    const share = opts.share ?? false
    log.info(`[session ${id}] exec${share ? ' (shared)' : ' (local)'}: ${command.slice(0, 120)}`)
    // Park an AbortController on the session so the /exec/abort route can
    // SIGKILL the child mid-run (the "stop" button on the bash card). Cleared
    // in the finally below. `!` is serial so at most one exec is in flight.
    const controller = new AbortController()
    s.execAbort = controller
    let result
    try {
      result = await execCommand(cwd, command, {
        onProgress: opts.onProgress,
        signal: controller.signal,
      })
    } finally {
      if (s.execAbort === controller) s.execAbort = undefined
    }
    // Build the synthetic user message with <bash-*> tags (mirrors Claude
    // Code's format). <bash-exit> lets the renderer show a status badge
    // without a separate WS channel.
    const exitTag = `<bash-exit code="${result.exitCode ?? -1}"${result.interrupted ? ' interrupted="true"' : ''}${result.truncated ? ' truncated="true"' : ''} />`
    const text =
      `<bash-input>${escapeXml(command)}</bash-input>\n` +
      `${exitTag}\n` +
      `<bash-stdout>${escapeXml(result.stdout)}</bash-stdout>` +
      (result.stderr ? `\n<bash-stderr>${escapeXml(result.stderr)}</bash-stderr>` : '')
    const userMsg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      uuid: randomUUID(),
      session_id: s.id,
    }
    if (share) {
      // `!!` — inject into the SDK transcript so the model sees the output.
      // This triggers a model turn (intentional — the user asked to share).
      this.dispatchUserMessage(s, userMsg)
    } else {
      // `!` — local only: record in our history ring + broadcast to live
      // subscribers, but NEVER push into the SDK input queue. The model
      // never sees this command; zero spurious turns.
      this.pushToSession(s, userMsg)
      // pushToSession marks the session mid-turn (pendingTurns=1, workingSince)
      // expecting an SDK `result` to clear it — but the local path triggers no
      // SDK turn, so no result ever arrives. Reset immediately: a local `!`
      // command is done the moment its output is broadcast, and leaving
      // working=true would stick the UI (WorkingBubble, header dot) forever
      // and trip the stuck-session health check after the idle timeout.
      s.pendingTurns = 0
      s.workingSince = undefined
      this.broadcastGlobal({ kind: 'update', session: this.info(s) })
    }
    return { ...result, message: userMsg }
  }

  /** Force-stop the current in-flight `!`/`!!` command (SIGKILL the child),
   *  like Ctrl+C in a terminal. No-op when no command is running on the
   *  session — mirroring interrupt()'s tolerance for "nothing to stop".
   *  Aborting fires execCommand's onAbort → finish({interrupted:true}); the
   *  still-running execInSession then completes normally and injects the
   *  interrupted result as a <bash-exit interrupted="true"> message, so the
   *  client needs no special handling. */
  abortExec(id: string): void {
    const s = this.sessions.get(id)
    s?.execAbort?.abort()
  }

  /** `/clear` — non-destructive context reset.
   *
   *  The headless `claude` binary refuses the `/clear` slash command (it's a
   *  REPL-only feature in non-interactive mode), so we drive the reset
   *  ourselves. Rather than destroy the pre-clear conversation P1, we spawn a
   *  **brand-new fresh conversation Y under a new id** in this tab and detach
   *  X. P1's on-disk transcript is ALWAYS left intact so resume(X) re-adopts
   *  it and recovers the conversation; the cleared tab gets a clean slate.
   *
   *  X is REMOVED from the store + broadcasts `removed` so it leaves the
   *  sidebar — /clear should not leave a dormant clone cluttering the list.
   *  Mental model: "spawn fresh Y + unload X (removed, transcript kept)".
   *  This mirrors how the `claude` CLI treats /clear (a new session) and
   *  aligns with fork()/create().
   *
   *  No `session-cleared` frame is emitted for this — Y is a fresh session
   *  with no pre-clear content to hide, so the client simply swaps the panel
   *  from X to Y. (The `session-cleared` frame still has a second producer —
   *  the SDK's own in-band `cleared` control event — so the client handler
   *  stays; only clear() stops emitting it.)
   *
   *  Idempotent: a second clear() while one is already in flight returns the
   *  current SessionInfo without re-driving the lifecycle. */
  async clear(id: string): Promise<SessionInfo> {
    const s = this.requireRunnable(id)
    if (s.clearing) return this.info(s)

    s.clearing = true
    log.info(`[session ${id}] clear: detaching pre-clear conversation`)
    try {
      // Resolve any pending tool-permission requests so SDK awaiters
      // don't hang once we destroy the handle.
      this.permBroker.denyAll(s)

      // Drain any in-flight assistant turn or queued user input. The
      // interrupt lands against the OLD Query; its result frame won't
      // matter once we unload, but interrupting first lets the SDK exit
      // cleanly instead of mid-API-call.
      if (s.pendingTurns > 0 || s.handle.queueDepth > 0) {
        try {
          await this.requireHandleMethod<() => Promise<void>>(
            s,
            'interrupt',
            'interrupt',
            'supportsInterrupt',
          )()
        } catch (err) {
          log.warn(`[session ${id}] clear: interrupt before detach failed:`, err)
        }
      }
      s.handle.clearQueuedInput?.()

      // Capture the settings to clone into the fresh session BEFORE unloading
      // X (unload destroys the handle and removes X from the live map).
      const settings = {
        provider: s.provider,
        cwd: s.cwd,
        model: s.model,
        permissionMode: s.permissionMode,
        title: s.title,
        effortLevel: s.effortLevel,
        betas: s.betas,
        hooks: s.hooks,
        fastMode: s.fastMode,
        enabledPlugins: s.enabledPlugins,
        parentId: s.parentId,
        // Carry X's session-level skill override onto Y so a pinned restrictive
        // policy survives /clear. fork() forwards this via its 5th spawn() arg;
        // clear() must do the same or Y silently falls back to the global
        // (possibly permissive) policy.
        skillOverride: s.skillOverride,
      }

      // Spawn a fresh session Y under a new id, same settings, no `resume:`.
      // spawn() persists Y, broadcasts `created`, and starts its pump. Side
      // Chat sessions re-inject SIDE_DEVELOPER_INSTRUCTIONS so the boundary
      // survives — same logic as the old respawn.
      const freshOpts: Options & { provider?: string; enabledPlugins?: string[] } = {
        provider: settings.provider,
        cwd: settings.cwd,
        model: settings.model,
        permissionMode: settings.permissionMode,
        title: settings.title,
        effort: settings.effortLevel,
        betas: settings.betas as Options['betas'],
        settings: settings.hooks ? ({ hooks: toSdkHooksSettings(settings.hooks) } as Settings) : undefined,
        enabledPlugins: settings.enabledPlugins,
      }
      if (settings.parentId) {
        freshOpts.systemPrompt = {
          type: 'preset',
          preset: 'claude_code',
          append: SIDE_DEVELOPER_INSTRUCTIONS,
        }
        ;(freshOpts as Options & { parentId?: string }).parentId = settings.parentId
      }
      const allGlobalMcpNames = Object.keys(this.mcpStore.toSdkConfig() ?? {})
      if (allGlobalMcpNames.length > 0) {
        await this.mcpStore.refreshOAuthTokens(allGlobalMcpNames)
        freshOpts.mcpServers = this.mcpStore.toSdkConfig()
      }
      // spawn() builds a fresh canUseTool for Y (permBroker.buildCanUseTool),
      // so we do NOT reuse X's canUseTool closure — Y gets its own permission
      // tracker. spawn() also applies the skill policy to sdkOptions.
      //
      // Spawn Y BEFORE unloading X: if spawn() throws (invalid resolved
      // options, provider createSession rejecting, mpStore path resolution
      // throwing), X is still live and runnable — the finally resets
      // s.clearing and the tab keeps its session. Unloading X first would
      // orphan the tab (X gone from the map, Y never registered). This also
      // keeps the `s.clearing` idempotency guard effective for the whole
      // spawn+fastMode window: a concurrent second clear(id) returns X's info
      // instead of racing into a 404 once X is removed.
      const newY = this.spawn(
        randomUUID(),
        freshOpts,
        undefined,
        undefined,
        settings.skillOverride,
        undefined,
        id,
      )
      const newYId = newY.id

      // fastMode is runtime state re-applied via applyFlagSettings, not an
      // Options field spawn() reads (it only carries forward from an existing
      // persisted meta, which Y lacks). Re-apply it on the live Y so a fast-
      // mode session stays fast after /clear. Best-effort: a failure is logged
      // and the clear still completes (Y is usable, just without fast mode).
      if (settings.fastMode) {
        const provider = this.providers.get(settings.provider)
        if (provider?.capabilities?.supportsFastMode) {
          try {
            await this.setFastMode(newYId, true)
          } catch (err) {
            log.warn(`[session ${newYId}] clear: re-applying fastMode failed:`, err)
          }
        }
      }

      // Detach X now that Y is live. unload() destroys the live Query (the
      // subprocess exits asynchronously, releasing the transcript file
      // handle), marks the session not-running, and removes it from the live
      // map. The transcript file is NEVER touched — P1 survives on disk so
      // resume(X) re-adopts it via adoptDiskSession and recovers the pre-clear
      // conversation.
      //
      // removeFromStore drops X from sessions.json + broadcasts `removed` so it
      // leaves the sidebar — /clear should not leave a dormant clone cluttering
      // the list. The trade-off is resume(X) loses app-level config (model/
      // permissionMode/plugins/hooks/skillOverride), rebuilt from SDK disk
      // metadata by adoptDiskSession; the conversation content is intact, which
      // is the valuable part. (Side Chats can't be /clear'd from the UI — their
      // composer bypasses local-command processing — so the parentId branch is
      // defensive only; if side-chat /clear is ever wired, Y still inherits
      // parentId via the freshOpts block above.)
      await this.unload(id, { removeFromStore: true })

      log.info(`[session ${id}] clear: detached (fresh session=${newYId})`)
      return newY
    } finally {
      s.clearing = false
    }
  }

  async setModel(id: string, model?: string): Promise<SessionInfo> {
    const s = this.requireLive(id)
    await this.requireHandleMethod<(model?: string) => Promise<void>>(
      s,
      'setModel',
      'model switching',
      'supportsModelSwitch',
    )(model)
    s.model = model
    s.lastActivityAt = Date.now()
    // The model changed drecompute its effort capability (keyword-based,
    // synchronous). The persist() below broadcasts the session-update
    // carrying the new effortLevels.
    s.effortLevels = effortLevelsForModel(s.model)
    this.persist(s)
    return this.info(s)
  }

  /** Rename a session. Accepts both live and dormant sessions (title is
   *  pure UI metadata dno SDK call needed). Empty string / whitespace
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
    const s = this.requireLive(id)
    // Local state is updated FIRST and unconditionally dit is the source of
    // truth for canUseTool and the UI, and guarantees the switch never fails
    // (including dbypassPermissions, which the SDK refuses mid-session).
    s.permissionMode = mode
    s.lastActivityAt = Date.now()
    // Forward to the SDK so its read-only `plan` steering engages / disengages.
    //   - switching INTO plan  dforward 'plan'
    //   - switching OUT of plan (forwarded === undefined) dforward 'default'
    //     to explicitly release the SDK's plan lock. Sending nothing would
    //     leave the model stuck in read-only mode.
    // All non-plan modes (acceptEdits/bypass/default/auto/dontAsk) resolve to
    // 'default' here and are enforced by canUseTool instead. Any SDK error is
    // swallowed: local state already took effect, so the switch never fails.
    const forwarded = mode === 'plan' ? 'plan' : 'default'
    try {
      await this.requireHandleMethod<(mode: string) => Promise<void>>(
        s,
        'setPermissionMode',
        'permission mode switching',
        'supportsFineGrainedPermissions',
      )(forwarded)
    } catch (err) {
      log.warn(
        `[session ${id}] SDK setPermissionMode(${forwarded ?? 'default'}) failed; ` +
        `mode kept locally and enforced via canUseTool:`,
        err,
      )
    }
    this.persist(s)
    return this.info(s)
  }

  async applySettings(id: string, settings: Settings): Promise<SessionInfo> {
    const s = this.requireLive(id)
    const forwarded = settings && typeof settings === 'object' && !Array.isArray(settings)
      ? { ...(settings as Record<string, unknown>) }
      : {}
    const hooksResult = 'hooks' in forwarded
      ? validateSessionHooksConfig(forwarded.hooks ?? {})
      : null
    let normalizedHooks: SessionHooksConfig | undefined
    if (hooksResult && !hooksResult.ok) {
      throw new HttpError(400, `invalid hooks settings: ${formatHooksValidationErrors(hooksResult.errors)}`)
    }
    if (hooksResult?.ok) {
      normalizedHooks = emptyHooksConfig(hooksResult.value) ? {} : hooksResult.value
      forwarded.hooks = toSdkHooksSettings(normalizedHooks)
    }
    await this.requireHandleMethod<(settings: Record<string, unknown>) => Promise<void>>(
      s,
      'applyFlagSettings',
      'flag settings',
    )(forwarded)
    if (normalizedHooks) s.hooks = normalizedHooks
    s.lastActivityAt = Date.now()
    this.persist(s)
    return this.info(s)
  }

  getHooks(id: string): { hooks: SessionHooksConfig; runs: HookRunRecord[] } {
    const s = this.sessions.get(id)
    if (s) return { hooks: s.hooks ?? {}, runs: s.hookRuns.slice() }
    const meta = this.store.get(id)
    if (!meta) throw new HttpError(404, `session ${id} not found`)
    return { hooks: meta.hooks ?? {}, runs: [] }
  }

  async applyHooks(id: string, hooks: SessionHooksConfig): Promise<{ session: SessionInfo; hooks: SessionHooksConfig }> {
    const s = this.requireLive(id)
    const normalized = emptyHooksConfig(hooks) ? {} : hooks
    await this.requireHandleMethod<(settings: Record<string, unknown>) => Promise<void>>(
      s,
      'applyFlagSettings',
      'hooks',
    )({ hooks: toSdkHooksSettings(normalized) })
    s.hooks = normalized
    s.lastActivityAt = Date.now()
    this.persist(s)
    return { session: this.info(s), hooks: normalized }
  }

  /** Toggle fast mode for a session. Forwards the intent to the SDK via
   *  applyFlagSettings({ fastMode }) and records it locally so it survives
   *  resume/restart (re-applied on respawn). The SDK reports the actual
   *  runtime state (off/cooldown/on) back through messages, which the pump
   *  parses into s.fastModeState dso we do NOT optimistically set the
   *  runtime state here. */
  async setFastMode(id: string, enabled: boolean): Promise<SessionInfo> {
    const s = this.requireLive(id)
    await this.requireHandleMethod<(settings: Record<string, unknown>) => Promise<void>>(
      s,
      'applyFlagSettings',
      'fast mode',
      'supportsFastMode',
    )({ fastMode: enabled })
    s.fastMode = enabled
    s.lastActivityAt = Date.now()
    this.persist(s)
    return this.info(s)
  }

  /** Set per-session UI prefs (pinned-header + auto-recap overrides).
   *  Unlike setFastMode / setEffortLevel these are PURE UI prefs — no
   *  applyFlagSettings round-trip to the SDK. A value of `undefined`
   *  clears the override so the session re-inherits the global default;
   *  a boolean pins it. Persisted so it survives resume / fork / reload. */
  async setPrefs(
    id: string,
    partial: { showPinnedUserMessage?: boolean | undefined; autoRecap?: boolean | undefined },
  ): Promise<SessionInfo> {
    const s = this.requireLive(id)
    if ('showPinnedUserMessage' in partial) {
      s.showPinnedUserMessage = partial.showPinnedUserMessage
    }
    if ('autoRecap' in partial) {
      s.autoRecap = partial.autoRecap
    }
    s.lastActivityAt = Date.now()
    this.persist(s)
    return this.info(s)
  }

  /** Set the reasoning effort level. Forwards to the SDK via
   *  applyFlagSettings({ effortLevel }) and records it locally so it survives
   *  resume/restart (re-applied on respawn). Unsupported levels for the
   *  current model are silently downgraded by the SDK dno error. The
   *  Settings.effortLevel typedef omits 'max', so we cast through to keep all
   *  5 levels (the API and supportedEffortLevels both list 'max'). */
  async setEffortLevel(id: string, level: EffortLevel): Promise<SessionInfo> {
    const s = this.requireLive(id)
    await this.requireHandleMethod<(settings: Record<string, unknown>) => Promise<void>>(
      s,
      'applyFlagSettings',
      'effort level',
      'supportsEffortLevel',
    )({ effortLevel: level as 'low' | 'medium' | 'high' | 'xhigh' })
    s.effortLevel = level
    s.lastActivityAt = Date.now()
    this.persist(s)
    return this.info(s)
  }

  async togglePlugin(id: string, pluginName: string, enabled: boolean): Promise<SessionInfo> {
    const s = this.requireLive(id)
    await this.requireHandleMethod<(settings: Record<string, unknown>) => Promise<void>>(
      s,
      'applyFlagSettings',
      'plugins',
      'supportsPlugins',
    )({ enabledPlugins: { [pluginName]: enabled } })
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
   *  can delay control_response deither way the call (and the HTTP
   *  request behind it) hangs with no SDK-side timeout. We don't time it
   *  out here (callers/UI handle that), but we DO measure every call so a
   *  slow init window or wedged subprocess is visible in the logs and can
   *  be correlated with a recent spawn / auto-resume. */
  private async timeSdkControl<T>(id: string, label: string, fn: () => Promise<T>): Promise<T> {
    const startedAt = Date.now()
    try {
      const result = await fn()
      const ms = Date.now() - startedAt
      // Only the slow ones are interesting da healthy control round-trip
      // is single-digit ms. Warn above 1s so the noise floor stays low.
      if (ms >= 1000) {
        log.warn(`[session ${id}] SDK ${label} resolved in ${ms}ms (slow dcheck init handshake / subprocess)`)
      } else {
        log.debug(`[session ${id}] SDK ${label} resolved in ${ms}ms`)
      }
      return result
    } catch (err) {
      log.error(`[session ${id}] SDK ${label} rejected after ${Date.now() - startedAt}ms:`, err)
      throw err
    }
  }

  async supportedModels(id: string) {
    const s = this.requireLive(id)
    const fn = this.requireHandleMethod<() => Promise<unknown>>(s, 'supportedModels', 'supported models')
    return this.timeSdkControl(id, 'supportedModels', fn)
  }

  async supportedCommands(id: string) {
    const s = this.requireLive(id)
    const fn = this.requireHandleMethod<() => Promise<unknown>>(
      s,
      'supportedCommands',
      'supported commands',
      'supportsCommands',
    )
    return this.timeSdkControl(id, 'supportedCommands', fn)
  }

  async supportedAgents(id: string) {
    const s = this.requireLive(id)
    const fn = this.requireHandleMethod<() => Promise<unknown>>(
      s,
      'supportedAgents',
      'supported agents',
      'supportsAgents',
    )
    return this.timeSdkControl(id, 'supportedAgents', fn)
  }

  async mcpServerStatus(id: string) {
    const s = this.requireLive(id)
    const fn = this.requireHandleMethod<() => Promise<unknown>>(
      s,
      'mcpServerStatus',
      'MCP status',
      'supportsMcp',
    )
    return this.timeSdkControl(id, 'mcpServerStatus', fn)
  }

  async reconnectMcpServer(id: string, serverName: string): Promise<void> {
    const s = this.requireLive(id)
    await this.requireHandleMethod<(name: string) => Promise<void>>(
      s,
      'reconnectMcpServer',
      'MCP reconnect',
      'supportsMcp',
    )(serverName)
  }

  async toggleMcpServer(id: string, serverName: string, enabled: boolean): Promise<void> {
    const s = this.requireLive(id)
    await this.requireHandleMethod<(name: string, enabled: boolean) => Promise<void>>(
      s,
      'toggleMcpServer',
      'MCP toggle',
      'supportsMcp',
    )(serverName, enabled)
  }

  /** Add/remove MCP servers on a live session via the SDK's setMcpServers API. */
  async setMcpServers(id: string, servers: Record<string, unknown>) {
    const s = this.requireLive(id)
    const result = await this.requireHandleMethod<(servers: Record<string, unknown>) => Promise<unknown>>(
      s,
      'setMcpServers',
      'dynamic MCP servers',
      'supportsMcp',
    )(servers)

    // [DEBUG MCP] setMcpServers returned. Log the SDK result so we can see
    // which servers were actually added and whether any errored.
    log.info(`[session ${id}] setMcpServers result:`, JSON.stringify(result))

    // Update the tracked MCP server names so the client's "available"
    // computation stays in sync without relying on the flaky mcp-status.
    s.mcpServerNames = Object.keys(servers)
    this.writeStore(s)
    this.broadcastGlobal({ kind: 'update', session: this.info(s) })

    // [DEBUG MCP] Probe whether the newly-added tools are loaded into the
    // prompt (isLoaded:true) or deferred behind tool search (isLoaded:false).
    // context-usage.mcpTools[].isLoaded is the authoritative signal here.
    // Fire-and-forget; never blocks the response.
    void this.debugLogMcpToolLoadState(id, Object.keys(servers)).catch(() => {})

    return result
  }

  /** [DEBUG MCP] Log per-tool isLoaded state from context-usage. isLoaded=false
   *  means the tool is deferred behind tool search (defer_loading=true) and
   *  won't appear in the model's tools list until discovered via ToolSearch. */
  private async debugLogMcpToolLoadState(id: string, expectedServers: string[], delayMs = 1500) {
    const expected = new Set(expectedServers)
    if (expected.size === 0) return
    // Retry the context-usage probe: right after spawn / setMcpServers the
    // subprocess may still be mid-init-handshake, so the first probe can
    // fail or return an empty mcpTools list. Back off and try again.
    const attempts = 3
    for (let i = 0; i < attempts; i++) {
      await new Promise((r) => setTimeout(r, i === 0 ? delayMs : 2500))
      let usage: unknown
      try {
        const fn = this.requireHandleMethod<() => Promise<unknown>>(
          this.requireLive(id),
          'getContextUsage',
          'context usage (debug)',
          'supportsContextUsage',
        )
        usage = await this.timeSdkControl(id, 'getContextUsage (debug)', fn)
      } catch (e) {
        log.info(`[session ${id}] [DEBUG MCP] context-usage probe ${i + 1}/${attempts} failed:`, (e as Error).message)
        continue
      }
      const mcpTools = (usage as { mcpTools?: Array<{ name: string; serverName: string; isLoaded?: boolean }> })?.mcpTools ?? []
      const relevant = mcpTools.filter((t) => expected.has(t.serverName))
      if (relevant.length === 0) {
        log.info(`[session ${id}] [DEBUG MCP] probe ${i + 1}/${attempts}: no mcpTools yet for [${[...expected].join(', ')}]`)
        continue
      }
      const lines = relevant.map((t) => `  ${t.serverName}__${t.name}: isLoaded=${t.isLoaded}`)
      log.info(`[session ${id}] [DEBUG MCP] tool load state for [${[...expected].join(', ')}] (probe ${i + 1}/${attempts}):`)
      log.info(lines.join('\n'))
      return
    }
    log.info(`[session ${id}] [DEBUG MCP] gave up after ${attempts} probes — tools never appeared for [${[...expected].join(', ')}]`)
  }

  /** Merge global MCP configs with session-specific overrides.
   *  enabledGlobal: names of global servers the user selected.
   *  sessionMcp: session-specific overrides (win on name collision).
   *  Returns undefined if the merged result is empty. */
  mergeMcpServers(
    enabledGlobal?: string[],
    sessionMcp?: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    const global = this.mcpStore.toSdkConfig() ?? {}
    const result: Record<string, unknown> = {}

    // Add explicitly-requested global servers. Guard on Array.isArray so a
    // stray string (e.g. enabledMcpServers:"foo") can't be iterated
    // character-by-character.
    //
    // An explicit request overrides the global `enabled` flag: a globally
    // disabled server is "off by default" (not pre-checked in the new-session
    // dialog) but the user can still opt into it per session by checking its
    // box. `toSdkConfig` skips disabled servers, so for names not present
    // there we fall back to `getSdkServerConfig`, which ignores `enabled`.
    // Unknown names resolve to nothing and are silently dropped.
    if (Array.isArray(enabledGlobal)) {
      for (const name of enabledGlobal) {
        if (typeof name !== 'string') continue
        const cfg = global[name] ?? this.mcpStore.getSdkServerConfig(name)
        if (cfg) result[name] = cfg
      }
    }

    // Session overrides replace or add
    if (sessionMcp) {
      Object.assign(result, sessionMcp)
    }

    return Object.keys(result).length > 0 ? result : undefined
  }

  /** Async merge path for HTTP routes: refresh remote OAuth tokens first. */
  async mergeMcpServersAsync(
    enabledGlobal?: string[],
    sessionMcp?: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined> {
    if (this.mcpStore && Array.isArray(enabledGlobal)) {
      await this.mcpStore.refreshOAuthTokens(enabledGlobal)
    }
    return this.mergeMcpServers(enabledGlobal, sessionMcp)
  }


  async reloadSkills(id: string) {
    const s = this.requireLive(id)
    const fn = this.requireHandleMethod<() => Promise<unknown>>(s, 'reloadSkills', 'skill reload')
    const result = await this.timeSdkControl(id, 'reloadSkills', fn)
    const skills = (result && typeof result === 'object' && Array.isArray((result as { skills?: unknown }).skills))
      ? (result as { skills: unknown[] }).skills
      : []
    if (skills.length > 0) this.broadcastCommandsChanged(id, skills)
    return result
  }

  async reloadSkillsForCwd(cwd?: string): Promise<{ reloaded: string[]; failed: { id: string; error: string }[] }> {
    const target = cwd ? cwd.toLowerCase() : undefined
    const reloaded: string[] = []
    const failed: { id: string; error: string }[] = []
    for (const s of this.sessions.values()) {
      if (!s.running || s.terminated) continue
      if (target && (s.cwd ?? '').toLowerCase() !== target) continue
      if (!s.handle.reloadSkills) continue
      try {
        await this.reloadSkills(s.id)
        reloaded.push(s.id)
      } catch (err) {
        failed.push({ id: s.id, error: err instanceof Error ? err.message : String(err) })
      }
    }
    return { reloaded, failed }
  }

  /** Pin a session's skill policy override. Forwards the effective policy to
   *  the SDK as a per-skill `applyFlagSettings({skillOverrides})` map so the
   *  switch takes effect on the next assistant turn — no spawn/respawn.
   *
   *  override semantics (see shared/skills.ts):
   *    - undefined / {kind:'inherit'} : follow the global config; flag layer
   *      is cleared (sent as `{}`) so user/project-level settings can win.
   *    - {kind:'mode', mode, allowlist}: pin a specific load mode at the
   *      session scope.
   *    - {kind:'disabled'}            : every skill forced 'off'.
   *
   *  RAM-only by design — see Session.skillOverride for the full reasoning. */
  async setSkillOverride(id: string, override: SessionSkillOverride | undefined): Promise<SessionInfo> {
    const s = this.requireLive(id)
    const next: SessionSkillOverride | undefined =
      !override || override.kind === 'inherit' ? undefined : override
    s.skillOverride = next
    await this.applyDynamicSkillOverrides(s)
    s.lastActivityAt = Date.now()
    this.persist(s)
    return this.info(s)
  }

  /** Send the session's currently-effective skill policy to the SDK via
   *  applyFlagSettings({ skillOverrides: <map> }). The map is built from the
   *  set of skills actually available to this cwd (user + project), so the
   *  flag layer covers every skill explicitly — no ambiguity about which
   *  layer wins for a given skill.
   *
   *  For 'default' mode we deliberately send an empty `{}` rather than
   *  omitting the field: that *replaces* any prior flag-layer overrides
   *  with an empty map (clearing them) so the lower priority layers
   *  (user / project / policy) take effect again. Sending undefined would
   *  leave a previous flag-layer pin in place. */
  async applyDynamicSkillOverrides(s: Session): Promise<void> {
    const policy = effectiveSkillPolicyFor(s.skillOverride)
    let availableSkills: string[]
    try {
      const list = await listSkills(s.cwd)
      availableSkills = list.skills.map((skill) => skill.name)
    } catch (err) {
      log.warn(`[session ${s.id}] applyDynamicSkillOverrides: listSkills failed:`, err)
      availableSkills = []
    }
    const map = policyToDynamicSkillOverrides(policy, availableSkills)
    const skillOverrides = map ?? {}
    await this.requireHandleMethod<(settings: Record<string, unknown>) => Promise<void>>(
      s,
      'applyFlagSettings',
      'skill overrides',
    )({ skillOverrides })
  }

  /** Re-broadcast the global skill policy to every live session that's
   *  currently inheriting it. Called from the /api/config save path so a
   *  user toggling the global mode in Settings sees it land in every open
   *  session immediately, without requiring a restart. Sessions that opted
   *  into a session-level override are deliberately unaffected — their
   *  override is "stickier" than the global toggle, that's the whole point.
   *
   *  Errors are collected per-session so one wedged subprocess can't block
   *  the others; the caller (route layer) returns a summary. */
  async reapplyGlobalSkillsToInheritingSessions(): Promise<{
    applied: string[]
    failed: { id: string; error: string }[]
  }> {
    const applied: string[] = []
    const failed: { id: string; error: string }[] = []
    for (const s of this.sessions.values()) {
      if (!s.running || s.terminated) continue
      if (s.skillOverride && s.skillOverride.kind !== 'inherit') continue
      if (typeof s.handle.applyFlagSettings !== 'function') continue
      try {
        await this.applyDynamicSkillOverrides(s)
        applied.push(s.id)
      } catch (err) {
        failed.push({ id: s.id, error: err instanceof Error ? err.message : String(err) })
      }
    }
    return { applied, failed }
  }

  async reloadPlugins(id: string) {
    const s = this.requireLive(id)
    return this.requireHandleMethod<() => Promise<unknown>>(
      s,
      'reloadPlugins',
      'plugin reload',
      'supportsPlugins',
    )()
  }

  async contextUsage(id: string) {
    const s = this.requireLive(id)
    const fn = this.requireHandleMethod<() => Promise<unknown>>(
      s,
      'getContextUsage',
      'context usage',
      'supportsContextUsage',
    )
    return this.timeSdkControl(id, 'getContextUsage', fn)
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
   * For "deny": `interrupt` defaults to false (model re-plans). `interrupt: true`
   * aborts the turn — used by the plan dialog's "Stop & take over" action.
   */
  async decide(
    sid: string,
    pid: string,
    decision:
      | { behavior: 'allow'; persistForSession?: boolean; planTargetMode?: PermissionMode }
      | { behavior: 'deny'; message?: string; interrupt?: boolean },
  ): Promise<void> {
    const s = this.require(sid)
    // Capture whether this pending is a plan proposal BEFORE broker.decide
    // deletes it from the pending map. Approving an ExitPlanMode request must
    // also switch the session out of plan mode into an execution mode dthe
    // SDK's read-only plan lock is still engaged, so without this the model
    // would be stuck unable to execute the plan it just got approved.
    const isPlanApproval =
      decision.behavior === 'allow' &&
      s.pending.get(pid)?.toolName === 'ExitPlanMode'
    this.permBroker.decide(s, pid, decision)
    s.lastActivityAt = Date.now()
    this.persist(s)
    if (isPlanApproval) {
      // default = "review each edit" if the client didn't specify a target.
      const target = (decision as { planTargetMode?: PermissionMode }).planTargetMode ?? 'default'
      await this.setPermissionMode(sid, target)
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
  subscribeContextUsage(id: string): { iterable: AsyncIterable<unknown>; snapshot?: import('./session-pump.js').LiteContextUsage | undefined; unsubscribe: () => void } | null {
    const s = this.sessions.get(id)
    if (!s) return null
    const sub = this.subscribePushableSet(s, s.contextUsageSubscribers, 'ctx', 50)
    return { iterable: sub.iterable, snapshot: s.lastContextUsage, unsubscribe: sub.unsubscribe }
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

  /** AsyncIterable of `session-cleared` signal frames for one session.
   *  Mirrors subscribeGitStatus; returns null when the session is unknown.
   *  Small maxDepth da clear is a rare, idempotent event and the durable
   *  truth (the truncated history ring) is replayed on reconnect, so a
   *  dropped live frame self-heals. */

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
  subscribeSessionCleared(id: string): { iterable: AsyncIterable<unknown>; unsubscribe: () => void } | null {
    const s = this.sessions.get(id)
    if (!s) return null
    return this.subscribePushableSet(s, s.sessionClearedSubscribers, 'cleared', 10)
  }

  /** Broadcast a `session-cleared` signal to every subscriber of the given
   *  session. No-op when the session is unknown or has no subscribers.
   *  Signal-only (bare sessionId) dthe client resets its transcript store
   *  and drops its local cache in response. Called by the pump after a
   *  `/clear`-triggered context reset is confirmed (and the history ring
   *  has already been truncated). */
  broadcastSessionCleared(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    if (s.sessionClearedSubscribers.size === 0) return
    const frame = { kind: 'session-cleared' as const, sessionId: id }
    for (const sub of s.sessionClearedSubscribers) {
      try { sub.push(frame) } catch { /* subscriber dead dskip */ }
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
  ): { iterable: AsyncIterable<T>; unsubscribe: () => void } {
    const pushable = createPushable<T>(`${label}-${s.id.slice(0, 8)}`, maxSize)
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
   *  subscribers. The payload is bare (signal-only) dthe client side
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
      try { sub.push(frame) } catch { /* subscriber dead dskip */ }
    }
  }

  /** Consume hook wired into each session's input pushable (see spawn /
   *  autoResume). Fires the instant the SDK reads a turn off the queue d
   *  either because it was buffered while a previous turn ran, or handed
   *  off directly to a blocked consumer. We:
   *    1. Filter to top-level user messages. Tool results and sub-agent
   *       outputs flow through the same Query stream but never through
   *       THIS pushable, so in practice everything here is a user turn;
   *       the guard is defence-in-depth and mirrors the pump's drop rule.
   *    2. Stamp `consumedAt` on the message object. Because the input
   *       pushable and the history ring hold the SAME object reference
   *       (dispatchUserMessage pushes one object to both), this stamp is
   *       immediately visible on the historical copy dso a reconnecting
   *       client replays it as already-consumed with zero extra storage.
   *    3. Broadcast a live `message-consumed` signal so currently-attached
   *       tabs flip the bubble without waiting for a replay. */
  private onInputConsumed(id: string, msg: SDKUserMessage): void {
    if (msg.type !== 'user') return
    if (msg.parent_tool_use_id != null) return
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
      try { sub.push(frame) } catch { /* subscriber dead dskip */ }
    }
  }

  /** Broadcast a recap-update payload to per-session subscribers AND
   *  fan out a global session-update so the sidebar (which mirrors
   *  SessionInfo.recap onto its session cards) stays in sync without
   *  needing a separate frame. Called by the RecapManager via the
   *  broadcastRecap dep. `recap` is undefined to mean "cleared" dboth
   *  the per-session frame and the SessionInfo projection encode that
   *  as undefined. */
  private broadcastSessionRecap(id: string, recap: SessionRecap | undefined): void {
    const s = this.sessions.get(id)
    if (!s) return
    // Per-session recap channel ddrives live UI on the active panel.
    if (s.recapSubscribers.size > 0) {
      const frame = { kind: 'session-recap-update' as const, sessionId: id, recap }
      for (const sub of s.recapSubscribers) {
        try { sub.push(frame) } catch { /* subscriber dead dskip */ }
      }
    }
    // Global session-update dsidebar / other tabs see the new recap
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
    await this.unload(id, { terminated: true, reason: 'deleted' })
    this.store.remove(id)
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
   *  `terminated`: when true, the session is marked terminated in the
   *  persistence store (prevents future resume) dused on explicit delete
   *  and when the Query itself has ended. Default false.
   *
   *  `removeFromStore`: when true, drop the session's persisted meta AND
   *  broadcast `removed` (instead of a dormant `update` + writeStore). The
   *  on-disk transcript is NOT touched, so the session stays resumable via
   *  `adoptDiskSession` — only the sidebar/sessions.json entry is dropped.
   *  Used by `clear()` so a cleared session doesn't linger as a dormant
   *  sidebar entry. Default false. */
  async unload(id: string, opts: { terminated?: boolean; reason?: string; removeFromStore?: boolean } = {}): Promise<void> {
    const s = this.sessions.get(id)
    if (!s) return
    if (opts.terminated) {
      s.terminated = true
      if (opts.reason) s.terminatedReason = opts.reason
    }
    s.running = false
    // Abort any in-flight `!`/`!!` exec so its child process doesn't outlive
    // the session. execInSession's finally still clears execAbort, but this
    // fires the SIGKILL promptly rather than letting the orphan run to its
    // timeout / natural completion.
    s.execAbort?.abort()
    // Stop polling any background subagents' transcripts da late completion
    // must not broadcast into a session being torn down.
    this.stopBackgroundSubagentWatchers(id)
    s.handle.destroy(opts.reason ?? 'unload')
    // When terminating (explicit delete or graceful shutdown), await the
    // pump so the SDK subprocess has time to exit cleanly.
    if (opts.terminated) {
      try {
        await Promise.race([
          s.pumpTask,
          new Promise<void>((r) => setTimeout(r, 1000)),
        ])
      } catch { /* pump swallows errors internally */ }
    }
    this.permBroker.denyAll(s)
    // Cancel any pending git-status broadcast dwithout this, a timer
    // scheduled by the last mutating tool_use could still fire after the
    // session is removed (the broadcast itself is a no-op then, but the
    // timer is dead code that should be released up front).
    cancelGitBroadcast(id)
    endAllSubscribers(s)
    // Broadcast the running=false / terminated state BEFORE removing
    // from the map. Without this, the client's copy stays stale at
    // `running: true` dhandleSelect then skips resume, and the user
    // hits a 409 on their next send. The session is still in the live
    // map at this point so info(s) works correctly.
    // `removeFromStore` suppresses the dormant `update` — `removed` is
    // broadcast at the tail instead (after the map delete), so the
    // client drops X from the sidebar rather than dimming it dormant.
    if (!opts.terminated && !opts.removeFromStore) {
      this.broadcastGlobal({ kind: 'update', session: this.info(s) })
    }
    this.sessions.delete(id)
    // Clear the recap state. The session is no longer in the manager's
    // map so getPhase will return 'unknown' from inside the manager d
    // we still call invalidate() to end any subscribers and clear the
    // legacy in-flight slot. Recap is in-memory only, so dropping the
    // session here is the end of the line for it.
    this.recapManager.invalidate(id)
    this.recapManager.cleanup(id)
    this.permBroker.removeDenialTracker(id)
    if (opts.removeFromStore) {
      // clear(): drop X from sessions.json so it leaves the sidebar, but
      // LEAVE the transcript file on disk — resume(X) re-adopts it via
      // adoptDiskSession and recovers the pre-clear conversation. Broadcast
      // `removed` (not dormant `update`) so the sidebar drops X entirely.
      // Not terminated, no pump await — X is a normal resumable session,
      // just hidden from the sidebar.
      this.store?.remove(id)
      this.broadcastGlobal({ kind: 'removed', id })
    } else {
      this.writeStore(s)
    }
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
    // Most recent activity first dmatches the old behaviour of live-only
    // sessions sitting at the top while the user works on them.
    out.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    return out
  }

  /** List sessions resumable from disk via the SDK's `listSessions()`.
   *
   *  Unlike `list()` (which only knows about sessions THIS app created /
   *  persisted), this scans `~/.claude/projects/` for every transcript d
   *  including sessions the `claude` CLI created directly in the same
   *  project dirs, which never appear in our sidebar. That's the whole
   *  point of the /resume picker.
   *
   *  Each result is annotated against our live + persisted state:
   *    - `known`      dalready in our store or in memory
   *    - `running`    dhas a live Query right now
   *    - `terminated` dwe've marked it un-resumable (e.g. transcript gone)
   *
   *  `dir` scopes to a project directory (and its worktrees); omit for all
   *  projects. Sorted newest-first by `lastModified`. SDK errors degrade to
   *  an empty list (mirrors hasSdkTranscript's fail-soft style). */
  async listResumable(opts?: { dir?: string }): Promise<ResumableSession[]> {
    const mapped: ResumableSession[] = []
    for (const provider of this.providers.list()) {
      if (!provider.listResumable) continue
      let raw: ResumableSession[]
      try {
        raw = await provider.listResumable(opts)
      } catch (err) {
        log.warn(`[session-manager] listResumable(${provider.name}) threw:`, err)
        continue
      }
      for (const s of raw) {
        const live = this.sessions.get(s.sessionId)
        const meta = this.store.get(s.sessionId)
        const providerName = s.provider ?? live?.provider ?? meta?.provider ?? provider.name
        if (live && live.provider !== providerName) continue
        if (!live && meta?.provider && meta.provider !== providerName) continue
        mapped.push({
          ...s,
          provider: providerName,
          known: !!live || !!meta,
          running: !!live && live.running,
          terminated: live?.terminated ?? meta?.terminated ?? false,
        })
      }
    }
    mapped.sort((a, b) => b.lastModified - a.lastModified)
    return mapped
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
    const meta = this.store.get(id)
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
   *  Works for dormant sessions too dreads the JSONL directly and does not
   *  require the session to be live. The session must exist in the store
   *  (404 otherwise); a session that never wrote a transcript returns an
   *  empty page. */
  async getHistoryPage(
    id: string,
    opts: { before?: number; beforeUuid?: string; limit: number },
  ): Promise<HistoryPage> {
    // Require the session to be known (live or persisted) so we don't serve
    // arbitrary uuids off disk.
    const live = this.sessions.get(id)
    const meta = this.store.get(id)
    if (!live && !meta) {
      throw new HttpError(404, 'session not found')
    }
    // Side Chat: exclude the inherited parent prefix via the fork boundary so
    // paging (the client's loadOlder scroll-up) never surfaces the parent's
    // history inside the Side Chat UI. Undefined for non-Side-Chat sessions.
    const afterUuid = live?.forkBoundaryUuid ?? meta?.forkBoundaryUuid
    return this.readProviderHistoryPage(live?.provider ?? meta?.provider ?? this.defaultProvider, id, {
      ...opts,
      ...(afterUuid ? { afterUuid } : {}),
    })
  }

  async searchMessages(query: string, opts: { limit?: number } = {}): Promise<MessageSearchHit[]> {
    const q = query.trim()
    if (q.length < 2) return []
    const limit = clampSearchLimit(opts.limit)
    const sessions = this.list()

    // Search sessions in parallel with a concurrency cap to avoid
    // overwhelming the filesystem or event loop.
    const CONCURRENCY = 10
    const allHits: MessageSearchHit[] = []
    let idx = 0
    const searchSession = async (info: SessionInfo) => {
      const live = this.sessions.get(info.id)
      const meta = this.store.get(info.id)
      const providerName = live?.provider ?? meta?.provider ?? info.provider ?? this.defaultProvider
      const provider = this.providers.get(providerName)
      if (!provider.readHistoryEntries) return

      let entries: HistoryEntry[]
      try {
        // Side Chat: exclude the inherited parent prefix via the fork boundary
        // so parent content doesn't surface as a hit under the Side Chat title.
        const afterUuid = live?.forkBoundaryUuid ?? meta?.forkBoundaryUuid
        entries = await provider.readHistoryEntries(info.id, afterUuid ? { afterUuid } : {})
      } catch (err) {
        log.warn(`[session-manager] searchMessages(${info.id}) history read failed:`, err)
        return
      }

      let sessionMatchOrdinal = 0
      for (const entry of entries) {
        const plainText = extractMessagePlainText(entry.message as SDKMessage)
        if (!plainText) continue
        const matchCount = countMatches(plainText, q)
        if (matchCount === 0) continue
        const matchOrdinal = sessionMatchOrdinal
        sessionMatchOrdinal += matchCount
        const uuid = messageUuid(entry.message)
        allHits.push({
          id: `${info.id}:${uuid ?? entry.index}`,
          sessionId: info.id,
          sessionTitle: info.title,
          cwd: info.cwd,
          messageUuid: uuid ?? String(entry.index),
          messageIndex: entry.index,
          messageType: messageType(entry.message),
          snippet: buildSnippet(plainText, q),
          matchCount,
          matchOrdinal,
          lastModified: info.lastTurnAt ?? info.lastActivityAt,
        })
      }
    }

    // Run up to CONCURRENCY searches in parallel.
    const workers: Promise<void>[] = []
    const next = async (): Promise<void> => {
      while (idx < sessions.length) {
        const i = idx++
        await searchSession(sessions[i])
      }
    }
    for (let w = 0; w < Math.min(CONCURRENCY, sessions.length); w++) {
      workers.push(next())
    }
    await Promise.all(workers)

    // Sort by recency (most recent first), then truncate to limit.
    allHits.sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0))
    return allHits.slice(0, limit)
  }

  async shutdown(): Promise<void> {
    this.healthMonitor.stop()
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
    // on shutdown we want a clean exit dgive each pump up to 5 s.
    if (pumpTasks.length > 0) {
      await Promise.race([
        Promise.allSettled(pumpTasks),
        new Promise((r) => setTimeout(r, 5000)),
      ])
    }
    await this.store.flush()
  }

  // --- internals ---

  private require(id: string): Session {
    const s = this.sessions.get(id)
    if (!s) throw new HttpError(404, `session ${id} not found`)
    return s
  }

  /** Like require(), but additionally ensures the session is alive and
   *  the Query is still running dthe precondition for send/sendContent. */
  private requireRunnable(id: string): Session {
    const s = this.require(id)
    if (s.terminated) {
      log.warn(`[session ${id}] send rejected dsession is terminated`)
      throw new HttpError(410, `session ${id} is terminated`)
    }
    if (!s.running) {
      log.warn(`[session ${id}] send rejected dsession is not running`)
      throw new HttpError(409, `session ${id} is not running; resume it first`)
    }
    return s
  }

  /** Reject user-input turns during the crash-recovery window: the old
   *  handle is aborted and about to be destroyed, so a send would be
   *  enqueued to a dead Pushable (message lost) and bump pendingTurns on
   *  the fresh handle with no queued input (stuck 'working'). Applied to
   *  send()/sendContent() only dNOT clear() (the reset escape hatch must
   *  stay usable during recovery) or execInSession (local !bash, doesn't
   *  touch the SDK handle). */
  private requireSendable(id: string): Session {
    const s = this.requireRunnable(id)
    if (s.recovering) {
      throw new HttpError(409, `session ${id} is recovering from a crash; retry shortly`)
    }
    return s
  }

  /** Like require(), but additionally insists the Query is still live.
   *  Use for any method that forwards a control request to the SDK dthe
   *  subprocess's stdin is closed once `running` flips to false, so a
   *  subsequent `supportedModels` / `getContextUsage` / etc. would otherwise
   *  throw `ProcessTransport is not ready for writing` from deep in the
   *  SDK and end up as an unhandled error in the Hono router. Also blocks
   *  during crash recovery: control ops (interrupt / setModel / etc.)
   *  would route into the aborted handle and throw opaque errors. */
  private requireLive(id: string): Session {
    const s = this.require(id)
    if (s.recovering) {
      throw new HttpError(409, `session ${id} is recovering from a crash; retry shortly`)
    }
    if (!s.running) {
      throw new HttpError(410, `session ${id} is not running`)
    }
    return s
  }

  private requireProviderCapability(
    providerName: string,
    capability: keyof ProviderCapabilities,
    action: string,
  ): void {
    const provider = this.providers.get(providerName)
    if (!provider.capabilities[capability]) {
      throw new HttpError(501, `provider ${providerName} does not support ${action}`)
    }
  }

  private requireHandleMethod<T extends (...args: never[]) => unknown>(
    s: Session,
    method: keyof ProviderSessionHandle,
    action: string,
    capability?: keyof ProviderCapabilities,
  ): T {
    if (capability) this.requireProviderCapability(s.provider, capability, action)
    const fn = s.handle[method]
    if (typeof fn !== 'function') {
      throw new HttpError(501, `provider ${s.provider} does not support ${action}`)
    }
    return fn.bind(s.handle) as T
  }

  private info(s: Session): SessionInfo {
    const isWorking = s.running && s.pendingTurns > 0
    return {
      id: s.id,
      provider: s.provider,
      createdAt: s.createdAt,
      lastActivityAt: s.lastActivityAt,
      subscribers: s.subscribers.size,
      messageCount: s.history.length,
      cwd: s.cwd,
      model: s.model,
      permissionMode: s.permissionMode,
      title: s.title,
      betas: s.betas,
      fastMode: s.fastMode,
      fastModeState: s.fastModeState,
      effortLevel: s.effortLevel,
      effortLevels: s.effortLevels,
      running: s.running,
      recovering: s.recovering,
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
      parentId: s.parentId,
      mcpServerNames: s.mcpServerNames,
      enabledPlugins: s.enabledPlugins,
      skillOverride: s.skillOverride,
      showPinnedUserMessage: s.showPinnedUserMessage,
      autoRecap: s.autoRecap,
    }
  }

  /** Coarse-grained lifecycle phase. Single source of truth for
   *  client-side gates that today re-derive the same state from the
   *  primitives (working / running / terminated / queueDepth /
   *  pending permissions). The recap auto-fire timer is the first
   *  caller, but anything else that wants "is the session quiet right
   *  nowd" should read `phase` rather than re-implementing the rule. */
  phaseOf(s: Session): SessionPhase {
    if (s.terminated) return 'terminated'
    if (!s.running) return 'dormant'
    // Any in-flight assistant turn, queued user input, or unanswered
    // tool-permission prompt counts as "working" dnone of those are
    // safe moments to summarise the conversation.
    if (s.clearing) return 'working'
    if (s.pendingTurns > 0) return 'working'
    if (s.handle.queueDepth > 0) return 'working'
    if (s.pending.size > 0) return 'working'
    return 'idle'
  }

  /** Project a persisted meta into the SessionInfo shape. Dormant sessions
   *  have running=false and no live subscribers; messageCount is the last
   *  known value from before the Query was unloaded. */
  private infoFromMeta(meta: SessionMeta): SessionInfo {
    return {
      id: meta.id,
      provider: meta.provider ?? 'claude',
      createdAt: meta.createdAt,
      lastActivityAt: meta.lastActivityAt,
      subscribers: 0,
      messageCount: meta.messageCount,
      cwd: meta.cwd,
      model: meta.model,
      permissionMode: meta.permissionMode,
      title: meta.title,
      fastMode: meta.fastMode,
      effortLevel: meta.effortLevel,
      // Dormant: no live Query, so the SDK isn't reporting a runtime state.
      // Leave fastModeState undefined — the UI hides the chip until resume.
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
      // is in-memory only (per spec dno persistence), so dormant
      // sessions always come back without one until the user resumes
      // and the recapManager rebuilds it.
      phase: meta.terminated ? 'terminated' : 'dormant',
      recap: undefined,
      parentId: meta.parentId,
      mcpServerNames: meta.mcpServerNames,
      enabledPlugins: meta.enabledPlugins,
      showPinnedUserMessage: meta.showPinnedUserMessage,
      autoRecap: meta.autoRecap,
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
        crashRecovery: this.crashRecoveryEnabled,
        attemptCrashRecovery: (s) => this.attemptCrashRecovery(s),
        // The pump's mutating-tool detector calls broadcaster.broadcastGitStatusChanged
        // through the debounce helper. `this` satisfies the SessionBroadcaster
        // interface (subscribeContextUsage, subscribeGitStatus, etc.).
        broadcaster: this,
        // Pump calls this when the SDK-reported fast_mode_state changes.
        // Broadcasts a session-update WITHOUT writing to disk dthe runtime
        // fast-mode state is transient and re-reported after respawn, so it
        // doesn't belong in persisted meta.
        broadcastInfo: (s) => {
          if (!this.sessions.has(s.id)) return
          this.broadcastGlobal({ kind: 'update', session: this.info(s) })
        },
        broadcastCommandsChanged: (id, commands) => this.broadcastCommandsChanged(id, commands),
        recordHookRun: (id, event) => this.recordHookRun(id, event),
        onBackgroundSubagentLaunched: (sessionId, toolUseId, agentId) =>
          this.startBackgroundSubagentWatcher(sessionId, toolUseId, agentId),
      }
    }
    return this.cachedPumpDeps
  }

  private async pump(session: Session): Promise<void> {
    return pumpSession(session, this.buildPumpDeps())
  }

  /** Max consecutive auto-resumes before giving up. Prevents infinite
   *  loops if the CLI subprocess keeps exiting immediately.
   *
   *  The counter resets to 0 on every user message (pushToSession), so
   *  this limit only caps *idle* exits between turns. A value of 3 was
   *  too aggressive — on slow conversations the CLI's idle timeout would
   *  fire 3+ times between messages, prematurely terminating the session.
   *  20 gives ~10 minutes of idle tolerance (assuming ~30s per exit+resume
   *  cycle) without sacrificing the infinite-loop guard. */
  private static MAX_AUTO_RESUME = 20
  /** Tracks consecutive auto-resume attempts per session. */
  private autoResumeCounts = new WeakMap<Session, number>()

  /** Max crash-recovery attempts before giving up. Step 1 (plain in-place
   *  resume) + Step 2 (fork from last completed turn) = 2. Tighter than
   *  autoResume's 20 because each attempt spawns a CLI that may crash again,
   *  and only the rare deterministic-crash case reaches Step 2. */
  private static MAX_CRASH_RECOVERY = 2
  /** Tracks consecutive crash-recovery attempts per session. Resets to 0 on
   *  every user message (pushToSession) so a fresh crash gets a fresh ladder. */
  private crashRecoveryCounts = new WeakMap<Session, number>()

  /** Active background-subagent transcript watchers, keyed by session id →
   *  tool_use_id → stop(). The watcher polls the subagent's own transcript
   *  for completion (the CLI doesn't reliably emit task_notification for
   *  Agent-launched background subagents) and synthesizes a
   *  system/task_notification frame when it settles. Stopped on unload so a
   *  watcher can't fire into a dead session. */
  private backgroundWatchers = new Map<string, Map<string, () => void>>()

  /** Re-spawn a session's Query after a clean exit (idle timeout).
   *  Returns true if the session was successfully re-spawned. */
  private async autoResume(session: Session): Promise<boolean> {
    // Guard: session must still be live and not explicitly stopped
    if (!this.sessions.has(session.id)) return false
    if (session.terminated) return false
    // Guard: SessionManager.clear() is mid-flight and drives its own
    // respawn path. Returning false here lets cleanupPump skip its
    // terminate tail (the `clearing` branch above) and clear() do the
    // fresh spawn without racing against an idle resume.
    if (session.clearing) return false

    // Guard: the SDK only writes session data to disk after the first
    // `result` message. If no turn was completed, resume would fail
    // with "No conversation found with session ID: <uuid>".
    if (!session.lastTurnAt) {
      log.warn(`[session ${session.id}] auto-resume skipped dno completed turns (no disk data)`)
      return false
    }

    // Track consecutive resumes to avoid infinite loops
    const resumeCount = this.autoResumeCounts.get(session) ?? 0
    if (resumeCount >= SessionManager.MAX_AUTO_RESUME) {
      log.warn(`[session ${session.id}] auto-resume limit reached (${resumeCount}/${SessionManager.MAX_AUTO_RESUME}), giving up`)
      return false
    }
    if (resumeCount >= SessionManager.MAX_AUTO_RESUME * 0.75) {
      log.warn(`[session ${session.id}] auto-resume count approaching limit (${resumeCount}/${SessionManager.MAX_AUTO_RESUME})`)
    }

    log.info(`[session ${session.id}] auto-resuming (attempt ${resumeCount + 1}/${SessionManager.MAX_AUTO_RESUME})`)

    // Destroy the old handle BEFORE the async buildResumeOpts: if the MCP
    // OAuth refresh throws, the handle is already cleaned up (no
    // ProcessMonitor/Pushable leak). respawnInPlace's destroy is a no-op
    // (isClosed) when it runs.
    session.handle.destroy('auto-resume')
    const resumeOpts = await this.buildResumeOpts(session)
    this.respawnInPlace(session, resumeOpts, 'auto-resume')
    this.autoResumeCounts.set(session, resumeCount + 1)
    // A clean idle-autoResume means the session was healthy (the prior
    // crash recovery, if any, succeeded) dreset the crash ladder so a
    // future crash starts fresh at Step 1 instead of escalating to Step 2.
    this.crashRecoveryCounts.delete(session)
    return true
  }

  /** Build the SDK resume Options shared by autoResume (clean idle-exit)
   *  and crash-recovery Step 1 (in-place resume after a crash). Centralized
   *  so the two re-spawn paths can't drift on resume semantics — MCP
   *  re-apply, Side Chat systemPrompt re-injection, skill policy, beta
   *  flags, canUseTool. Async because MCP OAuth tokens may need refreshing. */
  private async buildResumeOpts(session: Session): Promise<Options> {
    const resumeOpts: Options = {
      resume: session.id,
      cwd: session.cwd,
      model: session.model,
      permissionMode: session.permissionMode,
      title: session.title,
      effort: session.effortLevel,
      betas: session.betas as Options['betas'],
      settings: session.hooks ? ({ hooks: toSdkHooksSettings(session.hooks) } as Settings) : undefined,
    }
    // Side Chat sessions carry a systemPrompt boundary (SIDE_DEVELOPER_INSTRUCTIONS)
    // that establishes the "non-mutating inspection" contract at turn-zero. The
    // SDK does not persist systemPrompt across resume, so a Side Chat that
    // idle-exits and is auto-resumed would silently drop the boundary and the
    // model would behave like a normal workspace-mutating session. Re-inject
    // the same systemPrompt on resume so the boundary survives.
    if (session.parentId) {
      resumeOpts.systemPrompt = {
        type: 'preset',
        preset: 'claude_code',
        append: SIDE_DEVELOPER_INSTRUCTIONS,
      }
    }
    // Re-apply globally configured MCP servers (same as resume/fork).
    const allGlobalMcpNames = Object.keys(this.mcpStore.toSdkConfig() ?? {})
    if (allGlobalMcpNames.length > 0) {
      await this.mcpStore.refreshOAuthTokens(allGlobalMcpNames)
      resumeOpts.mcpServers = this.mcpStore.toSdkConfig()
    }
    if (session.canUseTool) resumeOpts.canUseTool = session.canUseTool
    return resumeOpts
  }

  /** Re-spawn a session's Query in-place on the SAME id (resume). Shared by
   *  autoResume and crash-recovery Step 1. Destroys the old handle, creates a
   *  fresh one, resets the runtime state, and starts a new pump.
   *
   *  Clears `error` / `terminatedReason` / `lastCrash` so the recovered
   *  session is indistinguishable from a healthy one: a stale crash error
   *  would otherwise make the NEXT clean idle-exit trip `!session.error &&
   *  autoResume` = false and terminate the recovered session, and info()
   *  would show a stale error badge.
   *
   *  Throws if createSession fails — callers wrap per their semantics
   *  (autoResume lets it propagate to cleanupPump; crash-recovery catches
   *  and gives up). */
  private respawnInPlace(session: Session, resumeOpts: Options, destroyReason: string): void {
    // Recover any user turns queued but NOT yet consumed by the crashed CLI.
    // Without this, a message sent mid-turn that the SDK hadn't read yet is
    // silently lost on re-resume: the UI already painted the bubble (pushToSession
    // broadcast it), but the SDK never wrote it to disk, so --resume loads a
    // transcript without it and the model never sees it. Drain the old queue
    // before destroying the handle, then re-enqueue to the fresh handle so the
    // SDK processes it as the next turn. (The SDK's echo of the re-enqueued
    // turn is dropped by the pump's echo filter — no duplicate bubble.)
    const pendingInput = session.handle.drainQueuedInput?.() ?? []
    session.handle.destroy(destroyReason)
    const provider = this.providers.get(session.provider)
    session.handle = provider.createSession({
      id: session.id,
      provider: session.provider,
      cwd: session.cwd,
      model: session.model,
      permissionMode: session.permissionMode,
      title: session.title,
      betas: session.betas,
      effortLevel: session.effortLevel,
      fastMode: session.fastMode,
      enabledPlugins: session.enabledPlugins,
      includeHookEvents: true,
      resume: session.id,
      onUserMessageConsumed: (msg) => this.onInputConsumed(session.id, msg as SDKUserMessage),
      canUseTool: session.canUseTool as ((...args: unknown[]) => Promise<unknown>) | undefined,
      providerExtras: { sdkOptions: applySkillPolicyToOptions(resumeOpts, session.skillOverride) },
    })
    // Re-enqueue recovered turns onto the fresh handle, oldest first.
    for (const msg of pendingInput) session.handle.enqueueUserMessage(msg)
    session.running = true
    session.exiting = false
    session.recovering = false
    session.lastCrash = undefined
    session.error = undefined
    session.terminatedReason = undefined
    session.autoInterruptedAt = undefined
    this.broadcastGlobal({ kind: 'update', session: this.info(session) })
    session.pumpTask = this.pump(session)
  }

  /** Crash-recovery ladder. Called from cleanupPump when `session.lastCrash`
   *  is set (a CLI subprocess crashed: non-zero exit / signal / killed).
   *
   *  Returns true if the session was re-spawned (Step 1, in-place) or
   *  forked-and-terminated (Step 2) dcleanupPump then skips its termination
   *  tail. Returns false on give-up (counter exhausted / no anchor / fork
   *  failed) dfall through to terminate.
   *
   *  - Step 1 (attempt 0): plain `--resume <id>` in-place. Handles the
   *    common cases: transient crashes (OOM, network) and tail corruption
   *    (the CLI self-heals partial trailing lines dverified). Same id, no
   *    sidebar corpse, subscribers stay attached.
   *  - Step 2 (attempt 1): `--fork-session --resume-session-at
   *    <lastSafeResumeUuid>`. For the rare deterministic crash where the
   *    last turn's content poisons the CLI: fork from the last *completed*
   *    turn, dropping the poisonous trailing turn. Creates a new session
   *    id; the original terminates with its transcript preserved as an
   *    artifact. resumeSessionAt only truncates under forkSession
   *    (empirically verified dnon-fork resume-session-at is a no-op because
   *    truncating persisted history is destructive on a same-id resume).
   *
   *  Floor cases terminate via crashRecoveryGiveUp (terminateCrashedSession,
   *  which broadcasts + pushes a terminal error + denies pending + persists)
   *  and return true so cleanupPump skips its generic tail:
   *    - counter >= MAX_CRASH_RECOVERY (ladder exhausted)
   *    - no completed turn (no transcript to resume, no anchor to fork from)
   *    - provider doesn't support resume
   *    - Step 1 spawn throws / Step 2 fork throws (e.g. Side Chat) */
  private async attemptCrashRecovery(session: Session): Promise<boolean> {
    // Guard: session must still be live and not explicitly stopped.
    if (!this.sessions.has(session.id)) return false
    if (session.terminated || session.clearing) return false
    const caps = this.providers.get(session.provider)?.capabilities
    if (!caps?.supportsResume) return this.crashRecoveryGiveUp(session)

    const attempt = this.crashRecoveryCounts.get(session) ?? 0
    if (attempt >= SessionManager.MAX_CRASH_RECOVERY) {
      log.warn(`[session ${session.id}] crash-recovery exhausted (${attempt}/${SessionManager.MAX_CRASH_RECOVERY}), terminating`)
      return this.crashRecoveryGiveUp(session)
    }

    // Both steps need a completed turn on disk: the SDK only writes the
    // transcript after the first `result`, so resume/fork would fail with
    // "No conversation found" without one. Probe the disk AUTHORITATIVELY
    // (hasSdkTranscript) rather than the `lastTurnAt` in-memory proxy —
    // mirrorring resume(). lastTurnAt is set only when THIS process observed
    // a `result`, so a fork (Step 2) that inherits a valid on-disk transcript
    // but has not yet produced a result of its own has lastTurnAt===undefined
    // and would be wrongly given up here. The disk probe is the source of
    // truth (see hasSdkTranscript / resume()).
    if (!(await this.hasSdkTranscript(session))) {
      log.warn(`[session ${session.id}] crash-recovery skipped dno on-disk transcript to resume/fork from`)
      return this.crashRecoveryGiveUp(session)
    }

    if (attempt === 0) {
      return this.crashRecoveryStep1(session)
    }
    return this.crashRecoveryStep2(session)
  }

  /** Give up the recovery ladder: terminate via terminateCrashedSession
   *  (broadcasts the terminated update, pushes a terminal error to
   *  subscribers, denies pending perms, persists) and return true so
   *  cleanupPump skips its generic termination tail — which lacks the
   *  broadcast, the terminal synthetic message, and the specific crash
   *  reason. `reason` defaults to the crash reason handleProcessExit
   *  preserved on session.terminatedReason. */
  private crashRecoveryGiveUp(session: Session, reason?: string): boolean {
    this.terminateCrashedSession(
      session,
      reason ?? session.terminatedReason ?? 'process_exited',
      session.error ?? 'CLI process crashed',
    )
    return true
  }

  /** Step 1: re-resume the same id in-place. Reuses the shared
   *  buildResumeOpts + respawnInPlace so it can't drift from autoResume.
   *  respawnInPlace clears the crash error/reason/lastCrash, so a
   *  subsequent clean idle-exit routes to autoResume (not termination). */
  private async crashRecoveryStep1(session: Session): Promise<boolean> {
    const attempt = this.crashRecoveryCounts.get(session) ?? 0
    log.info(`[session ${session.id}] crash-recovery Step 1: in-place resume (attempt ${attempt + 1}/${SessionManager.MAX_CRASH_RECOVERY})`)

    // Destroy the (already-aborted) old handle BEFORE the async
    // buildResumeOpts: if the MCP refresh throws, the handle is already
    // cleaned up (no ProcessMonitor/Pushable leak).
    session.handle.destroy('crash-recovery')
    let resumeOpts: Options
    try {
      resumeOpts = await this.buildResumeOpts(session)
    } catch (err) {
      // Preserve the original crash error in session.error (the root
      // cause) dlog the recovery-failure detail separately. The user
      // sees the crash reason on reload, not a generic "recovery failed".
      log.error(`[session ${session.id}] crash-recovery Step 1 buildResumeOpts failed:`, err)
      return this.crashRecoveryGiveUp(session)
    }
    // Re-check liveness after the async MCP refresh da concurrent unload()
    // (Delete / shutdown) may have removed the session, and clear() may
    // have set `clearing` to drive its own respawn. Returning true makes
    // cleanupPump skip its termination tail in both cases (the session is
    // either gone or being taken over by clear()).
    if (!this.sessions.has(session.id) || session.terminated || session.clearing) return true
    try {
      this.respawnInPlace(session, resumeOpts, 'crash-recovery')
    } catch (err) {
      log.error(`[session ${session.id}] crash-recovery Step 1 spawn failed:`, err)
      return this.crashRecoveryGiveUp(session)
    }
    this.crashRecoveryCounts.set(session, attempt + 1)
    // Follow the ephemeral "recovering" notice (pushed by handleProcessExit
    // to subscribers, not history) with a "recovered" notice so the live
    // transcript reflects that the in-place resume succeeded — otherwise
    // the "recovering" bubble lingers with no confirmation.
    this.broadcastSystemNotice(session, '已从崩溃恢复，继续对话。')
    return true
  }

  /** Step 2: fork from the last completed turn, dropping the poisonous
   *  trailing turn that crashed the CLI. The fork is a new session id; the
   *  original terminates with its transcript preserved. Returns true
   *  (original handled dfork is the recovered continuation). */
  private async crashRecoveryStep2(session: Session): Promise<boolean> {
    const attempt = this.crashRecoveryCounts.get(session) ?? 0
    const anchor = session.lastSafeResumeUuid
    // lastTurnAt is set on ANY result (success or error), but
    // lastSafeResumeUuid is promoted only on a SUCCESS result (a known-good
    // fork point). A session whose only turns ended in error_max_turns /
    // error_max_budget has lastTurnAt but no anchor dforking would include
    // the poisonous error turn, so give up rather than fork into a re-crash.
    if (!anchor) {
      log.warn(`[session ${session.id}] crash-recovery Step 2 skipped dno lastSafeResumeUuid anchor (no successfully completed turn)`)
      return this.crashRecoveryGiveUp(session)
    }
    // Re-check liveness before the async fork (disk probe + MCP refresh).
    // `clearing` → clear() is taking over (return true so cleanupPump skips
    // its termination tail); missing/unloaded → session is gone.
    if (!this.sessions.has(session.id) || session.terminated) return false
    if (session.clearing) return true
    log.info(`[session ${session.id}] crash-recovery Step 2: fork from anchor ${anchor} (attempt ${attempt + 1}/${SessionManager.MAX_CRASH_RECOVERY})`)

    let forkInfo: SessionInfo
    try {
      forkInfo = await this.fork(session.id, { resumeSessionAt: anchor })
    } catch (err) {
      // Side Chats can't fork (parentId), and a missing transcript would
      // trip here too. Either way, can't recover via fork dgive up.
      // Preserve the original crash error (root cause) for the terminal
      // state; log the fork-failure detail separately.
      log.error(`[session ${session.id}] crash-recovery Step 2 fork failed:`, err)
      return this.crashRecoveryGiveUp(session)
    }
    this.crashRecoveryCounts.set(session, attempt + 1)

    // The original session's state is poisonous (its last turn crashed the
    // CLI), so it can't be kept alive on the same id. Terminate it with a
    // SINGLE synthetic notice pointing the user at the recovered fork —
    // terminateCrashedSession pushes that notice (don't push a separate one
    // too, which would double-broadcast and make a successful recovery look
    // like a failure). The fork is an independent live session (fork()
    // already spawned + pumped it).
    this.terminateCrashedSession(
      session,
      'crash_recovered_fork',
      `已从上一个完整 turn 处 fork 恢复到新会话 ${forkInfo.id}（崩溃的那一轮被丢弃）。`,
    )
    return true
  }

}
