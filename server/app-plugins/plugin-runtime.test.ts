import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
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

function buildPlugin(root: string, id: string, body: string): string {
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
  }
  writeFileSync(join(dir, 'crw-plugin.json'), JSON.stringify(manifest))
  writeFileSync(join(dir, 'dist', 'service.mjs'), `${CHILD_RUNTIME}\n${body}\n`)
  return dir
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
})
