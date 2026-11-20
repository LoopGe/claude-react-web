// Render-side image content cache: durable ref → blob URL.
//
// Transcript render sites (BlockView → MsgImage → Lightbox) resolve image ref
// blocks through useImageContent. Unlike imageDecodeCache — a pure Blob memo
// whose URLs are composer-owned — this cache OWNS its blob URLs and revokes
// them on LRU eviction. An entry with active subscribers is never evicted: a
// mounted <img> (or the Lightbox displaying its URL) must not lose its src
// mid-display. The caps therefore bound the RETAINED set after components
// unmount (Virtuoso windows rows out of the DOM), not the on-screen set.
//
// Failures are not cached: a refused ref (404 missing / 500 corrupt) surfaces
// as `failed` for that mount, and a later mount retries — real errors stay
// visible instead of being pinned by a negative entry.

import { useEffect, useState } from 'react'
import type { ImageAttachmentRef } from '../../shared/image-attachment'
import { fetchImageContentBlob } from '../utils/image-content'

export interface ImageContentState {
  /** The cached blob URL, or null while loading / on failure / for null ref. */
  url: string | null
  /** The content route refused this ref (missing / corrupt / network). */
  failed: boolean
}

interface ContentEntry {
  url: string
  bytes: number
}

const DEFAULT_MAX_ENTRIES = 32
const DEFAULT_MAX_TOTAL_BYTES = 128 * 1024 * 1024

// key = the ref id (`sha256:<digest>`); Map order is LRU (back = most recent).
const cache = new Map<string, ContentEntry>()
// In-flight loads, so concurrent subscribers of one ref share a single fetch.
const inflight = new Map<string, Promise<ContentEntry>>()
// Active hook subscriptions per ref — eviction skips entries still on screen.
const subscribers = new Map<string, number>()

let maxEntries = DEFAULT_MAX_ENTRIES
let maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES

/** Test hook: override the LRU caps (null restores defaults). */
export function _setImageContentCapsForTests(caps: { maxEntries: number; maxTotalBytes: number } | null): void {
  if (caps) {
    maxEntries = caps.maxEntries
    maxTotalBytes = caps.maxTotalBytes
  } else {
    maxEntries = DEFAULT_MAX_ENTRIES
    maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES
  }
}

/** Test hook: drop every cached URL (revoking each) and all bookkeeping. */
export function _clearImageContentCacheForTests(): void {
  for (const entry of cache.values()) URL.revokeObjectURL(entry.url)
  cache.clear()
  inflight.clear()
  subscribers.clear()
}

/** LRU bookkeeping: delete + re-insert moves the key to the back. */
function touch(id: string, entry: ContentEntry): void {
  cache.delete(id)
  cache.set(id, entry)
}

/** Drop from the FRONT until both caps hold, skipping subscribed entries.
 *  When every entry is on screen nothing is evictable — the caps yield to
 *  live display rather than revoking a URL under an <img>. */
function evict(): void {
  let totalBytes = 0
  for (const entry of cache.values()) totalBytes += entry.bytes
  while (cache.size > maxEntries || totalBytes > maxTotalBytes) {
    let oldestId: string | null = null
    let oldestEntry: ContentEntry | null = null
    for (const [id, entry] of cache) {
      if ((subscribers.get(id) ?? 0) === 0) {
        oldestId = id
        oldestEntry = entry
        break
      }
    }
    if (oldestId === null || oldestEntry === null) return
    totalBytes -= oldestEntry.bytes
    cache.delete(oldestId)
    URL.revokeObjectURL(oldestEntry.url)
  }
}

function load(id: string): Promise<ContentEntry> {
  const pending = inflight.get(id)
  if (pending) return pending
  const p = (async () => {
    const blob = await fetchImageContentBlob(id)
    const entry: ContentEntry = { url: URL.createObjectURL(blob), bytes: blob.size }
    touch(id, entry)
    evict()
    return entry
  })()
  inflight.set(id, p)
  // Settle the inflight slot on either outcome without leaving an unhandled
  // rejection on this bookkeeping chain (subscribers attach their own).
  const settle = () => { inflight.delete(id) }
  p.then(settle, settle)
  return p
}

const LOADING: ImageContentState = { url: null, failed: false }

function cachedState(id: string | null): ImageContentState {
  if (id === null) return LOADING
  const entry = cache.get(id)
  return entry !== undefined ? { url: entry.url, failed: false } : LOADING
}

/** Resolve one image ref to a renderable blob URL. `null` ref (a legacy
 *  base64 block, or no image) is a no-op: no subscription, no fetch. */
export function useImageContent(ref: ImageAttachmentRef | null): ImageContentState {
  const id = ref?.id ?? null
  const [state, setState] = useState<ImageContentState>(() => cachedState(id))
  // The ref changed under a reused component (Virtuoso hands a row a new
  // block): re-read the cache during render so a hit paints without a
  // loading frame (the documented derived-state pattern — no effect).
  const [trackedId, setTrackedId] = useState<string | null>(id)
  if (trackedId !== id) {
    setTrackedId(id)
    setState(cachedState(id))
  }

  useEffect(() => {
    if (id === null) return
    // Stale-closure guard: when the row is reused for a new ref (or
    // unmounts) before this load settles, the late callback must not paint
    // the OLD ref's outcome over the new state — the render-phase read
    // never re-corrects (trackedId already equals the new id). The load
    // itself still completes and caches its entry for future subscribers.
    let active = true
    subscribers.set(id, (subscribers.get(id) ?? 0) + 1)
    const cached = cache.get(id)
    if (cached !== undefined) touch(id, cached)
    // A hit resolves in a microtask so the state update always rides a
    // subscription callback (the render-phase read above already paints a
    // hit synchronously; this covers the cache filling between render and
    // effect, and keeps the effect body free of synchronous setState).
    const resolved = cached !== undefined ? Promise.resolve(cached) : load(id)
    resolved.then(
      (entry) => { if (active) setState({ url: entry.url, failed: false }) },
      () => { if (active) setState({ url: null, failed: true }) },
    )
    return () => {
      active = false
      const remaining = (subscribers.get(id) ?? 1) - 1
      if (remaining <= 0) subscribers.delete(id)
      else subscribers.set(id, remaining)
      evict()
    }
  }, [id])

  return state
}
