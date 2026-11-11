// server/providers/native/tools/ls.ts
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { ToolInputError, type ToolDef } from './types.js'
import { resolveAgainstCwd } from './read.js'

const MAX_ENTRIES = 100

interface LsEntry {
  name: string
  type: 'file' | 'dir'
  size?: number
}

export const lsTool: ToolDef<{ path?: string; ignore?: string[] }> = {
  name: 'LS',
  description: 'List the immediate children of a directory.',
  guidance:
    'LS lists one directory level with file sizes and child type; `.git` is always excluded and any `ignore` substring removes matching names.',
  promptOrder: 150,
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory to list. Defaults to the session working directory.' },
      ignore: {
        type: 'array',
        items: { type: 'string' },
        description: 'Name substrings to skip, e.g. ["node_modules"].',
      },
    },
  },
  async run(input, ctx) {
    const abs = resolveAgainstCwd(ctx.cwd, input.path ?? '.')
    const info = await stat(abs).catch(() => null)
    if (!info) throw new ToolInputError(`directory not found: ${input.path ?? '.'}`)
    if (!info.isDirectory()) throw new ToolInputError(`not a directory: ${input.path ?? '.'}`)

    const ignore = (input.ignore ?? []).filter((needle) => needle !== '')
    const dirents = await readdir(abs, { withFileTypes: true })
    const visible = dirents
      .filter((entry) => entry.name !== '.git' && (entry.isFile() || entry.isDirectory()))
      .filter((entry) => !ignore.some((needle) => entry.name.includes(needle)))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

    const truncated = visible.length > MAX_ENTRIES
    const entries: LsEntry[] = []
    for (const entry of visible.slice(0, MAX_ENTRIES)) {
      if (entry.isDirectory()) {
        entries.push({ name: entry.name, type: 'dir' })
      } else {
        const fileStat = await stat(join(abs, entry.name))
        entries.push({ name: entry.name, type: 'file', size: fileStat.size })
      }
    }
    return { text: JSON.stringify({ path: abs, entries, truncated }) }
  },
}