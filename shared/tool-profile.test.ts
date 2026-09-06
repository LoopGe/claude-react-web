import { describe, expect, it } from 'vitest'
import {
  applyToolProfile,
  coerceToolProfile,
  extractToolProfile,
} from './tool-profile.js'

describe('extractToolProfile', () => {
  it('extracts a profile from an Options-shaped object when tool fields are present', () => {
    const opts = {
      model: 'x',
      tools: ['Bash', 'Edit'],
      allowedTools: ['Read'],
      disallowedTools: ['WebFetch'],
      toolAliases: { Bash: 'mcp__ws__bash' },
      toolConfig: { askUserQuestion: 'x' },
    }
    expect(extractToolProfile(opts)).toEqual({
      tools: ['Bash', 'Edit'],
      allowedTools: ['Read'],
      disallowedTools: ['WebFetch'],
      toolAliases: { Bash: 'mcp__ws__bash' },
      toolConfig: { askUserQuestion: 'x' },
    })
  })

  it('returns undefined when no tool-surface field is present', () => {
    expect(extractToolProfile({ model: 'x' })).toBeUndefined()
    expect(extractToolProfile(undefined)).toBeUndefined()
  })

  it('ignores malformed tool fields (non-string entries / non-object maps)', () => {
    expect(extractToolProfile({ tools: [1] })).toBeUndefined()
    expect(extractToolProfile({ toolAliases: ['not-a-map'] })).toBeUndefined()
    expect(extractToolProfile({ toolConfig: 'nope' })).toBeUndefined()
  })

  it('carries an empty tools list ([] disables all built-in tools)', () => {
    expect(extractToolProfile({ tools: [] })).toEqual({ tools: [] })
  })
})

describe('applyToolProfile', () => {
  it('projects profile fields onto options that are not already set', () => {
    const opts: Record<string, unknown> = { model: 'x' }
    applyToolProfile(opts, {
      tools: ['Bash'],
      allowedTools: ['Read'],
      disallowedTools: ['WebFetch'],
      toolAliases: { Bash: 'mcp__ws__bash' },
      toolConfig: { bait: 1 },
    })
    expect(opts).toEqual({
      model: 'x',
      tools: ['Bash'],
      allowedTools: ['Read'],
      disallowedTools: ['WebFetch'],
      toolAliases: { Bash: 'mcp__ws__bash' },
      toolConfig: { bait: 1 },
    })
  })

  it('does not override create-body passthrough (caller-set values win)', () => {
    const opts: Record<string, unknown> = { tools: ['Edit'] }
    applyToolProfile(opts, { tools: ['Bash'], allowedTools: ['Read'] })
    expect(opts.tools).toEqual(['Edit'])
    expect(opts.allowedTools).toEqual(['Read'])
  })

  it('projects an empty tools list to disable all built-in tools', () => {
    const opts: Record<string, unknown> = {}
    applyToolProfile(opts, { tools: [] })
    expect(opts.tools).toEqual([])
  })

  it('ignores an undefined profile', () => {
    const opts: Record<string, unknown> = { model: 'x' }
    applyToolProfile(opts, undefined)
    expect(opts).toEqual({ model: 'x' })
  })
})

describe('coerceToolProfile', () => {
  it('narrows a valid route payload to the clean shape', () => {
    expect(
      coerceToolProfile({
        tools: ['Bash', 'Edit'],
        allowedTools: ['Read'],
        disallowedTools: ['WebFetch'],
        toolAliases: { Bash: 'mcp__ws__bash' },
        toolConfig: { askUserQuestion: { previewFormat: 'html' } },
      }),
    ).toEqual({
      tools: ['Bash', 'Edit'],
      allowedTools: ['Read'],
      disallowedTools: ['WebFetch'],
      toolAliases: { Bash: 'mcp__ws__bash' },
      toolConfig: { askUserQuestion: { previewFormat: 'html' } },
    })
  })

  it('returns null for a malformed known field (caller 400s)', () => {
    expect(coerceToolProfile({ tools: 'nope' })).toBeNull()
    expect(coerceToolProfile({ tools: [1] })).toBeNull()
    expect(coerceToolProfile({ allowedTools: false })).toBeNull()
    expect(coerceToolProfile({ toolAliases: { a: 1 } })).toBeNull()
    expect(coerceToolProfile({ toolConfig: 5 })).toBeNull()
  })

  it('returns undefined for absent/non-object/empty payloads (clear, not a 400)', () => {
    expect(coerceToolProfile(null)).toBeUndefined()
    expect(coerceToolProfile([])).toBeUndefined()
    expect(coerceToolProfile(undefined)).toBeUndefined()
    expect(coerceToolProfile('tools')).toBeUndefined()
    expect(coerceToolProfile({})).toBeUndefined()
  })

  it('keeps empty string lists and ignores unknown top-level keys', () => {
    expect(coerceToolProfile({ tools: [], unknownKey: 1 })).toEqual({ tools: [] })
  })
})