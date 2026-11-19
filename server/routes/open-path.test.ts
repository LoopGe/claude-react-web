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

const { execFileMock, spawnMock, platformMock, extractIconMock } = vi.hoisted(() => ({
  execFileMock: vi.fn<(file: string, args: string[], opts: unknown, cb: (err: Error | null, stdout?: string, stderr?: string) => void) => void>(),
  spawnMock: vi.fn<(file: string, args: string[], opts: unknown) => SpawnChild>(),
  platformMock: vi.fn<() => string>(),
  extractIconMock: vi.fn<(target: string, platform: string) => Promise<{ bytes: Buffer; contentType: string } | null>>(),
}))

vi.mock('node:child_process', () => ({ execFile: execFileMock, spawn: spawnMock }))
vi.mock('node:os', () => ({ platform: platformMock, homedir: () => '/home/test-user' }))
// The extractors run real subprocesses on the host; the route tests mock the
// module boundary and exercise cache/404/gating behavior instead.
vi.mock('../open-path-icons.js', () => ({
  extractTargetIcon: extractIconMock,
  hostIconDeps: { temp: {}, run: vi.fn(), readBytes: vi.fn(), fileExists: vi.fn(), resolveExecutable: vi.fn(), listDir: vi.fn(), env: {}, home: '' },
}))

// Import the router AFTER the mocks are registered.
const { buildOpenPathRouter, availableAppsFor, openCommandsFor } = await import('./open-path.js')
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
      // A short-lived launcher (shell openers, CLI shims) exits right after
      // spawning; the default stub models that so requests settle at once.
      if (event === 'spawn') child.emit('exit', 0, null)
    })
    return child
  })
}

/** A launcher that SPAWNS and then stays alive — the first-instance editor
 *  case (the Electron main process lives as long as its window). `kill` is a
 *  spy so a test can pin that the server never terminates it. */
function stubSpawnLongLived(): { kills: Array<() => void> } {
  const kills: Array<() => void> = []
  spawnMock.mockImplementation(() => {
    const child = new EventEmitter() as SpawnChild & { kill: () => void }
    child.unref = vi.fn()
    child.kill = vi.fn()
    kills.push(child.kill)
    process.nextTick(() => child.emit('spawn'))
    return child
  })
  return { kills }
}


beforeEach(async () => {
  execFileMock.mockReset()
  spawnMock.mockReset()
  extractIconMock.mockReset()
  platformMock.mockReset()
  platformMock.mockReturnValue('darwin')
  execFileMock.mockImplementation((_file, _args, _opts, cb) => cb(null, '', ''))
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
    expect(spawnMock).not.toHaveBeenCalled()
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
    expect(spawnMock).not.toHaveBeenCalled()
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
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('rejects a path that is a file, not a directory', async () => {
    const file = tmpDir + '/file.txt'
    await writeFile(file, 'hi')
    const res = await req(makeApp(), 'POST', '/open-path', { path: file, target: 'finder' }, '127.0.0.1')
    expect(res.status).toBe(400)
    expect(execFileMock).not.toHaveBeenCalled()
    expect(spawnMock).not.toHaveBeenCalled()
  })

  // finder/terminal launchers are OS shell openers: they EXIT by contract
  // (open / explorer / wt / xdg-open / DE terminals), so the request waits
  // for their exit under a timeout — a wedged opener must surface as a
  // failure, not be counted launched and orphaned.
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
    // The Debian alternative's contract is unknown (xterm never exits) → watch.
    expect(spawnMock).toHaveBeenCalledWith(
      'x-terminal-emulator',
      [`--working-directory=${tmpDir}`],
      expect.objectContaining({ detached: true, stdio: 'ignore' }),
    )
  })

  it('spawns explorer / wt on win32', async () => {
    platformMock.mockReturnValue('win32')
    const app = makeApp()
    await req(app, 'POST', '/open-path', { path: tmpDir, target: 'finder' }, '127.0.0.1')
    expect(execFileMock).toHaveBeenCalledWith('explorer', [tmpDir], expect.anything(), expect.anything())
    // wt is NOT exit-by-contract: a first-instance wt.exe IS the terminal
    // window process, so it gets the detached watch, never the timeout kill.
    await req(app, 'POST', '/open-path', { path: tmpDir, target: 'terminal' }, '127.0.0.1')
    expect(spawnMock).toHaveBeenCalledWith('wt', ['-d', tmpDir], expect.objectContaining({ detached: true, stdio: 'ignore' }))
  })

  it('a first-instance terminal (long-lived wt) is never killed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { kills } = stubSpawnLongLived()
    try {
      platformMock.mockReturnValue('win32')
      const pending = req(makeApp(), 'POST', '/open-path', { path: tmpDir, target: 'terminal' }, '127.0.0.1')
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
      await vi.advanceTimersByTimeAsync(1500)
      const res = await pending
      expect(res.status).toBe(200)
      expect(kills).toHaveLength(1)
      expect(kills[0]).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
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

  it('a maxBuffer-killed opener is an output-size failure, not a timeout', async () => {
    execFileMock.mockImplementation((_f, _a, _o, cb) => {
      const err = new Error('stdout maxBuffer length exceeded') as Error & { code: string; killed: boolean }
      err.code = 'ENOBUFS'
      err.killed = true
      cb(err)
    })
    const res = await req(makeApp(), 'POST', '/open-path', { path: tmpDir, target: 'finder' }, '127.0.0.1')
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('maxBuffer')
    expect(body.error).not.toContain('timed out')
  })

  it('a signal-killed launcher reports the signal, not a null exit code', async () => {
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as SpawnChild
      child.unref = vi.fn()
      process.nextTick(() => {
        child.emit('spawn')
        child.emit('exit', null, 'SIGKILL')
      })
      return child
    })
    platformMock.mockReturnValue('linux')
    const res = await req(makeApp(), 'POST', '/open-path', { path: tmpDir, target: 'vscode' }, '127.0.0.1')
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('SIGKILL')
  })

  it('a timeout-killed opener is a failure, not the explorer exit-1 quirk', async () => {
    platformMock.mockReturnValue('win32')
    execFileMock.mockImplementation((_f, _a, _o, cb) => {
      const err = new Error('timed out') as Error & { code: number; killed: boolean }
      err.code = 1 // Windows TerminateProcess surfaces as exit code 1
      err.killed = true
      cb(err)
    })
    const res = await req(makeApp(), 'POST', '/open-path', { path: tmpDir, target: 'finder' }, '127.0.0.1')
    expect(res.status).toBe(500)
  })

  it('falls through the linux terminal candidates on ENOENT', async () => {
    platformMock.mockReturnValue('linux')
    const tried: string[] = []
    // x-terminal-emulator is an unknown alternative (may be a long-lived
    // xterm) → detached watch; gnome-terminal forks and exits → wait.
    spawnMock.mockImplementation((file) => {
      tried.push(file as string)
      const child = new EventEmitter() as SpawnChild
      child.unref = vi.fn()
      process.nextTick(() => {
        const err = new Error('spawn ENOENT') as Error & { code: string }
        err.code = 'ENOENT'
        child.emit('error', err)
      })
      return child
    })
    execFileMock.mockImplementation((file, _args, _opts, cb) => {
      tried.push(file as string)
      cb(null, '', '')
    })
    const res = await req(makeApp(), 'POST', '/open-path', { path: tmpDir, target: 'terminal' }, '127.0.0.1')
    expect(res.status).toBe(200)
    expect(tried).toEqual(['x-terminal-emulator', 'gnome-terminal'])
  })

  it('does not fall through on a non-ENOENT failure', async () => {
    platformMock.mockReturnValue('linux')
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as SpawnChild
      child.unref = vi.fn()
      process.nextTick(() => {
        child.emit('spawn')
        child.emit('exit', 126, null)
      })
      return child
    })
    const res = await req(makeApp(), 'POST', '/open-path', { path: tmpDir, target: 'terminal' }, '127.0.0.1')
    expect(res.status).toBe(500)
    expect(spawnMock).toHaveBeenCalledTimes(1)
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
    expect(spawnMock).not.toHaveBeenCalled()
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
      spawnMock.mockClear()
      await req(app, 'POST', '/open-path', { path: tmpDir, target }, '127.0.0.1')
      expect(spawnMock).toHaveBeenCalledTimes(1)
      const [file, args] = spawnMock.mock.calls[0]!
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
      expect(spawnMock).toHaveBeenCalledWith(
        '/w/LocalAppData/Programs/Microsoft VS Code/Code.exe',
        [tmpDir],
        expect.objectContaining({ detached: true, stdio: 'ignore' }),
      )
    } finally {
      delete process.env.LOCALAPPDATA
      delete process.env.ProgramFiles
    }
  })

  // The recorded acceptance defect: a first-instance editor IS the Electron
  // main process and lives as long as its window. Waiting for its exit (the
  // old execFile timeout) killed VS Code ~10s after it opened. A still-running
  // launcher must count as launched at the watch window and never be killed.
  it('counts a still-running launcher as launched and never kills it', async () => {
    // Only the watch timer is faked: the handler's real fs/microtask turns
    // must keep running (faking setImmediate would freeze the advance loop).
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    process.env.LOCALAPPDATA = '/w/LocalAppData'
    process.env.ProgramFiles = '/w/ProgramFiles'
    const { kills } = stubSpawnLongLived()
    try {
      platformMock.mockReturnValue('win32')
      const pending = req(makeApp(), 'POST', '/open-path', { path: tmpDir, target: 'vscode' }, '127.0.0.1')
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
      await vi.advanceTimersByTimeAsync(1500)
      const res = await pending
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      expect(spawnMock).toHaveBeenCalledWith(
        '/w/LocalAppData/Programs/Microsoft VS Code/Code.exe',
        [tmpDir],
        expect.objectContaining({ detached: true, stdio: 'ignore' }),
      )
      expect(kills).toHaveLength(1)
      expect(kills[0]).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
      delete process.env.LOCALAPPDATA
      delete process.env.ProgramFiles
    }
  })

  it('a nonzero exit after the watch window never flips a launched outcome', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    process.env.LOCALAPPDATA = '/w/LocalAppData'
    process.env.ProgramFiles = '/w/ProgramFiles'
    let launched: EventEmitter | null = null
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as SpawnChild
      child.unref = vi.fn()
      launched = child
      process.nextTick(() => child.emit('spawn'))
      return child
    })
    try {
      platformMock.mockReturnValue('win32')
      const pending = req(makeApp(), 'POST', '/open-path', { path: tmpDir, target: 'vscode' }, '127.0.0.1')
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
      await vi.advanceTimersByTimeAsync(1500)
      const res = await pending
      expect(res.status).toBe(200)
      // The window already counted the launcher launched; its late exit is
      // swallowed, never turned into a failure or an unhandled rejection.
      launched!.emit('exit', 1, null)
      expect(res.status).toBe(200)
    } finally {
      vi.useRealTimers()
      delete process.env.LOCALAPPDATA
      delete process.env.ProgramFiles
    }
  })

  it('surfaces a post-spawn error inside the watch window as a failure', async () => {
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as SpawnChild
      child.unref = vi.fn()
      process.nextTick(() => {
        child.emit('spawn')
        child.emit('error', new Error('post-spawn handle failure'))
      })
      return child
    })
    platformMock.mockReturnValue('linux')
    const res = await req(makeApp(), 'POST', '/open-path', { path: tmpDir, target: 'vscode' }, '127.0.0.1')
    expect(res.status).toBe(500)
  })

  it('folds a synchronous spawn throw into the candidate chain', async () => {
    platformMock.mockReturnValue('linux')
    const tried: string[] = []
    spawnMock.mockImplementation((file) => {
      tried.push(file as string)
      const err = new Error('spawn ENOENT') as Error & { code: string }
      err.code = 'ENOENT'
      throw err
    })
    execFileMock.mockImplementation((file, _args, _opts, cb) => {
      tried.push(file as string)
      cb(null, '', '')
    })
    const res = await req(makeApp(), 'POST', '/open-path', { path: tmpDir, target: 'terminal' }, '127.0.0.1')
    expect(res.status).toBe(200)
    expect(tried).toEqual(['x-terminal-emulator', 'gnome-terminal'])
  })

  it('the watch window starts at the spawn event, not the spawn call', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let launched: EventEmitter | null = null
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as SpawnChild
      child.unref = vi.fn()
      launched = child
      return child
    })
    try {
      platformMock.mockReturnValue('linux')
      const pending = req(makeApp(), 'POST', '/open-path', { path: tmpDir, target: 'vscode' }, '127.0.0.1')
      for (let i = 0; i < 100 && spawnMock.mock.calls.length === 0; i++) {
        await new Promise((r) => setImmediate(r))
      }
      // A slow spawn (AV scan, network path): the window must not run out
      // before the process exists.
      await vi.advanceTimersByTimeAsync(1500)
      let settled = false
      void Promise.resolve(pending).then(() => {
        settled = true
      })
      await new Promise((r) => setImmediate(r))
      expect(settled).toBe(false)
      launched!.emit('spawn')
      await vi.advanceTimersByTimeAsync(1500)
      const res = await pending
      expect(res.status).toBe(200)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a spawn failure after the would-be window is still a failure', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let launched: EventEmitter | null = null
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as SpawnChild
      child.unref = vi.fn()
      launched = child
      return child
    })
    try {
      platformMock.mockReturnValue('linux')
      const pending = req(makeApp(), 'POST', '/open-path', { path: tmpDir, target: 'vscode' }, '127.0.0.1')
      for (let i = 0; i < 100 && spawnMock.mock.calls.length === 0; i++) {
        await new Promise((r) => setImmediate(r))
      }
      await vi.advanceTimersByTimeAsync(1500)
      launched!.emit('error', new Error('spawn failed late'))
      const res = await pending
      expect(res.status).toBe(500)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a browser launch settles at spawn, not at a timer tick', async () => {
    const file = `${tmpDir}/page.html`
    await writeFile(file, '<h1>Hello</h1>')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    stubSpawnLongLived()
    try {
      const pending = req(makeApp(), 'POST', '/open-path', { path: file, target: 'browser' }, '127.0.0.1')
      // Real setImmediate turns (not faked) let the handler reach spawn;
      // vi.waitFor would advance the faked timers and hide the distinction.
      for (let i = 0; i < 100 && spawnMock.mock.calls.length === 0; i++) {
        await new Promise((r) => setImmediate(r))
      }
      expect(spawnMock).toHaveBeenCalled()
      // No timer advance: the spawn event alone must settle the request.
      const res = await pending
      expect(res.status).toBe(200)
    } finally {
      vi.useRealTimers()
    }
  })

  it('404s a brand target that has no candidates on this platform', async () => {
    platformMock.mockReturnValue('linux')
    const res = await req(makeApp(), 'POST', '/open-path', { path: tmpDir, target: 'iterm2' }, '127.0.0.1')
    expect(res.status).toBe(404)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('falls through darwin candidates on a nonzero exit (bundle missing, CLI fallback)', async () => {
    const tried: string[] = []
    execFileMock.mockImplementation((file, _args, _opts, cb) => {
      tried.push(file as string)
      // `open -a` reports a missing app as a nonzero exit, not ENOENT
      const err = new Error('not found') as Error & { code: number }
      err.code = 1
      cb(err)
    })
    spawnMock.mockImplementation((file) => {
      tried.push(file as string)
      const child = new EventEmitter() as SpawnChild
      child.unref = vi.fn()
      process.nextTick(() => {
        child.emit('spawn')
        child.emit('exit', 0, null)
      })
      return child
    })
    const res = await req(makeApp(), 'POST', '/open-path', { path: tmpDir, target: 'vscode' }, '127.0.0.1')
    expect(res.status).toBe(200)
    expect(tried).toEqual(['open', 'code'])
  })

  it('spawns `open -a Kiro` for kiro on darwin', async () => {
    const res = await req(makeApp(), 'POST', '/open-path', { path: tmpDir, target: 'kiro' }, '127.0.0.1')
    expect(res.status).toBe(200)
    expect(execFileMock).toHaveBeenCalledWith('open', ['-a', 'Kiro', tmpDir], expect.anything(), expect.anything())
  })

  // A custom-directory install: the registry is the ONLY proof, and the
  // launch must use the registry-resolved exe (real fs verifies it exists).
  // The stub answers ONLY the query whose script names the given exe — a
  // query for a different app gets an empty answer, so one app's registry
  // fact can never incidentally prove another.
  function stubAppPaths(exeName: string, exePath: string): void {
    execFileMock.mockImplementation((file, args, _opts, cb) => {
      if (file === 'powershell.exe' && (args as string[]).some((a) => a.includes(`\\${exeName}`))) {
        cb(null, `${exePath}\r\n\r\n`, '')
      } else {
        cb(null, '', '')
      }
    })
  }

  it('POST launches the registry-resolved VS Code exe for a custom-directory install', async () => {
    platformMock.mockReturnValue('win32')
    const exe = `${tmpDir}/Code.exe`
    await writeFile(exe, 'fake exe')
    stubAppPaths('Code.exe', exe)
    const res = await req(makeApp(), 'POST', '/open-path', { path: tmpDir, target: 'vscode' }, '127.0.0.1')
    expect(res.status).toBe(200)
    expect(spawnMock).toHaveBeenCalledWith(exe, [tmpDir], expect.objectContaining({ detached: true, stdio: 'ignore' }))
  })

  it('GET /apps offers vscode proven only by the registry', async () => {
    platformMock.mockReturnValue('win32')
    const exe = `${tmpDir}/Code.exe`
    await writeFile(exe, 'fake exe')
    stubAppPaths('Code.exe', exe)
    const res = await req(makeApp(), 'GET', '/open-path/apps')
    expect(res.status).toBe(200)
    expect(((await res.json()) as { apps: string[] }).apps).toContain('vscode')
  })

  it('POST launches the registry-resolved Kiro.exe for a custom-directory install', async () => {
    platformMock.mockReturnValue('win32')
    const exe = `${tmpDir}/Kiro.exe`
    await writeFile(exe, 'fake exe')
    stubAppPaths('Kiro.exe', exe)
    const res = await req(makeApp(), 'POST', '/open-path', { path: tmpDir, target: 'kiro' }, '127.0.0.1')
    expect(res.status).toBe(200)
    expect(spawnMock).toHaveBeenCalledWith(exe, [tmpDir], expect.objectContaining({ detached: true, stdio: 'ignore' }))
  })
})

describe('GET /open-path/apps', () => {
  it('returns the availability list shape', async () => {
    const res = await req(makeApp(), 'GET', '/open-path/apps')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { apps: string[] }
    expect(Array.isArray(body.apps)).toBe(true)
    for (const id of body.apps) {
      expect(['vscode', 'cursor', 'kiro', 'zed', 'iterm2', 'windowsterminal']).toContain(id)
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
    appPaths: ReadonlyMap<string, string> = new Map(),
  ): {
    fileExists: (p: string) => Promise<boolean>
    dirExists: (p: string) => Promise<boolean>
    executableExists: (p: string) => Promise<boolean>
    appPathsTarget: (exeName: string) => Promise<string | null>
  } {
    return {
      fileExists: async (p) => files.includes(p),
      dirExists: async (p) => dirs.includes(p),
      // Executability defaults to the same fixture set: the tests below that
      // care pin it explicitly.
      executableExists: async (p) => files.includes(p),
      // Registry-proven executables (App Paths): empty by default, so tests
      // that care inject the exe-name → resolved-path facts.
      appPathsTarget: async (exeName) => appPaths.get(exeName) ?? null,
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
        executableExists: async (p) => p !== '/opt/bin/code' && p !== '/opt/bin/cursor' && p !== '/opt/bin/kiro',
        appPathsTarget: async () => null,
      },
    )
    expect(apps).toEqual(['zed'])
  })

  // A custom-directory install (neither default path exists) is proven by
  // the installer's App Paths registry key alone — the win32 locator chain
  // must accept that fact, not just the two fixed paths.
  const winEnv = Object.freeze({ LOCALAPPDATA: '/w/LocalAppData', ProgramFiles: '/w/ProgramFiles', PATH: '/w' })

  it('detects win32 vscode proven only by the App Paths registry', async () => {
    const apps = await availableAppsFor(
      'win32',
      winEnv,
      '/home/u',
      deps([], [], new Map([['Code.exe', 'D:/custom/Microsoft VS Code/Code.exe']])),
    )
    expect(apps).toEqual(['vscode'])
  })

  it('still detects win32 vscode via the fixed paths when the registry proves nothing', async () => {
    const apps = await availableAppsFor(
      'win32',
      winEnv,
      '/home/u',
      deps(['/w/LocalAppData/Programs/Microsoft VS Code/Code.exe']),
    )
    expect(apps).toEqual(['vscode'])
  })

  it('detects a macOS Kiro bundle', async () => {
    const apps = await availableAppsFor('darwin', noopEnv, '/home/u', deps([], ['/Applications/Kiro.app']))
    expect(apps).toContain('kiro')
  })

  it('detects the linux kiro CLI on PATH', async () => {
    const apps = await availableAppsFor('linux', Object.freeze({ PATH: '/opt/bin' }), '/home/u', deps(['/opt/bin/kiro']))
    expect(apps).toContain('kiro')
  })

  it('detects win32 Kiro proven only by the App Paths registry', async () => {
    const apps = await availableAppsFor(
      'win32',
      winEnv,
      '/home/u',
      deps([], [], new Map([['Kiro.exe', 'D:/software/Kiro/Kiro.exe']])),
    )
    expect(apps).toContain('kiro')
  })

  it('detects the default per-user Kiro install path', async () => {
    const apps = await availableAppsFor('win32', winEnv, '/home/u', deps(['/w/LocalAppData/Programs/Kiro/Kiro.exe']))
    expect(apps).toContain('kiro')
  })
})

// The launch side of the app-paths locator: the registry-resolved exe is the
// FIRST candidate (it is the verified install), the fixed paths stay behind
// it as ENOENT fall-through. A registry that proves nothing drops out.
describe('openCommandsFor app-paths resolution', () => {
  const winEnv = Object.freeze({ LOCALAPPDATA: '/w/LocalAppData', ProgramFiles: '/w/ProgramFiles', PATH: '/w' })

  it('launches the registry-resolved exe first, fixed paths as fall-through', async () => {
    const cmds = await openCommandsFor('win32', 'vscode', '/proj', winEnv, async (exe) =>
      exe === 'Code.exe' ? 'D:/custom/Microsoft VS Code/Code.exe' : null,
    )
    expect(cmds.map((c) => c.file)).toEqual([
      'D:/custom/Microsoft VS Code/Code.exe',
      '/w/LocalAppData/Programs/Microsoft VS Code/Code.exe',
      '/w/ProgramFiles/Microsoft VS Code/Code.exe',
    ])
    expect(cmds[0]!.args).toEqual(['/proj'])
  })

  it('skips the registry row when it proves nothing', async () => {
    const cmds = await openCommandsFor('win32', 'vscode', '/proj', winEnv, async () => null)
    expect(cmds.map((c) => c.file)).toEqual([
      '/w/LocalAppData/Programs/Microsoft VS Code/Code.exe',
      '/w/ProgramFiles/Microsoft VS Code/Code.exe',
    ])
  })
})

// GET /open-path/icons/:target — the OS glyphs for finder/terminal, extracted
// once per router instance (per-process cache) and served with long-lived
// cache headers; 404 is the protocol's "genuinely does not exist here" and
// the client falls back to its generic glyph on it.
describe('GET /open-path/icons/:target', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47])

  it('serves the extracted png with immutable-ish cache headers', async () => {
    extractIconMock.mockResolvedValue({ bytes: PNG, contentType: 'image/png' })
    const res = await req(makeApp(), 'GET', '/open-path/icons/finder')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600')
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true)
    expect(extractIconMock.mock.calls[0]?.slice(0, 2)).toEqual(['finder', 'darwin'])
  })

  it('serves svg content types too', async () => {
    extractIconMock.mockResolvedValue({ bytes: Buffer.from('<svg/>'), contentType: 'image/svg+xml' })
    const res = await req(makeApp(), 'GET', '/open-path/icons/terminal')
    expect(res.headers.get('content-type')).toBe('image/svg+xml')
  })

  it('extracts each target once per router instance (process cache)', async () => {
    extractIconMock.mockResolvedValue({ bytes: PNG, contentType: 'image/png' })
    const app = makeApp()
    await req(app, 'GET', '/open-path/icons/finder')
    await req(app, 'GET', '/open-path/icons/finder')
    await req(app, 'GET', '/open-path/icons/terminal')
    expect(extractIconMock).toHaveBeenCalledTimes(2) // finder + terminal, not 3
  })

  it('answers 404 (no cache headers) when the icon does not exist on this platform', async () => {
    extractIconMock.mockResolvedValue(null)
    const res = await req(makeApp(), 'GET', '/open-path/icons/finder')
    expect(res.status).toBe(404)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('404s brand targets — their glyphs are client-side static, never extracted', async () => {
    const res = await req(makeApp(), 'GET', '/open-path/icons/vscode')
    expect(res.status).toBe(404)
    expect(extractIconMock).not.toHaveBeenCalled()
  })

  it('403s remote peers like every other open-path route', async () => {
    extractIconMock.mockResolvedValue({ bytes: PNG, contentType: 'image/png' })
    const res = await req(makeApp(), 'GET', '/open-path/icons/finder', undefined, '192.168.1.5')
    expect(res.status).toBe(403)
    expect(extractIconMock).not.toHaveBeenCalled()
  })
})
