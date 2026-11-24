import { describe, expect, it } from 'vitest'
import type { UpdateInfo } from '../../shared/update-info'
import { mergeUpdateInfoSnapshot } from './update-info-merge'

const BASE: UpdateInfo = {
  current: '1.0.0',
  packageName: 'claude-react-web',
  installMethod: 'global',
  hasUpdate: false,
  source: 'npm',
}
const info = (over: Partial<UpdateInfo> = {}): UpdateInfo => ({ ...BASE, ...over })

const OVERLAYS = {
  repoUrl: 'https://github.com/LoopGe/claude-react-web',
  claudeCli: { ok: true, version: '2.1.311' },
  agentSdk: { version: '0.3.311' },
} as const

describe('mergeUpdateInfoSnapshot', () => {
  it('rule 1: prev null → incoming wholesale', () => {
    const incoming = info({ latest: '1.1.0', checkedAt: 100, ...OVERLAYS })
    expect(mergeUpdateInfoSnapshot(null, incoming)).toEqual(incoming)
  })

  it('rule 2: disabled incoming always applies, even over a checked prev', () => {
    const prev = info({ latest: '1.1.0', hasUpdate: true, checkedAt: 200 })
    const merged = mergeUpdateInfoSnapshot(prev, info({ disabled: true }))
    expect(merged.disabled).toBe(true)
    expect(merged.latest).toBeUndefined()
  })

  it('rule 3: a checking placeholder cannot clobber a checked snapshot', () => {
    const prev = info({ latest: '1.1.0', hasUpdate: true, checkedAt: 200 })
    const merged = mergeUpdateInfoSnapshot(prev, info({ checking: true }))
    expect(merged.latest).toBe('1.1.0')
    expect(merged.checkedAt).toBe(200)
  })

  it('rule 4: a stale GET core (older checkedAt) is rejected', () => {
    const prev = info({ latest: '1.2.0', hasUpdate: true, checkedAt: 300 })
    const merged = mergeUpdateInfoSnapshot(prev, info({ latest: '1.1.0', hasUpdate: true, checkedAt: 200 }))
    expect(merged.latest).toBe('1.2.0')
    expect(merged.checkedAt).toBe(300)
  })

  it('rule 5: a fresher incoming core applies', () => {
    const prev = info({ latest: '1.1.0', checkedAt: 200 })
    const merged = mergeUpdateInfoSnapshot(prev, info({ latest: '1.2.0', checkedAt: 300 }))
    expect(merged.latest).toBe('1.2.0')
  })

  it('rule 5 tie: equal checkedAt lets incoming win', () => {
    const prev = info({ latest: '1.1.0', checkedAt: 200 })
    const merged = mergeUpdateInfoSnapshot(prev, info({ latest: '1.2.0', checkedAt: 200 }))
    expect(merged.latest).toBe('1.2.0')
  })

  it('rule 6: a frame after a GET preserves all three overlays', () => {
    const prev = info({ latest: '1.1.0', checkedAt: 200, ...OVERLAYS })
    const merged = mergeUpdateInfoSnapshot(prev, info({ latest: '1.2.0', checkedAt: 300 }))
    expect(merged.latest).toBe('1.2.0')
    expect(merged.repoUrl).toBe(OVERLAYS.repoUrl)
    expect(merged.claudeCli).toEqual(OVERLAYS.claudeCli)
    expect(merged.agentSdk).toEqual(OVERLAYS.agentSdk)
  })

  it('rule 6: a stale GET still refreshes overlays while its core is rejected', () => {
    const prev = info({ latest: '1.2.0', checkedAt: 300 }) // frame-derived, no overlays
    const merged = mergeUpdateInfoSnapshot(prev, info({ latest: '1.1.0', checkedAt: 200, ...OVERLAYS }))
    expect(merged.latest).toBe('1.2.0') // core fenced
    expect(merged.repoUrl).toBe(OVERLAYS.repoUrl) // overlays merged
    expect(merged.agentSdk).toEqual(OVERLAYS.agentSdk)
  })

  it('disabled incoming clears latest but keeps overlays', () => {
    const prev = info({ latest: '1.1.0', checkedAt: 200, ...OVERLAYS })
    const merged = mergeUpdateInfoSnapshot(prev, info({ disabled: true }))
    expect(merged.latest).toBeUndefined()
    expect(merged.repoUrl).toBe(OVERLAYS.repoUrl)
    expect(merged.claudeCli).toEqual(OVERLAYS.claudeCli)
  })

  it('overlays absent on both stay absent', () => {
    const merged = mergeUpdateInfoSnapshot(info({ checkedAt: 100 }), info({ checkedAt: 200 }))
    expect('repoUrl' in merged).toBe(false)
    expect('claudeCli' in merged).toBe(false)
    expect('agentSdk' in merged).toBe(false)
  })
})