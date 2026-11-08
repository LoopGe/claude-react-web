// server/providers/native/tools/types.ts
export class ToolInputError extends Error {}

export interface ToolContext {
  cwd: string
  signal: AbortSignal
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
  run(input: In, ctx: ToolContext): Promise<ToolOutcome>
}
