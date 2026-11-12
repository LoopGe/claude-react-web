import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderNativeSkillBody, renderNativeSkillToolResult } from './skill-render.js'

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
