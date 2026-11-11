// server/providers/native/tools/grep.test.ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ToolInputError } from './types.js'
import { grepTool } from './grep.js'

let dir: string
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })
const ctx = (cwd: string, signal = new AbortController().signal) => ({ cwd, signal })

describe('grepTool', () => {
  it('finds matches with line numbers', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-grep-'))
    await writeFile(join(dir, 'a.ts'), 'const one = 1\nconst two = 2\n')
    const res = await grepTool.run({ pattern: 'two' }, ctx(dir))
    expect(res.text).toBe('a.ts:2: const two = 2')
  })

  it('respects include as a basename glob', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-grep-'))
    await writeFile(join(dir, 'a.ts'), 'target\n')
    await writeFile(join(dir, 'b.md'), 'target\n')
    const res = await grepTool.run({ pattern: 'target', include: '*.md' }, ctx(dir))
    expect(res.text).toBe('b.md:1: target')
  })

  it('skips node_modules', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-grep-'))
    await mkdir(join(dir, 'node_modules'), { recursive: true })
    await writeFile(join(dir, 'node_modules', 'x.js'), 'target\n')
    await writeFile(join(dir, 'a.js'), 'target\n')
    const res = await grepTool.run({ pattern: 'target' }, ctx(dir))
    expect(res.text).toBe('a.js:1: target')
  })

  it('reports no matches without error', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-grep-'))
    await writeFile(join(dir, 'a.txt'), 'nothing here\n')
    const res = await grepTool.run({ pattern: 'zzz' }, ctx(dir))
    expect(res.text).toBe('no matches')
  })

  it('throws ToolInputError on an invalid regex', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-grep-'))
    await expect(grepTool.run({ pattern: '(' }, ctx(dir))).rejects.toThrow(ToolInputError)
  })

  it('stops the walk when the turn signal aborts', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-grep-'))
    await writeFile(join(dir, 'a.ts'), 'target\n')
    const controller = new AbortController()
    controller.abort()

    await expect(grepTool.run({ pattern: 'target' }, ctx(dir, controller.signal))).rejects.toThrow(/abort/i)
  })
})
