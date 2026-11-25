import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderNativeSkillBody, renderNativeSkillToolResult, substituteSkillArguments } from './skill-render.js'

describe('renderNativeSkillBody', () => {
  it('renders the absolute skill directory and body without frontmatter', () => {
    const directory = resolve('project', '.claude', 'skills', 'demo')
    const document = [
      '---',
      'name: demo',
      'description: Demo skill',
      'disable-model-invocation: true',
      '---',
      '',
      '# Demo instructions',
      '',
      'Keep $ARGUMENTS verbatim.',
      '',
    ].join('\n')

    expect(renderNativeSkillBody({ directory, document })).toBe(
      `Base directory for this skill: ${directory}\n\n# Demo instructions\n\nKeep $ARGUMENTS verbatim.\n`,
    )
  })

  it('preserves the body line endings after the closing delimiter', () => {
    const directory = resolve('skill-dir')
    const document = '---\r\nname: demo\r\ndescription: Demo\r\n---\r\n\r\nFirst\r\nSecond\r\n'

    expect(renderNativeSkillBody({ directory, document })).toBe(
      `Base directory for this skill: ${directory}\n\nFirst\r\nSecond\r\n`,
    )
  })

  it('fails loudly for invalid frontmatter', () => {
    expect(() => renderNativeSkillBody({
      directory: resolve('skill-dir'),
      document: '# Missing frontmatter',
    })).toThrow(/must start with YAML frontmatter/)
  })
})

describe('renderNativeSkillToolResult', () => {
  it.each(['', '  \n\t'])('adds no request section for blank args %j', (args) => {
    expect(renderNativeSkillToolResult('canonical body', args)).toBe('canonical body')
  })

  it('appends nonempty args under the exact User Request heading', () => {
    expect(renderNativeSkillToolResult('canonical body', 'do the thing')).toBe(
      'canonical body\n\n## User Request\ndo the thing',
    )
  })
})

describe('substituteSkillArguments', () => {
  it('substitutes $ARGUMENTS with the whole raw args', () => {
    expect(substituteSkillArguments('Run: $ARGUMENTS', 'a b')).toBe('Run: a b')
  })
  it('substitutes $N and $ARGUMENTS[N] 0-based', () => {
    expect(substituteSkillArguments('$0/$1', 'a b')).toBe('a/b\n\nARGUMENTS: a b')
    expect(substituteSkillArguments('$ARGUMENTS[0]', 'a b')).toBe('a\n\nARGUMENTS: a b')
  })
  it('leaves out-of-range indices literal', () => {
    expect(substituteSkillArguments('$5', 'a b')).toBe('$5\n\nARGUMENTS: a b')
    expect(substituteSkillArguments('$ARGUMENTS[9]', 'a b')).toBe('$ARGUMENTS[9]\n\nARGUMENTS: a b')
  })
  it('appends ARGUMENTS when $ARGUMENTS is absent and args non-empty', () => {
    expect(substituteSkillArguments('Body', 'a b')).toBe('Body\n\nARGUMENTS: a b')
  })
  it('still appends ARGUMENTS when only $N matched (no $ARGUMENTS)', () => {
    expect(substituteSkillArguments('$0', 'a b')).toBe('a\n\nARGUMENTS: a b')
  })
  it('does not append when $ARGUMENTS matched', () => {
    expect(substituteSkillArguments('$ARGUMENTS', 'a b')).toBe('a b')
  })
  it('does not append for empty args', () => {
    expect(substituteSkillArguments('Body', '')).toBe('Body')
  })
  it('renders escaped \\$ literally and still appends ARGUMENTS', () => {
    expect(substituteSkillArguments('\\$ARGUMENTS', 'x')).toBe('$ARGUMENTS\n\nARGUMENTS: x')
    expect(substituteSkillArguments('\\$0', 'x')).toBe('$0\n\nARGUMENTS: x')
  })
  it('does not re-substitute inserted args text', () => {
    expect(substituteSkillArguments('$ARGUMENTS', '$0')).toBe('$0')
  })
  it('splits quoted args shell-style', () => {
    expect(substituteSkillArguments('$0/$1', '"a b" c')).toBe('a b/c\n\nARGUMENTS: "a b" c')
  })
  it('throws past 4,000,000 chars', () => {
    expect(() => substituteSkillArguments('$ARGUMENTS', 'x'.repeat(4_000_001))).toThrow(/4,000,000/)
  })
})
