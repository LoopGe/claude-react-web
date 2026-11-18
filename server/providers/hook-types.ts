// server/providers/hook-types.ts
//
// Neutral in-process hook contract shared by the provider seam and the host.
// Imports nothing provider-specific.

import type { HookRuntimeEvent } from '../../shared/hooks.js'

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
 *  reconstructing the CLI's on-disk layout. Fire-and-forget.
 *
 *  `backgroundTasks` is the hook input's `background_tasks` (SDK
 *  `SubagentStopHookInput.background_tasks`), the CLI's documented
 *  discriminator between "subagent is done" and "subagent paused, waiting for
 *  its own background work to wake it" ("Empty array when nothing is in
 *  flight"). `undefined` means the field was absent (older CLI) — "unknown",
 *  NOT "empty"; the settle path keeps its legacy behaviour there. */
export type InProcessSubagentStop = (
  sessionId: string,
  info: {
    agentId: string
    transcriptPath?: string
    lastAssistantMessage?: string
    backgroundTasks?: Array<{ id: string; status?: string }>
  },
) => void
