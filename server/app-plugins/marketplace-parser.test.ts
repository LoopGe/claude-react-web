import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import { tmpdir } from 'node:os'
import {
  parseAppPluginMarketplace,
  parseAppPluginMarketplaceAuto,
  detectAppPluginMarketplaceSubdir,
  pluginDirInClone,
} from './marketplace-parser.js'

// The real marketplace dir shipped in the repo (plugins/).
const PLUGINS_DIR = resolvePath(__dirname, '..', '..', 'plugins')

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

describe('parseAppPluginMarketplace — subdir', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mp-parse-sub-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) })

  it('parses a marketplace whose catalog lives in a subdir', async () => {
    writePlugin(join(root, 'plugins', 'translator'), 'translator.claude-react-web')
    writeFileSync(join(root, 'plugins', 'app-plugins-marketplace.json'), JSON.stringify({
      name: 'Nested Market',
      appPlugins: [{ name: 'translator', dir: 'translator' }],
    }))
    const res = await parseAppPluginMarketplace(root, 'plugins')
    expect(res.name).toBe('Nested Market')
    expect(res.plugins.map((p) => p.name)).toEqual(['translator'])
  })

  it('auto-scans the subdir when it has no manifest', async () => {
    writePlugin(join(root, 'plugins', 'alpha'), 'com.example.alpha')
    const res = await parseAppPluginMarketplace(root, 'plugins')
    expect(res.plugins.map((p) => p.name)).toEqual(['com.example.alpha'])
  })

  it('throws on an invalid (escaping) subdir', async () => {
    await expect(parseAppPluginMarketplace(root, '../escape')).rejects.toThrow(/subdir/)
  })

  it('pluginDirInClone resolves inside the subdir', () => {
    expect(pluginDirInClone(root, 'translator', 'plugins')).toBe(join(root, 'plugins', 'translator'))
  })
})

describe('parseAppPluginMarketplace — real plugins/ dir', () => {
  it('lists the translator from the shipped marketplace catalog', async () => {
    const res = await parseAppPluginMarketplace(PLUGINS_DIR)
    const translator = res.plugins.find((p) => p.name === 'translator')
    expect(translator).toBeDefined()
    expect(translator?.dir).toBe('translator')
  })
})

describe('detectAppPluginMarketplaceSubdir', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mp-detect-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) })

  it('returns undefined when the root has no candidate content dir', async () => {
    expect(await detectAppPluginMarketplaceSubdir(root)).toBeUndefined()
  })

  it('returns a child dir that ships an app-plugins-marketplace.json', async () => {
    writePlugin(join(root, 'plugins', 'alpha'), 'com.alpha')
    writeFileSync(join(root, 'plugins', 'app-plugins-marketplace.json'), JSON.stringify({
      appPlugins: [{ name: 'alpha', dir: 'alpha' }],
    }))
    expect(await detectAppPluginMarketplaceSubdir(root)).toBe('plugins')
  })

  it('returns a child dir whose subdirs are plugin dirs (no catalog)', async () => {
    writePlugin(join(root, 'plugins', 'alpha'), 'com.alpha')
    expect(await detectAppPluginMarketplaceSubdir(root)).toBe('plugins')
  })

  it('returns undefined when several child dirs look like content', async () => {
    writePlugin(join(root, 'a', 'alpha'), 'com.a')
    writePlugin(join(root, 'b', 'beta'), 'com.b')
    expect(await detectAppPluginMarketplaceSubdir(root)).toBeUndefined()
  })

  it('ignores files and dirs without plugin manifests', async () => {
    writeFileSync(join(root, 'README.md'), 'hi')
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'docs', 'readme.txt'), 'x')
    expect(await detectAppPluginMarketplaceSubdir(root)).toBeUndefined()
  })

  it('ignores a child dir shipping only an empty catalog (decoy)', async () => {
    mkdirSync(join(root, 'examples'), { recursive: true })
    writeFileSync(join(root, 'examples', 'app-plugins-marketplace.json'), JSON.stringify({ appPlugins: [] }))
    expect(await detectAppPluginMarketplaceSubdir(root)).toBeUndefined()
  })

  it('does not let an empty-catalog decoy shadow a real content dir', async () => {
    writePlugin(join(root, 'plugins', 'alpha'), 'com.alpha')
    mkdirSync(join(root, 'examples'), { recursive: true })
    writeFileSync(join(root, 'examples', 'app-plugins-marketplace.json'), JSON.stringify({ appPlugins: [] }))
    expect(await detectAppPluginMarketplaceSubdir(root)).toBe('plugins')
  })
})

describe('parseAppPluginMarketplaceAuto', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mp-auto-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) })

  it('auto-detects a nested content dir when none was given', async () => {
    writePlugin(join(root, 'plugins', 'feishu.bridge'), 'feishu.bridge')
    writeFileSync(join(root, 'plugins', 'app-plugins-marketplace.json'), JSON.stringify({
      name: 'Feishu Bridge',
      appPlugins: [{ name: 'feishu.bridge', dir: 'feishu.bridge' }],
    }))
    const res = await parseAppPluginMarketplaceAuto(root)
    expect(res.subdir).toBe('plugins')
    expect(res.manifest.plugins.map((p) => p.name)).toEqual(['feishu.bridge'])
  })

  it('auto-detects nested content even when the nested catalog schema is off, via auto-scan', async () => {
    // Monorepo layout whose catalog file uses the wrong keys (`plugins`/`id`
    // instead of `appPlugins`/`name`) — detection still lands on the dir and
    // the fallback auto-scan finds the plugin by its crw-plugin.json.
    writePlugin(join(root, 'plugins', 'feishu.bridge'), 'feishu.bridge')
    writeFileSync(join(root, 'plugins', 'app-plugins-marketplace.json'), JSON.stringify({
      name: 'Feishu Bridge',
      plugins: [{ id: 'feishu.bridge', dir: 'feishu.bridge' }],
    }))
    const res = await parseAppPluginMarketplaceAuto(root)
    expect(res.subdir).toBe('plugins')
    expect(res.manifest.plugins.map((p) => p.name)).toEqual(['feishu.bridge'])
  })

  it('respects an explicit subdir and does not detect', async () => {
    writePlugin(join(root, 'plugins', 'alpha'), 'com.alpha')
    const res = await parseAppPluginMarketplaceAuto(root, 'plugins')
    expect(res.subdir).toBe('plugins')
    expect(res.manifest.plugins.map((p) => p.name)).toEqual(['com.alpha'])
  })

  it('returns undefined subdir when content sits at the root', async () => {
    writePlugin(join(root, 'alpha'), 'com.alpha')
    const res = await parseAppPluginMarketplaceAuto(root)
    expect(res.subdir).toBeUndefined()
    expect(res.manifest.plugins.map((p) => p.name)).toEqual(['com.alpha'])
  })

  it('returns empty when no content exists anywhere', async () => {
    const res = await parseAppPluginMarketplaceAuto(root)
    expect(res.subdir).toBeUndefined()
    expect(res.manifest.plugins).toEqual([])
  })

  it('leaves an ambiguous repo (two content dirs) unresolved', async () => {
    writePlugin(join(root, 'a', 'alpha'), 'com.a')
    writePlugin(join(root, 'b', 'beta'), 'com.b')
    const res = await parseAppPluginMarketplaceAuto(root)
    expect(res.subdir).toBeUndefined()
    expect(res.manifest.plugins).toEqual([])
  })

  it('falls back to root detection when an explicit subdir does not exist', async () => {
    writePlugin(join(root, 'plugins', 'alpha'), 'com.alpha')
    const res = await parseAppPluginMarketplaceAuto(root, 'no-such-dir')
    expect(res.subdir).toBe('plugins')
    expect(res.manifest.plugins.map((p) => p.name)).toEqual(['com.alpha'])
  })

  it('heals a stale subdir whose directory was removed (content moved to root)', async () => {
    writePlugin(join(root, 'alpha'), 'com.alpha')
    // A persisted subdir 'plugins' whose dir no longer exists on disk.
    const res = await parseAppPluginMarketplaceAuto(root, 'plugins')
    expect(res.subdir).toBeUndefined()
    expect(res.manifest.plugins.map((p) => p.name)).toEqual(['com.alpha'])
  })

  it('prefers nested content over an empty root catalog (content wins)', async () => {
    writePlugin(join(root, 'plugins', 'alpha'), 'com.alpha')
    writeFileSync(join(root, 'app-plugins-marketplace.json'), JSON.stringify({
      name: 'Empty Market',
      appPlugins: [],
    }))
    const res = await parseAppPluginMarketplaceAuto(root)
    expect(res.subdir).toBe('plugins')
    expect(res.manifest.plugins.map((p) => p.name)).toEqual(['com.alpha'])
  })

  it('heals a stale-but-present subdir whose content moved to the root', async () => {
    // plugins/ still exists on disk (a stray file keeps git from pruning it)
    // but holds no plugins; the real content now sits at the repo root.
    writePlugin(join(root, 'alpha'), 'com.alpha')
    mkdirSync(join(root, 'plugins'), { recursive: true })
    writeFileSync(join(root, 'plugins', 'README.md'), 'stray')
    const res = await parseAppPluginMarketplaceAuto(root, 'plugins')
    expect(res.subdir).toBeUndefined()
    expect(res.manifest.plugins.map((p) => p.name)).toEqual(['com.alpha'])
  })

  it('does not pin a detected dir that yields no plugins', async () => {
    // Only a decoy: a nested dir shipping an empty catalog. Nothing yields
    // content, so no subdir is persisted and a refresh stays free to re-search.
    mkdirSync(join(root, 'examples'), { recursive: true })
    writeFileSync(join(root, 'examples', 'app-plugins-marketplace.json'), JSON.stringify({
      name: 'Decoy',
      appPlugins: [],
    }))
    const res = await parseAppPluginMarketplaceAuto(root)
    expect(res.subdir).toBeUndefined()
    expect(res.manifest.plugins).toEqual([])
  })

  it('heals a persisted subdir whose catalog is malformed, falling back to root content', async () => {
    // Record still points at subdir 'plugins', which now holds a BROKEN catalog
    // (a restructure vestige) while the real content sits at the root. The
    // malformed catalog must not abort the search — the auto path falls through
    // and heals to the root content.
    writePlugin(join(root, 'alpha'), 'com.alpha')
    mkdirSync(join(root, 'plugins'), { recursive: true })
    writeFileSync(join(root, 'plugins', 'app-plugins-marketplace.json'), '{ this is not json ')
    const res = await parseAppPluginMarketplaceAuto(root, 'plugins')
    expect(res.subdir).toBeUndefined()
    expect(res.manifest.plugins.map((p) => p.name)).toEqual(['com.alpha'])
  })

  it('heals a detected dir whose catalog is malformed but which holds real plugin dirs', async () => {
    // Root has no content; the nested plugins/ dir has a BROKEN catalog but a
    // real plugin dir on disk. Detection lands on plugins/ and auto-scan finds
    // the on-disk plugin (malformed catalog ≠ content).
    writePlugin(join(root, 'plugins', 'alpha'), 'com.alpha')
    writeFileSync(join(root, 'plugins', 'app-plugins-marketplace.json'), '{ also broken ')
    const res = await parseAppPluginMarketplaceAuto(root)
    expect(res.subdir).toBe('plugins')
    expect(res.manifest.plugins.map((p) => p.name)).toEqual(['com.alpha'])
  })

  it('surfaces a malformed catalog when nothing else yields content', async () => {
    // A wholly-broken marketplace (malformed catalog, no plugin dirs anywhere)
    // must still throw so the route 400s instead of silently adding 0 plugins.
    writeFileSync(join(root, 'app-plugins-marketplace.json'), '{ broken ')
    await expect(parseAppPluginMarketplaceAuto(root)).rejects.toThrow(/failed to read/)
  })

  it('prefers on-disk plugin dirs over an empty catalog in a detected dir (detect/parse agree)', async () => {
    // plugins/ ships an EMPTY catalog but alpha/crw-plugin.json is on disk —
    // detect flags plugins/ as content (child plugin dir) and auto-scan must
    // surface alpha rather than trusting the empty catalog as authoritative.
    writePlugin(join(root, 'plugins', 'alpha'), 'com.alpha')
    writeFileSync(join(root, 'plugins', 'app-plugins-marketplace.json'), JSON.stringify({
      name: 'Stale Market',
      appPlugins: [],
    }))
    const res = await parseAppPluginMarketplaceAuto(root)
    expect(res.subdir).toBe('plugins')
    expect(res.manifest.plugins.map((p) => p.name)).toEqual(['com.alpha'])
  })

  it('ignores a decoy catalog whose entries all fail coercion when detecting', async () => {
    // examples/ ships a NON-empty catalog, but every entry has an invalid dir
    // and is dropped by coercion → it yields zero plugins and must not count as
    // a content candidate (otherwise it would make a single-real-content repo
    // look "ambiguous").
    writePlugin(join(root, 'plugins', 'alpha'), 'com.alpha')
    mkdirSync(join(root, 'examples'), { recursive: true })
    writeFileSync(join(root, 'examples', 'app-plugins-marketplace.json'), JSON.stringify({
      name: 'Decoy',
      appPlugins: [{ name: 'escape', dir: '../../etc' }],
    }))
    const res = await parseAppPluginMarketplaceAuto(root)
    expect(res.subdir).toBe('plugins')
    expect(res.manifest.plugins.map((p) => p.name)).toEqual(['com.alpha'])
  })
})
