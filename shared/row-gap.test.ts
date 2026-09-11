import { describe, it, expect } from 'vitest'
import { ROW_GAP_PRESETS, ROW_GAP_PX, ROW_GAP_LABELS, DEFAULT_ROW_GAP, isRowGapPreset } from './row-gap.js'

describe('row-gap presets', () => {
  it('defaults to spacious (12px)', () => {
    expect(DEFAULT_ROW_GAP).toBe('spacious')
  })

  it('maps every preset to a px value', () => {
    expect(ROW_GAP_PRESETS).toEqual(['compact', 'comfortable', 'spacious', 'airy'])
    expect(ROW_GAP_PX['compact']).toBe(4)
    expect(ROW_GAP_PX['comfortable']).toBe(8)
    expect(ROW_GAP_PX['spacious']).toBe(12)
    expect(ROW_GAP_PX['airy']).toBe(16)
  })

  it('isRowGapPreset guards the union', () => {
    expect(isRowGapPreset('compact')).toBe(true)
    expect(isRowGapPreset('spacious')).toBe(true)
    expect(isRowGapPreset('airy')).toBe(true)
    // The value we retired when folding spacing into the presets.
    expect(isRowGapPreset('14px')).toBe(false)
    expect(isRowGapPreset(8)).toBe(false)
    expect(isRowGapPreset(undefined)).toBe(false)
    expect(isRowGapPreset('loose')).toBe(false)
  })

  it('every preset has a px entry (no missing key)', () => {
    for (const p of ROW_GAP_PRESETS) {
      expect(typeof ROW_GAP_PX[p]).toBe('number')
      expect(ROW_GAP_PX[p]).toBeGreaterThan(0)
      expect(typeof ROW_GAP_LABELS[p]).toBe('string')
      expect(ROW_GAP_LABELS[p].length).toBeGreaterThan(0)
    }
  })
})