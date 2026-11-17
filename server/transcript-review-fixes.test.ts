/**
 * Regression tests for the final-review correctness fixes:
 *  C1 — v1 suffix appended after a v2 rebuild is replayed on the next fold.
 *  C2 — an evicted base message persists and restores as evicted (no resurrection).
 *  I3 — no committed v2 generation (crash before first commit) → hasCommittedGeneration=false.
 *  I4 — a torn tail is truncated before the next append (no concatenation corruption).
 *  I8 — trailing app-only entries (handoff boundary+summary) keep their old order.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TranscriptSidecar, foldSidecarRowsV2, makeCommitV2 } from './transcript-sidecar.js'
import { buildOrderedProjection, type ProjectionEntry } from './transcript-reconcile.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})
async function tmpDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'crw-fix-'))
  dirs.push(d)
  return d
}

const msgRow = (batchId: string, seq: number, uuid: string, evicted = false) => ({
  v: 2,
  batchId,
  seq,
  occurrenceId: `uuid:${uuid}:assistant`,
  source: 'provider',
  aliases: [],
  uuid,
  type: 'assistant',
  msg: { type: 'assistant', uuid, message: { id: `m${uuid}`, role: 'assistant', content: [] } },
  evicted,
})

describe('C1: v1 suffix after a v2 rebuild is replayed', () => {
  it('folds the committed generation plus later v1 message and tombstone rows', () => {
    const g = [msgRow('g1', 0, 'b')]
    const rows = [
      ...g,
      makeCommitV2({ batchId: 'g1', batchType: 'generation', generation: 1, reason: 'ordered-rebuild', contentPolicy: 'preserve', rows: g }),
      // v1 suffix appended by live ingest / eviction after the rebuild:
      { seq: 1, uuid: 'c', type: 'assistant', msg: { type: 'assistant', uuid: 'c', message: { id: 'mc', role: 'assistant', content: [] } } },
      { seq: 0, evicted: true },
    ]
    const folded = foldSidecarRowsV2(rows)
    expect(folded.hasCommittedGeneration).toBe(true)
    expect(folded.generation).toBe(1)
    expect(folded.entries.map((e) => [e.uuid, e.evicted === true])).toEqual([['b', true], ['c', false]])
  })
})

describe('C2: evicted base messages survive a rebuild restart', () => {
  it('a generation row with evicted:true restores as evicted', () => {
    const g = [msgRow('g1', 0, 'a', true)]
    const rows = [...g, makeCommitV2({ batchId: 'g1', batchType: 'generation', generation: 1, reason: 'ordered-rebuild', contentPolicy: 'preserve', rows: g })]
    const folded = foldSidecarRowsV2(rows)
    expect(folded.entries).toHaveLength(1)
    expect(folded.entries[0].uuid).toBe('a')
    expect(folded.entries[0].evicted).toBe(true)
  })
})

describe('I3: crash before the first v2 commit falls back to v1', () => {
  it('uncommitted v2 generation rows → hasCommittedGeneration=false', () => {
    const rows = [msgRow('g1', 0, 'a'), msgRow('g1', 1, 'b')] // no commit record
    const folded = foldSidecarRowsV2(rows)
    expect(folded.hasCommittedGeneration).toBe(false)
    expect(folded.entries).toEqual([])
  })
})

describe('I4: torn tail is truncated before the next append', () => {
  it('appendBatch recovers a torn partial line so the next batch is parseable', async () => {
    const dir = await tmpDir()
    const id = 'torn'
    const file = join(dir, 'transcripts', `${id}.ndjson`)
    await mkdir(join(dir, 'transcripts'), { recursive: true })
    const g = [msgRow('g1', 0, 'a')]
    const commit = makeCommitV2({ batchId: 'g1', batchType: 'generation', generation: 1, reason: 'ordered-rebuild', contentPolicy: 'preserve', rows: g })
    // Valid committed batch + a torn partial line (no trailing newline).
    await writeFile(file, [...g, commit].map((r) => JSON.stringify(r)).join('\n') + '\n' + '{"v":2,"batchId":"g2","seq":1,"uu')
    const sidecar = new TranscriptSidecar(dir, id)
    const g2 = [msgRow('g2', 1, 'b')]
    await sidecar.appendBatch(g2, makeCommitV2({ batchId: 'g2', batchType: 'live', generation: 1, reason: 'initial', contentPolicy: 'preserve', rows: g2 }))
    await sidecar.close()
    const raw = await readFile(file, 'utf8')
    // Every line parses (the torn fragment was truncated, not concatenated onto).
    for (const line of raw.split('\n').filter(Boolean)) expect(() => JSON.parse(line)).not.toThrow()
    const folded = foldSidecarRowsV2(raw.split('\n').filter(Boolean).map((l) => JSON.parse(l)))
    expect(folded.entries.map((e) => e.uuid)).toEqual(['a', 'b'])
  })
})

describe('I8: trailing app-only entries keep their old order', () => {
  const pe = (occurrenceId: string, msg: unknown, source: ProjectionEntry['source']): ProjectionEntry => ({
    occurrenceId, msg, source, aliases: [], evicted: false,
  })
  it('a handoff boundary+summary after A rebuilds as A,boundary,summary (not reversed)', () => {
    const A = pe('uuid:A:assistant', { type: 'assistant', uuid: 'A', message: { id: 'mA', role: 'assistant', content: [] } }, 'provider')
    const X = pe('uuid:X:system:compact_boundary', { type: 'system', subtype: 'compact_boundary', uuid: 'X' }, 'app')
    const Y = pe('uuid:Y:user:compact_summary', { type: 'user', uuid: 'Y', isCompactSummary: true, message: { role: 'user', content: 's' } }, 'app')
    const out = buildOrderedProjection({ old: [A, X, Y], canonical: [A], pending: [], oldTombstones: [] })
    expect(out.map((e) => e.occurrenceId)).toEqual(['uuid:A:assistant', 'uuid:X:system:compact_boundary', 'uuid:Y:user:compact_summary'])
  })
})
