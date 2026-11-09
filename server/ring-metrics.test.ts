import { describe, expect, it } from 'vitest'
import { ringImagePayload } from './ring-metrics'

function image(data: string): unknown {
  return { message: { content: [{ type: 'image', source: { type: 'base64', data } }] } }
}

const text: unknown = { message: { content: [{ type: 'text', text: 'x' }] } }

describe('ringImagePayload', () => {
  it('sums image blocks and base64 bytes across both rings', () => {
    const sessions = [
      { history: [image('AAAA'), text], subagentHistory: [image('BBBBBB')] },
      { history: [image('CC')], subagentHistory: [] },
    ]
    expect(ringImagePayload(sessions)).toEqual({ images: 3, bytes: 12 })
  })

  it('returns zeros for empty sessions', () => {
    expect(ringImagePayload([])).toEqual({ images: 0, bytes: 0 })
    expect(ringImagePayload([{ history: [], subagentHistory: [] }])).toEqual({ images: 0, bytes: 0 })
  })
})