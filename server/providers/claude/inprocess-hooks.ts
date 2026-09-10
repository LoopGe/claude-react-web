import { randomUUID } from 'node:crypto'
import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk'
import type { HookEvent, HookRuntimeEvent } from '../../../shared/hooks.js'

/** Called by an in-process read+react callback to surface structured input
 *  into the existing hook run-log channel. Fire-and-forget; never blocks. */
export type InProcessHookForward = (sessionId: string, event: HookRuntimeEvent) => void

/** Called with the authoritative in-flight background-task list the CLI
 *  attaches to the Stop hook input (SDK `StopHookInput.background_tasks`).
 *  Fire-and-forget; the host reconciles its own task map. An EMPTY array is
 *  meaningful ("nothing is in flight") and is forwarded — only a missing /
 *  wrong-typed field is skipped. */
export type InProcessTaskSnapshot = (
  sessionId: string,
  tasks: Array<{ id: string; status?: string }>,
) => void

/** Called when the CLI's `SubagentStop` hook fires — the authoritative,
 *  earliest completion edge for one subagent (probe-verified to arrive BEFORE
 *  the CLI's own task_updated / task_notification frames). `transcriptPath` is
 *  the hook's `agent_transcript_path`, which spares the host from
 *  reconstructing the CLI's on-disk layout. Fire-and-forget. */
export type InProcessSubagentStop = (
  sessionId: string,
  info: { agentId: string; transcriptPath?: string; lastAssistantMessage?: string },
) => void

const DEFAULT_CAP = 4096

/** Truncate a serialized input, keeping the head and appending a marker. */
export function capHookInput(s: string, max: number = DEFAULT_CAP): string {
  if (s.length <= max) return s
  const keep = Math.max(0, max - 20)
  return `${s.slice(0, keep)}…[truncated ${s.length - keep} chars]`.slice(0, max)
}

/** Wrap a callback so a throw/slow inner never crashes the host query() process. */
function defensiveHook(fn: (input: unknown) => void): (input: unknown, toolUseID: string | undefined, deps?: { signal?: AbortSignal }) => Promise<unknown> {
  return async (input: unknown, _toolUseID?: string, deps?: { signal?: AbortSignal }): Promise<unknown> => {
    if (deps?.signal?.aborted) return undefined
    try {
      fn(input)
    } catch {
      // In-process hook observed input; a malformed/throwy input must not crash the pump.
    }
    return undefined
  }
}

/** Narrow `StopHookInput.background_tasks` (SDK `BackgroundTaskSummary[]`) to
 *  the fields the host reconciliation consumes. Returns null when the field is
 *  absent or not an array — distinct from `[]`, which is the CLI positively
 *  reporting an empty in-flight set. Entries without a string `id` are
 *  dropped (defensive: the wire shape can gain fields without a bump). */
export function parseHookBackgroundTasks(input: unknown): Array<{ id: string; status?: string }> | null {
  const raw = (input as { background_tasks?: unknown } | null | undefined)?.background_tasks
  if (!Array.isArray(raw)) return null
  const out: Array<{ id: string; status?: string }> = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as { id?: unknown; status?: unknown }
    if (typeof e.id !== 'string' || e.id === '') continue
    out.push(typeof e.status === 'string' ? { id: e.id, status: e.status } : { id: e.id })
  }
  return out
}

/** Narrow a `SubagentStop` hook input to the completion edge we act on.
 *  Returns null without a usable `agent_id` (nothing can be matched to a
 *  watcher without it). `agent_transcript_path` / `last_assistant_message` are
 *  optional — the settle path degrades to an empty summary rather than failing. */
export function parseSubagentStopInput(input: unknown): {
  sessionId: string
  agentId: string
  transcriptPath?: string
  lastAssistantMessage?: string
} | null {
  if (!input || typeof input !== 'object') return null
  const o = input as Record<string, unknown>
  if (typeof o.session_id !== 'string' || o.session_id === '') return null
  if (typeof o.agent_id !== 'string' || o.agent_id === '') return null
  return {
    sessionId: o.session_id,
    agentId: o.agent_id,
    ...(typeof o.agent_transcript_path === 'string' && o.agent_transcript_path
      ? { transcriptPath: o.agent_transcript_path }
      : {}),
    ...(typeof o.last_assistant_message === 'string' && o.last_assistant_message
      ? { lastAssistantMessage: o.last_assistant_message }
      : {}),
  }
}

function buildSubagentStop(onSubagentStop: InProcessSubagentStop): (input: unknown) => void {
  return (input) => {
    const parsed = parseSubagentStopInput(input)
    if (!parsed) return
    onSubagentStop(parsed.sessionId, {
      agentId: parsed.agentId,
      transcriptPath: parsed.transcriptPath,
      lastAssistantMessage: parsed.lastAssistantMessage,
    })
  }
}

function buildStop(
  forward?: InProcessHookForward,
  onTaskSnapshot?: InProcessTaskSnapshot,
): (input: unknown) => void {
  return (input) => {
    const obj = (input ?? {}) as { session_id?: unknown; transcript_path?: unknown; reason?: unknown }
    if (typeof obj.session_id !== 'string') return
    // Task reconciliation runs before (and independently of) the run-log
    // forward: the snapshot is the payload we actually act on, and it must not
    // be skipped just because no run-log forward was wired.
    if (onTaskSnapshot) {
      const tasks = parseHookBackgroundTasks(input)
      if (tasks) onTaskSnapshot(obj.session_id, tasks)
    }
    if (!forward) return
    const detail: Record<string, unknown> = {}
    if (typeof obj.transcript_path === 'string') detail.transcript_path = obj.transcript_path
    if (typeof obj.reason === 'string') detail.reason = obj.reason
    const id = randomUUID()
    const run = {
      id,
      hookId: id,
      hookName: 'inproc:Stop',
      event: 'Stop',
      status: 'success' as const,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      ...(Object.keys(detail).length > 0 ? { hookInput: capHookInput(JSON.stringify(detail)) } : {}),
    }
    forward(obj.session_id, { kind: 'completed', run })
  }
}

/** Build the in-process read+react hooks object the provider injects into
 *  `Options.hooks`. SessionEnd/Notification do not fire in this SDK/CLI/Ark
 *  stack (probe-verified) and tool governance is intentionally absent
 *  (probe-disproven), so only two events are registered (`SubagentStart` also
 *  fires but carries nothing we act on — no background_tasks, no transcript):
 *
 *  - `Stop` — carries `transcript_path` for the run log, plus
 *    `background_tasks`, the authoritative in-flight task list at turn end
 *    (routed to `onTaskSnapshot`). Fires once per turn, but ONLY while the
 *    session's input iterable stays open: a generator that completes closes the
 *    CLI's stdin and that turn's Stop is skipped (probe-verified).
 *  - `SubagentStop` — carries `agent_id` + `agent_transcript_path`, the
 *    earliest authoritative completion edge for a background subagent (arrives
 *    before the CLI's own task_notification), routed to `onSubagentStop`. */
export function buildInProcessHooks(
  forward?: InProcessHookForward,
  onTaskSnapshot?: InProcessTaskSnapshot,
  onSubagentStop?: InProcessSubagentStop,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  return {
    Stop: [{ hooks: [defensiveHook(buildStop(forward, onTaskSnapshot))] }],
    ...(onSubagentStop
      ? { SubagentStop: [{ hooks: [defensiveHook(buildSubagentStop(onSubagentStop))] }] }
      : {}),
  } as Partial<Record<HookEvent, HookCallbackMatcher[]>>
}