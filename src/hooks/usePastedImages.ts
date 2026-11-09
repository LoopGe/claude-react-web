import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { formatBytes } from '../utils/format'
import { ImageNormalizeError, preparePastedImage, type NormalizedImage } from '../utils/image-normalize'
import { isSupportedImageMediaType } from '../../shared/image-media'
import { randomId } from '../utils/uuid'
import { getMaxPastedImageBytes } from './config-store'
import { MAX_IMAGE_BYTES, MAX_IMAGES_PER_MESSAGE } from '../../shared/upload-limits'
import type { PastedImage } from '../types'

/** Concurrent decodes inside one intake batch. */
const DECODE_CONCURRENCY = 2

type ProcessedImage =
  | { file: File; url: string; normalized: NormalizedImage }
  | { file: File; error: string }

export interface UsePastedImages {
  images: PastedImage[]
  error: string | null
  /** True while at least one accepted image is still being decoded. The
   *  composer blocks sending so a send cannot race past an in-flight batch. */
  pending: boolean
  /** Add one intake batch (drag/picker multi-select) with the limit checks
   *  counted across the whole batch. Landed images are appended as they
   *  decode. Returns the first refusal message (or null), so a caller can
   *  surface it even when the committed error string is unchanged between two
   *  attempts. */
  addImages: (files: readonly File[]) => Promise<string | null>
  removeImage: (id: string) => void
  clear: () => void
  /** Replace the pending images with a PREBUILT set (history recall — the
   *  images come from the decode cache with cache-owned URLs, `fromCache`).
   *  Replaced composer-owned URLs are revoked; cache-owned ones survive (the
   *  cache owns their lifecycle). An in-flight add batch is NOT discarded —
   *  it lands on the applied set. Empty array = clear (text-only recall). */
  applyImages: (prebuilt: readonly PastedImage[]) => void
  /** Synchronous mutation signal, replaced (not mutated) with every image-set
   *  change: `seq` is a monotonic counter, `kind` names the most recent
   *  mutation. Async pipelines that apply images (draft restore) capture
   *  `seq` before their async work and drop their apply if it advanced — a
   *  user edit in the window always wins. `kind` distinguishes consumption
   *  (send's `clear`, a `remove`) from replacement (a history recall's
   *  `apply`): the draft-image persistence deletes its record on the former
   *  and keeps it through the latter. A ref, not state: consumers read it
   *  from async callbacks, where they need the value at land time, not at
   *  last render. */
  mutationsRef: RefObject<ImageMutations>
}

/** What kind of mutation last touched the image set. */
export type ImageMutationKind = 'add' | 'remove' | 'clear' | 'apply'

/** The value shape of `usePastedImages`' mutation signal. */
export interface ImageMutations {
  seq: number
  kind: ImageMutationKind
}

export function usePastedImages(): UsePastedImages {
  const [images, setImages] = useState<PastedImage[]>([])
  const [error, setError] = useState<string | null>(null)
  // Counts intake batches still decoding, so overlapping batches cannot clear
  // the pending state early.
  const [pendingBatches, setPendingBatches] = useState(0)
  const imagesRef = useRef(images)
  // Bytes accepted by batches that have not committed yet. imagesRef only
  // catches up after a render, so overlapping intake calls (two drops, a drop
  // plus a paste) must also see each other's in-flight reservations.
  const reservedBytesRef = useRef(0)
  // A committed batch keeps its reservation until the imagesRef sync effect
  // runs. Releasing it at decode completion would let the very next call in
  // the same task compute its total from a stale imagesRef.
  const pendingReleaseRef = useRef(0)
  // Count reservations use the same lifecycle as the byte reservation:
  // accepted-but-not-yet-committed images stay counted across overlapping
  // batches, and committed images move into imagesRef on the next render.
  const reservedCountRef = useRef(0)
  const pendingReleaseCountRef = useRef(0)
  useEffect(() => {
    imagesRef.current = images
    if (pendingReleaseRef.current !== 0) {
      reservedBytesRef.current -= pendingReleaseRef.current
      pendingReleaseRef.current = 0
    }
    if (pendingReleaseCountRef.current !== 0) {
      reservedCountRef.current -= pendingReleaseCountRef.current
      pendingReleaseCountRef.current = 0
    }
  }, [images])
  // Generation counter bumped on every clear(). An add captures the
  // value before its first await and skips each commit if clear() ran
  // in the interim — otherwise the image lands with a revoked blob URL.
  const clearGenerationRef = useRef(0)
  // Synchronous mutation signal for async appliers — see the interface docs.
  const mutationsRef = useRef<ImageMutations>({ seq: 0, kind: 'apply' })
  const bumpMutations = useCallback((kind: ImageMutationKind) => {
    mutationsRef.current = { seq: mutationsRef.current.seq + 1, kind }
  }, [])
  // Every blob URL we create is registered here the instant it's minted,
  // and removed only once it has been explicitly revoked. This closes the
  // race where the component unmounts while an add is still normalizing: the
  // previewUrl was created but never
  // yet pushed into `images` (so imagesRef doesn't know about it), and
  // the unmount cleanup below would otherwise miss it, pinning the blob's
  // bytes for the tab's lifetime. Tracking all URLs in one set guarantees
  // every URL is revoked exactly once regardless of when unmount lands.
  const allUrlsRef = useRef<Set<string>>(new Set())
  const revokeUrl = useCallback((url: string) => {
    URL.revokeObjectURL(url)
    allUrlsRef.current.delete(url)
  }, [])

  const removeImage = useCallback((id: string) => {
    bumpMutations('remove')
    setImages((prev) => {
      const img = prev.find((i) => i.id === id)
      if (img) revokeUrl(img.previewUrl)
      return prev.filter((i) => i.id !== id)
    })
  }, [revokeUrl, bumpMutations])

  const clear = useCallback(() => {
    clearGenerationRef.current++
    bumpMutations('clear')
    for (const img of imagesRef.current) revokeUrl(img.previewUrl)
    setImages([])
    setError(null)
  }, [revokeUrl, bumpMutations])

  // History-recall path: apply a PREBUILT set built by the image decode
  // cache. The URLs are minted fresh per build and composer-owned (the cache
  // is a pure Blob memo — it never owns URLs, never revokes), so the normal
  // revoke-on-replace lifecycle applies unchanged. Runs synchronously — no
  // awaits — so no generation guard is needed here, and deliberately does
  // NOT bump clearGenerationRef: an add still decoding when the user
  // steps ↑ then ↓ back to the draft must LAND on the applied set, not be
  // silently dropped. clear() keeps the bump — after a send a stale
  // in-flight paste must not repopulate the emptied composer.
  const applyImages = useCallback(
    (prebuilt: readonly PastedImage[]) => {
      const next: PastedImage[] = [...prebuilt]
      bumpMutations('apply')
      setImages((prev) => {
        for (const img of prev) revokeUrl(img.previewUrl)
        return next
      })
    },
    [revokeUrl, bumpMutations],
  )

  const addImages = useCallback(async (files: readonly File[]): Promise<string | null> => {
    setError(null)

    // Check the batch as one sequence: each accepted file raises the running
    // total, so N files that each fit individually can no longer slip past the
    // aggregate limit in the same render cycle (imagesRef lags a commit).
    // `reservedBytesRef` extends the same accounting across overlapping
    // batches that have not committed yet.
    const accepted: File[] = []
    let total = imagesRef.current.reduce((sum, img) => sum + (img.original?.size ?? img.size), 0) + reservedBytesRef.current
    let totalCount = imagesRef.current.length + reservedCountRef.current
    const maxTotal = getMaxPastedImageBytes()
    let failure: string | null = null
    const refuse = (message: string): void => {
      if (failure !== null) return
      failure = message
      setError(message)
    }
    for (const file of files) {
      if (!isSupportedImageMediaType(file.type)) {
        refuse(`Unsupported image type: ${file.type || 'unknown'}. Use JPEG, PNG, GIF, or WebP.`)
        continue
      }
      if (totalCount >= MAX_IMAGES_PER_MESSAGE) {
        refuse(`Too many images. Max ${MAX_IMAGES_PER_MESSAGE} per message.`)
        continue
      }
      if (file.size > MAX_IMAGE_BYTES) {
        refuse(`Image too large (${formatBytes(file.size)}). Max ${formatBytes(MAX_IMAGE_BYTES)} per image.`)
        continue
      }
      if (total + file.size > maxTotal) {
        refuse(`Total image size too large. Max ${formatBytes(maxTotal)} across all images.`)
        continue
      }
      total += file.size
      totalCount += 1
      accepted.push(file)
    }
    if (accepted.length === 0) return failure

    const acceptedBytes = accepted.reduce((sum, file) => sum + file.size, 0)
    reservedBytesRef.current += acceptedBytes
    reservedCountRef.current += accepted.length
    setPendingBatches((count) => count + 1)
    const generation = clearGenerationRef.current
    // Normalize at most two images at a time: one drop can carry many
    // screenshots, and N concurrent decodes/encodes is a needless main-thread
    // burst. Each chunk's images still land as soon as it finishes, so a send
    // during a long batch sees what already made it. Their source bytes move
    // from the reservation to `pendingReleaseRef` at commit; the imagesRef
    // sync effect drains them once the commit is visible.
    let committedBytes = 0
    let committedCount = 0
    try {
      for (let index = 0; index < accepted.length; index += DECODE_CONCURRENCY) {
        if (clearGenerationRef.current !== generation) break
        const chunk = accepted.slice(index, index + DECODE_CONCURRENCY)
        const processed = await Promise.all(chunk.map(async (file): Promise<ProcessedImage> => {
          let previewUrl: string | undefined
          try {
            const url = URL.createObjectURL(file)
            previewUrl = url
            allUrlsRef.current.add(url)
            const normalized = await preparePastedImage(file)
            return { file, url, normalized }
          } catch (err) {
            if (previewUrl !== undefined) revokeUrl(previewUrl)
            return {
              file,
              error: err instanceof ImageNormalizeError
                ? err.message
                : `Could not process image: ${err instanceof Error ? err.message : String(err)}`,
            }
          }
        }))
        for (const entry of processed) {
          if ('error' in entry) {
            refuse(entry.error)
            continue
          }
          if (clearGenerationRef.current !== generation) {
            revokeUrl(entry.url)
            continue
          }
          pendingReleaseRef.current += entry.file.size
          pendingReleaseCountRef.current += 1
          committedBytes += entry.file.size
          committedCount += 1
          bumpMutations('add')
          setImages((prev) => [...prev, {
            id: randomId(),
            data: entry.normalized.data,
            mediaType: entry.normalized.mediaType,
            width: entry.normalized.width,
            height: entry.normalized.height,
            size: entry.normalized.size,
            original: entry.normalized.original,
            previewUrl: entry.url,
          }])
        }
      }
    } finally {
      // Release the bytes/count that never reached a commit; committed ones
      // are released by the imagesRef sync effect.
      reservedBytesRef.current -= acceptedBytes - committedBytes
      reservedCountRef.current -= accepted.length - committedCount
      setPendingBatches((count) => count - 1)
    }
    return failure
  }, [revokeUrl, bumpMutations])

  // Cleanup on unmount: revoke every URL we created, including any that
  // are still mid-decode (not yet in `images`). The Set instance is stable
  // for the ref's lifetime (we only mutate it, never reassign), so capturing
  // it here and iterating in the cleanup sees every URL added before unmount.
  useEffect(() => {
    const all = allUrlsRef.current
    return () => {
      for (const url of all) URL.revokeObjectURL(url)
      all.clear()
    }
  }, [])

  // Memoized so the returned object's identity is stable across renders
  // when nothing changed. Callers commonly list this hook's return in a
  // `useCallback` dep array (Composer's `send`, drag-drop handlers); a
  // fresh object literal per render would defeat that memo and cascade
  // into `handleSend` → Composer's `React.memo`. `images`/`error` come
  // from `useState` (only mutate on real changes); the three action
  // callbacks are `useCallback([])`-stable — so the memo returns the
  // same reference until the user pastes / removes / clears.
  const pending = pendingBatches > 0
  return useMemo(
    () => ({ images, error, pending, addImages, removeImage, clear, applyImages, mutationsRef }),
    [images, error, pending, addImages, removeImage, clear, applyImages, mutationsRef],
  )
}
