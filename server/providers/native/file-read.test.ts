// server/providers/native/file-read.test.ts
import {
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
  type FileHandle,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_READ_MAX_BYTES,
  MODEL_READ_WINDOW_MAX_BYTES,
  NativeFileChangedError,
  NativeFileEncodingError,
  NativeFileUnavailableError,
  NativeReadWindowTooLargeError,
  nativeMtimeFloor,
  readNativeTarget,
  readNativeTextWindow,
  resolveNativeReadTarget,
  sameNativeFileIdentity,
  withNativeFile,
  type NativeFileIdentity,
} from './file-read.js'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})

const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const signal = () => new AbortController().signal

let dir: string
beforeEach(async () => {
  vi.mocked(open).mockReset()
  vi.mocked(open).mockImplementation(actualFs.open)
  dir = await mkdtemp(join(tmpdir(), 'native-file-read-'))
})

afterEach(async () => {
  vi.mocked(open).mockReset()
  if (dir) await rm(dir, { recursive: true, force: true })
})

async function fixture(contents: string | Buffer = 'alpha', name = 'a.txt'): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, contents)
  return path
}

describe('resolveNativeReadTarget', () => {
  it('resolves relative, absolute, and cwd-internal symlink paths', async () => {
    const file = await fixture()
    await symlink(file, join(dir, 'link.txt'), 'file')

    const relative = await resolveNativeReadTarget(dir, 'a.txt')
    const absolute = await resolveNativeReadTarget(dir, file)
    const linked = await resolveNativeReadTarget(dir, 'link.txt')

    expect(relative.absolutePath).toBe(file)
    expect(absolute.realPath).toBe(await realpath(file))
    expect(linked.realPath).toBe(await realpath(file))
    expect(linked.identity).toEqual(relative.identity)
  })

  it('resolves a child file when cwd is the filesystem root', async () => {
    const root = parse(dir).root
    const file = await fixture('root child', 'root-cwd.txt')

    const target = await resolveNativeReadTarget(root, file)

    expect(target.absolutePath).toBe(file)
    expect(target.realPath).toBe(await realpath(file))
  })

  it('rejects lexical escapes, absolute escapes, directories, and missing paths', async () => {
    const outside = join(dir, 'outside.txt')
    const cwd = join(dir, 'cwd')
    await mkdir(cwd)
    await writeFile(outside, 'outside')
    await mkdir(join(cwd, 'directory'))

    for (const path of ['../outside.txt', outside, 'directory', 'missing.txt']) {
      await expect(resolveNativeReadTarget(cwd, path)).rejects.toThrow(NativeFileUnavailableError)
    }
  })

  it('rejects an internal junction whose real target escapes the cwd', async () => {
    const cwd = join(dir, 'cwd')
    const outside = join(dir, 'outside')
    await mkdir(cwd)
    await mkdir(outside)
    await writeFile(join(outside, 'secret.txt'), 'outside')
    await symlink(outside, join(cwd, 'escape'), 'junction')

    await expect(resolveNativeReadTarget(cwd, join('escape', 'secret.txt')))
      .rejects.toThrow(NativeFileUnavailableError)
  })
})

describe('resolveNativeReadTarget extra roots', () => {
  async function layout() {
    const cwd = join(dir, 'cwd')
    const memory = join(dir, 'memory')
    const outside = join(dir, 'outside')
    await mkdir(cwd)
    await mkdir(memory)
    await mkdir(outside)
    return { cwd, memory, outside }
  }

  it('resolves a file inside an extra root outside the cwd', async () => {
    const { cwd, memory } = await layout()
    const file = join(memory, 'm.txt')
    await writeFile(file, 'memory')

    await expect(resolveNativeReadTarget(cwd, file)).rejects.toThrow(NativeFileUnavailableError)
    const target = await resolveNativeReadTarget(cwd, file, [memory])
    expect(target.absolutePath).toBe(file)
    expect(target.realPath).toBe(await realpath(file))
  })

  it('still rejects a target outside the cwd and every extra root', async () => {
    const { cwd, memory, outside } = await layout()
    const file = join(outside, 'secret.txt')
    await writeFile(file, 'secret')

    await expect(resolveNativeReadTarget(cwd, file, [memory])).rejects.toThrow(NativeFileUnavailableError)
  })

  it('matches any of several extra roots', async () => {
    const { cwd, memory } = await layout()
    const second = join(dir, 'memory2')
    await mkdir(second)
    const file = join(second, 'm.txt')
    await writeFile(file, 'second')

    const target = await resolveNativeReadTarget(cwd, file, [memory, second])
    expect(target.realPath).toBe(await realpath(file))
  })

  it('rejects a junction inside an extra root whose real target escapes', async () => {
    const { cwd, memory, outside } = await layout()
    await writeFile(join(outside, 'secret.txt'), 'secret')
    await symlink(outside, join(memory, 'escape'), 'junction')

    await expect(resolveNativeReadTarget(cwd, join(memory, 'escape', 'secret.txt'), [memory]))
      .rejects.toThrow(NativeFileUnavailableError)
  })

  it('realpaths a symlinked extra root so a legitimate link target resolves', async () => {
    const { cwd } = await layout()
    const realMemory = join(dir, 'real-memory')
    await mkdir(realMemory)
    const file = join(realMemory, 'm.txt')
    await writeFile(file, 'linked')
    const linkRoot = join(dir, 'link-memory')
    await symlink(realMemory, linkRoot, 'junction')

    const target = await resolveNativeReadTarget(cwd, join(linkRoot, 'm.txt'), [linkRoot])
    expect(target.realPath).toBe(await realpath(file))
  })

  it('keeps cwd-internal resolution unchanged when extra roots are present', async () => {
    const { cwd, memory } = await layout()
    const file = join(cwd, 'a.txt')
    await writeFile(file, 'internal')

    const target = await resolveNativeReadTarget(cwd, 'a.txt', [memory])
    expect(target.realPath).toBe(await realpath(file))
  })
})

describe('native file identity', () => {
  it('compares every identity field and floors nanosecond mtimes', async () => {
    const target = await resolveNativeReadTarget(dir, await fixture())
    const identity = target.identity
    expect(sameNativeFileIdentity(identity, { ...identity })).toBe(true)
    for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'] as const) {
      expect(sameNativeFileIdentity(identity, { ...identity, [key]: identity[key] + 1n })).toBe(false)
    }
    expect(nativeMtimeFloor({ ...identity, mtimeNs: 123_999_999n })).toBe(123)
  })
})

describe('readNativeTarget', () => {
  it('reads empty and exact-cap files completely and truncates at cap + 1', async () => {
    const empty = await resolveNativeReadTarget(dir, await fixture('', 'empty.txt'))
    const emptyRead = await readNativeTarget(empty, { signal: signal() })
    expect(emptyRead.result).toEqual({ available: true, contents: '', truncated: false, encoding: 'utf-8' })
    expect(emptyRead.observation).toBeDefined()

    const exact = await resolveNativeReadTarget(dir, await fixture('1234', 'exact.txt'))
    const exactRead = await readNativeTarget(exact, { maxBytes: 4, signal: signal() })
    expect(exactRead.result).toEqual({ available: true, contents: '1234', truncated: false, encoding: 'utf-8' })
    expect(exactRead.observation).toBeDefined()

    const over = await resolveNativeReadTarget(dir, await fixture('12345', 'over.txt'))
    const overRead = await readNativeTarget(over, { maxBytes: 4, signal: signal() })
    expect(overRead.result).toEqual({ available: true, contents: '1234', truncated: true, encoding: 'utf-8' })
    expect(overRead.observation).toBeUndefined()
  })

  it('uses the 1 MiB default cap without buffering the whole file', async () => {
    const file = await fixture(Buffer.alloc(DEFAULT_READ_MAX_BYTES + 1, 0x61), 'default.txt')
    const target = await resolveNativeReadTarget(dir, file)
    const { result, observation } = await readNativeTarget(target, { signal: signal() })

    expect(result.contents).toHaveLength(DEFAULT_READ_MAX_BYTES)
    expect(result.truncated).toBe(true)
    expect(observation).toBeUndefined()
  })

  it('keeps only complete UTF-8 codepoints in a truncated prefix', async () => {
    const target = await resolveNativeReadTarget(dir, await fixture('A€B', 'unicode.txt'))
    const { result } = await readNativeTarget(target, { maxBytes: 2, signal: signal() })
    expect(result.contents).toBe('A')
    expect(result.truncated).toBe(true)
  })

  it('rejects invalid UTF-8 and NUL but preserves binary bytes as base64', async () => {
    const invalid = await resolveNativeReadTarget(dir, await fixture(Buffer.from([0xff]), 'invalid.bin'))
    await expect(readNativeTarget(invalid, { signal: signal() })).rejects.toThrow(NativeFileEncodingError)

    const nul = await resolveNativeReadTarget(dir, await fixture(Buffer.from([0x61, 0, 0x62]), 'nul.bin'))
    await expect(readNativeTarget(nul, { signal: signal() })).rejects.toThrow(NativeFileEncodingError)

    const binary = await resolveNativeReadTarget(dir, await fixture(Buffer.from([0, 0xff]), 'binary.bin'))
    const { result, observation } = await readNativeTarget(binary, { encoding: 'base64', signal: signal() })
    expect(result).toEqual({ available: true, contents: 'AP8=', truncated: false, encoding: 'base64' })
    expect(observation).toBeDefined()
  })

  it('rejects invalid maxBytes values before opening a stream', async () => {
    const target = await resolveNativeReadTarget(dir, await fixture())
    const invalid = [1.5, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]
    for (const maxBytes of invalid) {
      await expect(readNativeTarget(target, { maxBytes, signal: signal() })).rejects.toThrow(TypeError)
    }
    expect(open).not.toHaveBeenCalled()
  })

  it('honors an already-aborted signal before open', async () => {
    const target = await resolveNativeReadTarget(dir, await fixture())
    const controller = new AbortController()
    controller.abort()
    await expect(readNativeTarget(target, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(open).not.toHaveBeenCalled()
  })
})

describe('withNativeFile identity checks', () => {
  it('rejects an in-place mutation made by the callback', async () => {
    const file = await fixture('before')
    const target = await resolveNativeReadTarget(dir, file)
    await expect(withNativeFile(target, signal(), async () => {
      await writeFile(file, 'after and longer')
    })).rejects.toThrow(NativeFileChangedError)
  })

  it('rejects a replacement made after resolution but before open', async () => {
    const file = await fixture('A')
    await fixture('B', 'b.txt')
    const target = await resolveNativeReadTarget(dir, file)
    await rename(file, join(dir, 'original.txt'))
    await rename(join(dir, 'b.txt'), file)

    await expect(withNativeFile(target, signal(), async () => 'unreachable'))
      .rejects.toThrow(NativeFileChangedError)
  })

  it('rejects a path replacement after a successful handle read', async () => {
    const file = await fixture('A')
    await fixture('B', 'b.txt')
    const target = await resolveNativeReadTarget(dir, file)

    await expect(withNativeFile(target, signal(), async (handle) => {
      expect(await handle.readFile('utf-8')).toBe('A')
      await rename(file, join(dir, 'original.txt'))
      await rename(join(dir, 'b.txt'), file)
    })).rejects.toThrow(NativeFileChangedError)
  })

  it('rejects an opened B handle even when the path is restored to A', async () => {
    const file = await fixture('A')
    const other = await fixture('B', 'b.txt')
    const saved = join(dir, 'saved.txt')
    const original = join(dir, 'original.txt')
    const consumed = join(dir, 'consumed.txt')
    await copyFile(file, saved)
    const target = await resolveNativeReadTarget(dir, file)

    vi.mocked(open).mockImplementationOnce(async (path, flags) => {
      await rename(file, original)
      await rename(other, file)
      const handle = await actualFs.open(path, flags)
      await rename(file, consumed)
      await rename(original, file)
      return handle
    })

    await expect(withNativeFile(target, signal(), async () => 'unreachable'))
      .rejects.toThrow(NativeFileChangedError)
    expect(await readFile(file, 'utf-8')).toBe('A')
    expect(await readFile(saved, 'utf-8')).toBe('A')
  })

  it('rejects a same-size replacement with the original mtime', async () => {
    const file = await fixture('AA')
    const other = await fixture('BB', 'b.txt')
    const when = new Date('2020-01-01T00:00:00.000Z')
    await utimes(file, when, when)
    await utimes(other, when, when)
    const target = await resolveNativeReadTarget(dir, file)
    await rename(file, join(dir, 'original.txt'))
    await rename(other, file)
    const replacement = await stat(file, { bigint: true })
    expect(replacement.mtimeNs).toBe(target.identity.mtimeNs)
    expect(replacement.size).toBe(target.identity.size)

    await expect(withNativeFile(target, signal(), async () => 'unreachable'))
      .rejects.toThrow(NativeFileChangedError)
  })
})

describe('read cleanup and cancellation', () => {
  function controlledHandle(identity: NativeFileIdentity, stream: Readable, close = vi.fn(async () => {})): FileHandle {
    const stats = {
      ...identity,
      isFile: () => true,
    }
    return {
      stat: vi.fn(async () => stats),
      createReadStream: vi.fn(() => stream),
      close,
    } as unknown as FileHandle
  }

  it('stops after an aborted first chunk and closes the stream and handle', async () => {
    const target = await resolveNativeReadTarget(dir, await fixture('ab'))
    const controller = new AbortController()
    let pulls = 0
    let finalized = false
    const stream = new Readable({ read() {} })
    stream[Symbol.asyncIterator] = () => ({
      next: async () => {
        pulls += 1
        if (pulls > 1) return { done: true, value: undefined }
        controller.abort()
        return { done: false, value: Buffer.from('a') }
      },
      return: async () => {
        finalized = true
        return { done: true, value: undefined }
      },
      [Symbol.asyncIterator]() { return this },
    })
    const close = vi.fn(async () => {})
    const handle = controlledHandle(target.identity, stream, close)
    vi.mocked(open).mockImplementationOnce(async () => handle)

    await expect(readNativeTarget(target, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(pulls).toBe(1)
    expect(finalized).toBe(true)
    expect(stream.destroyed).toBe(true)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('closes the stream and handle when fatal decoding fails', async () => {
    const target = await resolveNativeReadTarget(dir, await fixture('x'))
    let finalized = false
    const stream = Readable.from((async function* () {
      try {
        yield Buffer.from([0xff])
      } finally {
        finalized = true
      }
    })())
    const close = vi.fn(async () => {})
    const handle = controlledHandle(target.identity, stream, close)
    vi.mocked(open).mockImplementationOnce(async () => handle)

    await expect(readNativeTarget(target, { signal: signal() })).rejects.toThrow(NativeFileEncodingError)
    expect(finalized).toBe(true)
    expect(stream.destroyed).toBe(true)
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('readNativeTextWindow', () => {
  it('stops near a small requested window in a multi-MiB file', async () => {
    const file = await fixture(`first\nsecond\n${'x'.repeat(3 * 1024 * 1024)}`, 'large.txt')
    const target = await resolveNativeReadTarget(dir, file)
    const window = await readNativeTextWindow(target, { limit: 2, signal: signal() })

    expect(window.text).toBe('first\nsecond')
    expect(window.startLine).toBe(1)
    expect(window.endLine).toBe(2)
    expect(window.endByteOffset).toBe(13)
    expect(window.scannedByteCount).toBeLessThan(128 * 1024)
    expect(window.scannedByteCount).toBeLessThan(Number(target.identity.size / 10n))
    expect(window.reachedEof).toBe(false)
  })

  it('scans only the continuation when startByteOffset is supplied', async () => {
    const prefix = 'x'.repeat(200_000) + '\n'
    const file = await fixture(`${prefix}first\nsecond\nthird`, 'continuation.txt')
    const target = await resolveNativeReadTarget(dir, file)
    const window = await readNativeTextWindow(target, {
      offset: 2,
      limit: 1,
      startByteOffset: Buffer.byteLength(prefix),
      signal: signal(),
    })

    expect(window.text).toBe('first')
    expect(window.startLine).toBe(2)
    expect(window.endLine).toBe(2)
    expect(window.endByteOffset).toBe(Buffer.byteLength(prefix) + 6)
    expect(window.scannedByteCount).toBeLessThan(1024)
    expect(window.scannedByteCount).toBeLessThan(window.endByteOffset)
  })

  it('rejects invalid UTF-8, NUL, and a requested window over 1 MiB', async () => {
    const invalid = await resolveNativeReadTarget(dir, await fixture(Buffer.from([0xff]), 'model-invalid.bin'))
    await expect(readNativeTextWindow(invalid, { signal: signal() })).rejects.toThrow(NativeFileEncodingError)

    const nul = await resolveNativeReadTarget(dir, await fixture(Buffer.from([0x61, 0]), 'model-nul.bin'))
    await expect(readNativeTextWindow(nul, { signal: signal() })).rejects.toThrow(NativeFileEncodingError)

    const large = Buffer.alloc(MODEL_READ_WINDOW_MAX_BYTES + 1, 0x61)
    const oversized = await resolveNativeReadTarget(dir, await fixture(large, 'model-oversized.txt'))
    await expect(readNativeTextWindow(oversized, { limit: 1, signal: signal() }))
      .rejects.toThrow(NativeReadWindowTooLargeError)
  })

  it('returns line 2001 through an exact byte-offset continuation', async () => {
    const contents = Array.from({ length: 2001 }, (_, index) => String(index + 1)).join('\n')
    const file = await fixture(contents, '2001-lines.txt')
    const target = await resolveNativeReadTarget(dir, file)
    const first = await readNativeTextWindow(target, { signal: signal() })
    const second = await readNativeTextWindow(target, {
      offset: 2001,
      startByteOffset: first.endByteOffset,
      signal: signal(),
    })

    expect(first.startLine).toBe(1)
    expect(first.endLine).toBe(2000)
    expect(first.reachedEof).toBe(false)
    expect(second.text).toBe('2001')
    expect(second.startLine).toBe(2001)
    expect(second.endLine).toBe(2001)
    expect(second.endByteOffset).toBe(Buffer.byteLength(contents))
    expect(second.scannedByteCount).toBe(4)
    expect(second.reachedEof).toBe(true)
    expect(sameNativeFileIdentity(first.observation.identity, second.observation.identity)).toBe(true)
  })
})

describe('read boundary regressions', () => {
  it('counts a trailing empty line separator toward the model window cap', async () => {
    const contents = 'x'.repeat(MODEL_READ_WINDOW_MAX_BYTES) + '\n'
    const target = await resolveNativeReadTarget(dir, await fixture(contents, 'cap-trailing-newline.txt'))

    await expect(readNativeTextWindow(target, { signal: signal() }))
      .rejects.toThrow(NativeReadWindowTooLargeError)
  })

  it('counts empty-line separators toward the model window cap', async () => {
    const contents = 'x'.repeat(MODEL_READ_WINDOW_MAX_BYTES) + '\n\n'
    const target = await resolveNativeReadTarget(dir, await fixture(contents, 'cap-empty-lines.txt'))

    await expect(readNativeTextWindow(target, { signal: signal() }))
      .rejects.toThrow(NativeReadWindowTooLargeError)
  })

  it('preserves a leading BOM on a complete host read', async () => {
    const bom = String.fromCharCode(0xfeff)
    const target = await resolveNativeReadTarget(dir, await fixture(`${bom}alpha`, 'host-bom.txt'))
    const { result, observation } = await readNativeTarget(target, { signal: signal() })

    expect(result.contents).toBe(`${bom}alpha`)
    expect(result.truncated).toBe(false)
    expect(observation).toBeDefined()
  })

  it('preserves BOM characters at the start of every projected line', async () => {
    const bom = String.fromCharCode(0xfeff)
    const contents = `${bom}first\n${bom}second\n${bom}`
    const target = await resolveNativeReadTarget(dir, await fixture(contents, 'model-bom.txt'))
    const window = await readNativeTextWindow(target, { signal: signal() })

    expect(window.text).toBe(contents)
    expect(window.endLine).toBe(3)
    expect(window.reachedEof).toBe(true)
  })
})
