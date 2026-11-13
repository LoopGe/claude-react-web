import { promises as fs } from 'node:fs'
import { isAbsolute, relative, resolve as resolvePath, sep } from 'node:path'
import type { ResolvedFileAttachment } from './agent-message.js'
import { attachmentRoot } from './attachment-paths.js'
import { HttpError } from './errors.js'
import { uploadEntryPathContained } from './upload-path.js'
import { UPLOAD_SUBDIR, type UploadEntry, type UploadStore } from './upload-store.js'

export interface AttachmentAccessOptions {
  uploadStore: UploadStore
  stateDir: string
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

async function approvedRealRoots(entry: UploadEntry, stateDir: string): Promise<string[]> {
  const candidates = [
    resolvePath(entry.cwd, UPLOAD_SUBDIR),
    resolvePath(stateDir, UPLOAD_SUBDIR),
    attachmentRoot(stateDir),
  ]
  const roots: string[] = []
  for (const candidate of candidates) {
    try {
      roots.push(await fs.realpath(candidate))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw err
    }
  }
  return roots
}

function metadataMatches(occurrence: ResolvedFileAttachment, entry: UploadEntry): boolean {
  return entry.id === occurrence.id
    && entry.name === occurrence.name
    && entry.size === occurrence.size
    && entry.digest === occurrence.digest
    && resolvePath(entry.path) === resolvePath(occurrence.path)
}

/** Authorize a persisted occurrence against the CURRENT registry entry. The
 * occurrence's path is evidence to compare, never a path to read: all disk
 * operations use the registry's path and must remain inside an approved root. */
export async function resolveAuthorizedAttachment(
  occurrence: ResolvedFileAttachment,
  opts: AttachmentAccessOptions,
): Promise<ResolvedFileAttachment> {
  const entry = opts.uploadStore.getById(occurrence.id)
  if (!entry) throw new HttpError(400, `unknown upload: ${occurrence.id}`)
  if (!metadataMatches(occurrence, entry)) {
    throw new HttpError(400, `attachment does not match its registry entry: ${occurrence.id}`)
  }
  if (!uploadEntryPathContained(entry, opts.stateDir)) {
    throw new HttpError(400, `upload path is not allowed: ${occurrence.id}`)
  }

  let realPath: string
  try {
    realPath = await fs.realpath(entry.path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new HttpError(400, `uploaded file is missing: ${entry.name}`)
    }
    throw err
  }
  const roots = await approvedRealRoots(entry, opts.stateDir)
  if (!roots.some((root) => isInside(root, realPath))) {
    throw new HttpError(400, `upload path is not allowed: ${occurrence.id}`)
  }
  const stat = await fs.stat(realPath)
  if (!stat.isFile()) {
    throw new HttpError(400, `uploaded file is not a regular file: ${entry.name}`)
  }

  return {
    id: entry.id,
    name: entry.name,
    size: entry.size,
    digest: occurrence.digest,
    path: entry.path,
    ...(occurrence.mediaType === undefined ? {} : { mediaType: occurrence.mediaType }),
  }
}
