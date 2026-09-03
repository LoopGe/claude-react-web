// Global background-image upload routes. Unlike session uploads (which land
// in the session's cwd, server/routes/uploads.ts), a background is a global
// appearance file stored under <stateDir>/backgrounds/ and served back as a
// same-origin URL. Filenames are server-assigned <uuid>.<ext> — user-supplied
// names are never trusted. Every read/delete is containment-checked.

import { Hono } from 'hono'
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises'
import { resolve, join, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { config as serverConfig } from './config.js'
import { createLogger } from './log.js'

const log = createLogger('background')

/** Acceptable upload content types → file extension. */
const ALLOWED_UPLOAD: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
}

/** Served extension (lowercase, no dot) → Content-Type for GET. */
const EXT_TYPE: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

/** Server-assigned names only: a uuid + a raster extension. */
function isSafeName(name: string): boolean {
  return name.length > 0 && name.length <= 80 && /^[0-9a-f-]+\.(jpg|jpeg|png|webp)$/i.test(name)
}

function isInside(base: string, target: string): boolean {
  const b = resolve(base)
  const t = resolve(target)
  return t === b || t.startsWith(b.endsWith(sep) ? b : b + sep)
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

    const ext = ALLOWED_UPLOAD[file.type]
    if (!ext) return c.json({ error: `unsupported image type '${file.type}'` }, 400)
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
    try {
      const data = await readFile(target)
      return new Response(new Uint8Array(data), {
        headers: { 'Content-Type': EXT_TYPE[ext] ?? 'application/octet-stream', 'Cache-Control': 'no-store' },
      })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return c.json({ error: 'not found' }, 404)
      log.error(`read background name=${name}: ${(e as Error).message}`)
      return c.json({ error: (e as Error).message }, 500)
    }
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
