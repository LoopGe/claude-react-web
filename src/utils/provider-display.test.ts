import { describe, expect, it } from 'vitest'
import { PROVIDER_LABELS, providerDescription, providerLabel } from './provider-display'

describe('providerLabel', () => {
  it('labels the two built-in providers', () => {
    expect(providerLabel('claude')).toBe('Claude CLI')
    expect(providerLabel('native')).toBe('Native in-process')
    expect(PROVIDER_LABELS).toEqual({ claude: 'Claude CLI', native: 'Native in-process' })
  })

  it('treats a missing provider as the server default (Claude CLI)', () => {
    expect(providerLabel(undefined)).toBe('Claude CLI')
    // Persisted metas can carry an empty string after a hand-edited file.
    expect(providerLabel('')).toBe('Claude CLI')
  })

  it('passes an unknown provider name through raw', () => {
    expect(providerLabel('my-provider')).toBe('my-provider')
  })
})

describe('providerDescription', () => {
  it('spells out the in-process vs subprocess difference', () => {
    expect(providerDescription('native')).toContain('in-process')
    expect(providerDescription('native')).toContain('no Claude CLI subprocess')
    expect(providerDescription('claude')).toContain('Claude CLI as a subprocess')
    expect(providerDescription(undefined)).toContain('Claude CLI as a subprocess')
  })

  it('names an unknown provider instead of mislabelling it', () => {
    expect(providerDescription('my-provider')).toContain('my-provider')
  })
})
