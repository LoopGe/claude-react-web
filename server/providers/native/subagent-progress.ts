// server/providers/native/subagent-progress.ts
//
// Per-subagent live progress tracker (native task-panel parity, design §B).
// Observes the nested run's frames and emits neutral `task/progress` on a
// ~30 s cadence: a mechanical frame (usage triple + lastToolName) every tick,
// plus a model-generated one-line `summary` produced by FORKING the subagent's
// own conversation — same model, same wire tools, same projected prefix, so
// the prompt cache reads cheap (the CLI's strategy; runSuggestion in
// native-session.ts is the direct in-repo precedent).
//
// NEUTRAL CORE: imports only the vocabulary, the wire adapter, sibling core
// types, neutral shared/* and generic infra (log/metrics). No SDK, no host
// adapter, no host-domain services (the neutrality + host-free pins cover it).
import type { RequestMessage } from './vocabulary/message.js'
import type { OperationalFrame } from './vocabulary/live-frame.js'
import type { NativeLoopFrame } from './loop.js'
import type { AgentToolDeps } from './subagent.js'
import type { ToolDef } from './tools/types.js'
import type { NativeProjectionOptions } from './attachment-projection.js'
import { projectNativeHistoryToWire } from './wire/wire-projection.js'
import { supportsThinkingForModel } from '../../../shared/model-capability.js'
import { createLogger } from '../../log.js'
import { metrics } from '../../metrics.js'

const log = createLogger('native-progress')

/** The CLI's progress cadence (sdk.d.ts:2121). */
export const PROGRESS_INTERVAL_MS = 30_000

/** A one-line summary needs tens of tokens, not the session default 16384. */
export const PROGRESS_MAX_TOKENS = 64

/** The fixed fork-tail prompt asking for the one-line status. */
export const PROGRESS_SUMMARY_PROMPT = `[PROGRESS SUMMARY: Describe what you are doing right now, for a one-line status display.]

Look at the conversation so far — especially the most recent tool calls and any tool still running.

Reply with ONLY one short present-tense line (at most 100 characters), e.g. "Reading the authentication module" or "Running the test suite". No quotes, no trailing period, no explanation, no second line.`

/** Normalize a raw fork output to the one-line summary: trim → first line →
 *  trim → cap to 100 chars on a code-point boundary → null if empty. Pure. */
export function normalizeProgressSummary(raw: string): string | null {
  const firstLine = raw.trim().split('\n')[0].trim()
  if (firstLine === '') return null
  const points = [...firstLine]
  return points.length <= 100 ? firstLine : points.slice(0, 100).join('')
}

/** Build the fork's ONE user tail message against a mid-run snapshot.
 *  runTurn pushes the assistant message BEFORE executing its tools and the
 *  matching tool results only AFTER they finish, so a snapshot taken during
 *  tool execution ends in an assistant message whose tool calls have no
 *  results yet — the API rejects a following user message that omits them.
 *  Synthesize a placeholder `tool_result` for every trailing unmatched call
 *  (ephemeral fork-tail content: never persisted, never fed back), then the
 *  summary prompt. A snapshot ending in complete tool results (or plain user
 *  text) gets the prompt-only tail — consecutive user messages are API-legal. */
function forkTail(snapshot: readonly RequestMessage[]): { role: 'user'; content: unknown[] } {
  // Walk back over the trailing first-class tool results, collecting the calls
  // they answer; the first non-tool message is the snapshot's real tail.
  const answered = new Set<string>()
  let i = snapshot.length - 1
  while (i >= 0) {
    const message = snapshot[i]
    if (message.role !== 'tool') break
    answered.add(message.toolCallId)
    i--
  }
  const content: unknown[] = []
  const last = snapshot[i]
  if (last !== undefined && last.role === 'assistant') {
    for (const block of last.content) {
      if (block.type === 'tool-call' && !answered.has(block.id)) {
        content.push({ type: 'tool_result', tool_use_id: block.id, content: '(tool still running)' })
      }
    }
  }
  content.push({ type: 'text', text: PROGRESS_SUMMARY_PROMPT })
  return { role: 'user', content }
}

/** The fork overrides the widened nested-stream seam forwards (Task 2):
 *  a breakpoint-free tail, a small output cap, stripped effort/fast-mode, and
 *  the model-gated thinking-disabled config. `AgentToolDeps['streamFor']`'s
 *  request type widens to match in the wiring task; until then the overrides
 *  ride the request structurally (the session seam already reads them). */
type ProgressForkRequest = Parameters<AgentToolDeps['streamFor']>[0] & {
  appendMessages?: unknown[]
  maxTokens?: number
  forkProfile?: boolean
  thinking?: { type: 'disabled' }
}

export interface SubagentProgressDeps {
  taskId: string
  toolUseId: string
  description: string
  subagentType?: string
  /** Gates ONLY the summary fork; the mechanical frame is always on. */
  enabled: boolean
  /** The subagent's LIVE nested history — read (and sliced) per fork. */
  history: () => readonly RequestMessage[]
  model: string
  system: string
  tools: ToolDef[]
  streamFor: AgentToolDeps['streamFor']
  attachmentProjection: NativeProjectionOptions
  emit: (frame: OperationalFrame, parentToolUseId: string | null) => void
  parentToolUseId: string | null
  /** The subagent's run signal: its abort cancels any in-flight fork. */
  signal: AbortSignal
}

export class SubagentProgress {
  private readonly deps: SubagentProgressDeps
  private toolUses = 0
  private lastToolName: string | undefined
  private totalTokens = 0
  private startedAt = 0
  private materialSinceLastFork = false
  private inFlight: AbortController | null = null
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(deps: SubagentProgressDeps) {
    this.deps = deps
  }

  /** Fold one nested-run frame into the mechanical counters. Only assistant
   *  frames carry material (text / tool calls / usage); everything else passes
   *  through untouched. */
  observe(frame: NativeLoopFrame): void {
    if (!('type' in frame) || frame.type !== 'assistant-frame') return
    for (const block of frame.message.content) {
      if (block.type === 'tool-call') {
        this.toolUses++
        this.lastToolName = block.name
        this.materialSinceLastFork = true
      } else if (block.type === 'text') {
        this.materialSinceLastFork = true
      }
    }
    const usage = frame.usage
    this.totalTokens += usage.inputTokens + usage.outputTokens
      + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  }

  /** Arm the cadence. The timer is unref'd so it never holds the process. */
  start(): void {
    this.startedAt = Date.now()
    this.timer = setInterval(() => this.tick(), PROGRESS_INTERVAL_MS)
    this.timer.unref()
  }

  /** Clear the timer and abort any in-flight fork. The fork's own catch sees
   *  the abort and stays silent; its finally releases the in-flight slot. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.inFlight?.abort()
  }

  /** One cadence tick: the mechanical frame always emits (unless the run is
   *  aborted); the summary fork is gated on option / material / one-in-flight. */
  private tick(): void {
    if (this.deps.signal.aborted) return
    this.emitProgress()
    metrics.count('native_task_progress_total', { outcome: 'mechanical' })
    if (!this.deps.enabled) {
      metrics.count('native_task_progress_total', { outcome: 'suppressed', reason: 'disabled' })
      return
    }
    if (!this.materialSinceLastFork) {
      metrics.count('native_task_progress_total', { outcome: 'suppressed', reason: 'no_material' })
      return
    }
    if (this.inFlight !== null) {
      metrics.count('native_task_progress_total', { outcome: 'suppressed', reason: 'in_flight' })
      return
    }
    // Reset only when a fork actually starts — a skipped tick keeps the flag
    // so the next eligible tick still sees the material.
    this.materialSinceLastFork = false
    const abort = new AbortController()
    this.inFlight = abort
    // runFork owns its failure contract (never rejects), so this fire-and-forget
    // assignment can never produce an unhandled rejection.
    void this.runFork(abort)
  }

  /** The summary fork: snapshot the live nested history, project it to the
   *  subagent's own wire prefix, append ONE breakpoint-free user tail (synthetic
   *  results for any trailing unmatched tool call + the summary prompt), stream
   *  ONE round, and emit at most one normalized summary frame. Reads only the
   *  snapshot — never mutates the nested history — and never throws into the
   *  subagent (the runSuggestion failure contract). */
  private async runFork(abort: AbortController): Promise<void> {
    const signal = abort.signal
    // The subagent's own interrupt cancels the fork (design §B lifecycle).
    const onParentAbort = () => abort.abort()
    this.deps.signal.addEventListener('abort', onParentAbort, { once: true })
    try {
      // Slice: runTurn keeps appending concurrently; the sent prefix must be
      // the snapshot, not a moving target.
      const snapshot = this.deps.history().slice()
      const prefix = await projectNativeHistoryToWire(snapshot, this.deps.attachmentProjection, signal)
      if (signal.aborted) return
      const req: ProgressForkRequest = {
        model: this.deps.model,
        system: this.deps.system,
        // IDENTICAL to the loop's per-round projection (loop.ts:208) so the
        // fork's tools prefix matches the subagent's cached rounds.
        tools: this.deps.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema })),
        messages: prefix,
        appendMessages: [forkTail(snapshot)],
        maxTokens: PROGRESS_MAX_TOKENS,
        forkProfile: true,
        signal,
        // Same model gate as runSuggestion: a non-thinking model/gateway must
        // not receive an unexpected thinking field. Always-on-thinking models
        // whose ids match the classifier 400 here — contained by the silent
        // failure contract below (the inherited runSuggestion limitation).
        ...(supportsThinkingForModel(this.deps.model) === true ? { thinking: { type: 'disabled' as const } } : {}),
      }
      // Collect text by block index; reasoning/tool deltas are ignored (the
      // fork never executes tools — single round, text only).
      const textByIndex = new Map<number, string>()
      for await (const ev of this.deps.streamFor(req, { suppressRetryFrames: true })) {
        if (signal.aborted) return
        if (ev.kind === 'block_start' && ev.block.type === 'text') textByIndex.set(ev.index, '')
        else if (ev.kind === 'block_delta' && ev.delta.type === 'text' && textByIndex.has(ev.index)) {
          textByIndex.set(ev.index, textByIndex.get(ev.index)! + ev.delta.text)
        }
      }
      if (signal.aborted) return
      // First non-null normalized candidate in block order.
      let summary: string | null = null
      for (const index of [...textByIndex.keys()].sort((a, b) => a - b)) {
        summary = normalizeProgressSummary(textByIndex.get(index)!)
        if (summary !== null) break
      }
      if (summary === null) {
        metrics.count('native_task_progress_total', { outcome: 'suppressed', reason: 'empty' })
        return
      }
      this.emitProgress(summary)
      metrics.count('native_task_progress_total', { outcome: 'generated' })
    } catch (err) {
      if (signal.aborted) return // aborted → silent
      log.debug(`[${this.deps.taskId}] progress summary failed:`, err)
      metrics.count('native_task_progress_total', { outcome: 'failed', reason: 'error' })
    } finally {
      this.deps.signal.removeEventListener('abort', onParentAbort)
      // Clear only if this fork still owns the slot.
      if (this.inFlight === abort) this.inFlight = null
    }
  }

  /** Emit one `task/progress` frame: the mechanical facts, plus the summary
   *  on the fork-result frame. Envelope-less (task frames carry no session
   *  identity); `time` is the ms-epoch fact the host reads as receivedAt. */
  private emitProgress(summary?: string): void {
    const now = Date.now()
    this.deps.emit({
      type: 'task/progress',
      taskId: this.deps.taskId,
      toolUseId: this.deps.toolUseId,
      description: this.deps.description,
      ...(this.deps.subagentType !== undefined ? { subagentType: this.deps.subagentType } : {}),
      usage: {
        totalTokens: this.totalTokens,
        toolUses: this.toolUses,
        durationMs: now - this.startedAt,
      },
      ...(this.lastToolName !== undefined ? { lastToolName: this.lastToolName } : {}),
      ...(summary !== undefined ? { summary } : {}),
      time: now,
    }, this.deps.parentToolUseId)
  }
}