import { describe, expect, it } from 'vitest'
import {
  policyToDynamicSkillOverrides,
  policyToInitialSkillsOption,
  resolveEffectiveSkillPolicy,
  type SessionSkillOverride,
} from './skills.js'

describe('resolveEffectiveSkillPolicy', () => {
  it('inherits the global default mode when no override is present', () => {
    expect(resolveEffectiveSkillPolicy(undefined, 'default', [])).toEqual({
      mode: 'default',
      allowlist: [],
    })
  })

  it('inherits the global all mode', () => {
    expect(resolveEffectiveSkillPolicy({ kind: 'inherit' }, 'all', ['a', 'b'])).toEqual({
      mode: 'all',
      allowlist: ['a', 'b'],
    })
  })

  it('inherits the global allowlist mode', () => {
    expect(
      resolveEffectiveSkillPolicy({ kind: 'inherit' }, 'allowlist', ['scout', 'gardener']),
    ).toEqual({ mode: 'allowlist', allowlist: ['scout', 'gardener'] })
  })

  it('returns disabled when the session pinned disabled regardless of global', () => {
    for (const global of ['default', 'all', 'allowlist'] as const) {
      expect(resolveEffectiveSkillPolicy({ kind: 'disabled' }, global, ['x'])).toEqual({
        mode: 'disabled',
        allowlist: [],
      })
    }
  })

  it('returns the session-pinned mode and allowlist when overridden', () => {
    const override: SessionSkillOverride = {
      kind: 'mode',
      mode: 'allowlist',
      allowlist: ['only-this-one'],
    }
    expect(resolveEffectiveSkillPolicy(override, 'all', ['ignored'])).toEqual({
      mode: 'allowlist',
      allowlist: ['only-this-one'],
    })
  })

  it('clones the allowlist arrays so callers cannot mutate config state', () => {
    const globalAllowlist = ['shared']
    const r1 = resolveEffectiveSkillPolicy({ kind: 'inherit' }, 'allowlist', globalAllowlist)
    r1.allowlist.push('mutated')
    expect(globalAllowlist).toEqual(['shared'])

    const sessionList = ['only']
    const r2 = resolveEffectiveSkillPolicy(
      { kind: 'mode', mode: 'allowlist', allowlist: sessionList },
      'default',
      [],
    )
    r2.allowlist.push('mutated')
    expect(sessionList).toEqual(['only'])
  })

  it('falls back to an empty allowlist when override.allowlist is undefined', () => {
    expect(
      resolveEffectiveSkillPolicy({ kind: 'mode', mode: 'allowlist' }, 'all', ['ignored']),
    ).toEqual({ mode: 'allowlist', allowlist: [] })
  })
})

describe('policyToInitialSkillsOption', () => {
  it("returns 'all' when mode is 'all'", () => {
    expect(policyToInitialSkillsOption({ mode: 'all', allowlist: [] })).toBe('all')
  })

  it('returns the allowlist array (cloned) when mode is allowlist', () => {
    const list = ['a', 'b']
    const out = policyToInitialSkillsOption({ mode: 'allowlist', allowlist: list })
    expect(out).toEqual(['a', 'b'])
    ;(out as string[]).push('c')
    expect(list).toEqual(['a', 'b'])
  })

  it('returns an empty array when mode is disabled (no skills loaded at spawn)', () => {
    expect(policyToInitialSkillsOption({ mode: 'disabled', allowlist: [] })).toEqual([])
  })

  it("returns undefined for 'default' so the SDK picks its own behavior", () => {
    expect(policyToInitialSkillsOption({ mode: 'default', allowlist: [] })).toBeUndefined()
  })
})

describe('policyToDynamicSkillOverrides', () => {
  const available = ['scout', 'gardener', 'librarian']

  it("returns undefined for 'default' so the flag layer can be cleared", () => {
    expect(
      policyToDynamicSkillOverrides({ mode: 'default', allowlist: [] }, available),
    ).toBeUndefined()
  })

  it("flips every available skill to 'on' for 'all'", () => {
    expect(policyToDynamicSkillOverrides({ mode: 'all', allowlist: [] }, available)).toEqual({
      scout: 'on',
      gardener: 'on',
      librarian: 'on',
    })
  })

  it("flips every available skill to 'off' for 'disabled'", () => {
    expect(
      policyToDynamicSkillOverrides({ mode: 'disabled', allowlist: [] }, available),
    ).toEqual({ scout: 'off', gardener: 'off', librarian: 'off' })
  })

  it('flips listed allowlist entries on and the rest off', () => {
    expect(
      policyToDynamicSkillOverrides(
        { mode: 'allowlist', allowlist: ['scout', 'librarian'] },
        available,
      ),
    ).toEqual({ scout: 'on', gardener: 'off', librarian: 'on' })
  })

  it('handles allowlist entries that are not present in the available set', () => {
    expect(
      policyToDynamicSkillOverrides(
        { mode: 'allowlist', allowlist: ['ghost'] },
        available,
      ),
    ).toEqual({ scout: 'off', gardener: 'off', librarian: 'off' })
  })
})
