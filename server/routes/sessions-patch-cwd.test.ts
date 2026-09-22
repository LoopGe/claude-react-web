// PATCH /sessions/:id — relocate a session's workspace (cwd).
//
// A moved/deleted project directory is the real cause behind the misleading
// "claude CLI binary not found (ENOENT)" resume failure. The user needs a
// supported way to point an existing session at the project's new home
// instead of hand-editing sessions.json (which a live server overwrites).

import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildSessionRouter } from './sessions.js'
import type { SessionManager } from '../session-manager.js'
import { rmRf } from '../__test-utils__/index.js'

function makeApp() {
  const sm = {
    list: vi.fn(() => []),
    rename: vi.fn((_id: string, title: string) => ({ id: 's1', title })),
    setCwd: vi.fn((_id: string, cwd: string) => ({ id: 's1', cwd })),
  }
  return { app: buildSessionRouter(sm as unknown as SessionManager), sm }
}

function patch(body: unknown) {
  return {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

describe('PATCH /sessions/:id cwd', () => {
  it('accepts cwd alone and forwards it to sm.setCwd', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crw-patch-cwd-'))
    try {
      const next = join(dir, 'moved', 'web')
      mkdirSync(next, { recursive: true })
      const { app, sm } = makeApp()
      const res = await app.request('/sessions/s1', patch({ cwd: next }))
      expect(res.status).toBe(200)
      const body = (await res.json()) as { session: { cwd?: string } }
      expect(body.session.cwd).toBe(next)
      expect(sm.setCwd).toHaveBeenCalledWith('s1', next)
      expect(sm.rename).not.toHaveBeenCalled()
    } finally {
      rmRf(dir)
    }
  })

  it('400s when the new cwd does not exist on disk', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions/s1', patch({ cwd: '/definitely/not/a/real/dir-xyz' }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: expect.stringMatching(/Working directory not found/),
    })
    expect(sm.setCwd).not.toHaveBeenCalled()
  })

  it('still accepts title-only patches via sm.rename', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions/s1', patch({ title: 'New name' }))
    expect(res.status).toBe(200)
    expect(sm.rename).toHaveBeenCalledWith('s1', 'New name')
    expect(sm.setCwd).not.toHaveBeenCalled()
  })

  it('400s when neither title nor cwd is provided', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions/s1', patch({}))
    expect(res.status).toBe(400)
    expect(sm.rename).not.toHaveBeenCalled()
    expect(sm.setCwd).not.toHaveBeenCalled()
  })
})
