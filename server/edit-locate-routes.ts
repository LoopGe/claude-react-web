// Resolve real file line numbers for Edit / MultiEdit diff cards.
//
// The SDK's Edit tool input carries only { file_path, old_string, new_string }
// — no file line offset — so the client can't know where in the file an edit
// lands without reading the file. This route reads <cwd>/<path> and locates
// new_string (edit already applied) or old_string (not yet applied / denied),
// returning the 1-based start line per anchor. Mirrors claude-code's
// read-file-and-locate approach (structuredPatch), adapted to our
// client/server split where the SDK runs Edit in a subprocess and doesn't
// surface line info.
//
// Conventions mirror fs-routes.ts / git-routes.ts: Hono factory
// `buildEditLocateRouter()` returning a bare app, mounted on /api/edit-locate
// by buildApp(); inline validation throws HttpError(400) → JSON via onError.
//
// The route returns line numbers only — never file contents — so the
// "directory-only /api/fs" content posture is preserved.

import { Hono } from 'hono'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import { HttpError, createErrorHandler } from './errors.js'

const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_ANCHORS = 100

interface Anchor {
  old: string
  new: string
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
    const nulls = (): (number | null)[] => parsed.map(() => null)

    let content: string
    try {
      const st = await stat(absPath)
      // Not a regular file (directory / missing / special) → no line info.
      if (!st.isFile()) return c.json({ lines: nulls() })
      // Cap the read so a giant generated file can't stall the request.
      if (st.size > MAX_FILE_BYTES) return c.json({ lines: nulls() })
      content = await readFile(absPath, 'utf8')
    } catch {
      // File missing / unreadable — edit may target a not-yet-created file,
      // or be outside the reachable filesystem. No line info.
      return c.json({ lines: nulls() })
    }

    // Precompute newline offsets once for O(log N) line lookup per anchor.
    const nl: number[] = []
    for (let i = 0; i < content.length; i++) {
      if (content.charCodeAt(i) === 10) nl.push(i)
    }
    const lineAt = (idx: number): number => {
      // 1-based line number of character index idx = (count of '\n' before idx) + 1.
      let lo = 0
      let hi = nl.length
      while (lo < hi) {
        const mid = (lo + hi) >>> 1
        if (nl[mid] < idx) lo = mid + 1
        else hi = mid
      }
      return lo + 1
    }

    /** Find the 1-based start line of `needle` in `content`, or null when
     *  the needle is absent or appears more than once (ambiguous → we'd
     *  rather show no gutter than a wrong one). */
    const locateUnique = (needle: string): number | null => {
      if (needle.length === 0) return null
      const first = content.indexOf(needle)
      if (first === -1) return null
      if (content.indexOf(needle, first + needle.length) !== -1) return null
      return lineAt(first)
    }

    const lines = parsed.map(({ old, new: neu }) => {
      // Applied edit: new_string is in the file. Not applied / denied:
      // old_string is. Try new first, then old.
      const fromNew = locateUnique(neu)
      if (fromNew !== null) return fromNew
      return locateUnique(old)
    })

    return c.json({ lines })
  })

  return app
}
