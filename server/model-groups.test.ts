import { describe, expect, it } from 'vitest'
import {
  capabilitiesForTier,
  fallbackAliasesFor,
  isOpaqueModel,
  resolveConfiguredModelId,
  resolveGroup,
} from './model-groups.js'

describe('resolveGroup', () => {
  const resolve = (m: string) => (m === 'opus-model' ? 'provider/opus-model' : m)
  const base = {
    id: 'g1', name: 'G1',
    opus: 'opus-model', sonnet: 'sonnet-model', haiku: 'haiku-model',
  }

  it('defaults main to the opus slot and resolves bare names through resolve', () => {
    const r = resolveGroup(base, resolve)
    expect(r.main).toBe('provider/opus-model')
    expect(r.tiers).toEqual({ opus: 'provider/opus-model', sonnet: 'sonnet-model', haiku: 'haiku-model' })
  })

  it('falls empty slots back to the main model', () => {
    const r = resolveGroup({ id: 'g2', name: 'G2', opus: 'op' }, resolve)
    expect(r.tiers).toEqual({ opus: 'op', sonnet: 'op', haiku: 'op' })
    expect(r.main).toBe('op')
  })

  it('honors main=sonnet', () => {
    const r = resolveGroup({ ...base, main: 'sonnet' }, resolve)
    expect(r.main).toBe('sonnet-model')
  })
})

describe('isOpaqueModel', () => {
  it('recognizes keyword classes and flags opaque gateway ids', () => {
    expect(isOpaqueModel('claude-opus-4-20250514')).toBe(false)
    expect(isOpaqueModel('claude-sonnet-4-20250514')).toBe(false)
    expect(isOpaqueModel('claude-haiku-3-5-20241022')).toBe(false)
    expect(isOpaqueModel('anthropic/claude-opus-4-20250514')).toBe(false)
    expect(isOpaqueModel('gateway-xyz-9')).toBe(true)
    expect(isOpaqueModel('deepseek/deepseek-v4-flash')).toBe(true)
  })
})

describe('capabilitiesForTier', () => {
  it('returns the slot-class token list for opaque models', () => {
    expect(capabilitiesForTier('opus', 'gateway-xyz-9')).toEqual([
      'effort', 'xhigh_effort', 'max_effort', 'thinking', 'adaptive_thinking', 'interleaved_thinking',
    ])
    expect(capabilitiesForTier('sonnet', 'gateway-xyz-9')).toEqual([
      'effort', 'max_effort', 'thinking', 'adaptive_thinking', 'interleaved_thinking',
    ])
    expect(capabilitiesForTier('haiku', 'gateway-xyz-9')).toEqual([])
  })

  it('skips recognizable ids (let the CLI detect)', () => {
    expect(capabilitiesForTier('opus', 'claude-opus-4-20250514')).toEqual([])
    expect(capabilitiesForTier('sonnet', 'claude-sonnet-4-20250514')).toEqual([])
  })
})

describe('fallbackAliasesFor', () => {
  it('derives the degradation chain below the main slot', () => {
    expect(fallbackAliasesFor('opus')).toEqual(['sonnet', 'haiku'])
    expect(fallbackAliasesFor('sonnet')).toEqual(['haiku'])
    expect(fallbackAliasesFor('haiku')).toEqual([])
  })
})

describe('resolveConfiguredModelId', () => {
  const list = ['anthropic/claude-opus-4-20250514', 'claude-haiku-3-5-20241022']

  it('resolves bare short names and passes prefixed ids through unchanged', () => {
    expect(resolveConfiguredModelId('claude-opus-4-20250514', list)).toBe('anthropic/claude-opus-4-20250514')
    expect(resolveConfiguredModelId('anthropic/claude-opus-4-20250514', list)).toBe('anthropic/claude-opus-4-20250514')
    expect(resolveConfiguredModelId('no-such-model', list)).toBe('no-such-model')
    expect(resolveConfiguredModelId(undefined, list)).toBeUndefined()
  })
})
