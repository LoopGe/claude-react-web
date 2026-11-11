// server/providers/native/tools/glob.ts
import { stat } from 'node:fs/promises'
import { basename, relative, sep } from 'node:path'
import { ToolInputError, statError, type ToolDef } from './types.js'
import { resolveAgainstCwd } from './read.js'
import { globToRegExp, walk } from './grep.js'
import { capToolText } from './bash.js'

const MAX_FILES = 100

/** Paths are matched with `/` separators on every platform; Windows walker
 *  output uses `\`, so normalize before matching and output. */
function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/')
}

interface GlobOutput {
  durationMs: number
  numFiles: number
  filenames: string[]
  truncated: boolean
  totalMatches?: number
}

export const globTool: ToolDef<{ pattern: string; path?: string }> = {
  name: 'Glob',
  description: 'Find files whose path matches a glob pattern.',
  guidance:
    'Glob matches file paths against a pattern where `*` matches within one segment, `?` one character, and `**` any depth ' +
    '(e.g. `**/*.ts`); it skips node_modules, .git and dist and returns at most 100 filenames.',
  promptOrder: 140,
  schema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern matched against the path relative to the search root, e.g. **/*.ts.',
      },
      path: { type: 'string', description: 'Directory (or a single file) to search. Defaults to the session working directory.' },
    },
    required: ['pattern'],
  },
  async run(input, ctx) {
    if (typeof input.pattern !== 'string' || input.pattern === '') {
      throw new ToolInputError('pattern is required')
    }
    const root = resolveAgainstCwd(ctx.cwd, input.path ?? '.')
    let rootStat
    try {
      rootStat = await stat(root)
    } catch (err) {
      throw statError(err, `path not found: ${input.path ?? '.'}`)
    }
    const matcher = globToRegExp(input.pattern)
    const started = Date.now()
    const matches: string[] = []
    // A file root is matched by its own basename (its walk-relative path).
    if (rootStat.isFile()) {
      if (matcher.test(toPosix(basename(root)))) matches.push(toPosix(relative(ctx.cwd, root)))
    } else {
      for await (const file of walk(root)) {
        const walkRelative = toPosix(relative(root, file))
        if (!matcher.test(walkRelative)) continue
        matches.push(toPosix(relative(ctx.cwd, file)))
      }
    }
    matches.sort()
    const filenames = matches.slice(0, MAX_FILES)
    const truncated = matches.length > MAX_FILES
    const output: GlobOutput = {
      durationMs: Date.now() - started,
      numFiles: filenames.length,
      filenames,
      truncated,
    }
    if (truncated) output.totalMatches = matches.length
    return { text: capToolText(JSON.stringify(output)) }
  },
}
