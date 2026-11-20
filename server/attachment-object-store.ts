// Content-addressed attachment store.
//
// Bytes are written once to `objects/<sha256>` and published under read-only
// hard-link aliases at `files/<sha256>/<name>`. Publication is crash-safe:
// streams stage into `tmp/`, are fsynced, hard-linked into the object tree,
// and only then exposed through an alias; directory entries are fsynced
// after the links land (skipped on Windows, where directories cannot be
// opened for fsync). Reads verify length + sha256 so tampered or truncated
// bytes fail closed instead of being served.

import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream, promises as fs } from 'node:fs'
import { dirname, join, parse, resolve as resolvePath } from 'node:path'
import {
  aliasPathOf,
  attachmentRoot,
  imageMetaPathOf,
  imageObjectPathOf,
  isInsideAttachmentRoot,
  objectPathOf,
  sanitizeStoredName,
} from './attachment-paths.js'
import { writeAtomicDurable } from './json-file-store.js'
import { AttachmentStoreError } from '../shared/attachment-store-error.js'
import type { VerifyFileInput } from '../shared/attachment-store-error.js'
import type { SupportedImageMediaType } from '../shared/image-media.js'

// The error class/codes and verified-read input live in
// shared/attachment-store-error.ts (neutral, host-free); this module
// re-exports them so host consumers can keep importing from here. The class
// has a single definition, so native instanceof checks match the errors
// thrown here.
export { AttachmentStoreError } from '../shared/attachment-store-error.js'
export type { AttachmentStoreErrorCode, VerifyFileInput } from '../shared/attachment-store-error.js'

/** A digest is a bare lowercase sha256 — the object file name and the first
 *  path segment of every alias. Anything else could escape the store root. */
const DIGEST_PATTERN = /^[a-f0-9]{64}$/

/** State dirs whose ancestor chain this process has already fsynced. The
 *  proof is per process, so a directory another process created but has not
 *  synced is never mistaken for a durable boundary. */
const durableHomes = new Set<string>()

export interface PublishStreamInput {
  /** Raw upload bytes, consumed chunk by chunk — never buffered whole. */
  chunks: AsyncIterable<Uint8Array>
  /** Client-supplied filename; sanitized before it becomes the alias leaf. */
  name?: string
  maxBytes: number
  signal?: AbortSignal
}

export interface PublishedAttachment {
  digest: string
  objectPath: string
  aliasPath: string
  /** The sanitized leaf name actually used for the alias. */
  name: string
  size: number
}

/** Caller-supplied image facts. The byte length is measured from the bytes,
 *  not trusted from the caller, so it is not part of this input. */
export interface ImageMeta {
  mediaType: SupportedImageMediaType
  width: number
  height: number
}

/** The meta sidecar content: `ImageMeta` plus the stored byte length. */
export interface StoredImageMeta extends ImageMeta {
  bytes: number
}

export interface PublishedImage {
  digest: string
  objectPath: string
  /** Stored byte length — the `bytes` field of an ImageAttachmentRef. */
  bytes: number
}

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class AttachmentObjectStore {
  private readonly stateDir: string
  private readonly root: string

  constructor(stateDir: string) {
    this.stateDir = resolvePath(stateDir)
    this.root = attachmentRoot(this.stateDir)
  }

  /** Consume `chunks`, publish one object for the bytes, and link the
   *  sanitized name as a read-only alias. Equal bytes always resolve to the
   *  same object; publishing the same name twice reuses the first alias. */
  async publishStream(input: PublishStreamInput): Promise<PublishedAttachment> {
    const { chunks, maxBytes, signal } = input
    const name = sanitizeStoredName(input.name)
    const { digest, objectPath, size, boundary, createdObject } =
      await this.publishObjectCore(chunks, maxBytes, signal, (d) => objectPathOf(this.root, d))

    let aliasPath: string | undefined
    let createdAlias = false
    try {
      aliasPath = aliasPathOf(this.root, digest, name)
      await this.ensureDurableDirectory(dirname(aliasPath), boundary)
      try {
        await fs.link(objectPath, aliasPath)
        createdAlias = true
      } catch (err) {
        if (errorCode(err) !== 'EEXIST') throw err
        await this.verifyFile({ path: aliasPath, digest, size, signal })
      }
      await fs.chmod(aliasPath, 0o400)

      await this.syncDirectories([objectPath, aliasPath])
      return { digest, objectPath, aliasPath, name, size }
    } catch (err) {
      // Best-effort cleanup of links this call landed: a failed publication
      // must not leave an orphan alias or object behind. Only entries this
      // call created are removed (an EEXIST hit is somebody else's file), and
      // cleanup errors are swallowed — the original failure is what the
      // caller needs to see.
      if (createdAlias && aliasPath !== undefined) await fs.unlink(aliasPath).catch(() => {})
      if (createdObject) await fs.unlink(objectPath).catch(() => {})
      if (err instanceof AttachmentStoreError) throw err
      throw new AttachmentStoreError('write-failed', `failed to publish attachment: ${errorMessage(err)}`, { cause: err })
    }
  }

  /** Publish one content-addressed image object (no filename alias) plus its
   *  meta sidecar. Equal bytes dedupe to one object and one digest; the sidecar
   *  records the measured byte length alongside the caller's image facts. */
  async publishImage(bytes: Uint8Array, meta: ImageMeta): Promise<PublishedImage> {
    const { digest, objectPath, size } = await this.publishObjectCore(
      (async function* () { yield bytes })(),
      bytes.byteLength,
      undefined,
      (d) => imageObjectPathOf(this.root, d),
    )
    const metaPath = imageMetaPathOf(this.root, digest)
    const stored: StoredImageMeta = { mediaType: meta.mediaType, bytes: size, width: meta.width, height: meta.height }
    try {
      // Durable atomic sidecar write (tmp + fsync + rename), reusing the
      // shared JSON-sidecar primitive rather than re-implementing it.
      await writeAtomicDurable(dirname(metaPath), metaPath, stored)
      await this.syncDirectories([objectPath])
      return { digest, objectPath, bytes: size }
    } catch (err) {
      if (err instanceof AttachmentStoreError) throw err
      throw new AttachmentStoreError('write-failed', `failed to publish image: ${errorMessage(err)}`, { cause: err })
    }
  }

  /** Read one stored image, verifying length + sha256 against the sidecar's
   *  recorded byte length. Throws `missing` when the object or sidecar is
   *  absent and `corrupt` when the bytes or sidecar fail integrity. */
  async readVerifiedImage(digest: string): Promise<{ bytes: Uint8Array; meta: StoredImageMeta }> {
    if (!DIGEST_PATTERN.test(digest)) {
      throw new Error(`invalid attachment digest: ${digest}`)
    }
    const objectPath = imageObjectPathOf(this.root, digest)
    const metaPath = imageMetaPathOf(this.root, digest)
    const raw = await fs.readFile(metaPath, 'utf8').catch((err) => {
      if (errorCode(err) === 'ENOENT') {
        throw new AttachmentStoreError('missing', `image not found: ${metaPath}`, { cause: err })
      }
      throw err
    })
    let meta: StoredImageMeta
    try {
      meta = JSON.parse(raw) as StoredImageMeta
    } catch (err) {
      throw new AttachmentStoreError('corrupt', `image meta failed integrity verification: ${metaPath}`, { cause: err })
    }
    const out: Uint8Array[] = []
    for await (const chunk of this.readVerified({ path: objectPath, digest, size: meta.bytes })) out.push(chunk)
    return { bytes: Buffer.concat(out), meta }
  }

  /** Stage `chunks` into `tmp/`, hash + fsync, hard-link into the object tree
   *  at `objectPathFor(digest)`, and mark the object read-only. Shared by file
   *  and image publication; the caller adds any alias/sidecar and final dir
   *  syncs. On failure, removes the staged temp and any object this call
   *  created (an EEXIST dedupe hit is somebody else's file and is left alone). */
  private async publishObjectCore(
    chunks: AsyncIterable<Uint8Array>,
    maxBytes: number,
    signal: AbortSignal | undefined,
    objectPathFor: (digest: string) => string,
  ): Promise<{ digest: string; objectPath: string; size: number; boundary: string; createdObject: boolean }> {
    const tmpPath = join(this.root, 'tmp', randomUUID())
    let objectPath: string | undefined
    let createdObject = false
    try {
      const boundary = await this.ensureDurableHome()
      await this.ensureDurableDirectory(join(this.root, 'tmp'), boundary)
      const { digest, size } = await this.writeTempFile(tmpPath, chunks, maxBytes, signal)

      objectPath = objectPathFor(digest)
      await this.ensureDurableDirectory(dirname(objectPath), boundary)
      try {
        await fs.link(tmpPath, objectPath)
        createdObject = true
      } catch (err) {
        if (errorCode(err) !== 'EEXIST') throw err
        // A concurrent publication won the race; the stored object must be
        // exactly the bytes we just hashed.
        await this.verifyFile({ path: objectPath, digest, size, signal })
      }
      // Unlink before any chmod: Windows shares the read-only attribute
      // across hard links, so once the object is read-only the staged temp
      // name could no longer be removed.
      await fs.unlink(tmpPath)

      await fs.chmod(objectPath, 0o400)
      return { digest, objectPath, size, boundary, createdObject }
    } catch (err) {
      await fs.unlink(tmpPath).catch(() => {})
      if (createdObject && objectPath !== undefined) await fs.unlink(objectPath).catch(() => {})
      if (err instanceof AttachmentStoreError) throw err
      throw new AttachmentStoreError('write-failed', `failed to publish attachment: ${errorMessage(err)}`, { cause: err })
    }
  }

  /** Drain a verified read; resolves only when the whole file matches. */
  async verifyFile(input: VerifyFileInput): Promise<void> {
    for await (const chunk of this.readVerified(input)) void chunk
  }

  /** Stream `path` while hashing; throws `missing` when it cannot be opened
   *  and `corrupt` after the last chunk if length or digest disagree. */
  async *readVerified(input: VerifyFileInput): AsyncIterable<Uint8Array> {
    const { path, digest, size, signal } = input
    const hash = createHash('sha256')
    let seen = 0
    try {
      for await (const chunk of createReadStream(path, { highWaterMark: 1 << 16, signal })) {
        const bytes: Buffer = chunk
        seen += bytes.byteLength
        hash.update(bytes)
        yield bytes
      }
    } catch (err) {
      if (errorCode(err) === 'ENOENT') {
        throw new AttachmentStoreError('missing', `attachment not found: ${path}`, { cause: err })
      }
      throw err
    }
    if (seen !== size || hash.digest('hex') !== digest) {
      throw new AttachmentStoreError('corrupt', `attachment failed integrity verification: ${path}`)
    }
  }

  /** Remove one published name. Missing files are a no-op. Store-internal:
   *  `path` is an alias this store published, so it must resolve inside the
   *  store root — a hand-edited registry path must never reach `unlink`. */
  async removeAlias(path: string): Promise<void> {
    if (!isInsideAttachmentRoot(this.root, path)) {
      throw new Error(`refusing to remove an alias outside the attachment store root: ${path}`)
    }
    await this.unlinkIfExists(path)
  }

  /** Remove a stored object by digest. Missing files are a no-op; callers
   *  must ensure no alias still references it. Store-internal: the digest
   *  must be a bare lowercase sha256 so it cannot escape the store root. */
  async removeObject(digest: string): Promise<void> {
    if (!DIGEST_PATTERN.test(digest)) {
      throw new Error(`invalid attachment digest: ${digest}`)
    }
    await this.unlinkIfExists(objectPathOf(this.root, digest))
  }

  private async writeTempFile(
    path: string,
    chunks: AsyncIterable<Uint8Array>,
    maxBytes: number,
    signal: AbortSignal | undefined,
  ): Promise<{ digest: string; size: number }> {
    const hash = createHash('sha256')
    let size = 0
    const handle = await fs.open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    try {
      for await (const chunk of chunks) {
        signal?.throwIfAborted()
        const nextSize = size + chunk.byteLength
        if (nextSize > maxBytes) {
          throw new AttachmentStoreError('too-large', `attachment exceeds ${maxBytes} bytes`)
        }
        size = nextSize
        hash.update(chunk)
        await handle.writeFile(chunk)
      }
      await handle.sync()
    } finally {
      await handle.close()
    }
    return { digest: hash.digest('hex'), size }
  }

  private async ensureDirectory(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true })
  }

  /** Establish this process's proof that the state dir and every ancestor
   *  below the filesystem root are durable. Mere existence is insufficient: a
   *  concurrent process may have created the directory but not synced its
   *  parent. */
  private async ensureDurableHome(): Promise<string> {
    if (!durableHomes.has(this.stateDir)) {
      await this.ensureDurableDirectory(this.stateDir, parse(this.stateDir).root)
      durableHomes.add(this.stateDir)
    }
    return this.stateDir
  }

  /** Create `path` and fsync every parent entry up to (excluding) `boundary`.
   *  The walk ignores what mkdir reports as newly created: a concurrent first
   *  save can create a level this process then merely observes, so "already
   *  existed" is not "already durable". Re-syncing a durable entry is
   *  harmless; skipping an unsynced one is not. */
  private async ensureDurableDirectory(path: string, boundary: string): Promise<void> {
    const target = resolvePath(path)
    const stop = resolvePath(boundary)
    await this.ensureDirectory(target)
    let level = target
    while (level !== stop) {
      const parent = dirname(level)
      await this.syncDirectory(parent)
      if (parent === level) return
      level = parent
    }
  }

  /** fsync every directory entry the publication added, from the object /
   *  alias parent up to (excluding) the store root. Windows cannot open a
   *  directory for fsync, so durability there is the filesystem's. */
  private async syncDirectories(paths: string[]): Promise<void> {
    if (process.platform === 'win32') return
    const dirs = new Set<string>()
    for (const path of paths) {
      let dir = dirname(path)
      while (dir !== this.root) {
        dirs.add(dir)
        const parent = dirname(dir)
        if (parent === dir) break
        dir = parent
      }
    }
    for (const dir of dirs) await this.syncDirectory(dir)
  }

  private async syncDirectory(dir: string): Promise<void> {
    // Windows opens a directory handle but refuses fsync on it (EPERM);
    // NTFS metadata journaling owns entry durability there.
    if (process.platform === 'win32') return
    const handle = await fs.open(dir, constants.O_RDONLY)
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  private async unlinkIfExists(path: string): Promise<void> {
    try {
      await fs.unlink(path)
    } catch (err) {
      if (errorCode(err) !== 'ENOENT') throw err
    }
  }
}
