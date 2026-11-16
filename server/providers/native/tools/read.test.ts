// server/providers/native/tools/read.test.ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ToolInputError } from './types.js'
import { MODEL_READ_WINDOW_MAX_BYTES } from '../file-read.js'
import { createReadTool } from './read.js'
import { NativeReadState } from '../read-state.js'

let dir: string
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })

const ctx = (cwd: string) => ({ cwd, signal: new AbortController().signal })
let state: NativeReadState
let readTool: ReturnType<typeof createReadTool>
beforeEach(() => {
  state = new NativeReadState()
  readTool = createReadTool(state)
})

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

  it('preserves trailing-newline and empty-file line numbering', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-read-'))
    await writeFile(join(dir, 'trailing.txt'), 'one\ntwo\n')
    await writeFile(join(dir, 'empty.txt'), '')

    const trailing = await readTool.run({ file_path: 'trailing.txt' }, ctx(dir))
    const empty = await readTool.run({ file_path: 'empty.txt' }, ctx(dir))
    expect(trailing.text).toBe('     1\tone\n     2\ttwo\n     3\t')
    expect(empty.text).toBe('     1\t')
  })

  it('normalizes fractional offset and limit like the existing tool', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-read-'))
    await writeFile(join(dir, 'a.txt'), '1\n2\n3\n4\n')
    const res = await readTool.run({ file_path: 'a.txt', offset: 2.9, limit: 2.9 }, ctx(dir))
    expect(res.text).toBe('     2\t2\n     3\t3')
  })

  it('rejects invalid UTF-8 and NUL without partial output', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-read-'))
    await writeFile(join(dir, 'invalid.txt'), Buffer.from([0x61, 0xff, 0x62]))
    await writeFile(join(dir, 'nul.txt'), Buffer.from([0x61, 0, 0x62]))

    await expect(readTool.run({ file_path: 'invalid.txt' }, ctx(dir))).rejects.toThrow(ToolInputError)
    await expect(readTool.run({ file_path: 'nul.txt' }, ctx(dir))).rejects.toThrow(ToolInputError)
  })

  it('rejects a requested raw window over 1 MiB', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-read-'))
    await writeFile(join(dir, 'large.txt'), Buffer.alloc(MODEL_READ_WINDOW_MAX_BYTES + 1, 0x61))
    await expect(readTool.run({ file_path: 'large.txt', limit: 1 }, ctx(dir))).rejects.toThrow(ToolInputError)
  })

  it('returns line 2001 with its original line number', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-read-'))
    await writeFile(join(dir, 'a.txt'), Array.from({ length: 2001 }, (_, index) => String(index + 1)).join('\n'))
    const res = await readTool.run({ file_path: 'a.txt', offset: 2001 }, ctx(dir))
    expect(res.text).toBe('  2001\t2001')
  })

  it('resumes an exact continuation and seeds after the second complete window', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-read-'))
    await writeFile(join(dir, 'a.txt'), Array.from({ length: 2001 }, (_, index) => String(index + 1)).join('\n'))

    await readTool.run({ file_path: 'a.txt' }, ctx(dir))
    await expect(state.assertEditable(dir, 'a.txt')).rejects.toThrow(/read/i)
    const res = await readTool.run({ file_path: 'a.txt', offset: 2001 }, ctx(dir))

    expect(res.text).toBe('  2001\t2001')
    await expect(state.assertEditable(dir, 'a.txt')).resolves.toBeDefined()
  })
})
