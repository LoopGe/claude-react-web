// server/providers/native/tools/write-edit.test.ts
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEditTool } from './edit.js'
import { createReadTool } from './read.js'
import { writeTool } from './write.js'
import { NativeReadState } from '../read-state.js'
import * as fileRead from '../file-read.js'
import { MAX_EDIT_BYTES, readNativeTarget, resolveNativeReadTarget } from '../file-read.js'

vi.mock('../file-read.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../file-read.js')>()
  return { ...actual, withNativeFile: vi.fn(actual.withNativeFile) }
})

const withNativeFileMock = vi.mocked(fileRead.withNativeFile)
const realWithNativeFile = withNativeFileMock.getMockImplementation()!

let dir: string
let state: NativeReadState
let readTool: ReturnType<typeof createReadTool>
let editTool: ReturnType<typeof createEditTool>

afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })
beforeEach(() => {
  withNativeFileMock.mockClear()
  state = new NativeReadState()
  readTool = createReadTool(state)
  editTool = createEditTool(state)
})

const ctx = (cwd: string) => ({ cwd, signal: new AbortController().signal })
const memCtx = (cwd: string, roots: { write?: string[]; read?: string[] }) => ({
  cwd,
  signal: new AbortController().signal,
  memoryRoots: { write: roots.write ?? [], read: roots.read ?? [] },
})
const input = (old_string: string, new_string: string, replace_all?: boolean) => ({
  file_path: 'a.txt', old_string, new_string, ...(replace_all === undefined ? {} : { replace_all }),
})

async function modelRead(path = 'a.txt') {
  await readTool.run({ file_path: path }, ctx(dir))
}

async function hostSeed(path: string) {
  const target = await resolveNativeReadTarget(dir, path)
  const { result, observation } = await readNativeTarget(target, {
    maxBytes: (await stat(target.realPath)).size,
    encoding: 'base64',
    signal: new AbortController().signal,
  })
  expect(result.truncated).toBe(false)
  state.observeHost(observation!)
  await state.seedReadState(dir, path, Math.floor((await stat(join(dir, path))).mtimeMs))
}

function controlNextHandle(wrap: (handle: FileHandle) => FileHandle) {
  withNativeFileMock.mockImplementationOnce((async (target, signal, fn, opts) =>
    realWithNativeFile(target, signal, async (handle) => fn(wrap(handle)), opts)
  ) as typeof fileRead.withNativeFile)
}

function wrappedHandle(handle: FileHandle, overrides: Partial<Record<keyof FileHandle, unknown>>): FileHandle {
  return new Proxy(handle, {
    get(target, property) {
      if (property in overrides) return overrides[property as keyof FileHandle]
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

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
  it('replaces a unique match after a complete read', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-edit-'))
    await writeFile(join(dir, 'a.txt'), 'foo bar foo')
    await modelRead()
    await editTool.run(input(' bar ', ' baz '), ctx(dir))
    expect(await readFile(join(dir, 'a.txt'), 'utf-8')).toBe('foo baz foo')
  })

  it('rejects without a current read', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-edit-'))
    await writeFile(join(dir, 'a.txt'), 'foo')
    await expect(editTool.run(input('foo', 'bar'), ctx(dir))).rejects.toThrow(/read/i)
    expect(await readFile(join(dir, 'a.txt'), 'utf-8')).toBe('foo')
  })

  it('rejects a stale version until a fresh complete read', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-edit-'))
    await writeFile(join(dir, 'a.txt'), 'foo')
    await modelRead()
    await writeFile(join(dir, 'a.txt'), 'external')
    await expect(editTool.run(input('external', 'changed'), ctx(dir))).rejects.toThrow(/changed|read/i)
    expect(await readFile(join(dir, 'a.txt'), 'utf-8')).toBe('external')

    await modelRead()
    await editTool.run(input('external', 'changed'), ctx(dir))
    expect(await readFile(join(dir, 'a.txt'), 'utf-8')).toBe('changed')
  })

  it('rejects invalid UTF-8 and NUL file content without changing bytes', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-edit-'))
    for (const [name, bytes] of [
      ['invalid.txt', Buffer.from([0x61, 0xff, 0x62])],
      ['nul.txt', Buffer.from([0x61, 0, 0x62])],
    ] as const) {
      await writeFile(join(dir, name), bytes)
      await hostSeed(name)
      await expect(editTool.run({ ...input('a', 'x'), file_path: name }, ctx(dir))).rejects.toThrow(/UTF-8|NUL/i)
      expect(await readFile(join(dir, name))).toEqual(bytes)
    }
  })

  it('rejects NUL in new_string and an empty old_string', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-edit-'))
    await writeFile(join(dir, 'a.txt'), 'abc')
    await modelRead()
    await expect(editTool.run(input('b', 'x\0y'), ctx(dir))).rejects.toThrow(/NUL/i)
    await expect(editTool.run(input('', 'x'), ctx(dir))).rejects.toThrow(/old_string/i)
    expect(await readFile(join(dir, 'a.txt'), 'utf-8')).toBe('abc')
  })

  it('throws when old_string appears more than once without replace_all', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-edit-'))
    await writeFile(join(dir, 'a.txt'), 'foo foo')
    await modelRead()
    await expect(editTool.run(input('foo', 'x'), ctx(dir))).rejects.toThrow('appears 2 times')
  })

  it('replace_all replaces every match', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-edit-'))
    await writeFile(join(dir, 'a.txt'), 'foo foo')
    await modelRead()
    await editTool.run(input('foo', 'x', true), ctx(dir))
    expect(await readFile(join(dir, 'a.txt'), 'utf-8')).toBe('x x')
  })

  it('empty new_string deletes the match', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-edit-'))
    await writeFile(join(dir, 'a.txt'), 'abXcd')
    await modelRead()
    await editTool.run(input('X', ''), ctx(dir))
    expect(await readFile(join(dir, 'a.txt'), 'utf-8')).toBe('abcd')
  })

  it('throws when old_string is absent', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-edit-'))
    await writeFile(join(dir, 'a.txt'), 'abc')
    await modelRead()
    await expect(editTool.run(input('zzz', 'x'), ctx(dir))).rejects.toThrow('not found')
  })

  it('inserts replacement-pattern characters literally', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-edit-'))
    await writeFile(join(dir, 'a.txt'), 'foo')
    await modelRead()
    await editTool.run(input('foo', '$&$&'), ctx(dir))
    expect(await readFile(join(dir, 'a.txt'), 'utf-8')).toBe('$&$&')
  })

  it('rejects an original over 8 MiB after reading only the edit cap', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-edit-'))
    const bytes = Buffer.alloc(MAX_EDIT_BYTES + 1024 * 1024, 0x61)
    await writeFile(join(dir, 'a.txt'), bytes)
    await hostSeed('a.txt')
    let streamed = 0
    controlNextHandle((handle) => wrappedHandle(handle, {
      createReadStream: (options: Parameters<FileHandle['createReadStream']>[0]) => {
        const stream = handle.createReadStream(options)
        stream.on('data', (chunk: string | Buffer) => {
          streamed += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
        })
        return stream
      },
    }))

    await expect(editTool.run(input('aaa', 'b'), ctx(dir))).rejects.toThrow(/8 MiB/i)
    expect(streamed).toBeLessThan(bytes.length)
    expect(streamed).toBeLessThanOrEqual(MAX_EDIT_BYTES + 64 * 1024)
    expect((await stat(join(dir, 'a.txt'))).size).toBe(bytes.length)
  }, 20000)

  it('precomputes replace_all overflow using UTF-8 bytes before writing', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-edit-'))
    const original = 'a'.repeat(MAX_EDIT_BYTES)
    const originalBytes = Buffer.from(original, 'utf8')
    expect(originalBytes).toHaveLength(MAX_EDIT_BYTES)
    await writeFile(join(dir, 'a.txt'), originalBytes)
    await hostSeed('a.txt')

    await expect(editTool.run(input('a', 'é', true), ctx(dir))).rejects.toThrow(/8 MiB/i)
    expect((await readFile(join(dir, 'a.txt'))).equals(originalBytes)).toBe(true)
  }, 20000)

  it('rejects replace_all expansion over 8 MiB before allocation', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-edit-'))
    const original = 'x'.repeat(1024)
    await writeFile(join(dir, 'a.txt'), original)
    await modelRead()

    await expect(editTool.run(input('x', 'y'.repeat(9000), true), ctx(dir))).rejects.toThrow(/8 MiB/i)
    expect(await readFile(join(dir, 'a.txt'), 'utf-8')).toBe(original)
  })

  it.each([
    { name: 'shortening', replacement: '' },
    { name: 'expansion', replacement: 'a much longer replacement' },
  ])('truncates and verifies $name edits from position zero', async ({ replacement }) => {
    dir = await mkdtemp(join(tmpdir(), 'native-edit-'))
    await writeFile(join(dir, 'a.txt'), 'prefix-MIDDLE-suffix')
    await modelRead()
    await editTool.run(input('MIDDLE', replacement), ctx(dir))
    const expected = `prefix-${replacement}-suffix`
    expect(await readFile(join(dir, 'a.txt'), 'utf-8')).toBe(expected)

    await editTool.run(input('prefix-', 'PREFIX-'), ctx(dir))
    expect(await readFile(join(dir, 'a.txt'), 'utf-8')).toBe(`PREFIX-${replacement}-suffix`)
  })

  it('rejects a same-handle change after its internal read without overwriting it', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-edit-'))
    await writeFile(join(dir, 'a.txt'), 'before')
    await modelRead()
    let changed = false
    controlNextHandle((handle) => wrappedHandle(handle, {
      stat: async (options?: { bigint?: boolean }) => {
        if (!changed) {
          changed = true
          await writeFile(join(dir, 'a.txt'), 'external')
        }
        return handle.stat(options)
      },
    }))

    await expect(editTool.run(input('before', 'edited'), ctx(dir))).rejects.toThrow(/changed/i)
    expect(changed).toBe(true)
    expect(await readFile(join(dir, 'a.txt'), 'utf-8')).toBe('external')
    await expect(state.assertEditable(dir, 'a.txt')).rejects.toThrow(/read|changed/i)
  })

  it('does not seed changed readback bytes', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-edit-'))
    await writeFile(join(dir, 'a.txt'), 'before')
    await modelRead()
    let truncated = false
    controlNextHandle((handle) => wrappedHandle(handle, {
      truncate: async (len?: number) => {
        truncated = true
        return handle.truncate(len)
      },
      read: async (buffer: Buffer, offset: number, length: number, position: number) => {
        const result = await handle.read(buffer, offset, length, position)
        if (truncated && position === 0 && result.bytesRead > 0) buffer[offset] ^= 1
        return result
      },
    }))

    await expect(editTool.run(input('before', 'edited'), ctx(dir))).rejects.toThrow(/readback|changed|verify/i)
    expect(await readFile(join(dir, 'a.txt'), 'utf-8')).toBe('edited')
    await expect(state.assertEditable(dir, 'a.txt')).rejects.toThrow(/read|changed/i)
  })

  it('does not seed when the file changes after the last expected readback byte', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-edit-'))
    await writeFile(join(dir, 'a.txt'), 'before')
    await modelRead()
    let truncated = false
    controlNextHandle((handle) => wrappedHandle(handle, {
      truncate: async (len?: number) => {
        truncated = true
        return handle.truncate(len)
      },
      read: async (buffer: Buffer, offset: number, length: number, position: number) => {
        const result = await handle.read(buffer, offset, length, position)
        if (truncated && position === 0 && result.bytesRead > 0) {
          await writeFile(join(dir, 'a.txt'), 'external')
        }
        return result
      },
    }))

    await expect(editTool.run(input('before', 'edited'), ctx(dir))).rejects.toThrow(/changed|readback|verify/i)
    expect(await readFile(join(dir, 'a.txt'), 'utf-8')).toBe('external')
    await expect(state.assertEditable(dir, 'a.txt')).rejects.toThrow(/read|changed/i)
  })

  it('caps readback of an externally extended file at nextByteLength plus one', async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-edit-'))
    await writeFile(join(dir, 'a.txt'), 'before')
    await modelRead()
    let requested = 0
    let truncated = false
    controlNextHandle((handle) => wrappedHandle(handle, {
      truncate: async (len?: number) => {
        await handle.truncate(len)
        await handle.write(Buffer.from('x'), 0, 1, 100)
        truncated = true
      },
      read: async (buffer: Buffer, offset: number, length: number, position: number) => {
        if (truncated) requested += length
        return handle.read(buffer, offset, length, position)
      },
    }))

    await expect(editTool.run(input('before', 'ok'), ctx(dir))).rejects.toThrow(/readback|changed|verify/i)
    expect(requested).toBeLessThanOrEqual(Buffer.byteLength('ok') + 1)
    await expect(state.assertEditable(dir, 'a.txt')).rejects.toThrow(/read|changed/i)
  })
})

describe('memory roots', () => {
  async function layout() {
    dir = await mkdtemp(join(tmpdir(), 'native-mem-'))
    const cwd = join(dir, 'cwd')
    const memory = join(dir, 'memory')
    const outside = join(dir, 'outside')
    await mkdir(cwd)
    await mkdir(memory)
    await mkdir(outside)
    return { cwd, memory, outside }
  }

  it('Write rejects an absolute path outside the cwd without roots', async () => {
    const { cwd, outside } = await layout()
    const file = join(outside, 'x.txt')
    await expect(writeTool.run({ file_path: file, content: 'x' }, ctx(cwd))).rejects.toThrow(/escapes/i)
  })

  it('Write creates a file inside a write root outside the cwd', async () => {
    const { cwd, memory } = await layout()
    const file = join(memory, 'm.txt')
    await writeTool.run({ file_path: file, content: 'hello' }, memCtx(cwd, { write: [memory] }))
    expect(await readFile(file, 'utf-8')).toBe('hello')
  })

  it('Write still rejects a target outside the cwd and every write root', async () => {
    const { cwd, memory, outside } = await layout()
    const file = join(outside, 'x.txt')
    await expect(writeTool.run({ file_path: file, content: 'x' }, memCtx(cwd, { write: [memory] })))
      .rejects.toThrow(/escapes/i)
  })

  it('Write is not authorized by a read-only root', async () => {
    const { cwd, memory } = await layout()
    const file = join(memory, 'm.txt')
    await expect(writeTool.run({ file_path: file, content: 'x' }, memCtx(cwd, { read: [memory] })))
      .rejects.toThrow(/escapes/i)
  })

  it('Read reads a file inside a read root outside the cwd', async () => {
    const { cwd, memory } = await layout()
    const file = join(memory, 'm.txt')
    await writeFile(file, 'memory line\n')
    const res = await readTool.run({ file_path: file }, memCtx(cwd, { read: [memory] }))
    expect(res.text).toContain('     1\tmemory line')
  })

  it('Read is not authorized by a write-only root', async () => {
    const { cwd, memory } = await layout()
    const file = join(memory, 'm.txt')
    await writeFile(file, 'memory')
    await expect(readTool.run({ file_path: file }, memCtx(cwd, { write: [memory] }))).rejects.toThrow(/escapes/i)
  })

  it('Edit edits a memory file after a complete read', async () => {
    const { cwd, memory } = await layout()
    const file = join(memory, 'm.txt')
    await writeFile(file, 'foo bar')
    const c = memCtx(cwd, { write: [memory], read: [memory] })
    await readTool.run({ file_path: file }, c)
    await editTool.run({ file_path: file, old_string: 'bar', new_string: 'baz' }, c)
    expect(await readFile(file, 'utf-8')).toBe('foo baz')
  })

  it('Edit still requires read evidence for a memory file', async () => {
    const { cwd, memory } = await layout()
    const file = join(memory, 'm.txt')
    await writeFile(file, 'foo')
    const c = memCtx(cwd, { write: [memory], read: [memory] })
    await expect(editTool.run({ file_path: file, old_string: 'foo', new_string: 'bar' }, c)).rejects.toThrow(/read/i)
    expect(await readFile(file, 'utf-8')).toBe('foo')
  })

  it('Edit is not authorized by a read-only root', async () => {
    const { cwd, memory } = await layout()
    const file = join(memory, 'm.txt')
    await writeFile(file, 'foo')
    await readTool.run({ file_path: file }, memCtx(cwd, { read: [memory] }))
    await expect(editTool.run({ file_path: file, old_string: 'foo', new_string: 'bar' }, memCtx(cwd, { read: [memory] })))
      .rejects.toThrow(/escapes/i)
    expect(await readFile(file, 'utf-8')).toBe('foo')
  })
})
