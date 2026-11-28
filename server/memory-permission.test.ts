// Root-scoped memory permission helpers: realpath containment for the native
// auto-memory store. Fixture dirs are real tmpdirs (realpath needs existence);
// directory escapes use junctions, which need no privilege on win32 and are
// ignored as a type on posix (the file-read.test.ts precedent).

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
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
async function layout(): Promise<{ roots: MemoryRoots; base: string; own: string; claude: string; outside: string }> {
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
  return { roots: { own, claude }, base, own, claude, outside }
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

  // A DANGLING symlink/junction realpaths ENOENT while lstat still sees the
  // link. The old lexical-tail re-append judged the write under own, but the OS
  // creates the file at the link's TARGET (POSIX O_CREAT follows the link) — an
  // escape into the claude dir. The helper must fail closed, not guess.
  it('rejects a Write through a DANGLING junction/symlink under own whose target is in the claude dir', async () => {
    const { roots, own, claude } = await layout()
    // Target absent (claude/sub does not exist). 'junction' is ignored as a type
    // on posix → a dangling dir symlink; on win32 a junction (no privilege needed,
    // and junction creation does not require the target to exist).
    await symlink(join(claude, 'sub'), join(own, 'escape'), 'junction')
    expect(await isMemoryRootWrite('Write', { file_path: join(own, 'escape', 'planted.md') }, roots)).toBe(false)
  })

  it('fails closed on a dangling link even when its target would stay inside own', async () => {
    const { roots, own } = await layout()
    // own/a → own/b (absent): a benign target, but the helper cannot prove the
    // write lands inside own without resolving the link, so it declines.
    await symlink(join(own, 'b'), join(own, 'a'), 'junction')
    expect(await isMemoryRootWrite('Write', { file_path: join(own, 'a') }, roots)).toBe(false)
  })

  it('sensitive-path guard is root-relative: a sensitive ancestor ABOVE own does not disable the exemption', async () => {
    const base = await tempDir()
    // An override nested under a .claude dir (e.g. a worktree layout): the
    // ancestor must not flag every memory write — only segments below own count.
    const own = join(base, '.claude', 'mem')
    await mkdir(own, { recursive: true })
    const roots: MemoryRoots = { own, claude: null }
    expect(await isMemoryRootWrite('Write', { file_path: join(own, 'fact.md') }, roots)).toBe(true)
    // A sensitive area UNDER the root still prompts (default opt-out).
    expect(await isMemoryRootWrite('Write', { file_path: join(own, '.git', 'config') }, roots)).toBe(false)
    // …and is exempt once the user opts in.
    expect(await isMemoryRootWrite('Write', { file_path: join(own, '.git', 'config') }, roots, undefined, true)).toBe(true)
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

// The native session-log tree is the dream consolidation's read-only source
// material. The broker exempts reads there so a background dream never stalls
// on an interactive prompt; it is NEVER a write root (write isolation).
describe('session-log read root (dream consolidation source)', () => {
  async function logLayout(): Promise<{ roots: MemoryRoots; logs: string; own: string; outside: string }> {
    const base = await tempDir()
    const own = join(base, 'own')
    const logs = join(base, 'native-sessions')
    const outside = join(base, 'outside')
    await mkdir(own)
    await mkdir(join(logs, 'sess-a'), { recursive: true })
    await mkdir(outside)
    await writeFile(join(own, 'existing.md'), 'own')
    await writeFile(join(logs, 'sess-a', 'session.v1.jsonl'), '{"type":"session/header"}\n')
    await writeFile(join(outside, 'secret.md'), 'outside')
    return { roots: { own, claude: null, sessionLogs: logs }, logs, own, outside }
  }

  it('exempts a Read of a session log inside the session-log root', async () => {
    const { roots, logs } = await logLayout()
    expect(await isMemoryRootRead('Read', { file_path: join(logs, 'sess-a', 'session.v1.jsonl') }, roots)).toBe(true)
  })

  it('NEVER exempts a Write inside the session-log root (read-only root)', async () => {
    const { roots, logs } = await logLayout()
    expect(await isMemoryRootWrite('Write', { file_path: join(logs, 'sess-a', 'session.v1.jsonl') }, roots)).toBe(false)
    expect(await isMemoryRootWrite('Write', { file_path: join(logs, 'new.jsonl') }, roots)).toBe(false)
  })

  it('returns false for a Read outside the session-log root', async () => {
    const { roots, outside } = await logLayout()
    expect(await isMemoryRootRead('Read', { file_path: join(outside, 'secret.md') }, roots)).toBe(false)
  })

  it('grants no session-log exemption when the root is absent', async () => {
    const { roots, logs } = await logLayout()
    const without: MemoryRoots = { own: roots.own, claude: null }
    expect(await isMemoryRootRead('Read', { file_path: join(logs, 'sess-a', 'session.v1.jsonl') }, without)).toBe(false)
  })
})

// Relative path fields must be anchored at the SESSION cwd (the base the tool
// executes against), never at process.cwd() — otherwise the exemption judges a
// different path than the one written (decision-integrity defect).
describe('relative path resolution against session cwd', () => {
  it('write: a forward relative path is exempt when anchored at a cwd that reaches own', async () => {
    const { roots, base } = await layout()
    // resolve(base, 'own/existing.md') === join(base, 'own', 'existing.md').
    expect(await isMemoryRootWrite('Write', { file_path: 'own/existing.md' }, roots, base)).toBe(true)
    expect(await isMemoryRootWrite('Write', { file_path: 'own/new.md' }, roots, base)).toBe(true)
  })

  it('write: the SAME relative path is not exempt from a different cwd (anchor divergence)', async () => {
    const { roots, base, outside } = await layout()
    // From base it reaches own; from outside it lands in outside/own (not own).
    expect(await isMemoryRootWrite('Write', { file_path: 'own/existing.md' }, roots, base)).toBe(true)
    expect(await isMemoryRootWrite('Write', { file_path: 'own/existing.md' }, roots, outside)).toBe(false)
  })

  it('write: a .. relative path anchored at the session cwd reaches own', async () => {
    const { roots, own, outside } = await layout()
    const rel = relative(outside, join(own, 'existing.md')) // ../own/existing.md
    expect(await isMemoryRootWrite('Write', { file_path: rel }, roots, outside)).toBe(true)
  })

  it('write: a relative path with no cwd fails closed', async () => {
    const { roots } = await layout()
    expect(await isMemoryRootWrite('Write', { file_path: 'own/existing.md' }, roots)).toBe(false)
    expect(await isMemoryRootWrite('Write', { file_path: 'own/existing.md' }, roots, undefined)).toBe(false)
  })

  it('write: an absolute path is unchanged regardless of cwd', async () => {
    const { roots, own, outside } = await layout()
    const abs = join(own, 'existing.md')
    expect(await isMemoryRootWrite('Write', { file_path: abs }, roots, outside)).toBe(true)
    expect(await isMemoryRootWrite('Write', { file_path: abs }, roots)).toBe(true)
  })

  it('read: relative Read / Glob paths anchor at the session cwd', async () => {
    const { roots, base, outside } = await layout()
    expect(await isMemoryRootRead('Read', { file_path: 'own/existing.md' }, roots, base)).toBe(true)
    expect(await isMemoryRootRead('Read', { file_path: 'claude/existing.md' }, roots, base)).toBe(true)
    expect(await isMemoryRootRead('Glob', { path: 'own' }, roots, base)).toBe(true)
    // From a different cwd the same relative path does not reach the roots.
    expect(await isMemoryRootRead('Read', { file_path: 'own/existing.md' }, roots, outside)).toBe(false)
  })

  it('read: a relative path with no cwd fails closed', async () => {
    const { roots } = await layout()
    expect(await isMemoryRootRead('Read', { file_path: 'own/existing.md' }, roots)).toBe(false)
  })
})