import { describe, expect, it } from 'vitest'
import { removeFromHistory } from './history-utils.js'

/** Minimal ring entry — removeFromHistory only reads `uuid`. */
function msg(uuid?: string): { uuid?: string } {
  return uuid === undefined ? {} : { uuid }
}

describe('removeFromHistory', () => {
  it('removes every entry whose uuid is in the set, in place', () => {
    const history = [msg('a'), msg('b'), msg('c'), msg('d')]
    const removed = removeFromHistory(history, new Set(['b', 'd']))
    expect(removed).toBe(2)
    expect(history).toEqual([msg('a'), msg('c')])
    expect(history).toHaveLength(2)
  })

  it('ignores unknown uuids (CLI-internal commands the host never sent)', () => {
    const history = [msg('a'), msg('b')]
    const removed = removeFromHistory(history, new Set(['b', 'cli-internal']))
    expect(removed).toBe(1)
    expect(history).toEqual([msg('a')])
  })

  it('returns 0 without touching the ring when the set is empty or nothing matches', () => {
    const history = [msg('a'), msg('b')]
    expect(removeFromHistory(history, new Set())).toBe(0)
    expect(removeFromHistory(history, new Set(['nope']))).toBe(0)
    expect(history).toEqual([msg('a'), msg('b')])
  })

  it('does not dedupe against entries lacking a uuid', () => {
    const history = [msg(), msg('a'), msg()]
    const removed = removeFromHistory(history, new Set(['a']))
    expect(removed).toBe(1)
    expect(history).toEqual([msg(), msg()])
  })
})
