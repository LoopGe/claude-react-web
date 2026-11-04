import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { captureCopy, canonicalTargetPath, sameCopy } from './capture.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'crw-capture-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('captureCopy', () => {
  it('stores identical content once and reports binary', async () => {
    const file = join(dir, 'a.txt')
    await writeFile(file, 'hello\n')
    const a = await captureCopy(file, join(dir, 'store'), 1024)
    const b = await captureCopy(file, join(dir, 'store'), 1024)
    expect(a.kind).toBe('file')
    expect(sameCopy(a, b)).toBe(true)

    const bin = join(dir, 'b.bin')
    await writeFile(bin, Buffer.from([0x00, 0x01]))
    expect(await captureCopy(bin, join(dir, 'store'), 1024)).toMatchObject({ kind: 'file', binary: true })
  })

  it('reports absent and oversized', async () => {
    expect(await captureCopy(join(dir, 'missing'), join(dir, 'store'), 1024)).toEqual({ kind: 'absent' })
    const big = join(dir, 'big')
    await writeFile(big, 'x'.repeat(2048))
    expect(await captureCopy(big, join(dir, 'store'), 1024)).toEqual({ kind: 'oversized' })
  })

  it('stores distinct content as distinct copies', async () => {
    const one = join(dir, 'one')
    const two = join(dir, 'two')
    await writeFile(one, 'one\n')
    await writeFile(two, 'two\n')
    const a = await captureCopy(one, join(dir, 'store'), 1024)
    const b = await captureCopy(two, join(dir, 'store'), 1024)
    expect(sameCopy(a, b)).toBe(false)
  })

  it('canonicalizes a not-yet-created path through its parent', async () => {
    const target = join(dir, 'new-file.txt')
    // tmpdir() may hand back an 8.3 short name (C:\…\GEZELI~1\…); the canonical
    // parent is what every capture key and the git worktree share.
    expect(await canonicalTargetPath(target)).toBe(join(await realpath(dir), 'new-file.txt'))
  })
})