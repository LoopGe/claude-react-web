import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TranscriptStore } from './transcript-store'
import {
  TranscriptSidecar,
  backfillFromEntries,
  foldSidecarRows,
  recordTranscriptMessage,
  transcriptRow,
  type TranscriptHolder,
} from './transcript-sidecar'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))) })

async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'crw-tsidecar-'))
  dirs.push(dir)
  return dir
}

function holder(dir: string, sessionId = 'sid-1'): TranscriptHolder {
  return { store: new TranscriptStore(sessionId), sidecar: new TranscriptSidecar(dir, sessionId), reconciled: false }
}

/** Holder with a no-op sidecar (pure store assertions — no fs). */
function stubHolder(): TranscriptHolder {
  return {
    store: new TranscriptStore('sid'),
    sidecar: { appendRow: async () => {}, load: async () => [], remove: async () => {} } as unknown as TranscriptSidecar,
    reconciled: true,
  }
}

/** Deterministically drain the sidecar's fire-and-forget append queue: the
 *  queue is serial, so awaiting one MORE append guarantees every earlier
 *  queued write has landed — a fixed sleep does not (it raced the fs
 *  callbacks under a loaded test box and flaked the row-count assertions). */
async function drain(sidecar: TranscriptSidecar): Promise<void> {
  await sidecar.appendRow({ drainSentinel: true })
}

/** Drop the drain() sentinel row from a loaded row list. */
function withoutSentinel(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.filter((r) => r.drainSentinel !== true)
}

function userMsg(uuid: string, text = 'hi'): Record<string, unknown> {
  return { type: 'user', uuid, session_id: 'sid-1', parent_tool_use_id: null, message: { role: 'user', content: text } }
}

function assistantMsg(uuid: string): Record<string, unknown> {
  return { type: 'assistant', uuid, session_id: 'sid-1', message: { role: 'assistant', content: [] } }
}

describe('TranscriptSidecar', () => {
  it('appends rows and loads them back in order', async () => {
    const dir = await tmpDir()
    const sc = new TranscriptSidecar(dir, 'sid-1')
    await sc.appendRow({ seq: 0, uuid: 'a', msg: { type: 'user' } })
    await sc.appendRow({ seq: 1, uuid: 'b', evicted: true })
    const rows = await new TranscriptSidecar(dir, 'sid-1').load()
    expect(rows.map((r) => r.seq)).toEqual([0, 1])
    expect(rows[1].evicted).toBe(true)
  })
  it('serializes concurrent appends without interleaving', async () => {
    const dir = await tmpDir()
    const sc = new TranscriptSidecar(dir, 'sid-1')
    await Promise.all(Array.from({ length: 50 }, (_, i) => sc.appendRow({ seq: i, uuid: `u${i}` })))
    const rows = await new TranscriptSidecar(dir, 'sid-1').load()
    expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i))
  })
  it('writes one ndjson line per row under <dir>/transcripts/<basename(sessionId)>.ndjson', async () => {
    const dir = await tmpDir()
    const sc = new TranscriptSidecar(dir, 'sid-1')
    await sc.appendRow({ seq: 0, uuid: 'a' })
    await sc.appendRow({ seq: 1, uuid: 'b' })
    const raw = await readFile(path.join(dir, 'transcripts', 'sid-1.ndjson'), 'utf8')
    expect(raw.split('\n').filter((l) => l.trim() !== '')).toHaveLength(2)
  })
  it('load tolerates a torn final line', async () => {
    const dir = await tmpDir()
    const sc = new TranscriptSidecar(dir, 'sid-1')
    await sc.appendRow({ seq: 0, uuid: 'a' })
    await sc.appendRow({ seq: 1, uuid: 'b' })
    // Simulate a crash mid-append: half a JSON line at the tail.
    const file = path.join(dir, 'transcripts', 'sid-1.ndjson')
    await appendFile(file, '{"seq":2')
    const rows = await new TranscriptSidecar(dir, 'sid-1').load()
    expect(rows.map((r) => r.seq)).toEqual([0, 1])
  })
  it('remove unlinks the file and is idempotent (ENOENT = success)', async () => {
    const dir = await tmpDir()
    const sc = new TranscriptSidecar(dir, 'sid-1')
    await sc.appendRow({ seq: 0, uuid: 'a' })
    await sc.remove()
    await expect(new TranscriptSidecar(dir, 'sid-1').load()).resolves.toEqual([])
    // Second remove: no file, still resolves.
    await new TranscriptSidecar(dir, 'sid-1').remove()
  })
  it('remove drains pending appends before unlinking', async () => {
    const dir = await tmpDir()
    const sc = new TranscriptSidecar(dir, 'sid-1')
    // Fire-and-forget appends still queued when remove() is called.
    for (let i = 0; i < 5; i++) void sc.appendRow({ seq: i, uuid: `u${i}` })
    await sc.remove()
    await expect(new TranscriptSidecar(dir, 'sid-1').load()).resolves.toEqual([])
  })
})

describe('foldSidecarRows', () => {
  it('folds tombstone rows onto the matching base row regardless of arrival order', () => {
    // Tombstone AFTER base (the normal append order).
    expect(foldSidecarRows([
      { seq: 0, uuid: 'a', type: 'user', msg: { type: 'user' } },
      { seq: 1, evicted: true },
    ])).toEqual([
      { seq: 0, uuid: 'a', msg: { type: 'user' }, evicted: undefined },
      { seq: 1, uuid: null, evicted: true },
    ])
    // Tombstone BEFORE base (eviction persisted while dormant, base appended
    // by a later reconcile back-fill) — the eviction must still stick.
    expect(foldSidecarRows([
      { seq: 2, evicted: true },
      { seq: 2, uuid: 'c', msg: { type: 'assistant' } },
    ])).toEqual([
      { seq: 2, uuid: 'c', msg: { type: 'assistant' }, evicted: true },
    ])
  })
  it('skips malformed rows (non-integer / negative / missing seq)', () => {
    expect(foldSidecarRows([{ seq: 'x' }, { seq: -1 }, { noSeq: true }, { seq: 1.5 }, { seq: 3, uuid: 'ok' }]))
      .toEqual([{ seq: 3, uuid: 'ok', msg: undefined, evicted: undefined }])
  })
})

describe('recordTranscriptMessage (seq assignment gate)', () => {
  it('assigns consecutive seqs to renderable messages and persists rows', async () => {
    const dir = await tmpDir()
    const t = holder(dir)
    expect(recordTranscriptMessage(t, userMsg('u1'))).toBe(0)
    expect(recordTranscriptMessage(t, assistantMsg('a1'))).toBe(1)
    await drain(t.sidecar)
    const rows = withoutSentinel(await new TranscriptSidecar(dir, 'sid-1').load())
    expect(rows.map((r) => r.seq)).toEqual([0, 1])
    expect(rows[0].uuid).toBe('u1')
    expect(rows[0].type).toBe('user')
  })
  it('does not re-allocate or re-persist a repeated uuid (SDK echo)', async () => {
    const dir = await tmpDir()
    const t = holder(dir)
    expect(recordTranscriptMessage(t, userMsg('u1'))).toBe(0)
    expect(recordTranscriptMessage(t, userMsg('u1'))).toBe(0)
    expect(recordTranscriptMessage(t, userMsg('u2'))).toBe(1)
    await drain(t.sidecar)
    const rows = withoutSentinel(await new TranscriptSidecar(dir, 'sid-1').load())
    expect(rows).toHaveLength(2)
  })
  it('allocates nothing for ephemeral / sidechain / non-broadcast system frames', async () => {
    const dir = await tmpDir()
    const t = holder(dir)
    expect(recordTranscriptMessage(t, { type: 'stream_event', uuid: 's1' })).toBeNull()
    expect(recordTranscriptMessage(t, { type: 'system', subtype: 'init', uuid: 's2' })).toBeNull()
    expect(recordTranscriptMessage(t, { type: 'system', subtype: 'status', uuid: 's3' })).toBeNull()
    expect(recordTranscriptMessage(t, { type: 'tool_progress', uuid: 's4' })).toBeNull()
    // The interrupt placeholder user frame renders as a stray bubble on both
    // paths — excluded from the seq space like the disk gate excludes it.
    expect(recordTranscriptMessage(t, userMsg('ph1', '[Request interrupted by user]'))).toBeNull()
    // Sidechain (subagent inner stream): parent set → no seq.
    expect(recordTranscriptMessage(t, { type: 'assistant', uuid: 'sc1', parent_tool_use_id: 'tu_1', message: { content: [] } })).toBeNull()
    expect(t.store.headSeq).toBe(0)
    // Main-thread frames after all of that get the seqs.
    expect(recordTranscriptMessage(t, userMsg('u1'))).toBe(0)
    expect(recordTranscriptMessage(t, assistantMsg('main1'))).toBe(1)
  })
  it('result frames and tool_use_summary are renderable (they render as transcript rows)', () => {
    const t = stubHolder()
    expect(recordTranscriptMessage(t, { type: 'result', uuid: 'r1' })).toBe(0)
    expect(recordTranscriptMessage(t, { type: 'tool_use_summary', uuid: 't1', summary: 'x' })).toBe(1)
    expect(t.store.messageAt(0)?.msg).toMatchObject({ type: 'result' })
  })
  it('keeps the message object on the store entry (window reads return it)', async () => {
    const dir = await tmpDir()
    const t = holder(dir)
    const msg = userMsg('u1', 'hello')
    recordTranscriptMessage(t, msg)
    expect(t.store.window(undefined, 10).messages[0].msg).toBe(msg)
  })
})

describe('backfillFromEntries (sidecar catch-up)', () => {
  it('appends only the entries the store does not already know', async () => {
    const dir = await tmpDir()
    const t = holder(dir)
    // Pre-existing state (e.g. sidecar-hydrated rows 0-1).
    t.store.hydrate(foldSidecarRows([
      transcriptRow(0, 'old1', { type: 'user' }),
      transcriptRow(1, 'old2', { type: 'assistant' }),
    ]))
    const appended = backfillFromEntries(t, [
      userMsg('old1'), // known → skipped
      assistantMsg('old2'), // known → skipped
      userMsg('new1'),
      assistantMsg('new2'),
    ])
    expect(appended).toBe(2)
    expect(t.store.headSeq).toBe(4)
    expect(t.store.seqOf('new1')).toBe(2)
    expect(t.store.seqOf('new2')).toBe(3)
  })
  it('positionally skips uuid-less entries already covered by the hydrated rows', () => {
    const t = stubHolder()
    t.store.hydrate([{ seq: 0, uuid: null, msg: { type: 'user' } }])
    const appended = backfillFromEntries(t, [{ type: 'user', message: {} }, userMsg('u2')])
    expect(appended).toBe(1)
    expect(t.store.headSeq).toBe(2)
  })
  it('a full cold rebuild assigns dense seqs in entry order', async () => {
    const dir = await tmpDir()
    const t = holder(dir)
    const entries = Array.from({ length: 10 }, (_, i) => userMsg(`u${i}`))
    expect(backfillFromEntries(t, entries)).toBe(10)
    expect(t.store.headSeq).toBe(10)
    const w = t.store.window(undefined, 20)
    expect(w.messages.map((m) => m.uuid)).toEqual(Array.from({ length: 10 }, (_, i) => `u${i}`))
  })
})

describe('TranscriptStore extensions (Task 3)', () => {
  it('record(uuid, msg) keeps the message and dedups without touching it', () => {
    const s = new TranscriptStore('sid')
    const msg = { type: 'user' }
    expect(s.record('u1', msg)).toBe(0)
    expect(s.record('u1', { type: 'assistant' })).toBe(0) // echo: original msg untouched
    expect(s.messageAt(0)?.msg).toBe(msg)
  })
  it('visibleCount excludes tombstones', () => {
    const s = new TranscriptStore('sid')
    for (let i = 0; i < 5; i++) s.record(`u${i}`)
    expect(s.visibleCount).toBe(5)
    s.evict(['u1', 'u3'])
    expect(s.visibleCount).toBe(3)
    expect(s.headSeq).toBe(5) // seq space unchanged
  })
})
