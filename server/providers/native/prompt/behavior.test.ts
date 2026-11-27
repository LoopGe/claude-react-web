// server/providers/native/prompt/behavior.test.ts
import { describe, expect, it } from 'vitest'
import { BEHAVIOR_SECTIONS } from './behavior.js'

const textOf = (name: string): string => {
  const section = BEHAVIOR_SECTIONS.find((s) => s.name === name)
  if (!section) throw new Error(`missing section: ${name}`)
  return section.text
}

describe('BEHAVIOR_SECTIONS', () => {
  it('has the seven sections in order', () => {
    expect(BEHAVIOR_SECTIONS.map((s) => [s.name, s.order])).toEqual([
      ['behavior:communicating', 10],
      ['behavior:tone', 20],
      ['behavior:doing-tasks', 30],
      ['behavior:actions', 40],
      ['behavior:delivering', 50],
      ['behavior:corrections', 60],
      ['behavior:pronouns', 70],
    ])
  })

  it('texts carry the CLI headings', () => {
    expect(textOf('behavior:communicating').startsWith('# Communicating with the user')).toBe(true)
    expect(textOf('behavior:tone').startsWith('# Tone and style')).toBe(true)
    expect(textOf('behavior:doing-tasks').startsWith('# Doing tasks')).toBe(true)
    expect(textOf('behavior:actions').startsWith('# Executing actions with care')).toBe(true)
    expect(textOf('behavior:delivering').startsWith('# Delivering work')).toBe(true)
    expect(textOf('behavior:corrections').startsWith('# Corrections')).toBe(true)
    expect(textOf('behavior:pronouns').startsWith('# Pronouns')).toBe(true)
    expect(textOf('behavior:pronouns')).toContain('they/them')
  })

  it('no product references', () => {
    for (const section of BEHAVIOR_SECTIONS) {
      expect(section.text).not.toContain('Claude Code')
      expect(section.text).not.toContain('/help')
    }
  })

  it('substance pins', () => {
    const tone = textOf('behavior:tone')
    expect(tone).toContain('file_path:line_number')
    expect(tone).toContain('Do not use a colon before tool calls')

    const doing = textOf('behavior:doing-tasks')
    expect(doing).toContain('premature abstraction')
    expect(doing).toContain("Don't add error handling, fallbacks, or validation for scenarios that can't happen")

    expect(textOf('behavior:actions')).toContain('blast radius')
    expect(textOf('behavior:delivering')).toContain('requested scope is the deliverable')
  })
})
