import { beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gitClone, gitHeadSha } from './git-clone.js'
import { cloneAndDiscover, installRemoteSkills, updateRemoteSkill } from './skills-remote.js'
import { importSkillFromPath } from './skills.js'
import { rmRf } from './__test-utils__/index.js'

// Same mocking contract as the other skills-remote suites: no network/git.
vi.mock('./git-clone.js', () => ({
  gitClone: vi.fn(),
  gitHeadSha: vi.fn(async () => 'sha-1'),
  gitLsRemoteHead: vi.fn(),
}))

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

function skillDoc(name: string, description: string, body = '# body'): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`
}

async function installEnv(): Promise<{ fixture: string; cwd: string; cleanup: () => Promise<void> }> {
  const fixture = await mkdtemp(join(tmpdir(), 'update-fixture-'))
  const cwd = await mkdtemp(join(tmpdir(), 'update-cwd-'))
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

beforeEach(() => {
  vi.mocked(gitClone).mockClear()
  vi.mocked(gitHeadSha).mockClear()
})

describe('cloneAndDiscover forceRefresh', () => {
  it('bypasses a warm clone cache', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'refresh-fixture-'))
    try {
      await writeSkill(fixture, 'skills/pdf', skillDoc('pdf', 'Read PDFs'))
      mockCloneFrom(fixture)
      await cloneAndDiscover('refresh-owner/refresh-repo')
      // Second call without the flag hits the cache (no new clone)…
      await cloneAndDiscover('refresh-owner/refresh-repo')
      expect(vi.mocked(gitClone)).toHaveBeenCalledTimes(1)
      // …but forceRefresh must clone again even inside the TTL.
      await cloneAndDiscover('refresh-owner/refresh-repo', { forceRefresh: true })
      expect(vi.mocked(gitClone)).toHaveBeenCalledTimes(2)
    } finally {
      rmRf(fixture)
      cleanupClones()
    }
  })
})

describe('updateRemoteSkill', () => {
  it('overwrites the installed skill with the latest upstream and rewrites lastSha', async () => {
    const env = await installEnv()
    try {
      await writeSkill(env.fixture, 'skills/pdf', skillDoc('pdf', 'Read PDFs', '# old body'))
      mockCloneFrom(env.fixture)
      vi.mocked(gitHeadSha).mockResolvedValueOnce('sha-1')
      await installRemoteSkills({ source: 'update/repo-a', scope: 'project', cwd: env.cwd, paths: ['skills/pdf'], overwrite: false })

      // Upstream moved: the next clone carries new content and a new HEAD.
      const newer = await mkdtemp(join(tmpdir(), 'update-newer-'))
      await writeSkill(newer, 'skills/pdf', skillDoc('pdf', 'Read PDFs', '# new body'))
      mockCloneFrom(newer)
      vi.mocked(gitHeadSha).mockResolvedValue('sha-2')
      const result = await updateRemoteSkill({ scope: 'project', cwd: env.cwd, name: 'pdf' })

      expect(result.lastSha).toBe('sha-2')
      const sidecar = JSON.parse(await readFile(join(env.cwd, '.claude', 'skills', 'pdf', '.crw-source.json'), 'utf8'))
      expect(sidecar).toEqual({ source: 'update/repo-a', relativePath: 'skills/pdf', lastSha: 'sha-2' })
      expect(await readFile(join(env.cwd, '.claude', 'skills', 'pdf', 'SKILL.md'), 'utf8')).toContain('# new body')
      rmRf(newer)
    } finally {
      await env.cleanup()
    }
  })

  it('rejects an upstream rename without creating a second skill or deleting the old one', async () => {
    const env = await installEnv()
    try {
      await writeSkill(env.fixture, 'skills/pdf', skillDoc('pdf', 'Read PDFs', '# old body'))
      mockCloneFrom(env.fixture)
      vi.mocked(gitHeadSha).mockResolvedValueOnce('sha-1')
      await installRemoteSkills({ source: 'update/repo-rename', scope: 'project', cwd: env.cwd, paths: ['skills/pdf'], overwrite: false })

      const renamed = await mkdtemp(join(tmpdir(), 'update-renamed-'))
      await writeSkill(renamed, 'skills/pdf', skillDoc('renamed', 'Renamed upstream'))
      mockCloneFrom(renamed)
      await expect(updateRemoteSkill({ scope: 'project', cwd: env.cwd, name: 'pdf' })).rejects.toThrow(/renamed|rename/i)

      expect(existsSync(join(env.cwd, '.claude', 'skills', 'renamed'))).toBe(false)
      expect(await readFile(join(env.cwd, '.claude', 'skills', 'pdf', 'SKILL.md'), 'utf8')).toContain('# old body')
      rmRf(renamed)
    } finally {
      await env.cleanup()
    }
  })

  it('rejects updating a skill with no source sidecar', async () => {
    const env = await installEnv()
    try {
      await writeSkill(env.fixture, 'local-one', skillDoc('local-one', 'local skill'))
      await importSkillFromPath({ scope: 'project', cwd: env.cwd, path: join(env.fixture, 'local-one') })
      await expect(updateRemoteSkill({ scope: 'project', cwd: env.cwd, name: 'local-one' })).rejects.toThrow(/GitHub|source/i)
    } finally {
      await env.cleanup()
    }
  })
})
