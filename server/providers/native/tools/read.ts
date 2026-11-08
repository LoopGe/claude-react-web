// server/providers/native/tools/read.ts
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { ToolInputError, type ToolDef } from './types.js'

const MAX_LINES = 2000

/** Resolve a user-supplied path against the session cwd and refuse anything
 *  that escapes it. P1 keeps the sandbox closed; the sandbox setting plumbs
 *  through in P3. */
export function resolveAgainstCwd(cwd: string, p: string): string {
  if (typeof p !== 'string' || p === '') throw new ToolInputError('path is required')
  const abs = isAbsolute(p) ? resolve(p) : resolve(join(cwd, p))
  const root = resolve(cwd)
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new ToolInputError(`path escapes the session working directory: ${p}`)
  }
  return abs
}

export const readTool: ToolDef<{ file_path: string; offset?: number; limit?: number }> = {
  name: 'Read',
  description: 'Read a UTF-8 text file and return line-numbered content.',
  guidance: 'Read a file before editing or writing it; paths resolve inside the session working directory.',
  promptOrder: 100,
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
    const abs = resolveAgainstCwd(ctx.cwd, input.file_path)
    let info
    try {
      info = await stat(abs)
    } catch {
      throw new ToolInputError(`file not found: ${input.file_path}`)
    }
    if (info.isDirectory()) throw new ToolInputError(`path is a directory: ${input.file_path}`)
    const raw = await readFile(abs, 'utf-8')
    const lines = raw.split('\n')
    const offset = Math.max(1, Math.floor(input.offset ?? 1))
    const limit = Math.min(MAX_LINES, Math.max(1, Math.floor(input.limit ?? MAX_LINES)))
    const slice = lines.slice(offset - 1, offset - 1 + limit)
    const text = slice.map((line, i) => `${String(offset + i).padStart(6)}\t${line}`).join('\n')
    return { text }
  },
}
