import { describe, expect, it } from 'vitest'
import { cliSupportsSteeringVersion } from './claude-provider.js'

describe('cliSupportsSteeringVersion', () => {
  it('accepts 2.1.110 and newer, rejects older/unparsable', () => {
    expect(cliSupportsSteeringVersion('2.1.110')).toBe(true)
    expect(cliSupportsSteeringVersion('2.1.296 (Claude Code)')).toBe(true)
    expect(cliSupportsSteeringVersion('2.2.0')).toBe(true)
    expect(cliSupportsSteeringVersion('3.0.0')).toBe(true)
    expect(cliSupportsSteeringVersion('2.1.109')).toBe(false)
    expect(cliSupportsSteeringVersion('2.0.0')).toBe(false)
    expect(cliSupportsSteeringVersion('1.0.0')).toBe(false)
    expect(cliSupportsSteeringVersion(undefined)).toBe(false)
    expect(cliSupportsSteeringVersion('garbage')).toBe(false)
    expect(cliSupportsSteeringVersion('')).toBe(false)
  })
})
