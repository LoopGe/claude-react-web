// Tests for the app-level SandboxSetting subset + its strict validator.
// The validator guards the session-create body and the live /sandbox route,
// rejecting unknown keys deep so they can never reach the CLI subprocess.

import { describe, expect, it } from 'vitest'
import { validateSandboxSetting, type SandboxSetting } from './sandbox.js'

const VALID: SandboxSetting = {
  enabled: true,
  autoAllowBashIfSandboxed: false,
  allowUnsandboxedCommands: true,
  failIfUnavailable: false,
  network: { allowedDomains: ['github.com', '*.npmjs.org'] },
  filesystem: { allowWrite: ['/tmp/build'] },
}

describe('validateSandboxSetting', () => {
  it('accepts a fully-populated valid setting and preserves its value', () => {
    const res = validateSandboxSetting(VALID)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.value).toEqual(VALID)
  })

  it('accepts a minimal setting with only enabled', () => {
    const res = validateSandboxSetting({ enabled: true })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.value).toEqual({ enabled: true })
  })

  it('rejects a non-object input', () => {
    for (const bad of ['on', 1, true, null, undefined, [1]]) {
      const res = validateSandboxSetting(bad)
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error).toMatch(/must be an object/)
    }
  })

  it('requires enabled', () => {
    const res = validateSandboxSetting({ autoAllowBashIfSandboxed: true })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/enabled/)
  })

  it('rejects an unknown top-level key', () => {
    const res = validateSandboxSetting({ enabled: true, nonsense: 1 })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/nonsense/)
  })

  it('rejects a non-boolean boolean field', () => {
    for (const key of ['enabled', 'autoAllowBashIfSandboxed', 'allowUnsandboxedCommands', 'failIfUnavailable']) {
      const res = validateSandboxSetting({ enabled: true, [key]: 'yes' })
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error).toMatch(new RegExp(`${key}.*boolean`))
    }
  })

  it('rejects network that is not an object', () => {
    const res = validateSandboxSetting({ enabled: true, network: ['github.com'] })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/network.*object/)
  })

  it('rejects an unknown network key', () => {
    const res = validateSandboxSetting({ enabled: true, network: { allowedDomains: [], denyRead: [] } })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/denyRead|network/)
  })

  it('rejects network.allowedDomains that is not an array of strings', () => {
    for (const bad of [[1, 2], 'github.com', [null]]) {
      const res = validateSandboxSetting({ enabled: true, network: { allowedDomains: bad } })
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error).toMatch(/allowedDomains.*strings/)
    }
  })

  it('rejects filesystem that is not an object', () => {
    const res = validateSandboxSetting({ enabled: true, filesystem: '/tmp' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/filesystem.*object/)
  })

  it('rejects an unknown filesystem key', () => {
    const res = validateSandboxSetting({ enabled: true, filesystem: { allowWrite: [], denyWrite: [] } })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/denyWrite|filesystem/)
  })

  it('rejects filesystem.allowWrite that is not an array of strings', () => {
    for (const bad of ['/tmp', 5, [{}]]) {
      const res = validateSandboxSetting({ enabled: true, filesystem: { allowWrite: bad } })
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error).toMatch(/allowWrite.*strings/)
    }
  })

  it('accepts empty network/filesystem objects', () => {
    const res = validateSandboxSetting({ enabled: true, network: {}, filesystem: {} })
    expect(res.ok).toBe(true)
  })
})