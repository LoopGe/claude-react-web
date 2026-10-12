// Shared test scaffolding for the input-history image side store (IDB).
//
// Every test file that touches `inputHistoryImages` needs the same three
// pieces: the fake-indexeddb factory swap, a settlement poll for the
// fire-and-forget IDB writes, and a PersistedImage fixture. Kept here so a
// change to the settlement strategy (or the fixture shape) is one edit.

import { IDBFactory } from 'fake-indexeddb'
import { _resetDbForTests, type PersistedImage } from '../state/inputHistoryImages'

/** Swap in a fresh IDBFactory and drop the module's cached DB promise. Call
 *  in beforeEach/afterEach of any file that exercises the side store. */
export function resetInputHistoryIdb(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).indexedDB = new IDBFactory()
  _resetDbForTests()
}

/** Fire-and-forget IDB writes settle asynchronously — poll until `cond` holds
 *  (black-box, no production test hooks). Throws after ~1s. */
export async function untilIdb(cond: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('IDB condition not met within timeout')
}

/** Minimal PersistedImage fixture. */
export function makeImg(
  data = 'AAAA',
  mediaType: PersistedImage['mediaType'] = 'image/png',
): PersistedImage {
  return { data, mediaType, width: 10, height: 20, size: 3 }
}
