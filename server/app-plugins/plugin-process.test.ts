import { describe, expect, it } from 'vitest'
import { parseAppEventNotification, SlidingWindowRate } from './plugin-process.js'

describe('parseAppEventNotification', () => {
  it('accepts a valid widgetId + stat-grid payload', () => {
    const parsed = parseAppEventNotification({
      widgetId: 'w1',
      payload: { values: [{ id: 'cpu', label: 'CPU', value: '1', unit: '%' }] },
    })
    expect(parsed).toEqual({ widgetId: 'w1', payload: { values: [{ id: 'cpu', label: 'CPU', value: '1', unit: '%' }] } })
  })

  it('rejects non-objects, missing widgetId, and invalid payloads', () => {
    expect(parseAppEventNotification(null)).toBeNull()
    expect(parseAppEventNotification({ payload: {} })).toBeNull()
    expect(parseAppEventNotification({ widgetId: '', payload: { values: [] } })).toBeNull()
    expect(parseAppEventNotification({ widgetId: 'w1', payload: { values: [] } })).toBeNull()
  })
})

describe('SlidingWindowRate', () => {
  it('allows up to max within the window, then blocks', () => {
    const rate = new SlidingWindowRate(3, 60_000)
    expect(rate.allow()).toBe(true)
    expect(rate.allow()).toBe(true)
    expect(rate.allow()).toBe(true)
    expect(rate.allow()).toBe(false)
  })
})
