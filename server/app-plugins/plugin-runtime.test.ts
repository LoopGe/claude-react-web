import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppPluginStore } from './app-plugin-store.js'
import { AppPluginManager } from './app-plugin-manager.js'
import type { SessionManager } from '../session-manager.js'

const smStub = {} as unknown as SessionManager

// A minimal JSON-RPC *child* runtime. The real child SDK (@claude-react-web/
// plugin-api) doesn't exist yet, so fixtures hand-roll the stdio loop: read
// newline-delimited JSON from stdin, dispatch to handlers, write responses
// to stdout, and call back into the host via outbound requests.
const CHILD_RUNTIME = `
import readline from 'node:readline'
const rl = readline.createInterface({ input: process.stdin })
let nextId = 1
const pending = new Map()
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\\n') }
function callHost(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    send({ jsonrpc: '2.0', id, method, params })
  })
}
const handlers = {
  activate: async () => ({ ok: true }),
  deactivate: async () => ({ ok: true }),
}
rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (!msg || typeof msg !== 'object') return
  if ('id' in msg && ('result' in msg || 'error' in msg)) {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.error) p.reject(new Error(msg.error.message))
    else p.resolve(msg.result)
    return
  }
  if ('method' in msg) {
    Promise.resolve(handlers[msg.method]?.(msg.params)).then(
      (result) => { if (msg.id != null) send({ jsonrpc: '2.0', id: msg.id, result: result ?? null }) },
      (err) => { if (msg.id != null) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: err.message } }) }
    )
  }
})
// Expose callHost to handler modules via globalThis.
globalThis.__callHost = callHost
`

function buildPlugin(root: string, id: string, body: string, overrides?: Record<string, unknown>): string {
  const dir = join(root, id.replace(/\./g, '_'))
  mkdirSync(join(dir, 'dist'), { recursive: true })
  const manifest = {
    manifestVersion: 1,
    id,
    name: id,
    version: '1.0.0',
    engines: { claudeReactWeb: '^0.6.0', node: '>=20' },
    runtime: { service: 'dist/service.mjs' },
    permissions: ['storage'],
    contributes: { commands: [{ id: `${id}.run`, title: 'Run' }], contextMenus: [], actions: [], configuration: { properties: [] } },
    ...overrides,
  }
  writeFileSync(join(dir, 'crw-plugin.json'), JSON.stringify(manifest))
  writeFileSync(join(dir, 'dist', 'service.mjs'), `${CHILD_RUNTIME}\n${body}\n`)
  return dir
}

/** Body that writes `marker` on activate — proves the subprocess ran without a
 *  command being invoked. */
function startupMarkerBody(marker: string): string {
  return `
import { writeFileSync } from 'node:fs'
handlers.activate = async () => {
  writeFileSync(${JSON.stringify(marker)}, 'activated')
  return { ok: true }
}
`
}

async function waitForState(manager: AppPluginManager, id: string, state: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (manager.get(id)!.runtimeState !== state && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25))
  }
  expect(manager.get(id)!.runtimeState).toBe(state)
}

async function waitFor(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!fn() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25))
  }
  expect(fn()).toBe(true)
}

describe('AppPluginManager — runtime (B2)', () => {
  let stateDir: string
  let store: AppPluginStore
  let manager: AppPluginManager

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'apm-b2-'))
    store = new AppPluginStore({ stateDir })
    manager = new AppPluginManager({ store, stateDir, hostVersion: '0.6.0', hostNodeMajor: 20, sm: smStub })
  })

  afterEach(async () => {
    await manager.shutdown().catch(() => {})
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  it('activates a subprocess and returns a command result', async () => {
    const dir = buildPlugin(stateDir, 'com.example.hello', `
handlers.executeCommand = async ({ invocationId }) => ({
  type: 'popover', invocationId, content: { kind: 'text', text: 'hello from plugin' },
})
`)
    await manager.install({ type: 'local', path: dir })
    await manager.enable('com.example.hello')

    const result = await manager.executeCommand({
      pluginId: 'com.example.hello',
      commandId: 'com.example.hello.run',
      context: { source: 'global', commandId: 'com.example.hello.run', invokedAt: Date.now() } as never,
    })
    expect(result).toMatchObject({ type: 'popover', content: { kind: 'text', text: 'hello from plugin' } })
    // The plugin is active after lazy activation.
    expect(manager.get('com.example.hello')!.runtimeState).toBe('active')
  })

  it('a plugin can round-trip storage through the Host API', async () => {
    const dir = buildPlugin(stateDir, 'com.example.storage', `
handlers.executeCommand = async ({ invocationId, context }) => {
  await globalThis.__callHost('storage.set', { scope: 'global', key: 'k', value: 'v' })
  const got = await globalThis.__callHost('storage.get', { scope: 'global', key: 'k' })
  return { type: 'notification', invocationId, level: 'success', content: { kind: 'text', text: String(got.value) } }
}
`)
    await manager.install({ type: 'local', path: dir })
    await manager.enable('com.example.storage')
    const result = await manager.executeCommand({
      pluginId: 'com.example.storage',
      commandId: 'com.example.storage.run',
      context: { source: 'global', commandId: 'com.example.storage.run', invokedAt: Date.now() } as never,
    })
    expect(result).toMatchObject({ type: 'notification', content: { kind: 'text', text: 'v' } })
  })

  it('quarantines a plugin after 3 crashes and refuses further commands', async () => {
    const dir = buildPlugin(stateDir, 'com.example.crashy', `
handlers.executeCommand = async () => { process.exit(1) }
`)
    await manager.install({ type: 'local', path: dir })
    await manager.enable('com.example.crashy')

    const ctx = { source: 'global', commandId: 'com.example.crashy.run', invokedAt: Date.now() } as never
    // Three crashes push the plugin into `quarantined`.
    for (let i = 0; i < 3; i++) {
      await expect(manager.executeCommand({ pluginId: 'com.example.crashy', commandId: 'com.example.crashy.run', context: ctx }))
        .rejects.toThrow()
    }
    expect(manager.get('com.example.crashy')!.runtimeState).toBe('quarantined')
    // The 4th attempt is refused without spawning (quarantine gate).
    await expect(manager.executeCommand({ pluginId: 'com.example.crashy', commandId: 'com.example.crashy.run', context: ctx }))
      .rejects.toThrow(/quarantined/)
  })

  it('a subprocess exit during host shutdown is not recorded as a crash', async () => {
    // Simulates the Windows shutdown artifact: the console signal that starts
    // host teardown also kills the plugin child (it has no SIGINT handler), so
    // the child can exit(1) while the host is tearing down. The host must
    // classify that exit as expected teardown, not a crash — a recorded crash
    // persists to the store and bricks onStartup plugins until the next
    // manual disable/enable.
    const trigger = join(stateDir, 'shutdown-exit-trigger.txt')
    const preExit = join(stateDir, 'shutdown-pre-exit.txt')
    const dir = buildPlugin(stateDir, 'com.example.shutdown', `
import { existsSync, writeFileSync } from 'node:fs'
handlers.activate = async () => ({ ok: true })
// Self-exit(1) once the trigger file appears — the test writes it AFTER
// prepareForShutdown(), so the exit is guaranteed to land during teardown.
// The pre-exit marker lets the test wait on the exit itself instead of a
// fixed sleep.
const iv = setInterval(() => {
  if (existsSync(${JSON.stringify(trigger)})) {
    writeFileSync(${JSON.stringify(preExit)}, '1')
    process.exit(1)
  }
}, 25)
`, { activationEvents: ['onStartup'], permissions: [] })
    await manager.install({ type: 'local', path: dir })
    await manager.enable('com.example.shutdown')
    await waitForState(manager, 'com.example.shutdown', 'active')

    // cli.ts calls this synchronously before any await of the signal handler.
    manager.prepareForShutdown()

    // Trigger the child's exit, wait until the child has actually exited
    // (pre-exit marker), then a short tail so the host's exit event has been
    // delivered and processed.
    writeFileSync(trigger, 'exit')
    await waitFor(() => existsSync(preExit))
    await new Promise((r) => setTimeout(r, 150))
    const info = manager.get('com.example.shutdown')!
    expect(info.runtimeState).toBe('active')
    expect(info.lastError).toBeUndefined()
  })

  it('deactivating a plugin whose child already exited completes immediately', async () => {
    // Windows shutdown artifact, part 2: the console signal kills the child
    // while the host tears down, and the subsequent deactivate('shutdown')
    // must not stall DEACTIVATE_TIMEOUT_MS per plugin waiting on a child
    // that will never answer — an exit-aware peer rejects immediately.
    const trigger = join(stateDir, 'dead-child-trigger.txt')
    const preExit = join(stateDir, 'dead-child-pre-exit.txt')
    const dir = buildPlugin(stateDir, 'com.example.deadchild', `
import { existsSync, writeFileSync } from 'node:fs'
handlers.activate = async () => ({ ok: true })
const iv = setInterval(() => {
  if (existsSync(${JSON.stringify(trigger)})) {
    writeFileSync(${JSON.stringify(preExit)}, '1')
    process.exit(1)
  }
}, 25)
`, { activationEvents: ['onStartup'], permissions: [] })
    await manager.install({ type: 'local', path: dir })
    await manager.enable('com.example.deadchild')
    await waitForState(manager, 'com.example.deadchild', 'active')
    manager.prepareForShutdown()
    writeFileSync(trigger, 'exit')
    await waitFor(() => existsSync(preExit))

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t0 = Date.now()
    try {
      await manager.shutdown()
    } finally {
      warnSpy.mockRestore()
    }
    // A 5s deactivate timeout means the call waited on a dead child.
    expect(Date.now() - t0).toBeLessThan(2000)
  }, 15_000)

  it('a wedged deactivate at shutdown is still logged — only an already-dead child is silent', async () => {
    // The shutdown-path warn suppression exists so the Windows artifact (child
    // killed by the console signal before deactivate runs) doesn't spam warns
    // on every shutdown. It must NOT swallow the diagnostic for a child that
    // is still alive but failed to answer — that's the one signal naming a
    // wedged plugin during a slow shutdown.
    const dir = buildPlugin(stateDir, 'com.example.wedged', `
handlers.activate = async () => ({ ok: true })
handlers.deactivate = async () => { throw new Error('deactivate blew up') }
`, { activationEvents: ['onStartup'], permissions: [] })
    await manager.install({ type: 'local', path: dir })
    await manager.enable('com.example.wedged')
    await waitForState(manager, 'com.example.wedged', 'active')

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      manager.prepareForShutdown()
      await manager.shutdown()
      const deactWarns = warnSpy.mock.calls.filter((c) =>
        c.some((a) => typeof a === 'string' && a.includes('deactivate did not complete cleanly')))
      expect(deactWarns.length).toBeGreaterThan(0)
      expect(deactWarns[0].some((a) => typeof a === 'string' && a.includes('deactivate blew up'))).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  }, 15_000)

  it('disable tears down the subprocess', async () => {
    const dir = buildPlugin(stateDir, 'com.example.teardown', `
handlers.executeCommand = async ({ invocationId }) => ({ type: 'none', invocationId })
`)
    await manager.install({ type: 'local', path: dir })
    await manager.enable('com.example.teardown')
    // Activate by running a command.
    await manager.executeCommand({
      pluginId: 'com.example.teardown',
      commandId: 'com.example.teardown.run',
      context: { source: 'global', commandId: 'com.example.teardown.run', invokedAt: Date.now() } as never,
    })
    await manager.disable('com.example.teardown')
    expect(manager.get('com.example.teardown')!.runtimeState).toBe('disabled')
  })

  it('disable during an in-flight command surfaces the typed "disabled" code', async () => {
    // A command that hangs forever — disable must cancel it and the rejection
    // must carry code 'disabled' (not generic 'command-cancelled').
    const dir = buildPlugin(stateDir, 'com.example.hang', `
handlers.executeCommand = async () => { await new Promise(() => {}) }
`)
    await manager.install({ type: 'local', path: dir })
    await manager.enable('com.example.hang')

    const ctx = { source: 'global', commandId: 'com.example.hang.run', invokedAt: Date.now() } as never
    // Attach the catch immediately so the rejection is never unhandled.
    let caught: unknown
    const pending = manager.executeCommand({ pluginId: 'com.example.hang', commandId: 'com.example.hang.run', context: ctx })
      .catch((e) => { caught = e })
    // Let activation + the hanging call land before cancelling.
    await new Promise((r) => setTimeout(r, 80))
    await manager.disable('com.example.hang')
    await pending
    expect(caught).toMatchObject({ body: { error: { code: 'disabled' } } })
  })

  it('Host API rejects malformed params (requireParams validation)', async () => {
    // The plugin calls storage.set with no scope/key — the host's requireParams
    // must reject with INVALID_PARAMS instead of writing an undefined-key entry.
    const dir = buildPlugin(stateDir, 'com.example.badparams', `
handlers.executeCommand = async ({ invocationId }) => {
  try {
    await globalThis.__callHost('storage.set', {})
    return { type: 'notification', invocationId, level: 'success', content: { kind: 'text', text: 'no error' } }
  } catch (e) {
    return { type: 'notification', invocationId, level: 'error', content: { kind: 'text', text: String(e.message) } }
  }
}
`)
    await manager.install({ type: 'local', path: dir })
    await manager.enable('com.example.badparams')
    const result = await manager.executeCommand({
      pluginId: 'com.example.badparams',
      commandId: 'com.example.badparams.run',
      context: { source: 'global', commandId: 'com.example.badparams.run', invokedAt: Date.now() } as never,
    })
    expect(result.type).toBe('notification')
    if (result.type === 'notification') {
      expect((result.content as { text: string }).text).toMatch(/missing param/)
    }
  })

  it('an onStartup plugin activates on enable without a command', async () => {
    const marker = join(stateDir, 'startup-enable-marker.txt')
    const dir = buildPlugin(stateDir, 'com.example.boot', startupMarkerBody(marker), {
      activationEvents: ['onStartup'],
    })
    await manager.install({ type: 'local', path: dir })
    await manager.enable('com.example.boot')

    // enable() fire-and-forgets onStartup activation — no executeCommand call.
    await waitForState(manager, 'com.example.boot', 'active')
    expect(existsSync(marker)).toBe(true)
    expect(readFileSync(marker, 'utf8')).toBe('activated')
  })

  it('re-initialise (boot) re-activates an enabled onStartup plugin', async () => {
    const marker = join(stateDir, 'startup-boot-marker.txt')
    const dir = buildPlugin(stateDir, 'com.example.boot', startupMarkerBody(marker), {
      activationEvents: ['onStartup'],
    })
    await manager.install({ type: 'local', path: dir })
    await manager.enable('com.example.boot')
    await waitForState(manager, 'com.example.boot', 'active')
    expect(existsSync(marker)).toBe(true)

    // A restart clamps active→inactive, then activateStartupPlugins() at the
    // end of initialize() brings it back up — the marker gets rewritten.
    rmSync(marker, { force: true })
    await manager.shutdown()
    manager = new AppPluginManager({ store, stateDir, hostVersion: '0.6.0', hostNodeMajor: 20, sm: smStub })
    await manager.initialize()
    await waitForState(manager, 'com.example.boot', 'active')
    expect(existsSync(marker)).toBe(true)
    expect(readFileSync(marker, 'utf8')).toBe('activated')
  })

  it('boot heals a persisted crashed state so an onStartup plugin re-activates', async () => {
    const marker = join(stateDir, 'crashed-boot-marker.txt')
    const dir = buildPlugin(stateDir, 'com.example.heal', startupMarkerBody(marker), {
      activationEvents: ['onStartup'],
    })
    await manager.install({ type: 'local', path: dir })
    // What a previous run persisted: the plugin crashed (e.g. the shutdown
    // artifact where the console signal kills the child mid-teardown) and the
    // host died before it could recover. The crash counter lives in the
    // process manager's in-memory 5-min window — fresh on every boot — so a
    // lone crash record must not survive the restart and brick the plugin.
    const rec = store.get('com.example.heal')!
    store.upsert({ ...rec, enabled: true, runtimeState: 'crashed', lastError: 'subprocess exited (1 crashes)' })
    await store.flush()

    manager = new AppPluginManager({ store, stateDir, hostVersion: '0.6.0', hostNodeMajor: 20, sm: smStub })
    await manager.initialize()

    // The stale crashed record is clamped to inactive at boot (lastError
    // cleared), then activateStartupPlugins() brings the subprocess back up.
    await waitForState(manager, 'com.example.heal', 'active')
    expect(manager.get('com.example.heal')!.lastError).toBeUndefined()
    expect(existsSync(marker)).toBe(true)
  })

  it('safe mode does not auto-activate onStartup plugins at boot', async () => {
    const marker = join(stateDir, 'startup-safe-marker.txt')
    const dir = buildPlugin(stateDir, 'com.example.boot', startupMarkerBody(marker), {
      activationEvents: ['onStartup'],
    })
    await manager.install({ type: 'local', path: dir })
    // enable() itself fire-and-forgets activation even in safe mode, so write
    // the store record directly to model a previously-enabled plugin at boot.
    const rec = store.get('com.example.boot')!
    store.upsert({ ...rec, enabled: true, runtimeState: 'inactive' })
    await store.flush()

    const safe = new AppPluginManager({
      store,
      stateDir,
      hostVersion: '0.6.0',
      hostNodeMajor: 20,
      sm: smStub,
      safeMode: true,
    })
    await safe.initialize()

    // activateStartupPlugins() returns immediately in safe mode — the plugin
    // stays inactive and the subprocess never runs.
    expect(safe.get('com.example.boot')!.runtimeState).toBe('inactive')
    expect(existsSync(marker)).toBe(false)
    await safe.shutdown()
  })

  it('reloads a running plugin after a configuration change so the new value applies immediately', async () => {
    const marker = join(stateDir, 'config-reload-marker.txt')
    const dir = buildPlugin(stateDir, 'com.example.cfg', `
import { writeFileSync } from 'node:fs'
handlers.activate = async (params) => {
  writeFileSync(${JSON.stringify(marker)}, JSON.stringify(params.configuration))
  return { ok: true }
}
`, {
      activationEvents: ['onStartup'],
      contributes: {
        commands: [],
        contextMenus: [],
        actions: [],
        configuration: {
          properties: [{ key: 'com.example.cfg.mode', type: 'string', title: 'Mode', default: 'a' }],
        },
      },
    })
    await manager.install({ type: 'local', path: dir })
    await manager.enable('com.example.cfg')
    await waitForState(manager, 'com.example.cfg', 'active')
    await waitFor(() => existsSync(marker))
    // First activation carries the declared default.
    expect(JSON.parse(readFileSync(marker, 'utf8'))['com.example.cfg.mode']).toBe('a')

    // A config PUT reloads the subprocess; the fresh activate passes the new value.
    await manager.putConfiguration('com.example.cfg', { 'com.example.cfg.mode': 'b' })
    await waitFor(() => {
      try { return JSON.parse(readFileSync(marker, 'utf8'))['com.example.cfg.mode'] === 'b' } catch { return false }
    })
    // The plugin is still active after the reload (no manual re-enable needed).
    expect(manager.get('com.example.cfg')!.runtimeState).toBe('active')
  })

  it('applies a configuration change saved mid-activation instead of dropping it', async () => {
    const marker = join(stateDir, 'config-mid-activate-marker.txt')
    const dir = buildPlugin(stateDir, 'com.example.cfgmid', `
import { writeFileSync } from 'node:fs'
handlers.activate = async (params) => {
  // Slow activation so a config save can land while ensureActive is in flight.
  await new Promise((r) => setTimeout(r, 250))
  writeFileSync(${JSON.stringify(marker)}, JSON.stringify(params.configuration))
  return { ok: true }
}
`, {
      activationEvents: ['onStartup'],
      contributes: {
        commands: [],
        contextMenus: [],
        actions: [],
        configuration: {
          properties: [{ key: 'com.example.cfgmid.mode', type: 'string', title: 'Mode', default: 'a' }],
        },
      },
    })
    await manager.install({ type: 'local', path: dir })
    // enable() fire-and-forgets onStartup activation; putConfiguration below
    // lands while ensureActive is still spawning, so `get()` is undefined and
    // the manager must waitForActive to avoid silently dropping the new value.
    await manager.enable('com.example.cfgmid')
    await manager.putConfiguration('com.example.cfgmid', { 'com.example.cfgmid.mode': 'b' })
    await waitFor(() => {
      try { return JSON.parse(readFileSync(marker, 'utf8'))['com.example.cfgmid.mode'] === 'b' } catch { return false }
    })
    expect(manager.get('com.example.cfgmid')!.runtimeState).toBe('active')
  })

  it('does not reload the subprocess when a configuration PUT is a no-op', async () => {
    const marker = join(stateDir, 'config-noop-marker.txt')
    const dir = buildPlugin(stateDir, 'com.example.cfgnop', `
import { appendFileSync } from 'node:fs'
handlers.activate = async () => {
  appendFileSync(${JSON.stringify(marker)}, 'activate\\n')
  return { ok: true }
}
`, {
      activationEvents: ['onStartup'],
      contributes: {
        commands: [],
        contextMenus: [],
        actions: [],
        configuration: {
          properties: [{ key: 'com.example.cfgnop.mode', type: 'string', title: 'Mode', default: 'a' }],
        },
      },
    })
    await manager.install({ type: 'local', path: dir })
    await manager.enable('com.example.cfgnop')
    await waitForState(manager, 'com.example.cfgnop', 'active')
    await waitFor(() => existsSync(marker))
    const activations = () => readFileSync(marker, 'utf8').split('\n').filter(Boolean).length
    expect(activations()).toBe(1)

    // Same value as the default → no persisted change → no deactivate/reactivate
    // cycle. A (wrong) reload would respawn the child and append a second line.
    await manager.putConfiguration('com.example.cfgnop', { 'com.example.cfgnop.mode': 'a' })
    await new Promise((r) => setTimeout(r, 200))
    expect(activations()).toBe(1)
    expect(manager.get('com.example.cfgnop')!.runtimeState).toBe('active')
  })

  it('forwards a plugin app.event notification to the bus', async () => {
    const dir = buildPlugin(
      stateDir,
      'com.example.events',
      `
handlers.activate = async () => ({ ok: true })
handlers.executeCommand = async () => {
  send({ jsonrpc: '2.0', method: 'app.event', params: {
    widgetId: 'com.example.events.overview',
    payload: { values: [{ id: 'cpu', label: 'CPU', value: '1', unit: '%' }] },
  } })
  return { type: 'none' }
}
`,
      {
        permissions: [],
        activationEvents: ['onStartup'],
        contributes: {
          widgets: [{ id: 'com.example.events.overview', location: 'global.bottomLeft', kind: 'stat-grid' }],
          commands: [{ id: 'com.example.events.run', title: 'Run' }],
          contextMenus: [],
          actions: [],
          configuration: { properties: [] },
        },
      },
    )
    await manager.install({ type: 'local', path: dir })
    const sub = manager.subscribeAppPlugins()
    const received: unknown[] = []
    const collect = (async () => {
      for await (const ev of sub.iterable) {
        received.push(ev)
      }
    })()
    try {
      await manager.enable('com.example.events')
      await manager.executeCommand({
        pluginId: 'com.example.events',
        commandId: 'com.example.events.run',
        context: { source: 'global', commandId: 'com.example.events.run', invokedAt: Date.now() } as never,
      })
      const deadline = Date.now() + 3000
      while (!received.some((e) => (e as { kind?: string }).kind === 'plugin-event') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25))
      }
      expect(received.some((e) => (e as { kind?: string }).kind === 'plugin-event')).toBe(true)
    } finally {
      sub.unsubscribe()
      await collect
    }
  })
})
