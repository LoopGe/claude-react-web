import { describe, it, expect } from 'vitest'
import { runCliCommand, GROUPS, topLevelHelp } from './index.js'
import { parseArgv } from './args.js'

describe('parseArgv (from args.ts)', () => {
  it('detects a leading subcommand', () => {
    expect(parseArgv(['mcp', 'list'])).toEqual({ stateDir: undefined, command: 'mcp', commandArgv: ['list'] })
  })
  it('strips --state-dir from anywhere', () => {
    expect(parseArgv(['--state-dir', '/x', 'mcp', 'list']).command).toBe('mcp')
    expect(parseArgv(['--state-dir=/x', 'mcp', 'list']).stateDir).toBe('/x')
    expect(parseArgv(['mcp', 'list', '--state-dir=/x']).command).toBe('mcp')
  })
  it('returns no command for server flags', () => {
    expect(parseArgv(['--port', '3456']).command).toBeUndefined()
    expect(parseArgv(['-o']).command).toBeUndefined()
  })
})

describe('registry', () => {
  it('registers the full set of groups', () => {
    const names = GROUPS.map((g) => g.name).sort()
    expect(names).toEqual(['app-plugin', 'config', 'doctor', 'marketplace', 'mcp', 'sessions', 'update'])
  })
  it('top-level help lists every group', () => {
    const help = topLevelHelp()
    for (const g of GROUPS) expect(help).toContain(g.name)
  })
  it('runs the doctor default and reports a non-zero exit for a broken setup', async () => {
    const code = await runCliCommand({ stateDir: '/nonexistent-cli-test' }, 'doctor', [])
    expect(code).toBe(1)
  })
  it('rejects an unknown command', async () => {
    await expect(runCliCommand({ stateDir: '' }, 'nope', [])).rejects.toThrow(/unknown command/)
  })
})
