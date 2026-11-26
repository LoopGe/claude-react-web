// server/providers/native/hooks/if-condition.test.ts
import { describe, it, expect, vi } from 'vitest'
import { evaluateIf, TOOL_HOOK_EVENTS } from './if-condition.js'

describe('evaluateIf — permission-rule parsing (RS §4.2 Bn)', () => {
  it('Bash(git *) matches a command starting with "git "', () => {
    expect(evaluateIf('Bash(git *)', 'Bash', { command: 'git status' })).toBe(true)
    expect(evaluateIf('Bash(git *)', 'Bash', { command: 'git commit -m "x"' })).toBe(true)
  })

  it('Bash(git *) does not match a different command', () => {
    expect(evaluateIf('Bash(git *)', 'Bash', { command: 'rm -rf' })).toBe(false)
    // The prefix is "git " (with the space): a longer first word is not a hit.
    expect(evaluateIf('Bash(git *)', 'Bash', { command: 'github status' })).toBe(false)
    // Bare "git" has no trailing space, so the "git " prefix does not cover it.
    expect(evaluateIf('Bash(git *)', 'Bash', { command: 'git' })).toBe(false)
  })

  it('a bare tool name matches the tool with no content constraint', () => {
    expect(evaluateIf('Edit', 'Edit', {})).toBe(true)
    expect(evaluateIf('Bash', 'Bash', { command: 'anything' })).toBe(true)
    expect(evaluateIf('mcp__git-tools__git_status', 'mcp__git-tools__git_status', {})).toBe(true)
  })

  it('a tool mismatch is false even when the content would match', () => {
    expect(evaluateIf('Bash(git *)', 'Read', {})).toBe(false)
    expect(evaluateIf('Bash(git *)', 'Read', { command: 'git status' })).toBe(false)
    expect(evaluateIf('Edit', 'Write', {})).toBe(false)
    expect(evaluateIf('Nope', 'Bash', {})).toBe(false)
  })

  it('tool names are case-sensitive', () => {
    expect(evaluateIf('bash', 'Bash', {})).toBe(false)
    expect(evaluateIf('Bash', 'bash', {})).toBe(false)
  })

  it('surrounding whitespace is trimmed; empty content means no constraint', () => {
    expect(evaluateIf('  Bash(git *)  ', 'Bash', { command: 'git status' })).toBe(true)
    expect(evaluateIf('Bash()', 'Bash', { command: 'anything' })).toBe(true)
    expect(evaluateIf('Bash(*)', 'Bash', { command: 'anything' })).toBe(true)
  })

  it('nested parens keep the inner content (first open paren, last close paren)', () => {
    expect(evaluateIf('Bash(echo (hi))', 'Bash', { command: 'echo (hi)' })).toBe(true)
    expect(evaluateIf('Bash(echo (hi))', 'Bash', { command: 'echo hi' })).toBe(false)
  })

  it('malformed rules are false + log, never throw', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(() => evaluateIf('Bash(git *', 'Bash', { command: 'git status' })).not.toThrow()
      expect(evaluateIf('Bash(git *', 'Bash', { command: 'git status' })).toBe(false)
      expect(evaluateIf('', 'Bash', {})).toBe(false)
      expect(evaluateIf('   ', 'Bash', {})).toBe(false)
      expect(evaluateIf('(git *)', 'Bash', { command: 'git status' })).toBe(false)
      expect(warnSpy).toHaveBeenCalled()
      const logged = warnSpy.mock.calls.map((call) => call.join(' ')).join('\n')
      expect(logged).toContain('if condition')
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('evaluateIf — Agent/Task/Explore aliases', () => {
  it('the agent-family aliases match each other', () => {
    expect(evaluateIf('Task', 'Agent', {})).toBe(true)
    expect(evaluateIf('Agent', 'Task', {})).toBe(true)
    expect(evaluateIf('Explore', 'Agent', {})).toBe(true)
    expect(evaluateIf('Agent', 'Explore', {})).toBe(true)
  })

  it('aliases do not widen to unrelated tools', () => {
    expect(evaluateIf('Task', 'Bash', {})).toBe(false)
    expect(evaluateIf('Bash', 'Agent', {})).toBe(false)
  })
})

describe('evaluateIf — Bash content matcher', () => {
  it('a rule without a wildcard is an exact command match', () => {
    expect(evaluateIf('Bash(git status)', 'Bash', { command: 'git status' })).toBe(true)
    expect(evaluateIf('Bash(git status)', 'Bash', { command: 'git status --short' })).toBe(false)
    expect(evaluateIf('Bash(git status)', 'Bash', { command: 'git status && git log' })).toBe(false)
  })

  it('a compound command must match in EVERY subcommand', () => {
    expect(evaluateIf('Bash(git *)', 'Bash', { command: 'git status && git log' })).toBe(true)
    expect(evaluateIf('Bash(git *)', 'Bash', { command: 'git status && rm -rf /' })).toBe(false)
    expect(evaluateIf('Bash(git *)', 'Bash', { command: 'git log | grep foo' })).toBe(false)
    expect(evaluateIf('Bash(git *)', 'Bash', { command: 'git status; git diff' })).toBe(true)
  })

  it('quoted operators do not split subcommands', () => {
    expect(evaluateIf('Bash(echo *)', 'Bash', { command: 'echo "a && b"' })).toBe(true)
    expect(evaluateIf('Bash(echo *)', 'Bash', { command: "echo 'a; b'" })).toBe(true)
  })

  it('a missing or non-string command never matches a content rule', () => {
    expect(evaluateIf('Bash(git *)', 'Bash', {})).toBe(false)
    expect(evaluateIf('Bash(git *)', 'Bash', { command: 42 })).toBe(false)
    expect(evaluateIf('Bash(git *)', 'Bash', { command: '   ' })).toBe(false)
    // A bare tool name still matches without a command field.
    expect(evaluateIf('Bash', 'Bash', {})).toBe(true)
  })
})

describe('evaluateIf — content-matcher coverage', () => {
  it('rule content on a tool without a content matcher is false + log (Bash only today)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(evaluateIf('Edit(src/**)', 'Edit', { file_path: 'src/a.ts' })).toBe(false)
      expect(evaluateIf('WebFetch(domain:example.com)', 'WebFetch', { url: 'https://example.com' })).toBe(false)
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('TOOL_HOOK_EVENTS', () => {
  it('is exactly the five tool events (RS §4.2)', () => {
    expect([...TOOL_HOOK_EVENTS].sort()).toEqual([
      'PermissionDenied',
      'PermissionRequest',
      'PostToolUse',
      'PostToolUseFailure',
      'PreToolUse',
    ])
  })
})