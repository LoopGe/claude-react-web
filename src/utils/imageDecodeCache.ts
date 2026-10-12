// Decode cache for persisted history images.
//
// Recall used to decode base64 → Blob synchronously on the main thread
// (atob + per-byte loop): a ~10 MB entry froze the UI for ~100-200 ms on
// EVERY ↑/↓ step onto it, and stepping A→B→A re-decoded each time. This
// module replaces that with:
//   - async decoding through `fetch(data:…)` — the browser parses the
//     data URL off the main thread and hands back a Blob
//   - an LRU keyed by the base64 payload, so walking back and forth over
//     the same entries is a cache hit (no re-decode)
//
// OWNERSHIP: this cache is a pure decode MEMO. It stores Blobs — never blob
// URLs — and every buildPastedImages() call mints a FRESH blob URL from the
// cached Blob. That makes each returned URL composer-owned (revoked by the
// composer on replace/remove/clear), so cache eviction can never revoke a
// URL the composer is currently displaying, and the composer needs no
// ownership special-casing. Eviction just drops the Blob reference; the GC
// reclaims it. `reset-config`'s "input history" item calls
// clearImageDecodeCache() alongside the IDB wipe (a clear-generation guard
// keeps in-flight decodes from resurrecting the memo).

import { randomId } from './uuid'
import type { PersistedImage } from '../state/inputHistoryImages'
import type { PastedImage } from '../types'

const DEFAULT_MAX_ENTRIES = 12
const DEFAULT_MAX_TOTAL_BYTES = 128 * 1024 * 1024

interface MemoEntry {
  blob: Blob
  mediaType: PersistedImage['mediaType']
}

// key = the base64 payload itself (map compare is memcmp-fast); the value's
// mediaType guards against the (pathological) same-payload-different-type hit.
const memo = new Map<string, MemoEntry>()
// In-flight decodes, so two rapid steps onto the same entry share one decode.
const inflight = new Map<string, Promise<MemoEntry>>()
// Bumped by clearImageDecodeCache(); decodes started before the clear must
// not re-insert their memo entry.
let clearGeneration = 0

let maxEntries = DEFAULT_MAX_ENTRIES
let maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES

/** Test hook: override the LRU caps (null restores defaults). */
export function _setCapsForTests(caps: { maxEntries: number; maxTotalBytes: number } | null): void {
  if (caps) {
    maxEntries = caps.maxEntries
    maxTotalBytes = caps.maxTotalBytes
  } else {
    maxEntries = DEFAULT_MAX_ENTRIES
    maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES
  }
}

/** LRU bookkeeping: delete + re-insert moves the key to the back (most
 *  recent). Then drop from the FRONT until both caps hold. */
function touchAndEvict(key: string, entry: MemoEntry): void {
  memo.delete(key)
  memo.set(key, entry)
  let totalBytes = 0
  for (const k of memo.keys()) {
    // The key IS the base64 payload — its length is the payload's size.
    totalBytes += k.length
  }
  while (memo.size > maxEntries || totalBytes > maxTotalBytes) {
    const oldest = memo.keys().next()
    if (oldest.done) break
    totalBytes -= oldest.value.length
    memo.delete(oldest.value)
  }
}

async function decode(key: string, p: PersistedImage, generation: number): Promise<MemoEntry> {
  const res = await fetch(`data:${p.mediaType};base64,${p.data}`)
  const blob = await res.blob()
  const entry: MemoEntry = { blob, mediaType: p.mediaType }
  // A decode that started before a clearImageDecodeCache() must not
  // resurrect the memo the clear just dropped.
  if (generation === clearGeneration) touchAndEvict(key, entry)
  return entry
}

/** Build live PastedImage objects for a persisted set. Cache hits reuse the
 *  decoded Blob (no re-decode) but always mint a FRESH composer-owned URL;
 *  misses decode asynchronously. Images whose decode fails are skipped
 *  (logged) rather than failing the whole recall. */
export async function buildPastedImages(
  images: readonly PersistedImage[],
): Promise<PastedImage[]> {
  const generation = clearGeneration
  const out = await Promise.all(
    images.map(async (p): Promise<PastedImage | null> => {
      const key = p.data
      const cached = memo.get(key)
      let entry: MemoEntry
      if (cached && cached.mediaType === p.mediaType) {
        touchAndEvict(key, cached)
        entry = cached
      } else {
        try {
          const pending = inflight.get(key)
          if (pending) {
            entry = await pending
          } else {
            const d = decode(key, p, generation)
            inflight.set(key, d)
            try {
              entry = await d
            } finally {
              inflight.delete(key)
            }
          }
        } catch (err) {
          // One un-decodable image must not fail the whole recall — skip it
          // (the rest still apply).
          console.warn('[imageDecodeCache] decode failed, skipping image:', err)
          return null
        }
      }
      return {
        id: randomId(),
        data: p.data,
        mediaType: p.mediaType,
        width: p.width,
        height: p.height,
        size: p.size,
        // Composer-owned URL, minted fresh from the cached Blob.
        previewUrl: URL.createObjectURL(entry.blob),
      }
    }),
  )
  return out.filter((i): i is PastedImage => i !== null)
}

/** Drop every decoded Blob (reset-config). Composer-owned URLs are unaffected
 *  — the cache never owns URLs. In-flight decodes are generation-guarded so
 *  they cannot resurrect the memo. */
export function clearImageDecodeCache(): void {
  clearGeneration++
  memo.clear()
  inflight.clear()
}
