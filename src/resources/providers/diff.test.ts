// @vitest-environment node
// Diff resource provider: address → existing git query builder per basis,
// failure frames, and refetch on git-snapshot frames
// (docs/resource-tabs-research.md §13–14 Phase 2).

import { describe, it, expect } from 'vitest'
import { createDiffProvider, diffQueryFor } from './diff'
import {
  diffResource,
  parseDiffResource,
  type DiffBasis,
} from '../../../shared/resource-address'
import type { GitDiff } from '../../../shared/git-types'
import type { InvalidationSource, ResourceFrame } from '../registry'

const base = { sessionId: 's1', cwd: '/repo', path: 'src/a.ts' }
const addressFor = (basis: DiffBasis) => diffResource({ ...base, basis })
const parsed = (basis: DiffBasis) => {
  const resource = parseDiffResource(addressFor(basis))
  if (!resource) throw new Error('test address did not parse')
  return resource
}

async function* emptyInvalidations(): AsyncIterable<never> {
  /* ends immediately */
}

function ctx(invalidations: InvalidationSource = emptyInvalidations) {
  return { signal: new AbortController().signal, invalidations }
}

async function collect<T>(iterable: AsyncIterable<ResourceFrame<T>>): Promise<ResourceFrame<T>[]> {
  const frames: ResourceFrame<T>[] = []
  for await (const frame of iterable) frames.push(frame)
  return frames
}

const DIFF: GitDiff = {
  path: 'src/a.ts',
  staged: false,
  truncated: false,
  totalLines: 3,
  text: '@@ -1 +1 @@\n-x\n+y\n',
  isBinary: false,
}

describe('diffQueryFor', () => {
  it('maps each basis to the existing git query builder', () => {
    expect(diffQueryFor(parsed({ type: 'worktree' }))).toBe(
      '/git/diff?cwd=%2Frepo&path=src%2Fa.ts&staged=0',
    )
    expect(diffQueryFor(parsed({ type: 'staged' }))).toBe(
      '/git/diff?cwd=%2Frepo&path=src%2Fa.ts&staged=1',
    )
    expect(diffQueryFor(parsed({ type: 'commit', sha: 'abc123' }))).toBe(
      '/git/commit-file?cwd=%2Frepo&hash=abc123&path=src%2Fa.ts',
    )
    expect(
      diffQueryFor(
        parsed({ type: 'range', from: 'main', to: 'origin/feat', mergeBase: true }),
      ),
    ).toBe(
      '/git/diff-range-file?cwd=%2Frepo&from=main&to=origin%2Ffeat&path=src%2Fa.ts&mode=mergeBase',
    )
    expect(
      diffQueryFor(parsed({ type: 'range', from: 'main', to: 'dev', mergeBase: false })),
    ).not.toContain('mode=')
  })

  it('appends the full-body flag for the escape hatch', () => {
    expect(diffQueryFor(parsed({ type: 'worktree' }), { full: true })).toBe(
      '/git/diff?cwd=%2Frepo&path=src%2Fa.ts&staged=0&full=1',
    )
  })
})

describe('diff resource provider', () => {
  it('yields the fetched diff', async () => {
    const reads: string[] = []
    const provider = createDiffProvider(async (path) => {
      reads.push(path)
      return DIFF
    })
    const frames = await collect(provider.open(addressFor({ type: 'worktree' }), ctx()))
    expect(frames).toEqual([{ ok: true, value: DIFF }])
    expect(reads).toHaveLength(1)
  })

  it('yields a failure for an invalid address', async () => {
    const provider = createDiffProvider(async () => DIFF)
    const frames = await collect(provider.open('crw-resource://file/s1/a.ts', ctx()))
    expect(frames[0]).toMatchObject({ ok: false, failure: { code: 'diff/invalid-address' } })
  })

  it('yields a failure when the fetch throws', async () => {
    const provider = createDiffProvider(async () => {
      throw new Error('git failed')
    })
    const frames = await collect(provider.open(addressFor({ type: 'worktree' }), ctx()))
    expect(frames).toEqual([
      { ok: false, failure: { code: 'diff/fetch-failed', message: 'git failed' } },
    ])
  })

  it('refetches on any git-snapshot frame', async () => {
    const reads: string[] = []
    const provider = createDiffProvider(async (path) => {
      reads.push(path)
      return { ...DIFF, text: `read-${reads.length}` }
    })
    const invalidations: InvalidationSource = (kinds) => {
      expect(kinds).toEqual(['git-snapshot'])
      return (async function* () {
        yield { kind: 'git-snapshot' }
      })()
    }
    const frames = await collect(provider.open(addressFor({ type: 'worktree' }), ctx(invalidations)))
    expect(reads).toHaveLength(2)
    expect(frames).toHaveLength(2)
  })

  it('subscribes to invalidations before the first read', async () => {
    let subscribed = false
    const invalidations: InvalidationSource = () =>
      (async function* () {
        subscribed = true
        yield* [] as never[]
        await new Promise<void>(() => {
          /* park */
        })
      })()
    let subscribedAtRead = false
    const provider = createDiffProvider(async () => {
      subscribedAtRead = subscribed
      return DIFF
    })
    const iterator = provider.open(addressFor({ type: 'worktree' }), ctx(invalidations))[
      Symbol.asyncIterator
    ]()
    await iterator.next()
    expect(subscribedAtRead).toBe(true)
    await iterator.return?.()
  })
})