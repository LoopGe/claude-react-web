// Pure parser tests — no git, no http. We construct fixture dirs on disk
// and feed them to parseMarketplace().

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  parseMarketplace,
  parseSinglePlugin,
  parseRepoManifest,
  MANIFEST_REL_PATH,
  PLUGIN_MANIFEST_REL_PATH,
} from './marketplace-parser.js'
import { tempDir } from './__test-utils__/index.js'

function makeRepo(): string {
  const dir = tempDir('mp-parser')
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
  return dir
}

function writeManifest(repo: string, content: unknown): void {
  writeFileSync(join(repo, MANIFEST_REL_PATH), JSON.stringify(content, null, 2), 'utf8')
}

function writePluginManifest(repo: string, content: unknown): void {
  writeFileSync(join(repo, PLUGIN_MANIFEST_REL_PATH), JSON.stringify(content, null, 2), 'utf8')
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
    // plugin lives at the cloned repo root, not in a subdir name after it.
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

  // ── git-subdir source (plugin lives in a separate external repo) ──

  const GIT_SUBDIR_SHA = 'e23271f65aa7572f567d085d6baec5c2408e2ad5'

  it('captures a git-subdir source without emitting dir-not-found', async () => {
    // No on-disk dir is created — the external repo isn't cloned at parse time.
    writeManifest(repo, {
      name: 'M',
      plugins: [
        {
          name: 'adobe-for-creativity',
          description: 'Adobe creative tools',
          source: {
            source: 'git-subdir',
            url: 'https://github.com/adobe/skills.git',
            path: 'plugins/creative-cloud/adobe-for-creativity',
            ref: 'main',
            sha: GIT_SUBDIR_SHA,
          },
        },
      ],
    })
    const { manifest, warnings } = await parseMarketplace(repo)
    expect(warnings).toEqual([])
    expect(manifest.plugins).toHaveLength(1)
    expect(manifest.plugins[0].dir).toBeNull()
    expect(manifest.plugins[0].source).toEqual({
      kind: 'git-subdir',
      url: 'https://github.com/adobe/skills.git',
      subPath: 'plugins/creative-cloud/adobe-for-creativity',
      ref: 'main',
      sha: GIT_SUBDIR_SHA,
    })
  })

  it('captures a `url` source as the external repo root', async () => {
    // `source: 'url'` means the WHOLE external repo is the plugin (no path).
    writeManifest(repo, {
      name: 'M',
      plugins: [
        {
          name: 'agentforce-adlc',
          source: {
            source: 'url',
            url: 'https://github.com/SalesforceAIResearch/agentforce-adlc.git',
            sha: GIT_SUBDIR_SHA,
          },
        },
      ],
    })
    const { manifest, warnings } = await parseMarketplace(repo)
    expect(warnings).toEqual([])
    expect(manifest.plugins).toHaveLength(1)
    expect(manifest.plugins[0].dir).toBeNull()
    expect(manifest.plugins[0].source).toEqual({
      kind: 'git-subdir',
      url: 'https://github.com/SalesforceAIResearch/agentforce-adlc.git',
      subPath: '.',
      ref: undefined,
      sha: GIT_SUBDIR_SHA,
    })
  })

  it('captures a `github` source (Anthropic convention) as git-subdir', async () => {
    // The `github` source type names an external GitHub repo by `owner/name`
    // and pins it at `sha`. No on-disk dir is created at parse time.
    writeManifest(repo, {
      name: 'M',
      plugins: [
        {
          name: 'fullstory',
          description: 'Connect Claude to Fullstory.',
          source: {
            source: 'github',
            repo: 'fullstorydev/fullstory-skills',
            commit: '1ec5865e7ab1449f9a0859d164c4b6a8c53b6e2f',
            sha: 'b20614e2d08d7a7c70775bb62b5af640f60b024b',
          },
        },
      ],
    })
    const { manifest, warnings } = await parseMarketplace(repo)
    expect(warnings).toEqual([])
    expect(manifest.plugins).toHaveLength(1)
    expect(manifest.plugins[0].dir).toBeNull()
    expect(manifest.plugins[0].source).toEqual({
      kind: 'git-subdir',
      url: 'https://github.com/fullstorydev/fullstory-skills',
      subPath: '.',
      ref: undefined,
      sha: 'b20614e2d08d7a7c70775bb62b5af640f60b024b',
    })
  })

  it('falls back to `commit` when a `github` source has no sha', async () => {
    writeManifest(repo, {
      name: 'M',
      plugins: [
        {
          name: 'p',
          source: {
            source: 'github',
            repo: 'o/r',
            commit: GIT_SUBDIR_SHA,
          },
        },
      ],
    })
    const { manifest, warnings } = await parseMarketplace(repo)
    expect(warnings).toEqual([])
    expect(manifest.plugins[0].source).toMatchObject({ kind: 'git-subdir', sha: GIT_SUBDIR_SHA })
  })

  it('skips a `github` source with an invalid repo', async () => {
    writeManifest(repo, {
      name: 'M',
      plugins: [
        { name: 'p', source: { source: 'github', repo: '../escape', sha: GIT_SUBDIR_SHA } },
      ],
    })
    const { manifest, warnings } = await parseMarketplace(repo)
    expect(manifest.plugins).toHaveLength(0)
    expect(warnings.some((w) => w.kind === 'plugin-bad-shape' && w.detail.includes('invalid repo'))).toBe(true)
    expect(warnings.some((w) => w.kind === 'plugin-dir-not-found')).toBe(false)
  })

  it('skips a `github` source missing both sha and commit', async () => {
    writeManifest(repo, {
      name: 'M',
      plugins: [
        { name: 'p', source: { source: 'github', repo: 'o/r' } },
      ],
    })
    const { manifest, warnings } = await parseMarketplace(repo)
    expect(manifest.plugins).toHaveLength(0)
    expect(warnings.some((w) => w.kind === 'plugin-bad-shape' && w.detail.includes('sha'))).toBe(true)
    expect(warnings.some((w) => w.kind === 'plugin-dir-not-found')).toBe(false)
  })

  it('skips a `url` source missing a valid sha', async () => {
    writeManifest(repo, {
      name: 'M',
      plugins: [
        { name: 'p', source: { source: 'url', url: 'https://github.com/o/r.git' } },
      ],
    })
    const { manifest, warnings } = await parseMarketplace(repo)
    expect(manifest.plugins).toHaveLength(0)
    expect(warnings.some((w) => w.kind === 'plugin-bad-shape' && w.detail.includes('sha'))).toBe(true)
    expect(warnings.some((w) => w.kind === 'plugin-dir-not-found')).toBe(false)
  })

  it('tags in-repo plugins with an in-repo source', async () => {
    makePluginDir(repo, 'foo')
    writeManifest(repo, { name: 'M', plugins: [{ name: 'foo' }] })
    const { manifest } = await parseMarketplace(repo)
    expect(manifest.plugins[0].source).toEqual({ kind: 'in-repo' })
  })

  it('skips a git-subdir plugin missing a valid sha', async () => {
    writeManifest(repo, {
      name: 'M',
      plugins: [
        {
          name: 'p',
          source: { source: 'git-subdir', url: 'https://github.com/o/r.git', path: 'sub' },
        },
      ],
    })
    const { manifest, warnings } = await parseMarketplace(repo)
    expect(manifest.plugins).toHaveLength(0)
    expect(warnings.some((w) => w.kind === 'plugin-bad-shape' && w.detail.includes('sha'))).toBe(true)
    expect(warnings.some((w) => w.kind === 'plugin-dir-not-found')).toBe(false)
  })

  it('skips a git-subdir plugin with a non-https url', async () => {
    writeManifest(repo, {
      name: 'M',
      plugins: [
        {
          name: 'p',
          source: { source: 'git-subdir', url: 'git://github.com/o/r.git', path: 'sub', sha: GIT_SUBDIR_SHA },
        },
      ],
    })
    const { manifest, warnings } = await parseMarketplace(repo)
    expect(manifest.plugins).toHaveLength(0)
    expect(warnings.some((w) => w.kind === 'plugin-bad-shape')).toBe(true)
  })

  it('skips a git-subdir plugin with a path escaping the repo', async () => {
    writeManifest(repo, {
      name: 'M',
      plugins: [
        {
          name: 'p',
          source: { source: 'git-subdir', url: 'https://github.com/o/r.git', path: '../outside', sha: GIT_SUBDIR_SHA },
        },
      ],
    })
    const { manifest, warnings } = await parseMarketplace(repo)
    expect(manifest.plugins).toHaveLength(0)
    expect(warnings.some((w) => w.kind === 'plugin-bad-shape')).toBe(true)
  })
})

// ── single-plugin repos (.claude-plugin/plugin.json) ──────────────

describe('parseSinglePlugin', () => {
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

  it('synthesises one in-repo plugin at the repo root (mattpocock-style)', async () => {
    // Real-world shape: a name, a skills path list, and an object author.
    // The skills list is irrelevant to us — the SDK reads it — but we must
    // tolerate it without choking.
    writePluginManifest(repo, {
      name: 'mattpocock-skills',
      description: 'Skills for real engineers',
      version: '1.2.0',
      author: { name: 'Matt Pocock', url: 'https://mattpocock.com' },
      skills: ['./skills/engineering/tdd', './skills/productivity/handoff'],
    })

    const { manifest, warnings } = await parseSinglePlugin(repo)
    expect(warnings).toEqual([])
    // Display name comes from the plugin name; owner from the author object.
    expect(manifest.name).toBe('mattpocock-skills')
    expect(manifest.version).toBe('1.2.0')
    expect(manifest.owner).toEqual({ name: 'Matt Pocock', url: 'https://mattpocock.com' })
    expect(manifest.plugins).toHaveLength(1)
    const p = manifest.plugins[0]
    expect(p).toMatchObject({
      name: 'mattpocock-skills',
      description: 'Skills for real engineers',
      version: '1.2.0',
      author: 'Matt Pocock',
    })
    // The plugin directory IS the repo root.
    expect(p.dir).toBe(repo)
    expect(p.source).toEqual({ kind: 'in-repo' })
  })

  it('coerces a string author into an owner with just a name', async () => {
    writePluginManifest(repo, { name: 'plug', author: 'Alice' })
    const { manifest } = await parseSinglePlugin(repo)
    expect(manifest.owner).toEqual({ name: 'Alice' })
    expect(manifest.plugins[0].author).toBe('Alice')
  })

  it('omits owner when no author is present', async () => {
    writePluginManifest(repo, { name: 'plug' })
    const { manifest } = await parseSinglePlugin(repo)
    expect(manifest.owner).toBeUndefined()
    expect(manifest.plugins[0].author).toBeUndefined()
  })

  it('throws when plugin.json is missing', async () => {
    await expect(parseSinglePlugin(repo)).rejects.toThrow(/not found/)
  })

  it('throws on malformed JSON', async () => {
    writeFileSync(join(repo, PLUGIN_MANIFEST_REL_PATH), '{ not json', 'utf8')
    await expect(parseSinglePlugin(repo)).rejects.toThrow(/not valid JSON/)
  })

  it('throws when the manifest is not a JSON object', async () => {
    writePluginManifest(repo, ['not', 'an', 'object'])
    await expect(parseSinglePlugin(repo)).rejects.toThrow(/must be a JSON object/)
  })

  it('throws when `name` is missing', async () => {
    writePluginManifest(repo, { description: 'no name here' })
    await expect(parseSinglePlugin(repo)).rejects.toThrow(/`name`/)
  })

  it('throws when `name` is empty', async () => {
    writePluginManifest(repo, { name: '   ' })
    await expect(parseSinglePlugin(repo)).rejects.toThrow(/`name`/)
  })

  it('throws when `name` has unsafe characters', async () => {
    writePluginManifest(repo, { name: 'has space' })
    await expect(parseSinglePlugin(repo)).rejects.toThrow(/rejected/)
  })

  it('throws when `name` starts with a dot', async () => {
    writePluginManifest(repo, { name: '.hidden' })
    await expect(parseSinglePlugin(repo)).rejects.toThrow(/rejected/)
  })
})

describe('parseRepoManifest', () => {
  let repo: string

  beforeEach(() => {
    repo = makeRepo()
  })
  afterEach(() => {
    try {
      rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    } catch {
      /* swallow */
    }
  })

  it('parses a marketplace repo via marketplace.json', async () => {
    makePluginDir(repo, 'foo')
    writeManifest(repo, { name: 'M', plugins: [{ name: 'foo' }] })
    const { manifest } = await parseRepoManifest(repo)
    expect(manifest.name).toBe('M')
    expect(manifest.plugins.map((p) => p.name)).toEqual(['foo'])
  })

  it('falls back to plugin.json for a single-plugin repo', async () => {
    writePluginManifest(repo, { name: 'solo-plugin', description: 'd' })
    const { manifest, warnings } = await parseRepoManifest(repo)
    expect(warnings).toEqual([])
    expect(manifest.name).toBe('solo-plugin')
    expect(manifest.plugins).toHaveLength(1)
    expect(manifest.plugins[0].dir).toBe(repo)
  })

  it('prefers marketplace.json when both manifests exist', async () => {
    makePluginDir(repo, 'foo')
    writeManifest(repo, { name: 'MarketplaceWins', plugins: [{ name: 'foo' }] })
    writePluginManifest(repo, { name: 'plugin-loses' })
    const { manifest } = await parseRepoManifest(repo)
    expect(manifest.name).toBe('MarketplaceWins')
    expect(manifest.plugins.map((p) => p.name)).toEqual(['foo'])
  })

  it('throws when neither manifest exists', async () => {
    await expect(parseRepoManifest(repo)).rejects.toThrow(/no plugin manifest found/)
  })
})
