import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppPluginStore } from './app-plugin-store.js'
import { AppPluginManager } from './app-plugin-manager.js'
import type { SessionManager } from '../session-manager.js'

// Minimal SessionManager stub — the B1 static tests don't execute commands,
// so the host adapters (which need a real sm) are never exercised.
const smStub = {} as unknown as SessionManager

// Build a minimal plugin directory with a valid manifest. `claudeReactWeb`
// must satisfy the host version passed to the manager (0.6.0 here), so the
// range is `^0.6.0` — real fixtures (Stage D) use the same host version.
function buildPluginDir(root: string, id: string, overrides?: Record<string, unknown>): string {
  const dir = join(root, id.replace(/\./g, '_'))
  mkdirSync(join(dir, 'dist'), { recursive: true })
  writeFileSync(join(dir, 'dist', 'service.mjs'), `export function activate(){}\n`)
  const manifest = {
    manifestVersion: 1,
    id,
    name: id,
    version: '1.0.0',
    engines: { claudeReactWeb: '^0.6.0', node: '>=20' },
    runtime: { service: 'dist/service.mjs' },
    permissions: ['storage'],
    contributes: {
      commands: [{ id: `${id}.run`, title: 'Run' }],
      contextMenus: [
        { id: `${id}.sel`, location: 'message.selectionContextMenu', commandId: `${id}.run`, title: 'On selection' },
      ],
      actions: [],
      configuration: { properties: [] },
    },
    ...overrides,
  }
  writeFileSync(join(dir, 'crw-plugin.json'), JSON.stringify(manifest))
  return dir
}

describe('AppPluginManager — static state machine (B1)', () => {
  let stateDir: string
  let store: AppPluginStore
  let manager: AppPluginManager

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'apm-test-'))
    store = new AppPluginStore({ stateDir })
    manager = new AppPluginManager({
      store,
      stateDir,
      hostVersion: '0.6.0',
      hostNodeMajor: 20,
      sm: smStub,
    })
  })

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  it('install registers a disabled plugin with declared permissions', async () => {
    const dir = buildPluginDir(stateDir, 'com.example.alpha')
    const result = await manager.install({ type: 'local', path: dir })
    expect(result.id).toBe('com.example.alpha')
    expect(result.permissionRequired).toBe(false)

    const info = manager.get('com.example.alpha')!
    expect(info.enabled).toBe(false)
    expect(info.runtimeState).toBe('disabled')
    expect(info.declaredPermissions.map((p) => p.permission)).toContain('storage')
    expect(info.grantedPermissions.map((p) => p.permission)).toContain('storage')
    // Contributions resolve even while disabled (UI shows what it'd add).
    expect(info.contributions.commands).toHaveLength(1)
  })

  it('enable flips to inactive and registers contributions', async () => {
    const dir = buildPluginDir(stateDir, 'com.example.beta')
    await manager.install({ type: 'local', path: dir })
    await manager.enable('com.example.beta')

    const info = manager.get('com.example.beta')!
    expect(info.enabled).toBe(true)
    expect(info.runtimeState).toBe('inactive')
    // Contributions are non-empty on the client info (registry-backed).
    expect(info.contributions.commands.map((c) => c.id)).toEqual(['com.example.beta.run'])
    expect(info.contributions.contextMenus.map((m) => m.location)).toContain('message.selectionContextMenu')
  })

  it('disable returns to disabled and the list reflects it', async () => {
    const dir = buildPluginDir(stateDir, 'com.example.gamma')
    await manager.install({ type: 'local', path: dir })
    await manager.enable('com.example.gamma')
    await manager.disable('com.example.gamma')

    const info = manager.get('com.example.gamma')!
    expect(info.enabled).toBe(false)
    expect(info.runtimeState).toBe('disabled')
  })

  it('uninstall removes the plugin from the list', async () => {
    const dir = buildPluginDir(stateDir, 'com.example.delta')
    await manager.install({ type: 'local', path: dir })
    await manager.uninstall('com.example.delta', { deleteData: true })
    expect(manager.get('com.example.delta')).toBeUndefined()
    expect(manager.list()).toHaveLength(0)
  })

  it('install with an invalid manifest is rejected', async () => {
    const dir = buildPluginDir(stateDir, 'com.example.bad', { id: 'Not Reverse DNS' })
    await expect(manager.install({ type: 'local', path: dir })).rejects.toThrow(/manifest invalid/)
  })

  it('update with broadened permissions enters permission-required', async () => {
    const dir = buildPluginDir(stateDir, 'com.example.up', {
      permissions: ['storage'],
      version: '1.0.0',
    })
    await manager.install({ type: 'local', path: dir })
    await manager.enable('com.example.up')

    // Rewrite the manifest to a new version that asks for a NEW permission.
    const dir2 = buildPluginDir(stateDir, 'com.example.up', {
      permissions: ['storage', 'ai.request'],
      version: '1.1.0',
    })
    const result = await manager.install({ type: 'local', path: dir2 })
    expect(result.permissionRequired).toBe(true)
    const info = manager.get('com.example.up')!
    expect(info.runtimeState).toBe('permission-required')
    // The consent path is granting the broadened permission set (not enable —
    // the plugin is still `enabled`; permission-required gates execution).
    const { declared } = manager.getPermissions('com.example.up')
    await manager.setPermissions('com.example.up', declared)
    const cleared = manager.get('com.example.up')!
    expect(cleared.runtimeState).toBe('inactive')
    expect(cleared.permissionRequired).toBe(false)
  })

  it('persists across a re-initialize (restart) and clamps active→inactive', async () => {
    const dir = buildPluginDir(stateDir, 'com.example.persist')
    await manager.install({ type: 'local', path: dir })
    await manager.enable('com.example.persist')
    // Simulate a stale persisted 'active' state (as if B2 ran before restart).
    const record = store.get('com.example.persist')!
    store.upsert({ ...record, runtimeState: 'active' })
    await store.flush()

    const manager2 = new AppPluginManager({
      store: new AppPluginStore({ stateDir }),
      stateDir,
      hostVersion: '0.6.0',
      hostNodeMajor: 20,
      sm: smStub,
    })
    await manager2.initialize()
    const info = manager2.get('com.example.persist')!
    expect(info.enabled).toBe(true)
    // No subprocess survives restart → clamped to inactive.
    expect(info.runtimeState).toBe('inactive')
  })

  it('WS snapshot broadcast emits snapshot then state-changed', async () => {
    const sub = manager.subscribeAppPlugins()
    const events: string[] = []
    const iter = sub.iterable[Symbol.asyncIterator]()
    // Drain the initial snapshot synchronously-ish.
    const first = await iter.next()
    expect(first.value).toMatchObject({ kind: 'snapshot' })
    void (async () => {
      for await (const ev of sub.iterable) events.push(ev.kind)
    })()

    const dir = buildPluginDir(stateDir, 'com.example.ws')
    await manager.install({ type: 'local', path: dir })
    await manager.enable('com.example.ws')

    // Give the async drain a tick.
    await new Promise((r) => setTimeout(r, 20))
    expect(events).toContain('state-changed')
    sub.unsubscribe()
  })

  it('disabled manager reports empty list and refuses install', async () => {
    const m = new AppPluginManager({
      store,
      stateDir,
      hostVersion: '0.6.0',
      hostNodeMajor: 20,
      sm: smStub,
      disabled: true,
    })
    await m.initialize()
    expect(m.list()).toEqual([])
    const dir = buildPluginDir(stateDir, 'com.example.disabled')
    await expect(m.install({ type: 'local', path: dir })).rejects.toThrow(/disabled/)
  })

  it('same-version reinstall preserves enabled state + granted permissions', async () => {
    const dir = buildPluginDir(stateDir, 'com.example.samever')
    await manager.install({ type: 'local', path: dir })
    await manager.enable('com.example.samever')
    // User re-runs install on the same dir (no version bump).
    const before = manager.get('com.example.samever')!
    expect(before.enabled).toBe(true)

    const result = await manager.install({ type: 'local', path: dir })
    expect(result.permissionRequired).toBe(false)
    const after = manager.get('com.example.samever')!
    // State + consent survive — not reset to disabled/fresh-grants.
    expect(after.enabled).toBe(true)
    expect(after.runtimeState).toBe('inactive')
    expect(after.grantedPermissions.map((p) => p.permission)).toContain('storage')
  })

  it('setPermissions on a disabled plugin does not flip it to inactive', async () => {
    const dir = buildPluginDir(stateDir, 'com.example.setperm')
    await manager.install({ type: 'local', path: dir })
    // Plugin is disabled (fresh install). Granting permissions must NOT
    // produce the inconsistent `enabled:false + runtimeState:'inactive'`.
    await manager.setPermissions('com.example.setperm', ['storage', 'ai.request'])
    const info = manager.get('com.example.setperm')!
    expect(info.enabled).toBe(false)
    expect(info.runtimeState).toBe('disabled')
    expect(info.grantedPermissions.map((p) => p.permission)).toContain('ai.request')
  })
})
