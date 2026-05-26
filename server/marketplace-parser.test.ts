// Pure parser tests — no git, no http. We construct fixture dirs on disk
// and feed them to parseMarketplace().

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { parseMarketplace, MANIFEST_REL_PATH } from './marketplace-parser.js'
import { tempDir } from './__test-utils__/index.js'

function makeRepo(): string {
  const dir = tempDir('mp-parser')
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
  return dir
}

function writeManifest(repo: string, content: unknown): void {
  writeFileSync(join(repo, MANIFEST_REL_PATH), JSON.stringify(content, null, 2), 'utf8')
}

function makePluginDir(repo: string, name: string): void {
  mkdirSync(join(repo, name), { recursive: true })
}

describe('parseMarketplace', () => {
  let repo: string

  beforeEach(() => {
    repo = makeRepo()
  })
  afterEach(() => {
    try {
      rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    } catch {
      /* swallow — tmpdir gets reaped eventually */
    }
  })

  it('parses a happy-path manifest', async () => {
    makePluginDir(repo, 'foo')
    makePluginDir(repo, 'bar')
    writeManifest(repo, {
      name: 'My Marketplace',
      version: '1.0.0',
      owner: { name: 'Alice', url: 'https://example.com' },
      plugins: [
        { name: 'foo', description: 'foo plugin', version: '0.1.0' },
        { name: 'bar', description: 'bar plugin' },
      ],
    })

    const { manifest, warnings } = await parseMarketplace(repo)
    expect(warnings).toEqual([])
    expect(manifest.name).toBe('My Marketplace')
    expect(manifest.version).toBe('1.0.0')
    expect(manifest.owner).toEqual({ name: 'Alice', url: 'https://example.com' })
    expect(manifest.plugins).toHaveLength(2)
    expect(manifest.plugins[0]).toMatchObject({ name: 'foo', description: 'foo plugin' })
    expect(manifest.plugins[0].dir).toBe(join(repo, 'foo'))
    expect(manifest.plugins[1]).toMatchObject({ name: 'bar' })
  })

  it('drops plugins whose directory is missing, surfacing a warning', async () => {
    makePluginDir(repo, 'present')
    // 'absent' is in the manifest but no dir exists for it
    writeManifest(repo, {
      name: 'M',
      plugins: [
        { name: 'present' },
        { name: 'absent' },
      ],
    })
    const { manifest, warnings } = await parseMarketplace(repo)
    expect(manifest.plugins.map((p) => p.name)).toEqual(['present'])
    expect(warnings.some((w) => w.kind === 'plugin-dir-not-found' && w.detail.includes('absent'))).toBe(true)
  })

  it('rejects a manifest with no plugins array', async () => {
    writeManifest(repo, { name: 'M' })
    await expect(parseMarketplace(repo)).rejects.toThrow(/plugins/)
  })

  it('rejects malformed JSON', async () => {
    writeFileSync(join(repo, MANIFEST_REL_PATH), '{ this is not json', 'utf8')
    await expect(parseMarketplace(repo)).rejects.toThrow(/not valid JSON/)
  })

  it('rejects when the manifest file is missing', async () => {
    // No manifest written. The .claude-plugin dir exists but file does not.
    await expect(parseMarketplace(repo)).rejects.toThrow(/not found/)
  })

  it('warns and skips plugin entries with invalid names', async () => {
    makePluginDir(repo, 'good')
    writeManifest(repo, {
      name: 'M',
      plugins: [
        { name: 'good' },
        { name: '../escape' },     // path-traversal in name
        { name: '.hidden' },       // leading dot
        { name: '' },              // empty
        {},                        // missing name
      ],
    })
    const { manifest, warnings } = await parseMarketplace(repo)
    expect(manifest.plugins.map((p) => p.name)).toEqual(['good'])
    // Three invalid + one missing-name → at least 4 warnings.
    expect(warnings.length).toBeGreaterThanOrEqual(4)
  })

  it('honours plugin.source.path when provided', async () => {
    mkdirSync(join(repo, 'subdir', 'nested'), { recursive: true })
    writeManifest(repo, {
      name: 'M',
      plugins: [
        { name: 'plug', source: { source: 'local', path: 'subdir/nested' } },
      ],
    })
    const { manifest } = await parseMarketplace(repo)
    expect(manifest.plugins[0].dir).toBe(join(repo, 'subdir/nested'))
  })

  it('honours plugin.source as a string shorthand pointing at the repo root', async () => {
    // Real-world manifest seen in the wild: { "source": "./" } means the
    // plugin lives at the cloned repo root, not in a subdir named after it.
    writeManifest(repo, {
      name: 'M',
      plugins: [
        { name: 'plug', source: './' },
      ],
    })
    const { manifest, warnings } = await parseMarketplace(repo)
    expect(warnings).toEqual([])
    expect(manifest.plugins).toHaveLength(1)
    expect(manifest.plugins[0].dir).toBe(repo)
  })

  it('honours plugin.source as a string shorthand pointing at a subdir', async () => {
    mkdirSync(join(repo, 'packages', 'plug'), { recursive: true })
    writeManifest(repo, {
      name: 'M',
      plugins: [
        { name: 'plug', source: 'packages/plug' },
      ],
    })
    const { manifest, warnings } = await parseMarketplace(repo)
    expect(warnings).toEqual([])
    expect(manifest.plugins[0].dir).toBe(join(repo, 'packages/plug'))
  })

  it('rejects an absolute source string and falls back to the plugin name', async () => {
    makePluginDir(repo, 'plug')
    writeManifest(repo, {
      name: 'M',
      plugins: [
        { name: 'plug', source: '/etc/passwd' },
      ],
    })
    const { manifest, warnings } = await parseMarketplace(repo)
    expect(manifest.plugins[0].dir).toBe(join(repo, 'plug'))
    expect(warnings.some((w) => w.kind === 'plugin-bad-shape')).toBe(true)
  })

  it('rejects an absolute source.path and falls back to the plugin name', async () => {
    makePluginDir(repo, 'plug')
    writeManifest(repo, {
      name: 'M',
      plugins: [
        { name: 'plug', source: { path: '/etc/passwd' } },
      ],
    })
    const { manifest, warnings } = await parseMarketplace(repo)
    // Falls back to <repo>/plug, which exists.
    expect(manifest.plugins[0].dir).toBe(join(repo, 'plug'))
    expect(warnings.some((w) => w.kind === 'plugin-bad-shape')).toBe(true)
  })

  it('rejects a source.path containing .. segments', async () => {
    makePluginDir(repo, 'plug')
    writeManifest(repo, {
      name: 'M',
      plugins: [
        { name: 'plug', source: { path: '../outside' } },
      ],
    })
    const { manifest, warnings } = await parseMarketplace(repo)
    expect(manifest.plugins[0].dir).toBe(join(repo, 'plug'))
    expect(warnings.some((w) => w.kind === 'plugin-bad-shape')).toBe(true)
  })

  it('drops duplicate plugin names with a warning', async () => {
    makePluginDir(repo, 'dup')
    writeManifest(repo, {
      name: 'M',
      plugins: [
        { name: 'dup' },
        { name: 'dup' },
      ],
    })
    const { manifest, warnings } = await parseMarketplace(repo)
    expect(manifest.plugins).toHaveLength(1)
    expect(warnings.some((w) => w.detail.includes('duplicate'))).toBe(true)
  })
})
