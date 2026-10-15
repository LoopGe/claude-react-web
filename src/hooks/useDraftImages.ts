// The composer draft's IMAGE half.
//
// The TEXT draft (Chat.tsx's DRAFT_KEY_PREFIX in sessionStorage) survives a
// panel unmount — a session switch, a session-group switch (which replaces
// the whole open-panel set), a panel close — and is re-hydrated on remount.
// Images are the draft's other half but were never wired into that
// lifecycle: they lived only in usePastedImages' React state, so any unmount
// destroyed them. sessionStorage cannot hold them (~5 MB quota vs multi-MB
// base64 payloads — the exact reason the input-history image side store
// exists), so this hook mirrors the text draft's lifecycle against the IDB
// side store instead:
//
//   - change  → debounced put (trailing edge; only the last set is written;
//               the restored set landing unchanged is skipped — it is
//               byte-identical to what was just read)
//   - clear   → immediate delete on a CONSUMPTION only (kind 'clear' from a
//               send / schedule, or 'remove' of the last image). A history
//               recall's sync-clear (kind 'apply', including an empty→empty
//               apply during the restore window) replaces the draft but does
//               NOT consume it — the record survives for the browse stash /
//               a later non-empty put to replace
//   - unmount / pagehide / visibilitychange → flush a pending write
//   - mount   → async load + decode + apply, seq-guarded so a user edit in
//               the window always wins over the stale persisted set; also
//               re-arms store writes (a resumed id may have been tombstoned
//               by an earlier removal flow — resume reuses session ids)
//
// Send/schedule consume the draft via an IMPERATIVE deleteDraftImages at the
// consumption site (Chat.tsx) — the effect-driven delete cannot fire once
// the panel has unmounted mid-POST, which would resurrect the sent images as
// a phantom draft. Session-deletion cleanup lives in App (performDelete,
// teardownRemovedSession, and the /clear & /discard swap sites — the
// removed-session variant tombstones the id against the unmount flush).
//
// Known window: the restore is async (IDB read + decode) while the text half
// restores synchronously, so an Enter within the window sends the restored
// text without the still-decoding images — the composer visibly shows no
// chips, so what the user sees is what sends. Perfect parity would require
// blocking sends on a maybe-restore; not worth it.

import { useCallback, useEffect, useRef, type RefObject } from 'react'
import {
  getDraftImages,
  putDraftImages,
  deleteDraftImages,
  resumeDraftWrites,
  toPersistedImage,
  type PersistedImage,
} from '../state/inputHistoryImages'
import { buildPastedImages } from '../utils/imageDecodeCache'
import { DRAFT_WRITE_DEBOUNCE_MS } from '../constants/storageKeys'
import type { PastedImage } from '../types'
import type { ImageMutations } from './usePastedImages'

/** Injectable seams for tests. Production uses the IDB side store and the
 *  decode cache; the tests pin orchestration (timing, guards, write-back)
 *  with synchronous fakes — the real IDB round-trip is covered by
 *  inputHistoryImages.test.ts. */
export interface DraftImagesDeps {
  get?: (sessionId: string) => Promise<PersistedImage[]>
  put?: (sessionId: string, images: PersistedImage[]) => Promise<void>
  del?: (sessionId: string) => Promise<void>
  build?: (images: readonly PersistedImage[]) => Promise<PastedImage[]>
  /** Re-arm store writes for the id (undo a removal tombstone). */
  armWrites?: (sessionId: string) => void
  debounceMs?: number
}

/** Payload equality on the persisted shape (the runtime-only `id` and
 *  `previewUrl` are excluded — a restored set differs from its stash only in
 *  those). String compares on `data` are memcmp-fast. */
function persistedEquals(a: PersistedImage[], b: PersistedImage[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].data !== b[i].data
      || a[i].mediaType !== b[i].mediaType
      || a[i].width !== b[i].width
      || a[i].height !== b[i].height
      || a[i].size !== b[i].size
    ) return false
  }
  return true
}

export function useDraftImages(
  sessionId: string,
  images: PastedImage[],
  /** usePastedImages' synchronous mutation signal — replaced in the same
   *  call as every image-set mutation, so it is reliable at async land time
   *  regardless of React's commit scheduling. `.seq` orders async appliers
   *  against user edits; `.kind` distinguishes consumption ('clear' /
   *  'remove') from replacement ('apply'). */
  mutationsRef: RefObject<ImageMutations>,
  /** usePastedImages.applyImages — the restore's landing pad. */
  apply: (imgs: readonly PastedImage[]) => void,
  deps: DraftImagesDeps = {},
): void {
  const {
    get = getDraftImages,
    put = putDraftImages,
    del = deleteDraftImages,
    build = buildPastedImages,
    armWrites = resumeDraftWrites,
    debounceMs = DRAFT_WRITE_DEBOUNCE_MS,
  } = deps

  // ── Persistence: watch the images array (the single funnel every mutation
  // flows through — paste landing, remove, clear/send, recall applies) ──
  const prevImagesRef = useRef<PastedImage[] | null>(null)
  const pendingRef = useRef<PersistedImage[] | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The stash the restore just applied, for one render cycle: the change
  // effect compares the applied set against it and skips the redundant
  // multi-MB re-write. Cleared on every real write/delete (one-shot).
  const lastRestoredRef = useRef<PersistedImage[] | null>(null)

  useEffect(() => {
    const prev = prevImagesRef.current
    if (prev === null) {
      // Mount: nothing changed yet. An eager empty-write here would DELETE
      // the persisted record before the restore effect below has read it.
      prevImagesRef.current = images
      return
    }
    if (prev === images) return // no change (StrictMode effect re-run)
    prevImagesRef.current = images

    if (images.length === 0) {
      // Only a CONSUMPTION deletes the record: a send/schedule clear (kind
      // 'clear') or the user removing the last image (kind 'remove'). A
      // history recall's sync-clear (kind 'apply', and any empty→empty
      // change during the restore window) merely replaces the draft — the
      // record must survive it, or a panel swap while browsing would lose
      // the draft images permanently (the Composer stash is in-memory only).
      if (prev.length === 0) return
      if (mutationsRef.current.kind === 'apply') return
      // Clearing is immediate, mirroring the text draft: a send consumes the
      // draft, and a deferred write landing afterwards would leave the
      // record in storage to be restored as a phantom draft later.
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      pendingRef.current = null
      lastRestoredRef.current = null
      void del(sessionId)
      return
    }
    const persisted = images.map(toPersistedImage)
    // The restored set landing unchanged: byte-identical to what was just
    // read from IDB — re-putting it would write the full multi-MB payload
    // on every panel open. One-shot: consumed here, so the next genuine
    // change writes normally.
    if (lastRestoredRef.current && persistedEquals(persisted, lastRestoredRef.current)) {
      lastRestoredRef.current = null
      return
    }
    lastRestoredRef.current = null
    pendingRef.current = persisted
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      pendingRef.current = null
      void put(sessionId, persisted)
    }, debounceMs)
  }, [sessionId, images, mutationsRef, put, del, debounceMs])

  // Flush a write still inside the debounce window. Fires on unmount (the
  // group-switch path: the paste happened <400ms before the panels were
  // swapped out) and on pagehide / visibilitychange (a tab hidden or closing
  // never unmounts React, so without this a paste made just before hiding
  // the tab is lost). Parity caveat vs the text half: that flush's
  // sessionStorage write is synchronous, while this one is a fire-and-forget
  // IDB transaction — reliable on visibilitychange (the page lives on) but
  // only BEST-EFFORT on pagehide, where the browser may tear the page down
  // before the transaction commits. Timer already fired ⇒ pendingRef is
  // null ⇒ no double write.
  const flushPending = useCallback(() => {
    if (timerRef.current === null) return
    clearTimeout(timerRef.current)
    timerRef.current = null
    const pending = pendingRef.current
    pendingRef.current = null
    if (pending) void put(sessionId, pending)
  }, [put, sessionId])

  useEffect(() => {
    window.addEventListener('pagehide', flushPending)
    document.addEventListener('visibilitychange', flushPending)
    return () => {
      window.removeEventListener('pagehide', flushPending)
      document.removeEventListener('visibilitychange', flushPending)
      flushPending()
    }
  }, [flushPending])

  // ── Restore: hydrate the persisted draft into the fresh (empty) composer.
  // The whole pipeline is guarded by the mutation seq — any user image edit
  // since mount (paste landing, remove, clear, a recall apply) drops the
  // restore: the live state is newer intent than the stale persisted set. ──
  useEffect(() => {
    // This mount is a legitimate (possibly resumed) writer for the id —
    // re-arm its store writes in case a removal flow tombstoned it earlier
    // (resume reuses session ids).
    armWrites(sessionId)
    let cancelled = false
    const seq = mutationsRef.current.seq
    void (async () => {
      const stash = await get(sessionId)
      if (cancelled || stash.length === 0) return
      if (mutationsRef.current.seq !== seq) return // mutation before the load
      const built = await build(stash)
      if (cancelled || mutationsRef.current.seq !== seq) {
        // Dropped (unmount / user edit). The built URLs never entered
        // composer state, so nothing else will revoke them — do it here, or
        // each multi-MB Blob stays pinned for the tab's lifetime (the decode
        // cache owns Blobs, never URLs).
        for (const img of built) URL.revokeObjectURL(img.previewUrl)
        return
      }
      // Record the stash so the write effect can skip the redundant
      // write-back of the set it is about to apply.
      lastRestoredRef.current = stash
      apply(built)
    })()
    return () => {
      cancelled = true
    }
  }, [sessionId, get, build, apply, mutationsRef, armWrites])
}
