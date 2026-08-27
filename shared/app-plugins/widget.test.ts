import { describe, expect, it } from 'vitest'
import { parseStatGridPayload } from './widget.js'

describe('parseStatGridPayload', () => {
  it('passes a valid payload through', () => {
    const payload = {
      values: [{ id: 'cpu', label: 'CPU', value: '23.4', unit: '%', progress: 0.234, tone: 'ok' }],
    }
    expect(parseStatGridPayload(payload)).toEqual(payload)
  })

  it('rejects non-objects and missing values', () => {
    expect(parseStatGridPayload(null)).toBeNull()
    expect(parseStatGridPayload({})).toBeNull()
    expect(parseStatGridPayload({ values: 'nope' })).toBeNull()
  })

  it('drops a row with progress outside [0,1]', () => {
    const p = parseStatGridPayload({ values: [{ id: 'a', label: 'A', value: '1', progress: 1.5 }] })
    expect(p).toBeNull() // all rows invalid → whole payload rejected
  })

  it('drops a row with an unknown tone but keeps valid rows', () => {
    const p = parseStatGridPayload({
      values: [
        { id: 'a', label: 'A', value: '1', tone: 'purple' as never },
        { id: 'b', label: 'B', value: '2' },
      ],
    })
    expect(p?.values).toHaveLength(1)
    expect(p?.values[0].id).toBe('b')
  })

  it('rejects a row missing required fields', () => {
    expect(parseStatGridPayload({ values: [{ id: '', label: 'A', value: '1' }] })).toBeNull()
    expect(parseStatGridPayload({ values: [{ id: 'a', label: '', value: '1' }] })).toBeNull()
  })
})
