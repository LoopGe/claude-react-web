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
import { SessionStore, coerceMemory, type SessionMeta } from './persistence.js'
import { PromptUuidStore, rewriteSeedPromptUuids, retainPromptUuidEntries, type PromptUuidEntry } from './prompt-uuid-store.js'
import { TurnAnchorStore, type TurnAnchorEntry } from './turn-anchor-store.js'
import { ResultFrameStore, type ResultFrameEntry } from './result-frame-store.js'
import { McpConfigStore } from './mcp-config.js'
import { RecapManager } from './recap.js'
import { summarizeForCompact } from './compact-summary.js'
import type { SessionActivity, SessionPhase, SessionRecap } from './session-types.js'
import { tryCaptureGitHead, invalidateStatusCache } from './git.js'
import { cancelGitBroadcast } from './git-broadcast.js'
import { execCommand, escapeXml } from './exec.js'
import { invalidateClaudeHealth } from './routes/health-routes.js'
import { config as defaultConfig } from './config.js'
import { createAsyncSubscription } from './async-subscription.js'
import { pump as pumpSession, getParentToolUseId, applyTaskEvent, type PumpDeps } from './session-pump.js'
import { isTerminalTaskStatus } from '../shared/tasks.js'
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
  type ElicitationDecision,
  type ElicitationEvent,
  type ElicitationRequestUi,
  type UserDialogDecision,
  type DialogEvent,
  type UserDialogRequestUi,
  endAllSubscribers,
} from './session-types.js'
import { HttpError } from './errors.js'
import { effortLevelsForModel, supportsThinkingForModel } from './effort-capability.js'
import type { ModelInfo } from '../shared/model-info.js'
import { coerceThinkingSetting, type SessionMemorySettings, type ThinkingSetting } from '../shared/session-info.js'
import { coerceAccountInfo, type AccountInfoData } from '../shared/account-info.js'
import { coerceRewindResult, type RewindFilesResult } from '../shared/rewind.js'
import { PermissionBroker } from './permission-broker.js'
import { ElicitationBroker } from './elicitation-broker.js'
import { DialogBroker } from './user-dialog-broker.js'
import { SessionHealthMonitor } from './session-health.js'
import { pushBounded, stampReceivedAt, stampConsumedAt } from './history-utils.js'
import { watchBackgroundSubagent, type SubagentCompletion } from './subagent-watcher.js'
import { createLogger } from './log.js'
import type { HistoryEntry, HistoryPage } from './history-reader.js'
import { deleteTranscriptFile } from './history-reader.js'
import { readTurnAnchorsFromDisk } from './history-reader.js'
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
import { SUPPORTED_DIALOG_KINDS } from '../shared/user-dialog.js'

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

/** `terminatedReason` values that reflect a transient process/query failure
 *  rather than a true terminal state. The SDK transcript may still be intact
 *  on disk, so `resume()` defers to the `hasSdkTranscript` probe instead of
 *  hard-410-ing — auto-recovery may have failed (crash ladder exhausted) even
 *  though the conversation data is perfectly recoverable.
 *
 *  Truly-terminal reasons keep the 410: `deleted` (user intent), and
 *  `transcript_missing` / `crash_recovered_fork` (the data is genuinely gone
 *  or already succeeded-into a fork). An unknown/undefined reason is also
 *  treated as hard-terminal (defensive: don't assume recoverable). */
const TRANSIENT_TERMINATED_REASONS = new Set([
  'query_error',
  'query_ended',
  'process_killed',
  'process_exited',
  'spawn_failed',
])

function isTransientTerminatedReason(reason?: string): boolean {
  return !!reason && TRANSIENT_TERMINATED_REASONS.has(reason)
}

/** Extract the model name from the first assistant frame in a history seed.
 *  Used by resume() when the session's persisted meta has no model (e.g. a
 *  CLI-created session adopted from disk — the SDK's getSessionInfo doesn't
 *  return model). The on-disk assistant frame carries `message.model`, which
 *  is the CLI's SHORT internal name (e.g. `deepseek-v4-flash`) — see
 *  resolveConfiguredModel() for why that is not a valid API model id. */
function firstAssistantModel(seed: SDKMessage[] | undefined): string | undefined {
  if (!seed) return undefined
  for (const msg of seed) {
    if ((msg as { type?: string }).type === 'assistant') {
      const model = (msg as { message?: { model?: string } }).message?.model
      if (typeof model === 'string' && model) return model
    }
  }
  return undefined
}

/** Resolve a model id to one the gateway actually accepts.
 *
 *  The on-disk transcript's `message.model` is the CLI's SHORT internal name
 *  (`deepseek-v4-flash`), NOT the configured full id (`deepseek/deepseek-v4-flash`)
 *  the gateway requires. resume() leans on that short name when the session's
 *  persisted meta has no model (a disk-adopted session, e.g. one /clear'd and
 *  then reopened), and it then gets persisted as the session's model — so the
 *  NEXT /clear clones the short id into a fresh session, which the gateway
 *  rejects with `400 Unsupported model`. Map a BARE short name (no provider
 *  prefix) to the unique configured model whose last `/`-segment matches, so
 *  resume/clear carry a valid API model. Values that already carry a provider
 *  prefix, or that have no unambiguous configured match, are returned
 *  unchanged. */
function resolveConfiguredModel(model: string | undefined): string | undefined {
  if (!model) return undefined
  // A provider-prefixed id is a full model the user picked explicitly; never
  // rewrite it (rewriting could redirect e.g. myprovider/gpt-5.6-sol to a
  // differently-prefixed same-named model in the list).
  if (model.includes('/')) return model
  const list = defaultConfig.modelList
  if (list.includes(model)) return model
  const matches = list.filter((m) => m.slice(m.lastIndexOf('/') + 1) === model)
  return matches.length === 1 ? matches[0] : model
}

/** Merge result frames from the sidecar back into a disk-read history seed.
 *  The SDK doesn't persist result to the on-disk transcript, so a seed read
 *  from disk lacks the per-turn result summaries (cost/duration/turns/usage).
 *  This inserts each result right after its corresponding assistant frame
 *  (matched by assistantUuid), restoring the turn-end summaries the client
 *  renders. Entries whose assistantUuid isn't in the seed (older than the
 *  ring window) are silently dropped — they have nowhere to insert. */
function mergeResultFrames(
  seed: SDKMessage[],
  resultFrames: ResultFrameEntry[] | null | undefined,
): SDKMessage[] {
  if (!resultFrames || resultFrames.length === 0 || seed.length === 0) return seed
  const byAssistant = new Map<string, SDKMessage>()
  for (const entry of resultFrames) {
    byAssistant.set(entry.assistantUuid, entry.result)
  }
  const merged: SDKMessage[] = []
  let inserted = 0
  for (const msg of seed) {
    merged.push(msg)
    const uuid = (msg as { uuid?: string }).uuid
    if (uuid && (msg as { type?: string }).type === 'assistant') {
      const result = byAssistant.get(uuid)
      if (result) {
        merged.push(result)
        inserted++
      }
    }
  }
  // If nothing was inserted (no assistant matched), return the original
  // array to avoid an unnecessary copy.
  return inserted > 0 ? merged : seed
}

/** Short preview of an assistant message for the discard-anchors listing.
 *  First text block's first ~80 chars; falls back to a tool-use label or
 *  the uuid prefix when there's no text. Tolerates any shape (the message
 *  may be absent from disk — returns a placeholder). */
function previewAssistantMessage(msg: unknown): string {
  if (!msg || typeof msg !== 'object') return '(reply not found on disk)'
  const content = (msg as { message?: { content?: unknown } }).message?.content
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const b = block as { type?: string; text?: unknown; name?: unknown }
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        const t = b.text.replace(/\s+/g, ' ').trim()
        return t.length > 80 ? t.slice(0, 80) + '…' : t
      }
      if (b.type === 'tool_use' && typeof b.name === 'string') {
        return `tool: ${b.name}`
      }
    }
  }
  const uuid = (msg as { uuid?: string }).uuid
  return uuid ? uuid.slice(0, 8) : '(empty reply)'
}

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

/** Produce a short human-readable summary of a queued user turn for the
 *  ephemeral "undelivered" notices the auto-resume throw-path surfaces when a
 *  window send can't be carried over. Text content is truncated; image blocks
 *  collapse to a "[image]" marker so the notice stays one line. */
function describeUserMessage(msg: SDKUserMessage): string {
  const content = (msg.message as { content?: unknown } | undefined)?.content
  if (typeof content === 'string') {
    const t = content.trim()
    return t.length > 120 ? `${t.slice(0, 120)}…` : t
  }
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const raw of content) {
      const b = raw as { type?: unknown; text?: unknown } | null
      if (!b || typeof b !== 'object') continue
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
      else if (b.type === 'image') parts.push('[image]')
      else parts.push(`[${String(b.type ?? 'block')}]`)
    }
    const joined = parts.join(' ').trim()
    return joined.length > 120 ? `${joined.slice(0, 120)}…` : joined
  }
  return '(empty message)'
}

const log = createLogger('session')

/** A user message after `stampReceivedAt` has stamped `receivedAt` on it.
 *  The SDK's `SDKUserMessage` type doesn't include `receivedAt` (it's a
 *  server-added field), so this intersection lets callers (the HTTP route)
 *  read both `uuid` and `receivedAt` without an `as unknown as` cast. */
type SentUserMessage = SDKUserMessage & { receivedAt: number }

/** The SDK's camelCase model-info shape (translated to the snake_case wire
 *  `ModelInfo` at the boundary so the browser bundle doesn't import the SDK). */
type SdkModelInfo = {
  value: string
  displayName: string
  description: string
  supportsFastMode: boolean
  supportsEffort: boolean
  supportedEffortLevels: ('low' | 'medium' | 'high' | 'xhigh' | 'max')[]
}

export class SessionManager {
  private sessions = new Map<string, Session>()
  private historyCap: number
  private subagentHistoryCap: number
  private forwardSubagentText: boolean
  private autoResumeEnabled: boolean
  private crashRecoveryEnabled: boolean
  /** Max crash-recovery attempts per crash episode before giving up.
   *  Every attempt is Step 1: an in-place `--resume <id>`. There is no
   *  automatic fork. When the counter reaches `maxCrashRecovery` the ladder
   *  gives up: the session terminates with the (transient) crash reason and
   *  the client shows a Resume / Fork-from-last-completed choice banner for
   *  the USER to decide. Default 2 = two automatic in-place resumes, then
   *  give-up. Raising it adds more in-place resumes before the banner, not
   *  forks. Tighter than autoResume's 20 because each attempt spawns a CLI
   *  that may crash again, and the user should take over after a couple of
   *  failures. Configurable via SessionManagerOptions.maxCrashRecovery. */
  private maxCrashRecovery: number
  private healthMonitor: SessionHealthMonitor
  private store?: SessionStore
  private promptUuidStore: PromptUuidStore
  private turnAnchorStore: TurnAnchorStore
  private resultFrameStore: ResultFrameStore
  private mcpStore?: McpConfigStore
  private providers: ProviderRegistry
  private defaultProvider: string
  private globalSubscribers = new Map<string, GlobalSubscriber>()
  private permBroker: PermissionBroker
  /** MCP elicitation (OAuth auth / server-initiated form) arbitration.
   *  Mirrors permBroker: owns the onElicitation callback construction,
   *  pending registry, decide/cancelAll, and per-session broadcast. */
  private elicitBroker: ElicitationBroker
  /** User-dialog (blocking CLI prompt, e.g. refusal fallback) arbitration.
   *  Mirrors elicitBroker: owns the onUserDialog callback construction,
   *  pending registry, decide/cancelAll, and per-session broadcast. */
  private dialogBroker: DialogBroker
  /** Owns recap lifecycle for every session. Public so the recap route
   *  can call requestGenerate() without going through a wrapper method —
   *  the route is the only HTTP surface for recap, and proxying through
   *  SessionManager would just re-export the same throw semantics. */
  recapManager: RecapManager
  /** Cached result of buildAnthropicEnv(). Invalidated when config.authToken
   *  or config.baseUrl change (detected lazily on each call). */
  /** Cached PumpDeps — all fields reference stable `this` members,
   *  so the object is built once and reused. */
  private cachedPumpDeps?: PumpDeps
  constructor(opts: SessionManagerOptions = {}) {
    this.historyCap = opts.historyCap ?? defaultConfig.historyCap
    this.subagentHistoryCap = opts.subagentHistoryCap ?? defaultConfig.subagentHistoryCap
    this.forwardSubagentText = opts.forwardSubagentText ?? defaultConfig.forwardSubagentText
    this.permBroker = new PermissionBroker()
    this.elicitBroker = new ElicitationBroker()
    this.dialogBroker = new DialogBroker()
    this.autoResumeEnabled = opts.autoResume ?? false
    this.crashRecoveryEnabled = opts.crashRecovery ?? false
    this.maxCrashRecovery = opts.maxCrashRecovery ?? 2
    this.store = opts.store ?? new SessionStore()
    this.promptUuidStore = new PromptUuidStore(this.store.getDir(), this.historyCap)
    this.turnAnchorStore = new TurnAnchorStore(this.store.getDir(), this.historyCap)
    this.resultFrameStore = new ResultFrameStore(this.store.getDir(), this.historyCap)
    this.mcpStore = opts.mcpConfigStore ?? new McpConfigStore()
    this.providers = opts.providers ?? createDefaultProviders({
      claudeBinary: opts.claudeBinary,
      mpStore: opts.mpStore,
      onProcessExit: (info) => this.handleProcessExit(info),
    })
    this.defaultProvider = opts.defaultProvider ?? 'claude'
    // Stuck-session monitor — periodic GC tick with auto-interrupt.
    // `unload` is a class method so it's always available via `this`.
    // The deps arrow captures `this` so the callback stays bound.
    this.healthMonitor = new SessionHealthMonitor({
      sessions: this.sessions,
      workingStuckMs: opts.workingStuckMs ?? defaultConfig.workingStuckMs,
      unload: (id, opts) => this.unload(id, opts),
    })

    // RecapManager — owns the lifecycle (pending — ready/error) for the
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
   *  - Spawn failure (binary missing / not executable): unload to dormant
   *    with the error recorded. We don't auto-retry (the binary is still
   *    gone this instant, a re-spawn would fail identically) but we also
   *    don't permanently terminate — the binary being missing is a
   *    transient, user-fixable condition, so the session stays resumable
   *    and the user can retry once it's restored (reinstall / chmod /
   *    CLAUDE_CODE_BINARY). See unloadSpawnFailed.
   *  - Crash (non-zero code / killed): when crashRecovery is enabled,
   *    record the crash context and defer to cleanupPump's recovery
   *    ladder (in-place resume until maxCrashRecovery is exhausted, then
   *    terminate with the transient reason so the client offers Resume /
   *    Fork-from-last-completed). When disabled, terminate immediately
   *    (legacy behavior). */
  private handleProcessExit(info: ProcessExitInfo): void {
    const { sessionId, code, signal, killed, spawnError } = info
    const s = this.sessions.get(sessionId)
    if (!s) return // Session already cleaned up (e.g. by unload)
    if (s.terminated) return // Already terminated — no action needed
    // clear() drives its own respawn and has already unregister()-marked the
    // old process's exit intentional, so this normally doesn't fire during a
    // clear. Guard anyway for the race where the child's 'exit' beat
    // destroy()'s unregister — clear() is tearing down + respawning on
    // purpose, so don't let an old-process exit terminate the session.
    if (s.clearing) return

    const cleanExit = !killed && code === 0 && !spawnError

    if (cleanExit) {
      // Normal exit (e.g. idle timeout). Abort the controller so the
      // pump breaks out of iter.next(), but DON'T set terminated — let
      // cleanupPump handle auto-resume or termination.
      log.info(`[session ${sessionId}] CLI exited cleanly (code=0) — deferring to pump cleanup`)
      // Mark as exiting so the GC timer's checkStuck() skips this session
      // during the window between abort and cleanupPump finishing.
      s.exiting = true
      s.handle.abort()
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

    log.error(`[session ${sessionId}] ${errorMsg}`)

    // Spawn failures can't be recovered by auto-retrying (the binary is
    // unavailable / unusable right now, a re-spawn would fail identically).
    // But a missing binary is a transient, user-fixable condition — don't
    // permanently terminate. Unload to dormant with the error recorded so
    // the user can resume once the binary is restored (reinstall / chmod /
    // CLAUDE_CODE_BINARY). A later successful resume clears the stale error.
    if (reason === 'spawn_failed') {
      this.unloadSpawnFailed(s, reason, errorMsg)
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
    // Do NOT set terminated / endSubscribers — the ladder may re-spawn
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
    this.elicitBroker.cancelAll(s)
    this.dialogBroker.cancelAll(s)
    s.handle.abort()

    this.broadcastSystemNotice(s, `${errorMsg} — 正在尝试自动恢复…`)
    this.broadcastGlobal({ kind: 'update', session: this.info(s) })
  }

  /** Push a synthetic system/error notice to a session's live subscribers.
   *  Ephemeral — NOT entered into the history ring (so it doesn't survive
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
      try { sub.push(msg) } catch { /* subscriber dead — skip */ }
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
        // The sidebar reads `backgroundSubagentCount` for its status dot;
        // broadcast the updated info so it flips out of 'waiting' the moment
        // the subagent settles (skip when the session was unloaded mid-poll).
        if (this.sessions.has(session.id)) {
          this.broadcastGlobal({ kind: 'update', session: this.info(session) })
        }
        this.broadcastSynthesizedTaskNotification(session, toolUseId, agentId, completion)
      },
    })
    perSession.set(toolUseId, stop)
    // Seed a TaskRecord for this watcher-tracked subagent. CLI versions that
    // emit no task_* frames for background Agent dispatches (the watcher's
    // reason to exist) would otherwise never surface in session.tasks /
    // the TasksPanel. A real task_started arriving later overwrites the seed
    // via applyTaskEvent's upsert; the watcher's own synthesized completion
    // settles it otherwise.
    const now = Date.now()
    const seeded = session.tasks.get(agentId)
    if (!seeded) {
      session.tasks.set(agentId, {
        taskId: agentId,
        toolUseId,
        description: 'Background subagent',
        taskType: 'subagent',
        status: 'running',
        isBackgrounded: true,
        startedAt: now,
        updatedAt: now,
      })
      const snapshot = Array.from(session.tasks.values())
      for (const sub of session.taskSubscribers) {
        try { sub.push(snapshot) } catch { /* subscriber dead — skip */ }
      }
    }
    // A new background subagent just launched — broadcast the updated count
    // so the sidebar can switch this session away from a plain 'live' dot
    // (the parent turn is still running right now; the `result` frame that
    // ends it re-broadcasts info via persist(), carrying the same count).
    if (this.sessions.has(session.id)) {
      this.broadcastGlobal({ kind: 'update', session: this.info(session) })
    }
  }

  /** Cancel the subagent watcher for a (session, toolUseId) when a REAL SDK
   *  task_notification arrives for the same tool call — the true completion
   *  already carries the result, so the watcher's synthesized notification
   *  would be a duplicate (and its maxMs backstop could later flip a
   *  legitimately-done record back to 'stopped'). No-op when no watcher is
   *  armed. */
  private cancelBackgroundWatcher(sessionId: string, toolUseId: string): void {
    const perSession = this.backgroundWatchers.get(sessionId)
    const stop = perSession?.get(toolUseId)
    if (!stop) return
    try { stop() } catch { /* ignore */ }
    perSession!.delete(toolUseId)
    const session = this.sessions.get(sessionId)
    // The pump folds the REAL notification (keyed by its task_id) BEFORE
    // calling this. Nothing ties that task_id to the agentId the launch ack
    // carried, so when they differ the watcher's seed record is a duplicate
    // still stuck on 'running' — the real record under the frame's task_id is
    // the authoritative one, so drop the seed (a matched task_id means the
    // fold already settled the seed itself and it is left intact).
    if (session) {
      let removed = false
      for (const [taskId, rec] of session.tasks) {
        if (rec.toolUseId === toolUseId && !isTerminalTaskStatus(rec.status)) {
          session.tasks.delete(taskId)
          removed = true
        }
      }
      if (removed) {
        const snapshot = Array.from(session.tasks.values())
        for (const sub of session.taskSubscribers) {
          try { sub.push(snapshot) } catch { /* subscriber dead — skip */ }
        }
      }
      // The watcher count feeds the sidebar's 'waiting' dot; re-broadcast so
      // it reflects the cancelled watcher immediately.
      this.broadcastGlobal({ kind: 'update', session: this.info(session) })
    }
    log.info(`[session ${sessionId}] real task_notification for toolUseId=${toolUseId} — watcher cancelled`)
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
    // completion — no subscribers to push to, and persisting would race
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
      try { sub.push(msg) } catch { /* subscriber dead — skip */ }
    }
    // Fold the same notification into the task-state cache so the seeded
    // watcher record settles to a terminal status in the TasksPanel. The
    // synthesized frame never passes through the pump (it bypasses the SDK
    // stream), so the normal fold path doesn't see it — fold it here.
    applyTaskEvent(session, msg)
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

  /** Unload a spawn-failed session to dormant (resumable) state with the
   *  error recorded on the persisted meta. A missing/unusable binary is a
   *  transient, user-fixable condition, so we don't permanently terminate
   *  (unlike terminateCrashedSession): terminated stays false so resume()
   *  still accepts the session. unload() destroys the handle, denies
   *  pending perms, ends subscribers, broadcasts a dormant update, deletes
   *  from the live map, and writeStore() persists the non-terminal meta WITH
   *  error/terminatedReason. A later successful resume() -> spawn() clears
   *  the stale error: snapshotMeta omits `error`, so spawn()'s writeStore
   *  overwrites it with undefined. unload() runs its body synchronously
   *  here (no opts.terminated => no await), so the session is gone from
   *  the map by the time handleProcessExit returns and cleanupPump's
   *  isLive() guard short-circuits. */
  private unloadSpawnFailed(s: Session, reason: string, errorMsg: string): void {
    s.terminatedReason = reason
    s.error = errorMsg
    this.broadcastSystemNotice(s, errorMsg) // before unload ends subscribers
    void this.unload(s.id) // no opts => dormant, not terminated
  }

  /** Terminate a crashed session immediately: the legacy non-recovery path
   *  for crashes when crashRecovery is disabled. Also the final state
   *  written when the recovery ladder gives up (called from cleanupPump's
   *  termination tail). Kept as a helper so the immediate and give-up paths
   *  stay identical. (spawn_failed no longer terminates — see
   *  unloadSpawnFailed.) */
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
    this.elicitBroker.cancelAll(s)
    this.dialogBroker.cancelAll(s)
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
    await this.store?.flush()
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
      provider: s.provider,
      createdAt: s.createdAt,
      lastActivityAt: s.lastActivityAt,
      cwd: s.cwd,
      model: s.model,
      permissionMode: s.permissionMode,
      title: s.title,
      betas: s.betas,
      fastMode: s.fastMode,
      memory: s.memory,
      effortLevel: s.effortLevel,
      thinking: s.thinking,
      autoCompactWindow: s.autoCompactWindow,
      hooks: s.hooks,
      // Both rings count — parity with the old single mixed ring.
      messageCount: s.history.length + s.subagentHistory.length,
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
      slept: s.slept,
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
  private snapshotMeta(opts: Options, provider: string): { provider: string; cwd?: string; model?: string; permissionMode?: PermissionMode; title?: string; betas?: string[]; memory?: SessionMemorySettings; effortLevel?: EffortLevel; thinking?: ThinkingSetting; autoCompactWindow?: number; hooks?: SessionHooksConfig; mcpServerNames?: string[]; enabledPlugins?: string[] } {
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
      // Memory passed at create time (app-level `memory` body field) is the
      // session's initial memory intent; coerced through the same gate as
      // persisted metadata.
      memory: coerceMemory((opts as { memory?: unknown }).memory),
      // Effort passed at create time (Options.effort) becomes the session's
      // initial effortLevel so a create-time choice persists like the others.
      effortLevel: opts.effort,
      // Same for thinking: a create-time Options.thinking becomes the
      // session's initial thinking intent.
      thinking: coerceThinkingSetting(opts.thinking),
      // Auto-compact window is an app-level custom opts field (no SDK
      // Options key — it's re-applied post-spawn via applyFlagSettings, like
      // fastMode/effortLevel). Carried through resume/fork/clear opts so a
      // pinned window survives re-spawns; normalised to a positive finite
      // token count (undefined = "auto").
      autoCompactWindow: (() => {
        const w = (opts as { autoCompactWindow?: unknown }).autoCompactWindow
        return typeof w === 'number' && Number.isFinite(w) && w > 0 ? Math.round(w) : undefined
      })(),
      hooks: settingsHooks,
      // Capture the resolved MCP server names so the client can compute
      // "available" without the flaky mcp-status SDK control request.
      mcpServerNames: opts.mcpServers ? Object.keys(opts.mcpServers as Record<string, unknown>) : undefined,
      enabledPlugins: (opts as { enabledPlugins?: string[] }).enabledPlugins,
    }
  }

  /** Create a brand-new session and start pumping.
   *
   *  For resume, use `resume()` instead — this path always allocates a
   *  fresh UUID and won't wire up SDK `resume`. */
  create(
    opts: Options & { provider?: string },
    customEnv?: Record<string, string>,
    /** Set by the restart flow: the id of the session Y joins. Threaded
     *  through to spawn() so the `created` broadcast carries `joinGroupOf`,
     *  letting every tab append Y to X's group (X is evicted later by
     *  swapSession / session-removed). */
    joinGroupOf?: string,
    /** Set by the restart flow (X is evicted): threaded to spawn() so the
     *  `created` broadcast carries `evictingSource`, letting the client
     *  bypass its maxGroupSize cap when appending Y. */
    evictingSource?: boolean,
  ): SessionInfo {
    // Pin a concrete default model for brand-new sessions so we don't lean
    // on the CLI subprocess's built-in default. When the client omits a
    // model, use the first entry of the configured model list
    // (config.defaultModel === modelList[0]). This keeps session.model a
    // concrete id from the start — matching what the model picker shows as
    // selected — instead of an undefined that silently resolves to whatever
    // model the `claude` CLI happens to pick. Resume/fork are unaffected:
    // they carry the persisted model forward through their own opts.
    const withDefault: Options & { provider?: string } = {
      ...opts,
      provider: opts.provider ?? this.defaultProvider,
      model: opts.model ?? defaultConfig.defaultModel,
    }
    return this.spawn(randomUUID(), withDefault, customEnv, undefined, undefined, undefined, joinGroupOf, evictingSource)
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
  async resume(id: string, opts?: { permissionMode?: PermissionMode }): Promise<SessionInfo> {
    // Coalesce: resume() awaits hasSdkTranscript / history / MCP refresh before
    // spawning, so two racing calls (parallel /resume POSTs) both pass the live
    // guard above and both reach spawn() — the second sessions.set() orphans the
    // first Query, leaving a duplicate claude.exe (observed). Return the in-flight
    // promise so a concurrent second call awaits the SAME spawn.
    const inflight = this.resumeInFlight.get(id)
    if (inflight) return inflight
    const p = this.doResume(id, opts).finally(() => {
      // Only clear if we're still tracked — a later resume may have replaced
      // us while we were settling (don't remove the replacement).
      if (this.resumeInFlight.get(id) === p) this.resumeInFlight.delete(id)
    })
    this.resumeInFlight.set(id, p)
    return p
  }

  private async doResume(id: string, opts?: { permissionMode?: PermissionMode }): Promise<SessionInfo> {
    const live = this.sessions.get(id)
    if (live) {
      // The pump's cleanup tail sets `terminated=true` but does NOT unload,
      // so a crashed session lingers here as a dead zombie. For a transient
      // reason (process crash / query error) the caller is asking to retry —
      // unload the zombie so we fall through to the store/disk path below and
      // actually re-spawn, instead of returning the dead session as-is (which
      // would advertise canRetryResume but do nothing). Hard-terminal zombies
      // are returned as-is: there's nothing to retry and the client shows the
      // ended banner off the terminated info.
      if (live.terminated && isTransientTerminatedReason(live.terminatedReason)) {
        log.info(
          `[session ${id}] resume requested on live transiently-terminated zombie ` +
          `(reason=${live.terminatedReason}); unloading before re-spawn`,
        )
        await this.unload(id)
      } else {
        return this.info(live)
      }
    }
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
      if (isTransientTerminatedReason(meta.terminatedReason)) {
        // Auto-recovery failed (process crash / query error / spawn failure),
        // but the SDK transcript may still be intact on disk. Don't hard-410
        // — fall through to the hasSdkTranscript probe below, which
        // authoritatively decides whether resume is actually possible. If the
        // transcript turns out to be gone, the probe's markTranscriptMissing
        // branch (with a transcript_missing 410) handles it. A successful
        // spawn() then clears the stale terminated/error/terminatedReason via
        // writeStore, so the session recovers cleanly.
        log.info(
          `[session ${id}] resume requested on transiently-terminated session ` +
          `(reason=${meta.terminatedReason}); probing transcript before allowing`,
        )
      } else {
        throw new HttpError(410, `session ${id} has ended and cannot be resumed`)
      }
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
    // Read the history seed FIRST so we can extract the model from the
    // transcript's first assistant frame when meta.model is missing (a
    // CLI-created session adopted from disk has no model in its meta — the
    // SDK's getSessionInfo doesn't return it). The on-disk assistant frame
    // carries the CLI's SHORT model id, which is NOT a valid API model id —
    // resolveConfiguredModel below maps it back to the configured full id.
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
      /* disk read failed — fall back to an empty ring (pre-fix behaviour) */
    }
    // resolveConfiguredModel maps a bare SHORT model id (what the CLI records
    // in the transcript, e.g. `deepseek-v4-flash`) back to the configured
    // FULL id (`deepseek/deepseek-v4-flash`) the gateway accepts. Without it,
    // resume-after-/clear persisted the short id and the NEXT /clear spawned
    // a fresh session the gateway rejected with `400 Unsupported model`.
    const resolvedModel = resolveConfiguredModel(meta.model ?? firstAssistantModel(historySeed))
    const resumeOpts: Options & { provider?: string; enabledPlugins?: string[]; autoCompactWindow?: number } = {
      provider,
      resume: id,
      cwd: meta.cwd,
      model: resolvedModel,
      // Use the persisted permissionMode if available (sessions we created).
      // For CLI sessions adopted from disk (no permissionMode in meta), fall
      // back to the caller-supplied mode (the user's current panel mode) so
      // "resume in whatever mode I'm currently in" works as expected.
      permissionMode: meta.permissionMode ?? opts?.permissionMode,
      title: meta.title,
      // Carry the effort level forward so a resumed session keeps its
      // reasoning depth instead of falling back to the SDK default.
      effort: meta.effortLevel,
      // Same for the extended-thinking config.
      thinking: meta.thinking,
      // Same for the auto-compact window: a pinned threshold survives resume.
      autoCompactWindow: meta.autoCompactWindow,
      // Carry beta flags forward — without this, a 1M-context session
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
    const allGlobalMcpNames = Object.keys(this.mcpStore?.toSdkConfig() ?? {})
    if (allGlobalMcpNames.length > 0) {
      await this.mcpStore?.refreshOAuthTokens(allGlobalMcpNames)
      resumeOpts.mcpServers = this.mcpStore?.toSdkConfig()
    }
    // uuid bridge: load the server-minted prompt uuids recorded for this
    // session and rewrite the disk-seed's top-level prompt uuids (SDK V →
    // server U) so the client's uuid-anchored replay overlap detection works
    // after a server restart. Returns the seed unchanged when there's nothing
    // to bridge (old/fresh session) or on any desync (signature fallback then
    // handles dedup). Loaded onto the session so subsequent sends append to it.
    const promptUuids = await this.promptUuidStore.load(id)
    if (historySeed) {
      // Merge result frames from the sidecar — the SDK doesn't persist
      // result to disk, so the disk-read seed lacks per-turn result
      // summaries (cost/duration/turns/usage).
      const resultFrames = await this.resultFrameStore.load(id)
      historySeed = mergeResultFrames(historySeed, resultFrames)
      historySeed = rewriteSeedPromptUuids(historySeed, promptUuids)
    }
    return this.spawn(id, resumeOpts, undefined, historySeed, undefined, undefined, undefined, undefined, promptUuids ?? [])
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
    const freshOpts: Options & { provider?: string; enabledPlugins?: string[]; autoCompactWindow?: number } = {
      provider,
      cwd: meta.cwd,
      model: meta.model,
      permissionMode: meta.permissionMode,
      title: meta.title,
      effort: meta.effortLevel,
      thinking: meta.thinking,
      autoCompactWindow: meta.autoCompactWindow,
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
    const allGlobalMcpNames = Object.keys(this.mcpStore?.toSdkConfig() ?? {})
    if (allGlobalMcpNames.length > 0) {
      await this.mcpStore?.refreshOAuthTokens(allGlobalMcpNames)
      freshOpts.mcpServers = this.mcpStore?.toSdkConfig()
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

  /** Adopt a session that exists on disk but isn't in our store — i.e. one
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
      // Non-null so the no_data guard passes — the transcript file existing
      // already proves a completed turn.
      lastTurnAt: info.lastModified ?? now,
    }
    this.store?.upsert(meta)
    log.info(`[session ${id}] adopted disk session (cwd=${info.cwd ?? '<none>'}) for resume`)
    return meta
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
    this.store?.upsert(meta)
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
   *  Source can be live OR dormant — we pull metadata from memory first,
   *  persistence second. Terminated sessions can still be forked (their
   *  transcript lives in ~/.claude/projects/ regardless).
   *
   *  Refuses to fork a source whose SDK hasn't completed a turn yet: the
   *  SDK only writes ~/.claude/projects/<cwd>/<id>.jsonl after the first
   *  `result` message, so forking earlier fails with `No conversation
   *  found with session ID: <uuid>` from the CLI. `lastTurnAt` is our
   *  ground-truth signal (set only by the pump on a real `result`). */
  async fork(id: string, opts?: { resumeSessionAt?: string; historySeed?: SDKMessage[]; inheritIdentity?: boolean; replacesSource?: boolean; forkFromLastSafe?: boolean }): Promise<SessionInfo> {
    const live = this.sessions.get(id)
    const meta = live ?? this.store?.get(id)
    if (!meta) throw new HttpError(404, `session ${id} not found`)
    if (!meta.lastTurnAt) {
      throw new HttpError(
        400,
        `session ${id} has no completed turns yet — send at least one message and wait for the reply before forking`,
      )
    }
    // resumeSessionAt (branch-from-a-point) only takes effect with
    // forkSession (empirically verified: --resume-session-at without
    // --fork-session is a no-op, because truncating the persisted history
    // is destructive on a same-id resume but safe on a fork copy). fork()
    // always sets forkSession, so passing resumeSessionAt here is honored.
    // forkFromLastSafe (the crash-recovery "Fork from last completed turn"
    // button) resolves the newest successful turn below, dropping a
    // poisonous trailing turn.
    // Side Chats are ephemeral, scoped to their parent's conversation, and
    // carry a non-mutating boundary prompt. Forking one would manufacture a
    // sibling-of-Side-Chat session whose `parentId` is dropped (forkOpts does
    // not propagate it), masking it as a normal workspace-mutating session.
    // Refuse at the entry point.
    if (meta.parentId) {
      throw new HttpError(400, `session ${id} is a Side Chat and cannot be forked.`)
    }
    // `forkFromLastSafe` (the crash-recovery "Fork from last completed turn"
    // button): resolve the newest successfully-completed turn as the fork
    // point, dropping any poisonous trailing turn. ensureAnchorsLoaded
    // returns chronological anchors; the last entry is the newest. No anchor
    // means no completed turn, which the lastTurnAt guard above already
    // covers — keep the explicit error so the UI can explain why.
    let resumeSessionAt = opts?.resumeSessionAt
    if (!resumeSessionAt && opts?.forkFromLastSafe) {
      const anchors = await this.ensureAnchorsLoaded(id)
      const last = anchors[anchors.length - 1]
      if (!last) {
        throw new HttpError(400, `session ${id} has no completed turn to fork from`)
      }
      resumeSessionAt = last.assistantUuid
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
        messageCount: live ? live.history.length + live.subagentHistory.length : (meta as SessionMeta).messageCount,
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
    // `inheritIdentity`: for discard (which is an in-place truncation, not a
    // sibling branch) keep the source's title verbatim instead of appending
    // " (fork)" — the user expects the conversation to continue under the
    // same name, not a renamed fork.
    const title = opts?.inheritIdentity ? meta.title : (meta.title ? `${meta.title} (fork)` : undefined)
    const sourceProvider = meta.provider ?? this.defaultProvider
    const forkOpts: Options & { provider?: string; enabledPlugins?: string[]; memory?: unknown; autoCompactWindow?: number } = {
      provider: sourceProvider,
      resume: id,
      forkSession: true,
      cwd: meta.cwd,
      model: meta.model,
      permissionMode: meta.permissionMode,
      title,
      // When branching from a specific point (the "Fork from last completed
      // turn" button / explicit resumeSessionAt), truncate the fork's loaded
      // history to this assistant uuid. Only honored because forkSession is
      // set (see method-header note).
      resumeSessionAt,
      // Carry effort + thinking + beta flags forward so the fork matches
      // the source. Thinking is a spawn-time Options key, so unlike fastMode
      // (re-applied post-spawn below) it rides the opts directly.
      effort: meta.effortLevel,
      thinking: meta.thinking,
      // Same for the auto-compact window (re-applied post-spawn via
      // applyFlagSettings, like fastMode — snapshotMeta captures it from here).
      autoCompactWindow: meta.autoCompactWindow,
      // Same as resume: preserve `context-1m-...` etc. so the fork has
      // the same effective window as the source. See resume() for the cast rationale.
      betas: meta.betas as Options['betas'],
      settings: meta.hooks ? ({ hooks: toSdkHooksSettings(meta.hooks) } as Settings) : undefined,
      enabledPlugins: meta.enabledPlugins,
      // Carry the auto-memory intent onto the new id (fork has no
      // existingMeta — snapshotMeta captures it from here). meta already
      // prefers the live session over the persisted store entry.
      memory: coerceMemory(meta.memory),
    }
    // Re-apply globally configured MCP servers (same as resume).
    const allGlobalMcpNames = Object.keys(this.mcpStore?.toSdkConfig() ?? {})
    if (allGlobalMcpNames.length > 0) {
      await this.mcpStore?.refreshOAuthTokens(allGlobalMcpNames)
      forkOpts.mcpServers = this.mcpStore?.toSdkConfig()
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
      opts?.historySeed,
      parentOverride,
      // Carry the source's pure-UI pref overrides onto the fork so a
      // pinned header / auto-recap override survives forking. No-op when
      // the source inherits global (both undefined) — the fork then
      // inherits global too.
      { showPinnedUserMessage: meta.showPinnedUserMessage, autoRecap: meta.autoRecap },
      // joinGroupOf: the source id — Y joins X's group (append semantics;
      // X stays, since fork doesn't remove the source). The crash-recovery
      // "Fork from last completed turn" button sets `replacesSource` so the
      // client instead REPLACES X with Y (X is dead) — Y takes X's group
      // slot, never overflowing the cap.
      id,
      undefined, // evictingSource
      undefined, // promptUuids
      opts?.replacesSource,
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
    // workaround clear() uses. The crash-recovery "Fork from last completed
    // turn" button forks a fast-mode session, so without this the fork would
    // silently drop fast mode. Best-effort: a failure is logged and the fork
    // still completes.
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

  /** Discard every message AFTER a given assistant message, keeping that
   *  turn and everything before it. Implemented as a fork from the anchor
   *  (`resumeSessionAt` is inclusive — the anchor message is kept) followed
   *  by a clear-style X→Y swap: the source X is removed from the sidebar
   *  (unloaded, `removed` broadcast) and Y replaces it in the panel. The
   *  source transcript is left on disk by default (recoverable via
   *  `/resume`); pass `deleteOriginal: true` to also unlink X's jsonl.
   *
   *  `fromAssistantUuid` MUST be the uuid of a successfully-completed turn's
   *  LAST main-thread assistant message (a "turn anchor"). Any other uuid
   *  (a user prompt, a mid-turn assistant frame, a failed turn) would cut
   *  mid-turn and orphan tool_use↔tool_result pairs — refused with 400.
   *  Anchors are persisted by the pump on every `result.subtype==='success'`
   *  (see turn-anchor-store); we look the supplied uuid up there.
   *
   *  Y inherits X's turn-anchor sidecar truncated to the cut point, so a
   *  later discard on Y can still cut at any earlier turn (the feature
   *  composes — repeated discards walk back through history). */
  async discard(
    id: string,
    fromAssistantUuid: string,
    opts?: { deleteOriginal?: boolean },
  ): Promise<SessionInfo> {
    // 1. Validate the anchor: it must be a recorded turn anchor (a success
    //    turn's last assistant frame). A uuid not in the sidecar is either
    //    a non-anchor message or a turn whose anchor was never persisted —
    //    either way, cutting there would orphan tool pairs, so refuse.
    //    ensureAnchorsLoaded backfills from disk for sessions whose turns
    //    predate the sidecar, so historical sessions are usable too.
    const anchors = await this.ensureAnchorsLoaded(id)
    const anchorIdx = anchors.findIndex((e) => e.assistantUuid === fromAssistantUuid)
    if (anchorIdx < 0) {
      throw new HttpError(
        400,
        `Cannot discard from this message — it isn't the last reply of a ` +
        `successfully-completed turn. Pick an assistant reply to cut after.`,
      )
    }

    // 2. Fork from the anchor. fork() probes the transcript on disk and
    //    throws 410 (marking X terminated) if it's gone, same as resume.
    //    resumeSessionAt is inclusive (SDK: "up to and including"), so the
    //    anchor's whole turn is preserved and only LATER turns are dropped.
    //    Seed Y's in-memory history ring with X's transcript up to (and
    //    including) the anchor, so the panel shows the kept history
    //    immediately instead of an empty "start a conversation" state.
    //    fork()'s SDK subprocess writes Y's disk transcript async after
    //    spawn, so we can't read Y's disk at spawn time — read X's disk
    //    tail and truncate to the anchor, mirroring resume()'s historySeed.
    //    User-prompt uuids are rewritten via X's promptUuid sidecar so the
    //    client's uuid-anchored replay dedup works. Older history beyond
    //    the tail is paged in by the client's loadOlder() scroll-up.
    const liveX = this.sessions.get(id)
    const metaX = liveX ?? this.store?.get(id)
    const providerX = metaX?.provider ?? this.defaultProvider
    let historySeed: SDKMessage[] | undefined
    let seedSource = 'none'
    try {
      // Prefer X's in-memory history rings (merged view): they contain result
      // frames (the SDK doesn't persist result to disk) plus subagent frames
      // the disk reader drops. Using the rings preserves the per-turn result
      // summaries (cost/duration/turns) the client renders, which a disk-only
      // seed would drop. The mixed seed is re-split by frame origin in spawn().
      const mergedX = liveX ? this.mergedHistory(liveX) : []
      if (liveX && mergedX.length > 0) {
        const ringAnchor = mergedX.findIndex((m) => (m as { uuid?: string }).uuid === fromAssistantUuid)
        if (ringAnchor >= 0) {
          historySeed = mergedX.slice(0, ringAnchor + 1) as SDKMessage[]
          seedSource = 'ring'
        }
      }
      // Fall back to disk when the ring is empty (dormant X) or the anchor
      // is older than the ring's window. Disk lacks result frames but covers
      // turns outside the ring.
      if (!historySeed) {
        const page = await this.readProviderHistoryPage(providerX, id, { limit: this.historyCap })
        const anchorInPage = page.messages.findIndex((m) => (m as { uuid?: string }).uuid === fromAssistantUuid)
        historySeed = anchorInPage >= 0
          ? (page.messages.slice(0, anchorInPage + 1) as SDKMessage[])
          : (page.messages.length > 0 ? (page.messages as SDKMessage[]) : undefined)
        seedSource = 'disk'
      }
      log.info(`[session ${id}] discard historySeed: ${historySeed?.length ?? 0} msgs (source: ${seedSource})`)
    } catch (err) {
      log.warn(`[session ${id}] discard historySeed read failed:`, err)
    }
    if (historySeed) {
      const promptUuids = await this.promptUuidStore.load(id)
      // Only merge result frames when the seed came from disk (disk lacks
      // result; the in-memory ring already has them). Avoids double-inserting.
      if (seedSource === 'disk') {
        const resultFrames = await this.resultFrameStore.load(id)
        historySeed = mergeResultFrames(historySeed, resultFrames)
      }
      historySeed = rewriteSeedPromptUuids(historySeed, promptUuids)
    }
    const forkInfo = await this.fork(id, { resumeSessionAt: fromAssistantUuid, historySeed, inheritIdentity: true })

    // 3. Copy X's turn-anchor sidecar to Y, truncated to the cut point
    //    (anchor inclusive). Without this, Y only has anchors for turns it
    //    produces itself — a second discard on Y couldn't cut any earlier
    //    than Y's first new turn, breaking the "repeatedly walk back"
    //    contract. Entries are in completion order, so slice(0, anchorIdx+1)
    //    keeps the anchor and everything before it.
    const inherited = anchors.slice(0, anchorIdx + 1)
    await this.turnAnchorStore.save(forkInfo.id, inherited)

    // Copy X's result-frame sidecar to Y, truncated to the cut point. Only
    // result frames whose assistantUuid is in the inherited anchors (i.e.
    // the turn is at or before the cut point) are kept — later turns'
    // result summaries are discarded along with the turns themselves.
    const resultFrames = (await this.resultFrameStore.load(id)) ?? []
    if (resultFrames.length > 0) {
      const anchorUuids = new Set(inherited.map((a) => a.assistantUuid))
      const inheritedResults = resultFrames.filter((e) => anchorUuids.has(e.assistantUuid))
      if (inheritedResults.length > 0) {
        await this.resultFrameStore.merge(forkInfo.id, inheritedResults)
      }
    }

    // 4. Unload X. removeFromStore drops it from the sidebar (clear-style
    //    X→Y swap). deleteOriginal additionally unlinks X's transcript: we
    //    pass `terminated: true` so unload AWAITS the pump (the CLI
    //    subprocess exits, releasing the file handle) before we unlink —
    //    otherwise Windows EPERM/EBUSY on a still-locked jsonl.
    if (opts?.deleteOriginal) {
      await this.unload(id, { terminated: true, reason: 'discarded', removeFromStore: true })
      await deleteTranscriptFile(id)
      // Await the sidecar removals (not fire-and-forget): callers — the REST
      // route and tests — read them immediately after discard returns, so a
      // pending remove races the read (observed as a flaky "sidecar gone"
      // assertion under full-suite load).
      await this.turnAnchorStore.remove(id)
      await this.resultFrameStore.remove(id)
      await this.promptUuidStore.remove(id)
    } else {
      await this.unload(id, { removeFromStore: true })
    }

    log.info(
      `[session ${id}] discarded ${anchors.length - anchorIdx - 1} turn(s) after anchor ` +
      `${fromAssistantUuid.slice(0, 8)} → forked to ${forkInfo.id}` +
      (opts?.deleteOriginal ? ' (original transcript deleted)' : ' (original kept on disk)'),
    )
    return forkInfo
  }

  /** Load the turn-anchor sidecar, backfilling from the on-disk transcript
   *  when it's empty. The sidecar is only populated by the pump on NEW
   *  success results, so a session whose turns completed before the feature
   *  shipped has an empty sidecar despite hundreds of completed turns on
   *  disk. This reads the transcript, derives each success turn's last
   *  assistant frame (stop_reason !== 'tool_use', no error), and seeds the
   *  sidecar so subsequent calls read it directly. Returns the (now-loaded)
   *  anchors in chronological order. */
  private async ensureAnchorsLoaded(id: string): Promise<TurnAnchorEntry[]> {
    const existing = (await this.turnAnchorStore.load(id)) ?? []
    if (existing.length > 0) return existing
    // Empty sidecar — backfill from disk. readTurnAnchorsFromDisk returns
    // success-turn last-frames; if the transcript is also empty/missing
    // (no completed turns yet), this returns [] and we skip the write (a
    // concurrent turn could still append later). Use `merge` (not `save`)
    // so a pump append that landed between our load and write is preserved
    // rather than clobbered.
    const backfilled = await readTurnAnchorsFromDisk(id)
    if (backfilled.length > 0) {
      await this.turnAnchorStore.merge(id, backfilled)
      log.info(`[session ${id}] backfilled ${backfilled.length} turn anchor(s) from disk`)
    }
    return backfilled
  }

  /** List the legal "discard from here" cut points for a session — each
   *  successfully-completed turn's last assistant message, with a short
   *  preview of that reply. Drives the client's right-click menu: an
   *  assistant message is a legal cut point iff its uuid is in this list.
   *
   *  Preview is the first ~80 chars of the assistant reply's first text
   *  block; falls back to a tool-use label or the uuid prefix when there's
   *  no text (e.g. a pure tool_use reply). */
  async listDiscardAnchors(id: string): Promise<{
    anchors: Array<{ uuid: string; completedAt: number; preview: string }>
  }> {
    const anchors = await this.ensureAnchorsLoaded(id)
    if (anchors.length === 0) return { anchors: [] }

    // Build a uuid → message map from the on-disk transcript so we can
    // attach a preview without a second pass. readHistoryEntries returns
    // every renderable message in chronological order.
    const live = this.sessions.get(id)
    const meta = live ?? this.store?.get(id)
    const providerName = (live?.provider ?? meta?.provider ?? this.defaultProvider)
    const provider = this.providers.get(providerName)
    const uuidToMessage = new Map<string, unknown>()
    if (provider?.readHistoryEntries) {
      try {
        const afterUuid = live?.forkBoundaryUuid ?? meta?.forkBoundaryUuid
        const entries = await provider.readHistoryEntries(id, afterUuid ? { afterUuid } : {})
        for (const entry of entries) {
          const uuid = (entry.message as { uuid?: string }).uuid
          if (typeof uuid === 'string') uuidToMessage.set(uuid, entry.message)
        }
      } catch (err) {
        log.warn(`[session ${id}] listDiscardAnchors: history read failed:`, err)
      }
    }

    return {
      anchors: anchors.map((a) => ({
        uuid: a.assistantUuid,
        completedAt: a.completedAt,
        preview: previewAssistantMessage(uuidToMessage.get(a.assistantUuid)),
      })),
    }
  }

  /** Create a Side Chat — an ephemeral fork of the parent session's
   *  transcript with a boundary prompt that tells the model the inherited
   *  history is reference-only. The Side Chat is a fully independent session
   *  marked with `parentId` so the UI can distinguish it. */
  async createSideChat(parentId: string): Promise<SessionInfo> {
    const live = this.sessions.get(parentId)
    const meta = live ?? this.store?.get(parentId)
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
      const persisted: SessionMeta = this.store?.get(parentId) ?? {
        id: meta.id,
        provider: meta.provider ?? this.defaultProvider,
        createdAt: meta.createdAt,
        lastActivityAt: meta.lastActivityAt,
        cwd: meta.cwd,
        model: meta.model,
        permissionMode: meta.permissionMode,
        title: meta.title,
        betas: meta.betas,
        messageCount: live ? live.history.length + live.subagentHistory.length : (meta as SessionMeta).messageCount,
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
      memory?: unknown
      autoCompactWindow?: number
    } = {
      provider: sourceProvider,
      resume: parentId,
      forkSession: true,
      cwd: meta.cwd,
      model: meta.model,
      permissionMode: meta.permissionMode,
      title,
      effort: meta.effortLevel,
      thinking: meta.thinking,
      autoCompactWindow: meta.autoCompactWindow,
      betas: meta.betas as Options['betas'],
      enabledPlugins: meta.enabledPlugins,
      settings: meta.hooks ? ({ hooks: toSdkHooksSettings(meta.hooks) } as Settings) : undefined,
      // New id (same as fork): carry the auto-memory intent via opts.
      memory: meta.memory,
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
    const allGlobalMcpNames = Object.keys(this.mcpStore?.toSdkConfig() ?? {})
    if (allGlobalMcpNames.length > 0) {
      await this.mcpStore?.refreshOAuthTokens(allGlobalMcpNames)
      sideChatOpts.mcpServers = this.mcpStore?.toSdkConfig()
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
     *  "Ungrouped". Undefined for every other caller.
     *  `evictingSource`: pass `true` for `/clear` and restart — X is being
     *  evicted, so the client bypasses its `maxGroupSize` cap when appending
     *  Y (the group only grows transiently until swapSession / session-removed
     *  removes X). Without it, a FULL group skips the append and Y flashes
     *  under "Ungrouped". Absent for fork (X stays → the cap stands). */
    joinGroupOf?: string,
    evictingSource?: boolean,
    /** On resume: the promptUuids sidecar loaded from disk, used to seed
     *  `session.promptUuids` (so subsequent sends append to the pre-restart
     *  list) AND — at the resume() call site — to rewrite the historySeed's
     *  prompt uuids (SDK V → server U). Undefined for every other caller
     *  (fresh spawn / fork / clear start with an empty list). */
    promptUuids?: PromptUuidEntry[],
    /** Set by the crash-recovery "Fork from last completed turn" button: the
     *  source session X is dead and the fork Y is its continuation, so the
     *  client should REPLACE X with Y in the sidebar group (instead of the
     *  ordinary fork's append that X stays in the group). Lets Y land in X's
     *  group slot even when the group is at `maxGroupSize` — X leaves the
     *  group, so it never overflows. Undefined for every other caller. */
    replacesSource?: boolean,
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

    const existingMeta = this.store?.get(id)
    const createdAt = existingMeta?.createdAt ?? Date.now()
    const metaSnapshot = this.snapshotMeta(fullOpts, providerName)

    // Split the resume/discard seed by frame origin (see the Session literal
    // below for why). stampReceivedAt is set-only-if-absent, so frames that
    // already carry a timestamp (the normal case) keep it.
    const seedMain: SDKMessage[] = []
    const seedSub: SDKMessage[] = []
    for (const m of historySeed ?? []) {
      stampReceivedAt(m)
      if (getParentToolUseId(m) != null) seedSub.push(m)
      else seedMain.push(m)
    }

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
      elicitationSubscribers: new Map(),
      elicitationPending: new Map(),
      dialogSubscribers: new Map(),
      dialogPending: new Map(),
      // Seed the in-memory ring with the on-disk transcript tail on resume.
      // A normally-running session maintains the invariant "history holds the
      // session's recent messages"; a resumed session starts with an empty
      // ring because the SDK loads the transcript as CONTEXT and never
      // re-emits it through the Query stream. Without this seed, the first
      // subscribe replays nothing and the client shows a blank transcript
      // until a new turn lands. Seeding here — before the pump starts and the
      // session enters the map — restores the invariant so replay / reconnect
      // / second-panel subscribe all see the history with zero client-side
      // special-casing. readHistoryPage already normalizes to the live wire
      // shape (see history-reader.ts), so seeded and live frames are
      // indistinguishable downstream.
      // Seed split by frame origin: main-thread frames go to `history`,
      // subagent frames (parent_tool_use_id != null — only present in seeds
      // built from a live session's merged view, e.g. discard(); the disk
      // reader drops isSidechain lines) to `subagentHistory`. Each ring takes
      // its own tail, so neither budget can crowd the other at seed time.
      // stampReceivedAt fills in any frame that lacks a timestamp (a disk
      // line without one) so the mergedHistory sort stays a total order.
      history: seedMain.slice(-this.historyCap),
      subagentHistory: seedSub.slice(-this.subagentHistoryCap),
      contextUsageSubscribers: new Set(),
      lastContextUsage: undefined,
      promptSuggestionSubscribers: new Set(),
      lastPromptSuggestion: undefined,
      tasks: new Map(),
      taskSubscribers: new Set(),
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
      // Preserve gitStartSha across resumes — the persisted meta carries
      // it forward so the "This session" anchor stays stable even if the
      // server restarts. New sessions get a fresh capture below.
      gitStartSha: existingMeta?.gitStartSha,
      fastMode: existingMeta?.fastMode,
      // Auto-compact window intent. Resume paths (same id) restore from the
      // persisted meta; create/fork/clear pass it on opts where snapshotMeta
      // captured it. `??` so an explicit intent survives (undefined = "auto").
      autoCompactWindow: existingMeta?.autoCompactWindow ?? metaSnapshot.autoCompactWindow,
      // Auto-memory intent. Resume paths (same id) restore from the
      // persisted meta; create/fork/clear pass the intent on opts where
      // snapshotMeta captured it. `??` so an explicit intent survives.
      memory: existingMeta?.memory ?? metaSnapshot.memory,
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
      // Seed from the resume sidecar (empty for fresh spawn / fork / clear).
      promptUuids: promptUuids ?? [],
      // A fresh spawn (create / resume / fork / clear) is live, so it's no
      // longer in the deliberately-slept state. This clears a persisted
      // slept:true when the user resumes a session they had slept.
      slept: false,
    }

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
    } else {
      session.canUseTool = fullOpts.canUseTool as Session['canUseTool']
    }

    // Elicitation (MCP OAuth auth / server-initiated forms). Mirrors the
    // canUseTool wiring above. No global-broadcast consumer for now —
    // elicitation is inherently interactive; the dialog appears in the
    // session's Chat panel via the per-session channel + REST snapshot.
    // Pending-changed rebroadcast is kept so SessionInfo updates ride the
    // same fan-out if we later surface a pending-elicitation badge.
    if (!fullOpts.onElicitation) {
      const onElicitation = this.elicitBroker.buildOnElicitation(
        session,
        undefined,
        (s) => {
          if (!this.sessions.has(s.id)) return
          this.broadcastGlobal({ kind: 'update', session: this.info(s) })
        },
      )
      session.onElicitation = onElicitation
      fullOpts.onElicitation = onElicitation
    } else {
      session.onElicitation = fullOpts.onElicitation as Session['onElicitation']
    }

    // User dialogs (blocking CLI prompts, e.g. refusal fallback). Mirrors the
    // elicitation wiring above, plus the atomic pair: `supportedDialogKinds`
    // is handed to the SDK ALONGSIDE the callback (non-empty kinds without a
    // callback make the SDK spawn throw; a callback without kinds is dead
    // code because the CLI fails closed).
    if (!fullOpts.onUserDialog) {
      const onUserDialog = this.dialogBroker.buildOnUserDialog(
        session,
        undefined,
        (s) => {
          if (!this.sessions.has(s.id)) return
          this.broadcastGlobal({ kind: 'update', session: this.info(s) })
        },
      )
      session.onUserDialog = onUserDialog
      fullOpts.onUserDialog = onUserDialog
      ;(fullOpts as { supportedDialogKinds?: string[] }).supportedDialogKinds = [
        ...SUPPORTED_DIALOG_KINDS,
      ]
    } else {
      session.onUserDialog = fullOpts.onUserDialog as Session['onUserDialog']
    }

    const sdkOptions = { ...applySkillPolicyToOptions(fullOpts, skillOverride) } as Options & { provider?: string }
    delete sdkOptions.provider
    // Strip the app-level plugin selection so it doesn't reach the SDK:
    // Options.enabledPlugins is a {[k:string]: string[]|boolean|object} MAP
    // (plugin@marketplace → enabled flag), but we carry a string[] of keys
    // for our own subset resolution. The SDK only needs Options.plugins
    // (resolved paths, set by applyStandardQueryOpts via the provider).
    delete (sdkOptions as { enabledPlugins?: unknown }).enabledPlugins
    // Strip the app-level memory intent (same reason as enabledPlugins):
    // the SDK has no `Options.memory` — it's re-applied post-spawn via
    // applyFlagSettings by the provider. Leaving it in would hand the CLI
    // arg builder an unknown key.
    delete (sdkOptions as { memory?: unknown }).memory
    // Same for autoCompactWindow: no SDK Options key (re-applied post-spawn
    // via applyFlagSettings) — strip so the CLI arg builder never sees it.
    delete (sdkOptions as { autoCompactWindow?: unknown }).autoCompactWindow
    const handle = provider.createSession({
      id,
      provider: providerName,
      cwd: fullOpts.cwd,
      model: fullOpts.model,
      permissionMode: requestedMode,
      title: fullOpts.title,
      betas: Array.isArray(fullOpts.betas) ? fullOpts.betas : undefined,
      effortLevel: session.effortLevel,
      thinking: session.thinking,
      fastMode: session.fastMode,
      autoCompactWindow: session.autoCompactWindow,
      memory: session.memory,
      env: customEnv,
      mcpServers: fullOpts.mcpServers as Record<string, unknown> | undefined,
      enabledPlugins: (fullOpts as { enabledPlugins?: string[] }).enabledPlugins ?? existingMeta?.enabledPlugins,
      includePartialMessages: fullOpts.includePartialMessages,
      includeHookEvents: true,
      // Forward subagent text/thinking frames so SubagentOverlay can render
      // the nested transcript. Spawn-time SDK Options key (config-gated;
      // not runtime-switchable — it's not a Settings key).
      forwardSubagentText: this.forwardSubagentText,
      resume: fullOpts.resume,
      forkSession: fullOpts.forkSession,
      resumeSessionAt: (fullOpts as { resumeSessionAt?: string }).resumeSessionAt,
      onUserMessageConsumed: (msg) => this.onInputConsumed(id, msg as SDKUserMessage),
      canUseTool: fullOpts.canUseTool as ((...args: unknown[]) => Promise<unknown>) | undefined,
      onElicitation: fullOpts.onElicitation as ((...args: unknown[]) => Promise<unknown>) | undefined,
      // Atomic pair: the SDK requires onUserDialog whenever
      // supportedDialogKinds is non-empty, so the two always travel together.
      onUserDialog: fullOpts.onUserDialog as ((...args: unknown[]) => Promise<unknown>) | undefined,
      supportedDialogKinds: (fullOpts as { supportedDialogKinds?: string[] }).supportedDialogKinds,
      providerExtras: { sdkOptions },
    })
    session.handle = handle

    // Same-id replacement (resume()/respawnFresh() spawn with an existing
    // id): if a live handle already sits in the map under this id, destroy it
    // BEFORE overwriting. Otherwise the previous Query is orphaned and keeps
    // running — a duplicate claude.exe (observed with racing resume() calls).
    // destroy() also detaches ProcessMonitor's onExit so the orphan's exit
    // can't fire cleanup into the new session.
    const superseded = this.sessions.get(id)
    if (superseded && superseded.handle && superseded.handle !== handle) {
      log.warn(`[session ${id}] spawn superseding a live session — destroying prior handle`)
      try {
        superseded.handle.destroy('session superseded by new spawn')
      } catch (err) {
        log.warn(`[session ${id}] failed to destroy superseded handle:`, err)
      }
    }

    session.pumpTask = this.pump(session)
    this.sessions.set(id, session)
    log.info(`[session ${id}] spawned model=${fullOpts.model ?? 'default'}, permissionMode=${requestedMode ?? 'default'}, resume=${!!fullOpts.resume}`)
    // Classify the model's effort capability (keyword-based, synchronous) so
    // the very first `created` frame below already carries the correct
    // visible/levels state — no follow-up update needed.
    session.effortLevels = effortLevelsForModel(session.model)
    // Same for thinking capability — keyword-classified, synchronous, so the
    // first `created` frame already carries the correct chip visibility.
    session.thinkingSupported = supportsThinkingForModel(session.model)
    // Brand-new session (or a resume, which also "creates" as far as the
    // UI list is concerned): persist to disk, then broadcast `created`
    // instead of `update`. The frontend `created` handler is the one
    // that knows how to insert, so there's a single canonical origin
    // for the row — no races with the POST /sessions response.
    this.writeStore(session)
    // `joinGroupOf` (set by /clear, restart, fork) is conditionally spread so
    // the wire frame stays clean (no `undefined` key) for plain creates.
    this.broadcastGlobal({
      kind: 'created',
      session: this.info(session),
      ...(joinGroupOf ? { joinGroupOf } : {}),
      ...(evictingSource ? { evictingSource: true } : {}),
      ...(replacesSource ? { replacesSource: true } : {}),
    })
    this.captureGitHead(session)

    return this.info(session)
  }

  /** Send a user turn into an existing session. */
  send(id: string, text: string): SentUserMessage {
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
      `[session ${id}] send PRE-PUSH — ${text.length} chars, uuid=${userMsg.uuid}, ` +
      `pendingTurns=${s.pendingTurns}, input.closed=${s.handle.closed}, ` +
      `input.queueDepth=${s.handle.queueDepth}, ` +
      `running=${s.running}, terminated=${s.terminated}`,
    )
    this.dispatchUserMessage(s, userMsg)
    // dispatchUserMessage → pushToSession → stampReceivedAt stamps receivedAt
    // in place before this returns; cast once here so the route reads it
    // without its own `as unknown as`.
    return userMsg as SentUserMessage
  }

  /** Send a user turn with a content array (text + image blocks). */
  sendContent(id: string, content: Array<{ type: string; [k: string]: unknown }>): SentUserMessage {
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
      `[session ${id}] sendContent PRE-PUSH — blocks=[${blockSummary}], uuid=${userMsg.uuid}, ` +
      `pendingTurns=${s.pendingTurns}, input.closed=${s.handle.closed}`,
    )
    this.dispatchUserMessage(s, userMsg)
    return userMsg as SentUserMessage
  }

  /** Shared tail for send() and sendContent(): push into the SDK input
   *  queue and broadcast to live subscribers.
   *
   *  The Pushable's onConsume callback stamps `consumedAt` on whatever
   *  object it receives.  When the SDK is idle (waiter active), that
   *  stamp fires synchronously during enqueueUserMessage — BEFORE
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
    // A new top-level user turn invalidates the previous turn's predicted
    // next-prompt. If we leave `lastPromptSuggestion` set, it resurfaces as
    // the reconnect snapshot (subscribePromptSuggestion) and — when the SDK
    // suppresses a fresh suggestion for this turn (plan mode / API error /
    // first turn) — a later resubscribe resurrects the stale prediction.
    // Clear it here, matching the client's own send-time clear.
    if (s.lastPromptSuggestion != null) {
      s.lastPromptSuggestion = undefined
    }
    s.handle.enqueueUserMessage({ ...userMsg })
    this.pushToSession(s, userMsg)
    this.recordPromptUuid(s, userMsg)
  }

  /** Record a just-sent top-level prompt's server-minted uuid (`u`) as an
   *  UNPAIRED entry in the in-memory `promptUuids` list (v undefined). The SDK
   *  uuid `v` is filled in later by `onPromptEcho` when the SDK echoes the
   *  prompt back (FIFO order pairs the echo's `v` with the oldest unpaired
   *  `u`), at which point the sidecar is persisted. Recording `u` here (without
   *  `v`) and persisting only at echo time means the sidecar never holds a `u`
   *  whose `v` isn't also on disk — eliminating the sidecar-ahead desync that
   *  broke the earlier positional scheme on same-text prompts. */
  private recordPromptUuid(s: Session, userMsg: SDKUserMessage): void {
    if (userMsg.parent_tool_use_id != null) return // not a top-level prompt (defensive)
    const u = typeof userMsg.uuid === 'string' ? userMsg.uuid : null
    if (!u) return
    const next = [...(s.promptUuids ?? []), { u }]
    // Keep every in-flight entry: SDK echoes can be delayed while a burst of
    // queued prompts exceeds historyCap. Capping the whole list here would
    // discard old unpaired entries and make the later FIFO echo pair with the
    // wrong server uuid. Only completed mappings are bounded; unpaired entries
    // are transient and are removed from the persisted sidecar at echo time.
    s.promptUuids = retainPromptUuidEntries(next, this.historyCap)
    // No sidecar save here — see onPromptEcho (the entry is only useful once
    // its SDK uuid `v` is known, which happens at echo time).
  }

  /** Pair the SDK echo uuid `v` with the oldest still-unpaired sent prompt `u`
   *  in `session.promptUuids`, then persist the sidecar. Called from the pump's
   *  top-level-user-echo drop-filter (the SDK echoes each persisted prompt back
   *  through the Query stream in FIFO order, so the oldest unpaired `u` is the
   *  match). On a resume replay, every loaded entry is already paired (v set),
   *  so this is a no-op. */
  private onPromptEcho(s: Session, echoUuid: string): void {
    const list = s.promptUuids
    if (!list || list.length === 0) return
    const idx = list.findIndex((e) => e.v == null)
    if (idx === -1) return // no unpaired send (resume replay, or echo for a non-send frame)
    if (list.some((e) => e.v === echoUuid)) return // already paired (defensive against a double echo)
    list[idx] = { ...list[idx], v: echoUuid }
    void this.promptUuidStore.save(s.id, list)
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
    // NOTE: crash-recovery counts are intentionally NOT reset here. Resetting
    // on every user message would defeat the ladder for a poisonous turn that
    // crashes the CLI on the model's response (but loads fine on resume):
    // each send would reset the counter, so the cycle stayed in-place forever
    // and never exhausted into the give-up banner. The ladder resets only on
    // proven health (a clean idle-autoResume after recovery — see
    // autoResume()).
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
    log.info(
      `[session ${id}] interrupt requested — pendingTurns=${s.pendingTurns}, ` +
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

  /** Background in-flight foreground tasks (Bash commands + subagents) —
   *  the CLI's Ctrl+B semantics. Resolves false when the SDK reports there
   *  was nothing to background. */
  async backgroundTasks(id: string, toolUseId?: string): Promise<boolean> {
    const s = this.requireLive(id)
    log.info(`[session ${id}] background tasks requested — toolUseId=${toolUseId ?? '(all)'}`)
    const result = await this.requireHandleMethod<(toolUseId?: string) => Promise<boolean>>(
      s,
      'backgroundTasks',
      'background tasks',
      'supportsTaskControl',
    )(toolUseId)
    s.lastActivityAt = Date.now()
    this.persist(s)
    return result
  }

  /** Stop a running background task by id. The SDK emits a
   *  task_notification (status 'stopped') that folds the task state. */
  async stopTask(id: string, taskId: string): Promise<void> {
    const s = this.requireLive(id)
    log.info(`[session ${id}] stop task requested — taskId=${taskId}`)
    await this.requireHandleMethod<(taskId: string) => Promise<void>>(
      s,
      'stopTask',
      'task stop',
      'supportsTaskControl',
    )(taskId)
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
  async clear(id: string, opts?: { seedText?: string }): Promise<SessionInfo> {
    const s = this.requireRunnable(id)
    if (s.clearing) return this.info(s)

    s.clearing = true
    log.info(`[session ${id}] clear: detaching pre-clear conversation`)
    try {
      // Resolve any pending tool-permission requests so SDK awaiters
      // don't hang once we destroy the handle.
      this.permBroker.denyAll(s)
      this.elicitBroker.cancelAll(s)
      this.dialogBroker.cancelAll(s)

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
        thinking: s.thinking,
        autoCompactWindow: s.autoCompactWindow,
        betas: s.betas,
        hooks: s.hooks,
        fastMode: s.fastMode,
        enabledPlugins: s.enabledPlugins,
        parentId: s.parentId,
        memory: s.memory,
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
      const freshOpts: Options & { provider?: string; enabledPlugins?: string[]; memory?: unknown; autoCompactWindow?: number } = {
        provider: settings.provider,
        cwd: settings.cwd,
        model: settings.model,
        permissionMode: settings.permissionMode,
        title: settings.title,
        effort: settings.effortLevel,
        thinking: settings.thinking,
        autoCompactWindow: settings.autoCompactWindow,
        betas: settings.betas as Options['betas'],
        settings: settings.hooks ? ({ hooks: toSdkHooksSettings(settings.hooks) } as Settings) : undefined,
        enabledPlugins: settings.enabledPlugins,
        // Carry the auto-memory intent onto the fresh session (new id —
        // snapshotMeta captures it from here, same as fork).
        memory: settings.memory,
      }
      if (settings.parentId) {
        freshOpts.systemPrompt = {
          type: 'preset',
          preset: 'claude_code',
          append: SIDE_DEVELOPER_INSTRUCTIONS,
        }
        ;(freshOpts as Options & { parentId?: string }).parentId = settings.parentId
      }
      const allGlobalMcpNames = Object.keys(this.mcpStore?.toSdkConfig() ?? {})
      if (allGlobalMcpNames.length > 0) {
        await this.mcpStore?.refreshOAuthTokens(allGlobalMcpNames)
        freshOpts.mcpServers = this.mcpStore?.toSdkConfig()
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
        // evictingSource: X is being detached by this clear(), so the client
        // bypasses its maxGroupSize cap when appending Y to X's group (the
        // group only grows transiently until swapSession / session-removed
        // evicts X). Without this, a full group flashes Y under "Ungrouped".
        true,
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

      // Optional compaction seed: when this clear was requested by compact(),
      // inject the hand-off summary into Y so the continuation can pick up
      // where X left off. Seeded as a `shouldQuery:false` user message (appended
      // to Y's transcript without triggering a turn; merged into the next real
      // user message) plus a synthetic `compact_boundary` divider so the client
      // renders the familiar compact divider + summary. Must happen while Y is
      // live and X is still attached — the swap that follows is then identical
      // to a plain /clear. Best-effort: a failure is logged and the clear still
      // completes (Y is usable, just without the summary seed).
      if (opts?.seedText) {
        try {
          this.seedCompactSummary(newYId, opts.seedText)
        } catch (err) {
          log.warn(`[session ${newYId}] clear: seeding compact summary failed:`, err)
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

  /** `/compact` — summarise the conversation, then continue in a fresh session
   *  seeded with the summary (CLI `/compact` semantics).
   *
   *  The SDK has no programmatic compact (auto-compact is CLI-internal), so we
   *  implement it as "summarise + clear-with-seed": summarize X's history via
   *  the LLM, spawn a fresh session Y carrying the same settings, seed Y with
   *  the hand-off summary (as a `shouldQuery:false` user message that merges
   *  into the next real turn), and detach X exactly like /clear. The client
   *  renders the synthetic compact divider + summary; the next user message
   *  continues the conversation with the summary in context.
   *
   *  Phase-guarded like recap auto-generation: unknown → 404, terminated →
   *  410, dormant → 412, working (in-flight turn / queued input / unanswered
   *  permission prompt / running background subagent) → 409. */
  async compact(id: string): Promise<SessionInfo> {
    const s = this.require(id)
    switch (this.phaseOf(s)) {
      case 'terminated':
        throw new HttpError(410, `session ${id} is terminated`)
      case 'dormant':
        throw new HttpError(412, `session ${id} is dormant; resume it before compacting`)
      case 'working':
        throw new HttpError(409, `session ${id} is working; retry when idle`)
    }
    // Merged view — behavior parity with the old single mixed ring (the
    // summarizer always saw subagent tool frames; it still sees subagent
    // frames, including the now-forwarded text/thinking ones).
    const merged = this.mergedHistory(s)
    const summary = await summarizeForCompact(merged, s.model)
    if (!summary) {
      log.info(`[session ${id}] compact: no compressible content, falling back to plain clear`)
      return this.clear(id)
    }
    log.info(`[session ${id}] compact: summarised ${merged.length} messages, seeding fresh session`)
    return this.clear(id, { seedText: summary })
  }

  /** Seed a freshly-spawned session Y with a compact hand-off summary.
   *
   *  Two artifacts, both broadcast to Y's subscribers and appended to Y's
   *  history ring, in this exact order (the client computes `isCompactSummary`
   *  from the PREVIOUS transcript item, so the boundary MUST precede the
   *  summary):
   *
   *   1. A synthetic `system/compact_boundary` divider. Client-only — the SDK
   *      never sees it (the CLI emits its own boundary when IT compacts; here
   *      we fabricate one so the UI shows the familiar divider).
   *   2. A user-role summary carrying the LLM hand-off text, pushed to the SDK
   *      via `sendControlMessage` with `shouldQuery:false` — the SDK appends
   *      it to the transcript WITHOUT triggering an assistant turn and merges
   *      it into the next user message that does query. `isSynthetic: true`
   *      makes the client render it as a neutral card, not a "you" bubble.
   *
   *  The pump's drop-filter discards the seed's eventual text-only echo
   *  (`parent_tool_use_id === null`), so the ring holds exactly one copy. */
  private seedCompactSummary(sessionId: string, summary: string): void {
    const s = this.sessions.get(sessionId)
    if (!s || !s.running) return

    // 1) Client-facing divider — never sent to the SDK. pre_tokens reflects
    //    the session's last-known context usage (or 0 before any snapshot).
    const boundary: import('@anthropic-ai/claude-agent-sdk').SDKCompactBoundaryMessage = {
      type: 'system',
      subtype: 'compact_boundary',
      uuid: randomUUID(),
      session_id: s.id,
      compact_metadata: {
        trigger: 'auto',
        pre_tokens: s.lastContextUsage?.totalTokens ?? 0,
      },
    }
    stampReceivedAt(boundary)
    pushBounded(s.history, boundary, this.historyCap)
    for (const sub of s.subscribers.values()) {
      try { sub.push(boundary) } catch { /* dropped */ }
    }

    // 2) User-role summary — seed the SDK (no turn) AND broadcast locally.
    const control = s.handle.sendControlMessage
    if (typeof control !== 'function') {
      throw new HttpError(501, `provider ${s.provider} does not support compact seeding`)
    }
    const seed: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: summary },
      parent_tool_use_id: null,
      isSynthetic: true,
      shouldQuery: false,
      uuid: randomUUID(),
      session_id: s.id,
    }
    control.call(s.handle, seed)
    stampReceivedAt(seed)
    pushBounded(s.history, seed, this.historyCap)
    for (const sub of s.subscribers.values()) {
      try { sub.push(seed) } catch { /* dropped */ }
    }
    s.lastActivityAt = Date.now() // restart the idle clock on Y
  }

  /** Put a live, idle session into dormant state to release its resources
   *  (SDK subprocess, pump task, WS subscriber queues, pending-permission
   *  map, git-broadcast timer, background-subagent watchers) WITHOUT deleting
   *  it. The on-disk metadata + transcript are kept, so `resume(id)` brings
   *  the session back. This is the user-facing "sleep" entry point — the
   *  reversible counterpart to `delete()` (which terminates + removes the
   *  store entry).
   *
   *  Reuses the private `unload()` dormant path verbatim; the only added
   *  logic is the idle guard. `phaseOf` returns `'working'` for `clearing`,
   *  `pendingTurns > 0`, `queueDepth > 0`, `pending.size > 0`, and a live
   *  background-subagent watcher, so a single `!== 'idle'` check rejects
   *  every mid-turn race (in-flight turn, queued input, unanswered
   *  permission prompt, still-running async subagent) — sleeping any of
   *  those would drop an in-flight assistant response, strand a permission
   *  awaiter, or abandon a background subagent's completion watcher.
   *  Terminated sessions fail `requireLive` (410); already-dormant sessions
   *  aren't in the live map, so `requireLive` → `require` throws 404. */
  async sleep(id: string): Promise<SessionInfo> {
    const s = this.requireLive(id)
    if (this.phaseOf(s) !== 'idle') {
      // The parent turn may have already finished while a background
      // subagent is still running — blame the real blocker, not the turn.
      const hasBackgroundSubagent = (this.backgroundWatchers.get(s.id)?.size ?? 0) > 0
      throw new HttpError(
        409,
        hasBackgroundSubagent
          ? `session ${id} has a background subagent still running — wait for it to finish before sleeping`
          : `session ${id} is working — wait for the turn to finish before sleeping`,
      )
    }
    log.info(`[session ${id}] sleep: unloading to dormant (releasing SDK subprocess + subscribers)`)
    // Mark the session as deliberately-slept BEFORE unload persists it, so
    // the flag survives a server restart and the client can distinguish
    // this from a passive restart/crash dormant state (and skip auto-resume
    // paths). Cleared on the next spawn() (resume / fresh).
    s.slept = true
    await this.unload(id) // no opts => dormant, not terminated; keep store + transcript
    // Read the info off the (now-detached) session object directly rather
    // than this.get(id): `s` is the ground truth we just unloaded, and this
    // avoids a store lookup (and works even when no store is configured).
    return this.info(s)
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
    // The model changed — recompute its effort capability (keyword-based,
    // synchronous). The persist() below broadcasts the session-update
    // carrying the new effortLevels.
    s.effortLevels = effortLevelsForModel(s.model)
    // Thinking capability tracks the model family too — recompute on switch.
    s.thinkingSupported = supportsThinkingForModel(s.model)
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
    const meta = this.store?.get(id)
    if (!meta) throw new HttpError(404, `session ${id} not found`)
    const nextMeta: SessionMeta = { ...meta, title: trimmed, lastActivityAt: Date.now() }
    this.store.upsert(nextMeta)
    const info = this.infoFromMeta(nextMeta)
    this.broadcastGlobal({ kind: 'update', session: info })
    return info
  }

  async setPermissionMode(id: string, mode: PermissionMode): Promise<SessionInfo> {
    const s = this.requireLive(id)
    // Local state is updated FIRST and unconditionally — it is the source of
    // truth for canUseTool and the UI, and guarantees the switch never fails
    // (including — bypassPermissions, which the SDK refuses mid-session).
    s.permissionMode = mode
    s.lastActivityAt = Date.now()
    // Forward to the SDK so its read-only `plan` steering engages / disengages.
    //   - switching INTO plan  — forward 'plan'
    //   - switching OUT of plan (forwarded === undefined) — forward 'default'
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
    // Keep the session's persisted auto-compact window in sync when the
    // generic /settings route forwards it directly (the dedicated
    // setAutoCompactWindow route is the primary path). `autoCompactEnabled`
    // alone (no window) is a plain toggle and doesn't pin a window — only
    // `autoCompactWindow` writes the intent.
    if ('autoCompactWindow' in forwarded) {
      const w = forwarded.autoCompactWindow
      s.autoCompactWindow = typeof w === 'number' && Number.isFinite(w) && w > 0 ? Math.round(w) : undefined
    }
    s.lastActivityAt = Date.now()
    this.persist(s)
    return this.info(s)
  }

  getHooks(id: string): { hooks: SessionHooksConfig; runs: HookRunRecord[] } {
    const s = this.sessions.get(id)
    if (s) return { hooks: s.hooks ?? {}, runs: s.hookRuns.slice() }
    const meta = this.store?.get(id)
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
   *  parses into s.fastModeState — so we do NOT optimistically set the
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

  /** Set per-session auto-memory settings (enable / directory / auto-dream).
   *  Forwards the intent to the SDK via applyFlagSettings — a `null` value
   *  clears the key back to its project/SDK default — and records it locally
   *  so it survives resume/restart (re-applied on respawn). Only the keys
   *  present in `partial` are touched; when the last key is cleared the
   *  whole `memory` object becomes undefined ("never pinned"). The SDK
   *  silently ignores autoMemoryDirectory when projectSettings pins it —
   *  no error surfaces here. */
  async setMemorySettings(
    id: string,
    partial: { autoMemoryEnabled?: boolean | null; autoMemoryDirectory?: string | null; autoDreamEnabled?: boolean | null },
  ): Promise<SessionInfo> {
    const s = this.requireLive(id)
    const flags: Record<string, boolean | string | null> = {}
    if ('autoMemoryEnabled' in partial) flags.autoMemoryEnabled = partial.autoMemoryEnabled ?? null
    if ('autoDreamEnabled' in partial) flags.autoDreamEnabled = partial.autoDreamEnabled ?? null
    // Forward the directory trimmed / null-normalised so the SDK's view
    // matches the persisted record below (a whitespace-only string would
    // otherwise set a literal " " dir in the SDK while the UI shows "not set").
    if ('autoMemoryDirectory' in partial) {
      flags.autoMemoryDirectory = (partial.autoMemoryDirectory ?? '').trim() || null
    }
    if (Object.keys(flags).length === 0) return this.info(s)
    await this.requireHandleMethod<(settings: Record<string, unknown>) => Promise<void>>(
      s,
      'applyFlagSettings',
      'memory settings',
    )(flags)
    const next: SessionMemorySettings = { ...(s.memory ?? {}) }
    for (const [key, value] of Object.entries(partial)) {
      const k = key as keyof SessionMemorySettings
      if (value == null || (k === 'autoMemoryDirectory' && !String(value).trim())) delete next[k]
      else if (k === 'autoMemoryDirectory') next[k] = String(value).trim()
      else next[k] = value as boolean
    }
    s.memory = Object.keys(next).length > 0 ? next : undefined
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
   *  current model are silently downgraded by the SDK — no error. The
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

  /** Pin the auto-compact window for a session. `tokens > 0` sets an
   *  absolute window (SDK Settings.autoCompactWindow) and enables
   *  auto-compact; `null` clears both keys back to "auto" (the CLI derives
   *  the threshold from the model's context window). Forwards the intent to
   *  the SDK via applyFlagSettings and records it locally so it survives
   *  resume/restart (re-applied on respawn). No capability gate — the
   *  applyFlagSettings handle method is the only prerequisite, same as
   *  setMemorySettings. */
  async setAutoCompactWindow(id: string, tokens: number | null): Promise<SessionInfo> {
    const s = this.requireLive(id)
    const window = tokens && tokens > 0 ? Math.round(tokens) : undefined
    const flags: Record<string, unknown> = window
      ? { autoCompactWindow: window, autoCompactEnabled: true }
      : { autoCompactWindow: null, autoCompactEnabled: null }
    await this.requireHandleMethod<(settings: Record<string, unknown>) => Promise<void>>(
      s,
      'applyFlagSettings',
      'auto-compact window',
    )(flags)
    s.autoCompactWindow = window
    s.lastActivityAt = Date.now()
    this.persist(s)
    return this.info(s)
  }

  /** Change extended thinking on a LIVE session. Unlike effort (a Settings
   *  key applied via applyFlagSettings), thinking has NO Settings key — the
   *  SDK's only runtime path is the deprecated-but-functional
   *  Query.setMaxThinkingTokens. The ThinkingSetting → token mapping:
   *    - adaptive  → null (clears any explicit budget; model decides)
   *    - disabled  → 0
   *    - enabled N → N
   *    - enabled (no budget) → not expressible via setMaxThinkingTokens;
   *      rejected with a 400 so the client only offers the Auto/Off/budget
   *      triple. The SDK-side effect survives respawn via Options.thinking
   *      (session.thinking is re-applied at spawn), so the deprecated path is
   *      only needed for the LIVE switch. */
  async setThinking(id: string, setting: ThinkingSetting): Promise<SessionInfo> {
    const s = this.requireLive(id)
    if (setting.type === 'enabled' && (setting.budgetTokens == null || setting.budgetTokens <= 0)) {
      throw new HttpError(400, "thinking 'enabled' requires a positive budgetTokens for a live switch")
    }
    const tokens = setting.type === 'adaptive' ? null
      : setting.type === 'disabled' ? 0
      : (setting.budgetTokens as number)
    await this.requireHandleMethod<(tokens: number | null) => Promise<void>>(
      s,
      'setMaxThinkingTokens',
      'thinking config',
      'supportsThinkingControl',
    )(tokens)
    s.thinking = setting
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
        log.warn(`[session ${id}] SDK ${label} resolved in ${ms}ms (slow — check init handshake / subprocess)`)
      } else {
        log.debug(`[session ${id}] SDK ${label} resolved in ${ms}ms`)
      }
      return result
    } catch (err) {
      log.error(`[session ${id}] SDK ${label} rejected after ${Date.now() - startedAt}ms:`, err)
      throw err
    }
  }

  async supportedModels(id: string): Promise<ModelInfo[]> {
    const s = this.requireLive(id)
    const fn = this.requireHandleMethod<() => Promise<unknown>>(s, 'supportedModels', 'supported models')
    const raw = (await this.timeSdkControl(id, 'supportedModels', fn)) as SdkModelInfo[]
    return raw
      .filter((m) => typeof m.value === 'string' && m.value.trim().length > 0)
      .map((m) => ({
        id: m.value,
        display_name: m.displayName,
        description: m.description,
        supports_fast_mode: m.supportsFastMode,
        supports_effort: m.supportsEffort,
        supported_effort_levels: m.supportedEffortLevels,
      }))
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

    // Update the tracked MCP server names so the client's "available"
    // computation stays in sync without relying on the flaky mcp-status.
    s.mcpServerNames = Object.keys(servers)
    this.writeStore(s)
    this.broadcastGlobal({ kind: 'update', session: this.info(s) })

    return result
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

    // Add explicitly-requested global servers. The parameter is typed
    // `string[]` and the HTTP routes validate it via `validateStringArray`
    // before calling, so no runtime Array.isArray / typeof guard is needed
    // here — the type system is the single boundary.
    //
    // An explicit request overrides the global `enabled` flag: a globally
    // disabled server is "off by default" (not pre-checked in the new-session
    // dialog) but the user can still opt into it per session by checking its
    // box. `toSdkConfig` skips disabled servers, so for names not present
    // there we fall back to `getSdkServerConfig`, which ignores `enabled`.
    // Unknown names resolve to nothing and are silently dropped.
    if (enabledGlobal) {
      for (const name of enabledGlobal) {
        const cfg = global[name] ?? this.mcpStore?.getSdkServerConfig(name)
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
    if (this.mcpStore && enabledGlobal) {
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

  /** Structured /usage data for one session: cost/usage totals plus
   *  claude.ai plan rate-limit windows when available. Mirrors
   *  contextUsage — a capability-gated passthrough to the provider handle. */
  async usage(id: string) {
    const s = this.requireLive(id)
    const fn = this.requireHandleMethod<() => Promise<unknown>>(
      s,
      'getUsage',
      'session usage',
      'supportsUsage',
    )
    return this.timeSdkControl(id, 'getUsage', fn)
  }

  /** Auto-generate a session title from a short description, via the SDK's
   *  `generate_session_title` control request (persisted to the CLI
   *  transcript via `persist: true` so it survives resume). NO-OP when the
   *  session already has a title — the user named it, or an earlier
   *  auto-title landed — so a user-chosen title is never overwritten.
   *  Mirrors usage()/accountInfo() as a capability-gated provider passthrough,
   *  but additionally writes the title into SessionMeta + broadcasts a
   *  session-update so every tab's sidebar refreshes. */
  async autoGenerateTitle(id: string, description: string): Promise<SessionInfo> {
    const s = this.requireLive(id)
    // Guard FIRST: a named session must never trigger an LLM title call.
    if (s.title) return this.info(s)
    const fn = this.requireHandleMethod<(desc: string) => Promise<unknown>>(
      s,
      'generateTitle',
      'auto-title',
      'supportsSessionTitle',
    )
    const raw = await this.timeSdkControl(id, 'generateSessionTitle', () => fn(description))
    const generated = String((raw as { title?: unknown } | undefined)?.title ?? '').trim()
    if (!generated) {
      log.warn(`[session ${id}] auto-title generated an empty title; leaving untitled`)
      return this.info(s)
    }
    s.title = generated
    s.lastActivityAt = Date.now()
    this.persist(s)
    this.broadcastGlobal({ kind: 'update', session: this.info(s) })
    return this.info(s)
  }

  /** Authenticated-account info for the session's CLI subprocess (email,
   *  organization, subscription type, auth backend). Live-Query-only control
   *  read like /usage; narrowed to the clean wire shape so the client never
   *  renders a raw SDK response. Undefined when the SDK reports nothing. */
  async accountInfo(id: string): Promise<AccountInfoData | undefined> {
    const s = this.requireLive(id)
    const fn = this.requireHandleMethod<() => Promise<unknown>>(
      s,
      'accountInfo',
      'account info',
      'supportsAccountInfo',
    )
    const raw = await this.timeSdkControl(id, 'accountInfo', fn)
    return coerceAccountInfo(raw)
  }

  /** Restore the session's tracked files to their state at user message
   *  `messageId` (SDK Query.rewindFiles, requires enableFileCheckpointing —
   *  on by default in the claude provider). `messageId` is the app-level
   *  (server-minted) uuid the client knows; it is mapped to the SDK's
   *  on-disk uuid via the in-memory promptUuids pairs. `dryRun: true`
   *  previews the diff without touching files.
   *
   *  Idle-only: rewinding mid-turn would race the running tool edits, so a
   *  working/queued session gets a 409. A REAL (non-dry) rewind also fires
   *  git-status-changed so open GitPanels refetch the now-changed worktree. */
  async rewindFiles(id: string, messageId: string, opts?: { dryRun?: boolean }): Promise<RewindFilesResult> {
    const s = this.requireLive(id)
    switch (this.phaseOf(s)) {
      case 'terminated':
        throw new HttpError(410, `session ${id} is terminated`)
      case 'dormant':
        throw new HttpError(412, `session ${id} is dormant; resume it before rewinding`)
      case 'working':
        throw new HttpError(409, `session ${id} is working; wait for the turn to finish before rewinding`)
    }
    // Map the app-level uuid → the SDK on-disk uuid. The pair exists only
    // once the SDK has echoed the prompt back (i.e. persisted it), which is
    // exactly the precondition for a checkpoint existing at that message.
    const sdkUuid = (s.promptUuids ?? []).find((e) => e.u === messageId && e.v != null)?.v
    if (!sdkUuid) {
      throw new HttpError(
        400,
        `no checkpoint target for message ${messageId} — the message was sent before uuid tracking, hasn't been persisted yet, or is not a sent user prompt`,
      )
    }
    const fn = this.requireHandleMethod<(mid: string, options?: { dryRun?: boolean }) => Promise<unknown>>(
      s,
      'rewindFiles',
      'file rewind',
      'supportsRewindFiles',
    )
    const raw = await this.timeSdkControl(id, 'rewindFiles', () => fn(sdkUuid, opts))
    const result = coerceRewindResult(raw)
    // A real rewind rewrote the worktree — nudge git consumers to refetch.
    if (result.canRewind && !opts?.dryRun) this.broadcastGitStatusChanged(id)
    return result
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
    // also switch the session out of plan mode into an execution mode — the
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

  /** Resolve a pending AskUserQuestion with free-form clarification. */
  clarifyQuestion(sid: string, pid: string, feedback: string): void {
    const s = this.require(sid)
    this.permBroker.clarifyQuestion(s, pid, feedback)
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

  /** List pending MCP elicitation (auth) requests for a session. */
  listPendingElicitation(id: string): ElicitationRequestUi[] {
    return this.elicitBroker.listPendingElicitation(this.require(id))
  }

  /** Resolve a pending MCP elicitation with the user's decision. */
  decideElicitation(id: string, eid: string, decision: ElicitationDecision): void {
    const s = this.require(id)
    this.elicitBroker.decideElicitation(s, eid, decision)
    s.lastActivityAt = Date.now()
    this.persist(s)
  }

  /** Subscription for elicitation-channel events. */
  subscribeElicitation(id: string): {
    iterable: AsyncIterable<ElicitationEvent>
    snapshot: ElicitationRequestUi[]
    unsubscribe: () => void
  } {
    return this.elicitBroker.subscribeElicitation(this.require(id))
  }

  /** List pending user dialogs (e.g. refusal fallback) for a session. */
  listPendingDialogs(id: string): UserDialogRequestUi[] {
    return this.dialogBroker.listPendingDialogs(this.require(id))
  }

  /** Resolve a pending user dialog with the user's decision. */
  decideDialog(id: string, did: string, decision: UserDialogDecision): void {
    const s = this.require(id)
    this.dialogBroker.decideDialog(s, did, decision)
    s.lastActivityAt = Date.now()
    this.persist(s)
  }

  /** Subscription for dialog-channel events. */
  subscribeDialog(id: string): {
    iterable: AsyncIterable<DialogEvent>
    snapshot: UserDialogRequestUi[]
    unsubscribe: () => void
  } {
    return this.dialogBroker.subscribeDialog(this.require(id))
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
   *  Small maxDepth — a clear is a rare, idempotent event and the durable
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

  /** Chronological merged view of both history rings (sort by receivedAt).
   *  This is the ONLY read surface for the rings — replay (subscribe),
   *  snapshots (getHistory), fork/discard seeds, and the compact summarizer
   *  input all go through it, preserving the exact ordering contract the old
   *  single mixed ring had. Every frame in either ring is stamped (pump
   *  stamps before pushing; the spawn seed split stamps), and the stamps are
   *  monotonic (see stampReceivedAt) — so the sort is a strict total order
   *  equal to arrival order. A plain Date.now() here would NOT suffice:
   *  same-ms frames tie, and a stable sort over `[...main, ...sub]` would
   *  float same-ms subagent frames after every main frame. */
  private mergedHistory(s: Session): SDKMessage[] {
    return [...s.history, ...s.subagentHistory].sort(
      (a, b) =>
        ((a as { receivedAt?: number }).receivedAt ?? 0) -
        ((b as { receivedAt?: number }).receivedAt ?? 0),
    )
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
      history: this.mergedHistory(s),
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
    this.store?.remove(id)
    // Drop the promptUuids sidecar too — the session is gone for good.
    void this.promptUuidStore.remove(id)
    // And the turn-anchor sidecar (legal discard cut points).
    void this.turnAnchorStore.remove(id)
    // And the result-frame sidecar (per-turn result summaries).
    void this.resultFrameStore.remove(id)
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
   *  persistence store (prevents future resume) — used on explicit delete
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
    // Stop polling any background subagents' transcripts — a late completion
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
    this.elicitBroker.cancelAll(s)
    this.dialogBroker.cancelAll(s)
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
    // `removeFromStore` suppresses the dormant `update` — `removed` is
    // broadcast at the tail instead (after the map delete), so the
    // client drops X from the sidebar rather than dimming it dormant.
    if (!opts.terminated && !opts.removeFromStore) {
      this.broadcastGlobal({ kind: 'update', session: this.info(s) })
    }
    this.sessions.delete(id)
    // Clear the recap state. The session is no longer in the manager's
    // map so getPhase will return 'unknown' from inside the manager —
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
    // Most recent activity first — matches the old behaviour of live-only
    // sessions sitting at the top while the user works on them.
    out.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    return out
  }

  /** Coarse per-session activity snapshot for host-side watchers (App Plugin
   *  background code that must NOT see the transcript). One entry per live
   *  session carrying the lifecycle + usage signals a polling plugin needs to
   *  pick an idle candidate — `pendingTurns`/`pendingPermissions` to skip
   *  working sessions, `historyLength` to skip thin ones, `lastActivityAt`
   *  for the idle clock. */
  listActivity(): SessionActivity[] {
    const out: SessionActivity[] = []
    for (const s of this.sessions.values()) {
      const isWorking = s.running && s.pendingTurns > 0
      out.push({
        sessionId: s.id,
        provider: s.provider,
        cwd: s.cwd,
        model: s.model,
        running: s.running,
        terminated: s.terminated,
        slept: s.slept,
        pendingTurns: s.pendingTurns,
        pendingPermissions: s.pending.size,
        lastActivityAt: s.lastActivityAt,
        workingSince: isWorking ? s.workingSince : undefined,
        historyLength: s.history.length + s.subagentHistory.length,
      })
    }
    return out
  }

  /** List sessions resumable from disk via the SDK's `listSessions()`.
   *
   *  Unlike `list()` (which only knows about sessions THIS app created /
   *  persisted), this scans `~/.claude/projects/` for every transcript —
   *  including sessions the `claude` CLI created directly in the same
   *  project dirs, which never appear in our sidebar. That's the whole
   *  point of the /resume picker.
   *
   *  Each result is annotated against our live + persisted state:
   *    - `known`      — already in our store or in memory
   *    - `running`    — has a live Query right now
   *    - `terminated` — we've marked it un-resumable (e.g. transcript gone)
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
        const meta = this.store?.get(s.sessionId)
        const providerName = s.provider ?? live?.provider ?? meta?.provider ?? provider.name
        if (live && live.provider !== providerName) continue
        if (!live && meta?.provider && meta.provider !== providerName) continue
        const terminated = live?.terminated ?? meta?.terminated ?? false
        mapped.push({
          ...s,
          provider: providerName,
          known: !!live || !!meta,
          running: !!live && live.running,
          terminated,
          // Transient-terminated (crash / query error): the server's
          // resume() will still attempt it, so let the picker offer retry.
          canRetryResume:
            terminated &&
            isTransientTerminatedReason(live?.terminatedReason ?? meta?.terminatedReason),
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
    const meta = this.store?.get(id)
    if (meta) return this.infoFromMeta(meta)
    throw new HttpError(404, `session ${id} not found`)
  }

  /** Snapshot of the in-memory message history for a live session.
   *  Returns null for dormant (not-in-memory) sessions. */
  getHistory(id: string): SDKMessage[] | null {
    const s = this.sessions.get(id)
    return s ? this.mergedHistory(s) : null
  }

  /** Cached context-usage snapshot for a session, or null when the session is
   *  unknown or has no snapshot yet. Cheap: reads the value the pump cached
   *  from the last context-usage frame — never touches the SDK (contrast the
   *  live `contextUsage(id)` above, which round-trips to the subprocess). */
  getCachedContextUsage(id: string): import('./session-pump.js').LiteContextUsage | null {
    return this.sessions.get(id)?.lastContextUsage ?? null
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
    const live = this.sessions.get(id)
    const meta = this.store?.get(id)
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
      const meta = this.store?.get(info.id)
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
      log.warn(`[session ${id}] send rejected — session is terminated`)
      throw new HttpError(410, `session ${id} is terminated`)
    }
    if (!s.running) {
      log.warn(`[session ${id}] send rejected — session is not running`)
      throw new HttpError(409, `session ${id} is not running; resume it first`)
    }
    return s
  }

  /** Reject user-input turns during a provider transition when the current
   *  handle cannot safely accept them. The closed-handle check is the
   *  invariant: never acknowledge or broadcast a user turn after its provider
   *  input has closed — a push to an ended Pushable is silently dropped, so
   *  the UI would paint a bubble the SDK never sees.
   *
   *  `exiting` (the clean-exit / auto-resume gap) is deliberately NOT a
   *  rejection reason: autoResume keeps the old handle's input queue OPEN
   *  while it builds resume options, and respawnInPlace drains that queue
   *  (drainQueuedInput) and re-enqueues onto the fresh handle — so a turn
   *  sent during the resume window is carried to the new Query as its next
   *  input, not lost. Rejecting every exiting send would degrade the normal
   *  resume experience for the sake of a transient state the carryover
   *  already handles. Applied to send()/sendContent() only — NOT clear() (the
   *  reset escape hatch must stay usable during recovery) or execInSession
   *  (local !bash, doesn't touch the SDK handle). */
  private requireSendable(id: string): Session {
    const s = this.requireRunnable(id)
    if (s.recovering) {
      throw new HttpError(409, `session ${id} is recovering from a crash; retry shortly`)
    }
    if (s.handle.closed) {
      log.warn(`[session ${id}] send rejected — provider input is closed`)
      throw new HttpError(409, `session ${id} is not ready for input; retry shortly`)
    }
    return s
  }

  /** Like require(), but additionally insists the Query is still live.
   *  Use for any method that forwards a control request to the SDK — the
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
      messageCount: s.history.length + s.subagentHistory.length,
      cwd: s.cwd,
      model: s.model,
      permissionMode: s.permissionMode,
      title: s.title,
      betas: s.betas,
      fastMode: s.fastMode,
      memory: s.memory,
      fastModeState: s.fastModeState,
      effortLevel: s.effortLevel,
      effortLevels: s.effortLevels,
      thinking: s.thinking,
      thinkingSupported: s.thinkingSupported,
      autoCompactWindow: s.autoCompactWindow,
      running: s.running,
      recovering: s.recovering,
      terminated: s.terminated,
      terminatedReason: s.terminatedReason,
      canRetryResume: s.terminated && isTransientTerminatedReason(s.terminatedReason),
      error: s.error,
      working: isWorking,
      workingSince: isWorking ? s.workingSince : undefined,
      // Background (async) subagents still in flight. The parent turn may
      // have completed (working=false) while these keep running; the sidebar
      // uses the count to show a 'waiting' state instead of plain 'live'.
      backgroundSubagentCount: this.backgroundWatchers.get(s.id)?.size ?? 0,
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
      slept: s.slept,
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
    // Any in-flight assistant turn, queued user input, unanswered
    // tool-permission prompt, or running background subagent counts as
    // "working" — none of those are safe moments to summarise the
    // conversation (the transcript is still being appended to).
    if (s.clearing) return 'working'
    if (s.pendingTurns > 0) return 'working'
    if (s.handle.queueDepth > 0) return 'working'
    if (s.pending.size > 0) return 'working'
    if ((this.backgroundWatchers.get(s.id)?.size ?? 0) > 0) return 'working'
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
      memory: meta.memory,
      effortLevel: meta.effortLevel,
      thinking: meta.thinking,
      autoCompactWindow: meta.autoCompactWindow,
      // Dormant: no live Query, so the SDK isn't reporting a runtime state.
      // Leave fastModeState undefined — the UI hides the chip until resume.
      running: false,
      terminated: meta.terminated,
      terminatedReason: meta.terminatedReason,
      canRetryResume: meta.terminated && isTransientTerminatedReason(meta.terminatedReason),
      error: meta.error,
      working: false,
      workingSince: undefined,
      // A dormant session has no live Query, so no subagent watchers.
      backgroundSubagentCount: undefined,
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
      parentId: meta.parentId,
      mcpServerNames: meta.mcpServerNames,
      enabledPlugins: meta.enabledPlugins,
      showPinnedUserMessage: meta.showPinnedUserMessage,
      autoRecap: meta.autoRecap,
      slept: meta.slept,
    }
  }

  /** Build (or return cached) PumpDeps shared by pump() and autoResume().
   *  All fields reference stable `this` members, so the object is built
   *  once and reused for the lifetime of the SessionManager. */
  private buildPumpDeps(): PumpDeps {
    if (!this.cachedPumpDeps) {
      this.cachedPumpDeps = {
        historyCap: this.historyCap,
        subagentHistoryCap: this.subagentHistoryCap,
        persist: (s) => this.persist(s),
        denyPendingPermissions: (s) => {
          this.permBroker.denyAll(s)
          this.elicitBroker.cancelAll(s)
          this.dialogBroker.cancelAll(s)
        },
        isLive: (s) => this.sessions.get(s.id) === s,
        autoResume: this.autoResumeEnabled ? (s) => this.autoResume(s) : undefined,
        crashRecovery: this.crashRecoveryEnabled,
        attemptCrashRecovery: (s) => this.attemptCrashRecovery(s),
        // The pump's mutating-tool detector calls broadcaster.broadcastGitStatusChanged
        // through the debounce helper. `this` satisfies the SessionBroadcaster
        // interface (subscribeContextUsage, subscribeGitStatus, etc.).
        broadcaster: this,
        // Pump calls this when the SDK-reported fast_mode_state changes.
        // Broadcasts a session-update WITHOUT writing to disk — the runtime
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
        onTaskNotification: (sessionId, toolUseId) =>
          this.cancelBackgroundWatcher(sessionId, toolUseId),
        // Mirror CLI notification frames onto the global WS channel so
        // App-level code can fire a browser/OS notification even when the
        // session's Chat panel isn't mounted (same rationale as the
        // permission_request mirror).
        onCliNotification: (sessionId, notification) => {
          if (!this.sessions.has(sessionId)) return
          this.broadcastGlobal({ kind: 'cli_notification', sessionId, notification })
        },
        onPromptEcho: (s, echoUuid) => {
          if (this.sessions.has(s.id)) this.onPromptEcho(s, echoUuid)
        },
        recordTurnAnchor: (sessionId, assistantUuid, completedAt) => {
          // Fire-and-forget on the turn path; a missed anchor only means
          // that turn can't serve as a discard cut point (recoverable by
          // re-promoting on a later replay of the transcript).
          void this.turnAnchorStore.append(sessionId, { assistantUuid, completedAt })
        },
        recordResultFrame: (sessionId, resultUuid, assistantUuid, result) => {
          // Fire-and-forget; a missed frame only means that turn's result
          // summary (cost/duration) won't show on resume.
          void this.resultFrameStore.append(sessionId, { resultUuid, assistantUuid, result })
        },
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

  /** Tracks consecutive crash-recovery attempts per session. Every attempt is
   *  Step 1 (in-place resume); once the count reaches `maxCrashRecovery` the
   *  ladder gives up and terminates with the transient crash reason (the client
   *  then offers Resume / Fork-from-last-completed). Does NOT reset on user
   *  messages (pushToSession) — a poisonous turn that crashes on response (but
   *  loads fine on resume) must keep consuming the budget rather than looping
   *  in-place forever. It resets only on a clean autoResume, which proves the
   *  session is healthy. */
  private crashRecoveryCounts = new WeakMap<Session, number>()

  /** Active background-subagent transcript watchers, keyed by session id →
   *  tool_use_id → stop(). The watcher polls the subagent's own transcript
   *  for completion (the CLI doesn't reliably emit task_notification for
   *  Agent-launched background subagents) and synthesizes a
   *  system/task_notification frame when it settles. Stopped on unload so a
   *  watcher can't fire into a dead session. */
  private backgroundWatchers = new Map<string, Map<string, () => void>>()

  /** Per-session in-flight resume() promises. resume() awaits disk/transcript
   *  probes before spawning, so two racing /resume calls (parallel browser
   *  tabs, or the client's background resumer) can both pass the live-guard
   *  and both reach spawn() — the second sessions.set() orphans the first
   *  Query, leaving a duplicate claude.exe. Coalescing here makes the second
   *  caller await the SAME spawn. */
  private readonly resumeInFlight = new Map<string, Promise<SessionInfo>>()

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
      log.warn(`[session ${session.id}] auto-resume skipped — no completed turns (no disk data)`)
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

    // Keep the old handle (and its input queue) OPEN while buildResumeOpts
    // runs async (e.g. MCP OAuth refresh). A user turn sent during this
    // resume window lands in the still-open queue; respawnInPlace then
    // drains it (drainQueuedInput) and re-enqueues onto the fresh handle, so
    // the turn survives as the new Query's next input instead of being
    // dropped against an ended Pushable. Sends are no longer rejected on
    // `exiting` alone — only once the handle is actually closed.
    let resumeOpts: Options
    try {
      resumeOpts = await this.buildResumeOpts(session)
    } catch (err) {
      // No re-spawn will happen (the throw propagates to cleanupPump, which
      // terminates the session). Surface any user turns that arrived during
      // the resume window but can't be carried over: we kept the old handle's
      // queue open precisely so a window send would queue, and a plain
      // destroy() would abandon them silently. Drain and report each as an
      // ephemeral notice (NOT history — the session is terminating anyway),
      // then destroy the old handle so its ProcessMonitor/Pushable are
      // cleaned up exactly as the pre-window destroy used to, instead of
      // lingering on a terminated session.
      const stranded = session.handle.drainQueuedInput?.() ?? []
      for (const msg of stranded) {
        this.broadcastSystemNotice(session, `自动恢复失败，消息未送达：${describeUserMessage(msg)}`)
      }
      session.handle.destroy('auto-resume-failed')
      throw err
    }
    // Re-check liveness after the async buildResumeOpts — a concurrent
    // unload() (Delete / shutdown) may have removed the session, and clear()
    // may have set `clearing` to drive its own respawn. Mirroring
    // crashRecoveryStep1: returning true makes cleanupPump skip its
    // termination tail in both cases (the session is either gone or being
    // taken over by clear()).
    if (!this.sessions.has(session.id) || session.terminated || session.clearing) return true
    this.respawnInPlace(session, resumeOpts, 'auto-resume')
    this.autoResumeCounts.set(session, resumeCount + 1)
    // A clean idle-autoResume means the session was healthy (the prior
    // crash recovery, if any, succeeded) — reset the crash ladder so a
    // future crash starts fresh with a full in-place budget.
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
      thinking: session.thinking,
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
    const allGlobalMcpNames = Object.keys(this.mcpStore?.toSdkConfig() ?? {})
    if (allGlobalMcpNames.length > 0) {
      await this.mcpStore?.refreshOAuthTokens(allGlobalMcpNames)
      resumeOpts.mcpServers = this.mcpStore?.toSdkConfig()
    }
    if (session.canUseTool) resumeOpts.canUseTool = session.canUseTool
    // Re-apply the elicitation callback too — without it the resumed Query
    // auto-declines every MCP elicitation (OAuth auth prompts included).
    if (session.onElicitation) resumeOpts.onElicitation = session.onElicitation
    // Same for the user-dialog callback + kinds: both keys travel together,
    // otherwise the resumed Query loses the refusal-fallback dialog.
    if (session.onUserDialog) {
      resumeOpts.onUserDialog = session.onUserDialog
      resumeOpts.supportedDialogKinds = [...SUPPORTED_DIALOG_KINDS]
    }
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
      thinking: session.thinking,
      fastMode: session.fastMode,
      autoCompactWindow: session.autoCompactWindow,
      memory: session.memory,
      enabledPlugins: session.enabledPlugins,
      includeHookEvents: true,
      forwardSubagentText: this.forwardSubagentText,
      resume: session.id,
      onUserMessageConsumed: (msg) => this.onInputConsumed(session.id, msg as SDKUserMessage),
      canUseTool: session.canUseTool as ((...args: unknown[]) => Promise<unknown>) | undefined,
      onElicitation: session.onElicitation as ((...args: unknown[]) => Promise<unknown>) | undefined,
      onUserDialog: session.onUserDialog as ((...args: unknown[]) => Promise<unknown>) | undefined,
      supportedDialogKinds: session.onUserDialog ? [...SUPPORTED_DIALOG_KINDS] : undefined,
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
   *  terminated via the give-up path (broadcast + terminal error) - cleanupPump
   *  then skips its generic termination tail. Returns false only when the
   *  session is already gone / terminated / clearing - cleanupPump runs its
   *  generic tail (a no-op for a removed session).
   *
   *  Every attempt is Step 1: plain `--resume <id>` in-place. Handles the
   *  common cases: transient crashes (OOM, network) and tail corruption
   *  (the CLI self-heals partial trailing lines - verified). Same id, no
   *  sidebar corpse, subscribers stay attached. `maxCrashRecovery` (default
   *  2) budgets the number of AUTOMATIC in-place resumes; when it is
   *  exhausted the session is given up and terminates with the (transient)
   *  crash reason - the client then shows a Resume / Fork-from-last-completed
   *  choice banner and the USER decides how to continue. There is no
   *  automatic fork.
   *
   *  Floor cases terminate via crashRecoveryGiveUp (terminateCrashedSession,
   *  which broadcasts + pushes a terminal error + denies pending + persists)
   *  and return true so cleanupPump skips its generic tail:
   *    - counter >= maxCrashRecovery (ladder exhausted)
   *    - no on-disk transcript (nothing to resume / fork from)
   *    - provider doesn't support resume
   *    - Step 1 spawn throws (e.g. Side Chat) */
  private async attemptCrashRecovery(session: Session): Promise<boolean> {
    // Guard: session must still be live and not explicitly stopped.
    if (!this.sessions.has(session.id)) return false
    if (session.terminated || session.clearing) return false
    const caps = this.providers.get(session.provider)?.capabilities
    if (!caps?.supportsResume) return this.crashRecoveryGiveUp(session)

    const attempt = this.crashRecoveryCounts.get(session) ?? 0
    if (attempt >= this.maxCrashRecovery) {
      log.warn(`[session ${session.id}] crash-recovery exhausted (${attempt}/${this.maxCrashRecovery}), terminating`)
      return this.crashRecoveryGiveUp(session)
    }

    // Step 1 needs a completed turn on disk: the SDK only writes the
    // transcript after the first `result`, so resume would fail with
    // "No conversation found" without one. Probe the disk AUTHORITATIVELY
    // (hasSdkTranscript) rather than the `lastTurnAt` in-memory proxy —
    // mirrorring resume(). If the transcript is genuinely gone (lastTurnAt
    // set but no file), mark it hard: resume() and fork() would both 410, so
    // the client must NOT show the Resume/Fork choice banner. If there was
    // never a completed turn (lastTurnAt undefined), leave the transient
    // reason: resume() respawns fresh and the banner's Resume still works.
    if (!(await this.hasSdkTranscript(session))) {
      log.warn(`[session ${session.id}] crash-recovery skipped: no on-disk transcript to resume from`)
      if (session.lastTurnAt) return this.crashRecoveryGiveUp(session, 'transcript_missing')
      return this.crashRecoveryGiveUp(session)
    }

    // Every attempt is Step 1 (in-place resume). The counter-exhausted check
    // above (attempt >= maxCrashRecovery) is the ladder's only terminal — the
    // crash reason is preserved (transient) so the client can offer the user
    // Resume / Fork-from-last-completed. There is no Step 2 auto-fork.
    return this.crashRecoveryStep1(session)
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
    log.info(`[session ${session.id}] crash-recovery Step 1: in-place resume (attempt ${attempt + 1}/${this.maxCrashRecovery})`)

    // Destroy the (already-aborted) old handle BEFORE the async
    // buildResumeOpts: if the MCP refresh throws, the handle is already
    // cleaned up (no ProcessMonitor/Pushable leak).
    session.handle.destroy('crash-recovery')
    let resumeOpts: Options
    try {
      resumeOpts = await this.buildResumeOpts(session)
    } catch (err) {
      // Preserve the original crash error in session.error (the root
      // cause) — log the recovery-failure detail separately. The user
      // sees the crash reason on reload, not a generic "recovery failed".
      log.error(`[session ${session.id}] crash-recovery Step 1 buildResumeOpts failed:`, err)
      return this.crashRecoveryGiveUp(session)
    }
    // Re-check liveness after the async MCP refresh — a concurrent unload()
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

}
