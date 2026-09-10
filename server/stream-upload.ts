// Streams a multipart/form-data body to disk without ever holding the whole
// file in memory. Shared by the global background upload and the per-session
// file upload. Each part is written to `<final>.<index>.part` and atomically
// renamed on success, so a truncated upload never becomes visible at a
// servable path.
//
// These routes must NOT be wrapped in Hono's `bodyLimit`: in the chunked case
// it reads the entire body into memory before calling next() (see
// node_modules/hono/dist/middleware/body-limit/index.js). The size limit is
// enforced here, while writing.

import Busboy from 'busboy'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createWriteStream } from 'node:fs'
import { rename, unlink } from 'node:fs/promises'

export interface SavedUpload {
  path: string
  name: string
  filename: string
  mimeType: string
  size: number
}

export interface PlaceArgs {
  filename: string
  mimeType: string
  index: number
}

export interface StreamUploadOptions {
  body: ReadableStream<Uint8Array>
  contentType: string
  maxFileBytes: number
  maxFiles?: number
  /** mime → ext allow-list. Omitted = accept any type. */
  accept?: Record<string, string>
  place: (args: PlaceArgs) => { tmp: string; final: string; name: string }
}

export type UploadFailure =
  | { kind: 'too-large'; filename: string; limit: number }
  | { kind: 'bad-type'; filename: string; mimeType: string }
  | { kind: 'parse'; message: string }

export class UploadError extends Error {
  constructor(readonly failure: UploadFailure) {
    super(`upload failed: ${failure.kind}`)
    this.name = 'UploadError'
  }
}

/** The routes served by streamUploads — exempt from the global bodyLimit. */
const STREAM_UPLOAD_PATTERNS = [/^\/api\/background\/upload$/, /^\/api\/sessions\/[^/]+\/uploads$/]

export function isStreamingUploadPath(path: string): boolean {
  return STREAM_UPLOAD_PATTERNS.some((re) => re.test(path))
}

interface Pending {
  tmp: string
  final: string
  name: string
  filename: string
  mimeType: string
  size: number
}

export async function streamUploads(o: StreamUploadOptions): Promise<SavedUpload[]> {
  const maxFiles = o.maxFiles ?? 1
  const temps: string[] = []
  const pending: Pending[] = []
  const writes: Promise<void>[] = []
  let failure: UploadFailure | null = null
  let index = 0

  const bb = Busboy({
    headers: { 'content-type': o.contentType },
    limits: { fileSize: o.maxFileBytes, files: maxFiles },
  })

  bb.on('file', (_field, stream, info) => {
    const i = index++
    if (o.accept && !Object.hasOwn(o.accept, info.mimeType)) {
      failure ??= { kind: 'bad-type', filename: info.filename, mimeType: info.mimeType }
      stream.resume() // drain so the parser can advance
      return
    }
    if (failure) {
      stream.resume()
      return
    }

    const dest = o.place({ filename: info.filename, mimeType: info.mimeType, index: i })
    temps.push(dest.tmp)
    const ws = createWriteStream(dest.tmp)
    let size = 0
    let limited = false
    stream.on('data', (chunk: Buffer) => { size += chunk.length })
    stream.on('limit', () => { limited = true })
    writes.push(
      pipeline(stream, ws).then(
        () => {
          if (limited) {
            failure ??= { kind: 'too-large', filename: info.filename, limit: o.maxFileBytes }
            return
          }
          pending.push({ tmp: dest.tmp, final: dest.final, name: dest.name, filename: info.filename, mimeType: info.mimeType, size })
        },
        (e: Error) => { failure ??= { kind: 'parse', message: e.message } },
      ),
    )
  })

  bb.on('error', (e: Error) => { failure ??= { kind: 'parse', message: e.message } })

  await new Promise<void>((resolve) => {
    const src = Readable.fromWeb(o.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>)
    src.on('error', (e: Error) => { failure ??= { kind: 'parse', message: e.message }; resolve() })
    bb.on('close', resolve)
    src.pipe(bb)
  })
  await Promise.all(writes)

  if (failure) {
    // Every temp the caller handed us goes — the successful writes too.
    for (const t of temps) await unlink(t).catch(() => {})
    throw new UploadError(failure)
  }
  for (const p of pending) await rename(p.tmp, p.final)
  return pending.map((p) => ({ path: p.final, name: p.name, filename: p.filename, mimeType: p.mimeType, size: p.size }))
}
