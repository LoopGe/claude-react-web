// IndexedDB side store for input-history images (Plan B).
//
// The text ring lives in localStorage (`inputHistoryStore`); image payloads
// are far too large for its ~5 MB quota, so each entry's images persist here,
// keyed by the `HistoryEntry.id` minted at add() time. Every call is
// best-effort: if IDB is unavailable (private mode, open failure) calls
// resolve and the feature degrades to text-only recall — never a crash, and
// the text ring is untouched.
//
// Deliberately a SEPARATE DB from the transcript cache (`claude-web` in
// session-store/idb.ts): bumping that DB's version would force cross-tab
// upgrade coordination (blocked()) for an unrelated feature. One tiny DB,
// one store, no schema-evolution risk.

import { openDB, type IDBPDatabase } from 'idb'
import type { PastedImage } from '../types'

const DB_NAME = 'claude-web-history'
const DB_VERSION = 1
const IMAGES_STORE = 'images'

/** The persistable subset of `PastedImage` (runtime-only fields dropped:
 *  `id` is re-minted on restore, `previewUrl` is a live blob URL). */
export interface PersistedImage {
  /** base64 payload, no data-URL prefix (same shape as PastedImage.data). */
  data: string
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
  width: number
  height: number
  size: number
}

interface ImageRecord {
  id: string
  images: PersistedImage[]
}

let dbPromise: Promise<IDBPDatabase | null> | null = null

async function openImagesDb(): Promise<IDBPDatabase | null> {
  // Unavailability is NOT cached (checked outside the promise): tests swap
  // the global factory mid-file, and a cached null here would pin it forever.
  if (typeof indexedDB === 'undefined') return null
  if (dbPromise) return dbPromise
  const p = (async () => {
    try {
      return await openDB(DB_NAME, DB_VERSION, {
        upgrade(db) {
          if (!db.objectStoreNames.contains(IMAGES_STORE)) {
            db.createObjectStore(IMAGES_STORE, { keyPath: 'id' })
          }
        },
        terminated() {
          // Connection force-closed (e.g. user cleared site data) — retry
          // the open on the next call.
          dbPromise = null
        },
      })
    } catch {
      // Visible to the caller as null. NOT reset here: a synchronous open
      // throw finishes this IIFE before the `dbPromise = p` assignment below
      // runs, so a reset inside would be clobbered. The sentinel after the
      // assignment handles both sync and async failures.
      return null
    }
  })()
  dbPromise = p
  // A failed open must not poison the cache: the next call retries.
  // Permanent unavailability just fails again, cheaply. The identity guard
  // keeps a later successful open from being cleared by this stale sentinel.
  void p.then((v) => {
    if (v === null && dbPromise === p) dbPromise = null
  })
  return dbPromise
}

/** Best-effort reset of the cached DB promise and the draft tombstones. For
 *  tests — the tombstone set is module state that must reset alongside the
 *  db promise or it leaks across tests. */
export function _resetDbForTests(): void {
  dbPromise = null
  deletedDraftSessions.clear()
}

/** Store (or replace) the image record for a history-entry id. */
export async function putImages(id: string, images: PersistedImage[]): Promise<void> {
  const db = await openImagesDb()
  if (!db) return
  try {
    await db.put(IMAGES_STORE, { id, images } satisfies ImageRecord)
  } catch (err) {
    console.warn('[inputHistoryImages] put failed:', err)
  }
}

/** The images stored for a history-entry id; [] when absent. */
export async function getImages(id: string): Promise<PersistedImage[]> {
  const db = await openImagesDb()
  if (!db) return []
  try {
    const rec = (await db.get(IMAGES_STORE, id)) as ImageRecord | undefined
    return rec?.images ?? []
  } catch (err) {
    console.warn('[inputHistoryImages] get failed:', err)
    return []
  }
}

/** Delete the records for the given entry ids (orphan cleanup). */
export async function deleteImages(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const db = await openImagesDb()
  if (!db) return
  try {
    const tx = db.transaction(IMAGES_STORE, 'readwrite')
    await Promise.all([...ids.map((id) => tx.store.delete(id)), tx.done])
  } catch (err) {
    console.warn('[inputHistoryImages] delete failed:', err)
  }
}

/** Wipe every image record. */
export async function clearImages(): Promise<void> {
  const db = await openImagesDb()
  if (!db) return
  try {
    await db.clear(IMAGES_STORE)
  } catch (err) {
    console.warn('[inputHistoryImages] clear failed:', err)
  }
}

/** Draft records share the images store with history records. The `draft:`
 *  prefix keeps the key spaces disjoint: history keys are randomId()s, which
 *  never contain ':', so the orphan cleanup inputHistoryStore.add() performs
 *  (deleteImages of evicted ENTRY ids) can never touch a draft record, and
 *  clearImages() (reset-config) wipes both kinds together, as intended.
 *  One record per session: the composer's CURRENT unsent images. */
const DRAFT_KEY_PREFIX = 'draft:'

/** Session ids whose session was REMOVED (delete / session-removed teardown).
 *  Those flows run BEFORE the removed panel's unmount commit, whose draft
 *  flush then issues its put — and IDB executes same-connection transactions
 *  in issue order, so that late put would resurrect the record. The
 *  tombstone makes it a no-op. Same pattern as sessionStoreRegistry.delete
 *  preventing the idle sweep from re-persisting a deleted session's
 *  transcript. Ids are NOT dead forever — resume() re-spawns under the same
 *  id — so useDraftImages clears the tombstone (resumeDraftWrites) whenever
 *  a live panel mounts for the id. The send-clear delete (deleteDraftImages)
 *  does NOT tombstone — a later paste must persist. */
const deletedDraftSessions = new Set<string>()

/** Store (or replace) the draft image record for a session. */
export async function putDraftImages(sessionId: string, images: PersistedImage[]): Promise<void> {
  if (deletedDraftSessions.has(sessionId)) return
  const db = await openImagesDb()
  if (!db) return
  try {
    await db.put(IMAGES_STORE, { id: DRAFT_KEY_PREFIX + sessionId, images } satisfies ImageRecord)
  } catch (err) {
    console.warn('[inputHistoryImages] draft put failed:', err)
  }
}

/** The draft images stored for a session; [] when absent. */
export async function getDraftImages(sessionId: string): Promise<PersistedImage[]> {
  const db = await openImagesDb()
  if (!db) return []
  try {
    const rec = (await db.get(IMAGES_STORE, DRAFT_KEY_PREFIX + sessionId)) as ImageRecord | undefined
    return rec?.images ?? []
  } catch (err) {
    console.warn('[inputHistoryImages] draft get failed:', err)
    return []
  }
}

/** Delete a session's draft record — the send-clear path (the draft was
 *  consumed; the session lives on and a later paste must persist again). */
export async function deleteDraftImages(sessionId: string): Promise<void> {
  const db = await openImagesDb()
  if (!db) return
  try {
    await db.delete(IMAGES_STORE, DRAFT_KEY_PREFIX + sessionId)
  } catch (err) {
    console.warn('[inputHistoryImages] draft delete failed:', err)
  }
}

/** Delete a session's draft record because the SESSION is gone (performDelete
 *  / session-removed teardown). Tombstones the id so the removed panel's
 *  late unmount-flush put cannot resurrect it — see deletedDraftSessions. */
export async function deleteDraftImagesForRemovedSession(sessionId: string): Promise<void> {
  deletedDraftSessions.add(sessionId)
  const db = await openImagesDb()
  if (!db) return
  try {
    await db.delete(IMAGES_STORE, DRAFT_KEY_PREFIX + sessionId)
  } catch (err) {
    console.warn('[inputHistoryImages] draft delete failed:', err)
  }
}

/** Re-arm draft writes for a session id that legitimately (re-)entered this
 *  tab — a live panel mounting for it. Needed because session ids are NOT
 *  dead forever once removed: resume() re-spawns under the SAME id, so a
 *  tombstoned id must become writable again. No-op when never tombstoned. */
export function resumeDraftWrites(sessionId: string): void {
  deletedDraftSessions.delete(sessionId)
}

/** Strip a live PastedImage down to its persistable shape (drops the runtime
 *  `id` and blob `previewUrl`). Used at both write sites: send() recording
 *  history and the composer stashing draft images on browse entry. */
export function toPersistedImage(img: PastedImage): PersistedImage {
  return {
    data: img.data,
    mediaType: img.mediaType,
    width: img.width,
    height: img.height,
    size: img.size,
  }
}
