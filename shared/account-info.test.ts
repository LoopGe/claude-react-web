import { describe, it, expect } from 'vitest'
import { coerceAccountInfo, ACCOUNT_PROVIDER_LABELS } from './account-info.js'

describe('coerceAccountInfo', () => {
  it('passes through a full first-party response, stripped to known keys', () => {
    expect(
      coerceAccountInfo({
        email: 'user@example.com',
        organization: 'Acme',
        subscriptionType: 'pro',
        tokenSource: 'oauth',
        apiKeySource: 'env',
        apiProvider: 'firstParty',
        unknownExtra: 'dropped',
      }),
    ).toEqual({
      email: 'user@example.com',
      organization: 'Acme',
      subscriptionType: 'pro',
      tokenSource: 'oauth',
      apiKeySource: 'env',
      apiProvider: 'firstParty',
    })
  })

  it('keeps sparse third-party responses (apiProvider only)', () => {
    expect(coerceAccountInfo({ apiProvider: 'bedrock' })).toEqual({ apiProvider: 'bedrock' })
    expect(coerceAccountInfo({ apiProvider: 'gateway' })).toEqual({ apiProvider: 'gateway' })
  })

  it('drops non-string / blank fields but keeps valid siblings', () => {
    expect(
      coerceAccountInfo({ email: 42, organization: '   ', subscriptionType: 'max', tokenSource: null }),
    ).toEqual({ subscriptionType: 'max' })
  })

  it('drops an unrecognized apiProvider enum', () => {
    expect(coerceAccountInfo({ apiProvider: 'not-a-provider' })).toBeUndefined()
    expect(coerceAccountInfo({ apiProvider: 'firstParty', email: 'a@b.c' })).toEqual({
      email: 'a@b.c',
      apiProvider: 'firstParty',
    })
  })

  it('collapses entirely malformed values to undefined', () => {
    expect(coerceAccountInfo(undefined)).toBeUndefined()
    expect(coerceAccountInfo(null)).toBeUndefined()
    expect(coerceAccountInfo('oauth')).toBeUndefined()
    expect(coerceAccountInfo({})).toBeUndefined()
  })

  it('has a display label for every provider enum value', () => {
    const providers = [
      'firstParty', 'bedrock', 'vertex', 'foundry', 'anthropicAws', 'mantle', 'gateway',
    ] as const
    for (const p of providers) {
      expect(typeof ACCOUNT_PROVIDER_LABELS[p]).toBe('string')
      expect(ACCOUNT_PROVIDER_LABELS[p].length).toBeGreaterThan(0)
    }
  })
})
