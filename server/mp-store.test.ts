// MpStore round-trip + slug + collision-suffix tests.
//
// We don't exercise the cacheDir or git-clone paths here ?those are
// covered by the route tests which mock git-clone. This file is purely
// about persistence semantics.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { MANIFEST_REL_PATH } from './marketplace-parser.js'
import { MpStore, type MpEntry } from './mp-store.js'
import type { MarketplaceManifest } from './marketplace-parser.js'
import { tempDir } from './__test-utils__/index.js'

function fakeManifest(plugins: string[] = []): MarketplaceManifest {
  return {
    name: 'fake',
    plugins: plugins.map((name) => ({ name, dir: `/fake/${name}` })),
  }
}

function fakeEntry(id: string, opts: Partial<MpEntry> = {}): MpEntry {
  return {
    id,
    displayName: opts.displayName ?? id,
    source: opts.source ?? { type: 'https', url: `https://example.com/${id}.git` },
    cloneDir: opts.cloneDir ?? `/tmp/${id}`,
    addedAt: opts.addedAt ?? 1_700_000_000_000,
    lastRefreshedAt: opts.lastRefreshedAt ?? 1_700_000_000_000,
    lastSha: opts.lastSha ?? 'a'.repeat(40),
    manifest: opts.manifest ?? fakeManifest(['plugA']),
  }
}

describe('MpStore', () => {
  let dir: string

  beforeEach(() => {
    dir = tempDir('mp-store')
  })
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    } catch { /* swallow */ }
  })

  it('persists and reloads an empty store', async () => {
    const s = new MpStore({ stateDir: dir })
    await s.load()
    expect(s.list()).toEqual([])
    await s.flush()
  })

  it('round-trips an entry through disk', async () => {
    const s = new MpStore({ stateDir: dir })
    await s.load()
    s.upsert(fakeEntry('mkt1'))
    await s.flush()

    const s2 = new MpStore({ stateDir: dir })
    const loaded = await s2.load()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].id).toBe('mkt1')
    expect(s2.get('mkt1')?.manifest.plugins[0].name).toBe('plugA')
  })

  it('re-parses cached clone manifests on load', async () => {
    const cloneDir = join(dir, 'marketplace-cache', 'official')
    const manifestPath = join(cloneDir, MANIFEST_REL_PATH)
    mkdirSync(dirname(manifestPath), { recursive: true })
    writeFileSync(
      manifestPath,
      JSON.stringify({
        name: 'official',
        plugins: [
          { name: 'legacy-local' },
          {
            name: 'atlassian',
            description: 'Atlassian tools',
            category: 'productivity',
            source: {
              source: 'url',
              url: 'https://github.com/atlassian/atlassian-mcp-server.git',
              sha: 'f4911dba81f25782c88815b03deabf444cd46e0d',
            },
          },
        ],
      }),
      'utf8',
    )
    mkdirSync(join(cloneDir, 'legacy-local'), { recursive: true })

    const s = new MpStore({ stateDir: dir })
    await s.load()
    s.upsert(fakeEntry('official', {
      displayName: 'old official',
      cloneDir,
      manifest: fakeManifest(['legacy-local']),
    }))
    await s.flush()

    const reloaded = new MpStore({ stateDir: dir })
    const loaded = await reloaded.load()

    expect(loaded).toHaveLength(1)
    expect(reloaded.get('official')?.displayName).toBe('official')
    expect(reloaded.get('official')?.manifest.plugins.map((p) => p.name)).toEqual(['legacy-local', 'atlassian'])
    expect(reloaded.get('official')?.manifest.plugins.find((p) => p.name === 'atlassian')?.source).toEqual({
      kind: 'git-subdir',
      url: 'https://github.com/atlassian/atlassian-mcp-server.git',
      subPath: '.',
      ref: undefined,
      sha: 'f4911dba81f25782c88815b03deabf444cd46e0d',
    })

    const raw = JSON.parse(readFileSync(join(dir, 'marketplaces.json'), 'utf8')) as { marketplaces: Record<string, MpEntry> }
    expect(raw.marketplaces.official.manifest.plugins.map((p) => p.name)).toEqual(['legacy-local', 'atlassian'])
  })

  it('persists and reloads enabled-plugin flags', async () => {
    const s = new MpStore({ stateDir: dir })
    await s.load()
    s.upsert(fakeEntry('mkt1', { manifest: fakeManifest(['plugA', 'plugB']) }))
    s.setEnabled('plugA', 'mkt1', true)
    await s.flush()

    const s2 = new MpStore({ stateDir: dir })
    await s2.load()
    expect(s2.isEnabled('plugA', 'mkt1')).toBe(true)
    expect(s2.isEnabled('plugB', 'mkt1')).toBe(false)
  })

  it('drops the enabled flag (rather than persisting `false`) on disable', async () => {
    const s = new MpStore({ stateDir: dir })
    await s.load()
    s.upsert(fakeEntry('mkt1'))
    s.setEnabled('plugA', 'mkt1', true)
    await s.flush()

    s.setEnabled('plugA', 'mkt1', false)
    await s.flush()
    const raw = readFileSync(join(dir, 'marketplaces.json'), 'utf8')
    const onDisk = JSON.parse(raw) as { enabledPlugins: Record<string, unknown> }
    expect(onDisk.enabledPlugins).toEqual({})
  })

  it('removes related enabled-plugin entries when an entry is removed', async () => {
    const s = new MpStore({ stateDir: dir })
    await s.load()
    s.upsert(fakeEntry('mkt1', { manifest: fakeManifest(['p1']) }))
    s.upsert(fakeEntry('mkt2', { manifest: fakeManifest(['p2']) }))
    s.setEnabled('p1', 'mkt1', true)
    s.setEnabled('p2', 'mkt2', true)
    await s.flush()

    // mkt1's clone dir doesn't exist on disk; removeEntry swallows the
    // rm error so the test is OK.
    await s.removeEntry('mkt1')

    expect(s.has('mkt1')).toBe(false)
    expect(s.isEnabled('p1', 'mkt1')).toBe(false)
    expect(s.isEnabled('p2', 'mkt2')).toBe(true)
  })

  it('generates safe slugs from URLs', () => {
    const s = new MpStore({ stateDir: dir })
    expect(s.generateId('https://github.com/owner/myrepo.git')).toBe('myrepo')
    expect(s.generateId('https://github.com/owner/My_Repo')).toBe('My_Repo')
    expect(s.generateId('https://example.com/foo/bar/')).toBe('bar')
    expect(s.generateId('https://example.com/.hidden/')).toBe('hidden')
  })

  it('appends a numeric suffix when slugs collide', async () => {
    const s = new MpStore({ stateDir: dir })
    await s.load()
    s.upsert(fakeEntry('myrepo'))
    expect(s.generateId('https://github.com/owner/myrepo.git')).toBe('myrepo-2')
    s.upsert(fakeEntry('myrepo-2'))
    expect(s.generateId('https://github.com/owner/myrepo.git')).toBe('myrepo-3')
  })

  it('returns absolute paths for enabled plugins', async () => {
    const s = new MpStore({ stateDir: dir })
    await s.load()
    s.upsert(fakeEntry('mkt1', {
      manifest: {
        name: 'fake',
        plugins: [
          { name: 'plugA', dir: '/abs/path/to/plugA' },
          { name: 'plugB', dir: '/abs/path/to/plugB' },
        ],
      },
    }))
    s.setEnabled('plugA', 'mkt1', true)
    s.setEnabled('plugB', 'mkt1', false)
    expect(s.getEnabledPluginAbsolutePaths()).toEqual(['/abs/path/to/plugA'])
  })

  it('dedupes paths when two enabled plugins resolve to the same dir', async () => {
    const s = new MpStore({ stateDir: dir })
    await s.load()
    // Two distinct plugins in one marketplace pointing at the same dir.
    s.upsert(fakeEntry('mkt1', {
      manifest: {
        name: 'fake',
        plugins: [
          { name: 'a', dir: '/abs/shared' },
          { name: 'b', dir: '/abs/shared' },
        ],
      },
    }))
    s.setEnabled('a', 'mkt1', true)
    s.setEnabled('b', 'mkt1', true)
    expect(s.getEnabledPluginAbsolutePaths()).toEqual(['/abs/shared'])
  })

  it('skips enabled plugins whose marketplace or plugin no longer exists', async () => {
    const s = new MpStore({ stateDir: dir })
    await s.load()
    // Stage an enabled flag for a marketplace that doesn't exist by
    // hand-writing the JSON file, then reloa?.
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'marketplaces.json'),
      JSON.stringify({
        version: 1,
        marketplaces: {},
        enabledPlugins: { 'ghost@phantom': true },
      }),
      'utf8',
    )
    await s.load()
    expect(s.getEnabledPluginAbsolutePaths()).toEqual([])
  })

  it('externalCloneDir is deterministic and shared per (url, sha)', () => {
    const s = new MpStore({ stateDir: dir })
    const url = 'https://github.com/adobe/skills.git'
    const sha = 'e23271f65aa7572f567d085d6baec5c2408e2ad5'
    const a = s.externalCloneDir(url, sha)
    const b = s.externalCloneDir(url, sha)
    expect(a).toBe(b)
    // Different sha ?different dir.
    expect(s.externalCloneDir(url, 'f'.repeat(40))).not.toBe(a)
    // Lives under the _external cache.
    expect(a.startsWith(s.externalCacheDir)).toBe(true)
  })

  it('resolves a git-subdir plugin path only when the external clone exists', async () => {
    const s = new MpStore({ stateDir: dir })
    await s.load()
    const url = 'https://github.com/adobe/skills.git'
    const sha = 'e23271f65aa7572f567d085d6baec5c2408e2ad5'
    const subPath = 'plugins/creative-cloud/adobe-for-creativity'
    s.upsert(fakeEntry('mkt1', {
      manifest: {
        name: 'fake',
        plugins: [
          { name: 'adobe', dir: null, source: { kind: 'git-subdir', url, subPath, sha } },
        ],
      },
    }))
    s.setEnabled('adobe', 'mkt1', true)

    // Not cloned yet ?excluded.
    expect(s.getEnabledPluginAbsolutePaths()).toEqual([])

    // Materialise the external clone subdir ?now resolved.
    const cloneDir = s.externalCloneDir(url, sha)
    const full = join(cloneDir, subPath)
    mkdirSync(full, { recursive: true })
    expect(s.getEnabledPluginAbsolutePaths()).toEqual([full])
  })

  it('drops a hand-edited git-subdir plugin whose subPath escapes the clone dir', async () => {
    // Simulate a tampered marketplaces.json with a path-traversal subPath.
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'marketplaces.json'),
      JSON.stringify({
        version: 1,
        marketplaces: {
          mkt1: {
            id: 'mkt1',
            displayName: 'mkt1',
            source: { type: 'https', url: 'https://example.com/mkt1.git' },
            cloneDir: '/tmp/mkt1',
            addedAt: 1,
            lastRefreshedAt: 1,
            lastSha: 'a'.repeat(40),
            manifest: {
              name: 'mkt1',
              plugins: [
                {
                  name: 'evil',
                  dir: null,
                  source: { kind: 'git-subdir', url: 'https://example.com/x.git', subPath: '../../../../etc', sha: 'a'.repeat(40) },
                },
                {
                  name: 'ok',
                  dir: null,
                  source: { kind: 'git-subdir', url: 'https://example.com/x.git', subPath: 'plugins/ok', sha: 'b'.repeat(40) },
                },
              ],
            },
          },
        },
        enabledPlugins: { 'evil@mkt1': true },
      }),
      'utf8',
    )
    const s = new MpStore({ stateDir: dir })
    await s.load()
    // The traversal plugin is filtered out on load; the safe one survives.
    const names = s.get('mkt1')!.manifest.plugins.map((p) => p.name)
    expect(names).toEqual(['ok'])
    // And its enabled flag resolves to nothing (plugin no longer exists).
    expect(s.getEnabledPluginAbsolutePaths()).toEqual([])
  })

  it('snapshot enabledMapFor returns only that marketplace', async () => {
    const s = new MpStore({ stateDir: dir })
    await s.load()
    s.upsert(fakeEntry('mkt1', { manifest: fakeManifest(['a', 'b']) }))
    s.upsert(fakeEntry('mkt2', { manifest: fakeManifest(['c']) }))
    s.setEnabled('a', 'mkt1', true)
    s.setEnabled('c', 'mkt2', true)
    expect(s.enabledMapFor('mkt1')).toEqual({ a: true })
    expect(s.enabledMapFor('mkt2')).toEqual({ c: true })
  })
})
