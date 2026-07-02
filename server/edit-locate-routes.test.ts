import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildEditLocateRouter } from './edit-locate-routes.js'
import { tempDir, json } from './__test-utils__/index.js'

describe('edit-locate-routes', () => {
  let dir: string

  beforeEach(() => {
    dir = tempDir('edit-locate')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  function post(app: ReturnType<typeof buildEditLocateRouter>, body: unknown) {
    return app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  describe('input validation', () => {
    it('400 when body is not JSON', async () => {
      const app = buildEditLocateRouter()
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not-json',
      })
      expect(res.status).toBe(400)
    })

    it('400 when cwd is not absolute', async () => {
      const app = buildEditLocateRouter()
      const res = await post(app, { cwd: 'relative', path: 'x', anchors: [{ old: 'a', new: 'b' }] })
      expect(res.status).toBe(400)
      const body = await json(res)
      expect(body.error).toMatch(/absolute/i)
    })

    it('400 when path is missing', async () => {
      const app = buildEditLocateRouter()
      const res = await post(app, { cwd: dir, anchors: [{ old: 'a', new: 'b' }] })
      expect(res.status).toBe(400)
    })

    it('400 when anchors is empty', async () => {
      const app = buildEditLocateRouter()
      const res = await post(app, { cwd: dir, path: 'foo', anchors: [] })
      expect(res.status).toBe(400)
    })
  })

  describe('path safety (issue #2)', () => {
    it('rejects absolute path outside cwd', async () => {
      const app = buildEditLocateRouter()
      // Use /etc/passwd-style path — must be an absolute path guaranteed to
      // exist outside `dir`. The parent of the tempdir works on any OS.
      const outsidePath = '/etc/hosts'
      const res = await post(app, {
        cwd: dir,
        path: outsidePath,
        anchors: [{ old: 'a', new: 'b' }],
      })
      expect(res.status).toBe(400)
      const body = await json(res)
      expect(body.error).toMatch(/within cwd/i)
    })

    it('rejects relative path escaping cwd via ..', async () => {
      const app = buildEditLocateRouter()
      const res = await post(app, {
        cwd: dir,
        path: '../../../../etc/hosts',
        anchors: [{ old: 'a', new: 'b' }],
      })
      expect(res.status).toBe(400)
      const body = await json(res)
      expect(body.error).toMatch(/within cwd/i)
    })

    it('accepts relative path inside cwd', async () => {
      writeFileSync(join(dir, 'file.txt'), 'line1\nHELLO\nline3\n')
      const app = buildEditLocateRouter()
      const res = await post(app, {
        cwd: dir,
        path: 'file.txt',
        anchors: [{ old: 'HELLO', new: 'WORLD' }],
      })
      expect(res.status).toBe(200)
      const body = await json(res)
      const results = body.results as Array<{ hunks: unknown }>
      expect(results[0].hunks).not.toBeNull()
    })

    it('accepts absolute path inside cwd', async () => {
      writeFileSync(join(dir, 'file.txt'), 'line1\nHELLO\nline3\n')
      const app = buildEditLocateRouter()
      const res = await post(app, {
        cwd: dir,
        path: join(dir, 'file.txt'),
        anchors: [{ old: 'HELLO', new: 'WORLD' }],
      })
      expect(res.status).toBe(200)
      const body = await json(res)
      const results = body.results as Array<{ hunks: unknown }>
      expect(results[0].hunks).not.toBeNull()
    })

    it('accepts nested subdirectory path inside cwd', async () => {
      mkdirSync(join(dir, 'sub'))
      writeFileSync(join(dir, 'sub', 'file.txt'), 'line1\nHELLO\nline3\n')
      const app = buildEditLocateRouter()
      const res = await post(app, {
        cwd: dir,
        path: 'sub/file.txt',
        anchors: [{ old: 'HELLO', new: 'WORLD' }],
      })
      expect(res.status).toBe(200)
      const body = await json(res)
      const results = body.results as Array<{ hunks: unknown }>
      expect(results[0].hunks).not.toBeNull()
    })
  })

  describe('anchor resolution', () => {
    it('returns hunks: null when file is missing', async () => {
      const app = buildEditLocateRouter()
      const res = await post(app, {
        cwd: dir,
        path: 'missing.txt',
        anchors: [{ old: 'a', new: 'b' }],
      })
      expect(res.status).toBe(200)
      const body = await json(res)
      const results = body.results as Array<{ hunks: unknown }>
      expect(results[0].hunks).toBeNull()
    })

    it('returns hunks: null when neither old nor new is uniquely present', async () => {
      writeFileSync(join(dir, 'f.txt'), 'HELLO\nHELLO\n')
      const app = buildEditLocateRouter()
      const res = await post(app, {
        cwd: dir,
        path: 'f.txt',
        anchors: [{ old: 'HELLO', new: 'WORLD' }],
      })
      expect(res.status).toBe(200)
      const body = await json(res)
      const results = body.results as Array<{ hunks: unknown }>
      expect(results[0].hunks).toBeNull()
    })

    it('returns real line numbers for applied edit (new uniquely present)', async () => {
      writeFileSync(join(dir, 'f.txt'), 'a\nb\nc\nAFTER\ne\nf\ng\n')
      const app = buildEditLocateRouter()
      const res = await post(app, {
        cwd: dir,
        path: 'f.txt',
        anchors: [{ old: 'BEFORE', new: 'AFTER' }],
      })
      expect(res.status).toBe(200)
      const body = await json(res)
      const results = body.results as Array<{ hunks: Array<{ oldStart: number; newStart: number; lines: string[] }> }>
      const hunk = results[0].hunks[0]
      expect(hunk.oldStart).toBeGreaterThan(0)
      expect(hunk.newStart).toBeGreaterThan(0)
      // The hunk should include a '-BEFORE' line and a '+AFTER' line
      expect(hunk.lines.some((l) => l === '-BEFORE')).toBe(true)
      expect(hunk.lines.some((l) => l === '+AFTER')).toBe(true)
    })
  })
})
