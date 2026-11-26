import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { listPluginSkills } from './plugin-skills.js'
import type { EnabledPluginEntry } from './mp-store.js'
import { MAX_SKILL_BYTES } from '../shared/skills.js'

// Scan oracle: CLI §5.8 (docs/research/2026-11-25-native-slash-skill-discovery.md).
// The stub exposes only getEnabledPluginEntries() — the structural minimum the
// scanner consumes from MpStore.

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'crw-plugin-skills-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function skillMd(fields: Record<string, string>, body = 'body'): string {
  return ['---', ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`), '---', '', body, ''].join('\n')
}

async function makeSkill(dir: string, fields: Record<string, string> = { description: 'A skill' }): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), skillMd(fields), 'utf8')
}

/** A plugin dir under the temp root. Default cloneDir is a DIFFERENT path
 *  (in-repo subdir plugin); pass cloneDir: dir for the marketplace-root case. */
async function makePlugin(
  name: string,
  opts: { manifest?: Record<string, unknown>; relDir?: string; cloneDir?: string } = {},
): Promise<EnabledPluginEntry> {
  const dir = resolve(root, opts.relDir ?? name)
  await mkdir(dir, { recursive: true })
  if (opts.manifest) {
    await mkdir(join(dir, '.claude-plugin'), { recursive: true })
    await writeFile(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify(opts.manifest), 'utf8')
  }
  return { key: `${name}@mp`, name, dir, cloneDir: opts.cloneDir ?? resolve(root, 'mp-clone') }
}

function stub(entries: EnabledPluginEntry[]) {
  return { getEnabledPluginEntries: () => entries }
}

/** Directory link that needs no privileges on Windows (junction); a plain
 *  symlink on POSIX. realpathSync resolves both to the target. */
async function linkDir(target: string, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await symlink(resolve(target), path, 'junction')
}

describe('listPluginSkills — default skills/ root scan', () => {
  it('names skills from the sanitized dir basename, ignoring frontmatter.name', async () => {
    const entry = await makePlugin('superpowers')
    await makeSkill(join(entry.dir, 'skills', 'brainstorming'), {
      name: 'ignored',
      description: 'Brainstorm ideas',
      'disable-model-invocation': 'true',
      'user-invocable': 'false',
      'argument-hint': '[topic]',
    })

    const records = await listPluginSkills(stub([entry]))

    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      name: 'superpowers:brainstorming',
      plugin: 'superpowers',
      scope: 'plugin',
      readOnly: true,
      valid: true,
      errors: [],
      description: 'Brainstorm ideas',
      disableModelInvocation: true,
      userInvocable: false,
      argumentHint: '[topic]',
    })
    expect(records[0]!.path).toBe(join(entry.dir, 'skills', 'brainstorming', 'SKILL.md'))
  })

  it('sanitizes non [a-zA-Z0-9_-] basename characters to dashes', async () => {
    const entry = await makePlugin('superpowers')
    await makeSkill(join(entry.dir, 'skills', 'my skill.v2'))

    const records = await listPluginSkills(stub([entry]))

    expect(records.map((r) => r.name)).toEqual(['superpowers:my-skill-v2'])
  })

  it('skips subdirs without SKILL.md and never recurses', async () => {
    const entry = await makePlugin('superpowers')
    await mkdir(join(entry.dir, 'skills', 'empty'), { recursive: true })
    await makeSkill(join(entry.dir, 'skills', 'nested', 'deep'))

    const records = await listPluginSkills(stub([entry]))

    expect(records).toEqual([])
  })
})

describe('listPluginSkills — manifest skills entries', () => {
  it('loads a manifest single-dir entry (brief case: ./skills/tdd)', async () => {
    const entry = await makePlugin('superpowers', { manifest: { name: 'superpowers', skills: ['./skills/tdd'] } })
    await makeSkill(join(entry.dir, 'skills', 'tdd'), { name: 'tdd', description: 'TDD skill' })

    const records = await listPluginSkills(stub([entry]))

    expect(records.map((r) => r.name)).toEqual(['superpowers:tdd'])
  })

  it('single-dir branch: frontmatter.name wins over basename, a leading N: prefix is stripped', async () => {
    const entry = await makePlugin('superpowers', {
      manifest: { skills: ['./extra/fancy', './extra/prefixed', './extra/bare'] },
    })
    await makeSkill(join(entry.dir, 'extra', 'fancy'), { name: 'frontmatter-name', description: 'd' })
    await makeSkill(join(entry.dir, 'extra', 'prefixed'), { name: 'superpowers:already-prefixed', description: 'd' })
    await makeSkill(join(entry.dir, 'extra', 'bare'), { description: 'd' })

    const records = await listPluginSkills(stub([entry]))

    expect(records.map((r) => r.name).sort()).toEqual([
      'superpowers:already-prefixed',
      'superpowers:bare',
      'superpowers:frontmatter-name',
    ])
  })

  it('accepts a bare string skills field and auto-detects a subdirs-root entry', async () => {
    const entry = await makePlugin('superpowers', { manifest: { skills: './more' } })
    await makeSkill(join(entry.dir, 'more', 'one'))
    await makeSkill(join(entry.dir, 'more', 'two'))

    const records = await listPluginSkills(stub([entry]))

    expect(records.map((r) => r.name).sort()).toEqual(['superpowers:one', 'superpowers:two'])
  })

  it('loads manifest entries IN ADDITION to the default skills/ root (non-marketplace-root)', async () => {
    const entry = await makePlugin('superpowers', { manifest: { skills: ['./extra/solo'] } })
    await makeSkill(join(entry.dir, 'skills', 'base'))
    await makeSkill(join(entry.dir, 'extra', 'solo'), { name: 'solo-skill', description: 'd' })

    const records = await listPluginSkills(stub([entry]))

    expect(records.map((r) => r.name).sort()).toEqual(['superpowers:base', 'superpowers:solo-skill'])
  })

  it('skips entries equal to the default skills/ dir (no double load)', async () => {
    const entry = await makePlugin('superpowers', { manifest: { skills: ['./skills'] } })
    await makeSkill(join(entry.dir, 'skills', 'base'))

    const records = await listPluginSkills(stub([entry]))

    expect(records.map((r) => r.name)).toEqual(['superpowers:base'])
  })

  it('rejects manifest entries that escape the plugin dir (traversal containment)', async () => {
    const entry = await makePlugin('superpowers', { relDir: 'plugin', manifest: { skills: ['../escape'] } })
    // Directly loadable as a single skill dir if containment were absent.
    await makeSkill(join(root, 'escape'), { name: 'leaked', description: 'd' })
    await makeSkill(join(entry.dir, 'skills', 'ok'))

    const records = await listPluginSkills(stub([entry]))

    expect(records.map((r) => r.name)).toEqual(['superpowers:ok'])
  })

  it('a contained dir literally named ..foo is not a traversal escape', async () => {
    const entry = await makePlugin('superpowers', { manifest: { skills: ['./..foo'] } })
    await makeSkill(join(entry.dir, '..foo'), { name: 'dotdot', description: 'd' })

    const records = await listPluginSkills(stub([entry]))

    expect(records.map((r) => r.name)).toEqual(['superpowers:dotdot'])
  })
})

describe('listPluginSkills — marketplace-root exception', () => {
  it('dir === cloneDir: a manifest skills subdir REPLACES the default skills/ scan', async () => {
    const dir = resolve(root, 'single-repo')
    const entry = await makePlugin('superpowers', {
      relDir: 'single-repo',
      cloneDir: dir,
      manifest: { skills: ['./custom'] },
    })
    await makeSkill(join(entry.dir, 'custom'), { name: 'custom-skill', description: 'd' })
    await makeSkill(join(entry.dir, 'skills', 'other'))

    const records = await listPluginSkills(stub([entry]))

    expect(records.map((r) => r.name)).toEqual(['superpowers:custom-skill'])
  })
})

describe('listPluginSkills — fallback and prefix authority', () => {
  it('fallback: no skills/, no manifest skills, P/SKILL.md → N:basename(P)', async () => {
    const entry = await makePlugin('solo', { relDir: 'solo-plugin' })
    await writeFile(join(entry.dir, 'SKILL.md'), skillMd({ description: 'Root skill' }), 'utf8')

    const records = await listPluginSkills(stub([entry]))

    expect(records.map((r) => r.name)).toEqual(['solo:solo-plugin'])
    expect(records[0]!.plugin).toBe('solo')
  })

  it('no fallback when a skills/ dir exists or manifest skills is declared', async () => {
    const withRoot = await makePlugin('with-root', { relDir: 'with-root' })
    await writeFile(join(withRoot.dir, 'SKILL.md'), skillMd({ description: 'd' }), 'utf8')
    await mkdir(join(withRoot.dir, 'skills'), { recursive: true })
    const withManifest = await makePlugin('with-manifest', { relDir: 'with-manifest', manifest: { skills: [] } })
    await writeFile(join(withManifest.dir, 'SKILL.md'), skillMd({ description: 'd' }), 'utf8')

    const records = await listPluginSkills(stub([withRoot, withManifest]))

    expect(records).toEqual([])
  })

  it('prefix comes from plugin.json name read fresh, falling back to the catalog name', async () => {
    const withManifest = await makePlugin('catalog-name', { relDir: 'p1', manifest: { name: 'real-name' } })
    await makeSkill(join(withManifest.dir, 'skills', 'x'))
    const withoutManifest = await makePlugin('catalog-name', { relDir: 'p2' })
    await makeSkill(join(withoutManifest.dir, 'skills', 'x'))

    const records = await listPluginSkills(stub([withManifest, withoutManifest]))

    expect(records.map((r) => [r.name, r.plugin])).toEqual([
      ['real-name:x', 'real-name'],
      ['catalog-name:x', 'catalog-name'],
    ])
  })
})

describe('listPluginSkills — validity', () => {
  it('excludes the bare-grammar name error: weird frontmatter.name stays valid', async () => {
    const entry = await makePlugin('superpowers')
    await makeSkill(join(entry.dir, 'skills', 'weird'), { name: 'weird:name', description: 'Has a description' })

    const records = await listPluginSkills(stub([entry]))

    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ name: 'superpowers:weird', valid: true, errors: [] })
  })

  it('missing description invalidates the record', async () => {
    const entry = await makePlugin('superpowers')
    await makeSkill(join(entry.dir, 'skills', 'nodesc'), { name: 'nodesc' })

    const records = await listPluginSkills(stub([entry]))

    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ valid: false, errors: ['frontmatter.description is required'] })
  })

  it('broken frontmatter delimiters invalidate the record', async () => {
    const entry = await makePlugin('superpowers')
    const dir = join(entry.dir, 'skills', 'broken')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), '---\nname: broken\ndescription: d\nno closing delimiter\n', 'utf8')

    const records = await listPluginSkills(stub([entry]))

    expect(records).toHaveLength(1)
    expect(records[0]!.valid).toBe(false)
  })
})

describe('listPluginSkills — realpath dedup', () => {
  it('two plugins linking the same SKILL.md realpath: first entry wins', async () => {
    const alpha = await makePlugin('alpha')
    await makeSkill(join(alpha.dir, 'skills', 'shared'))
    const beta = await makePlugin('beta')
    await linkDir(join(alpha.dir, 'skills', 'shared'), join(beta.dir, 'skills', 'shared'))

    const records = await listPluginSkills(stub([alpha, beta]))

    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ name: 'alpha:shared', plugin: 'alpha' })
    // The junction scans fine on its own — the drop above is realpath dedup,
    // not a silent scan skip.
    expect((await listPluginSkills(stub([beta]))).map((r) => r.name)).toEqual(['beta:shared'])
  })
})

describe('listPluginSkills — contained failures', () => {
  it('an unreadable plugin dir omits that plugin without throwing the pass', async () => {
    const bad: EnabledPluginEntry = {
      key: 'bad@mp',
      name: 'bad',
      dir: resolve(root, 'does-not-exist'),
      cloneDir: resolve(root, 'mp-clone'),
    }
    const good = await makePlugin('good')
    await makeSkill(join(good.dir, 'skills', 'fine'))

    const records = await listPluginSkills(stub([bad, good]))

    expect(records.map((r) => r.name)).toEqual(['good:fine'])
  })

  it('a corrupt plugin.json omits that plugin; siblings still surface', async () => {
    const bad = await makePlugin('bad')
    await mkdir(join(bad.dir, '.claude-plugin'), { recursive: true })
    await writeFile(join(bad.dir, '.claude-plugin', 'plugin.json'), '{not json', 'utf8')
    await makeSkill(join(bad.dir, 'skills', 'hidden'))
    const good = await makePlugin('good')
    await makeSkill(join(good.dir, 'skills', 'fine'))

    const records = await listPluginSkills(stub([bad, good]))

    expect(records.map((r) => r.name)).toEqual(['good:fine'])
  })

  it('a per-skill read failure omits only that skill', async () => {
    const entry = await makePlugin('superpowers')
    // SKILL.md exists but is a DIRECTORY — stat/read refuses it.
    await mkdir(join(entry.dir, 'skills', 'broken', 'SKILL.md'), { recursive: true })
    await makeSkill(join(entry.dir, 'skills', 'fine'))

    const records = await listPluginSkills(stub([entry]))

    expect(records.map((r) => r.name)).toEqual(['superpowers:fine'])
  })

  it('an over-cap SKILL.md is omitted', async () => {
    const entry = await makePlugin('superpowers')
    const dir = join(entry.dir, 'skills', 'huge')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), 'x'.repeat(MAX_SKILL_BYTES + 1), 'utf8')
    await makeSkill(join(entry.dir, 'skills', 'fine'))

    const records = await listPluginSkills(stub([entry]))

    expect(records.map((r) => r.name)).toEqual(['superpowers:fine'])
  })
})

describe('listPluginSkills — enabledPlugins filter', () => {
  it('undefined = all enabled, [] = none, keys = membership filter', async () => {
    const a = await makePlugin('alpha')
    await makeSkill(join(a.dir, 'skills', 'one'))
    const b = await makePlugin('beta')
    await makeSkill(join(b.dir, 'skills', 'two'))
    const store = stub([a, b])

    expect((await listPluginSkills(store)).map((r) => r.name).sort()).toEqual(['alpha:one', 'beta:two'])
    expect(await listPluginSkills(store, [])).toEqual([])
    expect((await listPluginSkills(store, [a.key])).map((r) => r.name)).toEqual(['alpha:one'])
  })
})
