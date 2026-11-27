// Root-scoped memory permission helpers: realpath containment for the native
// auto-memory store. Fixture dirs are real tmpdirs (realpath needs existence);
// directory escapes use junctions, which need no privilege on win32 and are
// ignored as a type on posix (the file-read.test.ts precedent).

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isMemoryRootRead, isMemoryRootWrite, type MemoryRoots } from './memory-permission.js'

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

async function tempDir(prefix = 'memory-permission-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** A real own root + claude root + an outside dir, each with a sample file. */
async function layout(): Promise<{ roots: MemoryRoots; own: string; claude: string; outside: string }> {
  const base = await tempDir()
  const own = join(base, 'own')
  const claude = join(base, 'claude')
  const outside = join(base, 'outside')
  await mkdir(own)
  await mkdir(claude)
  await mkdir(outside)
  await writeFile(join(own, 'existing.md'), 'own')
  await writeFile(join(claude, 'existing.md'), 'claude')
  await writeFile(join(outside, 'secret.md'), 'outside')
  return { roots: { own, claude }, own, claude, outside }
}

describe('isMemoryRootWrite', () => {
  it('returns false when roots are absent (claude session)', async () => {
    const { own } = await layout()
    expect(await isMemoryRootWrite('Write', { file_path: join(own, 'existing.md') }, undefined)).toBe(false)
  })

  it('returns false for non-edit tools', async () => {
    const { roots, own } = await layout()
    expect(await isMemoryRootWrite('Bash', { command: `cat ${join(own, 'existing.md')}` }, roots)).toBe(false)
    expect(await isMemoryRootWrite('Read', { file_path: join(own, 'existing.md') }, roots)).toBe(false)
  })

  it('returns false for a missing or non-string path field', async () => {
    const { roots } = await layout()
    expect(await isMemoryRootWrite('Write', {}, roots)).toBe(false)
    expect(await isMemoryRootWrite('Write', { file_path: 42 }, roots)).toBe(false)
    expect(await isMemoryRootWrite('Write', { file_path: '' }, roots)).toBe(false)
  })

  it('exempts a Write to an existing file inside own', async () => {
    const { roots, own } = await layout()
    expect(await isMemoryRootWrite('Write', { file_path: join(own, 'existing.md') }, roots)).toBe(true)
  })

  it('exempts a Write to a NEW file inside own (absent target, existing root)', async () => {
    const { roots, own } = await layout()
    expect(await isMemoryRootWrite('Write', { file_path: join(own, 'brand-new.md') }, roots)).toBe(true)
    expect(await isMemoryRootWrite('Write', { file_path: join(own, 'sub', 'deep.md') }, roots)).toBe(true)
  })

  it('NEVER exempts a Write inside the claude compat root (write isolation)', async () => {
    const { roots, claude } = await layout()
    expect(await isMemoryRootWrite('Write', { file_path: join(claude, 'existing.md') }, roots)).toBe(false)
    expect(await isMemoryRootWrite('Write', { file_path: join(claude, 'new.md') }, roots)).toBe(false)
  })

  it('returns false for a Write outside both roots', async () => {
    const { roots, outside } = await layout()
    expect(await isMemoryRootWrite('Write', { file_path: join(outside, 'secret.md') }, roots)).toBe(false)
  })

  it('returns false when the own root is absent (fail-closed)', async () => {
    const base = await tempDir()
    const roots: MemoryRoots = { own: join(base, 'does-not-exist'), claude: null }
    expect(await isMemoryRootWrite('Write', { file_path: join(roots.own, 'x.md') }, roots)).toBe(false)
  })

  it('rejects a junction inside own whose real target escapes', async () => {
    const { roots, own, outside } = await layout()
    await symlink(outside, join(own, 'escape'), 'junction')
    expect(await isMemoryRootWrite('Write', { file_path: join(own, 'escape', 'secret.md') }, roots)).toBe(false)
    // A new file under the escaping junction is still caught (nearest-existing
    // ancestor resolves through the link).
    expect(await isMemoryRootWrite('Write', { file_path: join(own, 'escape', 'new.md') }, roots)).toBe(false)
  })

  it('exempts Edit / MultiEdit / NotebookEdit through their path fields', async () => {
    const { roots, own } = await layout()
    expect(await isMemoryRootWrite('Edit', { file_path: join(own, 'existing.md') }, roots)).toBe(true)
    expect(await isMemoryRootWrite('MultiEdit', { file_path: join(own, 'existing.md') }, roots)).toBe(true)
    expect(await isMemoryRootWrite('NotebookEdit', { notebook_path: join(own, 'existing.md') }, roots)).toBe(true)
  })
})

describe('isMemoryRootRead', () => {
  it('returns false when roots are absent (claude session)', async () => {
    const { own } = await layout()
    expect(await isMemoryRootRead('Read', { file_path: join(own, 'existing.md') }, undefined)).toBe(false)
  })

  it('returns false for non-read tools', async () => {
    const { roots, own } = await layout()
    expect(await isMemoryRootRead('Write', { file_path: join(own, 'existing.md') }, roots)).toBe(false)
    expect(await isMemoryRootRead('Bash', { command: 'ls' }, roots)).toBe(false)
  })

  it('exempts a Read inside own and inside claude', async () => {
    const { roots, own, claude } = await layout()
    expect(await isMemoryRootRead('Read', { file_path: join(own, 'existing.md') }, roots)).toBe(true)
    expect(await isMemoryRootRead('Read', { file_path: join(claude, 'existing.md') }, roots)).toBe(true)
  })

  it('returns false for a Read outside both roots', async () => {
    const { roots, outside } = await layout()
    expect(await isMemoryRootRead('Read', { file_path: join(outside, 'secret.md') }, roots)).toBe(false)
  })

  it('exempts Glob / Grep / LS through their path field', async () => {
    const { roots, own, claude } = await layout()
    for (const tool of ['Glob', 'Grep', 'LS']) {
      expect(await isMemoryRootRead(tool, { path: own }, roots)).toBe(true)
      expect(await isMemoryRootRead(tool, { path: claude }, roots)).toBe(true)
    }
  })

  it('returns false for Glob / Grep / LS with an absent path (cwd-scoped search)', async () => {
    const { roots } = await layout()
    for (const tool of ['Glob', 'Grep', 'LS']) {
      expect(await isMemoryRootRead(tool, { pattern: '**/*.md' }, roots)).toBe(false)
      expect(await isMemoryRootRead(tool, {}, roots)).toBe(false)
    }
  })

  it('returns false for a Read of an absent target (fail-closed)', async () => {
    const { roots, own } = await layout()
    expect(await isMemoryRootRead('Read', { file_path: join(own, 'missing.md') }, roots)).toBe(false)
  })

  it('returns false when the claude root is null and the target is outside own', async () => {
    const { roots, outside } = await layout()
    expect(await isMemoryRootRead('Read', { file_path: join(outside, 'secret.md') }, { own: roots.own, claude: null })).toBe(false)
  })

  it('rejects a junction inside own whose real target escapes', async () => {
    const { roots, own, outside } = await layout()
    await symlink(outside, join(own, 'escape'), 'junction')
    expect(await isMemoryRootRead('Read', { file_path: join(own, 'escape', 'secret.md') }, roots)).toBe(false)
  })
})