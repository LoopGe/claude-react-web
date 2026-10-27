import { describe, expect, it } from 'vitest'
import {
  matchSearchHit,
  parseOwnerRepo,
  policyToDynamicSkillOverrides,
  policyToInitialSkillsOption,
  projectRootOfSkill,
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

describe('parseOwnerRepo', () => {
  it('accepts owner/repo shorthand', () => {
    expect(parseOwnerRepo('vercel-labs/agent-skills')).toEqual({ owner: 'vercel-labs', repo: 'agent-skills' })
  })
  it('accepts a github.com URL and strips .git', () => {
    expect(parseOwnerRepo('https://github.com/vercel-labs/agent-skills.git')).toEqual({ owner: 'vercel-labs', repo: 'agent-skills' })
  })
  it('rejects non-github hosts and bare words', () => {
    expect(parseOwnerRepo('https://gitlab.com/a/b')).toBeNull()
    expect(parseOwnerRepo('react')).toBeNull()
    expect(parseOwnerRepo('a/b/c')).toBeNull()
  })
})

describe('matchSearchHit', () => {
  const skills = [
    { name: 'pdf', description: '', relativePath: 'skills/pdf' },
    { name: 'docx', description: '', relativePath: 'skills/docx' },
    { name: 'pdf', description: '', relativePath: 'other/pdf' },
  ]
  it('prefers basename(relativePath) === skillId', () => {
    const r = matchSearchHit(skills, { skillId: 'docx', name: 'pdf' })
    expect(r.skill?.relativePath).toBe('skills/docx')
    expect(r.matchCount).toBe(1)
  })
  it('falls back to discovered name when skillId misses', () => {
    const r = matchSearchHit([{ name: 'pdf', description: '', relativePath: 'skills/pdf' }], { skillId: 'nope', name: 'pdf' })
    expect(r.skill?.relativePath).toBe('skills/pdf')
    expect(r.matchCount).toBe(1)
  })
  it('returns zero matches when neither skillId nor name matches', () => {
    const r = matchSearchHit(skills, { skillId: 'zzz', name: 'yyy' })
    expect(r.skill).toBeNull()
    expect(r.matchCount).toBe(0)
  })
  it('reports matchCount above 1 when several dirs share a basename', () => {
    const r = matchSearchHit(skills, { skillId: 'pdf', name: 'pdf' })
    expect(r.matchCount).toBe(2)
    expect(r.skill?.relativePath).toBe('skills/pdf')  // first in order
  })
})

describe('projectRootOfSkill', () => {
  it('strips the .claude/skills tail from a project skill path', () => {
    expect(projectRootOfSkill({ scope: 'project', path: '/work/proj/.claude/skills/find-skills/SKILL.md' })).toBe('/work/proj')
  })

  it('handles Windows backslash paths', () => {
    expect(projectRootOfSkill({ scope: 'project', path: 'C:\\proj\\.claude\\skills\\demo\\SKILL.md' })).toBe('C:\\proj')
  })

  it('returns null for user scope and for paths outside a skills root', () => {
    expect(projectRootOfSkill({ scope: 'user', path: '/home/u/.claude/skills/demo/SKILL.md' })).toBeNull()
    expect(projectRootOfSkill({ scope: 'project', path: '/elsewhere/SKILL.md' })).toBeNull()
  })
})
