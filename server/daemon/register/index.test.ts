import { describe, it, expect } from 'vitest'
import { getPlatformRegister } from './index.js'

describe('platform dispatch', () => {
  it('returns one of the three known mechanisms for the current platform', () => {
    const reg = getPlatformRegister()
    expect(['schtasks', 'launchd', 'systemd']).toContain(reg.mechanism)
  })

  it('caches the platform decision (same object on repeated calls)', () => {
    expect(getPlatformRegister()).toBe(getPlatformRegister())
  })
})
