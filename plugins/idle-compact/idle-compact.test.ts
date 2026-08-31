import { describe, expect, it } from 'vitest'
import { resolve as resolvePath } from 'node:path'
// Import the plugin's pure helper directly (vitest can import .mjs). The file
// is fixture/plugin code (ignored by eslint), but its logic is the idle-compact
// contract — worth locking with tests.
import { shouldCompact } from './dist/decide.mjs'
import { loadManifest } from '../../server/app-plugins/manifest-loader.js'

const DEFAULTS = {
  'idle-compact.claude-react-web.enabled': true,
  'idle-compact.claude-react-web.idleMinutes': 10,
  'idle-compact.claude-react-web.thresholdPercent': 90,
  'idle-compact.claude-react-web.minHistoryMessages': 20,
}

// 10 minutes of idle + enough history + a full-ish context.
const base = {
  idleMs: 10 * 60_000,
  historyLength: 50,
  usage: { totalTokens: 90_000, percentage: 90, model: 'm', maxTokens: 100_000, rawMaxTokens: 100_000, autoCompactThreshold: 100_000 },
  config: DEFAULTS,
}

describe('idle-compact — shouldCompact', () => {
  it('compacts a session that is idle, thick, and at threshold', () => {
    expect(shouldCompact(base)).toBe(true)
  })

  it('does not compact before the idle window elapses', () => {
    expect(shouldCompact({ ...base, idleMs: 10 * 60_000 - 1 })).toBe(false)
    expect(shouldCompact({ ...base, idleMs: 0 })).toBe(false)
  })

  it('does not compact thin conversations', () => {
    expect(shouldCompact({ ...base, historyLength: 19 })).toBe(false)
  })

  it('returns false with no context-usage snapshot', () => {
    expect(shouldCompact({ ...base, usage: null })).toBe(false)
  })

  it('returns false when totalTokens is zero/absent', () => {
    expect(shouldCompact({ ...base, usage: { ...base.usage, totalTokens: 0 } })).toBe(false)
    expect(shouldCompact({ ...base, usage: { percentage: 95, model: 'm' } })).toBe(false)
  })

  it('uses autoCompactThreshold when present (boundary at thresholdPercent%)', () => {
    // threshold 100k, 90% → compact at >= 90k.
    expect(shouldCompact({ ...base, usage: { ...base.usage, autoCompactThreshold: 100_000, totalTokens: 89_999 } })).toBe(false)
    expect(shouldCompact({ ...base, usage: { ...base.usage, autoCompactThreshold: 100_000, totalTokens: 90_000 } })).toBe(true)
    expect(shouldCompact({ ...base, usage: { ...base.usage, autoCompactThreshold: 200_000, totalTokens: 180_000 } })).toBe(true)
  })

  it('falls back to percentage when autoCompactThreshold is absent', () => {
    const noThreshold = { ...base.usage, autoCompactThreshold: undefined }
    expect(shouldCompact({ ...base, usage: { ...noThreshold, percentage: 89 } })).toBe(false)
    expect(shouldCompact({ ...base, usage: { ...noThreshold, percentage: 90 } })).toBe(true)
  })

  it('returns false when neither threshold nor percentage is usable', () => {
    expect(shouldCompact({ ...base, usage: { totalTokens: 100, model: 'm', maxTokens: 1000, rawMaxTokens: 1000 } })).toBe(false)
  })

  it('respects the enabled master switch', () => {
    expect(shouldCompact({ ...base, config: { ...DEFAULTS, 'idle-compact.claude-react-web.enabled': false } })).toBe(false)
  })

  it('honours configurable idle window / history / threshold', () => {
    const tight = {
      ...DEFAULTS,
      'idle-compact.claude-react-web.idleMinutes': 1,
      'idle-compact.claude-react-web.minHistoryMessages': 5,
      'idle-compact.claude-react-web.thresholdPercent': 50,
    }
    expect(
      shouldCompact({
        idleMs: 61_000,
        historyLength: 6,
        usage: { totalTokens: 50_001, percentage: 51, model: 'm', maxTokens: 100_000, rawMaxTokens: 100_000, autoCompactThreshold: 100_000 },
        config: tight,
      }),
    ).toBe(true)
    expect(
      shouldCompact({
        idleMs: 61_000,
        historyLength: 6,
        usage: { totalTokens: 49_999, percentage: 49, model: 'm', maxTokens: 100_000, rawMaxTokens: 100_000, autoCompactThreshold: 100_000 },
        config: tight,
      }),
    ).toBe(false)
  })

  it('returns false for a null/undefined config', () => {
    expect(shouldCompact({ ...base, config: null })).toBe(false)
  })
})

describe('idle-compact — manifest', () => {
  it('loads and validates against the host', async () => {
    const dir = resolvePath(__dirname, '..', 'idle-compact')
    const { manifest, validation } = await loadManifest(dir, { hostVersion: '0.7.0', hostNodeMajor: 22 })
    expect(manifest.id).toBe('idle-compact.claude-react-web')
    expect(manifest.activationEvents).toContain('onStartup')
    expect(manifest.permissions).toContain('sessions.read')
    expect(manifest.permissions).toContain('sessions.compact')
    expect(validation.ok).toBe(true)
    expect(validation.errors).toEqual([])
  })
})
