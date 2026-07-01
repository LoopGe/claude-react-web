// Resolve real file line numbers + context for Edit / MultiEdit diff cards.
//
// The SDK's Edit tool input carries only { file_path, old_string, new_string }
// — no file line offset — so the client can't know where in the file an edit
// lands without reading the file. This route reads <cwd>/<path>, reconstructs
// the old/new file contents around the edit, and runs `diff`'s
// `structuredPatch` to produce a canonical unified-diff hunk (with real
// old/new line numbers and K lines of context) per anchor — the same primitive
// claude-code's in-process FileEditTool uses, re-derived here because the SDK
// runs Edit in a subprocess and doesn't surface line info.
//
// Conventions mirror fs-routes.ts / git-routes.ts: Hono factory
// `buildEditLocateRouter()` returning a bare app, mounted on /api/edit-locate
// by buildApp(); inline validation throws HttpError(400) → JSON via onError.
//
// The route returns hunks (line numbers + diff lines) — never raw file
// contents — so the "directory-only /api/fs" content posture is preserved.

import { Hono } from 'hono'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import { structuredPatch } from 'diff'
import { HttpError, createErrorHandler } from './errors.js'

const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_ANCHORS = 100
/** Unchanged context lines shown above and below each edit hunk (git-diff
 *  style), passed straight to structuredPatch. */
const DIFF_CONTEXT_LINES = 3

interface Anchor {
  old: string
  new: string
}

/** Read a file's text. Returns null when the path is missing / not a regular
 *  file / too large / unreadable. */
async function readFileText(absPath: string): Promise<string | null> {
  let st
  try {
    st = await stat(absPath)
  } catch {
    return null
  }
  if (!st.isFile()) return null
  if (st.size > MAX_FILE_BYTES) return null
  try {
    return await readFile(absPath, 'utf8')
  } catch {
    return null
  }
}

/** True if `needle` occurs exactly once in `content` (so its position is
 *  unambiguous). Empty needle → false. */
function isUnique(content: string, needle: string): boolean {
  if (needle.length === 0) return false
  const first = content.indexOf(needle)
  if (first === -1) return false
  return content.indexOf(needle, first + needle.length) === -1
}

export function buildEditLocateRouter(): Hono {
  const app = new Hono()
  app.onError(createErrorHandler('[edit-locate]'))

  app.post('/', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { cwd?: unknown; path?: unknown; anchors?: unknown }
      | null
    if (!body || typeof body !== 'object') throw new HttpError(400, 'JSON body required')

    const { cwd, path: filePath, anchors } = body
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
      throw new HttpError(400, 'cwd must be an absolute path')
    }
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new HttpError(400, 'path is required')
    }
    if (!Array.isArray(anchors) || anchors.length === 0) {
      throw new HttpError(400, 'anchors must be a non-empty array')
    }
    if (anchors.length > MAX_ANCHORS) {
      throw new HttpError(400, `too many anchors (max ${MAX_ANCHORS})`)
    }

    const parsed: Anchor[] = []
    for (const a of anchors) {
      if (!a || typeof a !== 'object') throw new HttpError(400, 'each anchor must be { old, new }')
      const o = a as Record<string, unknown>
      if (typeof o.old !== 'string' || typeof o.new !== 'string') {
        throw new HttpError(400, 'each anchor must have string old/new')
      }
      parsed.push({ old: o.old, new: o.new })
    }

    const absPath = isAbsolute(filePath) ? filePath : resolvePath(cwd, filePath)
    const content = await readFileText(absPath)
    if (content === null) {
      return c.json({ results: parsed.map(() => ({ hunks: null })) })
    }

    const results = parsed.map(({ old, new: neu }) => {
      // Reconstruct old/new file contents around the edit so structuredPatch
      // can compute a real unified-diff hunk (line numbers + context) in one
      // shot. Applied edit → new_string is in the file; not applied / denied
      // → old_string is. Require uniqueness so the reconstruction targets the
      // right occurrence; otherwise we'd rather show no gutter than a wrong
      // one.
      let oldContent: string
      let newContent: string
      if (isUnique(content, neu)) {
        newContent = content
        oldContent = content.replace(neu, old)
      } else if (isUnique(content, old)) {
        oldContent = content
        newContent = content.replace(old, neu)
      } else {
        return { hunks: null }
      }
      const patch = structuredPatch(filePath, filePath, oldContent, newContent, '', '', {
        context: DIFF_CONTEXT_LINES,
      })
      return { hunks: patch.hunks }
    })

    return c.json({ results })
  })

  return app
}
