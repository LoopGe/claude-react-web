import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { rmRf } from '../__test-utils__/index.js'
import { cleanupGitFixtures, makeRepo, mkdtempUnderTmp } from '../test-git-fixtures.js'
import type { SessionManager } from '../session-manager.js'
import { buildSessionRouter } from './sessions.js'
import { provisionWorktree, worktreePathFor } from '../session-worktree.js'
import { HttpError } from '../errors.js'
import type { SessionInfo } from '../../src/types.js'

// Route test for GET /sessions/:id/worktree-status — the dirty-check behind
// the delete confirmation. The sm stub mirrors the other session-route tests
// (enough surface for one route); the worktree itself is REAL (provisioned
// through the same session-worktree module sm.create uses), so the git dirty
// probe runs against an actual linked worktree.

function makeApp(stateDir: string, info: Partial<SessionInfo> & { id: string }) {
  const sm = {
    get: vi.fn((id: string) => {
      if (id !== info.id) throw new HttpError(404, `session not found: ${id}`)
      return info
    }),
  }
  return { app: buildSessionRouter(sm as unknown as SessionManager, undefined, undefined, stateDir), sm }
}

async function get(app: { request: (path: string) => Response | Promise<Response> }, id: string) {
  const res = await app.request(`/sessions/${id}/worktree-status`)
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

describe('GET /sessions/:id/worktree-status', () => {
  let stateDir: string
  let repo: string

  beforeEach(async () => {
    stateDir = await mkdtempUnderTmp('crw-wt-route-state-')
    repo = await makeRepo()
  })
  afterEach(async () => {
    await rmRf(stateDir)
  })
  afterAll(async () => {
    await cleanupGitFixtures()
  })

  function sessionWithWorktree(id: string): SessionInfo {
    // SessionInfo carries `worktree` straight from the persisted meta for a
    // dormant session; the stub mirrors that (worktreePath is the same
    // worktreePathFor(stateDir, id) the provisioner created).
    return { id, worktree: { mainRepoPath: repo, branch: `crw/${id}`, baseSha: 'stub' } } as SessionInfo
  }

  it('reports unavailable for a session without worktree metadata', async () => {
    const { app } = makeApp(stateDir, { id: 's1' })
    const { status, body } = await get(app, 's1')
    expect(status).toBe(200)
    expect(body).toEqual({ available: false })
  })

  it('reports a clean worktree with branch and mainRepoPath', async () => {
    const prov = await provisionWorktree(stateDir, 's2', repo)
    const { app } = makeApp(stateDir, {
      id: 's2',
      worktree: { mainRepoPath: repo, branch: prov.branch, baseSha: prov.baseSha },
    })
    const { status, body } = await get(app, 's2')
    expect(status).toBe(200)
    expect(body).toEqual({
      available: true,
      dirty: false,
      branch: prov.branch,
      mainRepoPath: repo,
    })
  })

  it('reports dirty when the worktree holds an untracked file', async () => {
    await provisionWorktree(stateDir, 's3', repo)
    await writeFile(join(worktreePathFor(stateDir, 's3'), 'untracked.txt'), 'new\n')
    const { app } = makeApp(stateDir, sessionWithWorktree('s3'))
    const { body } = await get(app, 's3')
    expect(body).toEqual({
      available: true,
      dirty: true,
      branch: `crw/s3`,
      mainRepoPath: repo,
    })
  })

  it('reports dirty for an inherited worktree whose dir is named after another session', async () => {
    // /clear inheritance: Y (new id) holds X's WorktreeInfo with an explicit
    // path at the X-named dir — the dirty probe must hit THAT dir, not the
    // id-derived one (which does not exist).
    const prov = await provisionWorktree(stateDir, 'inh-cccc-x', repo)
    await writeFile(join(prov.worktreePath, 'untracked.txt'), 'new\n')
    const { app } = makeApp(stateDir, {
      id: 'inh-cccc-y',
      worktree: { mainRepoPath: repo, branch: prov.branch, baseSha: prov.baseSha, path: prov.worktreePath },
    })
    const { body } = await get(app, 'inh-cccc-y')
    expect(body).toEqual({
      available: true,
      dirty: true,
      branch: prov.branch,
      mainRepoPath: repo,
    })
  })

  it('reports dirty for a legacy path-less inherited meta via the session cwd', async () => {
    // Pre-`path` era /clear inheritance: Y's WorktreeInfo has no recorded
    // path, but Y's cwd IS the X-named dir — the dirty probe must resolve
    // through the cwd hint, not the id-derived path (which does not exist).
    const prov = await provisionWorktree(stateDir, 'inh-dddd-x', repo)
    await writeFile(join(prov.worktreePath, 'untracked.txt'), 'new\n')
    const { app } = makeApp(stateDir, {
      id: 'inh-dddd-y',
      cwd: prov.worktreePath,
      worktree: { mainRepoPath: repo, branch: prov.branch, baseSha: prov.baseSha },
    } as SessionInfo)
    const { body } = await get(app, 'inh-dddd-y')
    expect(body).toEqual({
      available: true,
      dirty: true,
      branch: prov.branch,
      mainRepoPath: repo,
    })
  })

  it('reports unavailable when the worktree dir no longer exists', async () => {
    await provisionWorktree(stateDir, 's4', repo)
    await rmRf(worktreePathFor(stateDir, 's4'))
    const { app } = makeApp(stateDir, sessionWithWorktree('s4'))
    const { body } = await get(app, 's4')
    expect(body).toEqual({ available: false })
  })

  it('reports unavailable (not 500) when the worktree dir is broken (.git file deleted)', async () => {
    await provisionWorktree(stateDir, 's5', repo)
    // The dirty probe shells out to git inside the worktree; with its .git
    // file gone git fails — the delete confirmation must degrade to the
    // plain dialog instead of 500ing.
    await rmRf(join(worktreePathFor(stateDir, 's5'), '.git'))
    const { app } = makeApp(stateDir, sessionWithWorktree('s5'))
    const { status, body } = await get(app, 's5')
    expect(status).toBe(200)
    expect(body).toEqual({ available: false })
  })
})
