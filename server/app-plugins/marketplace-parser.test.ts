import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseAppPluginMarketplace, pluginDirInClone } from './marketplace-parser.js'

function writePlugin(dir: string, id: string) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'crw-plugin.json'), JSON.stringify({ manifestVersion: 1, id, name: id, version: '1.0.0', engines: { claudeReactWeb: '^0.6.0', node: '>=20' }, runtime: { service: 'dist/service.mjs' }, permissions: [], contributes: { commands: [], contextMenus: [], actions: [], configuration: { properties: [] } } }))
}

describe('parseAppPluginMarketplace', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mp-parse-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) })

  it('reads app-plugins-marketplace.json when present', async () => {
    writePlugin(join(root, 'translator'), 'translator.claude-react-web')
    writePlugin(join(root, 'other'), 'other.plugin')
    writeFileSync(join(root, 'app-plugins-marketplace.json'), JSON.stringify({
      name: 'Test Market',
      appPlugins: [{ name: 'translator', dir: 'translator', description: 'translate', version: '1.0.0' }],
    }))
    const res = await parseAppPluginMarketplace(root)
    expect(res.name).toBe('Test Market')
    expect(res.plugins).toHaveLength(1)
    expect(res.plugins[0]).toMatchObject({ name: 'translator', dir: 'translator' })
  })

  it('auto-scans top-level subdirs for crw-plugin.json when no manifest', async () => {
    writePlugin(join(root, 'alpha'), 'com.example.alpha')
    writePlugin(join(root, 'beta'), 'com.example.beta')
    mkdirSync(join(root, 'not-a-plugin'), { recursive: true }) // no manifest → skipped
    const res = await parseAppPluginMarketplace(root)
    expect(res.plugins.map((p) => p.name).sort()).toEqual(['com.example.alpha', 'com.example.beta'])
  })

  it('drops entries with a non-contained dir (.. / absolute)', async () => {
    writeFileSync(join(root, 'app-plugins-marketplace.json'), JSON.stringify({
      appPlugins: [
        { name: 'ok', dir: 'ok' },
        { name: 'escape', dir: '../../etc' },
        { name: 'abs', dir: '/etc' },
      ],
    }))
    const res = await parseAppPluginMarketplace(root)
    expect(res.plugins.map((p) => p.name)).toEqual(['ok'])
  })

  it('de-duplicates entries by name', async () => {
    writeFileSync(join(root, 'app-plugins-marketplace.json'), JSON.stringify({
      appPlugins: [
        { name: 'dup', dir: 'a' },
        { name: 'dup', dir: 'b' },
      ],
    }))
    const res = await parseAppPluginMarketplace(root)
    expect(res.plugins).toHaveLength(1)
  })

  it('returns an empty catalog (not an error) when nothing is found', async () => {
    const res = await parseAppPluginMarketplace(root)
    expect(res.plugins).toEqual([])
  })

  it('pluginDirInClone resolves a contained dir under the root', () => {
    expect(pluginDirInClone(root, 'translator')).toBe(join(root, 'translator'))
  })
})
