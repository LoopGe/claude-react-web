import type { ParseSpec, ParsedOptions } from './parser.js'

export class CliError extends Error {
  readonly exitCode: number
  constructor(message: string, exitCode = 1) {
    super(message)
    this.name = 'CliError'
    this.exitCode = exitCode
  }
}

export interface CliContext {
  readonly stateDir: string
}

export type CliRunFn = (ctx: CliContext, parsed: ParsedOptions) => Promise<unknown>

export interface Subcommand {
  name: string
  usage: string
  description: string
  parseSpec: ParseSpec
  run: CliRunFn
  render(data: unknown): string
  exitCode?(data: unknown): number
}

export interface DefaultCommand {
  usage: string
  description: string
  parseSpec: ParseSpec
  run: CliRunFn
  render(data: unknown): string
  exitCode?(data: unknown): number
}

export interface CliGroup {
  name: string
  summary: string
  subcommands: Subcommand[]
  default?: DefaultCommand
}
