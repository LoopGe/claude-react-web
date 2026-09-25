import { describe, expect, it } from 'vitest'
import { dndData, dndExtraOf, dndPayloadOf, tiltFromVelocity, type DragPayload } from './payload'

describe('dndData / dndPayloadOf', () => {
  it('round-trips a payload through the data channel', () => {
    const payload: DragPayload = { kind: 'sidebar-card', id: 's1' }
    const data = dndData(payload)
    expect(dndPayloadOf(data as unknown as Record<string, unknown>)).toEqual(payload)
  })

  it('round-trips every payload kind', () => {
    const payloads: DragPayload[] = [
      { kind: 'sidebar-card', id: 's1' },
      { kind: 'main-panel', id: 's2' },
      { kind: 'group-card', id: 'g1' },
      { kind: 'profile-model', id: 'm1' },
      { kind: 'profile-model-group', id: 'g2' },
      { kind: 'main-grid' },
    ]
    for (const p of payloads) {
      expect(dndPayloadOf(dndData(p) as unknown as Record<string, unknown>)).toEqual(p)
    }
  })

  it('carries extras alongside the payload', () => {
    const data = dndData({ kind: 'sidebar-card', id: 's1' }, { containerGroupId: 'g1' })
    expect(dndPayloadOf(data as unknown as Record<string, unknown>)).toEqual({ kind: 'sidebar-card', id: 's1' })
    expect(dndExtraOf<string>(data as unknown as Record<string, unknown>, 'containerGroupId')).toBe('g1')
  })

  it('returns null for undefined / foreign / malformed data', () => {
    expect(dndPayloadOf(undefined)).toBeNull()
    expect(dndPayloadOf({})).toBeNull()
    expect(dndPayloadOf({ other: 1 })).toBeNull()
    expect(dndPayloadOf({ crw: { kind: 'nope', id: 'x' } })).toBeNull()
    expect(dndPayloadOf({ crw: { kind: 'sidebar-card' } })).toBeNull()
    expect(dndPayloadOf({ crw: 'sidebar-card' })).toBeNull()
  })

  it('accepts a pre-unwrapped payload object (useSortable data spread)', () => {
    // Callers that pass `data: { crw: payload }` to a droppable and later read
    // `over.data.current` get the same wrapper — this asserts the wrapper shape.
    const payload: DragPayload = { kind: 'group-card', id: 'g9' }
    const wrapped = dndData(payload) as unknown as Record<string, unknown>
    expect(wrapped).toEqual({ crw: payload })
  })
})

describe('tiltFromVelocity', () => {
  it('maps px/ms velocity to a small tilt angle', () => {
    // 1 px/ms (fast flick) → ~1.4° (soft tanh knee, ±4° asymptote)
    expect(tiltFromVelocity(1)).toBeCloseTo(1.43, 1)
    expect(tiltFromVelocity(-1)).toBeCloseTo(-1.43, 1)
  })

  it('scales sub-linearly and clamps at ±MAX_TILT_DEG', () => {
    expect(tiltFromVelocity(0)).toBe(0)
    const big = tiltFromVelocity(50)
    expect(Math.abs(big)).toBeLessThanOrEqual(4)
    expect(tiltFromVelocity(500)).toBeCloseTo(big, 10)
  })

  it('decayed velocity yields near-zero tilt', () => {
    expect(Math.abs(tiltFromVelocity(0.01))).toBeLessThan(0.5)
  })
})
