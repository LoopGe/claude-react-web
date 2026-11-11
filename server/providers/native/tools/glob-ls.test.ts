// server/providers/native/tools/glob-ls.test.ts
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ToolInputError } from './types.js'
import { globTool } from './glob.js'
import { lsTool } from './ls.js'

let dir: string
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })
const ctx = (cwd: string) => ({ cwd, signal: new AbortController().signal })

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
  entries: Array<{ name: string; type: 'file' | 'dir'; size?: number }>
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

  it('matches ? as exactly one character', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-glob-'))
    await writeFile(join(dir, 'a.ts'), 'x')
    await writeFile(join(dir, 'ab.ts'), 'x')

    const out = parse<GlobOutput>((await globTool.run({ pattern: '?.ts' }, ctx(dir))).text)
    expect(out.filenames).toEqual(['a.ts'])
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

  it('rejects a path that escapes the working directory', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-glob-'))
    await expect(globTool.run({ pattern: '*', path: '../outside' }, ctx(dir))).rejects.toThrow(ToolInputError)
  })

  it('never spawns a subprocess (pure-Node walk, no ripgrep)', async () => {
    const source = await readFile(new URL('./glob.ts', import.meta.url), 'utf-8')
    expect(source).not.toMatch(/node:child_process|execFile|spawn\(/)
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

  it('rejects a path that escapes the working directory', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-ls-'))
    await expect(lsTool.run({ path: '../outside' }, ctx(dir))).rejects.toThrow(ToolInputError)
  })

  it('rejects a non-directory target', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-ls-'))
    await writeFile(join(dir, 'a.txt'), 'x')
    await expect(lsTool.run({ path: 'a.txt' }, ctx(dir))).rejects.toThrow(ToolInputError)
  })
})