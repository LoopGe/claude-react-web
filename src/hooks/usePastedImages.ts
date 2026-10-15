import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { formatBytes } from '../utils/format'
import { randomId } from '../utils/uuid'
import { getMaxPastedImageBytes } from './config-store'
import type { PastedImage } from '../types'

const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
const MAX_PER_IMAGE = 10 * 1024 * 1024 // 10 MB

export interface UsePastedImages {
  images: PastedImage[]
  error: string | null
  addImage: (file: File) => Promise<void>
  removeImage: (id: string) => void
  clear: () => void
  /** Replace the pending images with a PREBUILT set (history recall — the
   *  images come from the decode cache with cache-owned URLs, `fromCache`).
   *  Replaced composer-owned URLs are revoked; cache-owned ones survive (the
   *  cache owns their lifecycle). An in-flight addImage is NOT discarded —
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
  const imagesRef = useRef(images)
  useEffect(() => { imagesRef.current = images }, [images])
  // Generation counter bumped on every clear(). addImage captures the
  // value before its await and skips the state update if clear() ran
  // in the interim — otherwise the image lands with a revoked blob URL.
  const clearGenerationRef = useRef(0)
  // Synchronous mutation signal for async appliers — see the interface docs.
  const mutationsRef = useRef<ImageMutations>({ seq: 0, kind: 'apply' })
  const bumpMutations = useCallback((kind: ImageMutationKind) => {
    mutationsRef.current = { seq: mutationsRef.current.seq + 1, kind }
  }, [])
  // Every blob URL we create is registered here the instant it's minted,
  // and removed only once it has been explicitly revoked. This closes the
  // race where the component unmounts while addImage is still awaiting
  // fileToBase64/getImageDimensions: the previewUrl was created but never
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
  // NOT bump clearGenerationRef: an addImage still decoding when the user
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

  const addImage = useCallback(async (file: File) => {
    setError(null)

    if (!ALLOWED_TYPES.has(file.type)) {
      setError(`Unsupported image type: ${file.type || 'unknown'}. Use JPEG, PNG, GIF, or WebP.`)
      return
    }
    if (file.size > MAX_PER_IMAGE) {
      setError(`Image too large (${formatBytes(file.size)}). Max ${formatBytes(MAX_PER_IMAGE)} per image.`)
      return
    }
    const currentTotal = imagesRef.current.reduce((sum, i) => sum + i.size, 0)
    const maxTotal = getMaxPastedImageBytes()
    if (currentTotal + file.size > maxTotal) {
      setError(`Total image size too large. Max ${formatBytes(maxTotal)} across all images.`)
      return
    }

    const id = randomId()
    const previewUrl = URL.createObjectURL(file)
    allUrlsRef.current.add(previewUrl)
    const generation = clearGenerationRef.current

    try {
      const data = await fileToBase64(file)
      const dims = await getImageDimensions(previewUrl)

      // If clear() was called while we were awaiting, the blob URL has
      // already been revoked and imagesRef was reset. Discard instead of
      // inserting a broken preview.
      if (clearGenerationRef.current !== generation) {
        revokeUrl(previewUrl)
        return
      }

      bumpMutations('add')
      setImages((prev) => [
        ...prev,
        {
          id,
          data,
          mediaType: file.type as PastedImage['mediaType'],
          width: dims.width,
          height: dims.height,
          size: file.size,
          previewUrl,
        },
      ])
    } catch {
      revokeUrl(previewUrl)
    }
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
  return useMemo(
    () => ({ images, error, addImage, removeImage, clear, applyImages, mutationsRef }),
    [images, error, addImage, removeImage, clear, applyImages, mutationsRef],
  )
}

function getImageDimensions(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => resolve({ width: 0, height: 0 })
    img.src = url
  })
}

/** Convert a File to a base64 string using FileReader, which avoids
 *  the O(n) string concatenation that blocked the main thread. */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      // Strip the data-URL prefix (e.g. "data:image/png;base64,")
      const commaIdx = result.indexOf(',')
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result)
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}
