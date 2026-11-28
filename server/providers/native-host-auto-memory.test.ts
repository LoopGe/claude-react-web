// Host auto-memory port: CLI-parity slug encoding, root resolution with the
// write-isolation guard, candidate enumeration, bounded reads and the dream
// session scan. Fixture dirs are real tmpdirs; the claude config root is
// injected (factory) or set through CLAUDE_CONFIG_DIR (lexical variant), so
// nothing touches the machine's real ~/.claude.

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HttpError } from '../errors.js'
import { claudeProjectSlug, createAutoMemoryPort, resolveMemoryRoots } from './native-host-auto-memory.js'
import { NativeSessionLog } from './native/session-log/log.js'
import { nativeSessionLogPath } from './native/session-log/paths.js'
import { createUserMessage } from './native/vocabulary/message.js'

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

async function tempDir(prefix = 'native-auto-memory-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function expectHttp400(fn: () => unknown): void {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).status).toBe(400)
    return
  }
  throw new Error('expected HttpError 400')
}

async function expectHttp400Async(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).status).toBe(400)
    return
  }
  throw new Error('expected HttpError 400')
}

describe('claudeProjectSlug', () => {
  it('encodes drive colon and separators like the CLI projects dir', () => {
    expect(claudeProjectSlug('D:\\codes\\claude-react-web')).toBe('D--codes-claude-react-web')
  })

  it('replaces ALL non-alphanumerics, not just separators', () => {
    expect(claudeProjectSlug('C:\\Users\\Ge Zelin\\my.project')).toBe('C--Users-Ge-Zelin-my-project')
    expect(claudeProjectSlug('D:\\my_repo+v2')).toBe('D--my-repo-v2')
  })

  it('strips trailing separators before encoding', () => {
    expect(claudeProjectSlug('D:\\codes\\repo\\')).toBe('D--codes-repo')
    expect(claudeProjectSlug('D:/codes/repo//')).toBe('D--codes-repo')
  })

  it('truncates a 250-char cwd to 200 chars plus the base36 hash of the ORIGINAL cwd', () => {
    const cwd = 'D:\\' + 'x'.repeat(247)
    // Hash suffix computed independently (h = (h<<5) - h + charCodeAt | 0).
    expect(claudeProjectSlug(cwd)).toBe('D--' + 'x'.repeat(197) + '-8g0v72')
  })

  it('leaves a 200-char slug untouched and truncates at 201', () => {
    expect(claudeProjectSlug('a'.repeat(200))).toBe('a'.repeat(200))
    expect(claudeProjectSlug('a'.repeat(201))).toBe('a'.repeat(200) + '-rkvsv5')
  })
})

describe('resolveMemoryRoots (lexical variant)', () => {
  let configDir: string
  let previousEnv: string | undefined

  beforeEach(async () => {
    configDir = await tempDir('claude-config-')
    previousEnv = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = configDir
  })

  afterEach(() => {
    if (previousEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousEnv
  })

  it('defaults own to the stateDir slug root and claude to the config projects memory dir', () => {
    const roots = resolveMemoryRoots('D:\\codes\\repo', 'D:\\state')
    expect(roots.own).toBe(join('D:\\state', 'native-memory', 'D--codes-repo'))
    expect(roots.claude).toBe(join(configDir, 'projects', 'D--codes-repo', 'memory'))
    // The dream's read-only consolidation source rides the broker roots.
    expect(roots.sessionLogs).toBe(join('D:\\state', 'native-sessions'))
  })

  it('override replaces own only; the claude compat root is unchanged', () => {
    const override = join('D:\\custom', 'memory')
    const roots = resolveMemoryRoots('D:\\codes\\repo', 'D:\\state', override)
    expect(roots.own).toBe(override)
    expect(roots.claude).toBe(join(configDir, 'projects', 'D--codes-repo', 'memory'))
  })

  it('expands a ~/ prefix against the home directory', () => {
    const roots = resolveMemoryRoots('D:\\codes\\repo', 'D:\\state', '~/mem')
    expect(roots.own).toBe(join(homedir(), 'mem'))
  })

  it('rejects an override with raw .. segments', () => {
    expectHttp400(() => resolveMemoryRoots('D:\\codes\\repo', 'D:\\state', 'D:\\state\\a\\..\\b'))
  })

  it('rejects an override lexically inside the claude config dir', () => {
    expectHttp400(() => resolveMemoryRoots('D:\\codes\\repo', 'D:\\state', join(configDir, 'projects', 'x', 'memory')))
  })
})

describe('createAutoMemoryPort.resolve', () => {
  async function fixture(): Promise<{ root: string; stateDir: string; configDir: string; port: ReturnType<typeof createAutoMemoryPort> }> {
    const root = await tempDir()
    const stateDir = join(root, 'state')
    const configDir = join(root, 'claude-config')
    await mkdir(stateDir, { recursive: true })
    await mkdir(configDir, { recursive: true })
    return { root, stateDir, configDir, port: createAutoMemoryPort({ stateDir, configDir }) }
  }

  it('creates the default ownDir with an empty MEMORY.md; absent claude dir is null', async () => {
    const { port, stateDir } = await fixture()
    const res = await port.resolve('D:\\codes\\repo')
    expect(res.ownDir).toBe(join(stateDir, 'native-memory', 'D--codes-repo'))
    expect(res.claudeDir).toBeNull()
    expect(await readFile(join(res.ownDir, 'MEMORY.md'), 'utf8')).toBe('')
  })

  it('reports the claude compat dir when it exists', async () => {
    const { port, configDir } = await fixture()
    const claudeDir = join(configDir, 'projects', 'D--codes-repo', 'memory')
    await mkdir(claudeDir, { recursive: true })
    const res = await port.resolve('D:\\codes\\repo')
    expect(res.claudeDir).toBe(claudeDir)
  })

  it('preserves an existing MEMORY.md index', async () => {
    const { port, stateDir } = await fixture()
    const ownDir = join(stateDir, 'native-memory', 'D--codes-repo')
    await mkdir(ownDir, { recursive: true })
    await writeFile(join(ownDir, 'MEMORY.md'), '- [A](a.md) — hook\n')
    const res = await port.resolve('D:\\codes\\repo')
    expect(await readFile(join(res.ownDir, 'MEMORY.md'), 'utf8')).toBe('- [A](a.md) — hook\n')
  })

  it('override replaces ownDir and is created with an empty MEMORY.md', async () => {
    const { port, root } = await fixture()
    const override = join(root, 'custom-memory')
    const res = await port.resolve('D:\\codes\\repo', override)
    expect(res.ownDir).toBe(override)
    expect(res.claudeDir).toBeNull()
    expect(await readFile(join(override, 'MEMORY.md'), 'utf8')).toBe('')
  })

  it('rejects an override inside the claude config dir with 400 and creates nothing', async () => {
    const { port, configDir } = await fixture()
    const override = join(configDir, 'projects', 'x', 'memory')
    await expectHttp400Async(() => port.resolve('D:\\codes\\repo', override))
    expect(existsSync(override)).toBe(false)
  })

  it('rejects a symlink alias pointing into the claude config dir (realpath check)', async () => {
    const { port, root, configDir } = await fixture()
    const target = join(configDir, 'mem-target')
    await mkdir(target, { recursive: true })
    const alias = join(root, 'alias')
    await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await expectHttp400Async(() => port.resolve('D:\\codes\\repo', alias))
  })

  it('rejects a nonexistent override under a symlinked parent BEFORE creating it', async () => {
    const { port, root, configDir } = await fixture()
    const target = join(configDir, 'mem-target')
    await mkdir(target, { recursive: true })
    const alias = join(root, 'alias')
    await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const override = join(alias, 'new-sub')
    await expectHttp400Async(() => port.resolve('D:\\codes\\repo', override))
    expect(existsSync(join(target, 'new-sub'))).toBe(false)
  })

  it('rejects a DANGLING symlink/junction override and creates nothing at its target', async () => {
    const { port, root, configDir } = await fixture()
    // The override is itself a dangling link → configDir/planted (absent). The
    // old lexical-tail re-append passed the guard, then mkdir followed the link
    // and created the directory INSIDE the config dir. Fail closed instead.
    // 'junction' is ignored as a type on posix (dangling dir symlink); on win32
    // junction creation does not require the target to exist.
    const alias = join(root, 'dangling')
    await symlink(join(configDir, 'planted'), alias, 'junction')
    await expect(port.resolve('D:\\codes\\repo', alias)).rejects.toThrow(/dangling symlink/)
    expect(existsSync(join(configDir, 'planted'))).toBe(false)
  })

  it('rejects an override with raw .. segments', async () => {
    const { port, root } = await fixture()
    await expectHttp400Async(() => port.resolve('D:\\codes\\repo', `${root}\\sub\\..\\escape`))
  })
})

describe('createAutoMemoryPort.listCandidates', () => {
  async function candidateFixture(): Promise<string> {
    const dir = await tempDir('memory-candidates-')
    await writeFile(join(dir, 'a.md'), '---\nname: fact-a\ndescription: First fact\nmetadata:\n  type: user\n---\nBody A\n')
    await writeFile(join(dir, 'b.md'), '---\nname: fact-b\ndescription: Second fact\nmetadata:\n  type: project\n---\nBody B\n')
    await writeFile(join(dir, 'MEMORY.md'), '- [A](a.md) — hook\n')
    await writeFile(join(dir, 'unknown.md'), '---\nname: fact-u\ndescription: Unknown fields tolerated\nmetadata:\n  type: feedback\nfutureField: whatever\n---\nBody U\n')
    await writeFile(join(dir, 'corrupt.md'), '---\nname: [unclosed\n---\nBody\n')
    await writeFile(join(dir, 'plain.md'), 'No frontmatter here.\n')
    await writeFile(join(dir, 'notes.txt'), 'not markdown')
    await mkdir(join(dir, 'nested'))
    await writeFile(join(dir, 'nested', 'c.md'), '---\ndescription: Nested fact\nmetadata:\n  type: reference\n---\nBody C\n')
    return dir
  }

  it('returns valid + unknown-field files, skips corrupt YAML, never MEMORY.md or non-md', async () => {
    const dir = await candidateFixture()
    const port = createAutoMemoryPort({ stateDir: dir })
    const candidates = await port.listCandidates([dir])
    const byName = new Map(candidates.map((c) => [c.filename, c]))
    expect([...byName.keys()].sort()).toEqual(['a.md', 'b.md', 'nested/c.md', 'plain.md', 'unknown.md'])
    expect(byName.get('a.md')).toMatchObject({ dir, path: join(dir, 'a.md'), description: 'First fact', memoryType: 'user' })
    expect(byName.get('b.md')).toMatchObject({ description: 'Second fact', memoryType: 'project' })
    expect(byName.get('unknown.md')).toMatchObject({ description: 'Unknown fields tolerated', memoryType: 'feedback' })
    expect(byName.get('nested/c.md')).toMatchObject({ path: join(dir, 'nested', 'c.md'), description: 'Nested fact', memoryType: 'reference' })
    expect(byName.get('plain.md')).toMatchObject({ description: null, memoryType: null })
    for (const c of candidates) expect(c.mtimeMs).toBeGreaterThan(0)
  })

  it('orders newest-first with a filename tiebreak', async () => {
    const dir = await candidateFixture()
    const now = new Date()
    const old = new Date(now.getTime() - 10_000)
    // Equal mtimes on the fresh files so the filename tiebreak is what decides.
    for (const name of ['b.md', 'unknown.md', 'plain.md', join('nested', 'c.md')]) {
      await utimes(join(dir, name), now, now)
    }
    await utimes(join(dir, 'a.md'), old, old)
    const port = createAutoMemoryPort({ stateDir: dir })
    const candidates = await port.listCandidates([dir])
    expect(candidates[0].filename).toBe('b.md')
    expect(candidates[candidates.length - 1].filename).toBe('a.md')
  })

  it('absent dirs contribute nothing and never throw', async () => {
    const dir = await candidateFixture()
    const port = createAutoMemoryPort({ stateDir: dir })
    expect(await port.listCandidates([join(dir, 'absent')])).toEqual([])
    const merged = await port.listCandidates([dir, join(dir, 'absent')])
    expect(merged).toHaveLength(5)
  })

  it('a large body does not affect frontmatter parsing (head read)', async () => {
    const dir = await tempDir('memory-candidates-large-')
    const body = 'x'.repeat(2 * 1024 * 1024)
    await writeFile(join(dir, 'big.md'), `---\ndescription: Big fact\nmetadata:\n  type: user\n---\n${body}\n`)
    const port = createAutoMemoryPort({ stateDir: dir })
    const candidates = await port.listCandidates([dir])
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ filename: 'big.md', description: 'Big fact', memoryType: 'user' })
  })

  it('enumeration reads only a head: a closing delimiter beyond the head budget reads as malformed', async () => {
    const dir = await tempDir('memory-candidates-head-')
    // Frontmatter whose closing delimiter sits past the head budget: a
    // full-file read would parse it, the bounded head read sees a missing
    // delimiter (the malformed contract) and skips the file. This is the
    // black-box proof the scan never reads the whole file.
    const padding = Array.from({ length: 400 }, (_, i) => `key${i}: ${'v'.repeat(40)}`).join('\n')
    await writeFile(join(dir, 'huge-fm.md'), `---\ndescription: Hidden\n${padding}\n---\nBody\n`)
    const port = createAutoMemoryPort({ stateDir: dir })
    expect(await port.listCandidates([dir])).toEqual([])
  })
})

describe('createAutoMemoryPort.readIndex', () => {
  it('absent index is null', async () => {
    const dir = await tempDir()
    const port = createAutoMemoryPort({ stateDir: dir })
    expect(await port.readIndex(dir)).toBeNull()
  })

  it('returns a small index verbatim', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'MEMORY.md'), '- [A](a.md) — hook\n')
    const port = createAutoMemoryPort({ stateDir: dir })
    expect(await port.readIndex(dir)).toBe('- [A](a.md) — hook\n')
  })

  it('caps at 200 lines', async () => {
    const dir = await tempDir()
    const lines = Array.from({ length: 250 }, (_, i) => `line ${i}`)
    await writeFile(join(dir, 'MEMORY.md'), lines.join('\n') + '\n')
    const port = createAutoMemoryPort({ stateDir: dir })
    expect(await port.readIndex(dir)).toBe(lines.slice(0, 200).join('\n'))
  })

  it('caps at 25000 bytes when the line count is under the cap', async () => {
    const dir = await tempDir()
    const content = Array.from({ length: 100 }, () => 'a'.repeat(300)).join('\n')
    await writeFile(join(dir, 'MEMORY.md'), content)
    const port = createAutoMemoryPort({ stateDir: dir })
    const index = await port.readIndex(dir)
    expect(index).toHaveLength(25000)
  })
})

describe('createAutoMemoryPort.readMemoryFile', () => {
  it('returns a small file verbatim, CRLF included', async () => {
    const dir = await tempDir()
    const path = join(dir, 'm.md')
    await writeFile(path, 'a\r\nb\r\n')
    const port = createAutoMemoryPort({ stateDir: dir })
    expect(await port.readMemoryFile(path)).toEqual({ content: 'a\r\nb\r\n', truncated: false })
  })

  it('4096 bytes exactly is not truncated; one byte more is', async () => {
    const dir = await tempDir()
    const port = createAutoMemoryPort({ stateDir: dir })
    const exact = join(dir, 'exact.md')
    await writeFile(exact, 'a'.repeat(4096))
    expect(await port.readMemoryFile(exact)).toEqual({ content: 'a'.repeat(4096), truncated: false })
    const over = join(dir, 'over.md')
    await writeFile(over, 'a'.repeat(4097))
    expect(await port.readMemoryFile(over)).toEqual({ content: 'a'.repeat(4096), truncated: true })
  })

  it('200 lines with a trailing newline is not truncated; 201 lines is', async () => {
    const dir = await tempDir()
    const port = createAutoMemoryPort({ stateDir: dir })
    const exact = join(dir, 'exact.md')
    const lines200 = Array.from({ length: 200 }, (_, i) => `line ${i}`)
    await writeFile(exact, lines200.join('\n') + '\n')
    expect(await port.readMemoryFile(exact)).toEqual({ content: lines200.join('\n') + '\n', truncated: false })
    const over = join(dir, 'over.md')
    const lines201 = Array.from({ length: 201 }, (_, i) => `line ${i}`)
    await writeFile(over, lines201.join('\n') + '\n')
    expect(await port.readMemoryFile(over)).toEqual({ content: lines200.join('\n'), truncated: true })
  })

  it('a byte cut through a multi-byte CJK character drops the partial character', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cjk.md')
    await writeFile(path, '中'.repeat(2000))
    const port = createAutoMemoryPort({ stateDir: dir })
    const res = await port.readMemoryFile(path)
    expect(res.truncated).toBe(true)
    expect(res.content).toBe('中'.repeat(1365))
    expect(res.content).not.toContain('\uFFFD')
  })

  it('an absent file rejects loudly', async () => {
    const dir = await tempDir()
    const port = createAutoMemoryPort({ stateDir: dir })
    await expect(port.readMemoryFile(join(dir, 'absent.md'))).rejects.toThrow()
  })
})

describe('createAutoMemoryPort.listSessionsTouchedSince', () => {
  async function writeSession(stateDir: string, id: string, cwd: string): Promise<void> {
    const log = NativeSessionLog.open({ stateDir, id, cwd, resume: false })
    log.append({
      type: 'user/message',
      time: Date.now(),
      parentToolUseId: null,
      data: createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }),
    })
    await log.flush()
    await log.close()
  }

  it('returns only same-cwd sessions touched at or after the threshold', async () => {
    const stateDir = await tempDir()
    const port = createAutoMemoryPort({ stateDir })
    const idOld = randomUUID()
    const idNew = randomUUID()
    const idOther = randomUUID()
    await writeSession(stateDir, idOld, 'D:\\repo')
    await writeSession(stateDir, idNew, 'D:\\repo')
    await writeSession(stateDir, idOther, 'D:\\other')
    const now = Date.now()
    const old = new Date(now - 10_000)
    await utimes(nativeSessionLogPath(stateDir, idOld), old, old)
    await utimes(nativeSessionLogPath(stateDir, idNew), new Date(now), new Date(now))
    await utimes(nativeSessionLogPath(stateDir, idOther), new Date(now), new Date(now))
    const res = await port.listSessionsTouchedSince('D:\\repo', now - 5000)
    expect(res).toEqual([{ id: idNew, logPath: nativeSessionLogPath(stateDir, idNew) }])
  })

  it('an empty state dir yields no sessions', async () => {
    const stateDir = await tempDir()
    const port = createAutoMemoryPort({ stateDir })
    expect(await port.listSessionsTouchedSince('D:\\repo', 0)).toEqual([])
  })
})

describe('createAutoMemoryPort dream state + lease', () => {
  const dreamStateFile = (stateDir: string): string => join(stateDir, 'native-memory', 'dream-state.json')

  it('readDreamState is {} when the state file is absent', async () => {
    const stateDir = await tempDir()
    const port = createAutoMemoryPort({ stateDir })
    expect(await port.readDreamState()).toEqual({})
  })

  it('claimDream: first claim true, second false, other cwdKeys unaffected', async () => {
    const stateDir = await tempDir()
    const port = createAutoMemoryPort({ stateDir })
    expect(await port.claimDream('D--repo')).toBe(true)
    expect(await port.claimDream('D--repo')).toBe(false)
    expect(await port.claimDream('D--other')).toBe(true)
  })

  it('claim does not persist running state (process-local lease)', async () => {
    const stateDir = await tempDir()
    const port = createAutoMemoryPort({ stateDir })
    await port.claimDream('D--repo')
    expect(await port.readDreamState()).toEqual({})
    expect(existsSync(dreamStateFile(stateDir))).toBe(false)
  })

  it('releaseDream persists lastDreamAt to the state file and unlocks the lease', async () => {
    const stateDir = await tempDir()
    const port = createAutoMemoryPort({ stateDir })
    await port.claimDream('D--repo')
    await port.releaseDream('D--repo', 1_700_000_000_000)
    expect(JSON.parse(await readFile(dreamStateFile(stateDir), 'utf8')))
      .toEqual({ 'D--repo': { lastDreamAt: 1_700_000_000_000 } })
    expect(await port.readDreamState()).toEqual({ 'D--repo': { lastDreamAt: 1_700_000_000_000 } })
    expect(await port.claimDream('D--repo')).toBe(true)
  })

  it('releaseDream merges keys instead of clobbering other cwds', async () => {
    const stateDir = await tempDir()
    const port = createAutoMemoryPort({ stateDir })
    await port.claimDream('D--a')
    await port.releaseDream('D--a', 10)
    await port.claimDream('D--b')
    await port.releaseDream('D--b', 20)
    expect(await port.readDreamState()).toEqual({ 'D--a': { lastDreamAt: 10 }, 'D--b': { lastDreamAt: 20 } })
  })

  it('concurrent releases for different cwdKeys both persist', async () => {
    const stateDir = await tempDir()
    const port = createAutoMemoryPort({ stateDir })
    await port.claimDream('D--a')
    await port.claimDream('D--b')
    await Promise.all([port.releaseDream('D--a', 10), port.releaseDream('D--b', 20)])
    expect(await port.readDreamState()).toEqual({ 'D--a': { lastDreamAt: 10 }, 'D--b': { lastDreamAt: 20 } })
  })

  it('a fresh port instance reads the persisted state and can claim again (crash resets the lease)', async () => {
    const stateDir = await tempDir()
    const port = createAutoMemoryPort({ stateDir })
    await port.claimDream('D--repo')
    await port.releaseDream('D--repo', 42)
    const restarted = createAutoMemoryPort({ stateDir })
    expect(await restarted.readDreamState()).toEqual({ 'D--repo': { lastDreamAt: 42 } })
    expect(await restarted.claimDream('D--repo')).toBe(true)
  })

  it('a corrupt state file reads as absent and the next release rewrites it', async () => {
    const stateDir = await tempDir()
    const port = createAutoMemoryPort({ stateDir })
    await mkdir(join(stateDir, 'native-memory'), { recursive: true })
    await writeFile(dreamStateFile(stateDir), '{torn')
    expect(await port.readDreamState()).toEqual({})
    await port.claimDream('D--repo')
    await port.releaseDream('D--repo', 7)
    expect(await port.readDreamState()).toEqual({ 'D--repo': { lastDreamAt: 7 } })
  })

  it('a non-object state file reads as absent', async () => {
    const stateDir = await tempDir()
    const port = createAutoMemoryPort({ stateDir })
    await mkdir(join(stateDir, 'native-memory'), { recursive: true })
    await writeFile(dreamStateFile(stateDir), '[]')
    expect(await port.readDreamState()).toEqual({})
  })

  it('drops entries whose lastDreamAt is not a finite number (a corrupt entry must not wedge the cwd dream)', async () => {
    const stateDir = await tempDir()
    const port = createAutoMemoryPort({ stateDir })
    await mkdir(join(stateDir, 'native-memory'), { recursive: true })
    await writeFile(dreamStateFile(stateDir), JSON.stringify({
      'D--good': { lastDreamAt: 42 },
      'D--string': { lastDreamAt: 'oops' },
      'D--null': { lastDreamAt: null },
      'D--object': { lastDreamAt: {} },
      'D--missing': {},
      'D--array': [1, 2],
      'D--scalar': 'x',
    }))
    expect(await port.readDreamState()).toEqual({ 'D--good': { lastDreamAt: 42 } })
    // The next release repairs the dropped cwd: a valid entry replaces the corrupt one.
    await port.claimDream('D--string')
    await port.releaseDream('D--string', 7)
    expect(await port.readDreamState()).toEqual({ 'D--good': { lastDreamAt: 42 }, 'D--string': { lastDreamAt: 7 } })
  })

  it('drops a non-finite lastDreamAt (JSON 1e999 parses to Infinity)', async () => {
    const stateDir = await tempDir()
    const port = createAutoMemoryPort({ stateDir })
    await mkdir(join(stateDir, 'native-memory'), { recursive: true })
    await writeFile(dreamStateFile(stateDir), '{"D--inf":{"lastDreamAt":1e999},"D--good":{"lastDreamAt":42}}')
    expect(await port.readDreamState()).toEqual({ 'D--good': { lastDreamAt: 42 } })
  })
})
