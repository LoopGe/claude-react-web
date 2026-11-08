// server/providers/native/tools/read.test.ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ToolInputError } from './types.js'
import { readTool } from './read.js'

let dir: string
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })

const ctx = (cwd: string) => ({ cwd, signal: new AbortController().signal })

describe('readTool', () => {
  it('returns line-numbered content', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-read-'))
    const file = join(dir, 'a.txt')
    await writeFile(file, 'one\ntwo\n')
    const res = await readTool.run({ file_path: 'a.txt' }, ctx(dir))
    expect(res.text).toContain('     1\tone')
    expect(res.text).toContain('     2\ttwo')
    expect(res.isError).toBeFalsy()
  })

  it('honors offset and limit', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-read-'))
    await writeFile(join(dir, 'a.txt'), '1\n2\n3\n4\n')
    const res = await readTool.run({ file_path: 'a.txt', offset: 2, limit: 2 }, ctx(dir))
    expect(res.text).not.toContain('1\t')
    expect(res.text).toContain('     2\t2')
    expect(res.text).toContain('     3\t3')
    expect(res.text).not.toContain('     4\t4')
  })

  it('rejects paths escaping the cwd', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-read-'))
    await expect(readTool.run({ file_path: '../outside.txt' }, ctx(dir))).rejects.toThrow(ToolInputError)
    await expect(readTool.run({ file_path: '/etc/hosts' }, ctx(dir))).rejects.toThrow(ToolInputError)
  })

  it('throws ToolInputError for a missing file', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-read-'))
    await expect(readTool.run({ file_path: 'nope.txt' }, ctx(dir))).rejects.toThrow(ToolInputError)
  })
})
