import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolve as resolvePath } from 'node:path'
import { AppPluginStore } from './app-plugin-store.js'
import { AppPluginManager } from './app-plugin-manager.js'
import type { SessionManager } from '../session-manager.js'

// Real fixture dirs (repo-rooted). The test installs them by local-directory
// reference, exactly like the management UI does.
const FIXTURES = resolvePath(__dirname, '..', '..', 'fixtures', 'app-plugins')

// Stub sm: executeCommand for a message-selection context subscribes to
// session-cleared; return null so that branch is skipped (the fixture doesn't
// touch sessions).
const smStub = {
  subscribeSessionCleared: () => null,
} as unknown as SessionManager

describe('App Plugins — fixture integration (Stage D)', () => {
  let stateDir: string
  let manager: AppPluginManager

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'apm-fix-'))
    const store = new AppPluginStore({ stateDir })
    manager = new AppPluginManager({ store, stateDir, hostVersion: '0.6.0', hostNodeMajor: 20, sm: smStub })
  })

  afterEach(async () => {
    await manager.shutdown().catch(() => {})
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  it('fixture.selection: install → enable → selection command → popover', async () => {
    const dir = join(FIXTURES, 'fixture.selection')
    const result = await manager.install({ type: 'local', path: dir })
    expect(result.id).toBe('fixture.selection')

    // Static contribution is registered without activating the subprocess.
    await manager.enable('fixture.selection')
    const info = manager.get('fixture.selection')!
    expect(info.contributions.contextMenus.map((m) => m.location)).toContain('message.selectionContextMenu')

    // Execute the selection command with a MessageSelectionCommandContext.
    const cmd = await manager.executeCommand({
      pluginId: 'fixture.selection',
      commandId: 'fixture.selection.echo',
      context: {
        source: 'message-selection',
        invocationId: '', // server-generated
        commandId: 'fixture.selection.echo',
        invokedAt: Date.now(),
        sessionId: 's-fake',
        messageId: 'm-fake',
        message: { role: 'assistant', contentBlockType: 'text' },
        selection: { text: 'hello world', length: 11, truncated: false },
      } as never,
    })
    expect(cmd.type).toBe('popover')
    if (cmd.type === 'popover') {
      expect(cmd.content).toMatchObject({ kind: 'text' })
      expect((cmd.content as { text: string }).text).toContain('hello world')
    }
  })

  it('fixture.service: storage round-trip command', async () => {
    const dir = join(FIXTURES, 'fixture.service')
    await manager.install({ type: 'local', path: dir })
    await manager.enable('fixture.service')

    const cmd = await manager.executeCommand({
      pluginId: 'fixture.service',
      commandId: 'fixture.service.store',
      context: { source: 'global', commandId: 'fixture.service.store', invokedAt: Date.now() } as never,
    })
    expect(cmd.type).toBe('notification')
    if (cmd.type === 'notification') {
      expect((cmd.content as { text: string }).text).toContain('roundtripped')
    }
  })

  it('fixture.service: crash command → crashed/quarantined state', async () => {
    const dir = join(FIXTURES, 'fixture.service')
    await manager.install({ type: 'local', path: dir })
    await manager.enable('fixture.service')

    const ctx = { source: 'global', commandId: 'fixture.service.crash', invokedAt: Date.now() } as never
    // First crash → crashed state (not yet quarantined).
    await expect(manager.executeCommand({ pluginId: 'fixture.service', commandId: 'fixture.service.crash', context: ctx }))
      .rejects.toThrow()
    expect(['crashed', 'quarantined']).toContain(manager.get('fixture.service')!.runtimeState)
  })

  it('fixture.declarative: install → enable → ping command → notification', async () => {
    const dir = join(FIXTURES, 'fixture.declarative')
    await manager.install({ type: 'local', path: dir })
    await manager.enable('fixture.declarative')

    const info = manager.get('fixture.declarative')!
    expect(info.contributions.actions.map((a) => a.location)).toContain('chat.header')
    expect(info.contributions.configuration.properties.map((p) => p.key)).toContain('fixture.declarative.label')

    const cmd = await manager.executeCommand({
      pluginId: 'fixture.declarative',
      commandId: 'fixture.declarative.ping',
      context: { source: 'global', commandId: 'fixture.declarative.ping', invokedAt: Date.now() } as never,
    })
    expect(cmd.type).toBe('notification')
    if (cmd.type === 'notification') {
      // Default config label is "pong".
      expect((cmd.content as { text: string }).text).toBe('pong')
    }
  })
})
