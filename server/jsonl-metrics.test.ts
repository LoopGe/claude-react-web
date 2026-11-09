import { describe, expect, it } from 'vitest'
import { jsonlSizeSummary } from './jsonl-metrics'

describe('jsonlSizeSummary', () => {
  it('sums sizes and reports the largest', () => {
    expect(jsonlSizeSummary([1, 5, 3])).toEqual({ total: 9, max: 5 })
  })

  it('returns zeros when there is no transcript', () => {
    expect(jsonlSizeSummary([])).toEqual({ total: 0, max: 0 })
  })
})