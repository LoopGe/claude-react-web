// server/providers/native/tools/glob.ts
import { stat } from 'node:fs/promises'
import { basename, relative, sep } from 'node:path'
import { ToolInputError, statError, type ToolDef } from './types.js'
import { resolveAgainstCwd } from './read.js'
import { globToRegExp, walk } from './grep.js'
import { capToolText } from './bash.js'

const MAX_FILES = 100
/** One past the cap: enough to observe that the result set is larger without
 *  walking the rest of the tree. */
const MAX_COLLECTED = MAX_FILES + 1

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
  /** OBSERVED match count when truncated. The walk stops at MAX_COLLECTED, so
   *  this is a lower bound (≤101), not an exact full-tree count. */
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
      for await (const file of walk(root, ctx.signal)) {
        const walkRelative = toPosix(relative(root, file))
        if (!matcher.test(walkRelative)) continue
        matches.push(toPosix(relative(ctx.cwd, file)))
        // Stop as soon as truncation is certain: sorting these collected
        // paths gives the same first-100 contract without scanning the rest
        // of a potentially huge tree.
        if (matches.length >= MAX_COLLECTED) break
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
