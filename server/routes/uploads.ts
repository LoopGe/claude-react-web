// File upload routes: upload and delete per-session files.

import { Hono } from 'hono'
import { mkdir, writeFile, unlink } from 'node:fs/promises'
import { resolve as resolvePath } from 'node:path'
import { SessionManager } from '../session-manager.js'
import { config as serverConfig } from '../config.js'

/** Where per-session uploads land inside the session's cwd. Kept visible
 *  (not dot-prefixed) so users can see what the UI dropped in. */
const UPLOAD_SUBDIR = 'claude-web-uploads'

export function buildUploadRouter(sm: SessionManager): Hono {
  const app = new Hono()

  // Upload one or more files into the session's cwd.
  app.post('/sessions/:id/uploads', async (c) => {
    const id = c.req.param('id')
    const info = sm.get(id)
    if (!info.cwd) {
      return c.json({ error: 'session has no cwd; uploads require a working directory' }, 400)
    }
    const contentType = c.req.header('content-type') ?? ''
    if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
      return c.json({ error: 'expected multipart/form-data' }, 400)
    }

    const body = await c.req.parseBody({ all: true }).catch(() => null)
    if (!body) return c.json({ error: 'invalid multipart payload' }, 400)

    const files: File[] = []
    for (const v of Object.values(body)) {
      if (v instanceof File) files.push(v)
      else if (Array.isArray(v)) for (const x of v) if (x instanceof File) files.push(x)
    }
    if (files.length === 0) return c.json({ error: 'no files in request' }, 400)

    const uploadDir = resolvePath(info.cwd, UPLOAD_SUBDIR)
    await mkdir(uploadDir, { recursive: true })

    const now = Date.now()
    const saved: Array<{ path: string; name: string; size: number }> = []
    for (const f of files) {
      if (f.size > serverConfig.maxUploadBytes) {
        return c.json(
          { error: `file ${f.name} exceeds ${serverConfig.maxUploadBytes} bytes` },
          413 as 400 | 404 | 410 | 500,
        )
      }
      const rawName = f.name || 'upload'
      const baseName = rawName.split(/[\\/]/).pop() || 'upload'
      const safeName = baseName.replace(/[\0/\\]/g, '_').slice(0, 200) || 'upload'
      const destName = `${now}-${safeName}`
      const dest = resolvePath(uploadDir, destName)
      const buf = Buffer.from(await f.arrayBuffer())
      await writeFile(dest, buf)
      saved.push({ path: dest, name: safeName, size: f.size })
    }

    return c.json({ uploads: saved })
  })

  // Delete a previously uploaded file.
  app.delete('/sessions/:id/uploads/:filename', async (c) => {
    const id = c.req.param('id')
    const filename = c.req.param('filename')
    const info = sm.get(id)
    if (!info.cwd) {
      return c.json({ error: 'session has no cwd' }, 400)
    }
    const target = resolvePath(info.cwd, UPLOAD_SUBDIR, filename)
    const uploadDir = resolvePath(info.cwd, UPLOAD_SUBDIR)
    const targetNorm = target.replaceAll('\\', '/')
    const uploadDirNorm = uploadDir.replaceAll('\\', '/')
    if (!targetNorm.startsWith(uploadDirNorm + '/') && targetNorm !== uploadDirNorm) {
      return c.json({ error: 'invalid filename' }, 400)
    }
    try {
      await unlink(target)
      return c.json({ ok: true })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return c.json({ error: 'file not found' }, 404)
      }
      return c.json({ error: (e as Error).message }, 500)
    }
  })

  return app
}
