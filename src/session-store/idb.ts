// IndexedDB access layer for the transcript cache (Plan C).
//
// IDB is a progressive enhancement over the localStorage cache (Plan B):
// the full projected transcript is persisted here (GB-scale quota, no trim
// needed for pure text), and `loadOlder` reads older messages locally
// instead of round-tripping to the server's /history endpoint. If IDB is
// unavailable (private mode, quota error, open failure), every call rejects
// and the store falls back to Plan B behavior — no crash.
//
// Schema (DB `claude-web` v1):
//   store `messages`, keyPath [sessionId, uuid], record { sessionId, uuid, seq, msg }
//     - `msg` is the projected SdkMessage (see project.ts).
//     - `seq` is a client-assigned per-session monotonic chronological rank
//       (NOT receivedAt — disk-restored history omits it). Live/replay appends
//       get ++maxSeq; loadOlder backfill gets --minSeq (oldest-first page →
//       oldest gets the smallest seq). Assigned once per uuid, stable forever.
//   index `bySeq` on [sessionId, seq, uuid] — the uuid tiebreak makes the
//     descending "fetch N older" cursor deterministic across concurrent-tab
//     seq collisions (two tabs both ++maxSeq from the same meta).
//   store `meta`, keyPath sessionId, value { sessionId, maxSeq, minSeq }.
//
// The DB is shared across all sessions (one DB, many sessionIds); opened once
// per process (module-level singleton). Each SessionStore instance holds the
// same handle.

import { openDB, type IDBPDatabase } from 'idb'
import type { SdkMessage } from '../types'

const DB_NAME = 'claude-web'
const DB_VERSION = 1
const MESSAGES_STORE = 'messages'
const META_STORE = 'meta'

/** A floor for seq lower-bounds in key ranges. seq is assigned ++maxSeq /
 *  --minSeq from 0; for any realistic session it stays within ±1e9. */
const SEQ_FLOOR = -1e9

export interface MessageRecord {
  sessionId: string
  uuid: string
  seq: number
  msg: SdkMessage
}

export interface SessionMeta {
  sessionId: string
  maxSeq: number
  minSeq: number
}

let dbPromise: Promise<IDBPDatabase | null> | null = null

/** Open the shared DB once. Resolves null if IDB is unavailable (private
 *  mode, blocked, etc.) — callers must treat null as "IDB disabled" and
 *  fall back to localStorage. */
export function openDb(): Promise<IDBPDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = (async () => {
    if (typeof indexedDB === 'undefined') return null
    try {
      return await openDB(DB_NAME, DB_VERSION, {
        upgrade(db) {
          if (!db.objectStoreNames.contains(MESSAGES_STORE)) {
            const messages = db.createObjectStore(MESSAGES_STORE, {
              keyPath: ['sessionId', 'uuid'],
            })
            messages.createIndex('bySeq', ['sessionId', 'seq', 'uuid'])
          }
          if (!db.objectStoreNames.contains(META_STORE)) {
            db.createObjectStore(META_STORE, { keyPath: 'sessionId' })
          }
        },
        blocked() {
          // Another tab is holding an older DB version; the upgrade waits.
          // Resolve null so the store falls back — the other tab will
          // complete its upgrade and a future open succeeds.
        },
        terminated() {
          // The connection was force-closed (e.g. user cleared site data).
          // Reset so the next openDb() retries.
          dbPromise = null
        },
      })
    } catch {
      return null
    }
  })()
  return dbPromise
}

/** Best-effort reset of the cached DB promise. For tests / after termination. */
export function _resetDbForTests(): void {
  dbPromise = null
}

/** Read a session's meta (maxSeq/minSeq). Undefined if no records yet. */
export async function getMeta(db: IDBPDatabase, sessionId: string): Promise<SessionMeta | undefined> {
  const rec = (await db.get(META_STORE, sessionId)) as SessionMeta | undefined
  return rec
}

/** Write a session's meta. */
export async function putMeta(db: IDBPDatabase, meta: SessionMeta): Promise<void> {
  await db.put(META_STORE, meta)
}

/** Scan all message records for a session, returning uuid → seq. Used on
 *  open to rebuild the in-memory `persistedUuids`/`uuidToSeq`. Reads only the
 *  `bySeq` index KEY ([sessionId, seq, uuid]) — not the record body — so a
 *  long session doesn't deserialize thousands of full message bodies on cold
 *  open. O(n) but runs once per open. */
export async function scanUuidSeqs(db: IDBPDatabase, sessionId: string): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  // 3-element upper bound matches the bySeq index key [sessionId, seq, uuid];
  // '￿' exceeds any uuid char so the inclusive bound captures every record.
  const range = IDBKeyRange.bound([sessionId, SEQ_FLOOR], [sessionId, Number.MAX_SAFE_INTEGER, '￿'])
  let cursor = await db.transaction(MESSAGES_STORE).store.index('bySeq').openKeyCursor(range)
  while (cursor) {
    // Index key is [sessionId, seq, uuid] — read seq + uuid without touching
    // the value (the full msg body stays on disk).
    const key = cursor.key as [string, number, string]
    out.set(key[2], key[1])
    cursor = await cursor.continue()
  }
  return out
}

/** Put a batch of message records + update meta in one transaction. The
 *  records carry their own sessionId; meta carries sessionId as its key. */
export async function putMessages(
  db: IDBPDatabase,
  records: MessageRecord[],
  meta: SessionMeta,
): Promise<void> {
  const tx = db.transaction([MESSAGES_STORE, META_STORE], 'readwrite')
  for (const r of records) {
    await tx.objectStore(MESSAGES_STORE).put(r)
  }
  await tx.objectStore(META_STORE).put(meta)
  await tx.done
}

/** Apply a save atomically in ONE transaction: put new records + update meta.
 *  Doing both in a single readwrite tx means a racing clearSession (its own tx)
 *  serializes wholly before or wholly after this write — never a
 *  delete-then-put that resurrects. The tx is created synchronously on entry
 *  (before any await), so once this is called the write is ordered against any
 *  concurrent clear deterministically by IDB's tx-creation order. (No per-uuid
 *  delete path: `api_retry` is transient and never written to IDB, so nothing
 *  is ever superseded.) */
export async function applyWrites(
  db: IDBPDatabase,
  records: MessageRecord[],
  meta: SessionMeta,
): Promise<void> {
  const tx = db.transaction([MESSAGES_STORE, META_STORE], 'readwrite')
  const messages = tx.objectStore(MESSAGES_STORE)
  for (const r of records) {
    await messages.put(r)
  }
  await tx.objectStore(META_STORE).put(meta)
  await tx.done
}


/** Fetch up to `n` messages strictly older than `beforeSeq` (descending —
 *  newest-first among the older set). Returns the records (caller dispatches
 *  PREPEND_MESSAGES in chronological oldest-first order, so reverse before
 *  dispatch). Also returns whether the cursor has more older records. */
export async function cursorOlder(
  db: IDBPDatabase,
  sessionId: string,
  beforeSeq: number,
  n: number,
): Promise<{ records: MessageRecord[]; hasMore: boolean }> {
  // Range: [sessionId, SEQ_FLOOR] .. [sessionId, beforeSeq-1, '￿'].
  // '￿' > any hex-ish uuid char, so the upper bound captures all uuids
  // at seq == beforeSeq-1. Direction 'prev' → descending seq (newest older
  // first).
  const range = IDBKeyRange.bound(
    [sessionId, SEQ_FLOOR],
    [sessionId, beforeSeq - 1, '￿'],
  )
  const records: MessageRecord[] = []
  let cursor = await db.transaction(MESSAGES_STORE).store.index('bySeq').openCursor(range, 'prev')
  while (cursor && records.length < n) {
    records.push(cursor.value as MessageRecord)
    cursor = await cursor.continue()
  }
  return { records, hasMore: !!cursor }
}

/** Fetch up to `n` most-recent messages (descending from maxSeq). Used by the
 *  async cold-load to supersede the tiny localStorage tail with IDB's fuller
 *  recent window. Returns oldest-first (ready to PREPEND). */
export async function cursorRecent(
  db: IDBPDatabase,
  sessionId: string,
  n: number,
): Promise<MessageRecord[]> {
  const range = IDBKeyRange.bound([sessionId, SEQ_FLOOR], [sessionId, Number.MAX_SAFE_INTEGER, '￿'])
  const records: MessageRecord[] = []
  let cursor = await db.transaction(MESSAGES_STORE).store.index('bySeq').openCursor(range, 'prev')
  while (cursor && records.length < n) {
    records.push(cursor.value as MessageRecord)
    cursor = await cursor.continue()
  }
  // cursor returned newest-first; reverse to oldest-first for PREPEND.
  records.reverse()
  return records
}

/** Delete all message + meta records for a session (/clear, session delete). */
export async function clearSession(db: IDBPDatabase, sessionId: string): Promise<void> {
  const tx = db.transaction([MESSAGES_STORE, META_STORE], 'readwrite')
  // messages store is keyed [sessionId, uuid]; delete the sessionId range.
  const range = IDBKeyRange.bound([sessionId, ''], [sessionId, '￿'])
  let cursor = await tx.objectStore(MESSAGES_STORE).openCursor(range)
  while (cursor) {
    await cursor.delete()
    cursor = await cursor.continue()
  }
  await tx.objectStore(META_STORE).delete(sessionId)
  await tx.done
}
