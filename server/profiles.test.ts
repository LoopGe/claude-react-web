import { describe, expect, it } from 'vitest'
import type { ModelGroupConfig, ProviderProfile } from './config.js'
import {
  coerceModelGroups, coerceProfileEntries, coerceProfiles, findProfile, maskToken,
  normalizeModelList, profileDefaultModel, profileFromLegacyFields, resolveActiveProfile,
} from './profiles.js'

const FALLBACK: ProviderProfile = {
  id: 'default', name: 'Default', authToken: '',
  baseUrl: 'https://api.anthropic.com',
  modelList: ['anthropic/claude-sonnet-4-20250514'],
  // Deliberately NOT '' even though the real DEFAULT_PROFILE is: the test
  // below asserts that a missing field is filled FROM this fallback, which
  // '' vs '' cannot distinguish. The shipped value is locked separately by
  // the DEFAULT_PROFILE contract test.
  modelGroups: [], recapModel: 'fb/recap', commitMessageModel: 'fb/commit',
}
const P = (id: string, modelList: string[] = ['a/' + id]): ProviderProfile =>
  ({ ...FALLBACK, id, name: 'P ' + id, modelList })

describe('normalizeModelList', () => {
  // The single definition of "which model ids does this list actually have",
  // shared by the reader and every writer so the rule cannot drift.
  it('keeps the usable ids and drops blanks', () => {
    expect(normalizeModelList(['a', '', '  ', 'b'], ['fb'])).toEqual(['a', 'b'])
  })

  it('falls back when nothing usable survives — including an all-blank list', () => {
    expect(normalizeModelList(['', '   '], ['fb'])).toEqual(['fb'])
    expect(normalizeModelList([], ['fb'])).toEqual(['fb'])
    expect(normalizeModelList(undefined, ['fb'])).toEqual(['fb'])
    expect(normalizeModelList('nope', ['fb'])).toEqual(['fb'])
  })

  it('trims the ids it keeps', () => {
    // Every sibling field (id, name, baseUrl, authToken, recap/commit) is
    // trimmed. A space-padded model id would be stored, become defaultModel, and
    // spawn sessions with it — a gateway error the user cannot see the cause of.
    expect(normalizeModelList([' a ', 'b'], ['fb'])).toEqual(['a', 'b'])
  })

  it('returns a mutable copy of the fallback, not the fallback itself', () => {
    const fb = ['fb']
    const out = normalizeModelList(undefined, fb)
    out.push('x')
    expect(fb).toEqual(['fb'])
  })
})

describe('coerceProfileEntries', () => {
  // The raw index is what lets a WRITER reach the same entry the reader
  // resolves. It has to survive coercion exactly: malformed entries dropped,
  // ids trimmed, duplicate ids resolved last-wins.
  const raw = (id: unknown, name: unknown) => ({ id, name })

  it('reports the raw index of each surviving entry', () => {
    const entries = coerceProfileEntries([raw('a', 'A'), { garbage: true }, raw('b', 'B')], FALLBACK)
    expect(entries.map((e) => [e.profile.id, e.index])).toEqual([['a', 0], ['b', 2]])
  })

  it('reports the LAST index for a duplicate id, matching the dedup', () => {
    const entries = coerceProfileEntries([raw('dup', 'First'), raw('dup', 'Second')], FALLBACK)
    expect(entries).toHaveLength(1)
    expect(entries[0].index).toBe(1)
    expect(entries[0].profile.name).toBe('Second')
  })

  it('trims the id on the profile but keeps the untrimmed raw index', () => {
    const entries = coerceProfileEntries([raw('a', 'A'), raw(' p ', 'P')], FALLBACK)
    expect(entries[1].index).toBe(1)
    expect(entries[1].profile.id).toBe('p')
  })

  it('coerces to the spelled-out expected profiles', () => {
    // Asserted against a concrete expectation, NOT against coerceProfileEntries:
    // coerceProfiles IS `coerceProfileEntries(...).map(e => e.profile)`, so
    // comparing the two would pass for any coercion result at all — including a
    // wrong one. Duplicate id → LAST wins; padded id → trimmed; malformed dropped.
    const input = [raw('a', 'A'), { garbage: true }, raw('p', 'P'), raw('a', 'A2')]
    const expected = [
      { ...FALLBACK, id: 'a', name: 'A2' },
      { ...FALLBACK, id: 'p', name: 'P' },
    ]
    expect(coerceProfiles(input, FALLBACK)).toEqual(expected)
    expect(coerceProfileEntries(input, FALLBACK).map((e) => e.profile)).toEqual(expected)
  })

  it('falls back to the fallback list for an all-blank stored modelList', () => {
    // [''] has length > 0 but no usable id — deciding on the raw length would
    // coerce to [], and `modelList: []` reads as "unset" downstream
    // (defaultModel becomes '').
    const entries = coerceProfileEntries([{ id: 'a', name: 'A', modelList: ['', '  '] }], FALLBACK)
    expect(entries[0].profile.modelList).toEqual(FALLBACK.modelList)
  })

  it('returns nothing for a non-array', () => {
    expect(coerceProfileEntries(undefined, FALLBACK)).toEqual([])
  })
})

describe('resolveActiveProfile', () => {
  it('returns the active profile by id', () => {
    const profiles = [P('one'), P('two')]
    expect(resolveActiveProfile(profiles, 'two', FALLBACK).id).toBe('two')
  })
  it('falls back to profiles[0] on a dangling activeProfileId', () => {
    expect(resolveActiveProfile([P('one')], 'missing', FALLBACK).id).toBe('one')
  })
  it('falls back to the synthetic profile when profiles is empty', () => {
    expect(resolveActiveProfile([], 'default', FALLBACK)).toBe(FALLBACK)
  })
})

describe('findProfile / profileDefaultModel', () => {
  it('finds by id and returns undefined when absent', () => {
    const profiles = [P('one')]
    expect(findProfile(profiles, 'one')?.id).toBe('one')
    expect(findProfile(profiles, 'nope')).toBeUndefined()
    expect(findProfile(profiles, undefined)).toBeUndefined()
  })
  it('profileDefaultModel is modelList[0] or empty', () => {
    expect(profileDefaultModel(P('one'))).toBe('a/one')
    expect(profileDefaultModel({ ...P('one'), modelList: [] })).toBe('')
  })
})

describe('coerceProfiles', () => {
  it('DEFAULT_PROFILE leaves the auxiliary models unset (empty = session model)', async () => {
    // Contract lock: the real fallback must stay empty. When it held a
    // hardcoded id ('claude-haiku-4-5-20251001'), every profile with an
    // unset recapModel silently inherited it and a third-party gateway
    // answered 401 for a model it has no provider for.
    const { DEFAULT_PROFILE } = await import('./config.js')
    expect(DEFAULT_PROFILE.recapModel).toBe('')
    expect(DEFAULT_PROFILE.commitMessageModel).toBe('')
  })

  it('drops malformed entries and keeps the last duplicate id', () => {
    const raw = [
      { id: '', name: 'x' },                          // dropped: blank id
      'nope',                                          // dropped: not an object
      { id: 'dup', name: 'first', modelList: ['m1'] },
      { id: 'dup', name: 'second', modelList: ['m2'] }, // last wins
    ]
    const out = coerceProfiles(raw, FALLBACK)
    expect(out.map((p) => p.id)).toEqual(['dup'])
    expect(out[0].name).toBe('second')
    expect(out[0].modelList).toEqual(['m2'])
  })
  it('fills missing fields from the fallback and trims baseUrl', () => {
    const out = coerceProfiles([{ id: 'x', name: 'X', baseUrl: 'https://gw.example.com/' }], FALLBACK)
    expect(out[0].baseUrl).toBe('https://gw.example.com')
    expect(out[0].modelList).toEqual(FALLBACK.modelList)
    expect(out[0].recapModel).toBe(FALLBACK.recapModel)
    expect(out[0].authToken).toBe('')
  })
  it('trims a whitespace-padded authToken', () => {
    const out = coerceProfiles([{ id: 'x', name: 'X', authToken: '  sk-ant-abc  ' }], FALLBACK)
    expect(out[0].authToken).toBe('sk-ant-abc')
  })
})

describe('coerceModelGroups', () => {
  it('mirrors the legacy validation: drops malformed, keeps last dup', () => {
    const groups: ModelGroupConfig[] = [
      { id: 'g', name: 'G', opus: 'o', sonnet: 's' },
      { id: 'g', name: 'G2', main: 'sonnet', opus: 'o2' },
    ]
    expect(coerceModelGroups([{ id: 'bad' }, groups[0], groups[1]])).toEqual([
      { id: 'g', name: 'G2', main: 'sonnet', opus: 'o2' },
    ])
  })
})

describe('profileFromLegacyFields', () => {
  it('maps full legacy fields into a default profile', () => {
    const p = profileFromLegacyFields(
      { authToken: 'tok', baseUrl: 'https://gw/', modelList: ['m'], recapModel: 'r', commitMessageModel: 'c', modelGroups: [] },
      FALLBACK,
    )
    expect(p.id).toBe('default')
    expect(p.authToken).toBe('tok')
    expect(p.baseUrl).toBe('https://gw')
    expect(p.modelList).toEqual(['m'])
    expect(p.recapModel).toBe('r')
  })
  it('fills missing fields from the fallback', () => {
    const p = profileFromLegacyFields({}, FALLBACK)
    expect(p.modelList).toEqual(FALLBACK.modelList)
    expect(p.authToken).toBe('')
  })
  it('trims a whitespace-padded authToken', () => {
    const p = profileFromLegacyFields({ authToken: '  sk-ant-abc  ' }, FALLBACK)
    expect(p.authToken).toBe('sk-ant-abc')
  })
})

describe('maskToken', () => {
  it('masks with last-4 suffix and returns undefined for blank', () => {
    expect(maskToken('sk-ant-abcdef')).toBe('****cdef')
    expect(maskToken('')).toBeUndefined()
    expect(maskToken(undefined)).toBeUndefined()
  })
})
