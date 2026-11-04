// Address grammar for resource tabs. The builder normalizes (separators, `.`/
// `..`, query key order); the parser only decodes and validates. Identity is
// the verbatim address string — see docs/resource-tabs-research.md §11.

import { describe, it, expect } from 'vitest'
import {
  buildResourceAddress,
  diffResource,
  fileResource,
  parseDiffResource,
  parseFileResource,
  parseResourceAddress,
  parseSnapshotDiffResource,
  resourceTitle,
  snapshotDiffResource,
} from './resource-address'

describe('parseResourceAddress', () => {
  it('rejects a foreign scheme', () => {
    expect(parseResourceAddress('dsh-resource://file/s1/repo/a.ts')).toBeNull()
  })

  it('rejects a malformed percent escape', () => {
    expect(parseResourceAddress('crw-resource://file/s1/%E0%A4%A')).toBeNull()
  })

  it('rejects a fragment', () => {
    expect(parseResourceAddress('crw-resource://file/s1/repo/a.ts#L10')).toBeNull()
  })

  it('parses an unknown protocol generically instead of rejecting it', () => {
    expect(parseResourceAddress('crw-resource://future/s1/x')).toEqual({
      protocol: 'future',
      segments: ['s1', 'x'],
      query: {},
    })
  })

  it('preserves empty path segments so a POSIX root survives', () => {
    expect(parseResourceAddress('crw-resource://file/s1//repo/a.ts')?.segments).toEqual([
      's1',
      '',
      'repo',
      'a.ts',
    ])
  })

  it('canonicalizes query key order and decodes values', () => {
    const address = buildResourceAddress('diff', ['s1', 'worktree', 'a.ts'], {
      z: '1',
      cwd: '/repo x',
      a: '2',
    })
    expect(address).toBe('crw-resource://diff/s1/worktree/a.ts?a=2&cwd=%2Frepo%20x&z=1')
    expect(parseResourceAddress(address)?.query).toEqual({ a: '2', cwd: '/repo x', z: '1' })
  })
})

describe('file addresses', () => {
  it('round-trips spaces, unicode and reserved characters', () => {
    const address = fileResource('s1', '/repo/src/文件 a#b?c%d.ts')
    expect(address).toBe(
      'crw-resource://file/s1//repo/src/%E6%96%87%E4%BB%B6%20a%23b%3Fc%25d.ts',
    )
    expect(parseFileResource(address)).toEqual({ sessionId: 's1', path: '/repo/src/文件 a#b?c%d.ts' })
  })

  it('keeps a Windows drive letter literal and normalizes backslashes', () => {
    const address = fileResource('s1', 'C:\\repo\\dir\\a.ts')
    expect(address).toBe('crw-resource://file/s1/C:/repo/dir/a.ts')
    expect(parseFileResource(address)).toEqual({ sessionId: 's1', path: 'C:/repo/dir/a.ts' })
  })

  it('preserves the double leading slash of a UNC path', () => {
    const address = fileResource('s1', '\\\\server\\share\\repo\\a.ts')
    expect(parseFileResource(address)).toEqual({ sessionId: 's1', path: '//server/share/repo/a.ts' })
  })

  it('drops "." segments and resolves ".." lexically, clamped at the root', () => {
    expect(parseFileResource(fileResource('s1', '/repo/./a/../b.ts'))?.path).toBe('/repo/b.ts')
    expect(parseFileResource(fileResource('s1', '/../../a.ts'))?.path).toBe('/a.ts')
    expect(parseFileResource(fileResource('s1', 'C:/../a.ts'))?.path).toBe('C:/a.ts')
  })

  it('keeps identity verbatim: no case folding, no trailing-slash tolerance', () => {
    expect(fileResource('s1', '/Repo/A.ts')).not.toBe(fileResource('s1', '/repo/a.ts'))
  })

  it('returns null for a non-file protocol', () => {
    expect(parseFileResource('crw-resource://diff/s1/worktree/a.ts')).toBeNull()
  })

  it('derives the title from the decoded basename', () => {
    expect(resourceTitle(fileResource('s1', '/repo/src/App.tsx'))).toBe('App.tsx')
  })
})

describe('diff addresses', () => {
  const base = { sessionId: 's1', cwd: '/repo', path: 'src/a.ts' }

  it('round-trips the worktree basis', () => {
    const address = diffResource({ ...base, basis: { type: 'worktree' } })
    expect(address).toBe('crw-resource://diff/s1/src/a.ts?basis=worktree&cwd=%2Frepo')
    expect(parseDiffResource(address)).toEqual({ ...base, basis: { type: 'worktree' } })
  })

  it('round-trips staged / commit / range bases with a canonical query', () => {
    expect(
      parseDiffResource(diffResource({ ...base, basis: { type: 'staged' } })),
    ).toEqual({ ...base, basis: { type: 'staged' } })

    const commit = diffResource({ ...base, basis: { type: 'commit', sha: 'abc123' } })
    expect(commit).toBe('crw-resource://diff/s1/src/a.ts?basis=commit&cwd=%2Frepo&sha=abc123')
    expect(parseDiffResource(commit)).toEqual({
      ...base,
      basis: { type: 'commit', sha: 'abc123' },
    })

    const range = diffResource({
      ...base,
      basis: { type: 'range', from: 'main', to: 'origin/feat', mergeBase: true },
    })
    expect(range).toBe(
      'crw-resource://diff/s1/src/a.ts?basis=range&cwd=%2Frepo&from=main&mode=mergeBase&to=origin%2Ffeat',
    )
    expect(parseDiffResource(range)).toEqual({
      ...base,
      basis: { type: 'range', from: 'main', to: 'origin/feat', mergeBase: true },
    })
  })

  it('keeps a ref containing a slash inside one segment', () => {
    const address = diffResource({
      ...base,
      basis: { type: 'range', from: 'release/1.0', to: 'main', mergeBase: false },
    })
    expect(parseDiffResource(address)?.basis).toEqual({
      type: 'range',
      from: 'release/1.0',
      to: 'main',
      mergeBase: false,
    })
  })

  it('treats each basis as a distinct identity', () => {
    expect(diffResource({ ...base, basis: { type: 'worktree' } })).not.toBe(
      diffResource({ ...base, basis: { type: 'staged' } }),
    )
  })

  it('rejects malformed diff addresses', () => {
    expect(
      parseDiffResource('crw-resource://diff/s1/src/a.ts?basis=nope&cwd=%2Frepo'),
    ).toBeNull()
    expect(parseDiffResource('crw-resource://diff/s1/src/a.ts?basis=worktree')).toBeNull()
    expect(
      parseDiffResource('crw-resource://diff/s1/src/a.ts?basis=commit&cwd=%2Frepo'),
    ).toBeNull()
    expect(parseDiffResource('crw-resource://diff/s1?basis=worktree&cwd=%2Frepo')).toBeNull()
    expect(
      parseDiffResource(
        'crw-resource://diff/s1/src/a.ts?basis=range&cwd=%2Frepo&from=main&to=dev',
      ),
    ).toBeNull()
    expect(
      parseDiffResource(
        'crw-resource://diff/s1/src/a.ts?basis=range&cwd=%2Frepo&from=main&to=dev&mode=other',
      ),
    ).toBeNull()
    expect(parseDiffResource('crw-resource://file/s1/src/a.ts')).toBeNull()
  })

  it('derives a diff title from the path basename plus the basis', () => {
    expect(resourceTitle(diffResource({ ...base, basis: { type: 'worktree' } }))).toBe(
      'a.ts · worktree',
    )
  })
})

describe('snapshot-diff addresses', () => {
  it('round-trips and derives a short title', () => {
    const address = snapshotDiffResource('s1', '1234567890abcdef')
    expect(address).toBe('crw-resource://snapshot-diff/s1/1234567890abcdef')
    expect(parseSnapshotDiffResource(address)).toEqual({
      sessionId: 's1',
      messageId: '1234567890abcdef',
    })
    expect(resourceTitle(address)).toBe('Changes 12345678')
  })

  it('rejects malformed snapshot-diff addresses', () => {
    expect(parseSnapshotDiffResource('crw-resource://snapshot-diff/s1')).toBeNull()
    expect(parseSnapshotDiffResource('crw-resource://snapshot-diff//abc')).toBeNull()
    expect(parseSnapshotDiffResource('crw-resource://snapshot-diff/s1/m1/junk')).toBeNull()
  })
})