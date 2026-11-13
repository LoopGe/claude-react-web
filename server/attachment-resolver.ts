import { createReadStream, promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve as resolvePath, sep } from 'node:path'
import type { ProviderContentBlock, ProviderInputContentBlock, ResolvedFileAttachment } from './agent-message.js'
import { HttpError } from './errors.js'
import { attachmentRoot } from './attachment-paths.js'
import { canReferenceUpload } from './upload-policy.js'
import { uploadEntryPathContained } from './upload-path.js'
import { UPLOAD_SUBDIR, type UploadEntry, type UploadStore } from './upload-store.js'
import { isFileBlock } from '../shared/attachments.js'

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const PDF_MAGIC = Buffer.from('%PDF-', 'ascii')

export interface ResolveAttachmentOptions {
  sessionId: string
  signal: AbortSignal
  uploadStore: UploadStore
  stateDir: string
}

function interrupted(): HttpError {
  return new HttpError(409, 'attachment resolution was interrupted')
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw interrupted()
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

async function realFileInUploadRoot(entry: UploadEntry, stateDir: string): Promise<string> {
  if (!uploadEntryPathContained(entry, stateDir)) {
    throw new HttpError(400, 'upload path is not allowed')
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
  const roots = await approvedRealRoots(entry, stateDir)
  if (!roots.some((root) => isInside(root, realPath))) {
    throw new HttpError(400, 'upload path is not allowed')
  }
  const stat = await fs.stat(realPath)
  if (!stat.isFile()) {
    throw new HttpError(400, `uploaded file is not a regular file: ${entry.name}`)
  }
  return realPath
}

async function hashEntry(
  entry: UploadEntry,
  realPath: string,
  signal: AbortSignal,
): Promise<{ digest: string; size: number; mediaType?: string }> {
  throwIfAborted(signal)
  const hash = createHash('sha256')
  const header = Buffer.alloc(PDF_MAGIC.length)
  let headerSize = 0
  let size = 0
  const stream = createReadStream(realPath, { highWaterMark: 1 << 16, signal })
  const abort = () => stream.destroy(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  try {
    for await (const chunk of stream) {
      throwIfAborted(signal)
      const bytes = chunk as Buffer
      size += bytes.length
      hash.update(bytes)
      if (headerSize < PDF_MAGIC.length) {
        const copied = bytes.subarray(0, PDF_MAGIC.length - headerSize)
        copied.copy(header, headerSize)
        headerSize += copied.length
      }
    }
  } catch (err) {
    throwIfAborted(signal)
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new HttpError(400, `uploaded file is missing: ${entry.name}`)
    }
    throw err
  } finally {
    signal.removeEventListener('abort', abort)
  }
  throwIfAborted(signal)
  return {
    digest: hash.digest('hex'),
    size,
    ...(headerSize === PDF_MAGIC.length && header.equals(PDF_MAGIC)
      ? { mediaType: 'application/pdf' }
      : {}),
  }
}

async function resolveEntry(
  entry: UploadEntry,
  stateDir: string,
  signal: AbortSignal,
): Promise<ResolvedFileAttachment> {
  if (entry.digest !== undefined && !SHA256_PATTERN.test(entry.digest)) {
    throw new HttpError(400, `upload digest is invalid: ${entry.name}`)
  }
  const realPath = await realFileInUploadRoot(entry, stateDir)
  const actual = await hashEntry(entry, realPath, signal)
  if (entry.size !== actual.size) {
    throw new HttpError(400, `upload size does not match its registry entry: ${entry.name}`)
  }
  if (entry.digest !== undefined && entry.digest !== actual.digest) {
    throw new HttpError(400, `upload digest does not match its registry entry: ${entry.name}`)
  }
  return {
    id: entry.id,
    name: entry.name,
    size: actual.size,
    digest: actual.digest,
    path: entry.path,
    ...(actual.mediaType === undefined ? {} : { mediaType: actual.mediaType }),
  }
}

/** Resolve and verify every file occurrence before a provider sees the turn.
 *  Duplicate registry id/path pairs share one streamed verification, but each
 *  input position retains its own resolved occurrence. */
export async function resolveAttachmentContent(
  content: readonly ProviderInputContentBlock[],
  opts: ResolveAttachmentOptions,
): Promise<ProviderContentBlock[]> {
  const unique = new Map<string, Promise<ResolvedFileAttachment>>()
  const resolved: ProviderContentBlock[] = []
  for (const block of content) {
    if (!isFileBlock(block)) {
      resolved.push(block)
      continue
    }
    throwIfAborted(opts.signal)
    const entry = opts.uploadStore.getById(block.attachment.id)
    if (entry === undefined) {
      throw new HttpError(400, `unknown upload: ${block.attachment.id}`)
    }
    if (!canReferenceUpload(entry, opts.sessionId)) {
      throw new HttpError(400, `upload does not belong to session ${opts.sessionId}`)
    }
    const key = `${entry.id}\0${entry.path}`
    let pending = unique.get(key)
    if (pending === undefined) {
      pending = resolveEntry(entry, opts.stateDir, opts.signal).then((attachment) => {
        if (entry.digest === undefined) {
          opts.uploadStore.record([{ ...entry, digest: attachment.digest }])
        }
        return attachment
      })
      unique.set(key, pending)
    }
    const attachment = await pending
    resolved.push({ type: 'file', attachment: { ...attachment } })
  }
  return resolved
}

/** Strip server-only attachment fields for the public history ring. */
export function publicAttachmentContent(
  content: readonly ProviderContentBlock[],
): ProviderInputContentBlock[] {
  return content.map((block) => block.type === 'file'
    ? {
        type: 'file' as const,
        attachment: {
          id: block.attachment.id,
          name: block.attachment.name,
          size: block.attachment.size,
          digest: block.attachment.digest,
        },
      }
    : block)
}
