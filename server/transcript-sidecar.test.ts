import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import * as nodeFs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TranscriptStore } from './transcript-store'
import {
  TranscriptSidecar,
  backfillFromEntries,
  foldSidecarRows,
  foldSidecarRowsV2,
  truncateToLastCommit,
  makeCommitV2,
  recordTranscriptMessage,
  transcriptRow,
  type TranscriptHolder,
} from './transcript-sidecar'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))) })

async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'crw-tsidecar-'))
  dirs.push(dir)
  return dir
}

function holder(dir: string, sessionId = 'sid-1'): TranscriptHolder {
  return { store: new TranscriptStore(sessionId), sidecar: new TranscriptSidecar(dir, sessionId), reconciled: false, degraded: false }
}

/** Holder with a no-op sidecar (pure store assertions — no fs). */
function stubHolder(): TranscriptHolder {
  return {
    store: new TranscriptStore('sid'),
    sidecar: { appendRow: async () => {}, load: async () => [], remove: async () => {} } as unknown as TranscriptSidecar,
    reconciled: true,
    degraded: false,
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

const MULTI_BLOCK_MSG_ID = 'msg_d7f04e09-b02a-97de-a134-bf4a2267a72c'
const DERIVED_UUID_PREFIX = '00bf9e30-3506-44fd-b02c-'
/** The CLI splits an assistant message with more than one content block into
 *  one streamed frame per block, each carrying this derived uuid:
 *  `uuid.slice(0,24) + blockIndex.toString(16).padStart(12,'0')`. */
const derivedUuid = (blockIndex: number) => `${DERIVED_UUID_PREFIX}${blockIndex.toString(16).padStart(12, '0')}`
const ORIGINAL_UUID = `${DERIVED_UUID_PREFIX}638463dbf3fa`

function assistantWithContent(
  uuid: string,
  messageId: string,
  content: unknown[],
  restoredFromDisk = false,
): Record<string, unknown> {
  return {
    type: 'assistant',
    uuid,
    session_id: 'sid-1',
    ...(restoredFromDisk ? { restoredFromDisk: true } : {}),
    message: { id: messageId, role: 'assistant', content },
  }
}

const thinkingBlock = (text: string) => ({ type: 'thinking', thinking: text, signature: '' })
const toolUseBlock = (id: string, name: string) => ({ type: 'tool_use', id, name, input: { file_path: 'x' } })
const multiBlockContent = [thinkingBlock('t'), toolUseBlock('tu-1', 'Edit'), toolUseBlock('tu-2', 'Write')]

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
  it('close drains pending appends, preserves the file, and blocks later appends', async () => {
    const dir = await tmpDir()
    const sc = new TranscriptSidecar(dir, 'sid-1')
    for (let i = 0; i < 5; i++) void sc.appendRow({ seq: i, uuid: `u${i}` })
    await sc.close()
    await sc.appendRow({ seq: 5, uuid: 'late' })
    const rows = await new TranscriptSidecar(dir, 'sid-1').load()
    expect(rows.map((r) => r.seq)).toEqual([0, 1, 2, 3, 4])
  })
  it('closes the file handle when an append fails', async () => {
    const dir = await tmpDir()
    const sc = new TranscriptSidecar(dir, 'sid-1')
    let closeCalls = 0
    const originalOpen = nodeFs.open
    const actualOpen = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open
    const openMock = vi.mocked(nodeFs.open)
    openMock.mockImplementationOnce(async (...args) => {
      const handle = await originalOpen(...args)
      vi.spyOn(handle, 'writeFile').mockRejectedValueOnce(new Error('disk full'))
      const originalClose = handle.close.bind(handle)
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        closeCalls++
        return originalClose()
      })
      return handle
    })
    try {
      await sc.appendRow({ seq: 0, uuid: 'a' })
      expect(closeCalls).toBe(1)
    } finally {
      openMock.mockImplementation(actualOpen)
    }
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
  it('evicts a disk-restored whole-message copy of blocks already recorded per frame', () => {
    // Resume reconcile used to append the CLI JSONL's single multi-block
    // assistant line (original uuid) even though the live stream had already
    // recorded the same message as one frame per block (derived uuids), so the
    // duplicate landed at the seq head and rendered as the transcript tail.
    const folded = foldSidecarRows([
      ...[0, 1, 2].map((i) => ({
        seq: 2155 + i,
        uuid: derivedUuid(i),
        type: 'assistant',
        msg: assistantWithContent(derivedUuid(i), MULTI_BLOCK_MSG_ID, [multiBlockContent[i]]),
      })),
      {
        seq: 2786,
        uuid: ORIGINAL_UUID,
        type: 'assistant',
        msg: assistantWithContent(ORIGINAL_UUID, MULTI_BLOCK_MSG_ID, multiBlockContent, true),
      },
    ])
    expect(folded.map((r) => r.evicted)).toEqual([undefined, undefined, undefined, true])
  })
  it('keeps the disk copy when it carries blocks the live frames never delivered', () => {
    // Crash mid-stream: live recorded two of the three blocks. Evicting the
    // disk copy would drop the third, so the heal must stay hands-off.
    const folded = foldSidecarRows([
      { seq: 0, uuid: derivedUuid(0), type: 'assistant', msg: assistantWithContent(derivedUuid(0), MULTI_BLOCK_MSG_ID, [multiBlockContent[0]]) },
      { seq: 1, uuid: derivedUuid(1), type: 'assistant', msg: assistantWithContent(derivedUuid(1), MULTI_BLOCK_MSG_ID, [multiBlockContent[1]]) },
      { seq: 2, uuid: ORIGINAL_UUID, type: 'assistant', msg: assistantWithContent(ORIGINAL_UUID, MULTI_BLOCK_MSG_ID, multiBlockContent, true) },
    ])
    expect(folded.map((r) => r.evicted)).toEqual([undefined, undefined, undefined])
  })
  it('leaves per-frame rows alone when no whole-message copy exists', () => {
    const folded = foldSidecarRows([0, 1, 2].map((i) => ({
      seq: i,
      uuid: derivedUuid(i),
      type: 'assistant',
      msg: assistantWithContent(derivedUuid(i), MULTI_BLOCK_MSG_ID, [multiBlockContent[i]]),
    })))
    expect(folded.map((r) => r.evicted)).toEqual([undefined, undefined, undefined])
  })
  it('removes a retracted message’s whole-message copy along with its tombstoned frames', () => {
    // The retraction tombstoned the three derived-uuid frames; the old
    // reconcile then appended the whole-message line. The copy must go too, or
    // the retracted reply stays visible at the transcript tail.
    const folded = foldSidecarRows([
      ...[0, 1, 2].map((i) => ({
        seq: i,
        uuid: derivedUuid(i),
        type: 'assistant',
        msg: assistantWithContent(derivedUuid(i), MULTI_BLOCK_MSG_ID, [multiBlockContent[i]]),
      })),
      ...[0, 1, 2].map((seq) => ({ seq, evicted: true })),
      {
        seq: 6,
        uuid: ORIGINAL_UUID,
        type: 'assistant',
        msg: assistantWithContent(ORIGINAL_UUID, MULTI_BLOCK_MSG_ID, multiBlockContent, true),
      },
    ])
    expect(folded.map((r) => r.evicted)).toEqual([true, true, true, true])
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
    // Settle the fire-and-forget sidecar writes before afterEach's rm: an
    // append landing after the recursive rm has unlinked the file re-creates
    // it, and the final rmdir fails ENOTEMPTY.
    await drain(t.sidecar)
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
    // Settle the fire-and-forget sidecar write before afterEach's rm (see the
    // drain note above).
    await drain(t.sidecar)
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
    // Settle the fire-and-forget sidecar writes before afterEach's rm (see the
    // drain note above).
    await drain(t.sidecar)
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
    // Settle the fire-and-forget sidecar writes before afterEach's rm (see the
    // drain note above).
    await drain(t.sidecar)
  })
  it('skips a disk row for a multi-block assistant message already recorded per frame', () => {
    const t = stubHolder()
    // Live stream: one frame per content block, each with a CLI-derived uuid.
    for (let i = 0; i < multiBlockContent.length; i++) {
      expect(recordTranscriptMessage(t, assistantWithContent(derivedUuid(i), MULTI_BLOCK_MSG_ID, [multiBlockContent[i]]))).toBe(i)
    }
    // Disk JSONL: the same message once, under its original uuid. Its uuid is
    // unknown to the store, but its message id is not — appending it would put
    // a whole duplicate of the message at the seq head.
    const appended = backfillFromEntries(t, [
      assistantWithContent(ORIGINAL_UUID, MULTI_BLOCK_MSG_ID, multiBlockContent, true),
      // A genuinely new message id still appends.
      assistantWithContent(`${DERIVED_UUID_PREFIX}0000000000ff`, 'msg_other', [thinkingBlock('x')], true),
    ])
    expect(appended).toBe(1)
    expect(t.store.headSeq).toBe(4)
  })
  it('appends every per-block JSONL line of one assistant message', () => {
    const t = stubHolder()
    // The dominant JSONL shape (and the one a cold rebuild sees): one line per
    // content block, each with its own uuid, all sharing one message id. The
    // message-id identity must not collapse them into a single row.
    const entries = multiBlockContent.map((block, i) =>
      assistantWithContent(`uuid-block-${i}`, MULTI_BLOCK_MSG_ID, [block], true))
    expect(backfillFromEntries(t, entries)).toBe(3)
    expect(t.store.headSeq).toBe(3)
  })
  it('appends a whole-message line whose blocks the live frames did not all record', () => {
    const t = stubHolder()
    // Crash mid-stream: the store has two of the three blocks. Skipping the
    // disk line would silently drop the third, so coverage — not mere
    // identity — decides.
    for (let i = 0; i < 2; i++) {
      recordTranscriptMessage(t, assistantWithContent(derivedUuid(i), MULTI_BLOCK_MSG_ID, [multiBlockContent[i]]))
    }
    expect(backfillFromEntries(t, [
      assistantWithContent(ORIGINAL_UUID, MULTI_BLOCK_MSG_ID, multiBlockContent, true),
    ])).toBe(1)
    expect(t.store.headSeq).toBe(3)
  })
  it('does not resurrect a retracted multi-block message from its disk copy', () => {
    const t = stubHolder()
    const uuids = [0, 1, 2].map(derivedUuid)
    uuids.forEach((u, i) => recordTranscriptMessage(t, assistantWithContent(u, MULTI_BLOCK_MSG_ID, [multiBlockContent[i]])))
    expect(t.store.evict(uuids)).toEqual([0, 1, 2])
    // The retraction tombstones the live uuids, which the disk copy's original
    // uuid never matches; the coverage projection includes tombstoned rows.
    expect(backfillFromEntries(t, [assistantWithContent(ORIGINAL_UUID, MULTI_BLOCK_MSG_ID, multiBlockContent, true)])).toBe(0)
    expect(t.store.visibleCount).toBe(0)
  })
  it('does not resurrect a retracted response even when its recorded blocks differ', () => {
    const t = stubHolder()
    // Only two of the three blocks were ever recorded, and they are retracted.
    // Content no longer matches the disk line, but a fully tombstoned response
    // must still be treated as covered.
    const uuids = [0, 1].map(derivedUuid)
    uuids.forEach((u, i) => recordTranscriptMessage(t, assistantWithContent(u, MULTI_BLOCK_MSG_ID, [multiBlockContent[i]])))
    expect(t.store.evict(uuids)).toEqual([0, 1])
    expect(backfillFromEntries(t, [assistantWithContent(ORIGINAL_UUID, MULTI_BLOCK_MSG_ID, multiBlockContent, true)])).toBe(0)
    expect(t.store.visibleCount).toBe(0)
  })
  it('retracting a whole-message uuid evicts every block of the response', () => {
    const t = stubHolder()
    const uuids = [0, 1, 2].map(derivedUuid)
    uuids.forEach((u, i) => recordTranscriptMessage(t, assistantWithContent(u, MULTI_BLOCK_MSG_ID, [multiBlockContent[i]])))
    // Reconcile skipped the whole-message line and aliased its original uuid.
    expect(backfillFromEntries(t, [assistantWithContent(ORIGINAL_UUID, MULTI_BLOCK_MSG_ID, multiBlockContent, true)])).toBe(0)
    // The CLI retracts the uuid it persisted; every block must go, not just the
    // first (aliased) one.
    expect(t.store.evict([ORIGINAL_UUID])).toEqual([0, 1, 2])
    expect(t.store.visibleCount).toBe(0)
  })
  it('stays idempotent when hydrate replays rows the live path already recorded', () => {
    const t = stubHolder()
    const msgs = [0, 1, 2].map((i) =>
      assistantWithContent(derivedUuid(i), MULTI_BLOCK_MSG_ID, [multiBlockContent[i]]))
    msgs.forEach((msg) => recordTranscriptMessage(t, msg))
    // A live session does not reconcile at spawn: its first transcript read
    // hydrates the sidecar rows over the live records. Replaying them must not
    // double the coverage projection.
    t.store.hydrate(foldSidecarRows(msgs.map((msg, i) => transcriptRow(i, derivedUuid(i), msg))))
    expect(backfillFromEntries(t, [
      assistantWithContent(ORIGINAL_UUID, MULTI_BLOCK_MSG_ID, multiBlockContent, true),
    ])).toBe(0)
    // The skipped line's original uuid still resolves for uuid-anchored reads
    // (/messages?aroundUuid, /history?beforeUuid).
    expect(t.store.seqOf(ORIGINAL_UUID)).toBe(0)
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

describe('sidecar v2 batch commits / fold / crash recovery (spec §8.2/§9)', () => {
  function msgRow(batchId: string, seq: number, uuid: string, occurrenceId = `uuid:${uuid}:user`): Record<string, unknown> {
    return { v: 2, batchId, seq, occurrenceId, source: 'provider', aliases: [], uuid, type: 'user', msg: { type: 'user', uuid, message: { role: 'user', content: uuid } } }
  }
  function genCommit(batchId: string, generation: number, rows: object[]): Record<string, unknown> {
    return makeCommitV2({ batchId, batchType: 'generation', generation, reason: 'ordered-rebuild', contentPolicy: 'preserve', rows })
  }
  function liveCommit(batchId: string, generation: number, rows: object[]): Record<string, unknown> {
    return makeCommitV2({ batchId, batchType: 'live', generation, reason: 'initial', contentPolicy: 'preserve', rows })
  }
  function lines(...rows: object[]): string {
    return rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
  }

  it('fold adopts the latest committed generation and replays a later live batch', () => {
    const g0 = [msgRow('g0', 0, 'a')]
    const g1 = [msgRow('g1', 0, 'b')]
    const live = [msgRow('l1', 1, 'c')]
    const rows = [
      ...g0, genCommit('g0', 0, g0),
      ...g1, genCommit('g1', 1, g1),
      ...live, liveCommit('l1', 1, live),
    ]
    const folded = foldSidecarRowsV2(rows)
    expect(folded.generation).toBe(1)
    expect(folded.entries.map((e) => e.uuid)).toEqual(['b', 'c'])
    expect(folded.entries.map((e) => e.seq)).toEqual([0, 1])
    expect(folded.history.map((h) => h.generation)).toEqual([0, 1])
  })

  it('uncommitted batch is ignored by fold; truncate returns prior committed prefix + salvaged tail', () => {
    const g0 = [msgRow('g0', 0, 'a')]
    const orphan = [msgRow('orphan', 1, 'x')]
    const raw = lines(...g0, genCommit('g0', 0, g0), ...orphan)
    const rows = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const folded = foldSidecarRowsV2(rows)
    expect(folded.entries.map((e) => e.uuid)).toEqual(['a'])
    const { prefix, salvaged } = truncateToLastCommit(raw)
    expect(prefix).toBe(lines(...g0, genCommit('g0', 0, g0)))
    expect(salvaged.map((r) => r.uuid)).toEqual(['x'])
  })

  it('a committed non-public recovery batch after the generation commit survives truncation', () => {
    const g0 = [msgRow('g0', 0, 'a')]
    const recovery = [{ v: 2, batchId: 'r1', operationId: 'op1', payload: { kind: 'result-revision' } }]
    const rCommit = makeCommitV2({ batchId: 'r1', batchType: 'recovery', generation: 0, reason: 'initial', contentPolicy: 'preserve', rows: recovery })
    const raw = lines(...g0, genCommit('g0', 0, g0), ...recovery, rCommit)
    const { prefix, salvaged } = truncateToLastCommit(raw)
    expect(prefix).toBe(raw)
    expect(salvaged).toEqual([])
  })

  it('a complete commit record with a bad checksum is not truncatable; fold throws corrupt-sidecar', () => {
    const g0 = [msgRow('g0', 0, 'a')]
    const badCommit = { ...genCommit('g0', 0, g0), checksum: 'deadbeef' }
    const raw = lines(...g0, badCommit)
    expect(() => truncateToLastCommit(raw)).toThrow(/corrupt-sidecar/)
    const rows = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    expect(() => foldSidecarRowsV2(rows)).toThrow(/corrupt-sidecar/)
  })

  it('v1 duplicate base seq fails with duplicate-seq', () => {
    const rows = [
      { seq: 0, uuid: 'a', type: 'user', msg: { type: 'user', uuid: 'a' } },
      { seq: 0, uuid: 'b', type: 'user', msg: { type: 'user', uuid: 'b' } },
    ]
    expect(() => foldSidecarRows(rows)).toThrow(/duplicate-seq/)
  })

  it('appendBatch fsyncs before resolving and propagates write errors', async () => {
    const dir = await tmpDir()
    // Derive the real FileHandle prototype from an actual handle (the module
    // mock does not re-export the FileHandle class binding).
    const probe = await nodeFs.open(path.join(dir, 'probe'), 'w')
    const handleProto = Object.getPrototypeOf(probe) as { sync: () => Promise<void>; writeFile: (d: string) => Promise<void> }
    await probe.close()

    const sidecar = new TranscriptSidecar(dir, 'sid-batch')
    const syncSpy = vi.spyOn(handleProto, 'sync')
    const rows = [msgRow('b1', 0, 'a')]
    await sidecar.appendBatch(rows, genCommit('b1', 0, rows))
    expect(syncSpy).toHaveBeenCalled()
    const loaded = await sidecar.load()
    expect(loaded.some((r) => r.commit === true)).toBe(true)
    syncSpy.mockRestore()
    await sidecar.close()

    const dir2 = await tmpDir()
    const sidecar2 = new TranscriptSidecar(dir2, 'sid-err')
    // Force the next write to fail; appendBatch must reject (not swallow).
    const writeSpy = vi.spyOn(handleProto, 'writeFile').mockRejectedValueOnce(new Error('disk full'))
    await expect(sidecar2.appendBatch([msgRow('b2', 0, 'z')], genCommit('b2', 0, []))).rejects.toThrow('disk full')
    writeSpy.mockRestore()
    await sidecar2.close()
  })
})
