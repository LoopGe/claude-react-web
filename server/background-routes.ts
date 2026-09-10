// Global background-image upload routes. Unlike session uploads (which land
// in the session's cwd, server/routes/uploads.ts), a background is a global
// appearance file stored under <stateDir>/backgrounds/ and served back as a
// same-origin URL. Filenames are server-assigned <uuid>.<ext> — user-supplied
// names are never trusted. Every read/delete is containment-checked.

import { Hono } from 'hono'
import { mkdir, writeFile, stat, unlink } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { resolve, join, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { config as serverConfig } from './config.js'
import { createLogger } from './log.js'

const log = createLogger('background')

/** Acceptable upload content types → file extension. Video is limited to the
 *  two containers every target browser plays natively (mp4/H.264, webm) — an
 *  accepted-but-unplayable file would be a wallpaper that silently does
 *  nothing, so `.mov`/`.avi` are refused rather than stored. */
const ALLOWED_UPLOAD: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
}

/** Served extension (lowercase, no dot) → Content-Type for GET. Must cover
 *  every extension ALLOWED_UPLOAD can produce. */
const EXT_TYPE: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  mp4: 'video/mp4',
  webm: 'video/webm',
}

/** Server-assigned names only: a uuid stem + an extension we actually serve.
 *  This is the read/delete containment gate. The extension set is read off
 *  EXT_TYPE rather than re-listed, so an upload can never mint a name this
 *  rejects — that file would be stored but never readable or deletable. */
function isSafeName(name: string): boolean {
  if (name.length === 0 || name.length > 80) return false
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return false
  return /^[0-9a-f-]+$/i.test(name.slice(0, dot))
    && Object.hasOwn(EXT_TYPE, name.slice(dot + 1).toLowerCase())
}

function isInside(base: string, target: string): boolean {
  const b = resolve(base)
  const t = resolve(target)
  return t === b || t.startsWith(b.endsWith(sep) ? b : b + sep)
}

/** A single satisfiable byte range, `unsatisfiable` for a well-formed range
 *  past the end (which must be a 416), or null for "serve the whole file" —
 *  no header, or a form we deliberately do not serve (multi-range, garbage),
 *  which a server is always free to answer in full. */
function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  // `bytes=-` (both sides empty) names nothing; treat it as unparseable.
  if (!m || (m[1] === '' && m[2] === '')) return null
  let start: number
  let end: number
  if (m[1] === '') {
    // `bytes=-N`: the last N bytes.
    const n = Number(m[2])
    if (n === 0 || size === 0) return 'unsatisfiable'
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(m[1])
    if (m[2] === '') {
      // `bytes=N-`: open-ended, so the end is ours to fill in below. The
      // inversion test must not run against a value we invented.
      end = size - 1
    } else {
      end = Number(m[2])
      // An EXPLICIT last-byte-pos before the first is an INVALID byte-range-spec,
      // not an unsatisfiable one: RFC 9110 requires an invalid Range to be
      // ignored, and a 416 can make a media element give up on the resource.
      if (end < start) return null
    }
  }
  if (start >= size) return 'unsatisfiable'
  return { start, end: Math.min(end, size - 1) }
}

export function buildBackgroundRouter(opts: { dir: string; maxUploadBytes?: number }): Hono {
  const app = new Hono()
  const dir = opts.dir
  const maxBytes = opts.maxUploadBytes ?? serverConfig.maxUploadBytes

  app.post('/upload', async (c) => {
    const ct = c.req.header('content-type') ?? ''
    if (!ct.toLowerCase().startsWith('multipart/form-data')) {
      return c.json({ error: 'expected multipart/form-data' }, 400)
    }
    const body = await c.req.parseBody({ all: true }).catch(() => null)
    if (!body) return c.json({ error: 'invalid multipart payload' }, 400)

    let file: File | undefined
    for (const v of Object.values(body)) {
      if (v instanceof File) { file = v; break }
    }
    if (!file) return c.json({ error: 'no file in request' }, 400)

    // `hasOwn` — a bare index is a prototype-chain lookup, so a part declaring
    // e.g. `Content-Type: constructor` would resolve to Object and bypass the
    // allow-list, storing a file whose name can never be served.
    const ext = Object.hasOwn(ALLOWED_UPLOAD, file.type) ? ALLOWED_UPLOAD[file.type] : undefined
    if (!ext) return c.json({ error: `unsupported file type '${file.type}'` }, 400)
    if (file.size > maxBytes) {
      return c.json({ error: `file exceeds ${maxBytes} bytes` }, 413 as 400 | 404 | 410 | 500)
    }

    await mkdir(dir, { recursive: true })
    const name = `${randomUUID()}${ext}`
    await writeFile(join(dir, name), Buffer.from(await file.arrayBuffer()))
    log.info(`upload background name=${name} bytes=${file.size}`)
    return c.json({ url: `/api/background/files/${name}` })
  })

  app.get('/files/:name', async (c) => {
    const name = c.req.param('name')
    if (!isSafeName(name)) return c.json({ error: 'invalid filename' }, 400)
    const target = join(dir, name)
    if (!isInside(dir, target)) return c.json({ error: 'invalid filename' }, 400)
    const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
    // `isSafeName` already proved `ext` is a key; the guarded read keeps this
    // lookup on the same footing as the upload allow-list rather than reaching
    // through Object.prototype if that gate is ever relaxed.
    const type = Object.hasOwn(EXT_TYPE, ext) ? EXT_TYPE[ext] : 'application/octet-stream'

    let size: number
    try {
      size = (await stat(target)).size
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return c.json({ error: 'not found' }, 404)
      log.error(`stat background name=${name}: ${(e as Error).message}`)
      return c.json({ error: (e as Error).message }, 500)
    }

    // A media element probes with a Range request and will not play a resource
    // that answers 200 with no byte-range support (Safari refuses outright), so
    // partial requests must be honoured. Streamed, not read into memory: a
    // wallpaper can be `maxUploadBytes` big.
    const range = parseRange(c.req.header('range'), size)
    if (range === 'unsatisfiable') {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' },
      })
    }

    const headers: Record<string, string> = {
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Content-Length': String(range ? range.end - range.start + 1 : size),
    }
    if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`

    const file = createReadStream(target, range ?? undefined)
    // The stream opens lazily, so a file removed between the stat above and the
    // open — the picker DELETEs an upload the moment it is replaced — fails
    // asynchronously, after the status line is already committed. Without its
    // own listener that failure leaves no trace on the server at all.
    file.on('error', (e) => log.error(`read background name=${name}: ${e.message}`))
    return new Response(Readable.toWeb(file) as unknown as ReadableStream, { status: range ? 206 : 200, headers })
  })

  app.delete('/files/:name', async (c) => {
    const name = c.req.param('name')
    if (!isSafeName(name)) return c.json({ error: 'invalid filename' }, 400)
    const target = join(dir, name)
    if (!isInside(dir, target)) return c.json({ error: 'invalid filename' }, 400)
    try {
      await unlink(target)
      log.info(`delete background name=${name}`)
      return c.json({ ok: true })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return c.json({ error: 'not found' }, 404)
      log.error(`delete background name=${name}: ${(e as Error).message}`)
      return c.json({ error: (e as Error).message }, 500)
    }
  })

  return app
}
