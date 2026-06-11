// Per-session git write routes — stage / unstage / discard / commit /
// stash / branch / abort. Mounted alongside /sessions/* so each route's
// path looks like POST /api/sessions/:id/git/<verb>.
//
// Every route follows the same pattern:
//   1. Look up the session via `sm.get(id)` (throws 404)
//   2. Require `session.cwd` (throws 400 if missing)
//   3. Validate body fields (destructive ops require `confirm: true`)
//   4. Call into server/git.ts to perform the git operation
//   5. Broadcast `git-status-changed` to the session's WS subscribers
//   6. Return the freshly-fetched status snapshot, plus stash/branch
//      lists when relevant, so the client can update without a second
//      round-trip.

import { Hono } from 'hono'
import { SessionManager } from '../session-manager.js'
import { HttpError } from '../errors.js'
import { safeJson } from './index.js'
import {
  getStatusInRepo,
  stageFiles,
  unstageFiles,
  discardTracked,
  discardUntracked,
  commitChanges,
  abortMerge,
  abortRebase,
  listStashes,
  stashCreate,
  stashPop,
  stashDrop,
  listBranches,
  createBranch,
  checkoutBranch,
  getStagedDiff,
  pullFromRemote,
  pushToRemote,
} from '../git.js'
import { generateCommitMessage } from '../commit-message.js'
import type { GitStatus } from '../../shared/git-types.js'

export function buildGitWriteRouter(sm: SessionManager): Hono {
  const app = new Hono()

  /** Resolve session + cwd in one go. Throws HttpError on either failure
   *  so the caller can write a one-line route. */
  function getSessionCwd(id: string): string {
    const info = sm.get(id) // throws HttpError(404) on unknown id
    if (!info.cwd) throw new HttpError(400, 'session has no cwd configured')
    return info.cwd
  }

  /** Common fetch: post-write status snapshot. Routes that mutate the
   *  worktree return this so the client doesn't need a separate refetch.
   *  We use the in-repo variant — the write itself already proved the
   *  cwd is a git work tree, so re-probing is wasteful. */
  async function freshStatus(cwd: string): Promise<GitStatus> {
    return getStatusInRepo(cwd)
  }

  // ── File operations ────────────────────────────────────────────────

  app.post('/sessions/:id/git/stage', async (c) => {
    const id = c.req.param('id')
    const cwd = getSessionCwd(id)
    const body = await safeJson<{ paths?: unknown }>(c.req)
    const paths = parsePathsArray(body.paths)
    await stageFiles(cwd, paths)
    sm.broadcastGitStatusChanged(id)
    return c.json({ status: await freshStatus(cwd) })
  })

  app.post('/sessions/:id/git/unstage', async (c) => {
    const id = c.req.param('id')
    const cwd = getSessionCwd(id)
    const body = await safeJson<{ paths?: unknown }>(c.req)
    const paths = parsePathsArray(body.paths)
    await unstageFiles(cwd, paths)
    sm.broadcastGitStatusChanged(id)
    return c.json({ status: await freshStatus(cwd) })
  })

  app.post('/sessions/:id/git/discard', async (c) => {
    const id = c.req.param('id')
    const cwd = getSessionCwd(id)
    const body = await safeJson<{ paths?: unknown; untracked?: unknown; confirm?: unknown }>(c.req)
    if (body.confirm !== true) throw new HttpError(400, 'discard requires confirm:true')
    const paths = parsePathsArray(body.paths)
    if (body.untracked === true) {
      await discardUntracked(cwd, paths)
    } else {
      await discardTracked(cwd, paths)
    }
    sm.broadcastGitStatusChanged(id)
    return c.json({ status: await freshStatus(cwd) })
  })

  // ── Commits ────────────────────────────────────────────────────────

  app.post('/sessions/:id/git/commit', async (c) => {
    const id = c.req.param('id')
    const cwd = getSessionCwd(id)
    const body = await safeJson<{ message?: unknown; amend?: unknown; confirm?: unknown }>(c.req)
    if (typeof body.message !== 'string') {
      throw new HttpError(400, 'message must be a string')
    }
    const amend = body.amend === true
    // Amending rewrites the previous commit's SHA — destructive in the
    // same sense as discard / abort / stash-drop, so gate on confirm:true
    // to match the rest of the write surface. A normal (non-amend)
    // commit doesn't need confirm — it only adds.
    if (amend && body.confirm !== true) {
      throw new HttpError(400, 'amend requires confirm:true')
    }
    await commitChanges(cwd, body.message, amend)
    sm.broadcastGitStatusChanged(id)
    return c.json({ status: await freshStatus(cwd) })
  })

  // ── Conflict abort ────────────────────────────────────────────────

  app.post('/sessions/:id/git/abort-merge', async (c) => {
    const id = c.req.param('id')
    const cwd = getSessionCwd(id)
    const body = await safeJson<{ confirm?: unknown }>(c.req)
    if (body.confirm !== true) throw new HttpError(400, 'abort-merge requires confirm:true')
    await abortMerge(cwd)
    sm.broadcastGitStatusChanged(id)
    return c.json({ status: await freshStatus(cwd) })
  })

  app.post('/sessions/:id/git/abort-rebase', async (c) => {
    const id = c.req.param('id')
    const cwd = getSessionCwd(id)
    const body = await safeJson<{ confirm?: unknown }>(c.req)
    if (body.confirm !== true) throw new HttpError(400, 'abort-rebase requires confirm:true')
    await abortRebase(cwd)
    sm.broadcastGitStatusChanged(id)
    return c.json({ status: await freshStatus(cwd) })
  })

  // ── Stash ─────────────────────────────────────────────────────────

  app.get('/sessions/:id/git/stashes', async (c) => {
    const id = c.req.param('id')
    const cwd = getSessionCwd(id)
    return c.json({ stashes: await listStashes(cwd) })
  })

  app.post('/sessions/:id/git/stash', async (c) => {
    const id = c.req.param('id')
    const cwd = getSessionCwd(id)
    const body = await safeJson<{ message?: unknown; includeUntracked?: unknown }>(c.req)
    const message = typeof body.message === 'string' ? body.message : undefined
    const includeUntracked = body.includeUntracked === true
    await stashCreate(cwd, message, includeUntracked)
    sm.broadcastGitStatusChanged(id)
    const [status, stashes] = await Promise.all([freshStatus(cwd), listStashes(cwd)])
    return c.json({ status, stashes })
  })

  app.post('/sessions/:id/git/stash-pop', async (c) => {
    const id = c.req.param('id')
    const cwd = getSessionCwd(id)
    const body = await safeJson<{ index?: unknown }>(c.req)
    if (typeof body.index !== 'number' || !Number.isInteger(body.index) || body.index < 0) {
      throw new HttpError(400, 'index must be a non-negative integer')
    }
    await stashPop(cwd, body.index)
    sm.broadcastGitStatusChanged(id)
    const [status, stashes] = await Promise.all([freshStatus(cwd), listStashes(cwd)])
    return c.json({ status, stashes })
  })

  app.post('/sessions/:id/git/stash-drop', async (c) => {
    const id = c.req.param('id')
    const cwd = getSessionCwd(id)
    const body = await safeJson<{ index?: unknown; confirm?: unknown }>(c.req)
    if (body.confirm !== true) throw new HttpError(400, 'stash-drop requires confirm:true')
    if (typeof body.index !== 'number' || !Number.isInteger(body.index) || body.index < 0) {
      throw new HttpError(400, 'index must be a non-negative integer')
    }
    await stashDrop(cwd, body.index)
    sm.broadcastGitStatusChanged(id)
    return c.json({ stashes: await listStashes(cwd) })
  })

  // ── Branches ──────────────────────────────────────────────────────

  app.get('/sessions/:id/git/branches', async (c) => {
    const id = c.req.param('id')
    const cwd = getSessionCwd(id)
    return c.json({ branches: await listBranches(cwd) })
  })

  app.post('/sessions/:id/git/branch', async (c) => {
    const id = c.req.param('id')
    const cwd = getSessionCwd(id)
    const body = await safeJson<{ name?: unknown; checkout?: unknown; autoStash?: unknown }>(c.req)
    if (typeof body.name !== 'string') throw new HttpError(400, 'name must be a string')
    const checkout = body.checkout === true
    const autoStash = body.autoStash === true
    const result = await createBranch(cwd, body.name, checkout, autoStash)
    sm.broadcastGitStatusChanged(id)
    const [status, branches] = await Promise.all([freshStatus(cwd), listBranches(cwd)])
    return c.json({ status, branches, stashed: result.stashed })
  })

  app.post('/sessions/:id/git/checkout', async (c) => {
    const id = c.req.param('id')
    const cwd = getSessionCwd(id)
    const body = await safeJson<{ branch?: unknown; autoStash?: unknown }>(c.req)
    if (typeof body.branch !== 'string') throw new HttpError(400, 'branch must be a string')
    const autoStash = body.autoStash === true
    const result = await checkoutBranch(cwd, body.branch, autoStash)
    sm.broadcastGitStatusChanged(id)
    const [status, branches] = await Promise.all([freshStatus(cwd), listBranches(cwd)])
    return c.json({ status, branches, stashed: result.stashed })
  })

  app.post('/sessions/:id/git/commit-message', async (c) => {
    // Generates a Conventional Commit message from the *staged* diff —
    // i.e. exactly what would land in the next `git commit`.
    const id = c.req.param('id')
    const cwd = getSessionCwd(id)
    const { text } = await getStagedDiff(cwd)
    if (!text.trim()) {
      throw new HttpError(400, 'nothing staged — stage some changes first')
    }
    // generateCommitMessage handles its own fallback path so an
    // unconfigured authToken or unreachable API doesn't surface as a
    // 500 — the caller always gets a usable message.
    const result = await generateCommitMessage(text)
    return c.json(result)
  })

  app.post('/sessions/:id/git/pull', async (c) => {
    const id = c.req.param('id')
    const cwd = getSessionCwd(id)
    const result = await pullFromRemote(cwd)
    sm.broadcastGitStatusChanged(id)
    const [status, branches] = await Promise.all([freshStatus(cwd), listBranches(cwd)])
    return c.json({ status, branches, updated: result.updated })
  })

  app.post('/sessions/:id/git/push', async (c) => {
    const id = c.req.param('id')
    const cwd = getSessionCwd(id)
    const body = await safeJson<{ force?: unknown; confirm?: unknown }>(c.req)
    const force = body.force === true
    if (force && body.confirm !== true) {
      throw new HttpError(400, 'force push requires confirm:true')
    }
    await pushToRemote(cwd, force)
    sm.broadcastGitStatusChanged(id)
    const [status, branches] = await Promise.all([freshStatus(cwd), listBranches(cwd)])
    return c.json({ status, branches })
  })

  return app
}

/** Validate the `paths` field of a write-op body. Refuses non-arrays,
 *  non-string elements, and empty arrays. The git-layer functions
 *  apply the per-path security rules; this is just shape validation. */
function parsePathsArray(value: unknown): string[] {
  if (!Array.isArray(value)) throw new HttpError(400, 'paths must be an array of strings')
  if (value.length === 0) throw new HttpError(400, 'paths must not be empty')
  if (value.length > 1000) throw new HttpError(400, 'too many paths in one request')
  for (const p of value) {
    if (typeof p !== 'string') throw new HttpError(400, 'each path must be a string')
  }
  return value as string[]
}
