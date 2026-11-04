/**
 * Whole-file captures around file-tool edits: the content of a path before
 * its first mutation in a turn and again at turn end, stored content-addressed
 * so both sides of a comparison survive later edits and need no git.
 *
 * The copies cover the paths the shadow snapshots do not: gitignored files
 * and files outside the session's snapshot scope.
 */
import { createHash } from 'node:crypto'
import { mkdir, open, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

/** Bytes git inspects for a NUL byte before treating content as binary. */
const BINARY_PROBE_BYTES = 8000

/** One captured side of a path. */
export type FileCopy =
  /** No file at the path. */
  | { kind: 'absent' }
  /** A regular file larger than the configured cap; its content is not stored. */
  | { kind: 'oversized' }
  /** A stored copy, named by the SHA-1 of its bytes. */
  | { kind: 'file'; file: string; binary: boolean }

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

/**
 * Store the current content of one path. At most `maxBytes + 1` bytes are
 * read, so a file that grows past the cap while it is read costs no more
 * memory than the cap.
 * @param absPath - absolute path of the file.
 * @param directory - directory holding content-addressed copies; created when missing.
 * @param maxBytes - inclusive byte cap on a stored copy.
 * @returns the capture.
 * @throws when the path cannot be opened or read for a reason other than absence, or the copy cannot be written.
 */
export async function captureCopy(absPath: string, directory: string, maxBytes: number): Promise<FileCopy> {
  let handle
  try {
    handle = await open(absPath, 'r')
  } catch (error: unknown) {
    if (!isMissing(error)) throw error
    return { kind: 'absent' }
  }
  let bytes: Buffer
  try {
    if (!(await handle.stat()).isFile()) return { kind: 'absent' }
    const probe = Buffer.allocUnsafe(maxBytes + 1)
    let length = 0
    while (length < probe.length) {
      const { bytesRead } = await handle.read(probe, length, probe.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > maxBytes) return { kind: 'oversized' }
    bytes = probe.subarray(0, length)
  } finally {
    await handle.close()
  }
  const file = join(directory, createHash('sha1').update(bytes).digest('hex'))
  await mkdir(directory, { recursive: true })
  // Identical content across paths and turns shares one copy; `wx` keeps an existing copy as is.
  await writeFile(file, bytes, { flag: 'wx' }).catch((error: unknown) => {
    if ((error as { code?: unknown }).code !== 'EEXIST') throw error
  })
  return { kind: 'file', file, binary: bytes.subarray(0, BINARY_PROBE_BYTES).includes(0) }
}

/**
 * Whether two captures are known to hold the same content. Two absent sides
 * are the same; two stored copies are the same when their bytes hash alike;
 * an oversized side is never known to match anything, since its content was
 * not read.
 * @param a - one side.
 * @param b - the other side.
 * @returns true only when both sides are known to match.
 */
export function sameCopy(a: FileCopy, b: FileCopy): boolean {
  if (a.kind === 'absent' || b.kind === 'absent') return a.kind === b.kind
  return a.kind === 'file' && b.kind === 'file' && a.file === b.file
}

/**
 * Resolve a tool's target to the canonical spelling every capture key uses.
 * A path that does not exist yet (a `Write`-created file, or a file in a
 * not-yet-created directory) is resolved through its existing parent, so the
 * before-copy and the turn-end copy land on the same key.
 * @param absPath - absolute or cwd-relative tool target.
 * @returns the canonical absolute path.
 */
export async function canonicalTargetPath(absPath: string): Promise<string> {
  const absolute = resolve(absPath)
  try {
    return await realpath(absolute)
  } catch (error: unknown) {
    if (!isMissing(error)) throw error
    try {
      return join(await realpath(dirname(absolute)), basename(absolute))
    } catch (parentError: unknown) {
      if (!isMissing(parentError)) throw parentError
      return absolute
    }
  }
}