import { describe, expect, it } from 'vitest'
import { isEmptyResultFrame } from './results.js'

const base = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 0,
  result: '',
  total_cost_usd: 0,
}

describe('isEmptyResultFrame', () => {
  it('flags the SDK 0.3.274 queued-completion shape (success, zero turns, no text, no cost)', () => {
    expect(isEmptyResultFrame(base)).toBe(true)
  })

  it('keeps a real turn (num_turns > 0)', () => {
    expect(isEmptyResultFrame({ ...base, num_turns: 1, result: 'done' })).toBe(false)
  })

  it('keeps a zero-turn result that still carried text', () => {
    expect(isEmptyResultFrame({ ...base, result: '/usage output' })).toBe(false)
  })

  it('keeps error results even with zero turns', () => {
    expect(isEmptyResultFrame({ ...base, is_error: true, subtype: 'error_during_execution' })).toBe(false)
    expect(isEmptyResultFrame({ ...base, subtype: 'error_max_turns' })).toBe(false)
  })

  it('keeps a zero-turn result that cost money', () => {
    expect(isEmptyResultFrame({ ...base, total_cost_usd: 0.01 })).toBe(false)
  })

  it('keeps a zero-turn interrupted turn (terminal_reason is the marker the UI reads)', () => {
    expect(isEmptyResultFrame({ ...base, terminal_reason: 'aborted_streaming' })).toBe(false)
    expect(isEmptyResultFrame({ ...base, terminal_reason: 'aborted_tools' })).toBe(false)
    // A plain completion is still suppressible.
    expect(isEmptyResultFrame({ ...base, terminal_reason: 'completed' })).toBe(true)
  })

  it('treats whitespace-only result text as empty', () => {
    expect(isEmptyResultFrame({ ...base, result: '  \n ' })).toBe(true)
  })

  it('never flags another frame type, and is conservative when num_turns is absent', () => {
    expect(isEmptyResultFrame({ ...base, type: 'assistant' })).toBe(false)
    expect(isEmptyResultFrame({ type: 'result', subtype: 'success', result: '' })).toBe(false)
  })
})
