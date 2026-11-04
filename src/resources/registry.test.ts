// @vitest-environment node
// Resource registry: provider-per-protocol, holder-counted streams, last-good
// retention beside a failure, and abort on the last release
// (docs/resource-tabs-research.md §13).

import { describe, it, expect } from 'vitest'
import { ResourceRegistry, type ResourceFrame, type ResourceProvider } from './registry'

const ADDRESS = 'crw-resource://test/x'

/** Wait until `predicate` holds (no reliance on vitest-version-specific helpers). */
async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`timed out waiting for: ${label}`)
}

function provider(
  protocol: string,
  open: ResourceProvider['open'],
): ResourceProvider {
  return { protocol, open }
}

/** A provider that emits its frames then parks until aborted. */
function streamingProvider(frames: ResourceFrame[], onAbort?: () => void): ResourceProvider {
  return provider('test', async function* (_address, { signal }) {
    for (const frame of frames) yield frame
    await new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => {
        onAbort?.()
        resolve()
      })
    })
  })
}

describe('ResourceRegistry', () => {
  it('throws when a protocol is registered twice', () => {
    const registry = new ResourceRegistry()
    const inert = () =>
      provider('test', async function* () {
        // never started: this test only registers
        yield { ok: true as const, value: null }
      })
    registry.register(inert())
    expect(() => registry.register(inert())).toThrow()
  })

  it('snapshots an unregistered protocol as none without starting anything', () => {
    const registry = new ResourceRegistry()
    expect(registry.getSnapshot(ADDRESS)).toEqual({ status: 'none' })
  })

  it('starts the provider stream on subscribe and publishes a live value', async () => {
    const registry = new ResourceRegistry()
    registry.register(streamingProvider([{ ok: true, value: { hello: 1 } }]))
    let notifications = 0
    const release = registry.subscribe(ADDRESS, () => {
      notifications++
    })
    await until(() => registry.getSnapshot(ADDRESS).status === 'live', 'live snapshot')
    expect(registry.getSnapshot(ADDRESS)).toMatchObject({ status: 'live', value: { hello: 1 } })
    expect(notifications).toBeGreaterThan(0)
    release()
  })

  it('retains the last good value beside a failure', async () => {
    const registry = new ResourceRegistry()
    registry.register(
      streamingProvider([
        { ok: true, value: 1 },
        { ok: false, failure: { code: 'test/boom', message: 'boom' } },
      ]),
    )
    const release = registry.subscribe(ADDRESS, () => {})
    await until(() => registry.getSnapshot(ADDRESS).status === 'failed', 'failed snapshot')
    expect(registry.getSnapshot(ADDRESS)).toEqual({
      status: 'failed',
      value: 1,
      failure: { code: 'test/boom', message: 'boom' },
    })
    release()
  })

  it('publishes failed when the provider throws', async () => {
    const registry = new ResourceRegistry()
    registry.register(
      provider('test', async function* () {
        yield* [] as never[]
        throw new Error('nope')
      }),
    )
    const release = registry.subscribe(ADDRESS, () => {})
    await until(() => registry.getSnapshot(ADDRESS).status === 'failed', 'failed snapshot')
    expect(registry.getSnapshot(ADDRESS).failure?.message).toContain('nope')
    release()
  })

  it('aborts the provider on the last release and resets to none', async () => {
    let aborts = 0
    const registry = new ResourceRegistry()
    registry.register(streamingProvider([{ ok: true, value: 1 }], () => {
      aborts++
    }))
    const release = registry.subscribe(ADDRESS, () => {})
    await until(() => registry.getSnapshot(ADDRESS).status === 'live', 'live snapshot')
    release()
    await until(() => aborts === 1, 'provider abort')
    expect(registry.getSnapshot(ADDRESS)).toEqual({ status: 'none' })
  })

  it('keeps the stream alive while another holder remains', async () => {
    let aborts = 0
    const registry = new ResourceRegistry()
    registry.register(streamingProvider([{ ok: true, value: 1 }], () => {
      aborts++
    }))
    const releaseOne = registry.subscribe(ADDRESS, () => {})
    const releasePin = registry.hold(ADDRESS)
    await until(() => registry.getSnapshot(ADDRESS).status === 'live', 'live snapshot')
    releaseOne()
    // Let any (incorrect) abort surface before asserting it did not happen.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(aborts).toBe(0)
    releasePin()
    await until(() => aborts === 1, 'provider abort')
  })

  it('never evicts a held stream, however many addresses are live', async () => {
    // The old cap evicted the oldest record, but every record is held (stop()
    // deletes on the last release) — so a 201st hold silently killed the first
    // file's stream. A live hold must never be evicted.
    const registry = new ResourceRegistry()
    registry.register(
      provider('test', async function* () {
        yield { ok: true, value: 1 }
      }),
    )
    const releases: Array<() => void> = []
    for (let i = 0; i < 250; i++) releases.push(registry.hold(`crw-resource://test/${i}`))
    await until(
      () => registry.getSnapshot('crw-resource://test/0').status === 'live',
      'first address live',
    )
    await until(
      () => registry.getSnapshot('crw-resource://test/249').status === 'live',
      'last address live',
    )
    expect(registry.getSnapshot('crw-resource://test/0')).toEqual({ status: 'live', value: 1 })
    for (const release of releases) release()
  })

  it('refresh restarts the stream while preserving the last good value', async () => {
    let opens = 0
    let aborts = 0
    const registry = new ResourceRegistry()
    registry.register(
      provider('test', async function* (_address, { signal }) {
        opens += 1
        yield { ok: true, value: opens === 1 ? 'first' : `second-${opens}` }
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            aborts += 1
            resolve()
          })
        })
      }),
    )
    const release = registry.subscribe(ADDRESS, () => {})
    await until(() => registry.getSnapshot(ADDRESS).status === 'live', 'first live')
    expect(registry.getSnapshot(ADDRESS).value).toBe('first')

    registry.refresh(ADDRESS)
    // The body must not blank while the refreshed stream is in flight.
    expect(registry.getSnapshot(ADDRESS).value).toBe('first')
    await until(
      () => registry.getSnapshot(ADDRESS).value === 'second-2',
      'second live',
    )
    expect(opens).toBe(2)
    expect(aborts).toBe(1)
    release()
  })

  it('does not notify a released listener', async () => {
    const registry = new ResourceRegistry()
    const frames: ResourceFrame[][] = [
      [{ ok: true, value: 1 }],
      [{ ok: true, value: 2 }],
    ]
    registry.register(
      provider('test', async function* (_address, { signal }) {
        yield frames[0][0]
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
        yield frames[1][0]
      }),
    )
    let calls = 0
    const release = registry.subscribe(ADDRESS, () => {
      calls++
    })
    await until(() => calls > 0, 'first notification')
    const seen = calls
    release()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(calls).toBe(seen)
  })
})