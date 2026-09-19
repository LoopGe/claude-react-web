import { describe, it, expect } from 'vitest'
import { planTailBackfillReplay } from './replay-plan.js'

/** Chronological ring slice fixture: index-tagged so tests can assert
 *  ordering without depending on message shape. */
function msg(i: number) {
  return { uuid: `m${i}`, type: 'assistant' }
}

describe('planTailBackfillReplay', () => {
  const CHUNK = 50

  it('returns null when history fits a single chunk (no backfill needed)', () => {
    expect(planTailBackfillReplay([], CHUNK)).toBeNull()
    expect(planTailBackfillReplay([msg(0)], CHUNK)).toBeNull()
    const exactly = Array.from({ length: CHUNK }, (_, i) => msg(i))
    expect(planTailBackfillReplay(exactly, CHUNK)).toBeNull()
  })

  it('splits the newest chunk as the tail and orders backfill newest→oldest', () => {
    const history = Array.from({ length: 120 }, (_, i) => msg(i))
    const plan = planTailBackfillReplay(history, CHUNK)

    // tail = the NEWEST 50 (m70..m119)
    expect(plan!.tail).toHaveLength(CHUNK)
    expect(plan!.tail[0].uuid).toBe('m70')
    expect(plan!.tail[49].uuid).toBe('m119')

    // backfill chunks newest→oldest: m20..m69, then m0..m19
    expect(plan!.backfill).toHaveLength(2)
    expect(plan!.backfill[0]).toHaveLength(CHUNK)
    expect(plan!.backfill[0][0].uuid).toBe('m20')
    expect(plan!.backfill[0][49].uuid).toBe('m69')
    expect(plan!.backfill[1]).toHaveLength(20)
    expect(plan!.backfill[1][0].uuid).toBe('m0')
    expect(plan!.backfill[1][19].uuid).toBe('m19')
  })

  it('reassembly of tail + backfill (reversed) equals the original history', () => {
    const history = Array.from({ length: 257 }, (_, i) => msg(i))
    const plan = planTailBackfillReplay(history, CHUNK)

    const reassembled = [
      ...[...plan!.backfill].reverse().flat(),
      ...plan!.tail,
    ]
    expect(reassembled.map((m) => m.uuid)).toEqual(history.map((m) => m.uuid))
  })

  it('handles a non-chunk-aligned length (partial oldest chunk)', () => {
    const history = Array.from({ length: 51 }, (_, i) => msg(i))
    const plan = planTailBackfillReplay(history, CHUNK)

    expect(plan!.tail).toHaveLength(CHUNK)
    expect(plan!.tail[0].uuid).toBe('m1')
    expect(plan!.backfill).toHaveLength(1)
    expect(plan!.backfill[0]).toHaveLength(1)
    expect(plan!.backfill[0][0].uuid).toBe('m0')
  })
})
