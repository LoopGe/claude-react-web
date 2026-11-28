// server/providers/native/tools/read.ts
import { isAbsolute, join, resolve, sep } from 'node:path'
import {
  MODEL_READ_MAX_LINES,
  NativeFileChangedError,
  NativeFileEncodingError,
  NativeFileUnavailableError,
  NativeReadWindowTooLargeError,
  readNativeTextWindow,
  resolveNativeReadTarget,
} from '../file-read.js'
import type { NativeReadState } from '../read-state.js'
import { ToolInputError, type ToolDef } from './types.js'

const MAX_LINES = MODEL_READ_MAX_LINES

/** Resolve a user-supplied path against the session cwd and refuse anything
 *  that escapes it. P1 keeps the sandbox closed; the sandbox setting plumbs
 *  through in P3. `extraRoots` (the auto-memory write roots) widen the lexical
 *  allowance beyond the cwd; this chain stays lexical — the realpath escape
 *  check lives in resolveNativeReadTarget on the Edit/Read chain. */
export function resolveAgainstCwd(cwd: string, p: string, extraRoots?: readonly string[]): string {
  if (typeof p !== 'string' || p === '') throw new ToolInputError('path is required')
  const abs = isAbsolute(p) ? resolve(p) : resolve(join(cwd, p))
  const roots = [resolve(cwd), ...(extraRoots ?? []).map((root) => resolve(root))]
  if (!roots.some((root) => abs === root || abs.startsWith(root + sep))) {
    throw new ToolInputError(`path escapes the session working directory: ${p}`)
  }
  return abs
}

export function createReadTool(state: NativeReadState): ToolDef<{
  file_path: string
  offset?: number
  limit?: number
}> {
  return {
    name: 'Read',
    description: 'Read a UTF-8 text file and return line-numbered content.',
    guidance: 'Read a file before editing or writing it; paths resolve inside the session working directory.',
    promptOrder: 100,
    readOnlyHint: true,
    schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to read, relative to the session working directory.' },
        offset: { type: 'number', description: '1-based first line to return. Defaults to 1.' },
        limit: { type: 'number', description: `Maximum number of lines to return. Defaults to ${MAX_LINES}.` },
      },
      required: ['file_path'],
    },
    async run(input, ctx) {
      const offset = Math.max(1, Math.floor(input.offset ?? 1))
      const limit = Math.min(MAX_LINES, Math.max(1, Math.floor(input.limit ?? MAX_LINES)))
      try {
        const target = await resolveNativeReadTarget(ctx.cwd, input.file_path, ctx.memoryRoots?.read)
        const continuation = offset > 1 ? state.continuation(target, offset) : undefined
        const window = await readNativeTextWindow(target, {
          offset,
          limit,
          ...(continuation ? { startByteOffset: continuation.byteOffset } : {}),
          signal: ctx.signal,
        })
        state.recordModelWindow(window, continuation !== undefined)
        const lineCount = Math.max(0, window.endLine - window.startLine + 1)
        const lines = lineCount === 0 ? [] : window.text.split('\n')
        const text = lines.map((line, i) => `${String(offset + i).padStart(6)}\t${line}`).join('\n')
        return { text }
      } catch (err) {
        if (err instanceof NativeFileUnavailableError
          || err instanceof NativeFileEncodingError
          || err instanceof NativeFileChangedError
          || err instanceof NativeReadWindowTooLargeError) {
          throw new ToolInputError(err.message)
        }
        throw err
      }
    },
  }
}
