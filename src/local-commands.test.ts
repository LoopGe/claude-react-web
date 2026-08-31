import { describe, expect, it } from 'vitest'
import { matchLocalCommand, LOCAL_COMMANDS } from './local-commands'

describe('matchLocalCommand', () => {
  it('matches an exact local command', () => {
    expect(matchLocalCommand('/resume')?.name).toBe('resume')
    expect(matchLocalCommand('/mcp')?.name).toBe('mcp')
    expect(matchLocalCommand('/help')?.name).toBe('help')
    expect(matchLocalCommand('/clear')?.name).toBe('clear')
    expect(matchLocalCommand('/compact')?.name).toBe('compact')
  })

  it('matches clear aliases', () => {
    expect(matchLocalCommand('/reset')?.name).toBe('clear')
    expect(matchLocalCommand('/new')?.name).toBe('clear')
  })

  it('matches the compact summarize alias', () => {
    expect(matchLocalCommand('/summarize')?.name).toBe('compact')
  })

  it('/mcp run() opens the mcp settings tab for its panel', () => {
    const cmd = matchLocalCommand('/mcp')!
    let opened: { id: string; tab: string } | null = null
    cmd.run({
      sessionId: 'sess-1',
      commands: [],
      requestResumeForPanel: () => {},
      openSettingsTab: (id, tab) => { opened = { id, tab } },
      showHelp: () => {},
      clearSession: () => {},
      compactSession: () => {},
    })
    expect(opened).toEqual({ id: 'sess-1', tab: 'mcp' })
  })

  it('/help run() opens the help dialog with the panel commands', () => {
    const cmd = matchLocalCommand('/help')!
    const panelCommands = [{ name: 'help', description: 'Show help', argumentHint: '' }]
    let shown: typeof panelCommands | null = null
    cmd.run({
      sessionId: 'sess-1',
      commands: panelCommands,
      requestResumeForPanel: () => {},
      openSettingsTab: () => {},
      showHelp: (cmds) => { shown = cmds },
      clearSession: () => {},
      compactSession: () => {},
    })
    expect(shown).toBe(panelCommands)
  })

  it('/clear run() calls the clear control hook for its panel', () => {
    const cmd = matchLocalCommand('/clear')!
    let cleared: string | null = null
    cmd.run({
      sessionId: 'sess-1',
      commands: [],
      requestResumeForPanel: () => {},
      openSettingsTab: () => {},
      showHelp: () => {},
      clearSession: (id) => { cleared = id },
      compactSession: () => {},
    })
    expect(cleared).toBe('sess-1')
  })

  it('/compact run() calls the compact control hook for its panel', () => {
    const cmd = matchLocalCommand('/compact')!
    let compacted: string | null = null
    cmd.run({
      sessionId: 'sess-1',
      commands: [],
      requestResumeForPanel: () => {},
      openSettingsTab: () => {},
      showHelp: () => {},
      clearSession: () => {},
      compactSession: (id) => { compacted = id },
    })
    expect(compacted).toBe('sess-1')
  })

  it('matches with surrounding whitespace', () => {
    expect(matchLocalCommand('  /resume  ')?.name).toBe('resume')
  })

  it('matches case-insensitively', () => {
    expect(matchLocalCommand('/RESUME')?.name).toBe('resume')
  })

  it('matches when trailing args are present (first token only)', () => {
    // The picker inserts "/resume " with a trailing space; args are ignored.
    expect(matchLocalCommand('/resume foo bar')?.name).toBe('resume')
  })

  it('does NOT match a command that merely starts with the name', () => {
    // Must be an exact first-token match, not a prefix — otherwise /resumed
    // would be swallowed.
    expect(matchLocalCommand('/resumed')).toBeNull()
  })

  it('returns null for non-local SDK/plugin commands', () => {
    expect(matchLocalCommand('/init')).toBeNull()
    expect(matchLocalCommand('/review the diff')).toBeNull()
  })

  it('returns null for plain text and empty input', () => {
    expect(matchLocalCommand('hello world')).toBeNull()
    expect(matchLocalCommand('')).toBeNull()
    expect(matchLocalCommand('/')).toBeNull()
  })

  it('every registered command has the required shape', () => {
    for (const cmd of LOCAL_COMMANDS) {
      expect(typeof cmd.name).toBe('string')
      expect(cmd.name.length).toBeGreaterThan(0)
      expect(typeof cmd.run).toBe('function')
    }
  })
})
