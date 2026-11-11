// server/providers/native/tools/grep.ts
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { ToolInputError, type ToolDef } from './types.js'
import { resolveAgainstCwd } from './read.js'

const MAX_FILES = 400
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_MATCHES = 200
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist'])

/** Translate a glob into an anchored RegExp. `*` matches within one path
 *  segment, `?` matches one character, and `**` matches any depth (a
 *  following `/` may therefore match zero segments). A pattern containing no
 *  `/` is effectively a basename match when the caller passes a basename. */
export function globToRegExp(glob: string): RegExp {
  // Collapse repeated any-depth segments (`**/**/x`): each `**/` compiles to
  // an optional group, and a run of them multiplies an anchored match's
  // backtracking paths.
  glob = glob.replace(/(?:\*\*\/)+/g, '**/')
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        while (glob[i + 1] === '*') i++
        if (glob[i + 1] === '/') {
          i++
          out += '(?:.*/)?'
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      out += `\\${ch}`
    } else {
      out += ch
    }
  }
  return new RegExp(`^${out}$`)
}

/** Recursive file walk from `root`, skipping SKIP_DIRS. Yields absolute paths.
 *  Shared by Grep and Glob; Glob normalizes them to walk-relative paths so a
 *  pattern is matched against the tree rather than the filesystem path. */
export async function* walk(root: string): AsyncGenerator<string> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      yield* walk(join(root, entry.name))
    } else if (entry.isFile()) {
      yield join(root, entry.name)
    }
  }
}

export const grepTool: ToolDef<{ pattern: string; path?: string; include?: string }> = {
  name: 'Grep',
  description: 'Search file contents with a regular expression.',
  guidance: 'Grep is a plain regex search over text files; it does not read .gitignore.',
  promptOrder: 130,
  schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'JavaScript regular expression source.' },
      path: { type: 'string', description: 'Directory or file to search. Defaults to the session working directory.' },
      include: { type: 'string', description: 'Filename glob filter, e.g. *.ts.' },
    },
    required: ['pattern'],
  },
  async run(input, ctx) {
    let regex: RegExp
    try {
      regex = new RegExp(input.pattern)
    } catch (err) {
      throw new ToolInputError(`invalid pattern: ${(err as Error).message}`)
    }
    const root = resolveAgainstCwd(ctx.cwd, input.path ?? '.')
    const includeRe = input.include ? globToRegExp(input.include) : null
    const lines: string[] = []
    let files = 0
    let totalMatches = 0
    const rootStat = await stat(root)
    const candidates: AsyncIterable<string> = rootStat.isFile()
      ? (async function* () { yield root })()
      : walk(root)
    for await (const file of candidates) {
      if (files >= MAX_FILES) break
      if (includeRe && !includeRe.test(file.split('/').pop() ?? file)) continue
      const buf = await readFile(file).catch(() => null)
      if (!buf || buf.length > MAX_FILE_BYTES || buf.subarray(0, 1024).includes(0)) continue
      files++
      const rel = relative(ctx.cwd, file)
      const text = buf.toString('utf-8')
      const fileLines = text.split('\n')
      for (let i = 0; i < fileLines.length; i++) {
        if (!regex.test(fileLines[i])) continue
        totalMatches++
        if (lines.length < MAX_MATCHES) lines.push(`${rel}:${i + 1}: ${fileLines[i]}`)
      }
    }
    if (totalMatches === 0) return { text: 'no matches' }
    let text = lines.join('\n')
    if (totalMatches > MAX_MATCHES) text += `\n...[${totalMatches - MAX_MATCHES} more matches truncated]`
    return { text }
  },
}
