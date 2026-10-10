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
import type { ProviderSessionHandle } from './providers/types.js'
import { getParentToolUseId, isTranscriptMessage, pushBounded, stampReceivedAt, shouldBroadcastMessage, trimLargeToolResults, truncateMiddle } from './history-utils.js'
import { mutatingToolUseId, scheduleGitBroadcast } from './git-broadcast.js'
import { metrics } from './metrics.js'
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
import { isTerminalTaskStatus, normalizeTaskType, type TaskResourceLink } from '../shared/tasks.js'
import { AUTOCOMPACT_BUFFER_TOKENS, AUTOCOMPACT_MAX_OUTPUT_FLOOR } from '../shared/auto-compact.js'
import { isEmptyResultFrame } from '../shared/results.js'
import { isTaskNotificationUserMessage, userMessageHasToolResult } from '../shared/user-frames.js'

const MAX_HOOK_OUTPUT_CHARS = 20_000

function trimHookOutput(value: string): string {
  if (value.length <= MAX_HOOK_OUTPUT_CHARS) return value
  // Same head+tail elision shape as tool_result trimming in history-utils —
  // one helper keeps the omission-marker wording consistent everywhere.
  return truncateMiddle(value, 10_000, 8_000)
}

const log = createLogger('pump')

/** Stamp an unaccounted CLI-driven turn start: pendingTurns 0→1 with a fresh
 *  workingSince and turnActive, plus a sidebar refresh. Both detection sites
 *  (the `<task-notification>` injection frame and the main-thread assistant
 *  catch-all) must stamp IDENTICALLY — one helper makes drift impossible.
 *  Callers gate on `session.pendingTurns === 0` (never double-fires, never
 *  lowers the count). */
function stampUnaccountedTurn(session: Session, deps: PumpDeps): void {
  session.pendingTurns = 1
  session.workingSince = Date.now()
  session.turnActive = true
  deps.broadcastInfo?.(session)
}

// getParentToolUseId lives in history-utils.ts, and the user-frame content
// predicates (userMessageHasToolResult / isTaskNotificationUserMessage) in
// shared/user-frames.ts — the history readers and the client need the
// identical classification (see trimLargeToolResults in history-utils for
// the same cross-surface placement rationale). Both imported above.

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
    is_backgrounded?: unknown
    patch?: unknown
    summary?: unknown
    last_tool_name?: unknown
    status?: unknown
    reason?: unknown
    resource_links?: unknown
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
      // Frames carry the internal discriminant (local_bash / local_agent /
      // local_workflow); the record always holds the friendly label the UI
      // matches on. See normalizeTaskType.
      taskType: normalizeTaskType(str(raw.task_type)) ?? existing?.taskType,
      workflowName: str(raw.workflow_name) ?? existing?.workflowName,
      status: 'running',
      skipTranscript: raw.skip_transcript === true ? true : existing?.skipTranscript,
      ambient: raw.ambient === true ? true : existing?.ambient,
      isBackgrounded: typeof raw.is_backgrounded === 'boolean'
        ? raw.is_backgrounded
        : existing?.isBackgrounded,
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
      // SDK 0.3.273: present only when the task did not end through an
      // ordinary completion/failure/stop (currently 'worker_restart').
      reason: raw.reason === 'worker_restart' ? 'worker_restart' : rec.reason,
      // SDK 0.3.257: files a backgrounded MCP task returned by reference.
      resourceLinks: normalizeResourceLinks(raw.resource_links) ?? rec.resourceLinks,
      endedAt: frameTime ?? rec.endedAt,
      updatedAt: now,
    })
  }

  pruneTerminalTasks(session)
  pushTasksSnapshot(session)
}

/** Narrow the SDK's `resource_link` blocks to the fields the UI renders,
 *  dropping malformed entries. Returns undefined when nothing usable remains
 *  so an existing value is preserved on a frame that carries none. */
function normalizeResourceLinks(raw: unknown): TaskResourceLink[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: TaskResourceLink[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const r = item as { uri?: unknown; name?: unknown; title?: unknown; mimeType?: unknown }
    if (typeof r.uri !== 'string' || r.uri === '') continue
    out.push({
      uri: r.uri,
      name: typeof r.name === 'string' && r.name !== '' ? r.name : r.uri,
      ...(typeof r.title === 'string' && r.title !== '' ? { title: r.title } : {}),
      ...(typeof r.mimeType === 'string' && r.mimeType !== '' ? { mimeType: r.mimeType } : {}),
    })
  }
  return out.length > 0 ? out : undefined
}

/** Evict oldest terminal records beyond the cap. Active tasks are never
 *  evicted; insertion order tracks start order, so the first terminal hit
 *  is the oldest. Shared by applyTaskEvent and the Stop-hook reconciliation
 *  (which can settle several records at once). */
function pruneTerminalTasks(session: Session): void {
  let terminals = 0
  for (const rec of session.tasks.values()) {
    if (isTerminalTaskStatus(rec.status)) terminals++
  }
  if (terminals <= MAX_TERMINAL_TASKS) return
  for (const [taskId, rec] of session.tasks) {
    if (terminals <= MAX_TERMINAL_TASKS) break
    if (isTerminalTaskStatus(rec.status)) {
      session.tasks.delete(taskId)
      terminals--
    }
  }
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
      if (!next.taskType && typeof t.task_type === 'string') next.taskType = normalizeTaskType(t.task_type)
      if (t.ambient === true) next.ambient = true
      next.updatedAt = now
      session.tasks.set(taskId, next)
    } else {
      session.tasks.set(taskId, {
        taskId,
        description: typeof t.description === 'string' ? t.description : '',
        taskType: typeof t.task_type === 'string' ? normalizeTaskType(t.task_type) : undefined,
        ambient: t.ambient === true,
        isBackgrounded: true,
        status: 'running',
        updatedAt: now,
      })
    }
  }
  pushTasksSnapshot(session)
}

/** One entry of a Stop-hook `background_tasks` array (SDK
 *  `BackgroundTaskSummary`), narrowed to the fields we consume. `id` is the
 *  task id; `status` is free-text in the SDK type, so it is adopted only when
 *  it parses as a known TaskStatus. */
export interface StopHookTaskSummary {
  id: string
  status?: string
}

/** Reconcile `session.tasks` against the authoritative in-flight list the CLI
 *  hands to the Stop hook (`StopHookInput.background_tasks` — "In-flight
 *  background work (running/pending + backgrounded) registered in this
 *  session. Empty array when nothing is in flight").
 *
 *  This is the only LEVEL signal that carries per-task status, which makes it
 *  the one place we can settle records the edge stream stranded: the CLI does
 *  not reliably emit `task_notification` for Agent-launched background
 *  subagents (hence subagent-watcher.ts), so a lost bookend otherwise leaves a
 *  row spinning forever and the WorkingBubble stuck in "Waiting...". Stop
 *  fires at turn end, which is exactly when the UI flips active → waiting/idle.
 *
 *  Three deliberate restrictions, each guarding a way this could do harm:
 *
 *  - **Ambient/skipTranscript records are never swept.** The SDK documents
 *    those as housekeeping the CLI "does not surface as user work", so their
 *    membership in this list is not something we can rely on; sweeping them
 *    would kill live watcher rows at every turn end.
 *  - **`paused` records are never swept.** Paused is not in-flight but is not
 *    finished either, so absence proves nothing.
 *  - **Terminal records are never resurrected.** A listed task we already
 *    settled means our completion signal and this level snapshot disagree;
 *    the edge that settled it carried real completion data (endedAt, summary),
 *    this snapshot carries none, so we keep the settled record.
 *
 *  Swept records land on `stopped`, not `completed`: we know they left the
 *  in-flight set, not that they succeeded. `stopped` renders neutral in the
 *  TasksPanel (only failed/killed take the error styling).
 *
 *  ASSUMPTION worth knowing if this ever mis-fires: the sweep trusts the CLI's
 *  list to cover EVERY non-ambient task type that can still be running at turn
 *  end. Probe-verified for `local_bash` and `local_agent`; NOT verified for
 *  `monitor` / `local_workflow`. If such a task were both genuinely running and
 *  absent from the list, its row would read `stopped` while the work continues
 *  — cosmetic and non-destructive (no transcript state, no chip), but it would
 *  not self-heal, because applyTaskEvent's `task_progress` branch preserves an
 *  existing status. A later `task_updated` carrying a status DOES reopen it.
 *  That is the first place to look, and narrowing the sweep to
 *  `isBackgrounded === true` is the fix — at the cost of no longer settling
 *  foreground records whose completion frame was lost.
 *
 *  Returns true when anything changed (a snapshot was pushed). */
export function reconcileTasksFromStopHook(session: Session, summaries: StopHookTaskSummary[]): boolean {
  const live = new Set<string>()
  for (const s of summaries) {
    if (s && typeof s.id === 'string' && s.id !== '') live.add(s.id)
  }

  // Id-space guard: a non-empty list where NOTHING matches a known record is
  // more likely a shape/id-space mismatch (or a session whose whole task set
  // we never saw) than a genuine "everything you know about is done" — and
  // acting on it would sweep every live row. Bail instead. An empty list needs
  // no such check: "nothing is in flight" is id-space independent.
  if (live.size > 0) {
    let anyKnown = false
    for (const id of live) {
      if (session.tasks.has(id)) { anyKnown = true; break }
    }
    if (!anyKnown) return false
  }

  const now = Date.now()
  let changed = false

  for (const [taskId, rec] of session.tasks) {
    if (isTerminalTaskStatus(rec.status)) continue
    if (live.has(taskId)) {
      // Listed → still in flight. Adopt the CLI's status when it parses as a
      // known non-terminal one and differs from ours (e.g. pending → running).
      const reported = summaries.find((s) => s.id === taskId)?.status
      if (
        isTaskRecordStatus(reported) &&
        !isTerminalTaskStatus(reported) &&
        reported !== rec.status
      ) {
        session.tasks.set(taskId, { ...rec, status: reported, updatedAt: now })
        changed = true
      }
      continue
    }
    if (rec.ambient === true || rec.skipTranscript === true) continue
    if (rec.status === 'paused') continue
    session.tasks.set(taskId, {
      ...rec,
      status: 'stopped',
      endedAt: rec.endedAt ?? now,
      progressSummary: undefined,
      lastToolName: undefined,
      updatedAt: now,
    })
    changed = true
  }

  if (!changed) return false
  pruneTerminalTasks(session)
  pushTasksSnapshot(session)
  return true
}

/** Settle EVERY non-terminal task record once the CLI process is gone.
 *
 *  `reconcileTasksFromStopHook` cannot cover this case. It needs a Stop hook
 *  (a process that has exited never fires one), and it deliberately exempts
 *  ambient / skipTranscript / `paused` records on the premise that absence from
 *  the in-flight list proves nothing while the process is alive. Neither
 *  premise survives the exit: there is no in-flight set left and nothing can
 *  resume, so every exemption there just means "left running forever". A record
 *  left behind renders a spinner in the TasksPanel on a dead session with no
 *  path that ever clears it (observed: a background `sleep` shell record stayed
 *  `running` after its session's CLI was killed).
 *
 *  Lands them on `stopped` — the same status the subagent watcher's own
 *  process-exit fallback uses, meaning "ended, no completion evidence", never
 *  an assertion of failure. Callers must NOT run this on the clean-exit path:
 *  an idle-timeout exit is followed by auto-resume, and settling there would
 *  flap records to stopped while the work continues. A late real completion
 *  still overrides an over-eager `stopped`, since a task_notification frame
 *  writes its own status.
 *
 *  Returns true when anything changed. */
export function settleTasksOnProcessExit(session: Session): boolean {
  const now = Date.now()
  let changed = false
  for (const [taskId, rec] of session.tasks) {
    if (isTerminalTaskStatus(rec.status)) continue
    session.tasks.set(taskId, {
      ...rec,
      status: 'stopped',
      endedAt: rec.endedAt ?? now,
      progressSummary: undefined,
      lastToolName: undefined,
      updatedAt: now,
    })
    changed = true
  }
  if (!changed) return false
  pruneTerminalTasks(session)
  pushTasksSnapshot(session)
  return true
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
  /** Capture the end-of-turn worktree state and append a patch (the diff
   *  from the previous tree to this one) to the snapshot sidecar. Pairs
   *  with `recordTurnAnchor`/`recordResultFrame` on the success-result
   *  path. Fire-and-forget: a missed patch only means that turn's file
   *  mutations aren't separately rewindable (the previous anchor still
   *  is). Optional so test fixtures that don't exercise snapshot behavior
   *  can omit it. */
  recordTurnSnapshot?: (sessionId: string, assistantUuid: string) => void
  /** Request a context-usage reconciliation probe after a non-empty result
   *  FAILED to yield a snapshot. The main failure mode: the aggregate-
   *  reporting wire (SDK 0.3.278 + e.g. mify proxies) whose top-level usage
   *  is the turn's BILLING SUM across all API calls and whose `iterations`
   *  arrive empty — liteContextUsageFromResult refuses that shape (a real
   *  session cached 995,023/1M = 99.5% off it while the CLI's own accounting
   *  said 16%), so the probe is the bar's ONLY source there. Also covers
   *  purely-compaction turns and garbage payloads the guards rejected. The
   *  manager (which owns SDK control calls — see probeAutoCompactFacts)
   *  answers by probing getContextUsage() and applying the CLI's
   *  authoritative numbers via applyContextUsage. Fire-and-forget: the turn
   *  path never awaits it. Optional so test fixtures that don't exercise
   *  reconciliation can omit it. */
  reconcileContextUsage?: (session: Session) => void
  /** Seed the session's context-usage snapshot (first `system/init` of a
   *  pump's life — `initAtMs` never resets, so an in-place respawn on the
   *  SAME session object does not re-fire; a fresh Session from
   *  spawn/resume always does). The manager answers with a fire-and-forget
   *  getContextUsage() probe so a brand-new session paints its Context bar
   *  before the first turn completes. This init hook is the RETRY leg of a
   *  three-trigger family (spawn completion + empty-cache subscribe are the
   *  others — see SessionManager.seedContextUsage): on proxy backends the
   *  init frame can arrive minutes late or never, so spawn is the primary
   *  trigger and this one only re-fires when the early probe failed. All
   *  guards (cache-empty, in-flight, staleness) live manager-side; safe to
   *  call redundantly. Optional so test fixtures that don't exercise
   *  seeding can omit it. */
  seedContextUsage?: (session: Session) => void
  /** Reference to the broadcaster — needed by the mutating-tool detector
   *  to schedule a debounced git-snapshot broadcast after Claude
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
  // SDK >=0.3.268 numbers result frames per run (`result_index`, from 0) in
  // delivery order. A pump owns exactly one run, so a gap means a result frame
  // was lost between the CLI and us — log it (diagnostic only; the turn still
  // settles via whatever frames arrived).
  let lastResultIndex: number | undefined
  // Pump-local: ids of tool_use blocks for filesystem-mutating tools.
  // Populated when we see the assistant's tool_use, drained when the
  // matching tool_result lands (which is when we know git status may
  // actually have changed). Set rather than Map because we only need
  // membership — the name was already checked at insertion time.
  const pendingMutatingToolUses = new Set<string>()
  // The handle this pump owns. An in-place respawn (restart()) swaps
  // session.handle under a still-running pump; cleanupPump compares against
  // this to tell "my Query ended" apart from "I was superseded".
  const myHandle = session.handle
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
    // Metrics: previous iter.next() resolution timestamp, for the arrival
    // cadence histogram (pump_next_gap_ms).
    let lastNextResolvedAt: number | undefined
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
        // Arrival cadence: gap between consecutive iter.next() resolutions
        // (= processing time of the previous message + any wait). During a
        // heavy stream this is the pump's steady-state heartbeat; a tiny gap
        // with a large ws_fanout_ms means the loop is the bottleneck. Gaps
        // above 60s are idle-between-turns waits, not cadence — reset the
        // baseline instead of recording them, so a long idle doesn't poison
        // the distribution.
        const resolvedAt = Date.now()
        if (lastNextResolvedAt !== undefined) {
          const gap = resolvedAt - lastNextResolvedAt
          if (gap <= 60_000) metrics.observe('pump_next_gap_ms', gap)
        }
        lastNextResolvedAt = resolvedAt
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
        // A <task-notification> injection arriving while no turn is accounted
        // IS the CLI starting a continuation turn — the injection is the
        // prompt. Stamp on the frame, not on the first assistant frame: the
        // model's first token can lag the injection by tens of seconds
        // (observed live: 83s between the streamed notification frame and the
        // first assistant frame), and that whole lag is otherwise unaccounted
        // turn time (live again, phase reads 'idle' mid-turn).
        if (session.pendingTurns === 0 && isTaskNotificationUserMessage(msg)) {
          stampUnaccountedTurn(session, deps)
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
        // git-snapshot broadcast when the matching tool_result lands.
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
        // git-snapshot broadcast. The SDK wraps tool_results in a
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
          if (bootMs !== undefined) metrics.observe('session_spawn_ms', bootMs)
          const model = typeof (msg as { model?: unknown }).model === 'string' ? (msg as { model?: string }).model : ''
          log.info(
            `[${session.id}] init handshake done in ${bootMs ?? '?'}ms from pump start` +
              (model ? ` (model=${model})` : ''),
          )
          // Zero-turn Context bar seed (retry leg) — see
          // PumpDeps.seedContextUsage. Contained like
          // onBackgroundSubagentLaunched: this is an injected dep boundary,
          // not a trusted internal call — the pump loop must survive any
          // implementation (test fixtures inject throwers).
          if (deps.seedContextUsage) {
            try {
              deps.seedContextUsage(session)
            } catch (err) {
              log.warn(`[${session.id}] seedContextUsage threw:`, err)
            }
          }
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
        // `active_goal`: the current /goal Stop-hook condition (iterations, set_at,
        // last_reason; the CLI reports `value: null` to clear it). Turn-scoped
        // and re-emitted on each goal re-check — NOT transcript content (a
        // persistent card would flood history with per-recheck rows). Drop it
        // entirely (never the ring, never a broadcast): the app has no goal
        // indicator to consume it, and mirroring a frame the server never
        // re-serves into shared state would be dead plumbing. Cast the type
        // check because `active_goal` isn't in the bundled SDKMessage union.
        if ((msg as { type?: string }).type === 'active_goal') continue
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
        // Metrics: time this message's synchronous fanout work (ring append +
        // subscriber pushes). This is the portion of the pump that directly
        // blocks the event loop per message — the primary signal for the
        // "session A streams, session B hangs" hypothesis. (The early-continue
        // ephemeral frames above perform no fanout and are intentionally not
        // observed.)
        // Unaccounted main-thread turn stamp (catch-all). `pendingTurns` is
        // normally driven by send() (set in pushToSession) and the result
        // handler (cleared below) — but turns the CLI starts ITSELF never
        // pass through send(): the harness injects a `<task-notification>`
        // user prompt internally and runs a full turn on it. The injection
        // frame itself IS streamed and gets its own stamp above; this
        // branch covers any other CLI-driven turn shape whose first
        // main-thread assistant frame arrives with nothing accounted.
        // Without a stamp the whole turn reads as idle (phase 'live'): the
        // WorkingBubble stays hidden, phase-gated routes accept mid-turn
        // calls, and the stuck-session GC never watches it — a silent tool
        // call inside such a turn can zombie forever (observed: 20+ min with
        // no message and no result). Subagent frames are excluded
        // (background subagent activity surfaces as 'waiting', not
        // 'working'); the result handler owns the clear, so back-to-back
        // notification turns re-stamp per turn. Resume does not replay
        // assistant frames over the stream (history is disk-seeded into the
        // ring directly), so this cannot misfire on a freshly resumed idle
        // session.
        if (msg.type === 'assistant' && getParentToolUseId(msg) == null && session.pendingTurns === 0) {
          stampUnaccountedTurn(session, deps)
        }
        const fanoutStart = performance.now()
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
          for (const sub of session.pluginSubscribers.values()) {
            try { sub.push(msg) } catch { /* subscriber dead — don't break broadcast to others */ }
          }
        }
        metrics.observe('ws_fanout_ms', performance.now() - fanoutStart)
        msgCount++
        // Derive a context-usage snapshot directly from the result's own
        // `usage` + `modelUsage` payload — no IPC. The result message is
        // the SDK's authoritative tally for the API call that just landed,
        // so we get exact numbers for free instead of round-tripping into
        // the CLI subprocess for getContextUsage(). The full breakdown
        // (skills/agents/memoryFiles/mcpTools) still comes from the
        // on-demand REST endpoint when the user opens SettingsPanel.
        // NOTE: on the empty-iterations wire this deliberately returns null
        // (see the aggregate-capable gate inside) — the reconcile probe is
        // the source of truth there, and the fire gate below keys on this
        // failure.
        let resultUsage: LiteContextUsage | null = null
        const emptyResult = msg.type === 'result' ? isEmptyResultFrame(msg) : false
        if (msg.type === 'result') {
          // Pass the session's pinned auto-compact window (undefined = auto)
          // so the derived threshold reflects a user override, not just the
          // model's raw context window — plus any authoritative threshold the
          // CLI already told us, which wins over our local replica. When the
          // provider's handle cannot be probed (no getContextUsage), the
          // unverifiable fallback stays available — see the gate inside.
          const usage = liteContextUsageFromResult(msg, session.autoCompactWindow, session.lastSdkAutoCompact, {
            allowUnverifiableFallback: typeof session.handle?.getContextUsage !== 'function',
          })
          resultUsage = usage
          // Cold-start instrumentation: log once on the FIRST REAL result —
          // the user-visible end of the first turn. Empty warm-up results
          // (num_turns: 0, or an all-zero usage payload) are placeholders,
          // not turns. Deliberately NOT gated on derivation success: on the
          // aggregate wire the gate refuses every real result, and the
          // spawn→first-response latency measurement must survive that.
          // Combines our pump-side anchors with the SDK's own wire timings
          // (ttft_ms = time to first token, request_sent_wall_ms = wall time
          // from send to response, time_to_request_from_spawn_ms). Read
          // defensively.
          if (!emptyResult && !isZeroUsageResult(msg) && session.firstTurnAtMs === undefined) {
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
          // SDK 0.3.274 emits one result per queued background-task completion,
          // all but the last empty (num_turns: 0) — same shape as the
          // spawn/restart warm-up result. They are not real turns: they must
          // not become resume anchors or persisted result frames, and the
          // client transcript suppresses their footer (isEmptyResultFrame).
          // (emptyResult is computed once above, shared with the cold-start
          // anchor.)
          const resultIndex = (msg as { result_index?: unknown }).result_index
          if (typeof resultIndex === 'number' && Number.isFinite(resultIndex)) {
            if (lastResultIndex !== undefined && resultIndex > lastResultIndex + 1) {
              log.warn(
                `[session ${session.id}] result frame gap: index ${resultIndex} after ${lastResultIndex} ` +
                `(${resultIndex - lastResultIndex - 1} lost)`,
              )
            }
            lastResultIndex = resultIndex
          }
          // Promote the most recent main-thread assistant uuid to the
          // safe-resume anchor: this turn completed successfully, so a later
          // fork/cut from here would drop a *later* crashed turn while
          // preserving this one. Only success counts — error_max_turns /
          // error_max_budget leave the turn in an indeterminate state, so we
          // keep the previous anchor rather than trusting a failed turn.
          if (!emptyResult && (msg as { subtype?: string }).subtype === 'success' && session.lastAssistantUuid) {
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
          if (!emptyResult) {
            const resultUuid = (msg as { uuid?: string }).uuid
            if (resultUuid && session.lastAssistantUuid) {
              deps.recordResultFrame?.(session.id, resultUuid, session.lastAssistantUuid, msg)
            }
            // Ask the manager to reconcile the context snapshot against the
            // CLI's own accounting (see the PumpDeps doc). Fire-and-forget.
            //
            // Fire gate: whenever this result FAILED to yield a trustworthy
            // snapshot. That covers the unverifiable aggregate wire (the
            // derivation returns null there BY DESIGN when a probe is
            // possible — the probe is the source of truth on it), a
            // purely-compaction turn (no 'message' iteration — the stale
            // pre-turn number must not wait for the next ordinary result), a
            // DEGRADED snapshot (corrupt bucket dropped; applyContextUsage
            // will refuse it over a healthy last-good, so without a probe
            // the bar would freeze), and any other garbage payload the
            // guards rejected. A healthy derivation needs no probe — no
            // round-trip is spent on wires whose per-call numbers are
            // already exact. ERROR results are skipped too: the CLI's
            // context accounting did not change, and an error loop would
            // otherwise spend one control request per failed turn.
            if (
              (msg as { is_error?: boolean }).is_error !== true
              && (resultUsage == null || resultUsage.degraded)
            ) {
              deps.reconcileContextUsage?.(session)
            }
          }
          // Capture the end-of-turn worktree state and append a patch (the
          // diff from the previous tree to this one) to the snapshot sidecar.
          // Pairs with the anchor captured at send time: the patch records
          // what this turn's tool edits changed, so a rewind-to-anchor can
          // restore the pre-turn state. Fire-and-forget like the anchor/
          // result-frame writes; a missed patch only means this turn's
          // mutations aren't separately rewindable.
          if (!emptyResult && session.lastAssistantUuid) {
            deps.recordTurnSnapshot?.(session.id, session.lastAssistantUuid)
          }
          const moreQueued = session.handle.queueDepth > 0
          log.debug(
            `[session ${session.id}] result received — total msgs: ${msgCount}, ` +
            `input.queueDepth=${session.handle.queueDepth}, moreQueued=${moreQueued}`,
          )
          // The turn this result closes is done. With moreQueued the next
          // turn hasn't STARTED yet (its echo hasn't landed), so turnActive
          // is false either way — interrupt()'s dead-working-state probe
          // reads it as "no turn in flight".
          session.turnActive = false
          if (moreQueued) {
            // Keep pendingTurns=1 so the UI continues to show "working" without
            // flicker. workingSince is RE-anchored at a REAL turn boundary (not
            // an emptyResult bookend): it is the turn timer's start, and leaving
            // it at the first send of a long queue painted a multi-dozen-hour
            // "Working" elapsed on back-to-back turns (90 queued inputs over
            // 38h). Empty results are background-task completions, not turns —
            // re-anchoring there would snap a live turn's age back to ~0.
            session.pendingTurns = 1
            if (!emptyResult) session.workingSince = Date.now()
          } else {
            // Every queue-empty result clears the turn state — INCLUDING empty
            // bookends. An empty bookend landing between the micro-turns of a
            // CLI-driven continuation drops the unaccounted-turn stamp for a
            // moment, but the next main-thread assistant frame re-stamps (the
            // blip self-heals), whereas NOT clearing on a turn-final empty
            // result would strand working=true forever (the GC would then
            // auto-interrupt a finished session). The stamps cover the real
            // hazard — long silent stretches mid-turn, where no result arrives
            // at all and pendingTurns holds regardless.
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
    await cleanupPump(session, deps, myHandle)
  }
}

async function cleanupPump(session: Session, deps: PumpDeps, pumpHandle: ProviderSessionHandle): Promise<void> {
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

    // This pump's handle is no longer the session's — SessionManager.restart()
    // replaced it in place (setProfile's "Restart now") while this pump was
    // still parked on iter.next(), and destroying the old handle is what ended
    // us. The session is alive and already owned by the replacement pump, so
    // the whole tail below is wrong here: `autoResume` would re-enter
    // respawnInPlace and destroy the handle the restart just created, whose own
    // pump then repeats the cycle until the resume budget is exhausted and the
    // session terminates with 'query_ended' — the client's "This session ended
    // unexpectedly: Connection closed" banner. Leaving subscribers attached and
    // the pending maps alone is also required: the restart kept the same
    // session object precisely so the tab's transcript stream survives.
    // Not to be folded together with the `clearing` guard below: that one
    // covers clear(), which keeps the session in the map (handle untouched)
    // while it awaits the pre-destroy interrupt — there the handle identity
    // still matches, so only `clearing` stops the tail.
    if (session.handle !== pumpHandle) return

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
    // This is the other dead end for task records, reached through a CLEAN
    // exit that declined to resume (an error was set, or autoResume was
    // exhausted / threw) rather than through a crash. Same reasoning as the
    // crash path in handleProcessExit: the CLI is gone, so no Stop hook and no
    // completion frame will ever settle what is left in the map, and a
    // `running` record would spin in the TasksPanel for the rest of the
    // session's life. Runs before endAllSubscribers so the snapshot reaches
    // live panels, and before persist so the terminating broadcast below reads
    // the settled counts.
    settleTasksOnProcessExit(session)
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
    session.turnActive = false
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
  /** Which lens produced this snapshot — the result/assistant derivation
   *  (window = the advertised modelUsage window) or the reconcile probe
   *  (window = the CLI response's own maxTokens). The reconcile builder keys
   *  its window carry on this: a derived last refreshes its window every
   *  ordinary turn (safe to carry), a probe-sourced last would pin a stale
   *  window forever (always adopt the response's). Optional — pre-existing
   *  snapshots and test seeds without it are treated as derived-lens. */
  source?: 'result' | 'assistant' | 'probe'
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

/** Authoritative auto-compact facts read from the SDK's `getContextUsage()`
 *  control response — the CLI's OWN numbers, as opposed to the local replica
 *  `computeAutoCompactThreshold()` derives above.
 *
 *  Why this exists: pinning `Settings.autoCompactWindow` genuinely reaches the
 *  CLI (applyFlagSettings → flag-settings layer), but the THRESHOLD we render
 *  on the ContextBar was a hardcoded copy of a CLI-INTERNAL formula (window −
 *  output headroom − 13000 buffer) with nothing verifying it. The SDK exposes
 *  `autoCompactThreshold` / `isAutoCompactEnabled` / `rawMaxTokens` directly on
 *  the getContextUsage response, so whenever we make that call we keep the
 *  answer, prefer it over the replica, and warn when the two disagree — which
 *  is the drift alarm the copied formula never had.
 *
 *  Opportunistic by design. getContextUsage() is a BLOCKING control request
 *  with no SDK-side timeout (see SessionManager.timeSdkControl), so nothing
 *  here puts one on the per-turn hot path. Facts arrive from the calls the app
 *  already makes: the REST `/sessions/:id/context-usage` endpoint (SettingsPanel
 *  breakdown) and one background probe after a pin/clear. Sessions that never
 *  trigger either keep the formula fallback, exactly as before. */
export interface SdkAutoCompactFacts {
  /** Main-loop model the CLI computed these for. The facts are only trusted
   *  while the live snapshot's model still matches — a model switch (explicit
   *  or a CLI-side fallback) changes the window and invalidates them. */
  model: string
  /** Token count at which the CLI actually triggers auto-compact. Absent when
   *  the CLI reported none (auto-compact off / unsupported backend). */
  threshold?: number
  /** The CLI's RESOLVED auto-compact window (the model's believed limit, or a
   *  smaller compaction-policy window). Recorded for diagnostics — it is
   *  deliberately NOT used as the bar's denominator, which stays the model's
   *  advertised window (see liteContextUsageFromResult). */
  rawMaxTokens?: number
  /** Whether auto-compact is on at all, per the CLI. */
  enabled?: boolean
}

/** Pick the auto-compact facts out of a raw getContextUsage response. Returns
 *  null when the payload isn't a usable response (non-object, or no model to
 *  gate the facts on) so callers can simply skip. Every field is validated
 *  independently — a backend that omits `autoCompactThreshold` still gives us
 *  a usable `model` + `enabled` pair. */
export function parseSdkAutoCompactFacts(raw: unknown): SdkAutoCompactFacts | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as {
    model?: unknown
    autoCompactThreshold?: unknown
    rawMaxTokens?: unknown
    isAutoCompactEnabled?: unknown
  }
  if (typeof r.model !== 'string' || r.model.length === 0) return null
  const facts: SdkAutoCompactFacts = { model: r.model }
  if (typeof r.autoCompactThreshold === 'number' && Number.isFinite(r.autoCompactThreshold) && r.autoCompactThreshold > 0) {
    facts.threshold = Math.round(r.autoCompactThreshold)
  }
  if (typeof r.rawMaxTokens === 'number' && Number.isFinite(r.rawMaxTokens) && r.rawMaxTokens > 0) {
    facts.rawMaxTokens = Math.round(r.rawMaxTokens)
  }
  if (typeof r.isAutoCompactEnabled === 'boolean') facts.enabled = r.isAutoCompactEnabled
  return facts
}

/** How far the local replica may drift from the CLI's reported threshold
 *  before we log about it. A few hundred tokens is rounding; a kilotoken means
 *  the copied buffer/headroom constants no longer match the CLI. */
const AUTOCOMPACT_DRIFT_TOLERANCE = 1000

/** The threshold to render: the CLI's own number when we have a trustworthy
 *  one, else the local formula.
 *
 *  `facts` are only trusted when their model matches the snapshot's — the CLI
 *  computed them for a specific window, and a model switch (or a CLI-side
 *  fallback to another model mid-session) makes them describe a window that is
 *  no longer in play.
 *
 *  `logDrift` is off on the per-turn path (a mismatch would warn on every
 *  result) and on for the rare paths that just fetched fresh facts. */
function resolveAutoCompactThreshold(
  facts: SdkAutoCompactFacts | undefined,
  model: string,
  effectiveWindow: number,
  maxOutputTokens?: number,
  logDrift = false,
): number | undefined {
  const derived = computeAutoCompactThreshold(effectiveWindow, maxOutputTokens)
  if (!facts || facts.model !== model || facts.threshold === undefined) return derived
  if (logDrift && derived !== undefined && Math.abs(derived - facts.threshold) > AUTOCOMPACT_DRIFT_TOLERANCE) {
    log.warn(
      `[context-usage] auto-compact threshold drift: CLI reports ${facts.threshold}, ` +
      `local formula derived ${derived} ` +
      `(model=${model}, effectiveWindow=${effectiveWindow}, ` +
      `maxOutputTokens=${maxOutputTokens ?? 'n/a'}) — using the CLI value. ` +
      `If this persists, shared/auto-compact.ts's constants no longer match the CLI.`,
    )
  }
  return facts.threshold
}

/** Record authoritative facts on the session and fold the CLI's threshold into
 *  the cached snapshot, re-broadcasting so every live ContextBar switches from
 *  the replica to the real number without waiting for another turn.
 *
 *  Same shape as reapplyAutoCompactWindow below: mutate the cached snapshot's
 *  threshold only, no-op when nothing moved.
 *
 *  `logDrift` forwards to resolveAutoCompactThreshold — keep the default
 *  (true) for rare paths (pin probe, REST pull); per-turn callers (the
 *  reconcile probe) pass false so a persistently-drifted threshold doesn't
 *  warn on every single turn. */
export function applySdkAutoCompactFacts(
  session: Session,
  facts: SdkAutoCompactFacts,
  logDrift = true,
): void {
  session.lastSdkAutoCompact = facts
  const last = session.lastContextUsage
  if (!last) return
  const pinned = session.autoCompactWindow
  const effectiveWindow = pinned && pinned > 0 ? pinned : last.maxTokens
  const next = resolveAutoCompactThreshold(facts, last.model, effectiveWindow, last.maxOutputTokens, logDrift)
  if (next === last.autoCompactThreshold) return
  const updated: LiteContextUsage = { ...last }
  if (typeof next === 'number') updated.autoCompactThreshold = next
  else delete updated.autoCompactThreshold
  applyContextUsage(session, updated)
}

/** Guard 1's bucket rule, shared by the result-derivation path and the
 *  reconcile builder so the two lenses cannot drift: a cache bucket larger
 *  than its lens window is BY DEFINITION garbage (a full prompt must fit in
 *  the window), and so is anything negative or non-finite; a bucket EQUAL to
 *  the window is a fully-cached prompt and is kept. The lens window is
 *  whatever window the number was measured against — the derived
 *  `contextWindow` for the result path, the response's own maxTokens for the
 *  reconcile builder.
 *  @internal — exported for unit tests; not part of the module's public API. */
export function saneCacheBucket(value: unknown, lensWindow: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= lensWindow
    ? value
    : undefined
}

/** The spawn/restart warm-up result carries an ALL-ZERO usage payload — not a
 *  user-visible turn end. Zero-ness of the raw buckets is the wire-independent
 *  discriminator: derivation-success used to gate the cold-start anchor, but
 *  the aggregate wire refuses every real result's derivation, so success can't
 *  distinguish a warm-up from a real turn anymore.
 *  @internal — exported for unit tests; not part of the module's public API. */
export function isZeroUsageResult(msg: unknown): boolean {
  const u = (msg as { usage?: Record<string, unknown> } | null | undefined)?.usage
  if (!u || typeof u !== 'object') return true
  const buckets = [u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens]
  return buckets.every((v) => typeof v !== 'number' || v === 0)
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
  if (cacheCreation != null && saneCacheBucket(cacheCreation, opts.contextWindow) === undefined) {
    log.debug(
      `[context-usage] cache_creation bucket outside contextWindow → dropping ` +
      `(source=${opts.source ?? 'unknown'}, model=${opts.model}, ` +
      `inputTokens=${opts.inputTokens}, cacheCreation=${cacheCreation}, ` +
      `cacheRead=${cacheRead}, contextWindow=${opts.contextWindow})`,
    )
    cacheCreation = undefined
    degraded = true
  }
  if (cacheRead != null && saneCacheBucket(cacheRead, opts.contextWindow) === undefined) {
    log.debug(
      `[context-usage] cache_read bucket outside contextWindow → dropping ` +
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
    source: opts.source ?? 'result',
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
export function applyContextUsage(session: Session, usage: LiteContextUsage): void {
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

/** Build a corrected LiteContextUsage from a raw getContextUsage() response —
 *  the CLI's OWN accounting (categories + totals), as opposed to the result
 *  payload's API-usage lens that liteContextUsageFromResult reads.
 *
 *  Why this exists: on aggregate-reporting backends (SDK 0.3.278 + e.g. mify
 *  proxies) a result's top-level `usage` is the turn's BILLING SUM across all
 *  API calls (`input_tokens` == per-call inputs summed, `cache_read` ==
 *  per-call cache reads summed, `iterations: []`), so the empty-iterations
 *  fallback in liteContextUsageFromResult treats the sum as one prompt and
 *  inflates the bar by the call count — a real session cached 995,023/1M =
 *  99.5% while the CLI's own accounting said 155,641/1M = 16%. This builder
 *  turns the authoritative response into the replacement snapshot.
 *
 *  DENOMINATOR CONTRACT: keyed on the LAST SNAPSHOT'S SOURCE (see
 *  LiteContextUsage.source).
 *    - last derived (source result/assistant, or unknown on pre-existing
 *      seeds): its window is the advertised modelUsage one and refreshes
 *      every ordinary turn, so it is carried — model-keyed (a model switch
 *      adopts the response's window; carrying would label the new model with
 *      the old one's denominator) and only while the reading fits (an
 *      over-carried-window reading means the window grew; carrying would
 *      print an impossible >100%).
 *    - last probe-sourced: every snapshot on that wire comes from a probe,
 *      so the response refreshes the window each time — carrying would pin a
 *      stale window forever; the response's own window is adopted.
 *    - standalone (no last snapshot): the response's own window, seeding a
 *      bar on backends whose results lack modelUsage entirely.
 *  In every branch rawMaxTokens is emitted EQUAL to maxTokens — the client's
 *  contextWindowTokens() prefers rawMaxTokens as its denominator, so a
 *  divergent pair would render a fill that disagrees with the served
 *  percentage. The resolved-vs-advertised distinction lives in the
 *  auto-compact THRESHOLD only (and a carried threshold that does not fit
 *  the adopted window is dropped — the client clamps nothing).
 *
 *  Per-call lens buckets (cache read/creation, output) come from the
 *  response's `apiUsage` ONLY, per-field and sanity-checked (finite, >= 0,
 *  < the rendered window — the same corruption class Guard 1 drops in the
 *  result path). They are deliberately NOT carried forward from `last`: on
 *  the aggregate wire that motivated this builder, `last`'s buckets are
 *  themselves billing sums (a 913k cache-read next to a 155k context total),
 *  so carrying them would render an internally inconsistent "authoritative"
 *  snapshot; a bucket the response doesn't report is simply omitted.
 *  maxOutputTokens always carries from `last` (a model limit, not a billing
 *  sum; the response doesn't report it).
 *
 *  Returns null when the response carries no usable reading — non-object,
 *  missing/zero/non-finite totalTokens or maxTokens, a total that exceeds the
 *  response's OWN maxTokens (the lens the CLI measured the total against —
 *  the same impossible-reading guard as assembleLiteUsage; validating against
 *  the carried window would both admit false-low readings and reject true
 *  over-window ones), or no model to attribute the reading to when no last
 *  snapshot exists — callers keep the derived snapshot, exactly as before.
 *  @internal — exported for the SessionManager's reconcile probe and unit
 *              tests. */
export function liteContextUsageFromSdkUsage(
  raw: unknown,
  last?: LiteContextUsage,
): LiteContextUsage | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as {
    totalTokens?: unknown
    maxTokens?: unknown
    // rawMaxTokens is deliberately NOT read: the builder always emits
    // rawMaxTokens === maxTokens (see the doc) — the resolved-vs-advertised
    // distinction lives in the auto-compact threshold, never the denominator.
    model?: unknown
    autoCompactThreshold?: unknown
    isAutoCompactEnabled?: unknown
    apiUsage?: unknown
  }
  if (typeof r.totalTokens !== 'number' || !Number.isFinite(r.totalTokens) || r.totalTokens <= 0) return null
  if (typeof r.maxTokens !== 'number' || !Number.isFinite(r.maxTokens) || r.maxTokens <= 0) return null
  const totalTokens = Math.round(r.totalTokens)
  // A fractional total in (0, 0.5) passes the raw guard but rounds to 0 —
  // that would land a "0 / N · 0.0%" snapshot, the exact clobber shape Guard
  // 2 prevents on the result path.
  if (totalTokens <= 0) return null
  const responseMax = Math.round(r.maxTokens)
  if (totalTokens > responseMax) return null
  const model = typeof r.model === 'string' && r.model.length > 0 ? r.model : last?.model
  if (!model) return null
  // The window/threshold fields of `last` are only trustworthy for THIS model
  // — a model switch adopts the response's regime wholesale.
  const sameModel = last != null && last.model === model
  // Denominator: KEYED ON THE LAST SNAPSHOT'S SOURCE.
  //  - last derived (source result/assistant, or unknown — pre-existing
  //    seeds): its window is the advertised modelUsage one and refreshes
  //    every ordinary turn, so carrying it never goes stale; adopting the
  //    CLI's (possibly compaction-shrunk) response window here would make the
  //    bar oscillate between two lenses around every compaction cycle. Carry —
  //  but only while the reading fits (an over-carried-window reading means
  //  the window grew; carrying would print an impossible >100%).
  //  - last probe-sourced: every snapshot on that wire comes from a probe,
  //    so the response refreshes the window each time — carrying would pin a
  //    stale window forever. Adopt the response's own window.
  const derivedLens = last != null && last.source !== 'probe'
  const maxTokens =
    derivedLens && sameModel && last.maxTokens > 0 && totalTokens <= last.maxTokens
      ? last.maxTokens
      : responseMax
  // NOTE on a compaction-shrunk backend (response window ≠ advertised): the
  // first correction after a derived snapshot carries the advertised window,
  // and every correction after that (last is probe-sourced) uses the CLI's
  // own lens — a ONE-TIME jump to the operative denominator, then stable.
  // That is deliberate: the CLI's own window is what its auto-compact timing
  // actually uses.
  // rawMaxTokens ALWAYS equals maxTokens. The client's contextWindowTokens()
  // prefers rawMaxTokens as its denominator, and the derived snapshots set
  // both to the same context window — a divergent pair would make the bar
  // render a different fill than the served percentage. The resolved-vs-
  // advertised distinction lives in the auto-compact THRESHOLD only.
  const out: LiteContextUsage = {
    totalTokens,
    maxTokens,
    rawMaxTokens: maxTokens,
    percentage: (totalTokens / maxTokens) * 100,
    model,
    source: 'probe',
  }
  if (typeof r.autoCompactThreshold === 'number' && Number.isFinite(r.autoCompactThreshold) && r.autoCompactThreshold > 0) {
    out.autoCompactThreshold = Math.round(r.autoCompactThreshold)
  } else if (
    sameModel
    && r.isAutoCompactEnabled !== false
    && typeof last?.autoCompactThreshold === 'number'
    // A threshold computed for a LARGER window must not tag along onto a
    // smaller adopted one — the client renders the marker at
    // threshold/maxTokens with no clamp, and 967000/200000 pins it at 483%.
    && last.autoCompactThreshold <= maxTokens
  ) {
    out.autoCompactThreshold = last.autoCompactThreshold
  }
  if (typeof last?.maxOutputTokens === 'number' && sameModel) out.maxOutputTokens = last.maxOutputTokens
  // Per-call lens buckets: fresh from the response where reported and sane
  // (same shared rule Guard 1 applies on the result path — a bucket must fit
  // BOTH its measuring lens (the response's window) and the rendered
  // denominator, whichever is smaller), omitted otherwise (never carried
  // from `last` — see the doc above).
  const api = r.apiUsage
  const a = (api && typeof api === 'object' ? api : undefined) as {
    cache_read_input_tokens?: unknown
    cache_creation_input_tokens?: unknown
    output_tokens?: unknown
  } | undefined
  const bucketBound = Math.min(responseMax, maxTokens)
  const cacheRead = saneCacheBucket(a?.cache_read_input_tokens, bucketBound)
  if (cacheRead !== undefined) out.cacheReadTokens = cacheRead
  const cacheCreation = saneCacheBucket(a?.cache_creation_input_tokens, bucketBound)
  if (cacheCreation !== undefined) out.cacheCreationTokens = cacheCreation
  const output = saneCacheBucket(a?.output_tokens, bucketBound)
  if (output !== undefined) out.outputTokens = output
  return out
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
  // The pin just moved, so any CLI-reported threshold we cached describes the
  // PREVIOUS window and would pin the marker to a stale position. Drop it and
  // fall back to the local formula for immediate optimistic feedback; the
  // caller's background probe re-establishes the authoritative value shortly.
  session.lastSdkAutoCompact = undefined
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

/** The wire shape where the top-level usage CANNOT be verified: the SDK type
 *  is `iterations?: IterationUsage[] | null`, and both degenerate values ride
 *  the aggregate bug — an EMPTY array and a NULL array are what
 *  aggregate-reporting backends emit atop a billing-sum top-level usage (a
 *  real session cached 995,023/1M = 99.5% off it while the CLI's own
 *  accounting said 16%), while an ABSENT field means a pre-iteration CLI
 *  whose top-level usage IS the one call's prompt. Populated arrays gave the
 *  derivation an exact last-iteration snapshot. Kept as a predicate so the
 *  derive gate and the reconcile fire gate can't drift apart when the wire
 *  evolves.
 *  @internal — exported for unit tests; not part of the module's public API. */
export function resultUsageUnverifiable(msg: unknown): boolean {
  const usage = (msg as { usage?: { iterations?: unknown } } | null | undefined)?.usage
  if (usage?.iterations === undefined) return false
  if (usage.iterations === null) return true
  return Array.isArray(usage.iterations) && usage.iterations.length === 0
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
 *
 *  `facts` are the CLI's own auto-compact numbers when a previous
 *  getContextUsage() supplied them (see SdkAutoCompactFacts). They win over
 *  the locally-derived threshold whenever their model still matches this
 *  turn's; otherwise the formula is the fallback, as it always was.
 *  @internal — exported only for unit tests; not part of the module's
 *              public API. */
export function liteContextUsageFromResult(
  msg: SDKMessage,
  windowOverride?: number,
  facts?: SdkAutoCompactFacts,
  opts?: { allowUnverifiableFallback?: boolean },
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

  // Always log the raw payload so we can diagnose context-usage issues.
  // This fires once per turn (when a result message lands). The JSON.stringify
  // calls are gated behind an enabled() check because the variadic log.debug
  // would otherwise evaluate them eagerly at the default info level —
  // `usage.iterations` can be a sizable array, so building it per turn is
  // pure waste when debug is off. Deliberately BEFORE the aggregate-capable
  // refusal below — the payload shape on that wire is exactly what this dump
  // exists to diagnose. (model/contextWindow are picked further down, so
  // this dump logs the modelUsage keys instead.)
  if (log.enabled('debug')) {
    log.debug(
      `[context-usage] raw payload (models=${JSON.stringify(Object.keys(modelUsage))}): ` +
      `top-level=${JSON.stringify({
        input_tokens: usage.input_tokens,
        cache_creation_input_tokens: usage.cache_creation_input_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens,
      })} ` +
      `iterations=${JSON.stringify(usage.iterations ?? null)}`,
    )
  }

  // Aggregate-capable wire: `iterations` present and EMPTY (or null — the
  // SDK type allows both, and aggregate backends serialize the empty list as
  // either). On this wire the top-level usage is UNVERIFIABLE — a turn's
  // billing sum (multi-call) and an honest single-call prompt are
  // indistinguishable, and on the backends that report this shape it is in
  // fact the billing sum (a real session cached 995,023/1M = 99.5% here
  // while the CLI's own accounting said 16%). The turn-end reconcile probe
  // is the source of truth on this wire; deriving here would broadcast a
  // possibly-inflated number that the probe then corrects ~300ms later — a
  // guaranteed near-100% flicker every turn. See resultUsageUnverifiable /
  // PumpDeps.reconcileContextUsage.
  //
  // Providers whose handle exposes NO getContextUsage can never be probed —
  // for them the unverifiable fallback stays available (a live, possibly
  // inflated bar beats a frozen one). The pump decides.
  if (resultUsageUnverifiable(result) && !opts?.allowUnverifiableFallback) return null

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
  // resolve the auto-compact threshold — the CLI's own value when we have a
  // matching one cached, else derived from the model's context window (or from
  // the session's pinned window when one is set via windowOverride).
  const effectiveWindow =
    windowOverride && windowOverride > 0 ? windowOverride : contextWindow
  return assembleLiteUsage({
    inputTokens: source.input_tokens ?? 0,
    cacheCreation: source.cache_creation_input_tokens,
    cacheRead: source.cache_read_input_tokens,
    outputTokens: source.output_tokens,
    contextWindow,
    model,
    autoCompactThreshold: resolveAutoCompactThreshold(facts, model, effectiveWindow, maxOutputTokens),
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
