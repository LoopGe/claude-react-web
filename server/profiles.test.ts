import { describe, expect, it } from 'vitest'
import type { ModelGroupConfig, ProviderProfile } from './config.js'
import {
  coerceModelGroups, coerceProfiles, findProfile, maskToken,
  profileDefaultModel, profileFromLegacyFields, resolveActiveProfile,
} from './profiles.js'

const FALLBACK: ProviderProfile = {
  id: 'default', name: 'Default', authToken: '',
  baseUrl: 'https://api.anthropic.com',
  modelList: ['anthropic/claude-sonnet-4-20250514'],
  modelGroups: [], recapModel: 'claude-haiku-4-5-20251001',
  commitMessageModel: 'claude-haiku-4-5-20251001',
}
const P = (id: string, modelList: string[] = ['a/' + id]): ProviderProfile =>
  ({ ...FALLBACK, id, name: 'P ' + id, modelList })

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
})

describe('maskToken', () => {
  it('masks with last-4 suffix and returns undefined for blank', () => {
    expect(maskToken('sk-ant-abcdef')).toBe('****cdef')
    expect(maskToken('')).toBeUndefined()
    expect(maskToken(undefined)).toBeUndefined()
  })
})
