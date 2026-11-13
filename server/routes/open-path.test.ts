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
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'

type SpawnChild = EventEmitter & { unref: () => void }

const { execFileMock, spawnMock, platformMock } = vi.hoisted(() => ({
  execFileMock: vi.fn<(file: string, args: string[], opts: unknown, cb: (err: Error | null) => void) => void>(),
  spawnMock: vi.fn<(file: string, args: string[], opts: unknown) => SpawnChild>(),
  platformMock: vi.fn<() => string>(),
}))

vi.mock('node:child_process', () => ({ execFile: execFileMock, spawn: spawnMock }))
vi.mock('node:os', () => ({ platform: platformMock, homedir: () => '/home/test-user' }))

// Import the router AFTER the mocks are registered.
const { buildOpenPathRouter, availableAppsFor } = await import('./open-path.js')
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

function stubSpawnEvent(event: 'spawn' | 'error', error?: Error) {
  spawnMock.mockImplementation(() => {
    const child = new EventEmitter() as SpawnChild
    child.unref = vi.fn()
    process.nextTick(() => {
      if (event !== 'error' || child.listenerCount('error') > 0) child.emit(event, error)
    })
    return child
  })
}

beforeEach(async () => {
  execFileMock.mockReset()
  spawnMock.mockReset()
  platformMock.mockReset()
  platformMock.mockReturnValue('darwin')
  execFileMock.mockImplementation((_file, _args, _opts, cb) => cb(null))
  stubSpawnEvent('spawn')
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
      { path: tmpDir, target: 'editor' },
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

  it('opens an HTML file as an encoded file URL in the default browser', async () => {
    const file = `${tmpDir}/page #1.html`
    await writeFile(file, '<h1>Hello</h1>')

    const res = await req(makeApp(), 'POST', '/open-path', { path: file, target: 'browser' }, '127.0.0.1')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [command, args, options] = spawnMock.mock.calls[0]
    expect(command).toBe('open')
    expect(args).toHaveLength(1)
    expect(args[0]).toMatch(/^file:\/\/\//)
    expect(args[0].endsWith('/page%20%231.html')).toBe(true)
    expect(args[0]).not.toContain('page #1.html')
    expect(options).toMatchObject({ stdio: 'ignore', detached: true })
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it.each(['page.htm', 'page.HTML', 'page.HTM'])('accepts the HTML extension %s case-insensitively', async (name) => {
    const file = `${tmpDir}/${name}`
    await writeFile(file, '<h1>Hello</h1>')

    const res = await req(makeApp(), 'POST', '/open-path', { path: file, target: 'browser' }, '127.0.0.1')

    expect(res.status).toBe(200)
    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [command, args] = spawnMock.mock.calls[0]
    expect(command).toBe('open')
    expect(args[0].endsWith(`/${name}`)).toBe(true)
  })

  it('rejects non-HTML, missing, relative, and directory browser targets without launching', async () => {
    const textFile = `${tmpDir}/page.txt`
    await writeFile(textFile, 'plain text')
    const htmlDirectory = `${tmpDir}/directory.html`
    await mkdir(htmlDirectory)
    const app = makeApp()

    for (const path of [textFile, `${tmpDir}/missing.html`, 'relative/page.html', htmlDirectory]) {
      const res = await req(app, 'POST', '/open-path', { path, target: 'browser' }, '127.0.0.1')
      expect(res.status).toBe(400)
    }
    expect(execFileMock).not.toHaveBeenCalled()
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('rejects a remote browser launch before touching the OS', async () => {
    const file = `${tmpDir}/page.html`
    await writeFile(file, '<h1>Hello</h1>')

    const res = await req(makeApp(), 'POST', '/open-path', { path: file, target: 'browser' }, '192.168.1.5')

    expect(res.status).toBe(403)
    expect(execFileMock).not.toHaveBeenCalled()
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('rejects a malformed NUL path as an invalid request', async () => {
    const pathWithNul = `${tmpDir}/bad\0.html`

    const res = await req(makeApp(), 'POST', '/open-path', { path: pathWithNul, target: 'browser' }, '127.0.0.1')

    expect(res.status).toBe(400)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('translates a browser spawn failure into a 500 with the OS message', async () => {
    const file = `${tmpDir}/page.html`
    await writeFile(file, '<h1>Hello</h1>')
    stubSpawnEvent('error', new Error('No default browser'))

    const res = await req(makeApp(), 'POST', '/open-path', { path: file, target: 'browser' }, '127.0.0.1')

    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('No default browser')
  })

  it('uses a fixed-argument Windows launcher for a dollar-expression HTML filename', async () => {
    platformMock.mockReturnValue('win32')
    const file = resolve(tmpDir, '$(whoami).html')
    await writeFile(file, '<h1>Safe</h1>')

    const res = await req(makeApp(), 'POST', '/open-path', { path: file, target: 'browser' }, '127.0.0.1')

    expect(res.status).toBe(200)
    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [command, args] = spawnMock.mock.calls[0]
    expect(command).toBe('rundll32')
    expect(args[0]).toBe('url.dll,FileProtocolHandler')
    expect(args[1]).toMatch(/^file:\/\/\//)
    expect(args[1].endsWith('/$(whoami).html')).toBe(true)
  })

  it('uses xdg-open for browser launches on linux', async () => {
    platformMock.mockReturnValue('linux')
    const file = `${tmpDir}/page.html`
    await writeFile(file, '<h1>Hello</h1>')

    const res = await req(makeApp(), 'POST', '/open-path', { path: file, target: 'browser' }, '127.0.0.1')

    expect(res.status).toBe(200)
    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [command, args] = spawnMock.mock.calls[0]
    expect(command).toBe('xdg-open')
    expect(args[0].endsWith('/page.html')).toBe(true)
  })
})

// The editor/terminal brand targets. Candidates are the launch table's rows
// (first existing binary wins at launch time via ENOENT fall-through); the
// /apps probe reuses the same rows' probe descriptors so the menu only
// offers what the server machine can actually launch.
describe('brand targets', () => {
  it('spawns `open -a` for the macOS brand apps', async () => {
    const app = makeApp()
    await req(app, 'POST', '/open-path', { path: tmpDir, target: 'vscode' }, '127.0.0.1')
    expect(execFileMock).toHaveBeenCalledWith(
      'open',
      ['-a', 'Visual Studio Code', tmpDir],
      expect.anything(),
      expect.anything(),
    )
    await req(app, 'POST', '/open-path', { path: tmpDir, target: 'iterm2' }, '127.0.0.1')
    expect(execFileMock).toHaveBeenCalledWith('open', ['-a', 'iTerm', tmpDir], expect.anything(), expect.anything())
    await req(app, 'POST', '/open-path', { path: tmpDir, target: 'zed' }, '127.0.0.1')
    expect(execFileMock).toHaveBeenCalledWith('open', ['-a', 'Zed', tmpDir], expect.anything(), expect.anything())
  })

  it('spawns PATH CLIs for linux brand targets', async () => {
    platformMock.mockReturnValue('linux')
    const app = makeApp()
    for (const target of ['vscode', 'cursor', 'zed']) {
      execFileMock.mockClear()
      await req(app, 'POST', '/open-path', { path: tmpDir, target }, '127.0.0.1')
      expect(execFileMock).toHaveBeenCalledTimes(1)
      const [file, args] = execFileMock.mock.calls[0]!
      expect(file).toBe(target === 'vscode' ? 'code' : target)
      expect(args).toEqual([tmpDir])
    }
  })

  it('expands win32 exe candidates from the environment and never shells out', async () => {
    process.env.LOCALAPPDATA = '/w/LocalAppData'
    process.env.ProgramFiles = '/w/ProgramFiles'
    try {
      platformMock.mockReturnValue('win32')
      const res = await req(makeApp(), 'POST', '/open-path', { path: tmpDir, target: 'vscode' }, '127.0.0.1')
      expect(res.status).toBe(200)
      expect(execFileMock).toHaveBeenCalledWith(
        '/w/LocalAppData/Programs/Microsoft VS Code/Code.exe',
        [tmpDir],
        expect.anything(),
        expect.anything(),
      )
    } finally {
      delete process.env.LOCALAPPDATA
      delete process.env.ProgramFiles
    }
  })

  it('404s a brand target that has no candidates on this platform', async () => {
    platformMock.mockReturnValue('linux')
    const res = await req(makeApp(), 'POST', '/open-path', { path: tmpDir, target: 'iterm2' }, '127.0.0.1')
    expect(res.status).toBe(404)
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('falls through darwin candidates on ENOENT (bundle missing, CLI fallback)', async () => {
    const spawned: string[] = []
    execFileMock.mockImplementation((file, _args, _opts, cb) => {
      spawned.push(file as string)
      if (file === 'open') {
        const err = new Error('not found') as Error & { code: number }
        err.code = 1 // `open -a` reports a missing app as a nonzero exit, not ENOENT
        cb(err)
      } else {
        cb(null)
      }
    })
    const res = await req(makeApp(), 'POST', '/open-path', { path: tmpDir, target: 'vscode' }, '127.0.0.1')
    expect(res.status).toBe(200)
    expect(spawned).toEqual(['open', 'code'])
  })
})

describe('GET /open-path/apps', () => {
  it('returns the availability list shape', async () => {
    const res = await req(makeApp(), 'GET', '/open-path/apps')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { apps: string[] }
    expect(Array.isArray(body.apps)).toBe(true)
    for (const id of body.apps) {
      expect(['vscode', 'cursor', 'zed', 'iterm2', 'windowsterminal']).toContain(id)
    }
  })
})

// Availability probing is a pure function over injected fs facts — the route
// test above only pins the shape, because the real machine's /Applications
// must never leak into expectations.
describe('availableAppsFor', () => {
  // The function is exported for direct unit testing; the route test above
  // only pins the response shape, because the real machine's /Applications
  // must never leak into expectations.

  const noopEnv = Object.freeze({ PATH: '/usr/bin' })

  function deps(
    files: readonly string[] = [],
    dirs: readonly string[] = [],
  ): {
    fileExists: (p: string) => Promise<boolean>
    dirExists: (p: string) => Promise<boolean>
    executableExists: (p: string) => Promise<boolean>
  } {
    return {
      fileExists: async (p) => files.includes(p),
      dirExists: async (p) => dirs.includes(p),
      // Executability defaults to the same fixture set: the tests below that
      // care pin it explicitly.
      executableExists: async (p) => files.includes(p),
    }
  }

  it('detects a macOS bundle in /Applications (bundle + CLI probes)', async () => {
    const apps = await availableAppsFor('darwin', noopEnv, '/home/u', deps([], ['/Applications/Visual Studio Code.app']))
    expect(apps).toContain('vscode')
    // CLI fallback alone also counts: bundle missing, `code` on PATH.
    const cliOnly = await availableAppsFor('darwin', noopEnv, '/home/u', deps(['/usr/bin/code'], []))
    expect(cliOnly).toContain('vscode')
  })

  it('does not offer a macOS app whose bundle and CLI are both absent', async () => {
    const apps = await availableAppsFor('darwin', noopEnv, '/home/u', deps([], []))
    expect(apps).toEqual([])
  })

  it('detects win32 installs via expanded exe paths', async () => {
    const apps = await availableAppsFor(
      'win32',
      Object.freeze({ LOCALAPPDATA: '/w/LocalAppData', PATH: '/w' }),
      '/home/u',
      deps(['/w/LocalAppData/Programs/cursor/Cursor.exe'], []),
    )
    expect(apps).toEqual(['cursor'])
  })

  it('scans PATH for linux CLIs and keeps catalog order', async () => {
    const apps = await availableAppsFor(
      'linux',
      Object.freeze({ PATH: '/opt/bin:/usr/local/bin' }),
      '/home/u',
      deps(['/opt/bin/zed', '/usr/local/bin/code'], []),
    )
    expect(apps).toEqual(['vscode', 'zed'])
  })

  it('never offers windowsterminal off win32', async () => {
    const apps = await availableAppsFor('darwin', noopEnv, '/home/u', deps([], ['/Applications/Visual Studio Code.app']))
    expect(apps).not.toContain('windowsterminal')
  })

  it('does not advertise windowsterminal on win32 (generic terminal is already wt)', async () => {
    // `wt -d` IS the win32 generic-terminal launcher, so a brand row would
    // render two identical menu entries — the id stays POST-valid but /apps
    // never offers it.
    const apps = await availableAppsFor(
      'win32',
      Object.freeze({ LOCALAPPDATA: '/w/LocalAppData', PATH: '/w' }),
      '/home/u',
      deps(['/w/LocalAppData/Programs/cursor/Cursor.exe', '/w/wt.exe'], []),
    )
    expect(apps).toEqual(['cursor'])
  })

  it('requires executability for PATH probes (a stale file does not shadow)', async () => {
    // A non-executable file named `code` on PATH must not make the probe
    // offer vscode (the POST would EACCES and 500 while the real bundle sits
    // untried); executability is a separate injected fact from existence.
    const apps = await availableAppsFor(
      'linux',
      Object.freeze({ PATH: '/opt/bin' }),
      '/home/u',
      {
        fileExists: async () => true,
        dirExists: async () => false,
        executableExists: async (p) => p !== '/opt/bin/code' && p !== '/opt/bin/cursor',
      },
    )
    expect(apps).toEqual(['zed'])
  })
})
