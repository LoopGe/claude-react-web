// Streams a multipart/form-data body to disk without ever holding the whole
// file in memory. Shared by the global background upload and the unified
// upload route. Each part is written to `<final>.<index>.part` and atomically
// renamed on success, so a truncated upload never becomes visible at a
// servable path. Callers with their own publication path (the
// content-addressed attachment store) pass `sink` instead of `place` and
// receive the part stream directly.
//
// These routes must NOT be wrapped in Hono's `bodyLimit`: in the chunked case
// it reads the entire body into memory before calling next() (see
// node_modules/hono/dist/middleware/body-limit/index.js). The size limit is
// enforced here, while writing.

import Busboy from 'busboy'
import { createHash } from 'node:crypto'
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
  /** sha256 of the exact stored bytes. */
  digest: string
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
  /** Write the part to caller-chosen paths; the stream owns the temp file. */
  place?: (args: PlaceArgs) => { tmp: string; final: string; name: string }
  /** Consume the part for publication elsewhere. Never handed more than
   *  `maxFileBytes`, so the sink cannot publish an over-limit file. */
  sink?: (part: SinkPart) => Promise<SavedUpload>
}

/** One file part handed to a `sink`. */
export interface SinkPart {
  filename: string
  mimeType: string
  index: number
  /** Raw part bytes, bounded by `maxFileBytes`; consumed by the sink. */
  data: AsyncIterable<Uint8Array>
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
const STREAM_UPLOAD_PATTERNS = [/^\/api\/background\/upload$/, /^\/api\/uploads$/]

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
  digest: string
}

/** The part bytes a sink may see: at most `limit` of them. The rest of the
 *  part is drained so the parser can advance, then the iteration fails.
 *  `destroyOnReturn: false` keeps a sink that stops early from destroying the
 *  part stream, which would leave busboy waiting on a read that never comes;
 *  streamUploads resumes the stream once the sink settles. */
async function* boundedChunks(
  stream: Readable,
  filename: string,
  limit: number,
): AsyncIterable<Uint8Array> {
  let size = 0
  let overflowed = false
  for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
    if (overflowed) continue
    size += chunk.byteLength
    if (size > limit) {
      overflowed = true
      continue
    }
    yield chunk
  }
  if (overflowed) throw new UploadError({ kind: 'too-large', filename, limit })
}

export async function streamUploads(o: StreamUploadOptions): Promise<SavedUpload[]> {
  if ((o.place === undefined) === (o.sink === undefined)) {
    throw new TypeError('streamUploads requires exactly one of place or sink')
  }
  const place = o.place
  const sink = o.sink
  const maxFiles = o.maxFiles ?? 1
  const temps: string[] = []
  const pending: Pending[] = []
  const saved: SavedUpload[] = []
  const writes: Promise<void>[] = []
  let failure: UploadFailure | null = null
  let index = 0

  const bb = Busboy({
    headers: { 'content-type': o.contentType },
    // Browsers send raw UTF-8 filenames in multipart Content-Disposition;
    // busboy's default latin1 charset turns them into mojibake.
    defParamCharset: 'utf8',
    limits: {
      // A sink counts bytes itself, so busboy must let one byte past the
      // limit through for the overflow to be visible at all. Place mode
      // relies on busboy's own truncation instead.
      fileSize: sink ? o.maxFileBytes + 1 : o.maxFileBytes,
      files: maxFiles,
    },
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

    if (sink) {
      const settled = sink({
        filename: info.filename,
        mimeType: info.mimeType,
        index: i,
        data: boundedChunks(stream, info.filename, o.maxFileBytes),
      }).then(
        (upload) => { saved.push(upload) },
        (e: unknown) => {
          if (e instanceof UploadError) failure = e.failure
          else failure ??= { kind: 'parse', message: e instanceof Error ? e.message : String(e) }
        },
      )
      // A sink that never consumed (or stopped early) leaves the part unread;
      // drain it so the parser reaches the closing boundary instead of
      // stalling on backpressure.
      writes.push(settled.finally(() => stream.resume()))
      return
    }

    const dest = place!({ filename: info.filename, mimeType: info.mimeType, index: i })
    temps.push(dest.tmp)
    const ws = createWriteStream(dest.tmp)
    const hash = createHash('sha256')
    let size = 0
    let limited = false
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length
      hash.update(chunk)
    })
    stream.on('limit', () => { limited = true })
    writes.push(
      pipeline(stream, ws).then(
        () => {
          if (limited) {
            failure ??= { kind: 'too-large', filename: info.filename, limit: o.maxFileBytes }
            return
          }
          pending.push({
            tmp: dest.tmp,
            final: dest.final,
            name: dest.name,
            filename: info.filename,
            mimeType: info.mimeType,
            size,
            digest: hash.digest('hex'),
          })
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
  if (sink) return saved
  for (const p of pending) await rename(p.tmp, p.final)
  return pending.map((p) => ({
    path: p.final,
    name: p.name,
    filename: p.filename,
    mimeType: p.mimeType,
    size: p.size,
    digest: p.digest,
  }))
}
