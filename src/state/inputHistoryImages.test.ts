// Tests for the input-history image side store (IndexedDB).
// Runs in jsdom with `fake-indexeddb` polyfilling the global `indexedDB`
// (same pattern as session-store/store.idb.test.ts). Each test resets to a
// fresh IDBFactory so records don't leak across tests.
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearImages,
  deleteImages,
  getImages,
  putImages,
} from './inputHistoryImages'
import { resetInputHistoryIdb, makeImg as img } from '../test-utils/inputHistoryIdb'

beforeEach(() => {
  resetInputHistoryIdb()
})

afterEach(() => {
  resetInputHistoryIdb()
})

describe('inputHistoryImages', () => {
  it('round-trips images by entry id', async () => {
    await putImages('e1', [img(), img('BBBB', 'image/jpeg')])
    expect(await getImages('e1')).toEqual([
      { data: 'AAAA', mediaType: 'image/png', width: 10, height: 20, size: 3 },
      { data: 'BBBB', mediaType: 'image/jpeg', width: 10, height: 20, size: 3 },
    ])
  })

  it('returns [] for an unknown id', async () => {
    await putImages('e1', [img()])
    expect(await getImages('nope')).toEqual([])
  })

  it('a later put for the same id replaces the record', async () => {
    await putImages('e1', [img()])
    await putImages('e1', [img('CCCC', 'image/gif')])
    expect(await getImages('e1')).toEqual([
      { data: 'CCCC', mediaType: 'image/gif', width: 10, height: 20, size: 3 },
    ])
  })

  it('deleteImages removes the named records only', async () => {
    await putImages('e1', [img()])
    await putImages('e2', [img()])
    await deleteImages(['e1'])
    expect(await getImages('e1')).toEqual([])
    expect(await getImages('e2')).toHaveLength(1)
  })

  it('deleteImages with an empty list is a no-op', async () => {
    await putImages('e1', [img()])
    await deleteImages([])
    expect(await getImages('e1')).toHaveLength(1)
  })

  it('clearImages wipes every record', async () => {
    await putImages('e1', [img()])
    await putImages('e2', [img()])
    await clearImages()
    expect(await getImages('e1')).toEqual([])
    expect(await getImages('e2')).toEqual([])
  })

  it('degrades to text-only when IDB is unavailable', async () => {
    resetInputHistoryIdb()
    // Remove the global AFTER the reset — the reset installs a fresh factory.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).indexedDB = undefined
    // Every call resolves instead of rejecting — images are an enhancement.
    await putImages('e1', [img()])
    expect(await getImages('e1')).toEqual([])
    await deleteImages(['e1'])
    await clearImages()
  })

  it('retries the open after a transient failure instead of caching it forever', async () => {
    // First open attempt fails (sync throw out of indexedDB.open).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).indexedDB = { open: () => { throw new Error('boom') } }
    await putImages('e1', [img()])
    expect(await getImages('e1')).toEqual([])
    // The failure must NOT be cached in the module's db promise: with a
    // working factory and the SAME module state (no _resetDbForTests), the
    // next call re-opens and round-trips.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).indexedDB = new IDBFactory()
    await putImages('e1', [img('OK')])
    expect(await getImages('e1')).toEqual([img('OK')])
  })
})
