import { describe, it, expect } from 'vitest'
import {
  decideReconcile,
  buildOrderedProjection,
  validateProjection,
  type ProjectionEntry,
  type ReconcileInput,
} from './transcript-reconcile.js'

function pe(occurrenceId: string, msg: unknown, source: ProjectionEntry['source'] = 'provider', aliases: string[] = []): ProjectionEntry {
  return { occurrenceId, msg, source, aliases, evicted: false }
}
const assistant = (uuid: string, stop = 'end_turn') =>
  pe(`uuid:${uuid}:assistant`, { type: 'assistant', uuid, message: { id: `r${uuid}`, content: [{ type: 'text', text: uuid }], stop_reason: stop } })
const prompt = (uuid: string, source: ProjectionEntry['source'] = 'provider') =>
  pe(`uuid:${uuid}:user`, { type: 'user', uuid, message: { role: 'user', content: `text-${uuid}` } }, source)
const result = (uuid: string, assistantUuid: string) =>
  pe(`uuid:${uuid}:result`, { type: 'result', uuid, subtype: 'success', assistantUuid, num_turns: 1 }, 'result')

function input(old: ProjectionEntry[], canonical: ProjectionEntry[], extra: Partial<ReconcileInput> = {}): ReconcileInput {
  return { old, canonical, pending: [], oldTombstones: [], ...extra }
}
const order = (entries: ProjectionEntry[]) => entries.map((e) => e.occurrenceId)

describe('decideReconcile (spec §6)', () => {
  it('incident middle-gap: a disk-only result before a trailing app prompt forces ordered-rebuild', () => {
    const A = assistant('A')
    const U = prompt('U', 'app')
    const R = result('R', 'A')
    const res = decideReconcile(input([A, U], [A, R]))
    expect(res).toEqual({ mode: 'ordered-rebuild' })
  })

  it('pure provider tail append stays append-only', () => {
    const A = assistant('A'), B = assistant('B'), C = assistant('C')
    expect(decideReconcile(input([A, B], [A, B, C]))).toEqual({ mode: 'append-only' })
  })

  it('canonical order mismatch forces ordered-rebuild', () => {
    const A = assistant('A'), B = assistant('B')
    expect(decideReconcile(input([A, B], [B, A]))).toEqual({ mode: 'ordered-rebuild' })
  })
})

describe('buildOrderedProjection (spec §7)', () => {
  it('incident: places the disk-only result at its provider position, app prompt after', () => {
    const A = assistant('A')
    const U = prompt('U', 'app')
    const R = result('R', 'A')
    const out = buildOrderedProjection(input([A, U], [A, R]))
    expect(order(out)).toEqual(['uuid:A:assistant', 'uuid:R:result', 'uuid:U:user'])
  })

  it('idempotence: rebuilding the output with the same canonical is an empty append', () => {
    const A = assistant('A')
    const U = prompt('U', 'app')
    const R = result('R', 'A')
    const out = buildOrderedProjection(input([A, U], [A, R]))
    const canon = out.filter((e) => e.source !== 'app')
    expect(decideReconcile(input(out, canon))).toEqual({ mode: 'append-only' })
  })

  it('prompt bridge: unique u/v content match merges across A into the canonical v position', () => {
    const u = prompt('u', 'app')
    const A = assistant('A')
    const v = pe('uuid:v:user', { type: 'user', uuid: 'v', message: { role: 'user', content: 'text-u' } })
    const out = buildOrderedProjection(input([u, A, v], [v, A]))
    expect(order(out)).toEqual(['uuid:v:user', 'uuid:A:assistant'])
    expect(out[0].aliases).toContain('u')
  })

  it('result turn terminal: a pending result lands after the supplement, not after the tool_use assistant', () => {
    const P = prompt('P')
    const A = assistant('A', 'tool_use')
    const S = pe('uuid:S:user', { type: 'user', uuid: 'S', message: { role: 'user', content: 'steer' } }, 'app')
    const R = result('R', 'A')
    const out = buildOrderedProjection(input([P, A, S], [P, A, S], { pending: [{ operationId: 'op1', entry: R }] }))
    expect(order(out)).toEqual(['uuid:P:user', 'uuid:A:assistant', 'uuid:S:user', 'uuid:R:result'])
  })

  it('unmapped retraction tombstone throws; coverage on a deduped duplicate is not an orphan', () => {
    const A = assistant('A')
    expect(() => buildOrderedProjection(input([A], [A], { oldTombstones: [{ occurrenceId: 'uuid:ghost:assistant', kind: 'retraction' }] }))).toThrow(/unmapped-tombstone/)
    const out = buildOrderedProjection(input([A], [A], { oldTombstones: [{ occurrenceId: 'uuid:dedup:assistant', kind: 'coverage' }] }))
    expect(order(out)).toEqual(['uuid:A:assistant'])
  })

  it('a pending operation appears exactly once even when absent from canonical', () => {
    const A = assistant('A')
    const R = result('R', 'A')
    const out = buildOrderedProjection(input([A], [A], { pending: [{ operationId: 'op1', entry: R }] }))
    expect(order(out).filter((id) => id === 'uuid:R:result')).toHaveLength(1)
  })

  it('identity conflict: same occurrence, non-equivalent content (not a result revision) throws', () => {
    const A = assistant('A')
    const A2 = pe('uuid:A:assistant', { type: 'assistant', uuid: 'A', message: { id: 'rA', content: [{ type: 'text', text: 'DIFFERENT' }], stop_reason: 'end_turn' } })
    expect(() => buildOrderedProjection(input([A], [A2]))).toThrow(/identity-conflict/)
  })

  it('validateProjection: assigns dense seqs from 0 and accepts a well-formed projection', () => {
    const A = assistant('A'), B = assistant('B')
    const out = buildOrderedProjection(input([A], [A, B]))
    expect(() => validateProjection(out, input([A], [A, B]))).not.toThrow()
  })
})
