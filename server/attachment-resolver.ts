import { createReadStream, promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve as resolvePath, sep } from 'node:path'
import type { ProviderContentBlock, ProviderInputContentBlock, ResolvedFileAttachment } from './agent-message.js'
import { HttpError } from './errors.js'
import { attachmentRoot, imageObjectPathOf } from './attachment-paths.js'
import { canReferenceUpload } from './upload-policy.js'
import { uploadEntryPathContained } from './upload-path.js'
import { UPLOAD_SUBDIR, type UploadEntry, type UploadStore } from './upload-store.js'
import { isFileBlock } from '../shared/attachments.js'
import { digestOfImageRef, isImageRefBlock, type ImageAttachmentRef, type ImageRefBlock } from '../shared/image-attachment.js'
import { AttachmentObjectStore, AttachmentStoreError, type StoredImageMeta } from './attachment-object-store.js'

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

/** One verified image occurrence: the public ref plus the verified base64
 *  payload and the read-only host path of the stored object. Provider-neutral
 *  like ResolvedFileBlock — it travels only in the provider payload and the
 *  in-memory dispatch op, never in the ring/broadcast/seq/sidecar (those keep
 *  the ImageRefBlock). The SDK copy is projected from it at dispatch. */
export interface ResolvedImageBlock {
  type: 'image'
  attachment: ImageAttachmentRef
  source: { type: 'base64'; data: string; media_type: string }
  path: string
}

/** Structural check for the resolved (provider-bound) image block, vs the
 *  public ImageRefBlock (no source/path) and the legacy base64 block (no
 *  attachment). */
export function isResolvedImageBlock(value: unknown): value is ResolvedImageBlock {
  if (!isImageRefBlock(value)) return false
  const block = value as { source?: unknown; path?: unknown }
  if (typeof block.path !== 'string') return false
  const source = block.source as { type?: unknown; data?: unknown; media_type?: unknown } | undefined
  return typeof source === 'object' && source !== null
    && source.type === 'base64'
    && typeof source.data === 'string'
    && typeof source.media_type === 'string'
}

export interface ResolveImageOptions {
  signal: AbortSignal
  stateDir: string
}

interface VerifiedImage {
  base64: string
  meta: StoredImageMeta
  path: string
}

/** Verified-read one stored image, fail-closed. `missing` (no object or meta
 *  sidecar) and `corrupt` (digest/length mismatch) both reject the send before
 *  any provider sees the turn; the status mirrors resolveEntry's verification
 *  failures (400 — the caller's ref is what failed to resolve). */
async function readVerifiedImageOccurrence(
  objects: AttachmentObjectStore,
  root: string,
  digest: string,
  refId: string,
  signal: AbortSignal,
): Promise<VerifiedImage> {
  throwIfAborted(signal)
  let stored: { bytes: Uint8Array; meta: StoredImageMeta }
  try {
    stored = await objects.readVerifiedImage(digest)
  } catch (err) {
    if (err instanceof AttachmentStoreError && err.code === 'missing') {
      throw new HttpError(400, `image not found: ${refId}`)
    }
    if (err instanceof AttachmentStoreError && err.code === 'corrupt') {
      throw new HttpError(400, `image failed integrity verification: ${refId}`)
    }
    throw err
  }
  throwIfAborted(signal)
  return {
    base64: Buffer.from(stored.bytes).toString('base64'),
    meta: stored.meta,
    path: imageObjectPathOf(root, digest),
  }
}

/** Resolve and verify every image ref occurrence before a provider sees the
 *  turn (the image analogue of resolveAttachmentContent). Non-image blocks
 *  pass through untouched. Duplicate digests share one verified read, but each
 *  input position retains its own resolved occurrence, and every occurrence's
 *  declared facts are checked against the stored meta. Image refs are global
 *  to the authenticated server (no upload registry / ownership check — the
 *  same authorization model as the image content route). */
export async function resolveImageBlocks<T extends ProviderContentBlock>(
  content: readonly (T | ImageRefBlock)[],
  opts: ResolveImageOptions,
): Promise<(T | ResolvedImageBlock)[]> {
  const objects = new AttachmentObjectStore(opts.stateDir)
  const root = attachmentRoot(opts.stateDir)
  const unique = new Map<string, Promise<VerifiedImage>>()
  const resolved: (T | ResolvedImageBlock)[] = []
  for (const block of content) {
    if (!isImageRefBlock(block)) {
      resolved.push(block)
      continue
    }
    throwIfAborted(opts.signal)
    const ref = block.attachment
    // isImageRefBlock already proved the id shape; the assertion only narrows.
    const digest = digestOfImageRef(ref.id)!
    let pending = unique.get(digest)
    if (pending === undefined) {
      pending = readVerifiedImageOccurrence(objects, root, digest, ref.id, opts.signal)
      unique.set(digest, pending)
    }
    const stored = await pending
    if (
      ref.bytes !== stored.meta.bytes
      || ref.mediaType !== stored.meta.mediaType
      || ref.width !== stored.meta.width
      || ref.height !== stored.meta.height
    ) {
      throw new HttpError(400, `image reference does not match the stored image: ${ref.id}`)
    }
    resolved.push({
      type: 'image',
      attachment: { ...ref },
      source: { type: 'base64', data: stored.base64, media_type: stored.meta.mediaType },
      path: stored.path,
    })
  }
  return resolved
}

/** Strip server-only attachment fields for the public history ring: resolved
 *  files lose their registry path, resolved images lose their base64 payload
 *  and host path (the public form is the durable ImageRefBlock). */
export function publicAttachmentContent(
  content: readonly (ProviderContentBlock | ResolvedImageBlock)[],
): (ProviderInputContentBlock | ImageRefBlock)[] {
  return content.map((block) => {
    if (block.type === 'file') {
      return {
        type: 'file' as const,
        attachment: {
          id: block.attachment.id,
          name: block.attachment.name,
          size: block.attachment.size,
          digest: block.attachment.digest,
        },
      }
    }
    if (isResolvedImageBlock(block)) {
      return { type: 'image' as const, attachment: { ...block.attachment } }
    }
    return block
  })
}
