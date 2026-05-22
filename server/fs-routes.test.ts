import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildFsRouter } from './fs-routes.js'
import { tempDir, json } from './__test-utils__/index.js'

describe('fs-routes', () => {
  let dir: string

  beforeEach(() => {
    dir = tempDir('fs')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  describe('GET /home', () => {
    it('returns home, cwd, and sep', async () => {
      const app = buildFsRouter()
      const res = await app.request('/home')
      expect(res.status).toBe(200)
      const body = await json(res)
      expect(body).toHaveProperty('home')
      expect(body).toHaveProperty('cwd')
      expect(body).toHaveProperty('sep')
      expect(typeof body.home).toBe('string')
      expect(typeof body.cwd).toBe('string')
    })
  })

  describe('GET /list', () => {
    it('returns 400 when path param is missing', async () => {
      const app = buildFsRouter()
      const res = await app.request('/list')
      expect(res.status).toBe(400)
      const body = await json(res)
      expect(body.error).toContain('path')
    })

    it('returns 400 for relative path', async () => {
      const app = buildFsRouter()
      const res = await app.request('/list?path=relative/path')
      expect(res.status).toBe(400)
      const body = await json(res)
      expect(body.error).toContain('absolute')
    })

    it('returns 404 for non-existent directory', async () => {
      const app = buildFsRouter()
      const res = await app.request(`/list?path=${join(dir, 'nope')}`)
      expect(res.status).toBe(404)
    })

    it('returns 400 when path is a file, not a directory', async () => {
      writeFileSync(join(dir, 'file.txt'), 'hi')
      const app = buildFsRouter()
      const res = await app.request(`/list?path=${join(dir, 'file.txt')}`)
      expect(res.status).toBe(400)
      const body = await json(res)
      expect(body.error).toContain('directory')
    })

    it('lists subdirectories', async () => {
      mkdirSync(join(dir, 'alpha'))
      mkdirSync(join(dir, 'beta'))
      writeFileSync(join(dir, 'ignored.txt'), 'file')
      const app = buildFsRouter()
      const res = await app.request(`/list?path=${dir}`)
      expect(res.status).toBe(200)
      const body = await json(res)
      expect(body.path).toBe(dir)
      const entries = body.entries as Array<{ name: string; isDir: boolean }>
      expect(entries).toHaveLength(2)
      expect(entries.map((e) => e.name).sort()).toEqual(['alpha', 'beta'])
      expect(entries.every((e) => e.isDir === true)).toBe(true)
    })

    it('hides hidden dirs by default', async () => {
      mkdirSync(join(dir, '.hidden'))
      mkdirSync(join(dir, 'visible'))
      const app = buildFsRouter()
      const res = await app.request(`/list?path=${dir}`)
      const body = await json(res)
      const entries = body.entries as Array<{ name: string }>
      expect(entries).toHaveLength(1)
      expect(entries[0].name).toBe('visible')
    })

    it('shows hidden dirs when ?hidden=1', async () => {
      mkdirSync(join(dir, '.hidden'))
      mkdirSync(join(dir, 'visible'))
      const app = buildFsRouter()
      const res = await app.request(`/list?path=${dir}&hidden=1`)
      const body = await json(res)
      const entries = body.entries as unknown[]
      expect(entries).toHaveLength(2)
    })

    it('includes parent path for non-root directories', async () => {
      const app = buildFsRouter()
      const res = await app.request(`/list?path=${dir}`)
      const body = await json(res)
      expect(body.parent).toBeTruthy()
    })

    it('returns null parent for filesystem root', async () => {
      const app = buildFsRouter()
      const res = await app.request('/list?path=/')
      const body = await json(res)
      expect(body.parent).toBeNull()
    })
  })

  describe('GET /resolve-cwd', () => {
    it('returns 400 when path param is missing', async () => {
      const app = buildFsRouter()
      const res = await app.request('/resolve-cwd')
      expect(res.status).toBe(400)
    })

    it('returns 400 for relative path', async () => {
      const app = buildFsRouter()
      const res = await app.request('/resolve-cwd?path=relative')
      expect(res.status).toBe(400)
    })

    it('resolves a directory path as-is', async () => {
      const app = buildFsRouter()
      const res = await app.request(`/resolve-cwd?path=${dir}`)
      expect(res.status).toBe(200)
      const body = await json(res)
      expect(body.cwd).toBe(dir)
      expect(body.resolvedFromFile).toBe(false)
    })

    it('resolves a file path to its parent directory', async () => {
      const file = join(dir, 'file.txt')
      writeFileSync(file, 'content')
      const app = buildFsRouter()
      const res = await app.request(`/resolve-cwd?path=${file}`)
      expect(res.status).toBe(200)
      const body = await json(res)
      expect(body.cwd).toBe(dir)
      expect(body.resolvedFromFile).toBe(true)
    })

    it('returns 404 for non-existent path', async () => {
      const app = buildFsRouter()
      const res = await app.request(`/resolve-cwd?path=${join(dir, 'nope')}`)
      expect(res.status).toBe(404)
    })
  })
})
