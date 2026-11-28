// server/providers/native/tools/types.ts
import type { NativeFileAttachment } from '../../../../shared/attachment-types.js'
import type { FileBlock, ImageRefBlock, TextBlock } from '../vocabulary/types.js'

export class ToolInputError extends Error {}

/** Map a stat failure onto a tool error: a missing target is the model's input
 *  error, everything else keeps the OS message (EACCES, ELOOP, ENOTDIR, ...). */
export function statError(err: unknown, missingMessage: string): ToolInputError {
  const e = err as NodeJS.ErrnoException
  return new ToolInputError(e.code === 'ENOENT' ? missingMessage : e.message)
}

export interface ToolContext {
  cwd: string
  signal: AbortSignal
  /** Actual model-history partition: `main` or the spawning Agent tool-use id.
   * Used by tools whose allocations must not cross sidechain boundaries. */
  historyKey?: string
  /** The `tool_use` id of the call being executed. Lets a tool anchor nested
   *  (sidechain) frames to itself. */
  toolUseId?: string
  /** Extra path-containment roots beyond the cwd, for the auto-memory store
   *  (which lives outside the session working directory). `write` widens the
   *  Write/Edit write-target allowance; `read` widens the Read allowance. They
   *  only widen the allowed set — the Edit/Read realpath escape check still
   *  applies to every root. Absent means cwd-only containment. */
  memoryRoots?: { write: readonly string[]; read: readonly string[] }
}

/** A neutral file occurrence in a tool result: a vocabulary FileBlock whose
 *  attachment keeps the FULL resolved registry facts (path / mediaType /
 *  modelForm) — a structural superset of the public FileAttachmentRef — so the
 *  wire adapter can still project it to handle text or a PDF document on every
 *  later API round. */
export interface ToolFileBlock extends FileBlock {
  attachment: NativeFileAttachment
}

export interface ToolOutcome {
  /** Text-only UI summary. Structured content, when present, is the canonical
   * model/log result and normally starts with the same summary TextBlock. */
  text: string
  /** Neutral vocabulary content — text blocks plus file / image occurrences.
   *  The loop wraps it into createToolResultMessage unchanged; no SDK
   *  tool_result shape is built here. */
  content?: Array<TextBlock | ToolFileBlock | ImageRefBlock>
  isError?: boolean
}

export interface ToolDef<In = Record<string, unknown>> {
  name: string
  description: string
  /** One DSH-style guidance sentence registered as a prompt section. */
  guidance: string
  promptOrder: number
  schema: Record<string, unknown>
  /** Explicit tool-level read-only metadata; absent is always false. */
  readOnlyHint?: boolean
  backgroundable?: {
    taskType: 'shell' | 'subagent' | 'monitor'
    describe(input: In): string
    subagentType?(input: In): string | undefined
    /** Model-initiated backgrounding: when true, the loop detaches the call
     *  immediately after launch (the tool_result is the TaskOutput launch
     *  acknowledgement, not the run's output). Absent = host-detach only. */
    shouldBackground?(input: In): boolean
    /** The detach acknowledgement text, for a tool whose CLIENT surface parses
     *  it (Monitor: MonitorBar reads the task id out of the CLI's
     *  "Monitor started (task <id>, …)" sentence). Omitted = the manager's
     *  generic TaskOutput pointer. Called after `validate`, before `run`. */
    launchAcknowledgement?(input: In, taskId: string): string
  }
  /** Optional pre-execution input validation. The loop calls this BEFORE
   *  registering a backgroundable task or running the tool, so malformed input
   *  throws ToolInputError as a clean error tool result — never a backgrounded
   *  record whose describe()/completion would read undefined fields. */
  validate?(input: In): void
  run(input: In, ctx: ToolContext): Promise<ToolOutcome>
}
