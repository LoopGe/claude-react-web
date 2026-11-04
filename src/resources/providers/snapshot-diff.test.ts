// @vitest-environment node
// Snapshot-diff resource provider: route shape, pass-through value, failures.

import { describe, it, expect } from 'vitest'
import { createSnapshotDiffProvider } from './snapshot-diff'
import { snapshotDiffResource } from '../../../shared/resource-address'
import type { SnapshotDiffValue } from '../../../shared/snapshot-diff'
import type { ResourceFrame } from '../registry'

const ADDRESS = snapshotDiffResource('s1', 'm1')
const VALUE: SnapshotDiffValue = {
  diffs: [
    { file: 'src/a.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-a\n+b\n' },
  ],
}

async function collect<T>(iterable: AsyncIterable<ResourceFrame<T>>): Promise<ResourceFrame<T>[]> {
  const frames: ResourceFrame<T>[] = []
  for await (const frame of iterable) frames.push(frame)
  return frames
}

const ctx = () => ({ signal: new AbortController().signal, invalidations: async function* () {} })

describe('snapshot-diff resource provider', () => {
  it('fetches the route and yields the value', async () => {
    const reads: string[] = []
    const provider = createSnapshotDiffProvider(async (path) => {
      reads.push(path)
      return VALUE
    })
    expect(await collect(provider.open(ADDRESS, ctx()))).toEqual([{ ok: true, value: VALUE }])
    expect(reads).toEqual(['/sessions/s1/snapshot-diff?from=m1'])
  })

  it('yields a failure for an invalid address', async () => {
    const provider = createSnapshotDiffProvider(async () => VALUE)
    const frames = await collect(provider.open('crw-resource://file/s1/a.ts', ctx()))
    expect(frames[0]).toMatchObject({
      ok: false,
      failure: { code: 'snapshot-diff/invalid-address' },
    })
  })

  it('yields a failure when the route rejects (snapshots disabled / no anchor)', async () => {
    const provider = createSnapshotDiffProvider(async () => {
      throw new Error('file snapshots are disabled')
    })
    expect(await collect(provider.open(ADDRESS, ctx()))).toEqual([
      {
        ok: false,
        failure: { code: 'snapshot-diff/fetch-failed', message: 'file snapshots are disabled' },
      },
    ])
  })
})