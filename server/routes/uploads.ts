// Upload routes: upload, delete, and (since the Uploads Manager) list
// uploaded files. Every UI upload is published into the content-addressed
// attachment store (`<stateDir>/claude-web-attachments/v1/`) and recorded in
// the UploadStore registry so the manager dialog can list/audit/delete it —
// including uploads whose session has since been deleted (orphans).

import { Hono } from 'hono'
import { unlink, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { resolve as resolvePath } from 'node:path'
import { randomUUID } from 'node:crypto'
import { SessionManager } from '../session-manager.js'
import { config as serverConfig } from '../config.js'
import { createLogger } from '../log.js'
import { UploadStore } from '../upload-store.js'
import { uploadEntryPathContained } from '../upload-path.js'
import { canReferenceUpload } from '../upload-policy.js'
import { attachmentRoot, isInsideAttachmentRoot, sameStoredPath } from '../attachment-paths.js'
import {
  AttachmentObjectStore,
  AttachmentStoreError,
  type PublishedAttachment,
} from '../attachment-object-store.js'
import { streamUploads, UploadError, type UploadFailure, type SavedUpload } from '../stream-upload.js'
import { uploadMimeType, type UploadEntry } from '../../shared/uploads.js'
import { safeJson } from './index.js'

const log = createLogger('uploads')

/** Files at or below this size are fully verified before the response starts,
 *  so a tampered file can still be answered with a proper 4xx/5xx. Larger
 *  files are streamed through the verified reader instead (never buffered). */
export const VERIFY_BEFORE_SERVE_MAX_BYTES = 8 * 1024 * 1024

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

/** Remove one registry entry, then the bytes behind it only when no OTHER
 *  entry still references them. The id is the registry key, so a
 *  `sha256:<digest>` reference resolves through `getById` to this entry's
 *  concrete id before removal. Aliases (`path`) and objects (`digest`) are
 *  shared whenever the same bytes were uploaded by more than one owner, so
 *  each is unlinked only after its last reference is gone. Paths compare
 *  through `sameStoredPath` — on a case-insensitive filesystem two spellings
 *  are one file, and the alias is shared. A legacy entry (`digest` undefined,
 *  or a digest backfilled onto a pre-v1 path) lives outside the store and is
 *  a plain unlink. Missing files are tolerated — an out-of-band delete leaves
 *  nothing to unlink. */
async function removeUploadEntry(
  store: UploadStore,
  objects: AttachmentObjectStore,
  entry: UploadEntry,
): Promise<void> {
  store.removeById(entry.id)
  const remaining = store.list()
  const aliasStillReferenced = remaining.some((e) => sameStoredPath(e.path, entry.path))

  if (entry.digest === undefined) {
    if (!aliasStillReferenced) await unlinkIfExists(entry.path)
    return
  }

  if (!aliasStillReferenced) {
    // Only a v1 publication has an alias under the store root; a backfilled
    // legacy entry keeps its recorded path, which `removeAlias` (store-only)
    // would refuse.
    if (isInsideAttachmentRoot(attachmentRoot(store.getDir()), entry.path)) {
      await objects.removeAlias(entry.path)
    } else {
      await unlinkIfExists(entry.path)
    }
  }
  if (!remaining.some((e) => e.digest === entry.digest)) await objects.removeObject(entry.digest)
}

/** Unlink a file, tolerating the already-gone case. */
async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
}

/** Undo publications from a batch that failed mid-stream, so a later part's
 *  failure cannot leave an alias or object no registry entry references.
 *  Reference checks mirror the delete routes; aliases/objects still held by
 *  an earlier upload stay put. */
async function rollbackPublished(
  objects: AttachmentObjectStore,
  store: UploadStore,
  published: readonly PublishedAttachment[],
): Promise<void> {
  const entries = store.list()
  for (const object of published) {
    if (!entries.some((entry) => sameStoredPath(entry.path, object.aliasPath))) {
      await objects.removeAlias(object.aliasPath)
    }
    if (!entries.some((entry) => entry.digest === object.digest)) {
      await objects.removeObject(object.digest)
    }
  }
}

/** Response headers for a recorded upload's content. RFC 6266: an ASCII
 *  fallback for old clients + RFC 5987 for the real (possibly non-ASCII)
 *  name. encodeURIComponent leaves the ' delimiter unescaped, which would
 *  end the ext-value early — encode it explicitly. */
function contentHeaders(entry: UploadEntry, download: boolean): Record<string, string> {
  const asciiName = entry.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  const encodedName = encodeURIComponent(entry.name).replace(/'/g, '%27')
  return {
    'Content-Type': uploadMimeType(entry.name),
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  }
}

/** The `UploadFailure` behind a rejected batch, or undefined when the
 *  rejection came from the object store (reported as a server error).
 *  `streamUploads` collapses every sink rejection into a generic parse
 *  failure, so the store's own error — captured on the sink's promise —
 *  decides. An over-limit part reaches the store as an `UploadError` while it
 *  consumes the part, which the store wraps as the cause of its write error. */
function uploadFailureOf(error: unknown, storeError: unknown): UploadFailure | undefined {
  if (storeError !== undefined) {
    return storeError instanceof AttachmentStoreError && storeError.cause instanceof UploadError
      ? storeError.cause.failure
      : undefined
  }
  return error instanceof UploadError ? error.failure : undefined
}

export function buildUploadRouter(
  sm: SessionManager,
  uploadStore?: UploadStore,
  objects?: AttachmentObjectStore,
): Hono {
  const app = new Hono()

  // ── Uploads Manager routes (only mounted when a store is wired) ──
  if (uploadStore) {
    const stateDir = uploadStore.getDir()
    const objectStore = objects ?? new AttachmentObjectStore(stateDir)

    // Upload one or more files into the content-addressed attachment store.
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

      const now = Date.now()
      const published: PublishedAttachment[] = []
      let storeError: unknown

      let files: SavedUpload[]
      try {
        files = await streamUploads({
          body: c.req.raw.body,
          contentType,
          maxFileBytes: serverConfig.maxUploadBytes,
          maxFiles: 20,
          sink: async ({ filename, mimeType, data }) => {
            let object: PublishedAttachment
            try {
              object = await objectStore.publishStream({
                chunks: data,
                name: filename,
                maxBytes: serverConfig.maxUploadBytes,
              })
            } catch (e) {
              storeError ??= e
              throw e
            }
            published.push(object)
            return {
              path: object.aliasPath,
              name: object.name,
              filename,
              mimeType,
              size: object.size,
              digest: object.digest,
            }
          },
        })
      } catch (e) {
        await rollbackPublished(objectStore, uploadStore, published)
        const failure = uploadFailureOf(e, storeError)
        // Neither an upload failure nor a store error: a programming error in
        // streamUploads, which must surface instead of becoming a 500 body.
        if (failure === undefined && storeError === undefined) throw e
        if (failure === undefined) {
          log.error(
            `upload store failure: ${storeError instanceof Error ? storeError.message : String(storeError)}`,
          )
          return c.json({ error: 'failed to store upload' }, 500)
        }
        if (failure.kind === 'too-large') {
          return c.json(
            { error: `file ${failure.filename} exceeds ${failure.limit} bytes` },
            413 as 400 | 404 | 410 | 500,
          )
        }
        return c.json({ error: 'invalid multipart payload' }, 400)
      }

      if (files.length === 0) return c.json({ error: 'no files in request' }, 400)

      // Dedupe by published alias: bytes and name identify the file on disk,
      // while the entry id stays per owner. A session re-uploading the same
      // file keeps its original id; a different session gets its own entry
      // (same alias, shared object). Paths compare through `sameStoredPath`
      // so a case-variant spelling on Windows/macOS is the same file. A
      // common upload (no session) is no one's to borrow: it only reuses a
      // common or ownerless entry, never a session-owned one.
      const entries = files.map((file): UploadEntry => {
        const existing = uploadStore
          .getByDigest(file.digest)
          .find(
            (entry) =>
              sameStoredPath(entry.path, file.path) &&
              (sessionId === undefined
                ? entry.origin === 'common' || entry.sessionId === undefined
                : canReferenceUpload(entry, sessionId)),
          )
        if (existing !== undefined) return existing
        const entry: UploadEntry = {
          id: randomUUID(),
          path: file.path,
          cwd: resolvePath(cwd),
          name: file.name,
          size: file.size,
          uploadedAt: now,
          sessionTitle,
          ...(origin ? { origin } : {}),
          ...(sessionId ? { sessionId } : {}),
          digest: file.digest,
        }
        uploadStore.record([entry])
        return entry
      })
      const saved = entries.map((e) => ({
        id: e.id,
        path: e.path,
        name: e.name,
        size: e.size,
        ...(e.digest === undefined ? {} : { digest: e.digest }),
      }))
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

    // Serve a recorded upload's content (manager dialog preview/download).
    // The id resolves through the registry — the client never supplies a
    // path — so the served path is whatever the upload routes recorded.
    app.get('/uploads/:id/content', async (c) => {
      const entry = uploadStore.getById(c.req.param('id'))
      if (!entry) {
        return c.json({ error: 'upload entry not found' }, 404)
      }
      if (!uploadEntryPathContained(entry, stateDir)) {
        return c.json({ error: 'invalid upload path' }, 400)
      }
      const download = c.req.query('download') === '1'
      const headers = contentHeaders(entry, download)

      // Legacy entry predating content addressing (digest not backfilled
      // yet): serve it as recorded. Existence check only — no Content-Length,
      // since a concurrent rewrite between this stat and the stream would
      // declare a length the body no longer matches. Chunked is always
      // correct.
      if (entry.digest === undefined) {
        try {
          await stat(entry.path)
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
            return c.json({ error: 'file missing' }, 404)
          }
          throw e
        }
        const body = Readable.toWeb(createReadStream(entry.path)) as ReadableStream<Uint8Array>
        return new Response(body, { headers })
      }

      const { digest } = entry

      // Small file: verify the whole file before sending anything, so a
      // tampered or missing object maps to a proper status instead of a
      // half-served body. Only once verification passes is Content-Length
      // declared — the length is a fact about the verified bytes.
      if (entry.size <= VERIFY_BEFORE_SERVE_MAX_BYTES) {
        try {
          await objectStore.verifyFile({ path: entry.path, digest, size: entry.size })
        } catch (err) {
          if (err instanceof AttachmentStoreError && err.code === 'missing') {
            return c.json({ error: 'file missing' }, 404)
          }
          if (err instanceof AttachmentStoreError && err.code === 'corrupt') {
            log.error(`integrity verification failed for ${entry.path}`)
            return c.json({ error: 'uploaded file failed integrity verification' }, 500)
          }
          throw err
        }
        const body = Readable.toWeb(createReadStream(entry.path)) as ReadableStream<Uint8Array>
        return new Response(body, {
          headers: { ...headers, 'Content-Length': String(entry.size) },
        })
      }

      // Large file: verifying first would mean buffering it whole. Hash
      // while streaming instead. The status line is already sent, so a
      // digest/length failure can no longer become a 4xx/5xx — it errors
      // the response body, aborting the transfer client-side before the
      // tampered bytes are trusted.
      const chunks = objectStore
        .readVerified({ path: entry.path, digest, size: entry.size })
        [Symbol.asyncIterator]()
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await chunks.next()
            if (next.done) controller.close()
            else controller.enqueue(next.value)
          } catch (err) {
            if (err instanceof AttachmentStoreError && err.code === 'corrupt') {
              log.error(`integrity verification failed for ${entry.path}`)
            }
            controller.error(err)
          }
        },
        // A client that disconnects mid-download must not leave the verified
        // reader (and its fs read stream) open.
        async cancel() {
          await chunks.return?.()
        },
      })
      return new Response(body, { headers })
    })

    // Delete every registry entry for a path key, unlinking the alias and
    // object only once no entry remains. Paths are shared when the same
    // published file was recorded under several ids, so dropping one entry
    // must not delete bytes another entry still serves.
    // REGISTERED BEFORE DELETE /uploads/:id so Hono matches it first.
    app.delete('/uploads/by-path', async (c) => {
      const body = await safeJson<{ path?: unknown }>(c.req)
      if (typeof body.path !== 'string') {
        return c.json({ error: 'path must be a string' }, 400)
      }
      const entries = uploadStore.list().filter((entry) => entry.path === body.path)
      if (entries.length === 0) {
        return c.json({ error: 'upload entry not found' }, 404)
      }
      if (entries.some((entry) => uploadStore.attachmentReferences.hasReference(entry.id))) {
        return c.json({ error: 'upload is referenced by a native session or an in-flight send' }, 409)
      }
      // Validate every entry before deleting anything, so a hand-edited
      // registry row can't half-apply the request.
      if (!entries.every((entry) => uploadEntryPathContained(entry, stateDir))) {
        return c.json({ error: 'invalid upload path' }, 400)
      }
      try {
        for (const entry of entries) {
          await removeUploadEntry(uploadStore, objectStore, entry)
        }
      } catch (e) {
        log.error(`delete upload by-path path=${body.path} error=${(e as Error).message}`)
        return c.json({ error: (e as Error).message }, 500)
      }
      log.info(`delete upload by-path path=${body.path}`)
      return c.json({ ok: true })
    })

    // Delete by registry id: validate the entry path lives inside the
    // entry's own upload dir, the shared upload dir, or the attachment
    // store, then drop the entry and any bytes no longer referenced.
    app.delete('/uploads/:id', async (c) => {
      const id = c.req.param('id')
      const entry = uploadStore.getById(id)
      if (!entry) {
        return c.json({ error: 'upload entry not found' }, 404)
      }
      if (uploadStore.attachmentReferences.hasReference(entry.id)) {
        return c.json({ error: 'upload is referenced by a native session or an in-flight send' }, 409)
      }
      // Validated against all three roots: the entry's own cwd upload dir,
      // the shared stateDir upload dir, and the attachment store.
      if (!uploadEntryPathContained(entry, stateDir)) {
        return c.json({ error: 'invalid upload path' }, 400)
      }
      try {
        await removeUploadEntry(uploadStore, objectStore, entry)
      } catch (e) {
        log.error(`delete upload id=${id} error=${(e as Error).message}`)
        return c.json({ error: (e as Error).message }, 500)
      }
      log.info(`delete upload id=${id}`)
      return c.json({ ok: true })
    })
  }

  return app
}
