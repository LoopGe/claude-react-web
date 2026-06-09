import { describe, it, expect } from 'vitest'
import { pluginTagOf, truncate } from './text'

describe('pluginTagOf', () => {
  it('extracts a leading (plugin) tag', () => {
    expect(pluginTagOf('(skills) Use this skill whenever…')).toBe('skills')
    expect(pluginTagOf('(ui-ux-pro-max) UI/UX design intelligence')).toBe('ui-ux-pro-max')
    expect(pluginTagOf('(atlassian) Analyze meeting notes')).toBe('atlassian')
  })

  it('returns null when there is no leading tag', () => {
    expect(pluginTagOf('Initialize a new CLAUDE.md file')).toBeNull()
    expect(pluginTagOf(undefined)).toBeNull()
    expect(pluginTagOf('')).toBeNull()
  })

  it('only matches a tag at the START, not a trailing parenthetical', () => {
    // e.g. the deep-research command: "… synthesize a cited report. (dynamic workflow)"
    expect(pluginTagOf('Deep research harness. (dynamic workflow)')).toBeNull()
  })

  it('trims whitespace inside the tag', () => {
    expect(pluginTagOf('(  skills  ) desc')).toBe('skills')
  })
})

describe('truncate', () => {
  it('leaves short strings unchanged and truncates long ones', () => {
    expect(truncate('abc', 5)).toBe('abc')
    expect(truncate('abcdef', 3)).toBe('abc…')
  })
})
