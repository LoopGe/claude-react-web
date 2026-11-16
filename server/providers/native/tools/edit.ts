// server/providers/native/tools/edit.ts
import type { BigIntStats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import {
  MAX_EDIT_BYTES,
  NativeFileChangedError,
  NativeFileEncodingError,
  NativeFileUnavailableError,
  sameNativeFileIdentity,
  withNativeFile,
  type NativeFileIdentity,
} from '../file-read.js'
import type { NativeReadState } from '../read-state.js'
import { ToolInputError, type ToolDef } from './types.js'

function identityOf(info: BigIntStats): NativeFileIdentity {
  return {
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeNs: info.mtimeNs,
    ctimeNs: info.ctimeNs,
  }
}

async function readOriginal(handle: FileHandle): Promise<{ text: string; bytes: Buffer }> {
  const chunks: Buffer[] = []
  let byteCount = 0
  let reachedEof = false
  let succeeded = false
  const stream = handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })
  try {
    for await (const chunk of stream) {
      const bytes = chunk as Buffer
      const remaining = MAX_EDIT_BYTES + 1 - byteCount
      const kept = bytes.subarray(0, Math.min(bytes.length, remaining))
      chunks.push(kept)
      byteCount += kept.length
      if (byteCount > MAX_EDIT_BYTES) break
    }
    reachedEof = byteCount <= MAX_EDIT_BYTES
    if (byteCount > MAX_EDIT_BYTES) throw new ToolInputError('file exceeds the 8 MiB edit limit')
    const bytes = Buffer.concat(chunks, byteCount)
    if (bytes.includes(0)) throw new NativeFileEncodingError('file contains NUL bytes')
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    } catch (err) {
      throw new NativeFileEncodingError('file is not valid UTF-8', { cause: err })
    }
    succeeded = true
    return { text, bytes }
  } finally {
    if (!reachedEof || !succeeded) stream.destroy()
  }
}

/** Write and certify through the same opened handle. Readback is deliberately
 * capped at one byte beyond the expected output, never at the mutable EOF. */
async function writeAndVerify(
  handle: FileHandle,
  bytes: Buffer,
  path: string,
): Promise<NativeFileIdentity> {
  await handle.truncate(0)
  let written = 0
  while (written < bytes.length) {
    const result = await handle.write(bytes, written, bytes.length - written, written)
    if (result.bytesWritten === 0) throw new NativeFileChangedError(`edit made no progress writing: ${path}`)
    written += result.bytesWritten
  }

  const beforeReadback = identityOf(await handle.stat({ bigint: true }))
  const readback = Buffer.alloc(bytes.length + 1)
  let read = 0
  while (read < readback.length) {
    const result = await handle.read(readback, read, readback.length - read, read)
    if (result.bytesRead === 0) break
    read += result.bytesRead
  }
  const afterReadback = identityOf(await handle.stat({ bigint: true }))
  if (!sameNativeFileIdentity(beforeReadback, afterReadback)) {
    throw new NativeFileChangedError(`file changed during edit readback: ${path}`)
  }
  if (read !== bytes.length || !readback.subarray(0, read).equals(bytes)) {
    throw new NativeFileChangedError(`edit readback did not match the expected bytes: ${path}`)
  }
  return afterReadback
}

export function createEditTool(state: NativeReadState): ToolDef<{
  file_path: string
  old_string: string
  new_string: string
  replace_all?: boolean
}> {
  return {
    name: 'Edit',
    description: 'Edit an existing UTF-8 text file by replacing literal text.',
    guidance: 'Read the complete current file first. old_string must be non-empty, match exactly, and appear exactly once unless replace_all is true.',
    promptOrder: 120,
    schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to edit, relative to the session working directory.' },
        old_string: { type: 'string', description: 'Literal text to replace.' },
        new_string: { type: 'string', description: 'Literal replacement text. Use an empty string to delete the match.' },
        replace_all: { type: 'boolean', description: 'Replace all matches. Defaults to false; when false, old_string must appear exactly once.' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
    async run(input, ctx) {
      if (input.old_string.length === 0) throw new ToolInputError('old_string must not be empty')
      if (input.old_string.includes('\0') || input.new_string.includes('\0')) {
        throw new ToolInputError('old_string and new_string must not contain NUL bytes')
      }
      try {
        const target = await state.assertEditable(ctx.cwd, input.file_path)
        const { value: verifiedIdentity, observation } = await withNativeFile(
          target,
          ctx.signal,
          async (handle) => {
            const original = await readOriginal(handle)
            const count = original.text.split(input.old_string).length - 1
            if (count === 0) throw new ToolInputError('old_string not found in file')
            if (count > 1 && !input.replace_all) {
              throw new ToolInputError(`old_string appears ${count} times; pass replace_all or use a longer unique string`)
            }

            const oldBytes = Buffer.byteLength(input.old_string, 'utf8')
            const newBytes = Buffer.byteLength(input.new_string, 'utf8')
            const nextByteLength = original.bytes.length + count * (newBytes - oldBytes)
            if (nextByteLength > MAX_EDIT_BYTES) {
              throw new ToolInputError('edited file would exceed the 8 MiB edit limit')
            }
            const next = input.replace_all
              ? original.text.replaceAll(input.old_string, () => input.new_string)
              : original.text.replace(input.old_string, () => input.new_string)
            if (next.includes('\0')) throw new ToolInputError('edited file must not contain NUL bytes')
            const nextBytes = Buffer.from(next, 'utf8')
            if (nextBytes.length !== nextByteLength) {
              throw new Error('internal edit byte-count mismatch')
            }

            const beforeWrite = identityOf(await handle.stat({ bigint: true }))
            if (!sameNativeFileIdentity(target.identity, beforeWrite)) {
              throw new NativeFileChangedError(`file changed during edit: ${input.file_path}`)
            }
            return writeAndVerify(handle, nextBytes, input.file_path)
          },
          { allowMutation: true },
        )
        if (!sameNativeFileIdentity(verifiedIdentity, observation.identity)) {
          throw new NativeFileChangedError(`file changed after edit readback: ${input.file_path}`)
        }
        state.completeEdit(observation)
        return { text: `edited ${input.file_path}` }
      } catch (err) {
        if (err instanceof NativeFileUnavailableError
          || err instanceof NativeFileChangedError
          || err instanceof NativeFileEncodingError) {
          throw new ToolInputError(err.message)
        }
        throw err
      }
    },
  }
}
