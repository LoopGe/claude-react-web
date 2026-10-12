// Chat-side handler for composer history recall images.
//
// The Composer decides WHEN images change on a history step; this handler
// decides WHAT lands in the composer. Two explicit entry points — no
// overloaded null:
//   - recallEntry(entryId)  — a HISTORY ENTRY is shown: load its images from
//     the IDB side store (null id = text-only/legacy entry).
//   - restoreDraft(stash)   — the live DRAFT is shown again (↓ past index 0):
//     decode + apply the images the Composer stashed on browse entry.
//
// Both run the payloads through the image decode cache (buildPastedImages):
// decoding happens ASYNC via fetch(data:) — never on the main thread — and
// LRU cache hits make A→B→A stepping a zero-decode URL reuse.
//
// SYNC CLEAR: every step first applies [] synchronously. The composer's
// text changes in the same commit, so between the step and the async
// land-out the composer holds the new text with NO images — a fast Enter in
// that window sends text without stale images instead of pairing the new
// text with the PREVIOUS step's images (wrong-content send).
//
// The sequence guard matters because load+decode are async while ↑/↓ steps
// are sync: a slow pipeline for an older step must never clobber a newer
// step's images. invalidate() extends the guard to USER image mutations
// (paste / remove / send-clear): Chat calls it so an in-flight pipeline
// can't overwrite an edit.

import { useCallback, useRef } from 'react'
import { getImages, type PersistedImage } from '../state/inputHistoryImages'
import { buildPastedImages } from '../utils/imageDecodeCache'
import type { PastedImage } from '../types'

export interface HistoryImageRecallApi {
  /** Show a history entry's images: load from IDB by id (null = text-only
   *  entry). Clears the composer's images synchronously; the entry's images
   *  land asynchronously. */
  recallEntry: (entryId: string | null) => void
  /** Show the live draft's images again: decode + apply the browse-entry
   *  stash. Clears synchronously first (same send-window argument). */
  restoreDraft: (stash: PersistedImage[]) => void
  /** Drop any in-flight pipeline. Chat calls this on USER image mutations
   *  (paste / remove / send-clear): the sequence guard only orders recall
   *  steps against each other, so without this a slow load landing after a
   *  user edit would silently overwrite it. */
  invalidate: () => void
}

export function useHistoryImageRecall(
  /** Apply built images to the composer (pastedImages.applyImages). */
  apply: (imgs: readonly PastedImage[]) => void,
  /** Injectable for tests: persisted images → live images. Production reads
   *  the image decode cache (async fetch(data:) decode + LRU). */
  build: (imgs: readonly PersistedImage[]) => Promise<readonly PastedImage[]> = buildPastedImages,
): HistoryImageRecallApi {
  const seqRef = useRef(0)
  const recallEntry = useCallback(
    (entryId: string | null) => {
      const seq = ++seqRef.current
      apply([]) // sync clear — see module docs (send-window)
      if (entryId == null) return // text-only / legacy entry: nothing to load
      void (async () => {
        const imgs = await build(await getImages(entryId))
        if (seq !== seqRef.current) return // superseded / invalidated
        apply(imgs)
      })()
    },
    [apply, build],
  )
  const restoreDraft = useCallback(
    (stash: PersistedImage[]) => {
      const seq = ++seqRef.current
      apply([]) // sync clear — see module docs (send-window)
      void (async () => {
        const imgs = await build(stash)
        if (seq !== seqRef.current) return // superseded / invalidated
        apply(imgs)
      })()
    },
    [apply, build],
  )
  const invalidate = useCallback(() => {
    seqRef.current++
  }, [])
  return { recallEntry, restoreDraft, invalidate }
}
