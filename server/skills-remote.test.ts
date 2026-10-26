import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { gitClone } from './git-clone.js'
import { cloneAndDiscover, discoverSkills, searchCatalog } from './skills-remote.js'
import { rmRf } from './__test-utils__/index.js'

// git-clone is mocked so no test touches the network or a real git binary.
// The fake enforces gitClone's contract (dest must NOT already exist — it
// throws if it does) and drops a root-level SKILL.md so cloneAndDiscover has
// something real to discover. A root-level skill's relativePath is '', which
// pins the cache contract: the returned dir must be the clone root
// (`join(tmp, 'repo')`), never the mkdtemp tree (that would surface as
// relativePath 'repo/' — and break Task 4's install).
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
      // Cache contract: `dir` is the clone root (mkdtemp + 'repo'), so the
      // root-level fixture skill reports relativePath '' — not 'repo'.
      expect(basename(dir)).toBe('repo')
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
})
