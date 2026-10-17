// Tests for the open-path routes (reveal a session cwd in Finder / open it
// in Terminal on the SERVER machine — the machine where the project files
// actually live).
//
// The security-critical property is the per-request loopback gate: a client
// connecting over the LAN (remoteAddress ≠ loopback) must get 403 and must
// never cause a process spawn, even with a valid path. The spawn itself is
// mocked (node:child_process) and the OS is mocked (node:os) so every
// platform branch is exercisable; path validation uses the real fs against
// a throwaway temp dir.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'

const { execFileMock, platformMock } = vi.hoisted(() => ({
  execFileMock: vi.fn<(file: string, args: string[], opts: unknown, cb: (err: Error | null) => void) => void>(),
  platformMock: vi.fn<() => string>(),
}))

vi.mock('node:child_process', () => ({ execFile: execFileMock }))
vi.mock('node:os', () => ({ platform: platformMock }))

// Import the router AFTER the mocks are registered.
const { buildOpenPathRouter } = await import('./open-path.js')
const { createErrorHandler } = await import('../errors.js')

function makeApp() {
  const app = new Hono()
  app.onError(createErrorHandler('[test]'))
  app.route('/', buildOpenPathRouter())
  return app
}

/** Simulate a Hono request arriving over a socket with the given peer
 *  address (mirrors what @hono/node-server puts on c.env.incoming). */
function req(app: Hono, method: string, path: string, body?: unknown, remoteAddress?: string) {
  const env = remoteAddress === undefined ? undefined : { incoming: { socket: { remoteAddress } } }
  return app.request(
    path,
    body === undefined
      ? { method }
      : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    env,
  )
}

let tmpDir: string

beforeEach(async () => {
  execFileMock.mockReset()
  platformMock.mockReset()
  platformMock.mockReturnValue('darwin')
  execFileMock.mockImplementation((_file, _args, _opts, cb) => cb(null))
  tmpDir = await mkdtemp('/tmp/open-path-test-')
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('GET /open-path/capability', () => {
  it('reports local for in-process requests (no socket env)', async () => {
    const res = await req(makeApp(), 'GET', '/open-path/capability')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ local: true })
  })

  it('reports local for loopback peers', async () => {
    const app = makeApp()
    for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      const res = await req(app, 'GET', '/open-path/capability', undefined, addr)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ local: true })
    }
  })

  it('reports non-local for LAN peers', async () => {
    for (const addr of ['192.168.1.5', '::ffff:192.168.1.5', 'fe80::1']) {
      const res = await req(makeApp(), 'GET', '/open-path/capability', undefined, addr)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ local: false })
    }
  })
})

describe('POST /open-path', () => {
  it('403s a remote peer without spawning anything', async () => {
    const res = await req(
      makeApp(),
      'POST',
      '/open-path',
      { path: tmpDir, target: 'finder' },
      '192.168.1.5',
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ reason: 'non_local' })
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('rejects a non-object body', async () => {
    const app = makeApp()
    // safeJson rejects JSON scalars (not objects) with 400...
    const scalar = await app.request('/open-path', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '5',
    })
    expect(scalar.status).toBe(400)
    // ...and a POST with no JSON content-type with 415 (request-guard).
    const missing = await req(app, 'POST', '/open-path', undefined, '127.0.0.1')
    expect(missing.status).toBe(415)
  })

  it('rejects an unknown target', async () => {
    const res = await req(
      makeApp(),
      'POST',
      '/open-path',
      { path: tmpDir, target: 'browser' },
      '127.0.0.1',
    )
    expect(res.status).toBe(400)
  })

  it('rejects a relative path', async () => {
    const res = await req(
      makeApp(),
      'POST',
      '/open-path',
      { path: 'relative/dir', target: 'finder' },
      '127.0.0.1',
    )
    expect(res.status).toBe(400)
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('rejects a non-existent path', async () => {
    const res = await req(
      makeApp(),
      'POST',
      '/open-path',
      { path: tmpDir + '/does-not-exist', target: 'finder' },
      '127.0.0.1',
    )
    expect(res.status).toBe(400)
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('rejects a path that is a file, not a directory', async () => {
    const file = tmpDir + '/file.txt'
    await writeFile(file, 'hi')
    const res = await req(makeApp(), 'POST', '/open-path', { path: file, target: 'finder' }, '127.0.0.1')
    expect(res.status).toBe(400)
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('spawns `open -R` for finder on darwin', async () => {
    const res = await req(makeApp(), 'POST', '/open-path', { path: tmpDir, target: 'finder' }, '127.0.0.1')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(execFileMock).toHaveBeenCalledWith('open', ['-R', tmpDir], expect.anything(), expect.anything())
  })

  it('spawns `open -a Terminal` for terminal on darwin', async () => {
    const res = await req(makeApp(), 'POST', '/open-path', { path: tmpDir, target: 'terminal' }, '127.0.0.1')
    expect(res.status).toBe(200)
    expect(execFileMock).toHaveBeenCalledWith(
      'open',
      ['-a', 'Terminal', tmpDir],
      expect.anything(),
      expect.anything(),
    )
  })

  it('spawns xdg-open / x-terminal-emulator on linux', async () => {
    platformMock.mockReturnValue('linux')
    const app = makeApp()
    await req(app, 'POST', '/open-path', { path: tmpDir, target: 'finder' }, '127.0.0.1')
    expect(execFileMock).toHaveBeenCalledWith('xdg-open', [tmpDir], expect.anything(), expect.anything())
    await req(app, 'POST', '/open-path', { path: tmpDir, target: 'terminal' }, '127.0.0.1')
    expect(execFileMock).toHaveBeenCalledWith(
      'x-terminal-emulator',
      [`--working-directory=${tmpDir}`],
      expect.anything(),
      expect.anything(),
    )
  })

  it('spawns explorer / wt on win32', async () => {
    platformMock.mockReturnValue('win32')
    const app = makeApp()
    await req(app, 'POST', '/open-path', { path: tmpDir, target: 'finder' }, '127.0.0.1')
    expect(execFileMock).toHaveBeenCalledWith('explorer', [tmpDir], expect.anything(), expect.anything())
    await req(app, 'POST', '/open-path', { path: tmpDir, target: 'terminal' }, '127.0.0.1')
    expect(execFileMock).toHaveBeenCalledWith('wt', ['-d', tmpDir], expect.anything(), expect.anything())
  })

  it('treats explorer exit code 1 as success (documented explorer.exe quirk)', async () => {
    platformMock.mockReturnValue('win32')
    execFileMock.mockImplementation((_f, _a, _o, cb) => {
      const err = new Error('exited with code 1') as Error & { code: number }
      err.code = 1
      cb(err)
    })
    const res = await req(makeApp(), 'POST', '/open-path', { path: tmpDir, target: 'finder' }, '127.0.0.1')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('falls through the linux terminal candidates on ENOENT', async () => {
    platformMock.mockReturnValue('linux')
    const spawned: string[] = []
    execFileMock.mockImplementation((file, _args, _opts, cb) => {
      spawned.push(file as string)
      if (file === 'x-terminal-emulator') {
        const err = new Error('spawn ENOENT') as Error & { code: string }
        err.code = 'ENOENT'
        cb(err)
      } else {
        cb(null)
      }
    })
    const res = await req(makeApp(), 'POST', '/open-path', { path: tmpDir, target: 'terminal' }, '127.0.0.1')
    expect(res.status).toBe(200)
    expect(spawned).toEqual(['x-terminal-emulator', 'gnome-terminal'])
  })

  it('does not fall through on a non-ENOENT failure', async () => {
    platformMock.mockReturnValue('linux')
    const spawned: string[] = []
    execFileMock.mockImplementation((file, _args, _opts, cb) => {
      spawned.push(file as string)
      const err = new Error('launch failed') as Error & { code: number }
      err.code = 126
      cb(err)
    })
    const res = await req(makeApp(), 'POST', '/open-path', { path: tmpDir, target: 'terminal' }, '127.0.0.1')
    expect(res.status).toBe(500)
    expect(spawned).toEqual(['x-terminal-emulator'])
  })

  it('rejects a loopback-socket request whose Host header is not loopback (DNS rebinding)', async () => {
    const app = makeApp()
    const res = await app.request('/open-path', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'evil.example.com' },
      body: JSON.stringify({ path: tmpDir, target: 'finder' }),
    })
    expect(res.status).toBe(403)
    expect(execFileMock).not.toHaveBeenCalled()
    const cap = await app.request('/open-path/capability', { headers: { host: 'evil.example.com' } })
    expect(await cap.json()).toEqual({ local: false })
  })

  it('accepts loopback Host headers with a port and [::1]', async () => {
    const app = makeApp()
    for (const host of ['localhost:3456', '127.0.0.1:3456', '[::1]:3456']) {
      const raw = await app.request('/open-path/capability', { headers: { host } })
      expect(await raw.json()).toEqual({ local: true })
    }
  })

  it('translates a spawn failure into a 500 with the OS message', async () => {
    execFileMock.mockImplementation((_f, _a, _o, cb) => cb(new Error('No application knows how to open')))
    const res = await req(makeApp(), 'POST', '/open-path', { path: tmpDir, target: 'finder' }, '127.0.0.1')
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('No application')
  })
})
