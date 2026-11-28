// server/providers/native/read-state.test.ts
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_EDIT_BYTES,
  readNativeTarget,
  readNativeTextWindow,
  resolveNativeReadTarget,
  type NativeReadObservation,
  type NativeTextWindow,
} from './file-read.js'
import { NativeReadState, memoryReadPathKey } from './read-state.js'

const dirs: string[] = []
const signal = () => new AbortController().signal

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function fixture(contents = 'one\ntwo\n') {
  const dir = await mkdtemp(join(tmpdir(), 'native-read-state-'))
  dirs.push(dir)
  const path = join(dir, 'a.txt')
  await writeFile(path, contents)
  return { dir, path }
}

async function hostObservation(path: string): Promise<NativeReadObservation> {
  const target = await resolveNativeReadTarget(join(path, '..'), path)
  const { result, observation } = await readNativeTarget(target, {
    encoding: 'base64', signal: signal(),
  })
  expect(result.truncated).toBe(false)
  expect(observation).toBeDefined()
  return observation!
}

async function seedHost(state: NativeReadState, dir: string, path: string) {
  state.observeHost(await hostObservation(path))
  await state.seedReadState(dir, path, Math.floor((await stat(path)).mtimeMs))
}

async function modelWindow(path: string, offset = 1, limit = 2000, startByteOffset?: number): Promise<NativeTextWindow> {
  const target = await resolveNativeReadTarget(join(path, '..'), path)
  return readNativeTextWindow(target, { offset, limit, startByteOffset, signal: signal() })
}

async function expectEditable(state: NativeReadState, dir: string, path: string) {
  await expect(state.assertEditable(dir, path)).resolves.toMatchObject({ realPath: await realpath(path) })
}

async function expectNotEditable(state: NativeReadState, dir: string, path: string) {
  await expect(state.assertEditable(dir, path)).rejects.toThrow(/read|changed/i)
}

describe('NativeReadState host observations', () => {
  it('seeds only a complete observation with matching manager mtime and current identity', async () => {
    const state = new NativeReadState()
    const { dir, path } = await fixture()

    await state.seedReadState(dir, path, Math.floor((await stat(path)).mtimeMs))
    await expectNotEditable(state, dir, path)

    state.observeHost(await hostObservation(path))
    await state.seedReadState(dir, path, Math.floor((await stat(path)).mtimeMs) - 1)
    await expectNotEditable(state, dir, path)

    await state.seedReadState(dir, path, Math.floor((await stat(path)).mtimeMs))
    await expectEditable(state, dir, path)
  })

  it('does not seed when the file changes between provider return and manager seed', async () => {
    const state = new NativeReadState()
    const { dir, path } = await fixture('before')
    state.observeHost(await hostObservation(path))

    await writeFile(path, 'after!')
    await state.seedReadState(dir, path, Math.floor((await stat(path)).mtimeMs))

    await expectNotEditable(state, dir, path)
  })

  it('rejects a same-size same-mtime replacement at seed time', async () => {
    const state = new NativeReadState()
    const { dir, path } = await fixture('before')
    state.observeHost(await hostObservation(path))
    const original = await stat(path)
    const replacement = join(dir, 'replacement.txt')
    await writeFile(replacement, 'after!')
    await utimes(replacement, original.atime, original.mtime)
    await rename(replacement, path)

    await state.seedReadState(dir, path, Math.floor(original.mtimeMs))

    await expectNotEditable(state, dir, path)
  })

  it('keeps an older still-current seed across truncated, partial, denied, invalid, and failed reads', async () => {
    const state = new NativeReadState()
    const { dir, path } = await fixture('one\ntwo\nthree\n')
    await seedHost(state, dir, path)

    const target = await resolveNativeReadTarget(dir, path)
    const truncated = await readNativeTarget(target, { maxBytes: 2, signal: signal() })
    expect(truncated.result.truncated).toBe(true)
    expect(truncated.observation).toBeUndefined()
    state.recordModelWindow(await modelWindow(path, 1, 1), false)
    await state.seedReadState(dir, 'denied.txt', 0)
    await writeFile(join(dir, 'invalid.txt'), Buffer.from([0xff]))
    await expect(readNativeTarget(await resolveNativeReadTarget(dir, 'invalid.txt'), { signal: signal() }))
      .rejects.toThrow(/UTF-8/i)
    await expect(resolveNativeReadTarget(dir, 'missing.txt')).rejects.toThrow(/unavailable/i)

    await expectEditable(state, dir, path)
  })

  it('invalidates a changed identity and authorizes a fresh complete read', async () => {
    const state = new NativeReadState()
    const { dir, path } = await fixture('before')
    await seedHost(state, dir, path)

    await writeFile(path, 'after')
    await expectNotEditable(state, dir, path)

    await seedHost(state, dir, path)
    await expectEditable(state, dir, path)
    expect(await readFile(path, 'utf8')).toBe('after')
  })
})

describe('NativeReadState model windows', () => {
  it('seeds one complete model window directly', async () => {
    const state = new NativeReadState()
    const { dir, path } = await fixture()

    state.recordModelWindow(await modelWindow(path), false)

    await expectEditable(state, dir, path)
  })

  it('seeds 2001 lines only after the exact continuation reaches EOF', async () => {
    const state = new NativeReadState()
    const { dir, path } = await fixture(Array.from({ length: 2001 }, (_, i) => `line-${i + 1}`).join('\n'))

    const first = await modelWindow(path)
    state.recordModelWindow(first, false)
    await expectNotEditable(state, dir, path)
    const target = await resolveNativeReadTarget(dir, path)
    const continuation = state.continuation(target, 2001)
    expect(continuation).toEqual({ byteOffset: first.endByteOffset })

    const second = await modelWindow(path, 2001, 2000, continuation!.byteOffset)
    state.recordModelWindow(second, true)
    await expectEditable(state, dir, path)
  })

  it.each([
    { name: 'skipped', firstLimit: 1000, secondOffset: 2001 },
    { name: 'overlapping', firstLimit: 2000, secondOffset: 2000 },
  ])('does not seed a $name candidate', async ({ firstLimit, secondOffset }) => {
    const state = new NativeReadState()
    const { dir, path } = await fixture(Array.from({ length: 2001 }, (_, i) => `line-${i + 1}`).join('\n'))

    state.recordModelWindow(await modelWindow(path, 1, firstLimit), false)
    state.recordModelWindow(await modelWindow(path, secondOffset), false)

    await expectNotEditable(state, dir, path)
  })

  it('does not seed an out-of-order candidate', async () => {
    const state = new NativeReadState()
    const { dir, path } = await fixture(Array.from({ length: 2001 }, (_, i) => `line-${i + 1}`).join('\n'))

    state.recordModelWindow(await modelWindow(path, 2001), false)
    state.recordModelWindow(await modelWindow(path, 1), false)

    await expectNotEditable(state, dir, path)
  })

  it('does not combine a candidate across file versions', async () => {
    const state = new NativeReadState()
    const initial = Array.from({ length: 2001 }, (_, i) => `line-${i + 1}`).join('\n')
    const { dir, path } = await fixture(initial)
    const first = await modelWindow(path)
    state.recordModelWindow(first, false)

    await writeFile(path, `${initial}\nchanged`)
    const target = await resolveNativeReadTarget(dir, path)
    expect(state.continuation(target, 2001)).toBeUndefined()
    state.recordModelWindow(await modelWindow(path, 2001), false)

    await expectNotEditable(state, dir, path)
  })

  it('never seeds a contiguous candidate over 8 MiB', async () => {
    const state = new NativeReadState()
    const line = 'x'.repeat(499)
    const { dir, path } = await fixture(Array.from({ length: 18_001 }, () => line).join('\n'))
    expect((await stat(path)).size).toBeGreaterThan(MAX_EDIT_BYTES)

    let offset = 1
    let byteOffset: number | undefined
    let continued = false
    for (;;) {
      const window = await modelWindow(path, offset, 2000, byteOffset)
      state.recordModelWindow(window, continued)
      if (window.reachedEof) break
      offset = window.endLine + 1
      byteOffset = state.continuation(await resolveNativeReadTarget(dir, path), offset)?.byteOffset
      expect(byteOffset).toBe(window.endByteOffset)
      continued = true
    }

    await expectNotEditable(state, dir, path)
  }, 20000)
})

describe('NativeReadState LRU', () => {
  it('evicts the oldest of 257 targets and requires another complete read', async () => {
    const state = new NativeReadState()
    const { dir } = await fixture()
    const paths: string[] = []
    for (let index = 0; index < 257; index += 1) {
      const path = join(dir, `${index}.txt`)
      await writeFile(path, `contents-${index}`)
      paths.push(path)
      await seedHost(state, dir, path)
    }

    await expectNotEditable(state, dir, paths[0])
    await expectEditable(state, dir, paths[1])
    await expectEditable(state, dir, paths[256])

    await seedHost(state, dir, paths[0])
    await expectEditable(state, dir, paths[0])
    await expectNotEditable(state, dir, paths[2])
  }, 20000)
})

// Recall exclusion consumes readPaths(): a memory file already read this session
// must not be re-injected even when the candidate is enumerated under a different
// alias (symlinked or case-variant root) than the path the model read.
describe('NativeReadState.readPaths (recall exclusion keys)', () => {
  it('emits both the realpath key and the lexical absolute path of each read', async () => {
    const state = new NativeReadState()
    const { dir, path } = await fixture()
    const target = await resolveNativeReadTarget(dir, path)
    state.observeHost(await hostObservation(path))
    const keys = state.readPaths()
    expect(keys.has(memoryReadPathKey(target.realPath))).toBe(true)
    expect(keys.has(memoryReadPathKey(target.absolutePath))).toBe(true)
  })

  it('a read through a symlinked alias contributes both the alias and realpath keys', async () => {
    const state = new NativeReadState()
    const base = await mkdtemp(join(tmpdir(), 'native-read-state-alias-'))
    dirs.push(base)
    const realDir = join(base, 'real')
    await mkdir(realDir)
    await writeFile(join(realDir, 'a.txt'), 'one\ntwo\n')
    const alias = join(base, 'alias')
    await symlink(realDir, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const aliasPath = join(alias, 'a.txt')
    const target = await resolveNativeReadTarget(alias, aliasPath)
    state.observeHost(await hostObservation(aliasPath))
    const keys = state.readPaths()
    // The lexical alias the read requested AND the resolved real path.
    expect(keys.has(memoryReadPathKey(target.absolutePath))).toBe(true)
    expect(keys.has(memoryReadPathKey(target.realPath))).toBe(true)
    expect(target.absolutePath).not.toBe(target.realPath)
  })
})

describe('NativeReadState repeat-read proof', () => {
  it('counts only a model-facing complete read, never a host seed', async () => {
    const state = new NativeReadState()
    const { dir, path } = await fixture()
    await seedHost(state, dir, path)
    const target = await resolveNativeReadTarget(dir, path)
    expect(state.unchangedSinceRead(target)).toBe(false)

    state.recordModelWindow(await modelWindow(path), false)
    expect(state.unchangedSinceRead(await resolveNativeReadTarget(dir, path))).toBe(true)

    // A later UI preview of the same bytes does not take that proof away.
    await seedHost(state, dir, path)
    expect(state.unchangedSinceRead(await resolveNativeReadTarget(dir, path))).toBe(true)

    await writeFile(path, 'one changed\n')
    expect(state.unchangedSinceRead(await resolveNativeReadTarget(dir, path))).toBe(false)
  })

  it('does not consume the proof Edit depends on', async () => {
    const state = new NativeReadState()
    const { dir, path } = await fixture()
    state.recordModelWindow(await modelWindow(path), false)
    expect(state.unchangedSinceRead(await resolveNativeReadTarget(dir, path))).toBe(true)
    await expectEditable(state, dir, path)
    expect(state.unchangedSinceRead(await resolveNativeReadTarget(dir, path))).toBe(true)
  })
})
