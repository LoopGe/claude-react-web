// server/providers/native/hooks/transcript.ts
// T22: the hook transcript projection (design §3 builder-check Q5, RS §3/§6.1/
// §6.2). Native's durable log is neutral v3, NOT CLI JSONL — passing v3 (or an
// empty path) would change hook verdicts vs claude. This module materializes a
// CLI-shaped JSONL artifact (neutral events → SDK RawLines → JSONL) at a stable
// per-session path for hook stdin `transcript_path` and the agent evaluator's
// Read, and builds the budget-truncated conversation transcript the prompt
// evaluator receives before its verdict question.
//
// NEUTRALITY: the neutral→SDK-line translation is HOST-side
// (projectNativeEventToSdkLine in native-host-frame-adapter.ts). The core never
// imports that adapter; the translation arrives as an injected projection
// function (the session passes ports.transcript.projectEventToSdkLine, whose
// host implementation delegates to the seam). This module owns only the neutral
// facts — the event list, the path, the JSONL write, the message budget — so it
// stays inside the core neutrality pin (no SDK / host frame vocabulary).
//
// The artifact is a READ-ONLY projection: the durable log stays neutral v3 and
// is never mutated here. Materialization is incremental — the log is append-only
// in the live course (compact appends a boundary; a failed append rolls back its
// own tail), so the common case projects and appends only the new suffix. A
// shrink or a changed boundary identity (rollback / migration rewrite) triggers
// a full atomic rebuild (temp + rename), the cache.ts append-parse precedent.
import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createLogger } from '../../../log.js'
import { isSafeSessionId, type RawLine } from '../../../../shared/transcript-format.js'
import { nativeSessionDir } from '../session-log/paths.js'
import { estimateMessage } from '../estimate.js'
import type { NativeSessionEvent } from '../vocabulary/session-event.js'
import type { RequestMessage } from '../vocabulary/message.js'
import type { TokenUsage } from '../vocabulary/types.js'

const log = createLogger('native-hooks')

/** The injected neutral→SDK-line projection (the host history-read seam). */
export type TranscriptProjection = (event: NativeSessionEvent, sessionId: string) => RawLine | null

/** Stable per-session CLI-JSONL artifact path, beside the durable log inside
 *  the session dir (so session deletion removes it with the log). */
export function transcriptArtifactPath(stateDir: string, sessionId: string): string {
  return join(nativeSessionDir(stateDir, sessionId), 'transcript.jsonl')
}

/** Stable per-(session, agent) sidechain artifact path for SubagentStop's
 *  `agent_transcript_path` (RS §3). The agent id is a tool_use id; it is validated
 *  as a path segment exactly like the session id. */
export function sidechainTranscriptArtifactPath(stateDir: string, sessionId: string, agentId: string): string {
  if (!isSafeSessionId(agentId)) throw new Error(`Invalid agent id for transcript artifact: ${agentId}`)
  return join(nativeSessionDir(stateDir, sessionId), `transcript-${agentId}.jsonl`)
}

/** Materializes one CLI-JSONL transcript artifact from the neutral event list.
 *  One instance owns one artifact path (the session holds the main one; a
 *  sidechain artifact gets its own). Calls are serialized so concurrent hook
 *  dispatches (parallel subagents) cannot interleave appends/rebuilds. */
export class TranscriptMaterializer {
  private initialized = false
  private count = 0
  private boundary: NativeSessionEvent | null = null
  private tail: Promise<unknown> = Promise.resolve()

  constructor(private readonly opts: {
    path: string
    sessionId: string
    project: TranscriptProjection
  }) {}

  /** Project the current events to the artifact and return its stable path. */
  materialize(events: readonly NativeSessionEvent[]): Promise<string> {
    const run = this.tail.then(() => this.write(events))
    // Keep the chain alive regardless of outcome; a failed write surfaces to
    // THIS caller (the dispatch seam degrades transcript_path to ''), never
    // poisoning the next call.
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }

  private async write(events: readonly NativeSessionEvent[]): Promise<string> {
    // Snapshot the end index + boundary ONCE, before any await: `events` is the
    // log's LIVE mutable array (neutral-read returns it by reference), so an
    // event appended during the IO below must not advance `count` past what was
    // actually projected — that would permanently drop the in-flight events.
    const end = events.length
    const boundary = end > 0 ? events[end - 1] : null
    const prefixIntact = this.count === 0 || events[this.count - 1] === this.boundary
    if (this.initialized && end === this.count && prefixIntact) return this.opts.path
    if (this.initialized && end > this.count && prefixIntact) {
      const suffix = this.projectSlice(events, this.count, end)
      if (suffix !== '') {
        try {
          await appendFile(this.opts.path, suffix)
        } catch (err) {
          // A torn append leaves a corrupt trailing line; invalidate so the next
          // call takes the atomic rebuild path instead of appending after it.
          this.initialized = false
          throw err
        }
      }
    } else {
      // First materialize, shrink, boundary mismatch, or post-torn rebuild →
      // full atomic rebuild.
      const body = this.projectSlice(events, 0, end)
      await mkdir(dirname(this.opts.path), { recursive: true })
      const tmp = `${this.opts.path}.tmp`
      await writeFile(tmp, body)
      await rename(tmp, this.opts.path)
    }
    this.initialized = true
    this.count = end
    this.boundary = boundary
    return this.opts.path
  }

  /** JSONL for events[from..to); non-message events project to null and drop. */
  private projectSlice(events: readonly NativeSessionEvent[], from: number, to: number): string {
    let out = ''
    for (let i = from; i < to; i++) {
      const line = this.opts.project(events[i], this.opts.sessionId)
      if (line !== null) out += JSON.stringify(line) + '\n'
    }
    return out
  }
}

// ── Prompt evaluator transcript budget (RS §6.1, CLI kTr) ───────────────────
// The CLI prepends the conversation transcript before the verdict question,
// truncated to half the evaluator model's context window (1M for a [1m] model,
// else 200K), keeping the TAIL. A real last-round usage reading that fits is the
// fast path (CLI yTr); otherwise rounds are estimated and kept from the tail.
// The truncation marker text is binary-extracted verbatim from the pinned CLI.

const HOOK_TRANSCRIPT_BUDGET_RATIO = 0.5
const DEFAULT_HOOK_WINDOW = 200_000
const LARGE_HOOK_WINDOW = 1_000_000

function truncationMarker(dropped: number): string {
  return `[Earlier conversation truncated to fit the hook evaluator's context window — ${dropped} earlier messages omitted. Evaluate the condition against the recent transcript below; if the required evidence may be in the omitted prefix, return {"ok": false, "reason": "insufficient evidence in transcript"}.]`
}

/** The conversation transcript a prompt evaluator receives before its question:
 *  the live model history, budget-truncated to the tail (whole assistant rounds
 *  kept so a tool_use is never split from its tool_result), with the CLI marker
 *  prepended when a prefix is dropped. `lastUsage` is the last main-thread API
 *  reading (the CLI yTr fast path); null forces the estimate path. */
export function hookTranscriptMessages(
  history: readonly RequestMessage[],
  model: string,
  lastUsage: TokenUsage | null,
): RequestMessage[] {
  const window = /\[1m\]/i.test(model) ? LARGE_HOOK_WINDOW : DEFAULT_HOOK_WINDOW
  const budget = Math.floor(window * HOOK_TRANSCRIPT_BUDGET_RATIO)
  if (lastUsage !== null) {
    const total = lastUsage.inputTokens + lastUsage.outputTokens
      + (lastUsage.cacheReadTokens ?? 0) + (lastUsage.cacheWriteTokens ?? 0)
    if (total <= budget) return [...history]
  }
  // Group into rounds: each assistant message opens a new group; user/tool
  // messages attach to the open one (CLI Wq). Keeping whole groups from the
  // tail never splits a tool_use from its result.
  const groups: RequestMessage[][] = []
  for (const message of history) {
    if (message.role === 'assistant' || groups.length === 0) groups.push([message])
    else groups[groups.length - 1].push(message)
  }
  let kept = 0
  let sum = 0
  for (let i = groups.length - 1; i >= 0; i--) {
    const cost = groups[i].reduce((acc, m) => acc + estimateMessage(m), 0)
    // The last group is always kept even if it alone exceeds the budget (CLI
    // `w < y.length` guard); a later group that would overflow stops the scan.
    if (kept > 0 && sum + cost > budget) break
    sum += cost
    kept++
  }
  const keptMessages = groups.slice(groups.length - kept).flat()
  const dropped = history.length - keptMessages.length
  if (dropped <= 0) return [...history]
  log.debug(`prompt hook transcript truncated ${history.length}→${keptMessages.length} msgs (budget ${budget}, model ${model})`)
  const marker: RequestMessage = { role: 'user', content: [{ type: 'text', text: truncationMarker(dropped) }] }
  return [marker, ...keptMessages]
}
