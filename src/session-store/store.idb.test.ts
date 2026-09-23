// Phase 1 tests: IndexedDB transcript cache (Plan C).
// Runs in jsdom with `fake-indexeddb` polyfilling the global `indexedDB`.
// Each test resets to a fresh IDBFactory so stores don't leak across tests.
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionStore } from './store'
import { _resetDbForTests, openDb, scanUuidSeqs, cursorRecent, clearSession, putMessages } from './idb'
import type { SdkMessage } from '../types'

const STORAGE_PREFIX = 'claude-web-session:'

/** Reset IDB to a clean factory + clear the module-level DB cache so each
 *  test opens fresh. Also clear localStorage (the LS co-cache). */
function resetIdb(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).indexedDB = new IDBFactory()
  _resetDbForTests()
}

function userMsg(uuid: string, text = 'hi'): SdkMessage {
  return { type: 'user', uuid, message: { role: 'user', content: text } } as unknown as SdkMessage
}
function asstMsg(uuid: string, text = 'hello'): SdkMessage {
  return { type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'text', text }] } } as unknown as SdkMessage
}
function apiRetryMsg(uuid: string): SdkMessage {
  return { type: 'system', subtype: 'api_retry', uuid, attempt: 1, max_retries: 3, retry_delay_ms: 1000 } as unknown as SdkMessage
}

async function readAllIdbRecords(sessionId: string): Promise<Array<{ uuid: string; seq: number }>> {
  const db = await openDb()
  if (!db) throw new Error('IDB unavailable')
  const uuidSeqs = await scanUuidSeqs(db, sessionId)
  return Array.from(uuidSeqs.entries()).map(([uuid, seq]) => ({ uuid, seq }))
}

describe('SessionStore IDB cache (Phase 1)', () => {
  beforeEach(() => {
    resetIdb()
    localStorage.clear()
  })
  afterEach(() => {
    localStorage.clear()
  })

  it('delta-writes new messages to IDB with increasing seq', async () => {
    const store = new SessionStore('s1')
    await store.idbReady
    store.dispatch({ type: 'MESSAGE', message: userMsg('u1', 'one') })
    store.dispatch({ type: 'MESSAGE', message: asstMsg('a1', 'two') })
    store.dispatch({ type: 'MESSAGE', message: userMsg('u2', 'three') })
    store.persistNow()
    await store.flushIdb()

    const records = await readAllIdbRecords('s1')
    expect(records).toHaveLength(3)
    const u1 = records.find((r) => r.uuid === 'u1')!
    const a1 = records.find((r) => r.uuid === 'a1')!
    const u2 = records.find((r) => r.uuid === 'u2')!
    // Appended in arrival order → strictly increasing seq.
    expect(u1.seq).toBeLessThan(a1.seq)
    expect(a1.seq).toBeLessThan(u2.seq)
  })

  it('cold-loads IDB history into a fresh store (supersedes LS tail)', async () => {
    // First store: populate IDB with several messages.
    const s1 = new SessionStore('s2')
    await s1.idbReady
    for (let i = 0; i < 5; i++) {
      s1.dispatch({ type: 'MESSAGE', message: asstMsg(`a-${i}`, `msg ${i}`) })
    }
    s1.persistNow()
    await s1.flushIdb()
    await s1.destroy()

    // Second store: cold-load should prepend the IDB messages.
    const s2 = new SessionStore('s2')
    await s2.idbReady
    const items = s2.getSnapshot().items
    expect(items.length).toBeGreaterThanOrEqual(5)
    expect(items.map((i) => i.id)).toContain('a-4')
    expect(items.map((i) => i.id)).toContain('a-0')
  })

  it('publishes idbReady once the async IDB state has settled', async () => {
    // The subscribe path waits for this: a cold-load can still prepend rows
    // into an empty store after hydration, which both flips the client's
    // cache declaration and can race a tail-first burst's backfill chunks.
    const store = new SessionStore('s-idbready')
    expect(store.getSnapshot().idbReady).toBe(false)
    await store.idbReady
    expect(store.getSnapshot().idbReady).toBe(true)
  })

  it('adopts a reconnect cursor when a cold-load prepends rows into an empty store', async () => {
    // LS cache lost, IDB survived (private mode, quota eviction, cleared LS):
    // the cold-load prepends rows, so the client HAS a transcript while the
    // cursor stays null. Deriving it keeps the client honest about what it
    // holds — incremental replay on reconnect, and no tail-first opt-in.
    const s1 = new SessionStore('s-cursor')
    await s1.idbReady
    for (let i = 0; i < 3; i++) s1.dispatch({ type: 'MESSAGE', message: asstMsg(`a-${i}`, `msg ${i}`) })
    s1.persistNow()
    await s1.flushIdb()
    await s1.destroy()
    localStorage.removeItem(STORAGE_PREFIX + 's-cursor')

    const s2 = new SessionStore('s-cursor')
    await s2.idbReady
    expect(s2.getSnapshot().items.length).toBeGreaterThanOrEqual(3)
    expect(s2.getState().mirror.lastMessageUuid).toBe('a-2')
  })

  it('api_retry is transient: never enters IDB (no supersession tracking needed)', async () => {
    // api_retry is routed to the mirror.apiRetry slot, NOT items/messages/IDB,
    // so the transcript stays append-only. Consecutive api_retry overwrite the
    // slot (no in-place replace, no IDB delete). Neither retry uuid lands in
    // IDB → nothing to supersede, nothing to re-emerge on cold-load.
    const store = new SessionStore('s3')
    await store.idbReady
    store.dispatch({ type: 'MESSAGE', message: apiRetryMsg('retry-1') })
    store.dispatch({ type: 'MESSAGE', message: apiRetryMsg('retry-2') })
    // A real message alongside, to confirm only non-retry frames persist.
    store.dispatch({ type: 'MESSAGE', message: asstMsg('a1') })
    store.persistNow()
    await store.flushIdb()

    const records = await readAllIdbRecords('s3')
    const uuids = records.map((r) => r.uuid)
    expect(uuids).toEqual(['a1']) // only the assistant frame; no api_retry
    // The latest api_retry is held in the transient slot (cleared by the
    // assistant frame that followed it).
    expect(store.getSnapshot().apiRetry).toBeNull()
  })

  it('clearPersisted clears IDB records for the session', async () => {
    const store = new SessionStore('s4')
    await store.idbReady
    store.dispatch({ type: 'MESSAGE', message: userMsg('u1') })
    store.dispatch({ type: 'MESSAGE', message: asstMsg('a1') })
    store.persistNow()
    await store.flushIdb()
    expect((await readAllIdbRecords('s4')).length).toBe(2)

    store.clearPersisted()
    await store.flushIdb() // awaits the clear
    expect((await readAllIdbRecords('s4')).length).toBe(0)
    expect(localStorage.getItem(STORAGE_PREFIX + 's4')).toBeNull()
  })

  it('falls back to Plan B (LS only) when IDB is unavailable', async () => {
    // Simulate private mode: no indexedDB global.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).indexedDB = undefined
    _resetDbForTests()

    const store = new SessionStore('s5')
    await store.idbReady
    store.dispatch({ type: 'MESSAGE', message: userMsg('u1', 'hello') })
    store.persistNow()
    await store.flushIdb()
    // IDB disabled — no throw, LS still has the data.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).indexedDB = new IDBFactory()
    _resetDbForTests()
    const db = await openDb()
    expect(db).not.toBeNull()
    const records = await scanUuidSeqs(db!, 's5')
    expect(records.size).toBe(0) // nothing written to IDB
    // LS has it.
    const raw = localStorage.getItem(STORAGE_PREFIX + 's5')
    expect(raw).not.toBeNull()
  })

  it('cursorRecent returns oldest-first for PREPEND', async () => {
    // Seed IDB directly via a store, then read via cursorRecent.
    const store = new SessionStore('s6')
    await store.idbReady
    store.dispatch({ type: 'MESSAGE', message: asstMsg('a-0', 'first') })
    store.dispatch({ type: 'MESSAGE', message: asstMsg('a-1', 'second') })
    store.dispatch({ type: 'MESSAGE', message: asstMsg('a-2', 'third') })
    store.persistNow()
    await store.flushIdb()

    const db = await openDb()
    const records = await cursorRecent(db!, 's6', 3)
    // oldest-first → a-0, a-1, a-2
    expect(records.map((r) => r.uuid)).toEqual(['a-0', 'a-1', 'a-2'])
    // The limit keeps the MOST RECENT n (still oldest-first). This is the
    // mechanism initIdb's cold-load relies on to bound memory at
    // MEMORY_ITEM_CAP, so it is asserted here rather than by seeding a store
    // with cap+1 records (which cost ~15s under fake-indexeddb).
    const capped = await cursorRecent(db!, 's6', 2)
    expect(capped.map((r) => r.uuid)).toEqual(['a-1', 'a-2'])
  })

  it('clearSession idb helper deletes all records + meta', async () => {
    const store = new SessionStore('s7')
    await store.idbReady
    store.dispatch({ type: 'MESSAGE', message: asstMsg('a-0') })
    store.persistNow()
    await store.flushIdb()
    const db = await openDb()
    await clearSession(db!, 's7')
    expect((await scanUuidSeqs(db!, 's7')).size).toBe(0)
  })

  // ── Phase 2: loadOlder from IDB ────────────────────────────────────
  //
  // These three used to be ONE test that seeded 1001 records so that
  // MEMORY_ITEM_CAP (1000) would make cold-load leave exactly one record
  // behind in IDB. Under fake-indexeddb every cursor step is a promise
  // round-trip (~7.5ms per record), so initIdb's two walks — scanUuidSeqs +
  // cursorRecent — cost ~15s for what was only the test's SETUP;
  // loadOlderFromIdb itself ran in 3ms.
  //
  // loadOlderFromIdb depends on exactly one thing: IDB holding records at a
  // seq below the oldest in-memory message's. That state is built directly
  // below, which is ~100x cheaper AND reaches the hasMore / non-contiguous
  // branches of cursorOlder that the 1001-record version never exercised.

  /** Store with one persisted message in memory (assigned seq 1), plus
   *  IDB-only records at `seqs` (all < 1, so they sit older than the tail). */
  async function storeWithIdbOnlySeqs(sessionId: string, seqs: number[]): Promise<SessionStore> {
    const store = new SessionStore(sessionId)
    await store.idbReady
    store.dispatch({ type: 'MESSAGE', message: asstMsg('tail', 'in memory') })
    store.persistNow()
    await store.flushIdb()
    const db = await openDb()
    const records = seqs.map((seq) => ({
      sessionId,
      uuid: `s${seq}`,
      seq,
      msg: asstMsg(`s${seq}`, `older ${seq}`),
    }))
    await putMessages(db!, records, { sessionId, maxSeq: 1, minSeq: Math.min(...seqs) })
    return store
  }

  it('loadOlderFromIdb pages records older than the in-memory tail, oldest-first', async () => {
    const store = await storeWithIdbOnlySeqs('s8', [0, -1])
    expect(store.getSnapshot().items.map((i) => i.id)).toEqual(['tail'])

    const page = await store.loadOlderFromIdb(200)
    expect(page).not.toBeNull()
    expect(page!.messages.map((m) => m.uuid)).toEqual(['s-1', 's0'])
    expect(page!.hasMore).toBe(false)
    expect(page!.contiguous).toBe(true) // seq 0 abuts the tail's seq 1
  })

  it('loadOlderFromIdb reports hasMore when records remain below the page', async () => {
    const store = await storeWithIdbOnlySeqs('s8b', [0, -1, -2])

    const page = await store.loadOlderFromIdb(2)
    expect(page!.messages.map((m) => m.uuid)).toEqual(['s-1', 's0']) // the 2 newest older
    expect(page!.hasMore).toBe(true)
    expect(page!.contiguous).toBe(true)
  })

  it('loadOlderFromIdb reports contiguous:false across a seq gap (mid-write tab close)', async () => {
    // seq 0 is missing, so the newest IDB record (-1) does not abut the
    // tail's seq 1 — the caller must probe the server to bridge the hole.
    const store = await storeWithIdbOnlySeqs('s8c', [-1, -2])

    const page = await store.loadOlderFromIdb(200)
    expect(page!.messages.map((m) => m.uuid)).toEqual(['s-2', 's-1'])
    expect(page!.contiguous).toBe(false)
  })

  it('loadOlderFromIdb returns null when IDB is unavailable', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).indexedDB = undefined
    _resetDbForTests()
    const store = new SessionStore('s9')
    await store.idbReady
    store.dispatch({ type: 'MESSAGE', message: asstMsg('a-0') })
    const page = await store.loadOlderFromIdb(200)
    expect(page).toBeNull()
  })

  // ── Regression: clearPersisted + in-flight saveIdb (no deadlock/resurrect) ──
  it('clearPersisted while a saveIdb is in-flight does not deadlock or resurrect', async () => {
    const store = new SessionStore('s-deadlock')
    await store.idbReady
    // Dispatch + persistNow kicks a saveIdb (in-flight via the chained
    // pendingIdbWrite). DON'T await flushIdb — leave the write in flight.
    store.dispatch({ type: 'MESSAGE', message: asstMsg('a-1', 'one') })
    store.dispatch({ type: 'MESSAGE', message: asstMsg('a-2', 'two') })
    store.persistNow()

    // While the saveIdb is in flight, run /clear. Pre-fix this deadlocked
    // (clearIdb awaited pendingIdbWrite while saveIdb awaited idbClearPromise)
    // and/or resurrected (saveIdb wrote after the clear).
    store.clearPersisted()

    // flushIdb must resolve (not hang). Use a timeout to fail-fast on deadlock.
    await Promise.race([
      store.flushIdb(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('flushIdb deadlocked')), 5000)),
    ])

    // IDB should have NO records for the session (clear won; the in-flight
    // saveIdb bailed via the generation check rather than resurrecting).
    const records = await readAllIdbRecords('s-deadlock')
    expect(records).toHaveLength(0)
    // LS key gone too.
    expect(localStorage.getItem(STORAGE_PREFIX + 's-deadlock')).toBeNull()
  })

  it('saveIdb that read the pre-clear mirror bails on clearGeneration and does not resurrect', async () => {
    // Force saveIdb to read the PRE-clear mirror (2 messages) by letting its
    // microtask run one tick before /clear. Then clearPersisted bumps
    // clearGeneration; the in-flight saveIdb must bail at the gen check
    // instead of writing the pre-clear records after the clear.
    const store = new SessionStore('s-genbail')
    await store.idbReady
    store.dispatch({ type: 'MESSAGE', message: asstMsg('a-1', 'one') })
    store.dispatch({ type: 'MESSAGE', message: asstMsg('a-2', 'two') })
    store.persistNow()
    // Let saveIdb start (read mirror) but not finish — one macrotask is
    // enough for the cached openDb + mirror read to land.
    await new Promise((r) => setTimeout(r, 0))

    store.clearPersisted()
    await Promise.race([
      store.flushIdb(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('flushIdb deadlocked')), 5000)),
    ])

    const records = await readAllIdbRecords('s-genbail')
    expect(records).toHaveLength(0)
  })

  it('clearPersisted after a completed save does not resurrect', async () => {
    const store = new SessionStore('s-resurrect')
    await store.idbReady
    store.dispatch({ type: 'MESSAGE', message: asstMsg('a-1', 'one') })
    store.persistNow()
    await store.flushIdb() // save fully landed
    expect((await readAllIdbRecords('s-resurrect')).length).toBe(1)

    store.clearPersisted()
    await store.flushIdb()
    expect((await readAllIdbRecords('s-resurrect')).length).toBe(0)
  })

  // ── C1: minSeq sentinel must track the real minimum (no phantom seq gap) ──

  it('prefix backfill assigns seqs contiguous with the suffix (no hole)', async () => {
    // Suffix-only persist assigns seqs 1..N. minSeq must track the real
    // minimum (1), not stay at its empty sentinel — otherwise a subsequent
    // prefix backfill assigns seqs below the sentinel and leaves a hole in
    // the seq space (e.g. {-2,-1,1,2,3}), which makes loadOlder's contiguity
    // check false-fire and triggers a redundant server probe every time the
    // prefix is trimmed and re-paged.
    const store = new SessionStore('s-minseq')
    await store.idbReady
    store.dispatch({ type: 'MESSAGE', message: asstMsg('a1', 'one') })
    store.dispatch({ type: 'MESSAGE', message: asstMsg('a2', 'two') })
    store.dispatch({ type: 'MESSAGE', message: asstMsg('a3', 'three') })
    store.persistNow()
    await store.flushIdb()

    // Prepend 2 older messages (the loadOlder backfill path).
    store.dispatch({
      type: 'PREPEND_MESSAGES',
      messages: [asstMsg('o2', 'older-2'), asstMsg('o1', 'older-1')],
    })
    store.persistNow()
    await store.flushIdb()

    const records = await readAllIdbRecords('s-minseq')
    expect(records).toHaveLength(5)
    const seqs = records.map((r) => r.seq).sort((a, b) => a - b)
    // The seq range must be contiguous — no hole between prefix and suffix.
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i] - seqs[i - 1]).toBe(1)
    }
  })

  // ── M1: cold-load must not invert order when the LS tail is stale ──────

  it('cold-load does not prepend IDB records newer than the stale LS tail', async () => {
    // Simulate the LS tail falling behind IDB (LS write skipped/failed while
    // IDB kept the newer records). On reopen, the LS tail is [u1,a1] but IDB
    // also has [u2,a2] (newer). cursorRecent returns all four; naively
    // prepending would place u2,a2 (newer) BEFORE u1,a1 (older) — an inverted
    // transcript. IDB's job is to extend the view BACKWARD, so records with
    // seq >= the oldest in-memory seq (duplicates or newer-than-LS) must be
    // skipped; the WS replay fills the newer tail in correct order.
    const s1 = new SessionStore('s-coldorder')
    await s1.idbReady
    s1.dispatch({ type: 'MESSAGE', message: userMsg('u1', 'one') })
    s1.dispatch({ type: 'MESSAGE', message: asstMsg('a1', 'two') })
    s1.persistNow()
    await s1.flushIdb()
    // LS now has [u1,a1]; IDB has [u1,a1] (seq 1,2). Add newer records to IDB
    // ONLY (LS stays stale at [u1,a1]).
    const db = await openDb()
    await putMessages(
      db!,
      [
        { sessionId: 's-coldorder', uuid: 'u2', seq: 3, msg: userMsg('u2', 'three') },
        { sessionId: 's-coldorder', uuid: 'a2', seq: 4, msg: asstMsg('a2', 'four') },
      ],
      { sessionId: 's-coldorder', maxSeq: 4, minSeq: 1 },
    )

    // Reopen: LS hydrates [u1,a1]; initIdb cold-load must NOT invert.
    const s2 = new SessionStore('s-coldorder')
    await s2.idbReady
    const ids = s2.getSnapshot().items.map((i) => i.id)
    // The LS tail order is preserved, and nothing newer is spliced in ahead
    // of it. u2/a2 (if present at all from a later replay) belong AFTER a1.
    expect(ids.indexOf('u1')).toBeGreaterThanOrEqual(0)
    expect(ids.indexOf('a1')).toBeGreaterThan(ids.indexOf('u1'))
    // The inversion signature is u2/a2 (newer) appearing BEFORE u1 (older).
    // u2 must be absent OR appear after a1.
    const u2Idx = ids.indexOf('u2')
    if (u2Idx >= 0) expect(u2Idx).toBeGreaterThan(ids.indexOf('a1'))
    // a2 must never appear before a1.
    if (ids.includes('a2')) {
      expect(ids.indexOf('a2')).toBeGreaterThan(ids.indexOf('a1'))
    }
  })

  it('cold-load does not invert when the oldest in-memory message is not in IDB', async () => {
    // Partial-failure edge: the LS tail's oldest message was never persisted
    // to IDB (items[0].id not in uuidToSeq), while IDB holds records newer
    // than the in-memory tail. The filter can't anchor on a seq, so the naive
    // path would prepend the newer IDB records ahead of the LS tail → inverted
    // transcript. The conservative fix: when the oldest in-memory seq is
    // unknown, skip the cold-load prepend entirely (WS replay fills in order).
    //
    // Set up: LS has [u1,u2,a2]; IDB has only [u2,a2] (u1 was lost from IDB —
    // e.g. IDB was cleared/rebuilt after u1 was persisted). On reopen,
    // items[0]=u1 is not in IDB, so uuidToSeq has no anchor.
    const db = await openDb()
    // 1. Persist all three to BOTH LS and IDB via a seed store.
    const seedStore = new SessionStore('s-coldorder2')
    await seedStore.idbReady
    seedStore.dispatch({ type: 'MESSAGE', message: userMsg('u1', 'one') })
    seedStore.dispatch({ type: 'MESSAGE', message: userMsg('u2', 'two') })
    seedStore.dispatch({ type: 'MESSAGE', message: asstMsg('a2', 'three') })
    seedStore.persistNow()
    await seedStore.flushIdb()
    // 2. Wipe IDB and re-put only [u2,a2] — LS still has [u1,u2,a2].
    await clearSession(db!, 's-coldorder2')
    await putMessages(
      db!,
      [
        { sessionId: 's-coldorder2', uuid: 'u2', seq: 1, msg: userMsg('u2', 'two') },
        { sessionId: 's-coldorder2', uuid: 'a2', seq: 2, msg: asstMsg('a2', 'three') },
      ],
      { sessionId: 's-coldorder2', maxSeq: 2, minSeq: 1 },
    )

    // Reopen: LS hydrates [u1,u2,a2] (u1 not in IDB); cold-load must not invert.
    const s2 = new SessionStore('s-coldorder2')
    await s2.idbReady
    const ids = s2.getSnapshot().items.map((i) => i.id)
    // u1 is the oldest in-memory message and must remain FIRST — nothing may
    // be spliced ahead of it (the inversion signature).
    expect(ids[0]).toBe('u1')
    // u2/a2, if present from cold-load, must not appear before u1.
    const u2Idx = ids.indexOf('u2')
    const a2Idx = ids.indexOf('a2')
    if (u2Idx >= 0) expect(u2Idx).toBeGreaterThan(ids.indexOf('u1'))
    if (a2Idx >= 0) expect(a2Idx).toBeGreaterThan(ids.indexOf('u1'))
  })
})
