import { describe, expect, it } from 'vitest'
import { parseZhipuTiers } from './zhipu.js'
import { parseKimiTiers } from './kimi.js'
import { parseMinimaxTiers } from './minimax.js'
import { parseZenmuxTiers } from './zenmux.js'
import { parseOpenCodeGoTiers } from './opencodego.js'
import { parseGenericWindows, parseBalance } from './generic.js'

describe('parseZhipuTiers', () => {
  it('classifies windows by explicit unit (3=5h, 6=weekly)', () => {
    const data = {
      level: 'standard',
      limits: [
        { type: 'TOKENS_LIMIT', unit: 3, percentage: 40, nextResetTime: 1788205252000 },
        { type: 'TOKENS_LIMIT', unit: 6, percentage: 25, nextResetTime: 1788710400000 },
      ],
    }
    const tiers = parseZhipuTiers(data)
    expect(tiers).toHaveLength(2)
    expect(tiers[0]).toMatchObject({ name: 'five_hour', utilization: 40 })
    expect(tiers[0].resets_at).toBe(new Date(1788205252000).toISOString())
    expect(tiers[1]).toMatchObject({ name: 'weekly', utilization: 25 })
  })

  it('falls back to reset-order heuristic when unit is missing', () => {
    const data = {
      limits: [
        { type: 'TOKENS_LIMIT', percentage: 10 },
        { type: 'TOKENS_LIMIT', percentage: 60, nextResetTime: 1788710400000 },
      ],
    }
    const tiers = parseZhipuTiers(data)
    expect(tiers).toHaveLength(2)
    // No-reset entry lands in five_hour first, then the rest by reset order.
    expect(tiers[0].name).toBe('five_hour')
    expect(tiers[1].name).toBe('weekly')
  })

  it('ignores non-limit entries; unknown-unit TOKENS_LIMIT degrades to five_hour', () => {
    const data = {
      limits: [
        { type: 'SOMETHING_ELSE', unit: 3, percentage: 99 },
        { type: 'TOKENS_LIMIT', unit: 999, percentage: 30 },
      ],
    }
    const tiers = parseZhipuTiers(data)
    // Non-limit type ignored; the TOKENS_LIMIT with an unknown unit falls
    // back to the five_hour slot (cc-switch: old plans return one entry).
    expect(tiers).toHaveLength(1)
    expect(tiers[0]).toMatchObject({ name: 'five_hour', utilization: 30 })
  })
})

describe('parseKimiTiers', () => {
  it('parses the first 5-hour limits[] entry plus the weekly usage object', () => {
    const body = {
      limits: [
        { detail: { limit: 100, remaining: 63, resetTime: 1788205252 } },
        { detail: { limit: 50, remaining: 50, resetTime: 1788205252000 } },
      ],
      usage: { limit: 500, remaining: 400, resetTime: 1788710400000 },
    }
    const tiers = parseKimiTiers(body)
    expect(tiers).toHaveLength(2) // first five_hour only → unique stat-grid id
    expect(tiers[0]).toMatchObject({ name: 'five_hour', utilization: 37 })
    expect(tiers[0].resets_at).toBe(new Date(1788205252 * 1000).toISOString())
    expect(tiers[1]).toMatchObject({ name: 'weekly', utilization: 20 }) // (500-400)/500
  })

  it('returns empty for unknown shapes', () => {
    expect(parseKimiTiers({})).toHaveLength(0)
    expect(parseKimiTiers(null)).toHaveLength(0)
  })
})

describe('parseMinimaxTiers', () => {
  it('inverts remaining percentages and only reads the general model', () => {
    const body = {
      model_remains: [
        { model_name: 'video', current_interval_remaining_percent: 99 },
        {
          model_name: 'general',
          current_interval_remaining_percent: 70,
          end_time: 1788205252000,
          current_weekly_status: 1,
          current_weekly_remaining_percent: 40,
          weekly_end_time: 1788710400000,
        },
      ],
    }
    const tiers = parseMinimaxTiers(body)
    expect(tiers).toHaveLength(2)
    expect(tiers[0]).toMatchObject({ name: 'five_hour', utilization: 30 })
    expect(tiers[0].resets_at).toBe(new Date(1788205252000).toISOString())
    expect(tiers[1]).toMatchObject({ name: 'weekly', utilization: 60 })
  })

  it('skips the weekly bucket when weekly status is not active', () => {
    const body = {
      model_remains: [
        {
          model_name: 'general',
          current_interval_remaining_percent: 50,
          current_weekly_status: 3, // no weekly limit on this plan
          current_weekly_remaining_percent: 100,
        },
      ],
    }
    const tiers = parseMinimaxTiers(body)
    expect(tiers).toHaveLength(1)
    expect(tiers[0].name).toBe('five_hour')
  })

  it('returns empty when no general model exists', () => {
    expect(parseMinimaxTiers({ model_remains: [{ model_name: 'video' }] })).toHaveLength(0)
    expect(parseMinimaxTiers({})).toHaveLength(0)
  })
})

describe('parseZenmuxTiers', () => {
  it('scales usage_percentage (0-1) to 0-100 and keeps ISO resets_at', () => {
    const data = {
      plan: { tier: 'pro' },
      account_status: 'active',
      quota_5_hour: { usage_percentage: 0.42, resets_at: '2026-09-01T03:40:52Z' },
      quota_7_day: { usage_percentage: 0.2, resets_at: '2026-09-07T00:00:00Z' },
    }
    const tiers = parseZenmuxTiers(data)
    expect(tiers).toHaveLength(2)
    expect(tiers[0]).toMatchObject({ name: 'five_hour', utilization: 42 })
    expect(tiers[0].resets_at).toBe(new Date('2026-09-01T03:40:52Z').toISOString())
    expect(tiers[1]).toMatchObject({ name: 'weekly', utilization: 20 })
  })

  it('returns empty for missing windows', () => {
    expect(parseZenmuxTiers({})).toHaveLength(0)
  })
})

describe('parseOpenCodeGoTiers', () => {
  it('parses rolling/weekly/monthly windows', () => {
    const body = {
      usage: {
        rolling: { status: 'ok', percent: 37, resetsAt: '2026-08-26T14:12:03.000Z' },
        weekly: { status: 'rate-limited', percent: 100, resetsAt: '2026-08-31T00:00:00.000Z' },
        monthly: { status: 'ok', percent: 0, resetsAt: '2026-09-11T00:00:00.000Z' },
      },
    }
    const tiers = parseOpenCodeGoTiers(body)
    expect(tiers).toHaveLength(3)
    expect(tiers[0]).toMatchObject({ name: 'five_hour', utilization: 37 })
    expect(tiers[0].resets_at).toBe(new Date('2026-08-26T14:12:03.000Z').toISOString())
    expect(tiers[1]).toMatchObject({ name: 'weekly', utilization: 100 })
    // percent==0 → placeholder resetsAt is dropped.
    expect(tiers[2]).toMatchObject({ name: 'monthly', utilization: 0, resets_at: null })
  })

  it('returns empty for unknown shapes', () => {
    expect(parseOpenCodeGoTiers({})).toHaveLength(0)
    expect(parseOpenCodeGoTiers({ usage: { rolling: {} } })).toHaveLength(0)
  })
})

describe('parseGenericWindows', () => {
  it('extracts windows from nested objects and de-duplicates by name', () => {
    const body = {
      data: {
        five_hour: { percent: 42 },
        weekly: { used: 10, quota: 100 },
        monthly: { usedPercent: 81 },
      },
      nested: { monthly: { percent: 99 } }, // duplicate monthly → ignored
    }
    const tiers = parseGenericWindows(body)
    expect(tiers).toHaveLength(3)
    expect(tiers[0]).toMatchObject({ name: 'five_hour', utilization: 42 })
    expect(tiers[1]).toMatchObject({ name: 'weekly', utilization: 10 })
    expect(tiers[2]).toMatchObject({ name: 'monthly', utilization: 81 })
  })

  it('handles used/quota via multiple field-name families', () => {
    const tiers = parseGenericWindows({ usage: { fivehour: { usedValue: 7, limit: 20 } } })
    expect(tiers[0]).toMatchObject({ name: 'five_hour', utilization: 35 })
  })
})

describe('parseBalance', () => {
  it('reads OpenAI-style total_balance', () => {
    expect(parseBalance({ total_balance: 12.34, currency: 'USD' })).toEqual({
      amount: 12.34,
      currency: 'USD',
    })
    expect(parseBalance({ data: { total_balance: '5' } })).toEqual({ amount: 5, currency: undefined })
  })
  it('reads plain balance / credits', () => {
    expect(parseBalance({ balance: 3 })).toEqual({ amount: 3, currency: undefined })
    expect(parseBalance({ credits: 99.9 })).toEqual({ amount: 99.9, currency: undefined })
  })
  it('returns null when nothing looks like a balance', () => {
    expect(parseBalance({ foo: 'bar' })).toBeNull()
    expect(parseBalance(null)).toBeNull()
  })
})