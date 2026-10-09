import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir, rmRf } from './__test-utils__/index.js'
import { canonicalCwd, sameCwd } from './cwd-equality.js'

const roots: string[] = []

function makeTree(): string {
  const dir = tempDir('cwd-equality-')
  roots.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of roots) rmRf(dir)
})

describe('sameCwd', () => {
  it('matches two spellings of the same directory through a symlink (macOS /var vs /private/var shape)', () => {
    const base = makeTree()
    const real = join(base, 'real-dir')
    const link = join(base, 'link-dir')
    mkdirSync(real)
    symlinkSync(real, link, 'dir')
    // The canonical forms of BOTH spellings are the same resolved dir.
    expect(sameCwd(link, real)).resolves.toBe(true)
    expect(sameCwd(real, link)).resolves.toBe(true)
  })

  it('rejects genuinely different directories', async () => {
    const base = makeTree()
    const a = join(base, 'a')
    const b = join(base, 'b')
    mkdirSync(a)
    mkdirSync(b)
    expect(await sameCwd(a, b)).toBe(false)
  })

  it('treats undefined on either side as exact-match semantics', async () => {
    expect(await sameCwd(undefined, undefined)).toBe(true)
    expect(await sameCwd(undefined, '/repo')).toBe(false)
    expect(await sameCwd('/repo', undefined)).toBe(false)
  })

  it('falls back to raw comparison for unresolvable paths (no throw)', async () => {
    const ghostA = join(makeTree(), 'does-not-exist-a')
    const ghostB = join(makeTree(), 'does-not-exist-b')
    expect(await sameCwd(ghostA, ghostA)).toBe(true) // raw-equal short-circuit
    expect(await sameCwd(ghostA, ghostB)).toBe(false)
  })
})

describe('canonicalCwd', () => {
  it('resolves symlinked spellings to one canonical form and memoizes', async () => {
    const base = makeTree()
    const real = join(base, 'real-dir')
    const link = join(base, 'link-dir')
    mkdirSync(real)
    symlinkSync(real, link, 'dir')
    const fromReal = await canonicalCwd(real)
    const fromLink = await canonicalCwd(link)
    expect(fromLink).toBe(fromReal)
    expect(fromLink).not.toBe(link) // actually canonicalized, not passed through
    // Memo hit returns the same result without re-resolving.
    expect(await canonicalCwd(link)).toBe(fromLink)
  })
})
