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
  isInsideAttachmentRoot,
  objectPathOf,
  sanitizeStoredName,
} from './attachment-paths.js'

export type AttachmentStoreErrorCode = 'too-large' | 'write-failed' | 'corrupt' | 'missing'

/** A digest is a bare lowercase sha256 — the object file name and the first
 *  path segment of every alias. Anything else could escape the store root. */
const DIGEST_PATTERN = /^[a-f0-9]{64}$/

/** State dirs whose ancestor chain this process has already fsynced. The
 *  proof is per process, so a directory another process created but has not
 *  synced is never mistaken for a durable boundary. */
const durableHomes = new Set<string>()

export class AttachmentStoreError extends Error {
  constructor(
    readonly code: AttachmentStoreErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'AttachmentStoreError'
  }
}

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

export interface VerifyFileInput {
  path: string
  digest: string
  size: number
  signal?: AbortSignal
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
    const tmpPath = join(this.root, 'tmp', randomUUID())
    let objectPath: string | undefined
    let aliasPath: string | undefined
    let createdObject = false
    let createdAlias = false

    try {
      const boundary = await this.ensureDurableHome()
      await this.ensureDurableDirectory(join(this.root, 'tmp'), boundary)
      const { digest, size } = await this.writeTempFile(tmpPath, chunks, maxBytes, signal)

      objectPath = objectPathOf(this.root, digest)
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
      await fs.unlink(tmpPath).catch(() => {})
      // Best-effort cleanup of links this call landed: a failed publication
      // must not leave an orphan alias or object behind. Only entries this
      // call created are removed (an EEXIST hit is somebody else's file), and
      // cleanup errors are swallowed — the original failure is what the
      // caller needs to see.
      if (createdAlias && aliasPath !== undefined) await fs.unlink(aliasPath).catch(() => {})
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
