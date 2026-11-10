import { describe, expect, it } from 'vitest'
import { mcpToolFqn } from './mcp-fqn.js'

describe('mcpToolFqn', () => {
  it('leaves an API-safe name untouched', () => {
    expect(mcpToolFqn('git-tools', 'git_status')).toBe('mcp__git-tools__git_status')
  })

  it('sanitizes invalid characters into the API charset, keeping colliding inputs distinct', () => {
    const spaced = mcpToolFqn('a b', 'c')
    const dotted = mcpToolFqn('a.b', 'c')
    expect(spaced).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    expect(dotted).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    expect(spaced).not.toBe(dotted)
  })

  it('truncates a long name to the exact 55 + _ + 8-hex shape', () => {
    const name = mcpToolFqn('s'.repeat(90), 't')
    expect(name).toHaveLength(64)
    expect(name).toMatch(/^[A-Za-z0-9_-]{55}_[0-9a-f]{8}$/)
    expect(name).toBe(mcpToolFqn('s'.repeat(90), 't'))
  })

  it('produces an API-safe name for empty and non-ASCII inputs', () => {
    expect(mcpToolFqn('', '')).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    expect(mcpToolFqn('🚀 server', 't')).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
  })

  it('is deterministic for the same input and keeps the mcp__ prefix', () => {
    expect(mcpToolFqn('a', 'b')).toBe(mcpToolFqn('a', 'b'))
    expect(mcpToolFqn('a b', 'c')).toMatch(/^mcp__/)
    expect(mcpToolFqn('s'.repeat(90), 't')).toMatch(/^mcp__/)
  })
})
