import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readNativeEnvironment, environmentSection, agentsSection } from './environment.js'

const dirs: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

async function writeHead(dir: string, head: string, marker: 'dir' | 'file' = 'dir'): Promise<void> {
  if (marker === 'dir') {
    await mkdir(join(dir, '.git'), { recursive: true })
    await writeFile(join(dir, '.git', 'HEAD'), head, 'utf8')
  } else {
    await writeFile(join(dir, '.git'), `gitdir: ${join(dir, 'gitdir-target')}\n`, 'utf8')
    await mkdir(join(dir, 'gitdir-target'), { recursive: true })
    await writeFile(join(dir, 'gitdir-target', 'HEAD'), head, 'utf8')
  }
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

describe('readNativeEnvironment', () => {
  it('reports the branch of an enclosing repository', async () => {
    const dir = await tempDir('native-env-branch-')
    await writeHead(dir, 'ref: refs/heads/main\n')
    const facts = readNativeEnvironment(dir)
    expect(facts.cwd).toBe(dir)
    expect(facts.git).toEqual({ kind: 'branch', name: 'main' })
    expect(facts.platform).toBe(process.platform)
    expect(facts.arch).toBe(process.arch)
  })

  it('walks up from a subdirectory to the work tree', async () => {
    const dir = await tempDir('native-env-subdir-')
    await writeHead(dir, 'ref: refs/heads/feature/x\n')
    const nested = join(dir, 'packages', 'app')
    await mkdir(nested, { recursive: true })
    expect(readNativeEnvironment(nested).git).toEqual({ kind: 'branch', name: 'feature/x' })
  })

  it('reports a detached HEAD by short sha', async () => {
    const dir = await tempDir('native-env-detached-')
    await writeHead(dir, '0123456789abcdef0123456789abcdef01234567\n')
    expect(readNativeEnvironment(dir).git).toEqual({ kind: 'detached', sha: '0123456' })
  })

  it('follows the `.git` file of a linked worktree', async () => {
    const dir = await tempDir('native-env-worktree-')
    await writeHead(dir, 'ref: refs/heads/wt\n', 'file')
    expect(readNativeEnvironment(dir).git).toEqual({ kind: 'branch', name: 'wt' })
  })

  it('reports no repository outside one', async () => {
    const dir = await tempDir('native-env-no-repo-')
    expect(readNativeEnvironment(dir).git).toBeNull()
  })

  it('formats the local calendar date', async () => {
    const dir = await tempDir('native-env-date-')
    const facts = readNativeEnvironment(dir, new Date(2026, 10, 28, 23, 59))
    expect(facts.date).toBe('2026-11-28')
  })
})

describe('environmentSection', () => {
  it('renders the CLI-shaped env block', async () => {
    const dir = await tempDir('native-env-section-')
    const facts = readNativeEnvironment(dir, new Date(2026, 10, 28))
    expect(environmentSection(facts)).toMatchObject({ name: 'harness:environment', order: 5 })
    const text = environmentSection(facts).text
    expect(text).toContain('<env>')
    expect(text).toContain(`Working directory: ${dir}`)
    expect(text).toContain('Is a git repository: no')
    expect(text).toContain(`Platform: ${process.platform} (${process.arch})`)
    expect(text).toContain("Today's date: 2026-11-28")
    expect(text.trimEnd().endsWith('</env>')).toBe(true)
  })

  it('names the branch or detached sha in the git line', async () => {
    const dir = await tempDir('native-env-section-git-')
    await writeHead(dir, 'ref: refs/heads/main\n')
    expect(environmentSection(readNativeEnvironment(dir)).text).toContain(
      'Is a git repository: yes (branch "main")',
    )
  })
})

describe('agentsSection', () => {
  it('returns null when the roster is empty', () => {
    expect(agentsSection([])).toBeNull()
  })

  it('sorts rows and renders the tool allowlist', () => {
    const section = agentsSection([
      { name: 'zeta', description: 'Zed agent' },
      { name: 'alpha', description: 'Alpha agent', tools: ['Read', 'Grep'] },
    ])!
    expect(section).toMatchObject({ name: 'harness:agents', order: 20 })
    expect(section.text).toContain('<available_agents>')
    expect(section.text).toContain('`general-purpose` is the built-in default')
    expect(section.text.indexOf('- alpha')).toBeLessThan(section.text.indexOf('- zeta'))
    expect(section.text).toContain('- alpha (tools: Read, Grep): Alpha agent')
    expect(section.text).toContain('- zeta: Zed agent')
  })
})
