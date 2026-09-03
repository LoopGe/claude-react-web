// Read-only HTTP surface for git status / diff / log.
//
// Mirrors the conventions in fs-routes.ts:
//   - Hono factory `buildGitRouter()` returning a bare app, mounted on
//     /api/git by buildApp().
//   - Inline parameter validation that returns 400 with a JSON error body
//     before reaching the git layer.
//   - HttpError thrown from server/git.ts is translated to JSON by the
//     global onError handler in app.ts.
//
// All three endpoints are GET / cwd-scope. Writes (stage/unstage/commit)
// live under /api/sessions/:id/git/* in routes/git-write.ts.

import { Hono } from 'hono'
import { isAbsolute } from 'node:path'
import { HttpError, createErrorHandler } from './errors.js'
import { getDiff, getLog, getStatusCached, getRangeDiffFiles, getRangeDiffFile, validateRef } from './git.js'
import type { GitLogResponse, GitRangeDiffResponse } from '../shared/git-types.js'

export function buildGitRouter(): Hono {
  const app = new Hono()
  app.onError(createErrorHandler('[git]'))

  // Validation shared by all three routes. Throws HttpError on failure
  // so the caller can early-return with a single line.
  function requireCwd(raw: string | undefined): string {
    if (!raw) throw new HttpError(400, 'cwd query param is required')
    if (!isAbsolute(raw)) throw new HttpError(400, 'cwd must be absolute')
    return raw
  }

  // --- GET /status -------------------------------------------------------
  // Returns the full porcelain snapshot, or { isRepo: false } when cwd is
  // reachable but isn't a git work tree. The "not a repo" case is 200, not
  // 404, because the UI uses it as a state indicator (chip hidden, panel
  // shows a friendly message) — it's not an error.
  app.get('/status', async (c) => {
    const cwd = requireCwd(c.req.query('cwd'))
    // Coalesce the thundering herd a single git-status-changed broadcast
    // produces across N subscribed tabs. Invalidated on every git mutation.
    const result = await getStatusCached(cwd)
    return c.json(result)
  })

  // --- GET /diff ---------------------------------------------------------
  // Per-file unified diff. `staged=1` returns the index-vs-HEAD diff;
  // `staged=0` (the default) returns the worktree-vs-index diff.
  //
  // Path validation lives in git.ts (validateRepoRelativePath) so the
  // execFile arg list never sees an absolute path or a `..` traversal.
  app.get('/diff', async (c) => {
    const cwd = requireCwd(c.req.query('cwd'))
    const path = c.req.query('path')
    if (!path) throw new HttpError(400, 'path query param is required')
    const staged = c.req.query('staged') === '1'
    const diff = await getDiff(cwd, path, staged)
    return c.json(diff)
  })

  // --- GET /diff-range ---------------------------------------------------
  // Per-file change summary between two refs (e.g. main → worktree branch).
  // `from`/`to` are ref names resolved within the repo, not user paths.
  app.get('/diff-range', async (c) => {
    const cwd = requireCwd(c.req.query('cwd'))
    const from = c.req.query('from')
    const to = c.req.query('to')
    if (!from || !to) throw new HttpError(400, 'from and to query params are required')
    validateRef(from)
    validateRef(to)
    // mode=mergeBase → three-dot (A...B, branch since fork); default tip (A..B).
    const mergeBase = c.req.query('mode') === 'mergeBase'
    const files = await getRangeDiffFiles(cwd, from, to, mergeBase)
    const body: GitRangeDiffResponse = { from, to, files }
    return c.json(body)
  })

  // --- GET /diff-range-file ---------------------------------------------
  // Unified body for one file across a range, lazily fetched on expand.
  app.get('/diff-range-file', async (c) => {
    const cwd = requireCwd(c.req.query('cwd'))
    const from = c.req.query('from')
    const to = c.req.query('to')
    const path = c.req.query('path')
    if (!from || !to) throw new HttpError(400, 'from and to query params are required')
    if (!path) throw new HttpError(400, 'path query param is required')
    validateRef(from)
    validateRef(to)
    const mergeBase = c.req.query('mode') === 'mergeBase'
    const diff = await getRangeDiffFile(cwd, from, to, path, mergeBase)
    return c.json(diff)
  })

  // --- GET /log ----------------------------------------------------------
  // Paginated history snapshot. The limit param is clamped server-side to
  // [1, 100]; no cursor / next-page since the UI only ever asks for the
  // latest few commits.
  app.get('/log', async (c) => {
    const cwd = requireCwd(c.req.query('cwd'))
    const limitRaw = c.req.query('limit')
    const limit = limitRaw ? Number(limitRaw) : 30
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new HttpError(400, 'limit must be a positive number')
    }
    const commits = await getLog(cwd, limit)
    const body: GitLogResponse = { commits }
    return c.json(body)
  })

  return app
}
