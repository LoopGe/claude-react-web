// server/providers/native/tools/glob-ls.test.ts
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ToolInputError } from './types.js'
import { globTool } from './glob.js'
import { lsTool } from './ls.js'

let dir: string
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })
const ctx = (cwd: string, signal = new AbortController().signal) => ({ cwd, signal })

function parse<T>(text: string): T {
  return JSON.parse(text) as T
}

interface GlobOutput {
  durationMs: number
  numFiles: number
  filenames: string[]
  truncated: boolean
  totalMatches?: number
}

interface LsOutput {
  path: string
  entries: Array<{ name: string; type: 'file' | 'dir' | 'link'; size?: number }>
  truncated: boolean
}

describe('globTool', () => {
  it('matches nested files with ** and reports cwd-relative paths', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-glob-'))
    await mkdir(join(dir, 'src', 'nested'), { recursive: true })
    await mkdir(join(dir, 'node_modules'), { recursive: true })
    await writeFile(join(dir, 'root.ts'), 'x')
    await writeFile(join(dir, 'src', 'nested', 'a.ts'), 'x')
    await writeFile(join(dir, 'src', 'nested', 'b.md'), 'x')
    await writeFile(join(dir, 'node_modules', 'ignored.ts'), 'x')

    const out = parse<GlobOutput>((await globTool.run({ pattern: '**/*.ts' }, ctx(dir))).text)
    expect(out.filenames).toEqual(['root.ts', 'src/nested/a.ts'])
    expect(out.numFiles).toBe(2)
    expect(out.truncated).toBe(false)
    expect(typeof out.durationMs).toBe('number')
  })

  it('matches ? as exactly one character and never spans a slash', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-glob-'))
    await mkdir(join(dir, 'src'), { recursive: true })
    await writeFile(join(dir, 'src', 'a.ts'), 'x')
    await writeFile(join(dir, 'srcXa.ts'), 'x')

    // `src/a.ts` is the same character count as the pattern would allow if `?`
    // could consume `/`; it must not match.
    const out = parse<GlobOutput>((await globTool.run({ pattern: 'src?a.ts' }, ctx(dir))).text)
    expect(out.filenames).toEqual(['srcXa.ts'])
  })

  it('matches the pattern against the walk-relative path under path', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-glob-'))
    await mkdir(join(dir, 'src', 'nested'), { recursive: true })
    await writeFile(join(dir, 'root.ts'), 'x')
    await writeFile(join(dir, 'src', 'a.ts'), 'x')
    await writeFile(join(dir, 'src', 'nested', 'deep.ts'), 'x')

    // `*.ts` is one segment relative to the search root, so it excludes
    // nested/deep.ts; results stay cwd-relative for feeding to Read.
    const out = parse<GlobOutput>((await globTool.run({ pattern: '*.ts', path: 'src' }, ctx(dir))).text)
    expect(out.filenames).toEqual(['src/a.ts'])
  })

  it('collapses consecutive **/ segments instead of backtracking over them', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-glob-'))
    await mkdir(join(dir, 'a', 'b'), { recursive: true })
    await writeFile(join(dir, 'a', 'b', 'c.ts'), 'x')

    const out = parse<GlobOutput>((await globTool.run({ pattern: '**/**/**/**/*.ts' }, ctx(dir))).text)
    expect(out.filenames).toEqual(['a/b/c.ts'])
  })

  it('caps filenames at 100 and reports the full match count', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-glob-'))
    for (let i = 0; i < 101; i++) {
      await writeFile(join(dir, `f${String(i).padStart(3, '0')}.txt`), 'x')
    }

    const out = parse<GlobOutput>((await globTool.run({ pattern: '*.txt' }, ctx(dir))).text)
    expect(out.filenames).toHaveLength(100)
    expect(out.numFiles).toBe(100)
    expect(out.truncated).toBe(true)
    expect(out.totalMatches).toBe(101)
  })

  it('stops after the first 101 observed matches instead of walking the whole tree', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-glob-'))
    for (let i = 0; i < 150; i++) {
      await writeFile(join(dir, `f${String(i).padStart(3, '0')}.txt`), 'x')
    }

    const out = parse<GlobOutput>((await globTool.run({ pattern: '*.txt' }, ctx(dir))).text)
    expect(out.filenames).toHaveLength(100)
    expect(out.truncated).toBe(true)
    // Old behavior reported all 150; the observed count is bounded by the
    // early stop at MAX_FILES + 1.
    expect(out.totalMatches).toBe(101)
  })

  it('stops the walk when the turn signal aborts', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-glob-'))
    await writeFile(join(dir, 'a.ts'), 'x')
    const controller = new AbortController()
    controller.abort()

    await expect(
      globTool.run({ pattern: '**/*.ts' }, ctx(dir, controller.signal)),
    ).rejects.toThrow(/abort/i)
  })

  it('errors when the search root does not exist', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-glob-'))
    await expect(globTool.run({ pattern: '*', path: 'missing' }, ctx(dir)))
      .rejects.toThrow('path not found: missing')
  })

  it('rejects a path that escapes the working directory', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-glob-'))
    await expect(globTool.run({ pattern: '*', path: '../outside' }, ctx(dir))).rejects.toThrow(ToolInputError)
  })

  it('matches a file root by its own basename', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-glob-'))
    await writeFile(join(dir, 'a.ts'), 'x')
    await writeFile(join(dir, 'b.md'), 'x')

    const out = parse<GlobOutput>((await globTool.run({ pattern: 'a.ts', path: 'a.ts' }, ctx(dir))).text)
    expect(out.filenames).toEqual(['a.ts'])
    expect(out.numFiles).toBe(1)
  })

  it('declares its prompt-section slot', () => {
    expect(globTool.promptOrder).toBe(140)
    expect(globTool.guidance).not.toBe('')
  })

  it('never spawns a subprocess (pure-Node walk, no ripgrep)', async () => {
    for (const file of ['./glob.ts', './grep.ts'] as const) {
      const source = await readFile(new URL(file, import.meta.url), 'utf-8')
      expect(source).not.toMatch(/node:child_process|execFile|spawn\(/)
    }
  })
})

describe('lsTool', () => {
  it('lists immediate children with type and size', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-ls-'))
    await mkdir(join(dir, 'sub', 'nested'), { recursive: true })
    await writeFile(join(dir, 'a.txt'), 'hello')
    await writeFile(join(dir, 'b.md'), 'x')

    const out = parse<LsOutput>((await lsTool.run({}, ctx(dir))).text)
    expect(out.path).toBe(resolve(dir))
    expect(out.entries).toEqual([
      { name: 'a.txt', type: 'file', size: 5 },
      { name: 'b.md', type: 'file', size: 1 },
      { name: 'sub', type: 'dir' },
    ])
    expect(out.truncated).toBe(false)
  })

  it('reports a symlinked directory as type link', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-ls-'))
    await mkdir(join(dir, 'target'), { recursive: true })
    await writeFile(join(dir, 'target', 'x.txt'), 'x')
    // A junction keeps this working on Windows without elevation.
    await symlink(join(dir, 'target'), join(dir, 'link-dir'), process.platform === 'win32' ? 'junction' : 'dir')

    const out = parse<LsOutput>((await lsTool.run({}, ctx(dir))).text)
    expect(out.entries).toContainEqual({ name: 'link-dir', type: 'link' })
    expect(out.entries).toContainEqual({ name: 'target', type: 'dir' })
  })

  it('excludes .git and applies ignore substring filters', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-ls-'))
    await mkdir(join(dir, '.git'), { recursive: true })
    await mkdir(join(dir, 'node_modules'), { recursive: true })
    await writeFile(join(dir, '.gitignore'), 'x')
    await writeFile(join(dir, 'keep.ts'), 'x')
    await writeFile(join(dir, 'skip.log'), 'x')

    const out = parse<LsOutput>((await lsTool.run({ ignore: ['node_modules', '.log'] }, ctx(dir))).text)
    expect(out.entries.map((e) => e.name)).toEqual(['.gitignore', 'keep.ts'])
  })

  it('caps entries at 100 and flags truncation', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-ls-'))
    for (let i = 0; i < 101; i++) {
      await writeFile(join(dir, `f${String(i).padStart(3, '0')}.txt`), 'x')
    }

    const out = parse<LsOutput>((await lsTool.run({}, ctx(dir))).text)
    expect(out.entries).toHaveLength(100)
    expect(out.truncated).toBe(true)
  })

  it('reports a missing directory as directory not found', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-ls-'))
    await expect(lsTool.run({ path: 'missing' }, ctx(dir))).rejects.toThrow('directory not found: missing')
  })

  it('surfaces non-ENOENT stat errors with the real message', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-ls-'))
    const err: unknown = await lsTool.run({ path: 'bad\u0000name' }, ctx(dir)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ToolInputError)
    const message = (err as Error).message
    expect(message).not.toContain('directory not found')
    expect(message).toMatch(/null bytes|ERR_INVALID_ARG_VALUE/i)
  })

  it('rejects a path that escapes the working directory', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-ls-'))
    await expect(lsTool.run({ path: '../outside' }, ctx(dir))).rejects.toThrow(ToolInputError)
  })

  it('rejects a non-directory target', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-ls-'))
    await writeFile(join(dir, 'a.txt'), 'x')
    await expect(lsTool.run({ path: 'a.txt' }, ctx(dir))).rejects.toThrow(ToolInputError)
  })

  it('declares its prompt-section slot', () => {
    expect(lsTool.promptOrder).toBe(150)
    expect(lsTool.guidance).not.toBe('')
  })
})
