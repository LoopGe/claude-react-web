import { CliError } from './types.js'

export interface ParseSpec {
  string?: string[]
  repeatable?: string[]
  boolean?: string[]
  minPositional?: number
  maxPositional?: number
}

export interface ParsedOptions {
  help: boolean
  json: boolean
  yes: boolean
  positionals: string[]
  values: Record<string, string | string[]>
  bools: Record<string, boolean>
}

export function parseArgs(argv: string[], spec: ParseSpec = {}): ParsedOptions {
  const string = new Set(spec.string ?? [])
  const repeatable = new Set(spec.repeatable ?? [])
  const boolean = new Set(spec.boolean ?? [])
  const out: ParsedOptions = { help: false, json: false, yes: false, positionals: [], values: {}, bools: {} }
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]
    if (raw === '-h' || raw === '--help') { out.help = true; continue }
    if (raw === '--json') { out.json = true; continue }
    if (raw === '--yes') { out.yes = true; continue }
    if (raw.startsWith('--')) {
      const eq = raw.indexOf('=')
      const name = eq === -1 ? raw.slice(2) : raw.slice(2, eq)
      const inline = eq === -1 ? undefined : raw.slice(eq + 1)
      if (boolean.has(name)) {
        if (inline !== undefined) throw new CliError(`option --${name} takes no value`, 2)
        out.bools[name] = true
        continue
      }
      if (name.startsWith('no-') && boolean.has(name.slice(3))) {
        if (inline !== undefined) throw new CliError(`option --${name} takes no value`, 2)
        out.bools[name.slice(3)] = false
        continue
      }
      if (string.has(name) || repeatable.has(name)) {
        let value = inline
        if (value === undefined) {
          value = argv[++i]
          if (value === undefined) throw new CliError(`option --${name} requires a value`, 2)
        }
        if (repeatable.has(name)) {
          const arr = (out.values[name] as string[] | undefined) ?? []
          arr.push(value)
          out.values[name] = arr
        } else {
          out.values[name] = value
        }
        continue
      }
      throw new CliError(`unknown option: --${name}`, 2)
    }
    if (raw.length > 1 && raw.startsWith('-')) throw new CliError(`unknown option: ${raw}`, 2)
    out.positionals.push(raw)
  }
  const min = spec.minPositional ?? 0
  const max = spec.maxPositional ?? Number.POSITIVE_INFINITY
  if (!out.help && out.positionals.length < min) throw new CliError(`expected at least ${min} argument(s)`, 2)
  if (!out.help && out.positionals.length > max) throw new CliError(`too many arguments`, 2)
  return out
}

export function scalar(p: ParsedOptions, name: string): string | undefined {
  const v = p.values[name]
  return typeof v === 'string' ? v : undefined
}

export function list(p: ParsedOptions, name: string): string[] {
  const v = p.values[name]
  return Array.isArray(v) ? v : []
}
