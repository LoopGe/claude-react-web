// server/providers/native/hooks/matcher.test.ts
import { describe, it, expect, vi } from 'vitest'
import { matches, matcherTarget } from './matcher.js'

describe('matches', () => {
  it('undefined, empty, "*" and ".*" match everything', () => {
    expect(matches(undefined, 'Bash')).toBe(true)
    expect(matches('', 'Bash')).toBe(true)
    expect(matches('*', 'Bash')).toBe(true)
    expect(matches('.*', 'Bash')).toBe(true)
    expect(matches('*', 'anything-at-all')).toBe(true)
  })

  it('literal list splits on | and matches by exact equality', () => {
    expect(matches('Bash|Edit', 'Edit')).toBe(true)
    expect(matches('Bash|Edit', 'Bash')).toBe(true)
    expect(matches('Bash|Edit', 'Write')).toBe(false)
  })

  it('literal list splits on commas and trims whitespace around names', () => {
    expect(matches('Bash,Edit', 'Edit')).toBe(true)
    expect(matches('Bash, Edit', 'Edit')).toBe(true)
    expect(matches(' Bash | Edit ', 'Bash')).toBe(true)
  })

  it('literal list is exact equality, not prefix or substring', () => {
    expect(matches('Bash', 'BashTool')).toBe(false)
    expect(matches('Bash|Edit', 'BashTool')).toBe(false)
    expect(matches('ash', 'Bash')).toBe(false)
    // A pure-charset prefix like 'Ba' is a literal name, not a regex: the
    // charset gate runs before any regex evaluation (CLI tEn/Fee).
    expect(matches('Ba', 'Bash')).toBe(false)
    expect(matches('bash', 'Bash')).toBe(false)
    // Empty segments are dropped (CLI tEn filter(Boolean)), so they cannot
    // match an empty-string target.
    expect(matches('Bash|', '')).toBe(false)
  })

  it('literal-list charset covers digits, underscore, hyphen and space', () => {
    expect(matches('mcp__git-tools__git_status', 'mcp__git-tools__git_status')).toBe(true)
    expect(matches('mcp__git-tools__git_status', 'mcp__git-tools__git_log')).toBe(false)
    expect(matches('Tool 1|Tool 2', 'Tool 2')).toBe(true)
    expect(matches('Tool 1', 'Tool 10')).toBe(false)
  })

  it('regex matchers are unanchored and case-sensitive', () => {
    expect(matches('^Bash$', 'Bash')).toBe(true)
    expect(matches('^Bash$', 'BashTool')).toBe(false)
    // '.' is outside the literal-list charset, so these take the regex path;
    // 'as.' matches mid-string, pinning the unanchored semantics.
    expect(matches('as.', 'Bash')).toBe(true)
    expect(matches('B.sh', 'Bash')).toBe(true)
    expect(matches('B.sh', 'Bxsh')).toBe(true)
    expect(matches('b.sh', 'Bash')).toBe(false)
  })

  it('invalid regex → no match + log, never throws', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(() => matches('[', 'Bash')).not.toThrow()
      expect(matches('[', 'Bash')).toBe(false)
      expect(matches('(', 'Bash')).toBe(false)
      expect(warnSpy).toHaveBeenCalled()
      const logged = warnSpy.mock.calls.map((call) => call.join(' ')).join('\n')
      expect(logged).toContain('Invalid regex')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('a missing target ignores the matcher (no-target events)', () => {
    expect(matches('Bash', undefined)).toBe(true)
    expect(matches('Edit', undefined)).toBe(true)
    // Ignored before regex evaluation: an invalid pattern neither matches
    // nor logs when there is no target to match against.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(matches('[', undefined)).toBe(true)
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('matcherTarget', () => {
  it('the five tool events target tool_name', () => {
    const input = { tool_name: 'Bash', tool_input: { command: 'ls' } }
    expect(matcherTarget('PreToolUse', input)).toBe('Bash')
    expect(matcherTarget('PostToolUse', input)).toBe('Bash')
    expect(matcherTarget('PostToolUseFailure', input)).toBe('Bash')
    expect(matcherTarget('PermissionRequest', input)).toBe('Bash')
    expect(matcherTarget('PermissionDenied', input)).toBe('Bash')
  })

  it('SessionStart targets source', () => {
    expect(matcherTarget('SessionStart', { source: 'startup' })).toBe('startup')
    expect(matcherTarget('SessionStart', { source: 'resume' })).toBe('resume')
  })

  it('PreCompact and PostCompact target trigger', () => {
    expect(matcherTarget('PreCompact', { trigger: 'manual' })).toBe('manual')
    expect(matcherTarget('PostCompact', { trigger: 'auto' })).toBe('auto')
  })

  it('SubagentStart and SubagentStop target agent_type', () => {
    expect(matcherTarget('SubagentStart', { agent_type: 'Explore' })).toBe('Explore')
    expect(matcherTarget('SubagentStop', { agent_type: 'general-purpose' })).toBe('general-purpose')
  })

  it('StopFailure targets error', () => {
    expect(matcherTarget('StopFailure', { error: 'overloaded' })).toBe('overloaded')
  })

  it('no-target events return undefined even when the input carries other fields', () => {
    expect(matcherTarget('Stop', {})).toBe(undefined)
    expect(matcherTarget('Stop', { tool_name: 'Bash', source: 'startup' })).toBe(undefined)
    expect(matcherTarget('UserPromptSubmit', { prompt: 'hi', tool_name: 'Bash' })).toBe(undefined)
  })

  it('a missing or non-string target field returns undefined', () => {
    expect(matcherTarget('PreToolUse', {})).toBe(undefined)
    expect(matcherTarget('PreToolUse', { tool_name: 42 })).toBe(undefined)
    expect(matcherTarget('SessionStart', { source: null })).toBe(undefined)
  })
})