// Background-subagent completion detection via the subagent's own on-disk
// transcript.
//
// PROBLEM: the CLI does not reliably emit a `system`/`task_notification`
// frame for Agent-launched background subagents (verified: across multiple
// background Agent dispatches the parent stream receives zero task_*
// frames). So the client reducer's completion branch never fires, the
// `background` record never flips to `done`, and its WorkingBubble chip
// reappears on every subsequent parent turn.
//
// SOLUTION: the CLI DOES write the subagent's transcript to
//   <cliHome>/projects/<encodedCwd>/<sessionId>/subagents/agent-<agentId>.jsonl
// and appends a final assistant message with `message.stop_reason` when the
// subagent settles. The launch ack carries the `agentId`, so we can locate
// the transcript, poll it, and synthesize a `system`/`task_notification`
// frame for the client when the subagent completes — feeding the reducer's
// existing completion branch.
//
// FRAGILITY: this reads the CLI's on-disk layout directly (the SDK exposes
// no subagent-transcript API), so it depends on the CLI's project-dir
// encoding and the `subagents/agent-<id>.jsonl` path. If the CLI changes
// either, real completion is never detected and only the maxMs backstop (a
// synthesized `stopped`) eventually clears the record — no crash, no false
// `completed`. The previous design's "fall back to the turn-end sweep" was
// a no-op once the parent turn had ended (the record was already `pending`),
// so it is no longer relied upon: the maxMs backstop synthesizes a frame so
// the record can never strand.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { createLogger } from './log.js'
import type { Session, GlobalSessionEvent, SessionInfo } from './session-types.js'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { pushBounded, stampReceivedAt } from './history-utils.js'
import { isTerminalTaskStatus } from '../shared/tasks.js'

const log = createLogger('subagent-watcher')

/** The CLI's config dir: $CLAUDE_CONFIG_DIR if set, else ~/.claude. The CLI
 *  stores transcripts under <cliHome>/projects/. */
export function cliHomeDir(): string {
  const override = process.env.CLAUDE_CONFIG_DIR
  return override ? path.resolve(override) : path.join(os.homedir(), '.claude')
}

/** The CLI encodes a cwd into a project-dir segment by replacing drive / path
 *  separators with '-': "D:/codes/x" -> "D--codes-x". Replicated here because
 *  the SDK doesn't expose subagent transcript access — we read the file the
 *  CLI writes, whose path uses this encoding.
 *
 *  Trailing separators are stripped BEFORE encoding so "D:/codes/x/" encodes
 *  to "D--codes-x" (not "D--codes-x-"), matching the CLI which resolves the
 *  cwd to a canonical path before encoding. Without this, a trailing separator
 *  produces a mismatched project-dir segment and the watcher never finds the
 *  transcript. */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[/\\]+$/, '').replace(/[:\\/]/g, '-')
}

/** Path of a background subagent's own transcript. */
export function subagentTranscriptPath(cwd: string, sessionId: string, agentId: string): string {
  return path.join(cliHomeDir(), 'projects', encodeCwd(cwd), sessionId, 'subagents', `agent-${agentId}.jsonl`)
}

/** Parse the agentId out of an async launch-ack tool_result body. The ack
 *  text looks like "Async agent launched successfully. ... agentId: <id> ...
 *  ". Returns null when no agentId is present (e.g. a synchronous subagent's
 *  real tool_result, which never carries this marker). */
export function parseAckAgentId(ackText: unknown): string | null {
  const text = typeof ackText === 'string' ? ackText : ''
  if (!text) return null
  const m = text.match(/agentId:\s*([A-Za-z0-9_-]+)/)
  return m ? m[1] : null
}

export interface SubagentCompletion {
  status: 'completed' | 'stopped'
  /** The subagent's final assistant text (joined text blocks), used as the
   *  synthesized task_notification's summary so the reducer merges it as the
   *  subagent's result. Empty if the subagent ended with no text. */
  summary: string
}

/** Flatten a message `content` payload (string | array of blocks) to its
 *  joined text. Local to the watcher. */
function extractTextBlocks(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const b of content as Array<{ type?: string; text?: unknown }>) {
    if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('\n').trim()
}

/** stop_reason values that mean the subagent is STILL RUNNING (will emit more
 *  after the tool result / pause resolves). 'tool_use' is set on every
 *  completed tool-calling assistant response — treating it as completion
 *  false-completes any tool-using subagent within seconds of launch (the
 *  common case). 'pause_turn' is a mid-flight pause (the subagent will
 *  resume) and must likewise NOT be treated as completion. Any OTHER
 *  stop_reason (end_turn, max_tokens, max_turns, stop_sequence, refusal, …)
 *  means the subagent has stopped producing → terminal. We use a denylist of
 *  the known non-terminal reasons rather than an allowlist so that a
 *  terminal-but-unfamiliar reason (e.g. a CLI-specific 'max_turns') still
 *  completes instead of polling until the maxMs fallback.
 *
 *  Hoisted to module scope: it is a constant, and readSubagentCompletion runs
 *  once per poll per watcher, so a per-call allocation would churn GC over a
 *  long backstop window. */
const NON_TERMINAL_STOP_REASONS = new Set(['tool_use', 'pause_turn'])

/** The CLI assigns `stop_sequence` to a response the API cut off mid-stream
 *  — the assistant message carries an error notice like "API Error: Connection
 *  lost mid-response. The response above may be incomplete." The subagent then
 *  recovers and keeps producing on its next turn, so this is NOT a completion.
 *  A genuine stop_sequence (the model hit a configured stop sequence and
 *  returned its final output) does NOT carry this marker — its text is the
 *  real final answer. We match the marker against the assistant message's full
 *  text, so the two are distinguished precisely. */
const API_ERROR_TRUNCATION_RE = /API Error: .*mid-response/i

/** Read the subagent's transcript and, if it contains a final assistant
 *  message (one with a terminal `message.stop_reason`), return the completion.
 *  Returns null if the transcript doesn't exist yet, is mid-write, or hasn't
 *  reached a terminal assistant message. Never throws — malformed/partial
 *  lines are skipped, read errors return null (treated as "not done yet"). */
export function readSubagentCompletion(filePath: string): SubagentCompletion | null {
  let text: string
  try {
    text = readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
  let lastStopReason: string | null = null
  let lastText = ''
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let obj: { type?: string; message?: { stop_reason?: unknown; content?: unknown } }
    try {
      obj = JSON.parse(trimmed)
    } catch {
      continue // partial line (file mid-write) — skip, retry next poll
    }
    if (obj.type !== 'assistant' || !obj.message) continue
    const sr = obj.message.stop_reason
    if (typeof sr !== 'string') continue
    if (NON_TERMINAL_STOP_REASONS.has(sr)) continue // mid-tool-call — keep polling
    // A response truncated by a transient API/connection error is NOT a
    // completion — the subagent recovers and keeps producing on its next
    // turn. The CLI writes the error notice as the whole text of the
    // stop_sequence message, so a text match distinguishes it from a genuine
    // stop_sequence (the model hit a configured stop sequence and returned
    // its final output), which stays a normal completion.
    const blockText = extractTextBlocks(obj.message.content)
    if (API_ERROR_TRUNCATION_RE.test(blockText)) continue // transient error — keep polling
    // The last terminal assistant message is the subagent's final response.
    // A later one (if any) overwrites.
    lastStopReason = sr
    lastText = blockText
  }
  if (lastStopReason === null) return null
  // Any terminal stop_reason means the subagent stopped producing and
  // returned its final text — a normal completion. stop_sequence /
  // max_turns / max_tokens are NOT errors: the subagent ran within its
  // bounds and returned output, exactly like end_turn. Mapping them to
  // 'stopped' (which the reducer renders as the interrupted/error state
  // → exclamation icon) was a false positive for subagents ending on a
  // non-end_turn terminal reason. Only the maxMs backstop below (no
  // terminal frame at all — the subagent was killed/stranded mid-work)
  // synthesizes 'stopped'; a real terminal frame is always 'completed'.
  return {
    status: 'completed',
    summary: lastText,
  }
}

export interface WatchOptions {
  cwd: string
  sessionId: string
  agentId: string
  toolUseId: string
  onCompleted: (completion: SubagentCompletion) => void
  /** Steady-state poll interval, in ms (default 2000). Used after the fast
   *  phase (see fastPhaseMs) elapses — long-running subagents settle into this
   *  cadence, keeping GC/read churn low over a multi-hour backstop window. */
  intervalMs?: number
  /** Fast-phase poll interval, in ms (default 500). Applied for the first
   *  `fastPhaseMs` after launch, when a SHORT subagent (the common case) is
   *  most likely to finish. Tightening the early cadence cuts perceived
   *  completion latency from up to `intervalMs` (2 s) down to this — the
   *  extra reads are bounded to the fast phase, so they can't accumulate over
   *  a long run. */
  fastIntervalMs?: number
  /** How long the fast phase lasts, in ms (default 30000). After this much
   *  wall-clock time the watcher drops to `intervalMs`. Chosen so the vast
   *  majority of short subagents (which finish within seconds) get the tight
   *  cadence, while genuinely long ones pay the denser polling for only their
   *  first 30 s. */
  fastPhaseMs?: number
  /** Absolute backstop, in ms (default 2 h). If the watcher reaches this
   *  without detecting a terminal `stop_reason`, it synthesizes a `stopped`
   *  completion so the record can never strand indefinitely. High by design:
   *  a legitimately long background subagent (the common case that previously
   *  false-timed-out at 10 min) is polled until its real `end_turn`, not cut
   *  off. This only resolves the rare subagent whose transcript never gets a
   *  terminal frame (the CLI died / ended via a non-standard path); a real
   *  `completed` always wins first. */
  maxMs?: number
  /** Test-only observability seam. Called immediately after each non-terminal
   *  poll arms the next timer, with the tick index (1-based) and the delay
   *  that was just chosen for the NEXT poll. Lets tests assert the adaptive
   *  cadence actually crossed the fast→steady boundary (a delay === intervalMs
   *  can only be scheduled after fastPhaseMs elapsed), which a completion-only
   *  assertion cannot distinguish from a watcher stuck at the fast cadence.
   *  Never set in production. */
  onPoll?: (info: { pollCount: number; delayMs: number }) => void
}

/** Poll a background subagent's transcript until it reaches completion, then
 *  call `onCompleted`. Two resolution paths, BOTH funnel through `onCompleted`
 *  so the owning record always leaves its `pending`/`background` state:
 *
 *    1. Real terminal `stop_reason` (end_turn / max_turns / stop_sequence / …)
 *       → the subagent's own final text, status `completed`. Any terminal
 *       reason is a normal completion (the subagent stopped producing and
 *       returned output); non-end_turn reasons are NOT errors.
 *    2. `maxMs` backstop → synthesize `stopped`.
 *
 *  The previous design gave up silently at 10 min (`onTimeout`, no frame) and
 *  relied on the client reducer's turn-end sweep to clear the record — but
 *  that sweep is a no-op once the parent turn has ended (the record is already
 *  `pending`), so a subagent that finished even seconds after the 10-min cap
 *  stranded forever (verified in production logs: ~11 of 40 background
 *  subagents timed out, most finishing 39s–7min AFTER the cap). Raising the
 *  cap to 2h lets those finish for real, and synthesizing a frame on the
 *  backstop guarantees the rare no-terminal-frame case still clears.
 *
 *  There is intentionally NO staleness heuristic: the CLI writes one JSON line
 *  per COMPLETE assistant message, so a subagent mid-inference (or a long
 *  tool) is legitimately transcript-quiet for minutes. A staleness threshold
 *  could not reliably tell "stuck" from "thinking" and risked false-stopping a
 *  running subagent. A false stop is recoverable (the reducer's task_notification
 *  branch accepts `interrupted` and lets a late real completion override), but
 *  the transient wrong status is still user-visible, so the watcher avoids
 *  synthesizing anything but a real terminal frame or the maxMs backstop. The
 *  maxMs backstop is the only synthesized path.
 *
 *  Returns a `stop()` to cancel early (called on session unload so a watcher
 *  can't fire into a dead session). */
export function watchBackgroundSubagent(opts: WatchOptions): () => void {
  const intervalMs = opts.intervalMs ?? 2000
  const fastIntervalMs = opts.fastIntervalMs ?? 500
  const fastPhaseMs = opts.fastPhaseMs ?? 30_000
  const maxMs = opts.maxMs ?? 2 * 60 * 60 * 1000
  const filePath = subagentTranscriptPath(opts.cwd, opts.sessionId, opts.agentId)
  // Wall-clock for the backstop (not an `elapsed += intervalMs` counter, which
  // undercounts real time when the event loop delays ticks).
  const startMs = Date.now()
  let done = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let pollCount = 0

  // Adaptive cadence: poll densely (fastIntervalMs) for the first fastPhaseMs
  // — short subagents (the common case) finish here and settle within ~½ s
  // instead of up to 2 s — then relax to intervalMs for the long tail, so a
  // multi-hour backstop window doesn't pay dense-poll read/GC churn.
  const nextDelay = (): number =>
    Date.now() - startMs < fastPhaseMs ? fastIntervalMs : intervalMs

  const finish = (completion: SubagentCompletion, level: 'info' | 'warn', reason: string) => {
    if (done) return
    done = true
    if (timer) clearTimeout(timer)
    log[level](
      `[${opts.sessionId}] background subagent agentId=${opts.agentId} ` +
      `toolUseId=${opts.toolUseId} ${reason} (status=${completion.status})`,
    )
    opts.onCompleted(completion)
  }

  const tick = () => {
    if (done) return
    // 1. Real terminal completion?
    const completion = readSubagentCompletion(filePath)
    if (completion) {
      finish(completion, 'info', 'completed (terminal stop_reason)')
      return
    }
    // 2. Hard backstop (wall-clock).
    if (Date.now() - startMs >= maxMs) {
      finish(
        { status: 'stopped', summary: '' },
        'warn',
        `reached ${maxMs}ms backstop with no completion; synthesizing stopped`,
      )
      return
    }
    // Not done — reschedule at the current adaptive cadence. A
    // self-rescheduling setTimeout (rather than a fixed setInterval) is what
    // lets the delay shrink/grow across the fast-phase boundary, and it also
    // guarantees no re-entrancy: the next poll is only armed after this one
    // returns, so a slow readSubagentCompletion can't stack overlapping ticks.
    const delayMs = nextDelay()
    pollCount += 1
    timer = setTimeout(tick, delayMs)
    opts.onPoll?.({ pollCount, delayMs })
  }
  // The subagent may have already finished by the time the ack reaches us —
  // check once immediately rather than waiting a full interval. Deferred to
  // a microtask so onCompleted can NEVER fire synchronously before the caller
  // has registered the watcher entry: startBackgroundSubagentWatcher sets the
  // map entry AFTER watchBackgroundSubagent returns, and a synchronous
  // completion would delete a not-yet-present entry and then re-add a stale
  // one behind it (its timer is already cleared, so nothing would ever clean
  // it up — backgroundSubagentCount would stick at 1 forever). A microtask
  // runs after the current synchronous stack, so the entry is guaranteed
  // present when the first poll fires; the `done` flag still lets stop()
  // (session unload) cancel the poll before it runs. The first tick also arms
  // the recurring timer via its own reschedule tail.
  queueMicrotask(tick)
  return () => {
    done = true
    if (timer) clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// BackgroundWatcherRegistry — per-session orchestration of the pollers above.
//
// Extracted from session-manager.ts for modularity: the polling itself
// (watchBackgroundSubagent) already lived here, but the Map<sessionId,
// Map<toolUseId, stop>> bookkeeping, TaskRecord seeding, and synthesized
// task_notification broadcast were still inline SessionManager methods. This
// class owns that orchestration; SessionManager keeps thin proxy methods
// (startBackgroundSubagentWatcher / cancelBackgroundWatcher /
// stopBackgroundSubagentWatchers / backgroundSubagentCount) so callers see
// no change.
//
// `applyTaskEvent` is injected (not imported) because it lives in
// session-pump.ts, which itself imports from this module (parseAckAgentId) —
// a direct import here would create a cycle.

export interface BackgroundWatcherRegistryDeps {
  /** Fold a synthesized system/task_notification frame into the session's
   *  task-state cache (session-pump.ts's applyTaskEvent). Injected to avoid
   *  a circular import (session-pump.ts imports from this module). */
  applyTaskEvent(session: Session, msg: SDKMessage): void
  /** Broadcast a global session-info update (sidebar status dot). */
  broadcastGlobal(ev: GlobalSessionEvent): void
  /** Project a live session into its public SessionInfo shape. */
  info(s: Session): SessionInfo
  /** History ring cap, used when pushing the synthesized frame into
   *  session.history (mirrors every other history-ring write). */
  historyCap: number
  /** Live sessions map — used to detect a session unloaded between watcher
   *  dispatch and completion, so a late completion never broadcasts into a
   *  dead session. */
  isLive(sessionId: string): boolean
}

/** One armed watcher's runtime handle. `stop()` cancels its poller; `agentId`
 *  is retained so a settle-on-process-exit can locate the subagent's on-disk
 *  transcript (the transcript path is keyed by agentId, not toolUseId). */
interface WatcherEntry {
  stop: () => void
  agentId: string
}

export class BackgroundWatcherRegistry {
  /** sessionId -> toolUseId -> WatcherEntry. One watcher per (session,
   *  toolUseId); a duplicate launch ack (replay, re-broadcast) must not stack
   *  a second poller on the same transcript. */
  private watchers = new Map<string, Map<string, WatcherEntry>>()

  constructor(private deps: BackgroundWatcherRegistryDeps) {}

  /** Number of background subagents currently being watched for a session.
   *  Feeds `SessionInfo.backgroundSubagentCount` (sidebar 'waiting' dot) and
   *  `phaseOf`'s working-vs-idle check. */
  count(sessionId: string): number {
    return this.watchers.get(sessionId)?.size ?? 0
  }

  /** Begin polling a background subagent's own transcript for completion.
   *  Called by the pump when it sees an async launch ack. On completion,
   *  synthesizes a `system`/`task_notification` frame (the CLI doesn't emit
   *  one reliably) and feeds it back through the normal broadcast path so
   *  the client reducer's completion branch flips the `background` record to
   *  `done` with the subagent's real output. */
  start(session: Session, toolUseId: string, agentId: string): void {
    const sessionId = session.id
    // One watcher per (session, toolUseId). A duplicate launch ack (replay,
    // re-broadcast) must not stack a second poller on the same transcript.
    let perSession = this.watchers.get(sessionId)
    if (!perSession) {
      perSession = new Map()
      this.watchers.set(sessionId, perSession)
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
        if (this.deps.isLive(session.id)) {
          this.deps.broadcastGlobal({ kind: 'update', session: this.deps.info(session) })
        }
        this.broadcastSynthesizedTaskNotification(session, toolUseId, agentId, completion)
      },
    })
    perSession.set(toolUseId, { stop, agentId })
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
    if (this.deps.isLive(session.id)) {
      this.deps.broadcastGlobal({ kind: 'update', session: this.deps.info(session) })
    }
  }

  /** Cancel the subagent watcher for a (session, toolUseId) when a REAL SDK
   *  task_notification arrives for the same tool call — the true completion
   *  already carries the result, so the watcher's synthesized notification
   *  would be a duplicate (and its maxMs backstop could later flip a
   *  legitimately-done record back to 'stopped'). No-op when no watcher is
   *  armed. `session` may be undefined (the pump's caller looks it up by id
   *  and may find it already unloaded) — the stop() still fires, but task-
   *  cleanup and the re-broadcast are skipped, mirroring the pre-extraction
   *  behaviour. */
  cancel(sessionId: string, toolUseId: string, session: Session | undefined): void {
    const perSession = this.watchers.get(sessionId)
    const entry = perSession?.get(toolUseId)
    if (!entry) return
    try { entry.stop() } catch { /* ignore */ }
    perSession!.delete(toolUseId)
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
      this.deps.broadcastGlobal({ kind: 'update', session: this.deps.info(session) })
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
    if (!this.deps.isLive(session.id)) return
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
    pushBounded(session.history, msg, this.deps.historyCap)
    for (const sub of session.subscribers.values()) {
      try { sub.push(msg) } catch { /* subscriber dead — skip */ }
    }
    // Fold the same notification into the task-state cache so the seeded
    // watcher record settles to a terminal status in the TasksPanel. The
    // synthesized frame never passes through the pump (it bypasses the SDK
    // stream), so the normal fold path doesn't see it — fold it here.
    this.deps.applyTaskEvent(session, msg)
  }

  /** Stop all background-subagent watchers for a session (called on unload
   *  so a late completion can't broadcast into a dead session). */
  stopAll(sessionId: string): void {
    const perSession = this.watchers.get(sessionId)
    if (!perSession) return
    for (const entry of perSession.values()) {
      try { entry.stop() } catch { /* ignore */ }
    }
    perSession.clear()
    this.watchers.delete(sessionId)
  }

  /** Settle every armed watcher for a session because its CLI subprocess just
   *  exited (crash / kill / unexpected exit — detected by ProcessMonitor in
   *  ms). This is the CERTAIN completion signal the transcript-poll fallback
   *  otherwise lacks: a background subagent runs INSIDE the parent CLI
   *  subprocess, so once that process is gone the subagent can never write
   *  another transcript line — waiting out the 2 h maxMs backstop would strand
   *  its chip for hours. We resolve each watcher immediately instead:
   *
   *    1. If the subagent's transcript already holds a terminal `stop_reason`
   *       (it finished right before the crash), honour it — status `completed`
   *       with the real final text.
   *    2. Otherwise synthesize `stopped` (the subagent died mid-work with the
   *       host process).
   *
   *  Both funnel through the same broadcast path as a normal completion, so
   *  the client reducer flips the `background`/`pending` record to done /
   *  interrupted. Called BEFORE the crash-recovery ladder or termination runs,
   *  while the session is still live in the map, so the synthesized frame
   *  reaches subscribers. A subsequent in-place recovery that re-sees the
   *  launch ack simply re-arms a fresh watcher (per-toolUseId dedup makes that
   *  safe), and a late real completion still overrides an over-eager `stopped`
   *  (the reducer accepts a later terminal frame). No-op when the session has
   *  no armed watchers. */
  settleAllOnProcessExit(session: Session): void {
    const perSession = this.watchers.get(session.id)
    if (!perSession || perSession.size === 0) return
    // Snapshot entries first: broadcastSynthesizedTaskNotification →
    // applyTaskEvent mutates session.tasks, and we delete from perSession as
    // we go, so iterate a copy to avoid mutating-while-iterating.
    const entries = Array.from(perSession.entries())
    for (const [toolUseId, entry] of entries) {
      try { entry.stop() } catch { /* ignore */ }
      perSession.delete(toolUseId)
      // Path 1: the subagent may have finished a terminal frame just before
      // the crash — prefer its real output over a synthesized `stopped`.
      const completion: SubagentCompletion = (session.cwd
        ? readSubagentCompletion(subagentTranscriptPath(session.cwd, session.id, entry.agentId))
        : null) ?? { status: 'stopped', summary: '' }
      log.info(
        `[${session.id}] settling background subagent agentId=${entry.agentId} ` +
        `toolUseId=${toolUseId} on process exit (status=${completion.status})`,
      )
      this.broadcastSynthesizedTaskNotification(session, toolUseId, entry.agentId, completion)
    }
    // The map for this session is now empty; drop it so count() reads 0.
    this.watchers.delete(session.id)
    // Refresh the sidebar dot (waiting → whatever the exit path lands on).
    if (this.deps.isLive(session.id)) {
      this.deps.broadcastGlobal({ kind: 'update', session: this.deps.info(session) })
    }
  }
}
