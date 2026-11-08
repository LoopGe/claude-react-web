// server/providers/native/tools/write-edit.test.ts
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { editTool } from './edit.js'
import { writeTool } from './write.js'

let dir: string
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })
const ctx = (cwd: string) => ({ cwd, signal: new AbortController().signal })

describe('writeTool', () => {
  it('creates a file including parent directories', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-write-'))
    await writeTool.run({ file_path: 'sub/a.txt', content: 'hello' }, ctx(dir))
    expect(await readFile(join(dir, 'sub/a.txt'), 'utf-8')).toBe('hello')
  })

  it('replaces an existing file', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-write-'))
    await writeFile(join(dir, 'a.txt'), 'old')
    await writeTool.run({ file_path: 'a.txt', content: 'new' }, ctx(dir))
    expect(await readFile(join(dir, 'a.txt'), 'utf-8')).toBe('new')
  })
})

describe('editTool', () => {
  it('replaces a unique match', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-edit-'))
    await writeFile(join(dir, 'a.txt'), 'foo bar foo')
    await editTool.run({ file_path: 'a.txt', old_string: ' bar ', new_string: ' baz ' }, ctx(dir))
    expect(await readFile(join(dir, 'a.txt'), 'utf-8')).toBe('foo baz foo')
  })

  it('throws when old_string appears more than once without replace_all', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-edit-'))
    await writeFile(join(dir, 'a.txt'), 'foo foo')
    await expect(editTool.run({ file_path: 'a.txt', old_string: 'foo', new_string: 'x' }, ctx(dir)))
      .rejects.toThrow('appears 2 times')
  })

  it('replace_all replaces every match', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-edit-'))
    await writeFile(join(dir, 'a.txt'), 'foo foo')
    await editTool.run({ file_path: 'a.txt', old_string: 'foo', new_string: 'x', replace_all: true }, ctx(dir))
    expect(await readFile(join(dir, 'a.txt'), 'utf-8')).toBe('x x')
  })

  it('empty new_string deletes the match', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-edit-'))
    await writeFile(join(dir, 'a.txt'), 'abXcd')
    await editTool.run({ file_path: 'a.txt', old_string: 'X', new_string: '' }, ctx(dir))
    expect(await readFile(join(dir, 'a.txt'), 'utf-8')).toBe('abcd')
  })

  it('throws when old_string is absent', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-edit-'))
    await writeFile(join(dir, 'a.txt'), 'abc')
    await expect(editTool.run({ file_path: 'a.txt', old_string: 'zzz', new_string: 'x' }, ctx(dir)))
      .rejects.toThrow('not found')
  })
})
