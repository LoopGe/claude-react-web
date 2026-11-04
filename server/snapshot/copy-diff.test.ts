import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { captureCopy, type FileCopy } from './capture.js'
import { compareCopies } from './copy-diff.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'crw-copydiff-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

async function copyOf(name: string, text: string): Promise<FileCopy> {
  const path = join(dir, name)
  await writeFile(path, text)
  return captureCopy(path, join(dir, 'store'), 1_000_000)
}

describe('compareCopies', () => {
  it('counts an added line and emits a git-style patch', async () => {
    const before = await copyOf('before', 'start\n')
    const after = await copyOf('after', 'start\ndone\n')
    const r = await compareCopies(before, after, 'notes.txt', 1_000_000)
    expect(r).toMatchObject({ added: 1, deleted: 0, binary: false, oversized: false, truncated: false })
    expect(r.patch).toContain('+++ b/notes.txt')
    expect(r.patch).toContain('+done')
  })

  it('treats a missing final newline as unchanged', async () => {
    const before = await copyOf('b', 'same')
    const after = await copyOf('a', 'same\n')
    expect(await compareCopies(before, after, 'x', 1_000_000)).toMatchObject({ added: 0, deleted: 0 })
  })

  it('counts a created file from its line count', async () => {
    const created = await compareCopies({ kind: 'absent' }, await copyOf('new', 'a\nb\n'), 'new.txt', 1_000_000)
    expect(created).toMatchObject({ added: 2, deleted: 0, binary: false, oversized: false })
    expect(created.patch).toContain('+a')
    expect(created.patch).toContain('+b')
  })

  it('counts a deleted file from its line count', async () => {
    const deleted = await compareCopies(await copyOf('gone', 'a\nb\nc\n'), { kind: 'absent' }, 'gone.txt', 1_000_000)
    expect(deleted).toMatchObject({ added: 0, deleted: 3 })
  })

  it('refuses binary and oversized sides', async () => {
    const binary: FileCopy = { kind: 'file', file: join(dir, 'binary'), binary: true }
    const binaryResult = await compareCopies(binary, await copyOf('text', 'x\n'), 'b.bin', 1_000_000)
    expect(binaryResult).toMatchObject({ binary: true, added: 0, deleted: 0 })
    expect(binaryResult.patch).toBeUndefined()
    const oversizeResult = await compareCopies({ kind: 'oversized' }, await copyOf('small', 'x\n'), 'big', 1_000_000)
    expect(oversizeResult).toMatchObject({ oversized: true, added: 0, deleted: 0 })
    expect(oversizeResult.patch).toBeUndefined()
  })

  it('clips a long patch and reports the unclipped line count', async () => {
    const before = await copyOf('long-before', '')
    const after = await copyOf('long-after', Array.from({ length: 700 }, (_, i) => `line ${i}`).join('\n') + '\n')
    const r = await compareCopies(before, after, 'long.txt', 1_000_000)
    expect(r.added).toBe(700)
    expect(r.truncated).toBe(true)
    expect(r.totalLines).toBeGreaterThan(500)
    expect(r.patch!.split('\n').length).toBeLessThanOrEqual(500)
  })
})