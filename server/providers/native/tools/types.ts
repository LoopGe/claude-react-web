// server/providers/native/tools/types.ts
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
  /** The `tool_use` id of the call being executed. Lets a tool anchor nested
   *  (sidechain) frames to itself. */
  toolUseId?: string
}

export interface ToolOutcome {
  text: string
  isError?: boolean
}

export interface ToolDef<In = Record<string, unknown>> {
  name: string
  description: string
  /** One DSH-style guidance sentence registered as a prompt section. */
  guidance: string
  promptOrder: number
  schema: Record<string, unknown>
  backgroundable?: {
    taskType: 'shell' | 'subagent'
    describe(input: In): string
    subagentType?(input: In): string | undefined
  }
  run(input: In, ctx: ToolContext): Promise<ToolOutcome>
}
