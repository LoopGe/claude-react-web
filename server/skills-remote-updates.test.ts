import { beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gitClone, gitHeadSha, gitLsRemoteHead } from './git-clone.js'
import { checkSkillUpdates, installRemoteSkills } from './skills-remote.js'
import { importSkillFromPath } from './skills.js'
import { rmRf } from './__test-utils__/index.js'

// Same mocking contract as skills-remote.test.ts: no network, no real git.
// gitClone materialises a fixture tree; gitHeadSha/gitLsRemoteHead are stubs.
vi.mock('./git-clone.js', () => ({
  gitClone: vi.fn(),
  gitHeadSha: vi.fn(async () => 'sha-1'),
  gitLsRemoteHead: vi.fn(),
}))

/** Point the mocked gitClone at a fixture tree (copied into the clone root). */
function mockCloneFrom(fixtureDir: string): void {
  vi.mocked(gitClone).mockImplementation(async (_url: string, dest: string) => {
    if (existsSync(dest)) throw new Error(`gitClone dest already exists: ${dest}`)
    await cp(fixtureDir, dest, { recursive: true })
  })
}

function cleanupClones(): void {
  for (const call of vi.mocked(gitClone).mock.calls) {
    rmRf(dirname(call[1]!))
  }
}

async function writeSkill(base: string, relDir: string, content: string): Promise<void> {
  const dir = relDir ? join(base, ...relDir.split('/')) : base
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), content)
}

function skillDoc(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# body\n`
}

async function installEnv(): Promise<{ fixture: string; cwd: string; cleanup: () => Promise<void> }> {
  const fixture = await mkdtemp(join(tmpdir(), 'updates-fixture-'))
  const cwd = await mkdtemp(join(tmpdir(), 'updates-cwd-'))
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

/** Install one repo's skill into the project scope with a pinned lastSha. */
async function installRepoSkill(source: string, cwd: string, relPath: string, sha: string): Promise<void> {
  vi.mocked(gitHeadSha).mockResolvedValueOnce(sha)
  await installRemoteSkills({ source, scope: 'project', cwd, paths: [relPath], overwrite: false })
}

beforeEach(() => {
  vi.mocked(gitClone).mockClear()
  vi.mocked(gitHeadSha).mockClear()
  vi.mocked(gitLsRemoteHead).mockReset()
})

describe('checkSkillUpdates', () => {
  it('flags skills whose repo HEAD moved past lastSha and skips no-sidecar skills', async () => {
    const env = await installEnv()
    try {
      await writeSkill(env.fixture, 'skills/pdf', skillDoc('pdf', 'Read PDFs'))
      await writeSkill(env.fixture, 'skills/docx', skillDoc('docx', 'Read DOCX'))
      await writeSkill(env.fixture, 'local-one', skillDoc('local-one', 'local skill'))
      mockCloneFrom(env.fixture)
      await installRepoSkill('updates/repo-a', env.cwd, 'skills/pdf', 'sha-1')
      await installRepoSkill('updates/repo-b', env.cwd, 'skills/docx', 'sha-2')
      // A folder import has no provenance and must never be checked.
      await importSkillFromPath({ scope: 'project', cwd: env.cwd, path: join(env.fixture, 'local-one') })

      vi.mocked(gitLsRemoteHead).mockResolvedValue('sha-2')
      const updates = await checkSkillUpdates({ scope: 'project', cwd: env.cwd })

      expect(updates).toEqual(expect.arrayContaining([
        { scope: 'project', name: 'pdf', hasUpdate: true, remoteSha: 'sha-2' },
      ]))
      // repo-b is already at the upstream tip → hasUpdate false.
      const repoB = updates.find((u) => u.name === 'docx' && u.hasUpdate === false)
      expect(repoB).toBeTruthy()
      expect(updates.find((u) => u.name === 'local-one')).toBeUndefined()
    } finally {
      await env.cleanup()
    }
  })

  it('dedupes ls-remote per repo and isolates one repo failure', async () => {
    const env = await installEnv()
    try {
      await writeSkill(env.fixture, 'skills/pdf', skillDoc('pdf', 'Read PDFs'))
      await writeSkill(env.fixture, 'skills/docx', skillDoc('docx', 'Read DOCX'))
      await writeSkill(env.fixture, 'skills/xlsx', skillDoc('xlsx', 'Read XLSX'))
      mockCloneFrom(env.fixture)
      await installRepoSkill('dedupe/repo-a', env.cwd, 'skills/pdf', 'sha-1')
      await installRepoSkill('dedupe/repo-a', env.cwd, 'skills/docx', 'sha-1')
      await installRepoSkill('dedupe/repo-b', env.cwd, 'skills/xlsx', 'sha-1')

      vi.mocked(gitLsRemoteHead).mockImplementation(async (url: string) => {
        if (url.includes('repo-a')) throw new Error('boom')
        return 'sha-2'
      })
      const updates = await checkSkillUpdates({ scope: 'project', cwd: env.cwd })

      // repo-a has two skills but only one ls-remote call; both get the error…
      expect(vi.mocked(gitLsRemoteHead).mock.calls.filter(([url]) => url === 'https://github.com/dedupe/repo-a.git')).toHaveLength(1)
      expect(updates.find((u) => u.name === 'pdf' && u.error)?.error).toBe('boom')
      expect(updates.find((u) => u.name === 'docx' && u.error)?.error).toBe('boom')
      // …while repo-b still gets a normal verdict.
      const repoB = updates.filter((u) => !u.error && u.name === 'xlsx' && u.hasUpdate)
      expect(repoB).toHaveLength(1)
    } finally {
      await env.cleanup()
    }
  })
})
