import { describe, expect, it } from 'vitest'
import { parseServerArgs, HELP } from './args.js'

describe('parseServerArgs --dev / --no-dev', () => {
  it('leaves dev undefined when neither flag is given (auto-detect)', () => {
    expect(parseServerArgs([]).dev).toBeUndefined()
  })

  it('sets dev true for --dev', () => {
    expect(parseServerArgs(['--dev']).dev).toBe(true)
  })

  it('sets dev false for --no-dev', () => {
    expect(parseServerArgs(['--no-dev']).dev).toBe(false)
  })

  it('lets a later flag win', () => {
    expect(parseServerArgs(['--dev', '--no-dev']).dev).toBe(false)
  })

  it('does not disturb the existing flags', () => {
    const args = parseServerArgs(['--dev', '-p', '4000', '--no-open'])
    expect(args).toMatchObject({ dev: true, port: 4000, open: false })
  })
})

describe('HELP text', () => {
  // --help is the discoverability surface for the CLI: a flag the parser
  // accepts but HELP omits is effectively source-only. --disable-app-plugins
  // and --safe-mode had drifted out of it that way.
  //
  // NOTE: `longFlags` is a curated list, not derived from parseServerArgs — so
  // this guards against a flag being REMOVED from HELP (and pins the two that
  // previously went missing), but it cannot notice a NEW flag added to the
  // parser and forgotten here. Deriving the set from one shared flag table
  // would close that gap.
  it('documents the flags this CLI ships', () => {
    const longFlags = [
      '--port',
      '--host',
      '--token',
      '--open',
      '--no-open',
      '--cwd',
      '--model',
      '--state-dir',
      '--claude-binary',
      '--dev',
      '--no-dev',
      '--disable-app-plugins',
      '--safe-mode',
      '--version',
      '--help',
    ]
    for (const flag of longFlags) expect(HELP).toContain(flag)

    // The short forms need their own anchored check: a substring test is
    // vacuous here because '-p' is inside '--port', '-o' inside '--open' and
    // '--no-open', and '-h' inside '--help' and '--host'.
    for (const short of ['-p', '-o', '-V', '-h']) {
      expect(HELP).toMatch(new RegExp(`^\\s+\\${short},\\s`, 'm'))
    }
  })
})
