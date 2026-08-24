import { describe, it, expect } from 'vitest'
import { effortLevelsForModel, supportsThinkingForModel } from './effort-capability.js'

describe('effortLevelsForModel', () => {
  it('returns all 5 levels for opus-family ids (incl. provider prefixes)', () => {
    const all = ['low', 'medium', 'high', 'xhigh', 'max']
    expect(effortLevelsForModel('claude-opus-4-20250514')).toEqual(all)
    expect(effortLevelsForModel('ppio/pa/claude-opus-4-8')).toEqual(all)
    expect(effortLevelsForModel('anthropic/claude-opus-4-7')).toEqual(all)
  })

  it('omits xhigh for sonnet-family ids', () => {
    const sonnet = ['low', 'medium', 'high', 'max']
    expect(effortLevelsForModel('anthropic/claude-sonnet-4-20250514')).toEqual(sonnet)
    expect(effortLevelsForModel('claude-sonnet-4-6')).toEqual(sonnet)
  })

  it('returns [] for haiku (no effort support)', () => {
    expect(effortLevelsForModel('claude-haiku-3-5-20241022')).toEqual([])
    expect(effortLevelsForModel('anthropic/claude-haiku-4-5')).toEqual([])
  })

  it('returns [] for non-Claude / unknown models', () => {
    expect(effortLevelsForModel('xiaomi/mimo-v2.5-pro')).toEqual([])
    expect(effortLevelsForModel('deepseek/deepseek-v4-pro')).toEqual([])
    expect(effortLevelsForModel('gpt-5')).toEqual([])
  })

  it('is case-insensitive', () => {
    expect(effortLevelsForModel('PPIO/PA/Claude-OPUS-4-8')).toEqual([
      'low', 'medium', 'high', 'xhigh', 'max',
    ])
    expect(effortLevelsForModel('Claude-SONNET-4')).toEqual(['low', 'medium', 'high', 'max'])
  })

  it('returns undefined when no model is set (capability unknown)', () => {
    expect(effortLevelsForModel(undefined)).toBeUndefined()
    expect(effortLevelsForModel('')).toBeUndefined()
  })

  it('prefers opus over sonnet if both somehow appear (opus wins)', () => {
    // Defensive: opus is checked first. A pathological id won't misclassify
    // into the smaller sonnet set.
    expect(effortLevelsForModel('claude-opus-sonnet-weird')).toEqual([
      'low', 'medium', 'high', 'xhigh', 'max',
    ])
  })
})

describe('supportsThinkingForModel', () => {
  it('returns true for opus / sonnet family ids (incl. provider prefixes)', () => {
    expect(supportsThinkingForModel('claude-opus-4-8')).toBe(true)
    expect(supportsThinkingForModel('ppio/pa/claude-opus-4-8')).toBe(true)
    expect(supportsThinkingForModel('anthropic/claude-sonnet-4-6')).toBe(true)
  })

  it('returns false for haiku and non-Claude models (fail soft → hide chip)', () => {
    expect(supportsThinkingForModel('claude-haiku-4-5')).toBe(false)
    expect(supportsThinkingForModel('deepseek/deepseek-v4-pro')).toBe(false)
    expect(supportsThinkingForModel('xiaomi/mimo-v2.5-pro')).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(supportsThinkingForModel('PPIO/PA/Claude-OPUS-4-8')).toBe(true)
    expect(supportsThinkingForModel('Claude-SONNET-4')).toBe(true)
  })

  it('returns undefined when no model is set (capability unknown → chip shown)', () => {
    expect(supportsThinkingForModel(undefined)).toBeUndefined()
    expect(supportsThinkingForModel('')).toBeUndefined()
  })
})
