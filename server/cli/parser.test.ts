import { describe, it, expect } from 'vitest'
import { parseArgs, scalar, list } from './parser.js'
import { CliError } from './types.js'

describe('parseArgs', () => {
  it('collects positionals and universal flags', () => {
    const p = parseArgs(['list', '--json', '--yes'], { minPositional: 1 })
    expect(p.positionals).toEqual(['list'])
    expect(p.json).toBe(true)
    expect(p.yes).toBe(true)
    expect(p.help).toBe(false)
  })

  it('supports --flag value and --flag=value for string flags', () => {
    expect(parseArgs(['--command', 'npx'], { string: ['command'] }).values.command).toBe('npx')
    expect(parseArgs(['--command=npx'], { string: ['command'] }).values.command).toBe('npx')
  })

  it('accumulates repeatable flags', () => {
    const p = parseArgs(['--env', 'A=1', '--env', 'B=2'], { repeatable: ['env'] })
    expect(list(p, 'env')).toEqual(['A=1', 'B=2'])
  })

  it('sets bare boolean flags and --no-x clears them', () => {
    expect(parseArgs(['--always-load'], { boolean: ['always-load'] }).bools['always-load']).toBe(true)
    expect(parseArgs(['--no-always-load'], { boolean: ['always-load'] }).bools['always-load']).toBe(false)
  })

  it('treats a flag value that looks like a flag as a value', () => {
    const p = parseArgs(['--args', '--json'], { string: ['args'] })
    expect(p.values.args).toBe('--json')
    expect(p.json).toBe(false)
  })

  it('throws CliError(2) on unknown options / missing value / arity', () => {
    expect(() => parseArgs(['--bogus'])).toThrowError(CliError)
    expect(() => parseArgs(['--command'], { string: ['command'] })).toThrowError(CliError)
    expect(() => parseArgs(['add'], { minPositional: 2 })).toThrowError(CliError)
    expect(() => parseArgs(['a', 'b'], { maxPositional: 1 })).toThrowError(CliError)
  })

  it('--help bypasses positional arity enforcement', () => {
    const p = parseArgs(['--help'], { minPositional: 2 })
    expect(p.help).toBe(true)
  })

  it('scalar() returns undefined for absent or array values', () => {
    const p = parseArgs(['--env', 'A=1'], { repeatable: ['env'] })
    expect(scalar(p, 'env')).toBeUndefined()
    expect(scalar(p, 'missing')).toBeUndefined()
  })
})
