// server/providers/native/file-read.ts
import type { BigIntStats } from 'node:fs'
import { open, realpath, stat, type FileHandle } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'
import type { FileReadResult } from '../../../shared/read-file.js'

export const DEFAULT_READ_MAX_BYTES = 1_048_576
export const MODEL_READ_WINDOW_MAX_BYTES = 1_048_576
export const MODEL_READ_MAX_LINES = 2000
export const MAX_EDIT_BYTES = 8 * 1024 * 1024

export interface NativeFileIdentity {
  dev: bigint
  ino: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}

export interface NativeReadTarget {
  requestedPath: string
  absolutePath: string
  realPath: string
  identity: NativeFileIdentity
}

export interface NativeReadObservation {
  target: NativeReadTarget
  identity: NativeFileIdentity
}

export interface NativeTextWindow {
  text: string
  startLine: number
  endLine: number
  endByteOffset: number
  scannedByteCount: number
  reachedEof: boolean
  observation: NativeReadObservation
}

export class NativeFileUnavailableError extends Error {}
export class NativeFileChangedError extends Error {}
export class NativeFileEncodingError extends Error {}
export class NativeReadWindowTooLargeError extends Error {}

const unavailableCodes = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'])

function unavailable(path: string): NativeFileUnavailableError {
  return new NativeFileUnavailableError(`file is unavailable: ${path}`)
}

function mapUnavailable(err: unknown, path: string): never {
  if (unavailableCodes.has((err as NodeJS.ErrnoException).code ?? '')) throw unavailable(path)
  throw err
}

function inside(root: string, path: string): boolean {
  const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
  const normalizedRoot = normalize(root)
  const normalizedPath = normalize(path)
  const rootPrefix = normalizedRoot.endsWith(sep) ? normalizedRoot : normalizedRoot + sep
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(rootPrefix)
}

function identityOf(info: BigIntStats): NativeFileIdentity {
  return {
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeNs: info.mtimeNs,
    ctimeNs: info.ctimeNs,
  }
}

async function statTarget(path: string): Promise<BigIntStats> {
  try {
    return await stat(path, { bigint: true })
  } catch (err) {
    mapUnavailable(err, path)
  }
}

export function sameNativeFileIdentity(a: NativeFileIdentity, b: NativeFileIdentity): boolean {
  return a.dev === b.dev
    && a.ino === b.ino
    && a.size === b.size
    && a.mtimeNs === b.mtimeNs
    && a.ctimeNs === b.ctimeNs
}

export function nativeMtimeFloor(identity: NativeFileIdentity): number {
  return Number(identity.mtimeNs / 1_000_000n)
}

export async function resolveNativeReadTarget(cwd: string, path: string, extraRoots?: readonly string[]): Promise<NativeReadTarget> {
  if (typeof path !== 'string' || path === '') throw unavailable(String(path))
  const root = resolve(cwd)
  const absolutePath = isAbsolute(path) ? resolve(path) : resolve(root, path)
  const roots = [root, ...(extraRoots ?? []).map((extra) => resolve(extra))]
  // Only the roots that LEXICALLY contain the target participate in the escape
  // double-check below. An extra root that does not contain the target (and may
  // not even exist on disk — a lexical-only resolve, or a memory dir removed
  // externally) is irrelevant to this read and must never fail it.
  const candidates = roots.filter((candidate) => inside(candidate, absolutePath))
  if (candidates.length === 0) {
    throw new NativeFileUnavailableError(`path escapes the session working directory: ${path}`)
  }

  // Double-check on the real paths: realpath BOTH each containing root and the
  // target, so a symlinked root or a junction inside a root cannot turn the
  // allowance into an escape. The extra roots widen the allowed set, never the
  // check.
  let realPath: string
  let realRoots: string[]
  try {
    ;[realPath, ...realRoots] = await Promise.all([realpath(absolutePath), ...candidates.map((candidate) => realpath(candidate))])
  } catch (err) {
    mapUnavailable(err, path)
  }
  if (!realRoots.some((candidate) => inside(candidate, realPath))) throw unavailable(path)
  const info = await statTarget(realPath)
  if (!info.isFile()) throw unavailable(path)
  return { requestedPath: path, absolutePath, realPath, identity: identityOf(info) }
}

export async function assertNativeTargetCurrent(target: NativeReadTarget): Promise<void> {
  let realPath: string
  try {
    realPath = await realpath(target.absolutePath)
  } catch (err) {
    mapUnavailable(err, target.requestedPath)
  }
  if (realPath !== target.realPath) throw new NativeFileChangedError(`file changed during read: ${target.requestedPath}`)
  const info = await statTarget(realPath)
  if (!info.isFile() || !sameNativeFileIdentity(target.identity, identityOf(info))) {
    throw new NativeFileChangedError(`file changed during read: ${target.requestedPath}`)
  }
}

function throwIfAborted(signal: AbortSignal): void {
  signal.throwIfAborted()
}

export async function withNativeFile<T>(
  target: NativeReadTarget,
  signal: AbortSignal,
  fn: (handle: FileHandle) => Promise<T>,
  opts?: { allowMutation?: boolean },
): Promise<{ value: T; observation: NativeReadObservation }> {
  throwIfAborted(signal)
  const handle = await open(target.absolutePath, opts?.allowMutation ? 'r+' : 'r').catch((err: unknown) => mapUnavailable(err, target.requestedPath))
  try {
    throwIfAborted(signal)
    const openedInfo = await handle.stat({ bigint: true })
    throwIfAborted(signal)
    if (!openedInfo.isFile() || !sameNativeFileIdentity(target.identity, identityOf(openedInfo))) {
      throw new NativeFileChangedError(`file changed before read: ${target.requestedPath}`)
    }

    const value = await fn(handle)
    throwIfAborted(signal)
    const finalInfo = await handle.stat({ bigint: true })
    throwIfAborted(signal)
    const finalIdentity = identityOf(finalInfo)
    if (!opts?.allowMutation && !sameNativeFileIdentity(target.identity, finalIdentity)) {
      throw new NativeFileChangedError(`file changed during read: ${target.requestedPath}`)
    }
    await assertNativeTargetCurrent(opts?.allowMutation ? { ...target, identity: finalIdentity } : target)
    throwIfAborted(signal)
    return { value, observation: { target, identity: finalIdentity } }
  } finally {
    await handle.close()
  }
}

function validateMaxBytes(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !Number.isSafeInteger(maxBytes + 1)) {
    throw new TypeError('maxBytes must be a positive safe integer whose successor is also safe')
  }
}

function completeUtf8Prefix(bytes: Buffer): Buffer {
  if (bytes.length === 0) return bytes
  let start = bytes.length - 1
  let continuationCount = 0
  while (start > 0 && continuationCount < 3 && (bytes[start] & 0xc0) === 0x80) {
    start -= 1
    continuationCount += 1
  }
  const lead = bytes[start]
  const expected = lead >= 0xc2 && lead <= 0xdf ? 2
    : lead >= 0xe0 && lead <= 0xef ? 3
      : lead >= 0xf0 && lead <= 0xf4 ? 4
        : 1
  return expected > bytes.length - start ? bytes.subarray(0, start) : bytes
}

function decodeText(bytes: Buffer): string {
  if (bytes.includes(0)) throw new NativeFileEncodingError('file contains NUL bytes')
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch (err) {
    throw new NativeFileEncodingError('file is not valid UTF-8', { cause: err })
  }
}

export async function readNativeTarget(
  target: NativeReadTarget,
  opts: { maxBytes?: number; encoding?: 'utf-8' | 'base64'; signal: AbortSignal },
): Promise<{ result: FileReadResult; observation?: NativeReadObservation }> {
  const maxBytes = opts.maxBytes ?? DEFAULT_READ_MAX_BYTES
  validateMaxBytes(maxBytes)
  const encoding = opts.encoding ?? 'utf-8'
  const { value, observation } = await withNativeFile(target, opts.signal, async (handle) => {
    const chunks: Buffer[] = []
    let byteCount = 0
    let truncated = false
    const stream = handle.createReadStream({
      autoClose: false,
      highWaterMark: Math.min(64 * 1024, maxBytes + 1),
    })
    let reachedEof = false
    let succeeded = false
    try {
      for await (const chunk of stream) {
        throwIfAborted(opts.signal)
        const bytes = chunk as Buffer
        const remaining = maxBytes + 1 - byteCount
        const kept = bytes.subarray(0, Math.min(bytes.length, remaining))
        chunks.push(kept)
        byteCount += kept.length
        if (byteCount > maxBytes) {
          truncated = true
          break
        }
      }
      reachedEof = !truncated
      throwIfAborted(opts.signal)
      const readBytes = Buffer.concat(chunks, byteCount)
      const retained = truncated ? readBytes.subarray(0, maxBytes) : readBytes
      const contents = encoding === 'base64'
        ? retained.toString('base64')
        : decodeText(truncated ? completeUtf8Prefix(retained) : retained)
      succeeded = true
      return { contents, truncated }
    } finally {
      if (!reachedEof || !succeeded) stream.destroy()
    }
  })
  return {
    result: { available: true, contents: value.contents, truncated: value.truncated, encoding },
    observation: value.truncated ? undefined : observation,
  }
}

/** Read a small head of the file under full identity protection, so media
 *  sniffing costs one short open instead of a full read. */
export async function readNativePrefix(
  target: NativeReadTarget,
  byteCount: number,
  signal: AbortSignal,
): Promise<Buffer> {
  validateMaxBytes(byteCount)
  const { value } = await withNativeFile(target, signal, async (handle) => {
    const buf = Buffer.alloc(byteCount)
    const result = await handle.read(buf, 0, byteCount, 0)
    return buf.subarray(0, result.bytesRead)
  })
  return value
}

/** Read the whole file as raw bytes (bounded, identity-protected). Used by
 *  media reads that must hand the exact bytes to the host (images, PDFs). */
export async function readNativeBytes(
  target: NativeReadTarget,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  validateMaxBytes(maxBytes)
  const { value } = await withNativeFile(target, signal, async (handle) => {
    const chunks: Buffer[] = []
    let byteCount = 0
    const stream = handle.createReadStream({ autoClose: false })
    let reachedEof = false
    let succeeded = false
    try {
      for await (const chunk of stream) {
        throwIfAborted(signal)
        const bytes = chunk as Buffer
        if (byteCount + bytes.length > maxBytes) {
          throw new NativeReadWindowTooLargeError('file exceeds the media read byte limit')
        }
        chunks.push(bytes)
        byteCount += bytes.length
      }
      reachedEof = true
      throwIfAborted(signal)
      succeeded = true
      return Buffer.concat(chunks, byteCount)
    } finally {
      if (!reachedEof || !succeeded) stream.destroy()
    }
  })
  return value
}

export async function readNativeTextWindow(
  target: NativeReadTarget,
  opts: { offset?: number; limit?: number; startByteOffset?: number; signal: AbortSignal },
): Promise<NativeTextWindow> {
  const offset = Math.max(1, Math.floor(opts.offset ?? 1))
  const limit = Math.min(MODEL_READ_MAX_LINES, Math.max(1, Math.floor(opts.limit ?? MODEL_READ_MAX_LINES)))
  const startByteOffset = opts.startByteOffset ?? 0
  if (!Number.isSafeInteger(startByteOffset) || startByteOffset < 0) {
    throw new TypeError('startByteOffset must be a non-negative safe integer')
  }

  const { value, observation } = await withNativeFile(target, opts.signal, async (handle) => {
    const continued = opts.startByteOffset !== undefined
    let lineNumber = continued ? offset : 1
    let capturing = lineNumber >= offset
    const lines: Buffer[] = []
    let lineParts: Buffer[] = []
    let currentBytes = 0
    let retainedBytes = 0
    let scannedByteCount = 0
    let endByteOffset = startByteOffset
    let reachedEof = false
    let awaitingEofProbe = false
    let stopped = false
    let naturalEof = false
    let succeeded = false
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    const stream = handle.createReadStream({ autoClose: false, start: startByteOffset })

    const validateChunk = (chunk: Buffer, streamDecode: boolean) => {
      if (chunk.includes(0)) throw new NativeFileEncodingError('file contains NUL bytes')
      try {
        if (streamDecode) decoder.decode(chunk, { stream: true })
        else decoder.decode()
      } catch (err) {
        throw new NativeFileEncodingError('file is not valid UTF-8', { cause: err })
      }
    }
    const append = (bytes: Buffer) => {
      if (!capturing || bytes.length === 0) return
      const separatorBytes = lines.length > 0 ? 1 : 0
      if (retainedBytes + separatorBytes + currentBytes + bytes.length > MODEL_READ_WINDOW_MAX_BYTES) {
        throw new NativeReadWindowTooLargeError('requested read window exceeds 1 MiB; request fewer lines')
      }
      lineParts.push(bytes)
      currentBytes += bytes.length
    }
    const finishLine = () => {
      if (!capturing) return
      const nextRetainedBytes = retainedBytes + (lines.length > 0 ? 1 : 0) + currentBytes
      if (nextRetainedBytes > MODEL_READ_WINDOW_MAX_BYTES) {
        throw new NativeReadWindowTooLargeError('requested read window exceeds 1 MiB; request fewer lines')
      }
      lines.push(Buffer.concat(lineParts, currentBytes))
      retainedBytes = nextRetainedBytes
      lineParts = []
      currentBytes = 0
    }

    try {
      for await (const chunk of stream) {
        throwIfAborted(opts.signal)
        const bytes = chunk as Buffer
        scannedByteCount += bytes.length
        validateChunk(bytes, true)
        if (awaitingEofProbe) {
          stopped = true
          break
        }

        let segmentStart = 0
        for (let index = 0; index < bytes.length; index += 1) {
          if (bytes[index] !== 0x0a) continue
          append(bytes.subarray(segmentStart, index))
          finishLine()
          endByteOffset = startByteOffset + scannedByteCount - bytes.length + index + 1
          if (lines.length === limit) {
            if (index + 1 < bytes.length) stopped = true
            else awaitingEofProbe = true
            break
          }
          lineNumber += 1
          capturing = lineNumber >= offset
          segmentStart = index + 1
        }
        if (stopped || awaitingEofProbe) {
          if (stopped) break
          continue
        }
        append(bytes.subarray(segmentStart))
      }
      if (!stopped && !awaitingEofProbe) {
        naturalEof = true
        throwIfAborted(opts.signal)
        validateChunk(Buffer.alloc(0), false)
        finishLine()
        endByteOffset = startByteOffset + scannedByteCount
        reachedEof = true
      }
      const text = lines.map((line) => decodeText(line)).join('\n')
      succeeded = true
      return {
        text,
        startLine: offset,
        endLine: offset + lines.length - 1,
        endByteOffset,
        scannedByteCount,
        reachedEof,
      }
    } finally {
      if (!naturalEof || !succeeded) stream.destroy()
    }
  })
  return { ...value, observation }
}
