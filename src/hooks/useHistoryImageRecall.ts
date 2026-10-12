// Chat-side handler for composer history recall images.
//
// The Composer decides WHEN images change on a history step; this handler
// decides WHAT lands in the composer. Two explicit entry points — no
// overloaded null:
//   - recallEntry(entryId)  — a HISTORY ENTRY is shown: load its images from
//     the IDB side store (null id = text-only/legacy entry → restore([])).
//   - restoreDraft(stash)   — the live DRAFT is shown again (↓ past index 0):
//     apply the images the Composer stashed on browse entry.
//
// The sequence guard matters because IDB loads are async while ↑/↓ steps are
// sync: a slow load for an older step must never clobber a newer step's
// images (text is applied immediately by the Composer, images follow — a
// clobbered text/images mismatch would be visible and confusing).
// invalidate() extends the guard to USER image mutations (paste / remove /
// send-clear): Chat calls it so an in-flight load can't overwrite an edit.

import { useCallback, useRef } from 'react'
import { getImages, type PersistedImage } from '../state/inputHistoryImages'

export interface HistoryImageRecallApi {
  /** Show a history entry's images: load from IDB by id (null = text-only
   *  entry → restore([])). */
  recallEntry: (entryId: string | null) => void
  /** Show the live draft's images again: apply the browse-entry stash. */
  restoreDraft: (stash: PersistedImage[]) => void
  /** Drop any in-flight entry load. Chat calls this on USER image mutations
   *  (paste / remove / send-clear): the sequence guard only orders recall
   *  steps against each other, so without this a slow load landing after a
   *  user edit would silently overwrite it. */
  invalidate: () => void
}

export function useHistoryImageRecall(
  /** Apply the images to the composer (pastedImages.restore). */
  restore: (imgs: readonly PersistedImage[]) => void,
  /** Injectable for tests; production reads the IDB side store. */
  loadImages: (id: string) => Promise<PersistedImage[]> = getImages,
): HistoryImageRecallApi {
  const seqRef = useRef(0)
  const recallEntry = useCallback(
    (entryId: string | null) => {
      const seq = ++seqRef.current
      if (entryId == null) {
        // Text-only / legacy entry: nothing in IDB — clear what the previous
        // step showed.
        restore([])
        return
      }
      void loadImages(entryId).then((imgs) => {
        if (seq !== seqRef.current) return // superseded / invalidated
        restore(imgs)
      })
    },
    [restore, loadImages],
  )
  const restoreDraft = useCallback(
    (stash: PersistedImage[]) => {
      seqRef.current++ // a draft restore supersedes any in-flight load
      restore(stash)
    },
    [restore],
  )
  const invalidate = useCallback(() => {
    seqRef.current++
  }, [])
  return { recallEntry, restoreDraft, invalidate }
}
