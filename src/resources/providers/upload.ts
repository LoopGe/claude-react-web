// `upload` resource provider — uploads-manager previews in the resource strip.
//
// Bytes come from the durable `GET /api/uploads/:id/content` route (verified
// server-side against the registry digest), never through a live session's
// read-file — a dormant or busy panel previews an upload just the same. The
// content is immutable, so there is no invalidation source: one frame per open
// (the snapshot-diff provider's fetch-once shape).
//
// Only the `text` kind reads bytes here: its payload IS what the body renders,
// so it rides the registry value (stream-capped like the old UploadPreview —
// uploads go to 500 MB, a full text() is not safe). `image` and `pdf` yield
// without bytes: their leaves stream the direct content URL (an <img> src) or
// fetch raw bytes for pdf.js (UploadPdfViewer), each with its own loading /
// error state and no base64 round-trip. `other` fetches nothing; the body shows
// the no-preview notice.

import { parseUploadResource } from '../../../shared/resource-address'
import { uploadPreviewKind, type UploadPreviewKind } from '../../../shared/uploads'
import type { FileReadResult } from '../../../shared/read-file'
import { formatError } from '../../utils/format-error'
import type { ResourceProvider } from '../registry'
import { failure } from './shared'

/** Cap for the streamed text preview (the former UploadPreview limit). */
export const TEXT_PREVIEW_LIMIT = 512 * 1024

export interface UploadResourceValue {
  kind: UploadPreviewKind
  /** File name from the address — drives chip title and extension detection. */
  name: string
  /** Recorded byte count (address query) — the PDF over-cap pre-gate. */
  size: number
  /** Present exactly when kind === 'text'. */
  text?: FileReadResult
}

type FetchLike = (input: string, init: { signal: AbortSignal }) => Promise<Response>

/** Stream the text body up to the cap, then cancel — the file may be far
 *  larger. Lifted verbatim from the old UploadPreview, including the
 *  exact-cap probe: a stream landing exactly on the cap may still be complete,
 *  so one more read decides whether bytes were actually dropped. */
async function readTextCapped(
  fetchImpl: FetchLike,
  url: string,
  signal: AbortSignal,
): Promise<FileReadResult> {
  const res = await fetchImpl(url, { signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const reader = res.body?.getReader()
  if (!reader) throw new Error('no response body')
  const chunks: Uint8Array[] = []
  let received = 0
  let over = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.length
    if (received >= TEXT_PREVIEW_LIMIT) {
      const next = await reader.read()
      over = received > TEXT_PREVIEW_LIMIT || !next.done
      if (!next.done) void reader.cancel()
      break
    }
  }
  const cut = Math.min(received, TEXT_PREVIEW_LIMIT)
  const merged = new Uint8Array(cut)
  let offset = 0
  for (const chunk of chunks) {
    if (offset >= cut) break
    merged.set(chunk.subarray(0, cut - offset), offset)
    offset += Math.min(chunk.length, cut - offset)
  }
  const contents = new TextDecoder('utf-8', { fatal: false }).decode(merged)
  return { available: true, encoding: 'utf-8', contents, ...(over ? { truncated: true } : {}) }
}

export function createUploadProvider(
  fetchImpl: FetchLike = (input, init) => globalThis.fetch(input, init),
): ResourceProvider<UploadResourceValue> {
  return {
    protocol: 'upload',
    async *open(address, ctx) {
      const resource = parseUploadResource(address)
      if (!resource) {
        yield failure('upload/invalid-address', 'This address does not name an upload.')
        return
      }
      const kind = uploadPreviewKind(resource.name)
      const base: UploadResourceValue = { kind, name: resource.name, size: resource.size }
      if (kind !== 'text') {
        yield { ok: true, value: base }
        return
      }
      try {
        const text = await readTextCapped(
          fetchImpl,
          `/api/uploads/${encodeURIComponent(resource.id)}/content`,
          ctx.signal,
        )
        if (ctx.signal.aborted) return
        yield { ok: true, value: { ...base, text } }
      } catch (error) {
        if (ctx.signal.aborted) return
        yield failure('upload/read-failed', formatError(error))
      }
    },
  }
}
