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

/** Best-effort reset of the cached DB promise. For tests. */
export function _resetDbForTests(): void {
  dbPromise = null
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
