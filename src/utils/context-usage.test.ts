import { describe, expect, it } from 'vitest'
import { contextUsageStats } from './context-usage'

describe('contextUsageStats', () => {
  it('keeps a confirmed zero threshold without rendering a threshold marker', () => {
    const stats = contextUsageStats({
      totalTokens: 10_000,
      maxTokens: 16_000,
      rawMaxTokens: 16_000,
      percentage: 62.5,
      model: 'small',
      autoCompactThreshold: 0,
    })

    expect(stats.threshold).toBe(0)
    expect(stats.thresholdPct).toBeNull()
  })
})
