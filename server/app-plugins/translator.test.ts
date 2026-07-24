import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolve as resolvePath } from 'node:path'
import { AppPluginStore } from './app-plugin-store.js'
import { AppPluginManager } from './app-plugin-manager.js'
import type { SessionManager } from '../session-manager.js'

const smStub = { subscribeSessionCleared: () => null } as unknown as SessionManager
const TRANSLATOR_DIR = resolvePath(__dirname, '..', '..', 'plugins', 'translator')

describe('translator plugin — install + manifest against the framework', () => {
  let stateDir: string
  let manager: AppPluginManager

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'translator-'))
    const store = new AppPluginStore({ stateDir })
    manager = new AppPluginManager({ store, stateDir, hostVersion: '0.6.0', hostNodeMajor: 20, sm: smStub })
  })

  afterEach(async () => {
    await manager.shutdown().catch(() => {})
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  it('installs from the real plugins/translator dir with the expected surface', async () => {
    const result = await manager.install({ type: 'local', path: TRANSLATOR_DIR })
    expect(result.id).toBe('translator.claude-react-web')

    const info = manager.get('translator.claude-react-web')!
    expect(info.enabled).toBe(false)

    // Declared permissions cover the translation flow.
    const perms = info.declaredPermissions.map((p) => p.permission)
    expect(perms).toEqual(expect.arrayContaining(['messages.selectedText', 'ai.request', 'storage']))

    // The selection context menu is contributed, gated on hasSelection.
    const menu = info.contributions.contextMenus.find((m) => m.location === 'message.selectionContextMenu')
    expect(menu).toBeDefined()
    expect(menu?.commandId).toBe('translator.claude-react-web.translate')
    expect(menu?.when).toBe('message.hasSelection == true')

    // The command is message-selection category.
    const cmd = info.contributions.commands.find((c) => c.id === 'translator.claude-react-web.translate')
    expect(cmd?.category).toBe('message.selection')

    // The target-language config is an enum with the expected options + default.
    const target = info.contributions.configuration.properties.find((p) => p.key === 'translator.claude-react-web.target')
    expect(target?.type).toBe('enum')
    expect(target?.enum).toEqual(expect.arrayContaining(['zh-CN', 'en', 'ja']))
    expect(target?.default).toBe('zh-CN')

    const cache = info.contributions.configuration.properties.find((p) => p.key === 'translator.claude-react-web.cache')
    expect(cache?.type).toBe('boolean')
    expect(cache?.default).toBe(true)
  })

  it('exposes the resolved configuration (defaults applied) via getConfiguration', async () => {
    await manager.install({ type: 'local', path: TRANSLATOR_DIR })
    const config = await manager.getConfiguration('translator.claude-react-web')
    expect(config['translator.claude-react-web.target']).toBe('zh-CN')
    expect(config['translator.claude-react-web.cache']).toBe(true)
  })
})
