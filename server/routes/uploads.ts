// Upload routes: upload, delete, and (since the Uploads Manager) list
// uploaded files. Every UI upload is recorded in the UploadStore registry
// so the manager dialog can list/audit/delete it — including uploads
// whose session has since been deleted (orphans). All uploads land in
// the shared `<stateDir>/claude-web-uploads/` directory.

import { Hono } from 'hono'
import { mkdir, unlink, stat } from 'node:fs/promises'
import { resolve as resolvePath, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { SessionManager } from '../session-manager.js'
import { config as serverConfig } from '../config.js'
import { createLogger } from '../log.js'
import { UploadStore, UPLOAD_SUBDIR } from '../upload-store.js'
import { streamUploads, UploadError, type SavedUpload } from '../stream-upload.js'
import { safeJson } from './index.js'

const log = createLogger('uploads')

/** Live on-disk existence check for a registry entry. Only a clean ENOENT
 *  reports missing — any other stat error reports present (and logs), so a
 *  transient FS hiccup never invites deleting a healthy file. */
async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false
    log.warn(`stat failed for ${path}: ${(e as Error).message}`)
    return true
  }
}

export function buildUploadRouter(sm: SessionManager, uploadStore?: UploadStore): Hono {
  const app = new Hono()

  // ── Uploads Manager routes (only mounted when a store is wired) ──
  if (uploadStore) {
    const stateDir = uploadStore.getDir()

    // Upload one or more files into the shared upload directory.
    app.post('/uploads', async (c) => {
      const sessionId = c.req.query('sessionId')
      let cwd: string
      let sessionTitle: string
      let origin: 'common' | undefined

      if (sessionId) {
        const info = sm.get(sessionId) // throws HttpError(404) for unknown ids
        cwd = info.cwd ? resolvePath(info.cwd) : stateDir
        sessionTitle = info.title ?? ''
        // no origin field for session uploads
      } else {
        cwd = stateDir
        sessionTitle = ''
        origin = 'common'
      }

      const contentType = c.req.header('content-type') ?? ''
      if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
        return c.json({ error: 'expected multipart/form-data' }, 400)
      }
      if (!c.req.raw.body) return c.json({ error: 'no files in request' }, 400)

      const uploadDir = resolvePath(stateDir, UPLOAD_SUBDIR)
      await mkdir(uploadDir, { recursive: true })
      const now = Date.now()

      let files: SavedUpload[]
      try {
        files = await streamUploads({
          body: c.req.raw.body,
          contentType,
          maxFileBytes: serverConfig.maxUploadBytes,
          maxFiles: 20,
          place: ({ filename, index }) => {
            const baseName = filename.split(/[\\/]/).pop() || 'upload'
            const safeName = baseName.replace(/[\0/\\]/g, '_').slice(0, 200) || 'upload'
            const destName = `${now}-${safeName}`
            return { tmp: join(uploadDir, `${destName}.${index}.part`), final: join(uploadDir, destName), name: safeName }
          },
        })
      } catch (e) {
        if (!(e instanceof UploadError)) throw e
        const f = e.failure
        if (f.kind === 'too-large') {
          return c.json(
            { error: `file ${f.filename} exceeds ${f.limit} bytes` },
            413 as 400 | 404 | 410 | 500,
          )
        }
        return c.json({ error: 'invalid multipart payload' }, 400)
      }

      if (files.length === 0) return c.json({ error: 'no files in request' }, 400)

      const saved = files.map((f) => ({ path: f.path, name: f.name, size: f.size }))
      try {
        uploadStore.record(
          files.map((f) => ({
            id: randomUUID(),
            path: f.path,
            cwd: resolvePath(cwd),
            name: f.name,
            size: f.size,
            uploadedAt: now,
            sessionTitle,
            ...(origin ? { origin } : {}),
          })),
        )
      } catch (e) {
        log.warn(`upload registry record failed: ${(e as Error).message}`)
      }
      log.info(`upload session=${sessionId ?? 'common'} files=${saved.length} totalBytes=${saved.reduce((s, f) => s + f.size, 0)}`)
      return c.json({ uploads: saved })
    })

    // List every recorded upload with a live exists flag.
    app.get('/uploads', async (c) => {
      const uploads = await Promise.all(
        uploadStore.list().map(async (u) => ({ ...u, exists: await fileExists(u.path) })),
      )
      return c.json({ uploads })
    })

    // Delete by path key — unlinks the file and drops the entry.
    // REGISTERED BEFORE DELETE /uploads/:id so Hono matches it first.
    app.delete('/uploads/by-path', async (c) => {
      const body = await safeJson<{ path?: unknown }>(c.req)
      if (typeof body.path !== 'string') {
        return c.json({ error: 'path must be a string' }, 400)
      }
      const entry = uploadStore.getByPath(body.path)
      if (!entry) {
        return c.json({ error: 'upload entry not found' }, 404)
      }
      try {
        await unlink(entry.path)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
          log.error(`delete upload by-path path=${entry.path} error=${(e as Error).message}`)
          return c.json({ error: (e as Error).message }, 500)
        }
        // ENOENT tolerated — file already gone, just drop the entry.
      }
      uploadStore.removeByPath(body.path)
      log.info(`delete upload by-path path=${body.path}`)
      return c.json({ ok: true })
    })

    // Delete by registry id: validate the entry path lives inside the
    // entry's own upload dir OR the shared upload dir, unlink (unless
    // already gone), drop the entry.
    app.delete('/uploads/:id', async (c) => {
      const id = c.req.param('id')
      const entry = uploadStore.getById(id)
      if (!entry) {
        return c.json({ error: 'upload entry not found' }, 404)
      }
      // Dual-branch validation: path must be under the entry's cwd upload dir
      // OR under the shared stateDir upload dir.
      const entryUploadDir = resolvePath(entry.cwd, UPLOAD_SUBDIR)
      const sharedUploadDir = resolvePath(stateDir, UPLOAD_SUBDIR)
      const target = resolvePath(entry.path)
      const targetNorm = target.replaceAll('\\', '/')
      const entryUploadDirNorm = entryUploadDir.replaceAll('\\', '/')
      const sharedUploadDirNorm = sharedUploadDir.replaceAll('\\', '/')
      if (
        !targetNorm.startsWith(entryUploadDirNorm + '/') &&
        !targetNorm.startsWith(sharedUploadDirNorm + '/')
      ) {
        return c.json({ error: 'invalid upload path' }, 400)
      }
      try {
        await unlink(target)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
          log.error(`delete upload id=${id} error=${(e as Error).message}`)
          return c.json({ error: (e as Error).message }, 500)
        }
        // Already gone (out-of-band deletion) — just drop the entry.
      }
      uploadStore.removeById(id)
      log.info(`delete upload id=${id}`)
      return c.json({ ok: true })
    })
  }

  return app
}
