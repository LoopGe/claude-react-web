import { describe, it, expect } from 'vitest'
import {
  decideReconcile,
  buildOrderedProjection,
  validateProjection,
  alignOldByUuid,
  detectRebuildTrigger,
  type ProjectionEntry,
  type ReconcileInput,
} from './transcript-reconcile.js'
import { occurrenceIdOf } from './transcript-projection.js'

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

// ─── alignOldByUuid: wire/disk twin alignment (spec §5.2/§5.3/§7.1) ─────────
//
// The live wire assistant frame and the CLI's persisted final frame share one
// uuid but differ in usage/stop_reason (streaming pre-finalization vs final).
// semanticMessageProjection keeps those fields (§5.3), so the composition
// layer's content-hash disambiguator gives the twins DIFFERENT occurrenceIds;
// without uuid-level alignment the rebuild keeps both (the resume-duplicate
// incident). These tests use production-shaped hashed identities.

const wireAssistant = (uuid: string, extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  uuid,
  parent_tool_use_id: null,
  timestamp: '2026-11-19T12:04:35.259Z',
  message: {
    id: `m${uuid}`,
    role: 'assistant',
    content: [{ type: 'tool_use', id: `tu-${uuid}`, name: 'Bash', input: { command: 'ls' } }],
    stop_reason: null,
    usage: { input_tokens: 110477, output_tokens: 0 },
  },
  ...extra,
})
const diskAssistant = (uuid: string, extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  uuid,
  parent_tool_use_id: null,
  restoredFromDisk: true,
  message: {
    id: `m${uuid}`,
    role: 'assistant',
    content: [{ type: 'tool_use', id: `tu-${uuid}`, name: 'Bash', input: { command: 'ls' } }],
    stop_reason: 'tool_use',
    usage: { input_tokens: 7, cache_read_input_tokens: 320400, output_tokens: 1080 },
  },
  ...extra,
})
const hashed = (msg: unknown, dis: string, source: ProjectionEntry['source'] = 'provider', evicted = false): ProjectionEntry => ({
  occurrenceId: occurrenceIdOf(msg, { appOperationId: dis }),
  msg,
  source,
  aliases: [],
  evicted,
})
const uuidsOf = (entries: ProjectionEntry[]) => entries.map((e) => (e.msg as { uuid?: string }).uuid)

describe('alignOldByUuid (wire/disk twin dedup)', () => {
  it('without alignment the rebuild keeps both twins; with alignment one canonical copy survives', () => {
    const wire = hashed(wireAssistant('A'), 'wire-hash', 'app')
    const disk = hashed(diskAssistant('A'), 'disk-hash')
    // Pre-fix shape: the builder treats the wire twin as an app-only occurrence.
    const unaligned = buildOrderedProjection(input([wire], [disk]))
    expect(uuidsOf(unaligned)).toEqual(['A', 'A'])

    const aligned = alignOldByUuid([wire], [disk])
    const out = buildOrderedProjection(input(aligned.old, aligned.canonical))
    expect(uuidsOf(out)).toEqual(['A'])
    // Canonical (disk final) content wins (§5.3 lifecycle merge).
    expect((out[0].msg as { message: { stop_reason: string } }).message.stop_reason).toBe('tool_use')
    expect(out[0].source).toBe('provider')
  })

  it('merges lifecycle metadata from the old wire copy onto the canonical msg', () => {
    const wire = hashed(wireAssistant('A', { consumedAt: 123, steeredAt: 456 }), 'wire-hash', 'app')
    const disk = hashed(diskAssistant('A'), 'disk-hash')
    const aligned = alignOldByUuid([wire], [disk])
    const out = buildOrderedProjection(input(aligned.old, aligned.canonical))
    const msg = out[0].msg as { consumedAt?: number; steeredAt?: number }
    expect(msg.consumedAt).toBe(123)
    expect(msg.steeredAt).toBe(456)
    // Inputs are not mutated.
    expect((disk.msg as { consumedAt?: number }).consumedAt).toBeUndefined()
  })

  it('canonical lifecycle values win over the old copy', () => {
    const wire = hashed(wireAssistant('A', { consumedAt: 123 }), 'wire-hash', 'app')
    const disk = hashed(diskAssistant('A', { consumedAt: 999 }), 'disk-hash')
    const aligned = alignOldByUuid([wire], [disk])
    const out = buildOrderedProjection(input(aligned.old, aligned.canonical))
    expect((out[0].msg as { consumedAt?: number }).consumedAt).toBe(999)
  })

  it('an evicted wire twin tombstones the canonical occurrence (§5.4)', () => {
    const wire = hashed(wireAssistant('A'), 'wire-hash', 'app', true)
    const disk = hashed(diskAssistant('A'), 'disk-hash')
    const aligned = alignOldByUuid([wire], [disk])
    const out = buildOrderedProjection(input(aligned.old, aligned.canonical))
    expect(out).toHaveLength(1)
    expect(out[0].evicted).toBe(true)
  })

  it('an evicted HASH-MATCHED disk copy is not shadowed by a visible wire twin (last-wins oldByOcc)', () => {
    // Asymmetric tombstones: the disk copy is retracted, the wire twin visible.
    // Both orders must keep the occurrence evicted — the aligned entry must
    // report the OR-merged flag, not its own.
    const diskOld = hashed(diskAssistant('A'), 'disk-hash', 'provider', true)
    const wire = hashed(wireAssistant('A'), 'wire-hash', 'app', false)
    const disk = hashed(diskAssistant('A'), 'disk-hash')
    for (const old of [[diskOld, wire], [wire, diskOld]]) {
      const aligned = alignOldByUuid(old, [disk])
      const out = buildOrderedProjection(input(aligned.old, aligned.canonical))
      expect(out).toHaveLength(1)
      expect(out[0].evicted).toBe(true)
    }
  })

  it('a retracted hash-matched copy with no app twin still tombstones the occurrence (early-return keeps the OR)', () => {
    // Corrupt store: two identical rows for one occurrence, one evicted, one
    // visible, NO alignable app entry. The eviction OR onto canonical must
    // survive the no-alignment path — otherwise last-wins oldByOcc reads the
    // visible copy and resurrects the retracted message.
    const retracted = hashed(diskAssistant('A'), 'disk-hash', 'provider', true)
    const visible = hashed(diskAssistant('A'), 'disk-hash', 'provider', false)
    const canon = hashed(diskAssistant('A'), 'disk-hash')
    for (const old of [[retracted, visible], [visible, retracted]]) {
      const aligned = alignOldByUuid(old, [canon])
      const out = buildOrderedProjection(input(aligned.old, aligned.canonical))
      expect(out).toHaveLength(1)
      expect(out[0].evicted).toBe(true)
    }
  })

  it('among multiple wire twins the newest lifecycle stamp wins; canonical still wins over all', () => {
    const wireOld = hashed(wireAssistant('A', { consumedAt: 100 }), 'wire-hash-1', 'app')
    const wireNew = hashed(wireAssistant('A', { consumedAt: 200 }), 'wire-hash-2', 'app')
    const disk = hashed(diskAssistant('A'), 'disk-hash')
    const aligned = alignOldByUuid([wireOld, wireNew], [disk])
    const out = buildOrderedProjection(input(aligned.old, aligned.canonical))
    expect(uuidsOf(out)).toEqual(['A'])
    expect((out[0].msg as { consumedAt?: number }).consumedAt).toBe(200)
    // Canonical's own value beats every wire copy.
    const diskStamped = hashed(diskAssistant('A', { consumedAt: 999 }), 'disk-hash')
    const aligned2 = alignOldByUuid([wireOld, wireNew], [diskStamped])
    const out2 = buildOrderedProjection(input(aligned2.old, aligned2.canonical))
    expect((out2[0].msg as { consumedAt?: number }).consumedAt).toBe(999)
  })

  it('a corrupt store holding BOTH copies folds them into one canonical occurrence', () => {
    const diskOld = hashed(diskAssistant('A'), 'disk-hash') // hash-matched → provider
    const wire = hashed(wireAssistant('A'), 'wire-hash', 'app', true)
    const disk = hashed(diskAssistant('A'), 'disk-hash')
    const aligned = alignOldByUuid([diskOld, wire], [disk])
    const out = buildOrderedProjection(input(aligned.old, aligned.canonical))
    expect(uuidsOf(out)).toEqual(['A'])
    expect(out[0].evicted).toBe(true)
  })

  it('ambiguous canonical (two same uuid+frameKind entries) is left untouched', () => {
    const wire = hashed(wireAssistant('A'), 'wire-hash', 'app')
    const d1 = hashed(diskAssistant('A'), 'disk-hash-1')
    const d2 = hashed(diskAssistant('A', { message: { id: 'mA', role: 'assistant', content: [{ type: 'text', text: 'other' }], stop_reason: 'end_turn', usage: {} } }), 'disk-hash-2')
    const aligned = alignOldByUuid([wire], [d1, d2])
    expect(aligned.old[0]).toEqual(wire)
  })

  it('uuid-less and frameKind-mismatched old entries are left untouched', () => {
    const anon = pe('app:anon-hash', { type: 'system', subtype: 'init' }, 'app')
    const summaryWire = hashed({ type: 'user', uuid: 'A', isCompactSummary: true, message: { role: 'user', content: 'summary' } }, 'wire-hash', 'app')
    const diskPrompt = hashed({ type: 'user', uuid: 'A', message: { role: 'user', content: 'prompt' } }, 'disk-hash')
    const aligned = alignOldByUuid([anon, summaryWire], [diskPrompt])
    expect(aligned.old[0]).toEqual(anon)
    expect(aligned.old[1]).toEqual(summaryWire)
  })

  it('aligned projection reconciles append-only on the second pass (§7.4 idempotence)', () => {
    const wire = hashed(wireAssistant('A'), 'wire-hash', 'app')
    const disk = hashed(diskAssistant('A'), 'disk-hash')
    const aligned = alignOldByUuid([wire], [disk])
    const out = buildOrderedProjection(input(aligned.old, aligned.canonical))
    const canon = out.filter((e) => e.source !== 'app')
    expect(decideReconcile(input(out, canon))).toEqual({ mode: 'append-only' })
  })
})

// ─── detectRebuildTrigger: live anomaly → REBUILD_REQUIRED (spec §8.1) ──────
//
// The live result/completion append path consults this pure detector BEFORE
// recordTranscriptFor. rebuild-required ONLY on a genuine anomaly: a result
// whose canonical turn-terminal position precedes the current tail (the A,U,R
// incident shape arriving live), or a same-uuid semantic revision. Normal tail
// results and queued user sends must stay append-only (the T7b guarantee).

const anchors = (assistantUuid: string | null) => ({ assistantUuid })
const completion = (uuid: string, status: string, extra: Record<string, unknown> = {}) =>
  pe(`uuid:${uuid}:system:task_notification`, { type: 'system', subtype: 'task_notification', uuid, tool_use_id: 'tu', status, ...extra }, 'app')

describe('detectRebuildTrigger (spec §8.1 live anomaly trigger)', () => {
  it('(a) incident shape: a result whose turn terminal precedes the tail is rebuild-required', () => {
    const A = assistant('A')
    const U = prompt('U') // the next root prompt was already published
    expect(detectRebuildTrigger([A, U], result('R', 'A'), anchors('A'))).toBe('rebuild-required')
  })

  it('(a2) the full P,A,U shape with a trailing result anchor still inverts', () => {
    const P = prompt('P'), A = assistant('A'), U = prompt('U')
    expect(detectRebuildTrigger([P, A, U], result('R', 'A'), anchors('A'))).toBe('rebuild-required')
  })

  it('(b) a same-resultUuid semantic revision is rebuild-required', () => {
    const A = assistant('A')
    const R1 = result('R', 'A')
    const R2 = pe('uuid:R:result', { type: 'result', uuid: 'R', subtype: 'success', assistantUuid: 'A', num_turns: 1, result: 'revised answer' }, 'result')
    expect(detectRebuildTrigger([A, R1], R2, anchors('A'))).toBe('rebuild-required')
  })

  it('(b2) a same-resultUuid EQUIVALENT redelivery stays append-only (dedup, not a revision)', () => {
    const A = assistant('A')
    const R1 = result('R', 'A')
    const copy = pe('uuid:R:result', { ...(R1.msg as object) }, 'result')
    expect(detectRebuildTrigger([A, R1], copy, anchors('A'))).toBe('append-only')
  })

  it('(c) a normal tail result (turn terminal == tail) is append-only — NO trigger', () => {
    const P = prompt('P'), A = assistant('A')
    expect(detectRebuildTrigger([P, A], result('R', 'A'), anchors('A'))).toBe('append-only')
  })

  it('(c2) turn members after the anchor (tool_result carrier, steering supplement) are not an inversion', () => {
    const P = prompt('P')
    const A = assistant('A', 'tool_use')
    const carrier = pe('uuid:C:user', { type: 'user', uuid: 'C', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu', content: 'ok' }] } })
    const S = pe('uuid:S:user', { type: 'user', uuid: 'S', message: { role: 'user', content: 'steer' } }, 'app')
    expect(detectRebuildTrigger([P, A, carrier, S], result('R', 'A'), anchors('A'))).toBe('append-only')
  })

  it('(d) a queued user send is never a trigger (T7b): non-result/completion incoming is append-only', () => {
    const P = prompt('P'), A = assistant('A')
    expect(detectRebuildTrigger([P, A], prompt('U2', 'app'), anchors('A'))).toBe('append-only')
  })

  it('empty result bookends are excluded before identity/placement (spec §5.1)', () => {
    const A = assistant('A'), U = prompt('U')
    const empty = pe('uuid:E:result', { type: 'result', uuid: 'E', subtype: 'success', num_turns: 0, result: '' }, 'result')
    expect(detectRebuildTrigger([A, U], empty, anchors('A'))).toBe('append-only')
  })

  it('no anchor / anchor absent from the projection: no position evidence, append-only', () => {
    const A = assistant('A'), U = prompt('U')
    const R = result('R', 'A')
    expect(detectRebuildTrigger([A, U], R, anchors(null))).toBe('append-only')
    expect(detectRebuildTrigger([A, U], R, anchors('ghost'))).toBe('append-only')
  })

  it('a completion revision (same uuid, non-equivalent) is rebuild-required; a fresh completion is append-only', () => {
    const A = assistant('A')
    const stopped = completion('N', 'stopped')
    const completed = completion('N', 'completed', { summary: 'done' })
    expect(detectRebuildTrigger([A, stopped], completed, anchors('A'))).toBe('rebuild-required')
    // A live completion's canonical position is its arrival tail (§5.1/§7.2.3):
    // a fresh uuid never inverts, even published after a later root prompt.
    const U = prompt('U')
    expect(detectRebuildTrigger([A, U], completion('M', 'completed'), anchors('A'))).toBe('append-only')
  })
})
