import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { gitClone } from './git-clone.js'
import { HttpError } from './errors.js'
import {
  cloneAndDiscover,
  discoverSkills,
  installRemoteSkills,
  searchCatalog,
  stageSkillInto,
} from './skills-remote.js'
import { rmRf } from './__test-utils__/index.js'

// git-clone is mocked so no test touches the network or a real git binary.
// The fake enforces gitClone's contract (dest must NOT already exist — it
// throws if it does) and drops a root-level SKILL.md so cloneAndDiscover has
// something real to discover. A root-level skill's relativePath is '', which
// pins the cache contract: the returned dir must be the clone root
// (`join(tmp, repo)`), never the mkdtemp tree (that would surface as
// relativePath '<repo>/' — and break Task 4's install).
vi.mock('./git-clone.js', () => ({
  gitClone: vi.fn(async (_url: string, dest: string) => {
    if (existsSync(dest)) throw new Error(`gitClone dest already exists: ${dest}`)
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, 'SKILL.md'), '---\nname: demo\ndescription: demo skill\n---\n\n# body\n', 'utf8')
  }),
}))

const CACHE_TTL_MS = 10 * 60 * 1000

beforeEach(() => {
  vi.mocked(gitClone).mockClear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function makeTree(): Promise<{ base: string; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(join(tmpdir(), 'skills-remote-'))
  return { base, cleanup: () => rm(base, { recursive: true, force: true }) }
}

/** relDir uses forward slashes; '' writes the skill at the tree root. */
async function writeSkill(base: string, relDir: string, content: string | Buffer): Promise<void> {
  const dir = relDir ? join(base, ...relDir.split('/')) : base
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), content)
}

function skillDoc(fields: { name?: string; description?: string }): string {
  const lines = ['---']
  if (fields.name !== undefined) lines.push(`name: ${fields.name}`)
  if (fields.description !== undefined) lines.push(`description: ${fields.description}`)
  lines.push('---', '', '# body', '')
  return lines.join('\n')
}

describe('discoverSkills', () => {
  it('finds nested skills and reads description from frontmatter', async () => {
    const { base, cleanup } = await makeTree()
    try {
      await writeSkill(base, 'skills/pdf', skillDoc({ name: 'pdf', description: 'Read PDFs' }))
      await writeSkill(base, 'skills/docx', skillDoc({ description: 'Read DOCX' }))
      const found = await discoverSkills(base)
      expect(found).toEqual(
        expect.arrayContaining([
          { name: 'pdf', description: 'Read PDFs', relativePath: 'skills/pdf' },
          { name: 'docx', description: 'Read DOCX', relativePath: 'skills/docx' },
        ]),
      )
    } finally {
      await cleanup()
    }
  })

  it('reports a root-level skill with relativePath ""', async () => {
    const { base, cleanup } = await makeTree()
    try {
      await writeSkill(base, '', skillDoc({ name: 'root-skill' }))
      const found = await discoverSkills(base)
      expect(found).toEqual([{ name: 'root-skill', description: '', relativePath: '' }])
    } finally {
      await cleanup()
    }
  })

  it('skips SKIP_DIRS and stops at depth 5', async () => {
    const { base, cleanup } = await makeTree()
    try {
      await writeSkill(base, 'node_modules/x', skillDoc({ name: 'x', description: 'nope' }))
      await writeSkill(base, 'a/b/c/d/e/f', skillDoc({ name: 'too-deep', description: 'nope' }))
      await writeSkill(base, 'a/b/c/d/e', skillDoc({ name: 'e', description: 'ok' }))
      const found = await discoverSkills(base)
      expect(found.map((s) => s.relativePath)).toEqual(['a/b/c/d/e'])
    } finally {
      await cleanup()
    }
  })

  it('ignores a skill deeper than the depth limit even when no ancestor is a skill dir', async () => {
    // Isolates the depth rule from "don't descend into a SKILL.md dir":
    // base/a/b/c/d/e/f is 6 levels below the base (depth 6), so it is never
    // visited, while base/a/b/c/d/e (depth 5) is the boundary and is found.
    const { base, cleanup } = await makeTree()
    try {
      await mkdir(join(base, 'a', 'b', 'c', 'd', 'e'), { recursive: true })
      await writeSkill(base, 'a/b/c/d/e/f', skillDoc({ name: 'too-deep', description: 'nope' }))
      expect(await discoverSkills(base)).toEqual([])
      await writeSkill(base, 'a/b/c/d/e', skillDoc({ name: 'boundary', description: 'ok' }))
      const found = await discoverSkills(base)
      expect(found.map((s) => s.relativePath)).toEqual(['a/b/c/d/e'])
    } finally {
      await cleanup()
    }
  })

  it('does not descend into a directory that contains SKILL.md', async () => {
    const { base, cleanup } = await makeTree()
    try {
      await writeSkill(base, 'parent', skillDoc({ name: 'parent', description: 'outer' }))
      await writeSkill(base, 'parent/child', skillDoc({ name: 'child', description: 'inner' }))
      const found = await discoverSkills(base)
      expect(found.map((s) => s.relativePath)).toEqual(['parent'])
    } finally {
      await cleanup()
    }
  })

  it('falls back to the directory basename when frontmatter has no name', async () => {
    const { base, cleanup } = await makeTree()
    try {
      await writeSkill(base, 'skills/my-tool', skillDoc({ description: 'Does a thing' }))
      const found = await discoverSkills(base)
      expect(found[0]!.name).toBe('my-tool')
    } finally {
      await cleanup()
    }
  })

  it('skips a SKILL.md larger than MAX_SKILL_BYTES', async () => {
    const { base, cleanup } = await makeTree()
    try {
      // 1 MiB + 1 bytes exceeds MAX_SKILL_BYTES (1024 * 1024)
      await writeSkill(base, 'big', Buffer.alloc(1024 * 1024 + 1, 0x61))
      expect(await discoverSkills(base)).toEqual([])
    } finally {
      await cleanup()
    }
  })
})

// Every cloneAndDiscover test uses its own source: the clone cache is
// module-private and lives for the whole file, so a shared source would let
// one test's entry satisfy the next.
describe('cloneAndDiscover', () => {
  it('constructs a github.com URL from owner/repo and clones into a fresh dir', async () => {
    const { dir, skills } = await cloneAndDiscover('vercel-labs/agent-skills')
    try {
      expect(vi.mocked(gitClone)).toHaveBeenCalledWith(
        'https://github.com/vercel-labs/agent-skills.git',
        dir,
      )
      // Cache contract: `dir` is the clone root (mkdtemp + the repo segment),
      // so the root-level fixture skill reports relativePath '' — not
      // 'agent-skills'. The basename is the repo name, which is the name
      // fallback for a root-level skill with no frontmatter.name.
      expect(basename(dir)).toBe('agent-skills')
      expect(basename(dirname(dir)).startsWith('crw-skill-')).toBe(true)
      expect(skills).toEqual([{ name: 'demo', description: 'demo skill', relativePath: '' }])
    } finally {
      rmRf(dirname(dir))
    }
  })

  it('rejects a source that is not owner/repo', async () => {
    await expect(cloneAndDiscover('https://evil.example/x/y')).rejects.toThrow(/source must be/)
    expect(vi.mocked(gitClone)).not.toHaveBeenCalled()
  })

  it('names a root-level skill with no frontmatter.name after the repo, not "repo"', async () => {
    // Root SKILL.md with only a description: discoverSkills falls back to
    // basename(cloneRoot), which must be the repo segment — the artificial
    // tmp clone folder name would surface as the literal skill name "repo".
    vi.mocked(gitClone).mockImplementationOnce(async (_url: string, dest: string) => {
      if (existsSync(dest)) throw new Error(`gitClone dest already exists: ${dest}`)
      mkdirSync(dest, { recursive: true })
      writeFileSync(join(dest, 'SKILL.md'), skillDoc({ description: 'Root skill, unnamed' }), 'utf8')
    })
    const { dir, skills } = await cloneAndDiscover('acme/my-skills-repo')
    try {
      expect(skills).toEqual([
        { name: 'my-skills-repo', description: 'Root skill, unnamed', relativePath: '' },
      ])
    } finally {
      rmRf(dirname(dir))
    }
  })

  it('reuses the cached clone dir for a second call with the same source', async () => {
    const first = await cloneAndDiscover('cache-owner/cache-repo')
    const second = await cloneAndDiscover('cache-owner/cache-repo')
    try {
      expect(second.dir).toBe(first.dir)
      expect(vi.mocked(gitClone)).toHaveBeenCalledTimes(1)
    } finally {
      rmRf(dirname(first.dir))
    }
  })

  it('shares one cache entry across owner/repo and the github.com URL spelling', async () => {
    // The cache key is the normalized owner/repo, so the same parsed repo
    // never clones twice just because the source was spelled differently.
    const first = await cloneAndDiscover('twins-owner/twins-repo')
    const second = await cloneAndDiscover('https://github.com/twins-owner/twins-repo.git')
    try {
      expect(second.dir).toBe(first.dir)
      expect(vi.mocked(gitClone)).toHaveBeenCalledTimes(1)
    } finally {
      rmRf(dirname(first.dir))
    }
  })

  it('re-clones after the cache TTL expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-26T00:00:00Z'))
    const first = await cloneAndDiscover('ttl-owner/ttl-repo')
    vi.setSystemTime(Date.now() + CACHE_TTL_MS + 1)
    const second = await cloneAndDiscover('ttl-owner/ttl-repo')
    try {
      expect(vi.mocked(gitClone)).toHaveBeenCalledTimes(2)
      expect(second.dir).not.toBe(first.dir)
      // the expired mkdtemp tree is torn down when the fresh clone replaces it
      expect(existsSync(dirname(first.dir))).toBe(false)
    } finally {
      vi.useRealTimers()
      rmRf(dirname(second.dir))
    }
  })

  it('does not cache when the clone fails', async () => {
    vi.mocked(gitClone).mockRejectedValueOnce(new Error('clone boom'))
    await expect(cloneAndDiscover('fail-owner/fail-repo')).rejects.toThrow('clone boom')
    const failedDest = vi.mocked(gitClone).mock.calls[0]![1]!
    expect(existsSync(dirname(failedDest))).toBe(false)

    const { dir, skills } = await cloneAndDiscover('fail-owner/fail-repo')
    try {
      expect(vi.mocked(gitClone)).toHaveBeenCalledTimes(2)
      expect(skills).toEqual([{ name: 'demo', description: 'demo skill', relativePath: '' }])
    } finally {
      rmRf(dirname(dir))
    }
  })
})

describe('searchCatalog', () => {
  it('rejects a query shorter than 2 characters', async () => {
    await expect(searchCatalog('a', 20)).rejects.toThrow(/at least 2/)
    await expect(searchCatalog(' ', 20)).rejects.toThrow(/at least 2/)
  })

  it('caps limit at 50 and forwards the skills.sh payload', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          skills: [
            { id: 'a', source: 'o/r', skillId: 's-a', name: 'A', installs: 3 },
            { id: 'b', source: 'o/r', skillId: 's-b', name: 'B', installs: 10 },
            { id: 'c', source: 'o/r', skillId: 's-c', name: 'C' },
          ],
        }),
        { status: 200 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const hits = await searchCatalog('react', 999)
    expect(fetchMock.mock.calls[0]![0]).toBe('https://skills.sh/api/search?q=react&limit=50')
    expect(hits).toEqual([
      { id: 'b', source: 'o/r', skillId: 's-b', name: 'B', installs: 10 },
      { id: 'a', source: 'o/r', skillId: 's-a', name: 'A', installs: 3 },
      { id: 'c', source: 'o/r', skillId: 's-c', name: 'C', installs: 0 },
    ])
  })

  it('throws when skills.sh responds non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })))
    await expect(searchCatalog('react', 20)).rejects.toThrow(/status 503/)
  })

  it('throws 502 when the payload has no skills array', async () => {
    // External wire input: a non-conforming body must read as an upstream
    // failure, not an opaque TypeError 500.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ nope: true }), { status: 200 })))
    const err = await searchCatalog('react', 20).then(
      () => null,
      (e: unknown) => e as HttpError,
    )
    expect(err).toBeInstanceOf(HttpError)
    expect(err!.status).toBe(502)
    expect(err!.message).toMatch(/malformed/i)
  })
})

// ── Remote install: stage + import ─────────────────────────────────────────
//
// installRemoteSkills is tested against the REAL importSkillFromPath (project
// scope writes to `join(cwd, '.claude', 'skills')` — a throwaway cwd, so the
// user's real skill root is never touched) with a mocked gitClone that
// materialises a fixture tree as the clone.

/** Point the mocked gitClone at a fixture tree: it builds gitClone's
 *  destination (the clone root) as a copy of `fixtureDir`, honouring
 *  gitClone's contract that dest must not already exist. */
function mockCloneFrom(fixtureDir: string): void {
  vi.mocked(gitClone).mockImplementation(async (_url: string, dest: string) => {
    if (existsSync(dest)) throw new Error(`gitClone dest already exists: ${dest}`)
    await cp(fixtureDir, dest, { recursive: true })
  })
}

/** Drop the throwaway clone tree this test's mocked gitClone created.
 *  beforeEach's mockClear() keeps calls scoped to the test that just ran. */
function cleanupClones(): void {
  for (const call of vi.mocked(gitClone).mock.calls) {
    rmRf(dirname(call[1]!))
  }
}

describe('stageSkillInto', () => {
  it('rejects a relativePath that escapes the clone dir', async () => {
    const cloneDir = await mkdtemp(join(tmpdir(), 'stage-clone-'))
    const destDir = await mkdtemp(join(tmpdir(), 'stage-dest-'))
    try {
      await writeSkill(cloneDir, 'skills/good', skillDoc({ name: 'good', description: 'ok' }))
      await expect(stageSkillInto(cloneDir, '../outside', destDir)).rejects.toThrow(/escapes/)
      await expect(stageSkillInto(cloneDir, 'skills/../../outside', destDir)).rejects.toThrow(/escapes/)
    } finally {
      rmRf(cloneDir)
      rmRf(destDir)
    }
  })

  it('allows the clone root itself (relativePath "")', async () => {
    const cloneDir = await mkdtemp(join(tmpdir(), 'stage-clone-'))
    const destDir = await mkdtemp(join(tmpdir(), 'stage-dest-'))
    try {
      await writeSkill(cloneDir, '', skillDoc({ name: 'root', description: 'ok' }))
      await writeFile(join(cloneDir, 'notes.md'), 'hi')
      await stageSkillInto(cloneDir, '', destDir)
      expect(existsSync(join(destDir, 'SKILL.md'))).toBe(true)
      expect(existsSync(join(destDir, 'notes.md'))).toBe(true)
    } finally {
      rmRf(cloneDir)
      rmRf(destDir)
    }
  })
})

describe('installRemoteSkills', () => {
  /** Fixture tree (what the mocked clone materialises) + project cwd (the
   *  real importSkillFromPath target). One pair per test. */
  async function installEnv(): Promise<{
    fixture: string
    cwd: string
    cleanup: () => Promise<void>
  }> {
    const fixture = await mkdtemp(join(tmpdir(), 'install-fixture-'))
    const cwd = await mkdtemp(join(tmpdir(), 'install-cwd-'))
    return {
      fixture,
      cwd,
      cleanup: async () => {
        rmRf(fixture)
        rmRf(cwd)
        cleanupClones()
      },
    }
  }

  it('stages a root-level skill without .git or node_modules', async () => {
    const env = await installEnv()
    try {
      await writeSkill(env.fixture, '', skillDoc({ name: 'root-skill', description: 'Root skill' }))
      await mkdir(join(env.fixture, '.git'), { recursive: true })
      await writeFile(join(env.fixture, '.git', 'config'), '[core]', 'utf8')
      await mkdir(join(env.fixture, 'node_modules', 'x'), { recursive: true })
      await writeFile(join(env.fixture, 'node_modules', 'x', 'index.js'), 'module.exports = 1', 'utf8')
      await writeFile(join(env.fixture, 'notes.md'), '# notes', 'utf8')
      mockCloneFrom(env.fixture)

      const res = await installRemoteSkills({
        source: 'root-owner/root-repo',
        scope: 'project',
        cwd: env.cwd,
        paths: [''],
      })
      expect(res.failed).toEqual([])
      expect(res.installed).toEqual([{ name: 'root-skill', relativePath: '' }])
      const installedDir = join(env.cwd, '.claude', 'skills', 'root-skill')
      expect(existsSync(join(installedDir, 'notes.md'))).toBe(true)
      expect(existsSync(join(installedDir, '.git'))).toBe(false)
      expect(existsSync(join(installedDir, 'node_modules'))).toBe(false)
    } finally {
      await env.cleanup()
    }
  })

  it('continues past a failing skill and reports it in failed[]', async () => {
    const env = await installEnv()
    try {
      // `skills/bad` exists but has no SKILL.md. It comes first in `paths` so
      // the batch has to survive the failure to reach the good skill.
      await mkdir(join(env.fixture, 'skills', 'bad'), { recursive: true })
      await writeFile(join(env.fixture, 'skills', 'bad', 'notes.md'), 'no skill here', 'utf8')
      await writeSkill(env.fixture, 'skills/good', skillDoc({ name: 'good', description: 'ok' }))
      mockCloneFrom(env.fixture)

      const res = await installRemoteSkills({
        source: 'mixed-owner/mixed-repo',
        scope: 'project',
        cwd: env.cwd,
        paths: ['skills/bad', 'skills/good'],
      })
      expect(res.installed).toEqual([{ name: 'good', relativePath: 'skills/good' }])
      expect(res.failed).toHaveLength(1)
      expect(res.failed[0]!.relativePath).toBe('skills/bad')
      expect(res.failed[0]!.error).not.toBe('')
    } finally {
      await env.cleanup()
    }
  })

  it('records an import failure without aborting the batch', async () => {
    const env = await installEnv()
    try {
      // Discovered (SKILL.md present) but importSkillFromPath rejects it:
      // frontmatter.description is required for a real import.
      await writeSkill(env.fixture, 'skills/bad', skillDoc({ name: 'bad' }))
      await writeSkill(env.fixture, 'skills/good', skillDoc({ name: 'good', description: 'ok' }))
      mockCloneFrom(env.fixture)

      const res = await installRemoteSkills({
        source: 'badfm-owner/badfm-repo',
        scope: 'project',
        cwd: env.cwd,
        paths: ['skills/bad', 'skills/good'],
      })
      expect(res.installed).toEqual([{ name: 'good', relativePath: 'skills/good' }])
      expect(res.failed).toHaveLength(1)
      expect(res.failed[0]).toEqual({
        name: 'bad',
        relativePath: 'skills/bad',
        error: expect.stringContaining('description'),
      })
    } finally {
      await env.cleanup()
    }
  })

  it('reports Skill already exists per-skill when overwrite is false', async () => {
    const env = await installEnv()
    try {
      await writeSkill(env.fixture, 'skills/dupe', skillDoc({ name: 'dupe', description: 'ok' }))
      mockCloneFrom(env.fixture)

      const first = await installRemoteSkills({
        source: 'exists-owner/exists-repo',
        scope: 'project',
        cwd: env.cwd,
        paths: ['skills/dupe'],
      })
      expect(first).toEqual({ installed: [{ name: 'dupe', relativePath: 'skills/dupe' }], failed: [] })

      const second = await installRemoteSkills({
        source: 'exists-owner/exists-repo',
        scope: 'project',
        cwd: env.cwd,
        paths: ['skills/dupe'],
        overwrite: false,
      })
      expect(second.installed).toEqual([])
      expect(second.failed).toHaveLength(1)
      expect(second.failed[0]!.error).toContain('already exists')
    } finally {
      await env.cleanup()
    }
  })

  it('installs two skills that share a frontmatter name by relativePath', async () => {
    const env = await installEnv()
    try {
      await writeSkill(env.fixture, 'skills/a', skillDoc({ name: 'dup', description: 'A' }))
      await writeFile(join(env.fixture, 'skills', 'a', 'only-a.txt'), 'a', 'utf8')
      await writeSkill(env.fixture, 'skills/b', skillDoc({ name: 'dup', description: 'B' }))
      await writeFile(join(env.fixture, 'skills', 'b', 'only-b.txt'), 'b', 'utf8')
      mockCloneFrom(env.fixture)

      const res = await installRemoteSkills({
        source: 'dup-owner/dup-repo',
        scope: 'project',
        cwd: env.cwd,
        paths: ['skills/a', 'skills/b'],
        overwrite: true,
      })
      expect(res.failed).toEqual([])
      // Both resolve to the same install name ('dup' from frontmatter); the
      // second only succeeds because overwrite:true replaced the first.
      expect(res.installed).toEqual([
        { name: 'dup', relativePath: 'skills/a' },
        { name: 'dup', relativePath: 'skills/b' },
      ])
      const installedDir = join(env.cwd, '.claude', 'skills', 'dup')
      expect(existsSync(join(installedDir, 'only-b.txt'))).toBe(true)
      expect(existsSync(join(installedDir, 'only-a.txt'))).toBe(false)
    } finally {
      await env.cleanup()
    }
  })

  it('rejects an empty paths array', async () => {
    const env = await installEnv()
    try {
      await expect(
        installRemoteSkills({ source: 'a/b', scope: 'project', cwd: env.cwd, paths: [] }),
      ).rejects.toThrow(/paths/)
    } finally {
      await env.cleanup()
    }
  })

  it('reports an unknown relativePath as not found', async () => {
    const env = await installEnv()
    try {
      await writeSkill(env.fixture, 'skills/good', skillDoc({ name: 'good', description: 'ok' }))
      mockCloneFrom(env.fixture)

      const res = await installRemoteSkills({
        source: 'unknown-owner/unknown-repo',
        scope: 'project',
        cwd: env.cwd,
        paths: ['../outside'],
      })
      expect(res.installed).toEqual([])
      // The discovery lookup runs first, so an escaping path never reaches
      // stageSkillInto; stageSkillInto's containment check is defense-in-depth.
      expect(res.failed).toEqual([
        { name: '../outside', relativePath: '../outside', error: 'Not found in repository' },
      ])
    } finally {
      await env.cleanup()
    }
  })
})
