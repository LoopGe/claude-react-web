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
  putDraftImages,
  getDraftImages,
  deleteDraftImages,
  deleteDraftImagesForRemovedSession,
  resumeDraftWrites,
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

describe('draft images', () => {
  it('round-trips a draft by session id', async () => {
    await putDraftImages('s1', [img('DDDD', 'image/webp')])
    expect(await getDraftImages('s1')).toEqual([
      { data: 'DDDD', mediaType: 'image/webp', width: 10, height: 20, size: 3 },
    ])
  })

  it('returns [] when no draft was stored', async () => {
    expect(await getDraftImages('nope')).toEqual([])
  })

  it('a later put replaces the session draft', async () => {
    await putDraftImages('s1', [img()])
    await putDraftImages('s1', [img('EEEE', 'image/gif')])
    expect(await getDraftImages('s1')).toEqual([
      { data: 'EEEE', mediaType: 'image/gif', width: 10, height: 20, size: 3 },
    ])
  })

  it('deleteDraftImages removes only that session’s draft', async () => {
    await putDraftImages('s1', [img()])
    await putDraftImages('s2', [img('EEEE')])
    await deleteDraftImages('s1')
    expect(await getDraftImages('s1')).toEqual([])
    expect(await getDraftImages('s2')).toHaveLength(1)
  })

  it('coexists with history records: entry-id orphan cleanup never touches drafts', async () => {
    await putImages('e1', [img()])
    await putDraftImages('s1', [img('DDDD')])
    // The orphan cleanup inputHistoryStore.add() performs passes HISTORY
    // ENTRY ids — draft keys live in a disjoint namespace, so the draft
    // record must survive it.
    await deleteImages(['e1'])
    expect(await getImages('e1')).toEqual([])
    expect(await getDraftImages('s1')).toEqual([img('DDDD')])
  })

  it('a put issued after the removed-session delete is a no-op (closing panel’s unmount flush)', async () => {
    // Delete flows (performDelete / session-removed teardown) run BEFORE the
    // deleted panel's unmount commit, whose draft flush then issues its put
    // — IDB executes same-connection transactions in issue order, so that
    // late put would resurrect the deleted session's record. The removed-
    // session delete tombstones the id; the late put must be dropped.
    await putDraftImages('s1', [img()])
    await deleteDraftImagesForRemovedSession('s1')
    await putDraftImages('s1', [img('LATE')])
    expect(await getDraftImages('s1')).toEqual([])
  })

  it('the send-clear delete does NOT tombstone — a later paste persists again', async () => {
    // The hook deletes on send-consumed drafts; the same session must keep
    // persisting future drafts afterwards.
    await putDraftImages('s1', [img()])
    await deleteDraftImages('s1')
    await putDraftImages('s1', [img('NEW')])
    expect(await getDraftImages('s1')).toEqual([img('NEW')])
  })

  it('resumeDraftWrites re-arms puts after a removed-session tombstone', async () => {
    // Session ids are NOT dead forever: resume() re-spawns under the SAME id
    // (server doResume), so a tombstoned id can legitimately write again
    // once a live panel mounts for it. The hook calls this on mount.
    await putDraftImages('s1', [img()])
    await deleteDraftImagesForRemovedSession('s1')
    resumeDraftWrites('s1')
    await putDraftImages('s1', [img('AGAIN')])
    expect(await getDraftImages('s1')).toEqual([img('AGAIN')])
  })
})
