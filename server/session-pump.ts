// Background pump that iterates a session's Query async generator, appends
// every message to the bounded history ring, and fans out to all live
// subscribers. Extracted from SessionManager.pump() for modularity.
//
// The pump is the session's main loop — it runs until the Query ends or
// crashes, then performs cleanup (deny pending permissions, end subscribers,
// mark session as terminated, persist final state).

import { randomUUID } from 'node:crypto'
import type { FastModeState, SDKMessage, SlashCommand } from '@anthropic-ai/claude-agent-sdk'
import type { Session, SessionBroadcaster } from './session-types.js'
import { endAllSubscribers } from './session-types.js'
import { isTranscriptMessage, pushBounded, stampReceivedAt, shouldBroadcastMessage, trimLargeToolResults, truncateMiddle } from './history-utils.js'
import { mutatingToolUseId, scheduleGitBroadcast } from './git-broadcast.js'
import { parseAckAgentId } from './subagent-watcher.js'

/** Anchored signature of an async/background subagent launch ack (the
 *  tool_result content the CLI returns immediately for a run_in_background
 *  Agent call). Anchored so a synchronous subagent's real result that merely
 *  mentions the phrase is never mistaken for an ack. Mirrors the reducer's
 *  client-side ack detector. */
const LAUNCH_ACK_RE = /^async agent launched successfully/i
import { createLogger } from './log.js'
import type { HookRunRecord, HookRuntimeEvent, HookRunStatus } from '../shared/hooks.js'
import type { CliNotification } from '../shared/ws-protocol.js'
import { isTerminalTaskStatus } from '../shared/tasks.js'
import { AUTOCOMPACT_BUFFER_TOKENS, AUTOCOMPACT_MAX_OUTPUT_FLOOR } from '../shared/auto-compact.js'

const MAX_HOOK_OUTPUT_CHARS = 20_000

function trimHookOutput(value: string): string {
  if (value.length <= MAX_HOOK_OUTPUT_CHARS) return value
  // Same head+tail elision shape as tool_result trimming in history-utils —
  // one helper keeps the omission-marker wording consistent everywhere.
  return truncateMiddle(value, 10_000, 8_000)
}

/** Extract `parent_tool_use_id` from an SDK message defensively.
 *  Returns the value for user/assistant messages; undefined for types
 *  that don't carry the field. Server-side SDKMessage is a discriminated
 *  union, so the cast is necessary — the field is only guaranteed on
 *  SDKUserMessage / SDKAssistantMessage variants. */
export function getParentToolUseId(msg: SDKMessage): string | null | undefined {
  return (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id
}

const log = createLogger('pump')

/** True when an SDK `user` message carries at least one `tool_result`
 *  content block. Used to distinguish a genuine top-level user-input echo
 *  (text/image blocks only — drop it, we already broadcast our own copy)
 *  from a tool_result frame (forward it, the UI needs it to resolve the
 *  tool card's status). Defensive against string content and odd shapes. */
export function userMessageHasToolResult(msg: SDKMessage): boolean {
  const content = (msg as { message?: { content?: unknown } }).message?.content
  if (!Array.isArray(content)) return false
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'tool_result') {
      return true
    }
  }
  return false
}

/** True when a top-level `user` message's leading text is a
 *  `<task-notification>` XML block — the harness's background-subagent
 *  result injection (delivered as user-role text for the model to consume
 *  on its next turn). The pump's echo drop-filter must NOT drop these:
 *  they aren't echoes of server-broadcast human input, so forwarding them
 *  lets the client render the result as a task-result card instead of
 *  silently losing it. Mirrors the client-side check in
 *  src/session-store/normalize.ts. */
export function isTaskNotificationUserMessage(msg: SDKMessage): boolean {
  if (msg.type !== 'user') return false
  // Subagent-internal user frames (parent_tool_use_id set) are never a
  // top-level task-notification injection; the pump's drop-filter only
  // calls this on null-parent frames anyway, but keep the guard so the
  // helper is correct standalone (mirrors the client check).
  if (getParentToolUseId(msg) != null) return false
  const content = (msg as { message?: { content?: unknown } }).message?.content
  let text: string | undefined
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
        const t = (block as { text?: unknown }).text
        if (typeof t === 'string') { text = t; break }
      }
    }
  }
  return !!text && /^\s*<task-notification\b[\s\S]*<\/task-notification>/i.test(text)
}

/** All `tool_use_id`s carried by a user message's tool_result blocks. The
 *  originating tool_use id lives on the block, not on the message's
 *  `parent_tool_use_id` (null for main-thread results). */
export function toolResultIds(msg: SDKMessage): string[] {
  const content = (msg as { message?: { content?: unknown } }).message?.content
  if (!Array.isArray(content)) return []
  const ids: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as { type?: unknown; tool_use_id?: unknown }
    if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') ids.push(b.tool_use_id)
  }
  return ids
}

/** Detect async/background subagent LAUNCH acks in a user message. An ack is
 *  a tool_result block whose content starts with "Async agent launched
 *  successfully" and carries an `agentId: <id>` line. Returns the
 *  originating Agent tool_use id + the parsed agentId for each, so the
 *  SessionManager can poll the subagent's own transcript and synthesize a
 *  completion signal (the CLI doesn't reliably emit task_notification for
 *  Agent-launched background subagents — see server/subagent-watcher.ts). */
export function backgroundSubagentLaunches(
  msg: SDKMessage,
): Array<{ toolUseId: string; agentId: string }> {
  if (msg.type !== 'user') return []
  const content = (msg as { message?: { content?: unknown } }).message?.content
  if (!Array.isArray(content)) return []
  const out: Array<{ toolUseId: string; agentId: string }> = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as { type: unknown; tool_use_id?: unknown; content?: unknown }
    if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue
    const text = typeof b.content === 'string'
      ? b.content
      : Array.isArray(b.content)
        ? (b.content as Array<{ type?: string; text?: unknown }>)
            .filter((x) => x?.type === 'text' && typeof x.text === 'string')
            .map((x) => x.text as string)
            .join('\n')
        : ''
    if (!text || !LAUNCH_ACK_RE.test(text)) continue
    const agentId = parseAckAgentId(text)
    if (agentId) out.push({ toolUseId: b.tool_use_id, agentId })
  }
  return out
}

/** Cap on terminal (completed/failed/killed/stopped) task records kept in
 *  `session.tasks`. Terminal records linger so the TasksPanel can show
 *  recent completions, but an unbounded map would grow forever in a long
 *  session — oldest terminals are evicted beyond this many. */
const MAX_TERMINAL_TASKS = 50

/** System subtypes folded into `session.tasks` by applyTaskEvent. The
 *  first three are EPHEMERAL task-state events — the pump early-continues
 *  on them (never history ring, never the message channel). The fourth
 *  (`task_notification`) additionally flows through the normal
 *  ring+broadcast path because the client reducer's async-subagent
 *  completion branch depends on it. */
export const TASK_EVENT_SUBTYPES = new Set(['task_started', 'task_updated', 'task_progress', 'task_notification'])

function isTaskRecordStatus(v: unknown): v is import('../shared/tasks.js').TaskStatus {
  return v === 'pending' || v === 'running' || v === 'completed' || v === 'failed'
    || v === 'killed' || v === 'stopped' || v === 'paused'
}

/** Fold one SDK task_* system frame into `session.tasks` and push a full
 *  snapshot to the session's taskSubscribers. Upsert semantics: a
 *  task_updated / task_progress / task_notification may arrive without a
 *  prior task_started (frame loss / late subscribe / CLI quirks), so a
 *  missing record is created as a stub from whatever the frame carries —
 *  the UI shows partial state rather than a hole. Pure w.r.t. the frame —
 *  never throws on malformed input. Exported for unit tests.
 *
 *  Also used by the SessionManager's watcher path: a synthesized
 *  task_notification (subagent-watcher backstop) is folded through the same
 *  helper so the seeded record settles consistently. */
export function applyTaskEvent(session: Session, msg: SDKMessage): void {
  if (msg.type !== 'system') return
  const raw = msg as {
    subtype?: unknown
    task_id?: unknown
    tool_use_id?: unknown
    description?: unknown
    subagent_type?: unknown
    task_type?: unknown
    workflow_name?: unknown
    skip_transcript?: unknown
    ambient?: unknown
    patch?: unknown
    summary?: unknown
    last_tool_name?: unknown
    status?: unknown
    receivedAt?: unknown
  }
  if (raw.subtype !== 'task_started' && raw.subtype !== 'task_updated'
    && raw.subtype !== 'task_progress' && raw.subtype !== 'task_notification') return
  if (typeof raw.task_id !== 'string' || raw.task_id === '') return

  const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
  const now = Date.now()
  const frameTime = typeof raw.receivedAt === 'number' ? raw.receivedAt : undefined

  const existing = session.tasks.get(raw.task_id)
  if (raw.subtype === 'task_started') {
    // Spread the existing record first (upsert, not replace): a duplicate /
    // out-of-order task_started — e.g. a real frame arriving AFTER the
    // watcher's seed, or a re-emission on task restart — must not erase
    // state an earlier frame already established (isBackgrounded from a
    // task_updated patch, progressSummary/lastToolName from task_progress).
    // SDKTaskStartedMessage carries none of those fields, so the fallbacks
    // below keep the prior values; endedAt clears because the task is
    // (re)running.
    session.tasks.set(raw.task_id, {
      ...existing,
      taskId: raw.task_id,
      toolUseId: str(raw.tool_use_id) ?? existing?.toolUseId,
      description: str(raw.description) ?? existing?.description ?? '',
      subagentType: str(raw.subagent_type) ?? existing?.subagentType,
      taskType: str(raw.task_type) ?? existing?.taskType,
      workflowName: str(raw.workflow_name) ?? existing?.workflowName,
      status: 'running',
      skipTranscript: raw.skip_transcript === true ? true : existing?.skipTranscript,
      ambient: raw.ambient === true ? true : existing?.ambient,
      startedAt: frameTime ?? existing?.startedAt,
      endedAt: undefined,
      updatedAt: now,
    })
  } else if (raw.subtype === 'task_updated') {
    // patch: { status?, description?, end_time?, error?, is_backgrounded? }
    const patch = (raw.patch && typeof raw.patch === 'object' ? raw.patch : {}) as {
      status?: unknown; description?: unknown; end_time?: unknown; is_backgrounded?: unknown
    }
    const rec = existing ?? {
      taskId: raw.task_id, description: '', status: 'running' as const, updatedAt: now,
    }
    session.tasks.set(raw.task_id, {
      ...rec,
      toolUseId: str(raw.tool_use_id) ?? rec.toolUseId,
      description: str(patch.description) ?? str(raw.description) ?? rec.description,
      status: isTaskRecordStatus(patch.status) ? patch.status : rec.status,
      isBackgrounded: typeof patch.is_backgrounded === 'boolean' ? patch.is_backgrounded : rec.isBackgrounded,
      endedAt: typeof patch.end_time === 'number' ? patch.end_time : rec.endedAt,
      updatedAt: now,
    })
  } else if (raw.subtype === 'task_progress') {
    const rec = existing ?? {
      taskId: raw.task_id, toolUseId: str(raw.tool_use_id), description: '', status: 'running' as const, updatedAt: now,
    }
    session.tasks.set(raw.task_id, {
      ...rec,
      description: str(raw.description) ?? rec.description,
      subagentType: str(raw.subagent_type) ?? rec.subagentType,
      progressSummary: str(raw.summary) ?? rec.progressSummary,
      lastToolName: str(raw.last_tool_name) ?? rec.lastToolName,
      updatedAt: now,
    })
  } else {
    // task_notification — terminal completion signal (completed/failed/stopped)
    const rec = existing ?? {
      taskId: raw.task_id, description: '', status: 'running' as const, updatedAt: now,
    }
    const status = raw.status === 'completed' || raw.status === 'failed' || raw.status === 'stopped'
      ? raw.status
      : rec.status
    session.tasks.set(raw.task_id, {
      ...rec,
      toolUseId: str(raw.tool_use_id) ?? rec.toolUseId,
      description: str(raw.description) ?? rec.description,
      status,
      progressSummary: str(raw.summary) ?? rec.progressSummary,
      endedAt: frameTime ?? rec.endedAt,
      updatedAt: now,
    })
  }

  // Evict oldest terminal records beyond the cap. Active tasks are never
  // evicted; insertion order tracks start order, so the first terminal hit
  // is the oldest.
  let terminals = 0
  for (const rec of session.tasks.values()) {
    if (isTerminalTaskStatus(rec.status)) terminals++
  }
  if (terminals > MAX_TERMINAL_TASKS) {
    for (const [taskId, rec] of session.tasks) {
      if (terminals <= MAX_TERMINAL_TASKS) break
      if (isTerminalTaskStatus(rec.status)) {
        session.tasks.delete(taskId)
        terminals--
      }
    }
  }

  pushTasksSnapshot(session)
}

/** Push the current `session.tasks` contents as a full snapshot to every
 *  task subscriber. Shared by applyTaskEvent and
 *  applyBackgroundTasksChanged. */
function pushTasksSnapshot(session: Session): void {
  const snapshot = Array.from(session.tasks.values())
  for (const sub of session.taskSubscribers) {
    try { sub.push(snapshot) } catch { /* subscriber dead — skip */ }
  }
}

/** Fold a `system/background_tasks_changed` frame into `session.tasks`.
 *
 *  The SDK emits this as a REPLACE-semantics snapshot of the LIVE background
 *  task set whenever membership changes (start / completion / kill / a
 *  foreground agent being backgrounded) and — crucially — right behind a
 *  repeated `initialize`, so a reconnecting host that missed the edge
 *  `task_started`/`task_updated`/`task_notification` stream can reconcile.
 *
 *  Forward-only reconciliation: each listed task means "running right now",
 *  so a missing record is seeded as a running, backgrounded record; an
 *  existing record is only back-filled for fields it still lacks (never
 *  demoted, never deleted — the live set only tracks background tasks, so a
 *  foreground/completed task absent from it must keep its state). A
 *  background agent that finished during a disconnect is reconciled by the
 *  subagent-watcher's synthesized task_notification, not by this frame. */
export function applyBackgroundTasksChanged(session: Session, msg: SDKMessage): void {
  if (msg.type !== 'system') return
  const raw = msg as { subtype?: unknown; tasks?: unknown }
  if (raw.subtype !== 'background_tasks_changed' || !Array.isArray(raw.tasks)) return
  const now = Date.now()
  for (const t of raw.tasks as Array<Record<string, unknown>>) {
    const taskId = typeof t.task_id === 'string' && t.task_id !== '' ? t.task_id : ''
    if (!taskId) continue
    const existing = session.tasks.get(taskId)
    if (existing) {
      const next = { ...existing }
      if (!next.description && typeof t.description === 'string') next.description = t.description
      if (!next.taskType && typeof t.task_type === 'string') next.taskType = t.task_type
      if (t.ambient === true) next.ambient = true
      next.updatedAt = now
      session.tasks.set(taskId, next)
    } else {
      session.tasks.set(taskId, {
        taskId,
        description: typeof t.description === 'string' ? t.description : '',
        taskType: typeof t.task_type === 'string' ? t.task_type : undefined,
        ambient: t.ambient === true,
        isBackgrounded: true,
        status: 'running',
        updatedAt: now,
      })
    }
  }
  pushTasksSnapshot(session)
}

/** Extract the SDK-reported `fast_mode_state` from a message, if present.
 *  The field rides on `system/init` and `result` (success + error) messages
 *  (see sdk.d.ts: SDKSystemMessage, SDKResultSuccess, SDKResultError). We
 *  probe every message defensively rather than branching on type — a missing
 *  field is simply undefined. Returns undefined when absent (which also means
 *  "the current model doesn't support fast mode"). Pure — exported for tests. */

function commandsChanged(msg: SDKMessage): SlashCommand[] | undefined {
  const candidate = msg as { type: unknown; subtype: unknown; commands: unknown }
  if (candidate.type !== 'system' || candidate.subtype !== 'commands_changed') return undefined
  return Array.isArray(candidate.commands) ? candidate.commands as SlashCommand[] : []
}
export function fastModeStateOf(msg: SDKMessage): FastModeState | undefined {
  const fms = (msg as { fast_mode_state?: unknown }).fast_mode_state
  return fms === 'off' || fms === 'cooldown' || fms === 'on' ? fms : undefined
}

/** Extract the CLI's authoritative session state from a
 *  `system/session_state_changed` frame ('idle' | 'running' |
 *  'requires_action'). Returns undefined for any other frame so callers can
 *  detect a no-op. Pure — exported for tests. */
export function sessionStateOf(msg: SDKMessage): 'idle' | 'running' | 'requires_action' | undefined {
  const raw = msg as { type?: unknown; subtype?: unknown; state?: unknown }
  if (raw.type !== 'system' || raw.subtype !== 'session_state_changed') return undefined
  return raw.state === 'idle' || raw.state === 'running' || raw.state === 'requires_action' ? raw.state : undefined
}

/** Extract the SDK-reported compaction state from a message, if present.
 *  The flag rides on `system/status` frames: `status: 'compacting'` marks
 *  compaction in progress, and a later status frame (`status: null` /
 *  `'requesting'`) clears it. Returns undefined for non-status frames so
 *  callers can detect a no-op. Pure — exported for tests. */
export function compactingOf(msg: SDKMessage): boolean | undefined {
  const raw = msg as { type?: unknown; subtype?: unknown; status?: unknown }
  if (raw.type !== 'system' || raw.subtype !== 'status') return undefined
  return raw.status === 'compacting'
}

/** Narrow an SDK `system/notification` frame into a CliNotification.
 *  Defensive: `text` and `priority` are required (returns null when either
 *  is missing/wrong-typed — the frame is dropped with a warn in the pump);
 *  `key` and `timeout_ms` are optional and pass through only when
 *  well-typed. Pure — exported for tests. */
export function cliNotificationOf(msg: SDKMessage): CliNotification | null {
  const raw = msg as {
    key?: unknown
    text?: unknown
    priority?: unknown
    timeout_ms?: unknown
  }
  const text = typeof raw.text === 'string' ? raw.text : ''
  if (!text) return null
  if (raw.priority !== 'low' && raw.priority !== 'medium' && raw.priority !== 'high' && raw.priority !== 'immediate') {
    return null
  }
  return {
    ...(typeof raw.key === 'string' && raw.key ? { key: raw.key } : {}),
    text,
    priority: raw.priority,
    ...(typeof raw.timeout_ms === 'number' && raw.timeout_ms > 0 ? { timeoutMs: raw.timeout_ms } : {}),
  }
}

export interface PumpDeps {
  historyCap: number
  /** Separate FIFO budget for subagent frames (parent_tool_use_id != null).
   *  Independent of historyCap so subagent volume never evicts main-thread
   *  frames from the replay surface. */
  subagentHistoryCap: number
  persist: (session: Session) => void
  denyPendingPermissions: (session: Session) => void
  /** Return true if `session` is still the live entry for its id in the
   *  manager's map (identity, not just presence). A same-id replacement (a
   *  new spawn superseding an orphaned Query) must read the stale session as
   *  not-live so its cleanup tail can't persist terminated=true over the new
   *  session — without identity this the resurrected session would be
   *  immediately stamped dead. */
  isLive: (session: Session) => boolean
  /** Called when the Query exits cleanly (no error). If it returns true,
   *  the session is being auto-resumed — skip full cleanup (don't mark
   *  terminated, don't end subscribers). If it returns false or throws,
   *  fall through to normal termination. */
  autoResume?: (session: Session) => Promise<boolean>
  /** When true, a session whose CLI crashed (session.lastCrash set by
   *  handleProcessExit) is routed to `attemptCrashRecovery` instead of
   *  immediate termination. The ladder re-resumes in-place until
   *  maxCrashRecovery is exhausted, then gives up (the client offers the
   *  user Resume / Fork-from-last-completed — no automatic fork). */
  crashRecovery?: boolean
  /** Crash-recovery ladder. Called from cleanupPump when `session.lastCrash`
   *  is set and `crashRecovery` is enabled. Returns true if the session was
   *  re-spawned in-place or terminated via the give-up path (which broadcasts
   *  the terminated update + pushes a terminal error), so cleanupPump skips
   *  its generic termination tail. Returns false only when the session is
   *  already gone / terminated / clearing — cleanupPump then runs its generic
   *  tail (a no-op for a removed session). */
  attemptCrashRecovery?: (session: Session) => Promise<boolean>
  /** Record a successfully-completed turn's anchor (the uuid of its last
   *  main-thread assistant message) to the turn-anchor sidecar. Used by
   *  the "discard messages from here onward" feature to mark legal cut
   *  points. Fire-and-forget on the turn path. Optional so test fixtures
   *  that don't exercise discard can omit it. */
  recordTurnAnchor?: (sessionId: string, assistantUuid: string, completedAt: number) => void
  /** Record a result frame (cost/duration/turns/usage) to the result-frames
   *  sidecar. The SDK doesn't persist result to the on-disk transcript, so
   *  without this a resumed/dormant session loses the per-turn result
   *  summaries. `resultUuid` is the result frame's own uuid (dedup);
   *  `assistantUuid` is the turn's last assistant uuid (positions the result
   *  in the seed). Fire-and-forget on the turn path. */
  recordResultFrame?: (sessionId: string, resultUuid: string, assistantUuid: string, result: SDKMessage) => void
  /** Reference to the broadcaster — needed by the mutating-tool detector
   *  to schedule a debounced `git-status-changed` frame after Claude
   *  runs Edit/Write/NotebookEdit/Bash. Optional so test fixtures that
   *  don't exercise tool-use behaviour can omit it. */
  broadcaster?: SessionBroadcaster
  /** Push a `session-update` frame (e.g. after the SDK-reported fast-mode
   *  state changes). Distinct from `persist` — this broadcasts WITHOUT
   *  writing to disk, for transient runtime state that doesn't belong in
   *  persisted meta. Optional so test fixtures can omit it. */
  broadcastInfo?: (session: Session) => void
  broadcastCommandsChanged: (sessionId: string, commands: SlashCommand[]) => void
  recordHookRun?: (sessionId: string, event: HookRuntimeEvent) => void
  /** Called when the pump sees an async/background subagent launch ack (a
   *  tool_result whose content starts with "Async agent launched
   *  successfully" and carries an agentId). The SessionManager uses it to
   *  poll the subagent's own transcript and synthesize a completion signal —
   *  the CLI doesn't reliably emit task_notification for Agent-launched
   *  background subagents. Optional so test fixtures can omit it. */
  onBackgroundSubagentLaunched?: (sessionId: string, toolUseId: string, agentId: string) => void
  /** Called when a REAL SDK task_notification frame arrives (as opposed to
   *  the watcher's synthesized one, which never passes through the pump).
   *  The SessionManager uses it to cancel the matching subagent watcher so
   *  the real completion isn't double-reported. Optional so test fixtures
   *  can omit it. */
  onTaskNotification?: (sessionId: string, toolUseId: string) => void
  /** Called when a CLI notification frame (SDK `system/notification`) arrives.
   *  The SessionManager mirrors it onto the global WS channel so App-level
   *  code can fire a browser/OS notification even when the session's Chat
   *  panel isn't mounted. Optional so test fixtures can omit it. */
  onCliNotification?: (sessionId: string, notification: CliNotification) => void
  /** Called when the pump is about to drop the SDK's echo of a top-level user
   *  prompt (the SDK replays persisted user input through the Query stream).
   *  `echoUuid` is the SDK's on-disk uuid for that prompt. The SessionManager
   *  pairs it with the server-minted uuid recorded at send() time (FIFO order)
   *  so resume() can rewrite the disk-seed ring's prompt uuids and the client's
   *  uuid-anchored replay overlap detection works after a restart. Optional so
   *  test fixtures can omit it. */
  onPromptEcho?: (session: Session, echoUuid: string) => void
}

export function hookLifecycleMessage(msg: SDKMessage): HookRuntimeEvent | null {
  if (msg.type !== 'system') return null
  const raw = msg as unknown as {
    subtype?: unknown
    hook_id?: unknown
    hook_name?: unknown
    hook_event?: unknown
    stdout?: unknown
    stderr?: unknown
    output?: unknown
    exit_code?: unknown
    outcome?: unknown
  }
  if (raw.subtype !== 'hook_started' && raw.subtype !== 'hook_progress' && raw.subtype !== 'hook_response') return null
  if (typeof raw.hook_id !== 'string' || typeof raw.hook_name !== 'string' || typeof raw.hook_event !== 'string') {
    log.warn(`dropped malformed ${raw.subtype} message: missing hook_id/hook_name/hook_event`)
    return null
  }

  const now = Date.now()
  let status: HookRunStatus
  let kind: HookRuntimeEvent['kind']
  if (raw.subtype === 'hook_started') {
    status = 'started'
    kind = 'started'
  } else if (raw.subtype === 'hook_progress') {
    status = 'progress'
    kind = 'progress'
  } else {
    if (raw.outcome === 'error' || raw.outcome === 'cancelled') {
      status = raw.outcome
    } else if (raw.outcome === 'success' || raw.outcome == null) {
      status = 'success'
    } else {
      log.warn(`unexpected hook outcome "${raw.outcome}", treating as error`)
      status = 'error'
    }
    kind = 'completed'
  }

  const run: HookRunRecord = {
    id: raw.hook_id,
    hookId: raw.hook_id,
    hookName: raw.hook_name,
    event: raw.hook_event,
    status,
    startedAt: now,
    updatedAt: now,
  }
  if (typeof raw.stdout === 'string') run.stdout = trimHookOutput(raw.stdout)
  if (typeof raw.stderr === 'string') run.stderr = trimHookOutput(raw.stderr)
  if (typeof raw.output === 'string') run.output = trimHookOutput(raw.output)
  if (typeof raw.exit_code === 'number') run.exitCode = raw.exit_code
  return { kind, run }
}

/**
 * Iterate the session's Query to completion, fanning each message out to
 * subscribers and managing the history ring and turn-state bookkeeping.
 *
 * Resolves when the Query ends (normally or with an error). Never throws —
 * errors are captured on `session.error` and broadcast as a synthetic
 * system message so the frontend can surface them.
 */
export async function pump(session: Session, deps: PumpDeps): Promise<void> {
  log.info(`[session ${session.id}] pump started`)
  let msgCount = 0
  // Pump-local: ids of tool_use blocks for filesystem-mutating tools.
  // Populated when we see the assistant's tool_use, drained when the
  // matching tool_result lands (which is when we know git status may
  // actually have changed). Set rather than Map because we only need
  // membership — the name was already checked at insertion time.
  const pendingMutatingToolUses = new Set<string>()
  try {
    const iter = session.handle.messages[Symbol.asyncIterator]()
    // Race iter.next() against the session's abort signal so unload() can
    // break a wedged generator immediately instead of waiting for the SDK
    // subprocess to exit on its own. Built ONCE per session: once the abort
    // promise resolves, every subsequent race short-circuits to done.
    const signal = session.handle.abortSignal
    const abortPromise: Promise<IteratorResult<SDKMessage>> = new Promise((resolve) => {
      if (signal.aborted) {
        resolve({ done: true, value: undefined })
        return
      }
      signal.addEventListener('abort', () => resolve({ done: true, value: undefined }), { once: true })
    })
    // Idle watchdog: a single timer per session that warns if query.next()
    // hasn't resolved within 60s. The mutable `nextStartedAt` is updated at
    // the top of each iteration so the warning reports the correct duration.
    // We reuse one timer across all iterations instead of allocating and
    // clearing a new setTimeout per message (which for a 200-message turn
    // means 200 timer allocations).
    let nextStartedAt = Date.now()
    const idleTimer = setTimeout(() => {
      if (session.pendingTurns === 0 && session.pending.size === 0) return
      log.warn(
        `[session ${session.id}] query.next() idle for ${Date.now() - nextStartedAt}ms ` +
        `(waiting for msg #${msgCount + 1}, ` +
        `pendingTurns=${session.pendingTurns}, pending perms=${session.pending.size})`,
      )
    }, 60_000)
    // Don't let this per-session watchdog hold the event loop alive on its
    // own — consistent with the rest of the codebase's timers (health-monitor,
    // git-broadcast, event-loop-probe). It still fires normally while the
    // server is running; this only affects a clean shutdown where nothing
    // else keeps the loop alive. Cleared in the finally block below.
    idleTimer.unref?.()
    try {
      while (true) {
        nextStartedAt = Date.now()
        // Cold-start instrumentation anchor: first time the pump actually waits
        // on the CLI (the first iter.next() triggers the SDK to spawn the child
        // + run the initialize handshake — the critical path for a fresh
        // session's first turn).
        if (session.bootStartedAt === undefined) session.bootStartedAt = Date.now()
        log.debug(`[session ${session.id}] pump awaiting iter.next() for msg #${msgCount + 1}`)
        const step: IteratorResult<SDKMessage> = await Promise.race([iter.next(), abortPromise])
        if (step.done) {
          // When the loop exits (normally or via abort signal), explicitly
          // close the async iterator so the SDK can clean up its subprocess
          // resources (stdin pipe, child process, etc.). Without this,
          // aborting the session may leave orphan CLI processes.
          try { await iter.return?.() } catch { /* subprocess already dead — ignore */ }
          break
        }
        const msg = step.value
        const msgSubtype = (msg as unknown as { subtype?: string }).subtype
        // The SDK may echo top-level user input back through the Query
        // stream (sometimes as SDKUserMessageReplay with isReplay=true,
        // sometimes — notably the very first turn after spawn — as a plain
        // SDKUserMessage with no replay marker). We already broadcast our
        // own user messages via SessionManager.send() / sendContent(), so
        // forwarding the SDK's echo would paint the bubble twice — we must
        // drop it.
        //
        // We CANNOT key the drop on `parent_tool_use_id == null` alone:
        // SDK 0.3.143 emits MAIN-THREAD tool_results as user frames with
        // `parent_tool_use_id: null` too (only subagent-internal tool hops
        // carry a non-null parent). Dropping those strands the tool card on
        // 'running' forever — the frontend seeds 'running' from the
        // assistant's tool_use but never sees the result to flip it (the
        // "tool stuck running" bug). Verified against SDK 0.3.143: a Bash
        // tool_result arrives as { type:'user', parent_tool_use_id:null,
        // content:[tool_result] }.
        //
        // The robust discriminator is the CONTENT: a genuine input echo
        // carries the user's text/image blocks and never a tool_result
        // block, while every tool_result frame (main-thread or subagent)
        // carries at least one. So drop only null-parent user frames that
        // carry NO tool_result block.
        //
        // EXCEPTION: a `<task-notification>` user message is also a null-
        // parent text-only user frame, but it is NOT an echo of something
        // we broadcast — the harness injects it as the background
        // subagent's result delivery for the model to consume on its next
        // turn. Dropping it would silently lose the result from the
        // transcript; forwarding it lets the client render it as a
        // task-result card (see isTaskNotificationUserMessage). SDK 0.3.x
        // emits task completion as a `system`/`task_notification` frame
        // (already forwarded), so this guard only matters for harnesses
        // that use the user-role injection path.
        if (
          msg.type === 'user' &&
          getParentToolUseId(msg) == null &&
          !userMessageHasToolResult(msg) &&
          !isTaskNotificationUserMessage(msg)
        ) {
          // Before dropping the SDK's echo of a top-level user prompt, hand its
          // on-disk uuid (`v`) to the manager so it can pair it with the
          // server-minted `u` recorded at send() time (FIFO order). That pairs
          // the disk uuid with the ring/cache uuid, which resume() uses to
          // rewrite the disk-seed ring so the client's uuid-anchored replay
          // overlap detection works after a restart. No-op on a resume replay
          // (every loaded entry is already paired).
          const echoUuid = (msg as { uuid?: string }).uuid
          if (echoUuid) deps.onPromptEcho?.(session, echoUuid)
          log.debug(`[session ${session.id}] dropping echoed top-level user message uuid=${(msg as { uuid: string }).uuid}`)
          continue
        }
        log.debug(
          `[session ${session.id}] msg #${msgCount + 1} received d` +
          `type=${msg.type}${msgSubtype ? `/${msgSubtype}` : ''} ` +
          `(next() took ${Date.now() - nextStartedAt}ms)`,
        )
        const changedCommands = commandsChanged(msg)
        if (changedCommands) {
          deps.broadcastCommandsChanged?.(session.id, changedCommands)
          continue
        }
        const hookEvent = hookLifecycleMessage(msg)
        if (hookEvent) {
          const existing = session.hookRuns.find((run) => run.id === hookEvent.run.id)
          if (existing) hookEvent.run.startedAt = existing.startedAt
          session.lastActivityAt = Date.now()
          session.autoInterruptedAt = undefined
          deps.recordHookRun?.(session.id, hookEvent)
          continue
        }
        // Detect filesystem-mutating tool_use ids so we can fire a debounced
        // git-status-changed broadcast when the matching tool_result lands.
        if (msg.type === 'assistant') {
          const content = (msg as { message?: { content?: unknown } }).message?.content
          if (Array.isArray(content)) {
            for (const block of content) {
              const id = mutatingToolUseId(block)
              if (id) pendingMutatingToolUses.add(id)
            }
          }
          // Track the most recent assistant uuid so it can be promoted to
          // lastSafeResumeUuid when the turn completes. The recovery ladder
          // no longer forks from this anchor (no Step 2) — the manual
          // Fork-from-last-completed button resolves anchors from the turn
          // sidecar instead — but the pump still promotes it for history
          // readers. Subagent assistant frames (parent_tool_use_id set) are
          // NOT main-thread turns, so don't promote from them.
          if (getParentToolUseId(msg) == null) {
            const aUuid = (msg as { uuid?: string }).uuid
            if (aUuid) session.lastAssistantUuid = aUuid
          }
        }
        // tool_result for a mutating tool → schedule a debounced
        // git-status-changed broadcast. The SDK wraps tool_results in a
        // user message; the originating tool_use id is on each tool_result
        // BLOCK (`tool_use_id`), NOT on the message's `parent_tool_use_id`
        // (which is null for main-thread results — see the drop-filter note
        // above). We don't care about the result content here — just that
        // it landed (the worktree is now in its post-mutation state).
        if (msg.type === 'user') {
          for (const id of toolResultIds(msg)) {
            if (pendingMutatingToolUses.has(id)) {
              pendingMutatingToolUses.delete(id)
              if (deps.broadcaster) scheduleGitBroadcast(deps.broadcaster, session.id)
            }
          }
          // Async/background subagent launch acks: hand the agentId to the
          // manager so it can poll the subagent's transcript for completion.
          if (deps.onBackgroundSubagentLaunched) {
            for (const { toolUseId, agentId } of backgroundSubagentLaunches(msg)) {
              try {
                deps.onBackgroundSubagentLaunched(session.id, toolUseId, agentId)
              } catch (err) {
                log.warn(`[session ${session.id}] onBackgroundSubagentLaunched threw for agentId=${agentId}:`, err)
              }
            }
          }
        }
        session.lastActivityAt = Date.now()
        // Cold-start instrumentation: log once when the init handshake lands
        // (the first `system/init` frame), quantifying CLI spawn + module load
        // + MCP connect + handshake — the portion startup()/WarmQuery would
        // pre-pay.
        if (
          msg.type === 'system' && (msg as { subtype?: string }).subtype === 'init'
          && session.initAtMs === undefined
        ) {
          session.initAtMs = Date.now()
          const bootMs = session.bootStartedAt !== undefined ? session.initAtMs - session.bootStartedAt : undefined
          const model = typeof (msg as { model?: unknown }).model === 'string' ? (msg as { model?: string }).model : ''
          log.info(
            `[${session.id}] init handshake done in ${bootMs ?? '?'}ms from pump start` +
              (model ? ` (model=${model})` : ''),
          )
        }
        // Track the SDK-reported fast-mode runtime state. It rides on
        // system/init and result messages; when it changes, broadcast a
        // session-update so the UI's fast-mode chip reflects reality
        // (including the 'cooldown' rate-limited state). Not persisted —
        // the SDK re-reports it after respawn. Only broadcast on a real
        // change to avoid a frame per message.
        {
          const fms = fastModeStateOf(msg)
          log.trace('fastModeState check', {
            sessionId: session.id,
            msgType: msg.type,
            msgSubtype: (msg as { subtype?: string }).subtype,
            extracted: fms,
            current: session.fastModeState,
            changed: fms !== undefined && fms !== session.fastModeState,
          })
          if (fms !== undefined && fms !== session.fastModeState) {
            const prev = session.fastModeState
            session.fastModeState = fms
            log.trace('fastModeState updated', {
              sessionId: session.id,
              from: prev,
              to: fms,
            })
            deps.broadcastInfo?.(session)
          }
        }
        // Track the SDK-reported compaction state. It rides on `system/status`
        // frames (`status: 'compacting'` while the CLI compacts the transcript;
        // a later status frame clears it). When it changes, broadcast a
        // session-update so the WorkingBubble can show "Recap (auto)…" instead
        // of a stale phase. Not persisted — the SDK re-reports it after respawn.
        {
          const compacting = compactingOf(msg)
          if (compacting !== undefined && compacting !== (session.compacting ?? false)) {
            const prev = session.compacting
            session.compacting = compacting
            log.trace('compacting updated', {
              sessionId: session.id,
              from: prev,
              to: compacting,
            })
            deps.broadcastInfo?.(session)
          }
        }
        // The session has produced something since the last GC kick, so any
        // pending auto-interrupt mark is no longer relevant — clear it so a
        // future silence triggers fresh detection rather than immediately
        // escalating to unload.
        session.autoInterruptedAt = undefined
        // Stamp the moment we first observed this message. Set once and only
        // if absent (the SDK type has no such field, so it's never preset)
        // so the value travels unchanged through both the history ring and
        // live subscriber broadcast — replay and live paths share this object.
        stampReceivedAt(msg)
        // Trim oversized tool_result content before it enters the history
        // ring and subscriber broadcast.  The SDK may forward the full MCP
        // server output (potentially MBs) — keeping it unbounded wastes
        // server memory, inflates WS frames, and bloats client state /
        // localStorage.  In-place mutation ensures replay and live paths
        // see the same (trimmed) object.
        trimLargeToolResults(msg)
        // prompt_suggestion is ephemeral — not conversation content. Push
        // to dedicated subscribers and skip the history ring + broadcast.
        if (msg.type === 'prompt_suggestion') {
          const suggestion = (msg as { suggestion?: string }).suggestion
          if (typeof suggestion === 'string' && suggestion) {
            session.lastPromptSuggestion = suggestion
            for (const sub of session.promptSuggestionSubscribers) {
              try { sub.push(suggestion) } catch { /* subscriber dead — skip */ }
            }
          }
          continue
        }
        // CLI notification (SDK `system/notification`): a transient UI signal
        // ("waiting for your input", idle nudge, …) — NOT transcript content.
        // Narrow the frame and hand it to the manager, which mirrors it onto
        // the global WS channel (fire a browser/OS notification even when the
        // session's panel isn't mounted). Early-continue: it never enters the
        // history ring or the per-session message broadcast.
        if (msg.type === 'system' && (msg as { subtype?: string }).subtype === 'notification') {
          const n = cliNotificationOf(msg)
          if (n) {
            try { deps.onCliNotification?.(session.id, n) }
            catch (err) { log.warn(`[session ${session.id}] onCliNotification threw: ${err}`) }
          } else {
            log.warn(`[session ${session.id}] dropped malformed notification frame (missing text/priority)`)
          }
          continue
        }
        // `system/thinking_tokens`: live thinking-token estimate for the
        // current thinking block (redacted-thinking phase progress). Purely
        // transient — forwarded to live subscribers only, never entering the
        // history ring (a long thinking phase emits one frame per delta, and
        // these must not evict durable content) nor surviving replay. The
        // client mirrors it into a transient WorkingBubble slot.
        if (msg.type === 'system' && (msg as { subtype?: string }).subtype === 'thinking_tokens') {
          for (const sub of session.subscribers.values()) {
            try { sub.push(msg) } catch { /* subscriber dead — skip */ }
          }
          continue
        }
        // `system/session_state_changed`: the CLI's authoritative turn state
        // ('idle' after a turn fully settles — including a held-back result /
        // exited bg-agent do-while — 'running' mid-turn, 'requires_action'
        // while it waits on the user). Ephemeral — mirror only state CHANGES
        // to live subscribers (never the history ring); the client keeps it in
        // a dedicated slot rather than the transcript.
        if (msg.type === 'system' && (msg as { subtype?: string }).subtype === 'session_state_changed') {
          const st = sessionStateOf(msg)
          if (st && st !== session.lastSessionState) {
            session.lastSessionState = st
            for (const sub of session.subscribers.values()) {
              try { sub.push(msg) } catch { /* subscriber dead — skip */ }
            }
          }
          continue
        }
        // `tool_progress` is a high-frequency per-tool liveness ping
        // (elapsed seconds for the running tool call). Nothing renders it —
        // the ToolCards already show their own elapsed state — so drop it
        // entirely: no ring slot, no broadcast.
        if (msg.type === 'tool_progress') continue
        // PROBE (see decision gate): `system/files_persisted` semantics are
        // unconfirmed for local SDK sessions — the payload
        // (SDKFilesPersistedEvent: `files: {filename, file_id}[]`) carries a
        // `file_id`, which reads like SDK artifact/file-persistence rather than
        // a workspace git write, so it must NOT be wired to scheduleGitBroadcast
        // on speculation. Log + early-continue so a real session can tell us
        // whether it ever fires and what `filename` looks like. Gate: if it
        // fires with repo-relative filenames, promote to scheduleGitBroadcast;
        // otherwise remove this branch (it should never hit the ring either way).
        if (msg.type === 'system' && (msg as { subtype?: string }).subtype === 'files_persisted') {
          const f = msg as { files?: unknown; failed?: unknown }
          log.info(
            `[${session.id}] files_persisted files=${JSON.stringify(f.files ?? [])} failed=${JSON.stringify(f.failed ?? [])}`,
          )
          continue
        }
        // Task lifecycle events fold into the dedicated task-state cache and
        // ride the `tasks` channel as full snapshots. task_started /
        // task_updated / task_progress are EPHEMERAL (high-frequency update
        // stream — ring slots would crowd durable content) and early-continue;
        // task_notification ALSO folds task state but keeps flowing through
        // the normal ring+broadcast path — the client reducer's async-subagent
        // completion branch matches on it (see shouldBroadcastMessage).
        if (msg.type === 'system') {
          const subtype = (msg as { subtype?: string }).subtype
          if (subtype === 'task_started' || subtype === 'task_updated' || subtype === 'task_progress') {
            applyTaskEvent(session, msg)
            continue
          }
          // REPLACE-semantics live-set snapshot (see applyBackgroundTasksChanged).
          // Ephemeral like the edge task events: fold + early-continue, never the
          // history ring or the message channel.
          if (subtype === 'background_tasks_changed') {
            applyBackgroundTasksChanged(session, msg)
            continue
          }
          if (subtype === 'task_notification') {
            applyTaskEvent(session, msg)
            const toolUseId = (msg as { tool_use_id?: string }).tool_use_id
            if (toolUseId) {
              try { deps.onTaskNotification?.(session.id, toolUseId) }
              catch (err) { log.warn(`[session ${session.id}] onTaskNotification threw: ${err}`) }
            }
          }
        }
        // Only durable transcript messages enter the bounded history ring
        // (the WS full-replay surface). Ephemeral `stream_event` deltas are
        // live-streamed to subscribers but never stored: a heavy streaming
        // turn (~200 deltas/s) would otherwise evict durable content — a
        // just-sent user message, an assistant message, a tool result — from
        // the replay surface within seconds, so a reload during/after the
        // flood loses recent durable messages.
        if (isTranscriptMessage(msg)) {
          // Split by frame origin: subagent frames (parent_tool_use_id
          // set — tool hops plus the text/thinking frames forwarded when
          // Options.forwardSubagentText is on) live in their own FIFO ring
          // with a separate budget, so a long subagent turn can evict only
          // older subagent frames, never main-thread ones. Read surfaces
          // see the two rings through SessionManager.mergedHistory().
          const isSubagentFrame = getParentToolUseId(msg) != null
          pushBounded(
            isSubagentFrame ? session.subagentHistory : session.history,
            msg,
            isSubagentFrame ? deps.subagentHistoryCap : deps.historyCap,
          )
        }

        // Only broadcast system messages that the frontend actually needs.
        // Other system frames (init, status, — are kept in history for
        // fastModeState extraction, but skip the broadcast to save
        // bandwidth and client memory.
        if (shouldBroadcastMessage(msg as { type?: string; subtype?: string })) {
          for (const sub of session.subscribers.values()) {
            try { sub.push(msg) } catch { /* subscriber dead — don't break broadcast to others */ }
          }
        }
        msgCount++
        // Derive a context-usage snapshot directly from the result's own
        // `usage` + `modelUsage` payload — no IPC. The result message is
        // the SDK's authoritative tally for the API call that just landed,
        // so we get exact numbers for free instead of round-tripping into
        // the CLI subprocess for getContextUsage(). The full breakdown
        // (skills/agents/memoryFiles/mcpTools) still comes from the
        // on-demand REST endpoint when the user opens SettingsPanel.
        if (msg.type === 'result') {
          // Pass the session's pinned auto-compact window (undefined = auto)
          // so the derived threshold reflects a user override, not just the
          // model's raw context window.
          const usage = liteContextUsageFromResult(msg, session.autoCompactWindow)
          // Cold-start instrumentation: log once on the FIRST REAL result —
          // the user-visible end of the first turn. The spawn/restart
          // `result` warm-up carries an ALL-ZERO usage payload (liteContext
          // returns null for it), so gating on `usage` skips that placeholder;
          // a real turn's result always has input_tokens > 0. Combines our
          // pump-side anchors with the SDK's own wire timings (ttft_ms = time
          // to first token, request_sent_wall_ms = wall time from send to
          // response, time_to_request_from_spawn_ms). Read defensively.
          if (usage && session.firstTurnAtMs === undefined) {
            session.firstTurnAtMs = Date.now()
            const bootMs = session.bootStartedAt !== undefined ? session.firstTurnAtMs - session.bootStartedAt : undefined
            const initMs = session.initAtMs !== undefined ? session.firstTurnAtMs - session.initAtMs : undefined
            const r = msg as { ttft_ms?: unknown; request_sent_wall_ms?: unknown; time_to_request_from_spawn_ms?: unknown }
            log.info(
              `[${session.id}] first result: ${bootMs ?? '?'}ms from pump start` +
                (initMs !== undefined ? `, ${initMs}ms after init` : '') +
                ` ttft_ms=${typeof r.ttft_ms === 'number' ? r.ttft_ms : 'n/a'}` +
                ` request_sent_wall_ms=${typeof r.request_sent_wall_ms === 'number' ? r.request_sent_wall_ms : 'n/a'}` +
                ` time_to_request_from_spawn_ms=${typeof r.time_to_request_from_spawn_ms === 'number' ? r.time_to_request_from_spawn_ms : 'n/a'}`,
            )
          }
          if (usage) applyContextUsage(session, usage)
        }
        // Also derive a snapshot from each main-thread `assistant` message
        // so the bar refreshes MID-TURN (per API response) instead of only
        // at turn end dmatching the Claude CLI's cadence. We reuse the
        // context window / model / auto-compact threshold cached on the
        // last `result`; until the first `result` lands there is no window
        // to divide against, so liteContextUsageFromAssistant returns null
        // and we skip. Subagent frames are filtered out inside the helper.
        if (msg.type === 'assistant') {
          const usage = liteContextUsageFromAssistant(msg, session.lastContextUsage)
          if (usage) applyContextUsage(session, usage)
        }
        // `result` marks a completed turn.
        //
        // If the user queued another message while this turn was running
        // (input.queueDepth > 0), the SDK is about to start the next turn
        // immediately — clearing pendingTurns/workingSince here would make
        // the UI flash to "not working" between turns and hide the
        // WorkingBubble until the next HTTP send() bump. Detecting more
        // pending input lets us keep the working state continuous across
        // back-to-back turns. The race window is closed: SDK emits
        // `result` BEFORE calling iter.next() for the next turn, so the
        // queued item is still in our Pushable when we observe `result`.
        if (msg.type === 'result') {
          // Promote the most recent main-thread assistant uuid to the
          // safe-resume anchor: this turn completed successfully, so a later
          // fork/cut from here would drop a *later* crashed turn while
          // preserving this one. Only success counts — error_max_turns /
          // error_max_budget leave the turn in an indeterminate state, so we
          // keep the previous anchor rather than trusting a failed turn.
          if ((msg as { subtype?: string }).subtype === 'success' && session.lastAssistantUuid) {
            session.lastSafeResumeUuid = session.lastAssistantUuid
            // Persist this turn's anchor to the sidecar so the "discard
            // messages from here onward" feature can offer ANY historical
            // success turn as a cut point (not just the in-memory
            // lastSafeResumeUuid, which only tracks the most recent one).
            // Fire-and-forget: the turn path doesn't block on disk writes.
            deps.recordTurnAnchor?.(session.id, session.lastAssistantUuid, Date.now())
          }
          // Persist the result frame itself to the result-frames sidecar.
          // The SDK doesn't write result to the on-disk transcript, so
          // without this a resumed/dormant session loses the per-turn result
          // summaries (cost/duration/turns/usage). Both success AND error
          // results are recorded (error turns have a result summary too).
          // Fire-and-forget: the turn path doesn't block on disk writes.
          {
            const resultUuid = (msg as { uuid?: string }).uuid
            if (resultUuid && session.lastAssistantUuid) {
              deps.recordResultFrame?.(session.id, resultUuid, session.lastAssistantUuid, msg)
            }
          }
          const moreQueued = session.handle.queueDepth > 0
          log.debug(
            `[session ${session.id}] result received — total msgs: ${msgCount}, ` +
            `input.queueDepth=${session.handle.queueDepth}, moreQueued=${moreQueued}`,
          )
          if (moreQueued) {
            // Keep pendingTurns=1 and workingSince anchored at its existing
            // value so the UI continues to show "working" without flicker.
            // The next result will re-evaluate the queue.
            session.pendingTurns = 1
          } else {
            session.pendingTurns = 0
            session.workingSince = undefined
          }
          // Compaction is a mid-turn phenomenon — a `result` means the turn
          // (and any compaction it triggered) is done. The CLI normally clears
          // `compacting` via a status frame; this is a lifecycle bound so a
          // missed frame can't stick the "Recap (auto)…" label on forever.
          if (session.compacting) {
            session.compacting = undefined
            deps.broadcastInfo?.(session)
          }
          session.lastTurnAt = Date.now()
          try { deps.persist(session) } catch (err) {
            log.warn(`[session ${session.id}] persist failed after result: ${err}`)
          }
        }
      }
    } finally {
      clearTimeout(idleTimer)
    }
    log.info(`[session ${session.id}] pump ended normally d${msgCount} messages processed`)
  } catch (err) {
    // When the CLI crashed, handleProcessExit already recorded lastCrash,
    // set session.error, and broadcast a "recovering" notice. Don't overwrite
    // that with the iterator's abort/exit error or double-broadcast — let
    // cleanupPump drive the recovery ladder from the lastCrash marker.
    if (session.lastCrash) {
      log.warn(`[session ${session.id}] pump broke after CLI crash — deferring to recovery ladder`)
    } else {
      session.error = err instanceof Error ? err.message : String(err)
      // Log with full context — the message alone often omits the stack
      // frame that points at the real culprit (e.g. missing API key,
      // model name typo, CLI subprocess failed to spawn).
      log.error(`[session ${session.id}] pump error after ${msgCount} messages:`, err)
      // Broadcast a synthetic error message so subscribers know what happene?.
      const synthetic: SDKMessage = {
        type: 'system',
        subtype: 'error',
        error: session.error,
        uuid: randomUUID(),
        session_id: session.id,
        receivedAt: Date.now(),
      } as unknown as SDKMessage
      for (const sub of session.subscribers.values()) {
        try { sub.push(synthetic) } catch { /* subscriber dead — skip */ }
      }
    }
  } finally {
    await cleanupPump(session, deps)
  }
}

async function cleanupPump(session: Session, deps: PumpDeps): Promise<void> {
  // Wrap in its own try/catch so a failure in cleanup (e.g.
  // subscriber.push() throwing, persist() failing) doesn't escape
  // as an unhandledRejection from the pumpTask promise.
  try {
    // If unload() already removed this session from the map (idle GC
    // or graceful shutdown), it has already persisted the correct
    // state. Overwriting here would stamp terminated=true, which
    // prevents the user from resuming the session later. Skip.
    //
    // Same-id replacement (spawn() superseded this session): the id is now
    // owned by a fresh session object. Still settle the superseded session's
    // parked permission awaits and end its subscriber queues — otherwise a
    // client attached to the replaced session hangs on a dead message channel
    // (it only recovers on a manual refresh), and parked SDK permits never
    // resolve. Both are idempotent for the already-unloaded case (unload has
    // already ended subscribers and cleared the pending maps).
    if (!deps.isLive(session)) {
      deps.denyPendingPermissions(session)
      endAllSubscribers(session)
      return
    }

    // SessionManager.clear() drives its own respawn after destroying the
    // current handle. Skip both the auto-resume probe AND the cleanup
    // tail (mark-terminated, end-subscribers, persist) so the live
    // subscribers stay attached across the gap and the next pump can
    // pick up exactly where this one left off. clear() resets running /
    // pendingTurns / etc. as part of the respawn.
    if (session.clearing) return

    // When the Query exits cleanly (no error), try auto-resume first.
    // This keeps the session alive transparently — the CLI subprocess
    // likely exited due to idle timeout, not user intent.
    if (session.lastCrash && deps.crashRecovery && deps.attemptCrashRecovery) {
      // CLI crash (non-clean exit): try the recovery ladder before giving
      // up. Every attempt re-resumes in-place (transient crashes + tail
      // corruption); when the budget is exhausted the session terminates
      // with the transient crash reason so the UI offers Resume /
      // Fork-from-last-completed. Returns true if re-spawned/handled — skip
      // termination.
      try {
        const recovered = await deps.attemptCrashRecovery(session)
        if (recovered) return
      } catch (resumeErr) {
        log.error(`[session ${session.id}] crash recovery threw, falling back to termination:`, resumeErr)
      }
      // Fall through to termination tail (give-up or ladder exhausted).
    }
    if (!session.error && deps.autoResume) {
      try {
        const resumed = await deps.autoResume(session)
        if (resumed) return // Session re-spawned — skip full cleanup
      } catch (resumeErr) {
        log.error(`[session ${session.id}] auto-resume failed, falling back to termination:`, resumeErr)
      }
    }

    session.running = false
    session.exiting = false
    session.recovering = false
    session.lastCrash = undefined
    session.terminated = true
    // Only set terminatedReason if it hasn't already been set by
    // handleProcessExit (which provides more specific values like
    // 'process_killed' or 'process_exited').
    if (!session.terminatedReason) {
      session.terminatedReason = session.error ? 'query_error' : 'query_ended'
    }
    // Reset pending turns so the UI doesn't stay stuck in "working"
    // when the SDK merged queued messages into fewer turns than were
    // sent, or the session ended before emitting a result for every
    // queued turn.
    session.pendingTurns = 0
    session.workingSince = undefined
    deps.denyPendingPermissions(session)
    endAllSubscribers(session)
    // Persist the terminal state so the UI shows the transcript as
    // "ended" after a reload, and resume() can refuse to re-spawn it.
    deps.persist(session)
  } catch (cleanupErr) {
    log.error(`[session ${session.id}] pump cleanup error:`, cleanupErr)
  }
}

/** Subset of getContextUsage's response that ContextBar actually renders.
 *  See src/hooks/useChatStream.ts:ContextUsage — these are the four fields
 *  the chat-side bar reads (totalTokens, maxTokens, percentage, model).
 *  rawMaxTokens is included because ContextBar prefers it over maxTokens. */
export interface LiteContextUsage {
  totalTokens: number
  maxTokens: number
  rawMaxTokens: number
  percentage: number
  model: string
  /** Tokens written to the cache on this turn (cache write). Present when
   *  the source iteration reports it; absent on turns that lack the field. */
  cacheCreationTokens?: number
  /** Tokens served from cache on this turn (cache read / hit). Present when
   *  the source iteration reports it; absent on turns that lack the field. */
  cacheReadTokens?: number
  /** Output tokens the model generated on this API call. Surfaced so the
   *  bar can show throughput alongside context fill. */
  outputTokens?: number
  /** Token count at which the SDK's auto-compact triggers, derived from
   *  the model's effective context window. Present once a `result` has
   *  supplied `modelUsage[model].contextWindow`/`maxOutputTokens`; the
   *  client renders "X% until auto-compact" from it. Carried forward onto
   *  mid-turn `assistant` snapshots so the warning stays live. */
  autoCompactThreshold?: number
  /** The picked model's advertised max output tokens (from
   *  `modelUsage[model].maxOutputTokens`). Surfaced so the client can invert
   *  a marker position back into Settings.autoCompactWindow exactly instead of
   *  assuming the 20000 floor. Carried forward like the threshold. */
  maxOutputTokens?: number
  /** Set when Guard 1 dropped a corrupt cache bucket, so this snapshot is the
   *  input-only fallback rather than the true prompt size. The pump uses this
   *  to avoid overwriting a healthy last-good value: an intermittently corrupt
   *  proxy must not flip-flop the ContextBar between the real fill level and
   *  the under-reported fallback on every turn. Present only on the affected
   *  snapshot — a healthy snapshot leaves it undefined. */
  degraded?: boolean
}

/** Compute the auto-compact threshold (in tokens) from a model's advertised
 *  context window and max output, mirroring the CLI's formula:
 *    effectiveContextWindow = contextWindow - min(maxOutputTokens, 20000)
 *  Returns undefined when contextWindow is missing/non-positive. When
 *  maxOutputTokens is absent we assume the floor, so the threshold degrades
 *  gracefully instead of going undefined. */
function computeAutoCompactThreshold(
  contextWindow: number,
  maxOutputTokens?: number,
): number | undefined {
  if (!contextWindow || contextWindow <= 0) return undefined
  const outputHeadroom = Math.min(
    maxOutputTokens ?? AUTOCOMPACT_MAX_OUTPUT_FLOOR,
    AUTOCOMPACT_MAX_OUTPUT_FLOOR,
  )
  return Math.max(0, contextWindow - outputHeadroom - AUTOCOMPACT_BUFFER_TOKENS)
}

/** Shared assembly for both `result`- and `assistant`-derived snapshots.
 *  Sums the three input buckets (the true prompt size per Anthropic docs),
 *  defensively clamps against an impossible >100% reading, computes the
 *  percentage, and forwards cache/output/threshold buckets only when present
 *  (so "not reported" stays distinguishable from "zero"). Returns null when
 *  the prompt size exceeds the context window — unparseable SDK data, where
 *  we keep the last known good value rather than showing a false 100%. */
function assembleLiteUsage(opts: {
  inputTokens: number
  cacheCreation: number | null | undefined
  cacheRead: number | null | undefined
  outputTokens?: number | null
  contextWindow: number
  model: string
  autoCompactThreshold?: number
  maxOutputTokens?: number
  /** Caller tag so the diagnostic log can tell us which path produced a
   *  suspicious payload ('result' = end-of-turn, 'assistant' = mid-turn). */
  source?: 'result' | 'assistant'
}): LiteContextUsage | null {
  // Guard 1 — drop impossible cache buckets. A single prompt-side bucket can
  // never exceed the context window in a valid Anthropic response (the full
  // prompt = input + cache_read + cache_creation must fit in the window), so
  // a bucket larger than the window is garbage. Some proxies return a garbage
  // cache_read_input_tokens (millions of tokens — neither a per-request cache
  // hit nor a monotonic cumulative counter); summing it against the window
  // would make every snapshot look >100% and get rejected below, leaving the
  // ContextBar empty forever. Drop the bad bucket and recompute from the
  // survivors.
  //
  // A bucket over the window is *by definition* invalid: a legitimate cache
  // hit reports cache_read <= window and is summed normally below, so dropping
  // an over-window bucket never under-reports a genuinely cached conversation.
  // `totalTokens = inputTokens` is then only the non-cached portion — the best
  // non-blocking estimate available for a corrupt turn (the authoritative
  // breakdown comes from the on-demand SettingsPanel REST endpoint). The
  // earlier "reject the whole snapshot" version of this guard froze the
  // ContextBar empty on proxies that return a corrupt bucket on EVERY turn,
  // because there was never a last-good value to keep.
  let { cacheCreation, cacheRead } = opts
  // True when Guard 1 dropped a corrupt bucket, so this snapshot is the
  // input-only fallback rather than the true prompt size. The pump refuses to
  // let a degraded snapshot overwrite a healthy last-good (see
  // applyContextUsage), which stops an intermittently corrupt proxy from
  // flip-flopping the ContextBar every turn.
  let degraded = false
  if (cacheCreation != null && cacheCreation > opts.contextWindow) {
    log.debug(
      `[context-usage] cache_creation bucket > contextWindow → dropping ` +
      `(source=${opts.source ?? 'unknown'}, model=${opts.model}, ` +
      `inputTokens=${opts.inputTokens}, cacheCreation=${cacheCreation}, ` +
      `cacheRead=${cacheRead}, contextWindow=${opts.contextWindow})`,
    )
    cacheCreation = undefined
    degraded = true
  }
  if (cacheRead != null && cacheRead > opts.contextWindow) {
    log.debug(
      `[context-usage] cache_read bucket > contextWindow → dropping ` +
      `(source=${opts.source ?? 'unknown'}, model=${opts.model}, ` +
      `inputTokens=${opts.inputTokens}, cacheCreation=${cacheCreation}, ` +
      `cacheRead=${cacheRead}, contextWindow=${opts.contextWindow})`,
    )
    cacheRead = undefined
    degraded = true
  }
  const totalTokens = opts.inputTokens + (cacheCreation ?? 0) + (cacheRead ?? 0)
  if (totalTokens > opts.contextWindow) {
    log.debug(
      `[context-usage] raw total ${totalTokens} > contextWindow ${opts.contextWindow} for model ${opts.model}; skipping update`,
    )
    return null
  }
  // Guard 2 — zero-total → keep the last good value. The SDK emits
  // placeholder frames with an all-zero usage payload: every turn's opening
  // `assistant` message and the spawn/restart `result` warm-up both carry
  // `input_tokens: 0` (sometimes with `iterations: []`). Broadcasting those
  // would clobber the last good snapshot and drop the ContextBar to
  // `0 / N · 0.0%`. A real turn's `result` always has input_tokens > 0, so
  // returning null here is safe and only affects the placeholders. Log level:
  // warn for end-of-turn zero (still suspicious), debug for mid-turn zero
  // (expected every turn — would spam at warn).
  if (totalTokens <= 0) {
    const msg =
      `[context-usage] zero totalTokens → skipping ` +
      `(source=${opts.source ?? 'unknown'}, model=${opts.model}, ` +
      `inputTokens=${opts.inputTokens}, ` +
      `cacheCreation=${opts.cacheCreation === undefined ? 'undef' : opts.cacheCreation}, ` +
      `cacheRead=${opts.cacheRead === undefined ? 'undef' : opts.cacheRead}, ` +
      `outputTokens=${opts.outputTokens === undefined ? 'undef' : opts.outputTokens}, ` +
      `contextWindow=${opts.contextWindow})`
    if (opts.source === 'result') log.warn(msg)
    else log.debug(msg)
    return null
  }
  const out: LiteContextUsage = {
    totalTokens,
    maxTokens: opts.contextWindow,
    rawMaxTokens: opts.contextWindow,
    percentage: (totalTokens / opts.contextWindow) * 100,
    model: opts.model,
  }
  if (degraded) out.degraded = true
  // Forward the cache buckets only when the proxy reported a number, so
  // "absent" stays distinguishable from "zero". Corrupt buckets were dropped
  // to undefined by Guard 1 and naturally fall out of the typeof check.
  if (typeof cacheCreation === 'number') out.cacheCreationTokens = cacheCreation
  if (typeof cacheRead === 'number') out.cacheReadTokens = cacheRead
  if (typeof opts.outputTokens === 'number') out.outputTokens = opts.outputTokens
  if (typeof opts.autoCompactThreshold === 'number') out.autoCompactThreshold = opts.autoCompactThreshold
  if (typeof opts.maxOutputTokens === 'number') out.maxOutputTokens = opts.maxOutputTokens
  return out
}

/** Apply a freshly-derived context-usage snapshot to the session: cache it on
 *  `lastContextUsage` (so a tab attaching LATER gets it via the
 *  subscribeContextUsage snapshot) and broadcast it to every live subscriber.
 *
 *  Guards against a degraded snapshot (Guard 1 dropped a corrupt cache bucket)
 *  overwriting a healthy last-good value. Without this, an intermittently
 *  corrupt proxy flip-flops the ContextBar between the true fill level and the
 *  input-only fallback on every turn — e.g. 67% on a turn where a bogus
 *  0.67M cache_read is under the window, then 0.04% on the next turn where
 *  the same proxy reports 1.3M and Guard 1 drops it. The healthy reading is
 *  the closest estimate of reality; a corrupt turn's fallback tells us nothing
 *  new, so we keep the last good bar and log instead.
 *
 *  A degraded snapshot still lands when there is no last-good at all (a proxy
 *  that returns a corrupt bucket on EVERY turn — the very case 1dd57aa fixed,
 *  where rejecting the snapshot froze the bar empty forever). In that situation
 *  `lastContextUsage` is either undefined (first turn) or already degraded, so
 *  the guard below doesn't fire and the input-only estimate is what the bar
 *  shows, keeping it live. */
function applyContextUsage(session: Session, usage: LiteContextUsage): void {
  const last = session.lastContextUsage
  if (usage.degraded && last && !last.degraded) {
    log.debug(
      `[context-usage] degraded snapshot over healthy last-good → keeping ` +
      `last-good (model=${last.model}, ` +
      `totalTokens=${last.totalTokens}/${last.maxTokens}) ` +
      `instead of degraded (totalTokens=${usage.totalTokens}/${usage.maxTokens})`,
    )
    return
  }
  session.lastContextUsage = usage
  for (const sub of session.contextUsageSubscribers) {
    try { sub.push(usage) } catch { /* subscriber dead — skip */ }
  }
}

/** Recompute the auto-compact threshold on the cached context-usage snapshot
 *  after a pinned-window change (setAutoCompactWindow pin/clear, or the
 *  generic /settings route forwarding `autoCompactWindow`) and re-broadcast
 *  immediately — WITHOUT waiting for the next turn's `result`.
 *
 *  Without this, a successful pin/clear leaves every live ContextBar showing
 *  the PREVIOUS threshold (typically the auto position — e.g. 83.5% on a
 *  200k model) until the next completed turn lands, which reads as "the drag
 *  did nothing / it snapped back to 84%". The threshold only ever derives
 *  from `result` payloads, so the immediate refresh must re-derive it from
 *  the last snapshot's own window/maxOutputTokens under the new override
 *  (mirroring liteContextUsageFromResult's windowOverride handling: the
 *  override replaces the model window; absent → fall back to the model
 *  window = "auto").
 *
 *  No-op when there is no cached snapshot yet (fresh session — the bar is
 *  empty regardless, and the next `result` derives the threshold fresh), or
 *  when the recomputed threshold is unchanged (no pointless broadcast). */
export function reapplyAutoCompactWindow(session: Session, windowOverride?: number): void {
  const last = session.lastContextUsage
  if (!last) return
  const effectiveWindow = windowOverride && windowOverride > 0 ? windowOverride : last.maxTokens
  const next = computeAutoCompactThreshold(effectiveWindow, last.maxOutputTokens)
  if (next === last.autoCompactThreshold) return
  const updated: LiteContextUsage = { ...last }
  if (typeof next === 'number') updated.autoCompactThreshold = next
  else delete updated.autoCompactThreshold
  applyContextUsage(session, updated)
}

/** Build a LiteContextUsage from a `result` SDK message. Returns null when
 *  the message lacks the expected fields (e.g. result errors before the
 *  API call landed).
 *
 *  `windowOverride` is the session's pinned auto-compact window (absolute
 *  tokens, SDK Settings.autoCompactWindow). When set to a positive number it
 *  REPLACES the model's advertised context window in the auto-compact
 *  threshold derivation — so a 1M model with a user-pinned 200k window warns
 *  at 200k, not 1M. It does NOT change the bar's maxTokens/percentage, which
 *  continue to reflect the model's real window.
 *  @internal — exported only for unit tests; not part of the module's
 *              public API. */
export function liteContextUsageFromResult(
  msg: SDKMessage,
  windowOverride?: number,
): LiteContextUsage | null {
  if (msg.type !== 'result') return null
  // The result message's `usage` and `modelUsage` shapes are SDK-specific
  // and broader than what we read here — cast through unknown so we can
  // pick out only the numeric fields we care about. Missing fields fall
  // back to 0 below.
  type IterationUsage = {
    type?: string
    input_tokens?: number
    cache_creation_input_tokens?: number | null
    cache_read_input_tokens?: number | null
    output_tokens?: number
  }
  const result = msg as unknown as {
    usage?: IterationUsage & { iterations?: IterationUsage[] | null }
    modelUsage?: Record<string, { contextWindow?: number; maxOutputTokens?: number }>
  }
  const usage = result.usage
  const modelUsage = result.modelUsage
  if (!usage || !modelUsage) return null

  // Pick the model with a contextWindow set. In practice modelUsage has
  // exactly one entry per turn — but we iterate defensively.
  let model = ''
  let contextWindow = 0
  let maxOutputTokens: number | undefined
  for (const [name, info] of Object.entries(modelUsage)) {
    if (info?.contextWindow && info.contextWindow > 0) {
      model = name
      contextWindow = info.contextWindow
      maxOutputTokens = info.maxOutputTokens
      break
    }
  }
  if (contextWindow <= 0) return null

  // Always log the raw payload so we can diagnose context-usage issues.
  // This fires once per turn (when a result message lands). The JSON.stringify
  // calls are gated behind an enabled() check because the variadic log.debug
  // would otherwise evaluate them eagerly at the default info level —
  // `usage.iterations` can be a sizable array, so building it per turn is
  // pure waste when debug is off.
  if (log.enabled('debug')) {
    log.debug(
      `[context-usage] raw payload for model=${model} contextWindow=${contextWindow}: ` +
      `top-level=${JSON.stringify({
        input_tokens: usage.input_tokens,
        cache_creation_input_tokens: usage.cache_creation_input_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens,
      })} ` +
      `iterations=${JSON.stringify(usage.iterations ?? null)}`,
    )
  }

  // Context-window usage = the prompt size of the most recent regular
  // sampling iteration. We must:
  //   1. Skip non-'message' iteration types. 'compaction' iterations
  //      report the SIZE OF THE SUMMARIZED SOURCE MATERIAL in
  //      `input_tokens` (can be many millions — far past any model's
  //      window). 'advisor_message' iterations are internal sub-calls
  //      that don't reflect what the user-facing model "saw".
  //   2. Fall back to top-level `usage` only when iterations is absent
  //      or empty (single-call turn — top-level == that one call).
  // Per Anthropic SDK docs: "Calculate the true context window size
  // from the last iteration." — but only the last `message` iteration.
  let source: IterationUsage = usage
  if (usage.iterations && usage.iterations.length > 0) {
    let pickedMessage = false
    for (let i = usage.iterations.length - 1; i >= 0; i--) {
      if (usage.iterations[i].type === 'message') {
        source = usage.iterations[i]
        pickedMessage = true
        break
      }
    }
    // No 'message' iteration in this turn (e.g. a turn that's purely
    // compaction). Return null rather than reporting a bogus 100% — the
    // previous fallback to "last iteration of any kind" silently clamped
    // to contextWindow, producing the 1000k/1000k bug.
    if (!pickedMessage) {
      log.debug(
        `[context-usage] no 'message' iteration found ` +
        `(types=${usage.iterations.map((it) => it.type).join(', ')}); ` +
        `skipping update to avoid false 100% reading`,
      )
      return null
    }
  }
  // Surface the cache buckets of the picked iteration so the UI can show
  // cache hit rate, plus its output_tokens for the throughput readout, and
  // derive the auto-compact threshold from the model's context window — or
  // from the session's pinned window when one is set (windowOverride).
  const effectiveWindow =
    windowOverride && windowOverride > 0 ? windowOverride : contextWindow
  return assembleLiteUsage({
    inputTokens: source.input_tokens ?? 0,
    cacheCreation: source.cache_creation_input_tokens,
    cacheRead: source.cache_read_input_tokens,
    outputTokens: source.output_tokens,
    contextWindow,
    model,
    autoCompactThreshold: computeAutoCompactThreshold(effectiveWindow, maxOutputTokens),
    maxOutputTokens,
    source: 'result',
  })
}

/** Build a LiteContextUsage from an `assistant` SDK message, reusing the
 *  context-window / model / threshold carried by the last `result`-derived
 *  snapshot. This is what lets the bar refresh MID-TURN (per API response)
 *  instead of only at turn end dmatching the Claude CLI's cadence. Returns
 *  null when there is no cached context window yet (the very first turn,
 *  before any `result` has landed), when the assistant message lacks a
 *  usable usage payload, or when it is a subagent frame (parent_tool_use_id
 *  set) whose own context window would misrepresent the main thread.
 *  @internal — exported only for unit tests; not part of the module's
 *              public API. */
export function liteContextUsageFromAssistant(
  msg: SDKMessage,
  cached: LiteContextUsage | undefined,
): LiteContextUsage | null {
  if (msg.type !== 'assistant') return null
  // Subagent assistant frames carry their own (smaller) context window;
  // updating the main-thread bar from them would be misleading.
  if (getParentToolUseId(msg) != null) return null
  if (!cached || !cached.maxTokens || cached.maxTokens <= 0) return null
  const beta = (
    msg as unknown as {
      message?: {
        usage?: {
          input_tokens?: number
          cache_creation_input_tokens?: number | null
          cache_read_input_tokens?: number | null
          output_tokens?: number | null
        }
      }
    }
  ).message?.usage
  if (!beta) return null
  // `input_tokens` on a BetaMessage usage is the non-cached prompt portion;
  // the true prompt size sums all three input buckets (Anthropic docs).
  return assembleLiteUsage({
    inputTokens: beta.input_tokens ?? 0,
    cacheCreation: beta.cache_creation_input_tokens,
    cacheRead: beta.cache_read_input_tokens,
    outputTokens: beta.output_tokens,
    contextWindow: cached.maxTokens,
    model: cached.model,
    // Carry the threshold forward from the last `result` so the warning
    // stays live between turn-end refreshes.
    autoCompactThreshold: cached.autoCompactThreshold,
    maxOutputTokens: cached.maxOutputTokens,
    source: 'assistant',
  })
}
