// server/providers/native/tools/types.ts
import type { NativeFileBlock } from '../session-log/format.js'

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
}

export interface ToolOutcome {
  /** Text-only UI summary. Structured content, when present, is the canonical
   * model/log result and normally starts with the same summary TextBlock. */
  text: string
  content?: Array<{ type: 'text'; text: string } | NativeFileBlock>
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
    taskType: 'shell' | 'subagent'
    describe(input: In): string
    subagentType?(input: In): string | undefined
  }
  run(input: In, ctx: ToolContext): Promise<ToolOutcome>
}
