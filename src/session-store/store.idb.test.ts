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

  it('drains superseded api_retry uuids from IDB (no re-emerge on cold-load)', async () => {
    const store = new SessionStore('s3')
    await store.idbReady
    // Two consecutive api_retry → the first is replaced in place.
    store.dispatch({ type: 'MESSAGE', message: apiRetryMsg('retry-1') })
    store.dispatch({ type: 'MESSAGE', message: apiRetryMsg('retry-2') })
    store.persistNow()
    await store.flushIdb()

    const records = await readAllIdbRecords('s3')
    const uuids = records.map((r) => r.uuid)
    expect(uuids).toContain('retry-2')
    expect(uuids).not.toContain('retry-1') // superseded → deleted from IDB
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

  it('loadOlderFromIdb pages older messages not in memory (cold-load leaves older in IDB)', async () => {
    // Seed IDB directly with 1001 messages (seqs 1..1001). Cold-load fetches
    // the most-recent 1000 (MEMORY_ITEM_CAP), leaving seq 1 only in IDB.
    const db = await openDb()
    const records = Array.from({ length: 1001 }, (_, i) => ({
      sessionId: 's8',
      uuid: `old-${i}`,
      seq: i + 1,
      msg: asstMsg(`old-${i}`, `msg ${i}`),
    }))
    await putMessages(db!, records, { sessionId: 's8', maxSeq: 1001, minSeq: 1 })

    const store = new SessionStore('s8')
    await store.idbReady
    // Memory holds the 1000 most-recent (seqs 2..1001); seq 1 is only in IDB.
    expect(store.getSnapshot().items.length).toBe(1000)
    expect(store.getSnapshot().items[0].id).toBe('old-1') // oldest in memory = seq 2

    const page = await store.loadOlderFromIdb(200)
    expect(page).not.toBeNull()
    expect(page!.messages).toHaveLength(1)
    expect(page!.messages[0].uuid).toBe('old-0') // seq 1, oldest-first
    expect(page!.hasMore).toBe(false)
    expect(page!.contiguous).toBe(true) // seq 1 abuts seq 2
  }, 30000)

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
})
