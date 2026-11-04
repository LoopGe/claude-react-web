// @vitest-environment node
// File resource provider: read-file fetch shape, image encoding, failure
// frames, and git-snapshot invalidation filtering
// (docs/resource-tabs-research.md §13 "File provider").

import { describe, it, expect } from 'vitest'
import { createFileProvider } from './file'
import { fileResource } from '../../../shared/resource-address'
import type { FileReadResult } from '../../../shared/read-file'
import type { InvalidationSource, ResourceFrame } from '../registry'

const TS = fileResource('s1', '/repo/a.ts')

async function* emptyInvalidations(): AsyncIterable<never> {
  /* ends immediately: fetch once */
}

async function collect<T>(iterable: AsyncIterable<ResourceFrame<T>>): Promise<ResourceFrame<T>[]> {
  const frames: ResourceFrame<T>[] = []
  for await (const frame of iterable) frames.push(frame)
  return frames
}

function ctx(invalidations: InvalidationSource = emptyInvalidations) {
  return { signal: new AbortController().signal, invalidations }
}

describe('file resource provider', () => {
  it('fetches the file through the read-file route and yields the value', async () => {
    const reads: string[] = []
    const provider = createFileProvider(async (path) => {
      reads.push(path)
      return { available: true, contents: 'export const x = 1' }
    })
    const frames = await collect(provider.open(TS, ctx()))
    expect(frames).toEqual([{ ok: true, value: { available: true, contents: 'export const x = 1' } }])
    expect(reads).toEqual(['/sessions/s1/read-file?path=%2Frepo%2Fa.ts'])
  })

  it('asks for base64 with a larger cap for image paths', async () => {
    const reads: string[] = []
    const provider = createFileProvider(async (path) => {
      reads.push(path)
      return { available: true, contents: 'b64', encoding: 'base64' }
    })
    await collect(provider.open(fileResource('s1', '/repo/pic.png'), ctx()))
    expect(reads[0]).toBe(
      '/sessions/s1/read-file?path=%2Frepo%2Fpic.png&encoding=base64&maxBytes=5242880',
    )
  })

  it('passes a denied/missing read through as a value for the body’s neutral hint', async () => {
    const provider = createFileProvider(async () => ({ available: false }))
    const frames = await collect(provider.open(TS, ctx()))
    expect(frames).toEqual([{ ok: true, value: { available: false } }])
  })

  it('subscribes to git-snapshot invalidations before the initial read', async () => {
    // A snapshot emitted while the read is in flight must be buffered, not lost.
    let subscribed = false
    const invalidations: InvalidationSource = () =>
      (async function* () {
        subscribed = true
        yield* [] as never[]
        await new Promise<void>(() => {
          /* park: no frame */
        })
      })()
    let subscribedAtRead = false
    const provider = createFileProvider(async () => {
      subscribedAtRead = subscribed
      return { available: true, contents: 'x' }
    })
    const iterator = provider.open(TS, ctx(invalidations))[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.value).toEqual({ ok: true, value: { available: true, contents: 'x' } })
    expect(subscribedAtRead).toBe(true)
    await iterator.return?.()
  })

  it('yields a failure when the read throws (dormant session, bad path)', async () => {
    const provider = createFileProvider(async () => {
      throw new Error('Session is not live')
    })
    const frames = await collect(provider.open(TS, ctx()))
    expect(frames).toEqual([
      { ok: false, failure: { code: 'file/read-failed', message: 'Session is not live' } },
    ])
  })

  it('yields a failure for a non-file address', async () => {
    const provider = createFileProvider(async () => ({ available: true }))
    const frames = await collect(provider.open('crw-resource://diff/s1/worktree/a.ts', ctx()))
    expect(frames[0]).toMatchObject({ ok: false, failure: { code: 'file/invalid-address' } })
  })

  it('refetches only when an invalidation names the file’s work tree', async () => {
    const reads: string[] = []
    const provider = createFileProvider(async (path) => {
      reads.push(path)
      return { available: true, contents: String(reads.length) }
    })
    const invalidations: InvalidationSource = (kinds) => {
      expect(kinds).toEqual(['git-snapshot'])
      return (async function* () {
        yield { kind: 'git-snapshot', cwd: '/other', repoRoot: '/other' }
        yield { kind: 'git-snapshot', cwd: '/repo', repoRoot: '/repo' }
      })()
    }
    const frames = await collect(provider.open(TS, ctx(invalidations)))
    expect(reads).toHaveLength(2)
    expect(frames).toEqual([
      { ok: true, value: { available: true, contents: '1' } },
      { ok: true, value: { available: true, contents: '2' } },
    ])
  })

  it('passes the parsed result through unchanged', async () => {
    const result: FileReadResult = { available: true, contents: 'abc', truncated: true }
    const provider = createFileProvider(async () => result)
    expect((await collect(provider.open(TS, ctx())))[0]).toEqual({ ok: true, value: result })
  })
})