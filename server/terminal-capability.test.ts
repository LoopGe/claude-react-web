import { describe, expect, it } from 'vitest'
import { terminalCapability } from './terminal-capability.js'

describe('terminalCapability', () => {
  it('reports supported on this dev host with prebuilds installed', () => {
    expect(terminalCapability().supported).toBe(true)
  })
  it('caches the probe result (same object identity)', () => {
    expect(terminalCapability()).toBe(terminalCapability())
  })
})
