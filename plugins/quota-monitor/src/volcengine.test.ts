import { describe, expect, it } from 'vitest'
import {
  canonicalQuery,
  deriveRegion,
  parseAfpTiers,
  parseCodingPlanTiers,
  signV4,
} from './volcengine.js'

describe('volcengine canonicalQuery', () => {
  it('sorts keys alphabetically and leaves unreserved chars unencoded', () => {
    expect(canonicalQuery('GetAFPUsage', 'cn-beijing')).toBe(
      'Action=GetAFPUsage&Region=cn-beijing&Version=2024-01-01',
    )
  })
})

describe('volcengine signV4', () => {
  const now = new Date('2024-06-21T00:00:00Z')

  it('locks the structural contract (Volcengine SigV4 variant)', () => {
    const query = canonicalQuery('GetAFPUsage', 'cn-beijing')
    const sig = signV4('AKLTtest', 'secretkey', 'cn-beijing', 'GetAFPUsage', Buffer.alloc(0), now)

    // Empty body SHA-256 — proves the empty-body path.
    expect(sig.contentSha256).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    // X-Date format.
    expect(sig.xDate).toBe('20240621T000000Z')
    // Algorithm has no AWS4 prefix; scope ends with ark/request.
    expect(sig.authorization).toMatch(/^HMAC-SHA256 Credential=AKLTtest\/20240621\/cn-beijing\/ark\/request,/)
    // Fixed header order — NOT alphabetical.
    expect(sig.authorization).toContain('SignedHeaders=host;x-date;x-content-sha256;content-type,')
    // Signature is 64 lowercase hex chars.
    const signature = sig.authorization.split('Signature=')[1]
    expect(signature).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic for identical inputs', () => {
    const query = canonicalQuery('GetAFPUsage', 'cn-beijing')
    const a = signV4('AKLTtest', 'secretkey', 'cn-beijing', 'GetAFPUsage', Buffer.alloc(0), now)
    const b = signV4('AKLTtest', 'secretkey', 'cn-beijing', 'GetAFPUsage', Buffer.alloc(0), now)
    expect(a.authorization).toBe(b.authorization)
  })
})

describe('deriveRegion', () => {
  it('extracts region from a data-plane base URL', () => {
    expect(deriveRegion('https://ark.cn-beijing.volces.com')).toBe('cn-beijing')
    expect(deriveRegion('https://ark.ap-southeast-1.volces.com/api')).toBe('ap-southeast-1')
  })
  it('falls back to cn-beijing for unknown hosts', () => {
    expect(deriveRegion('https://example.com')).toBe('cn-beijing')
  })
})

describe('parseAfpTiers', () => {
  it('parses the real GetAFPUsage shape into absolute tiers', () => {
    const body = {
      PlanType: 'medium',
      AFPFiveHour: { Quota: 10000, Used: 10000, ResetTime: 1788205252000 },
      AFPWeekly: { Quota: 35000, Used: 10006.4684, ResetTime: 1788710400000 },
      AFPMonthly: { Quota: 100000, Used: 63793.5981, ResetTime: 1789919999000 },
      AFPDaily: { Quota: 50000, Used: 0, ResetTime: 1788278400000 },
    }
    const tiers = parseAfpTiers(body)
    expect(tiers).toHaveLength(3) // daily is intentionally skipped
    expect(tiers[0]).toMatchObject({ name: 'five_hour', utilization: 100, used: 10000, quota: 10000 })
    expect(tiers[0].resets_at).toBe(new Date(1788205252000).toISOString())
    expect(tiers[1]).toMatchObject({ name: 'weekly', utilization: (10006.4684 / 35000) * 100 })
    expect(tiers[2]).toMatchObject({ name: 'monthly' })
  })

  it('skips windows with Quota<=0 (not subscribed)', () => {
    expect(parseAfpTiers({ AFPWeekly: { Quota: 0, Used: 0 } })).toHaveLength(0)
    expect(parseAfpTiers({})).toHaveLength(0)
  })
})

describe('parseCodingPlanTiers', () => {
  it('parses percentage windows across field-name families', () => {
    const body = {
      QuotaUsage: [
        { Level: 'session', Percent: 37, ResetTime: '1788205252' },
        { Type: 'weekly', UsedPercent: 62 },
        { Period: 'monthly', UsagePercent: '81', ResetTime: 1789919999000 },
      ],
    }
    const tiers = parseCodingPlanTiers(body)
    expect(tiers).toHaveLength(3)
    expect(tiers[0]).toMatchObject({ name: 'five_hour', utilization: 37 })
    expect(tiers[0].resets_at).toBe(new Date(1788205252 * 1000).toISOString())
    expect(tiers[1]).toMatchObject({ name: 'weekly', utilization: 62 })
    expect(tiers[2]).toMatchObject({ name: 'monthly', utilization: 81 })
  })

  it('returns empty for unknown shapes', () => {
    expect(parseCodingPlanTiers({})).toHaveLength(0)
    expect(parseCodingPlanTiers({ Usages: [{ Label: 'fortnightly', Percent: 10 }] })).toHaveLength(0)
  })
})