// Update-info hub — the SINGLE broadcast decision point for update snapshots.
//
// Every meaningful snapshot mutation publishes here, regardless of trigger
// (scheduled probe, manual Check now, install completion, registry-disabled
// reset): the checker calls publishUpdateInfo at its snapshot-write sites and
// the update route calls it after an in-app install. The hub compares against
// the last received snapshot and fans out only meaningful changes, so no
// mutation path can be missed and no unchanged probe spams tabs.
//
// WS-agnostic on purpose: frame-bridge owns the wire part (subscribeUpdateInfo
// → always-on `update-info` channel, seeded per connection). Module-singleton
// state mirrors the checker's own idiom.

import type { UpdateInfo } from '../shared/update-info.js'
import { createAsyncSubscription, type AsyncSubscription } from './async-subscription.js'

/** The fields whose change is worth a broadcast. `checkedAt` alone is not —
 *  an unchanged successful probe must stay silent. */
const MEANINGFUL_KEYS = ['latest', 'deprecated', 'error', 'updateAppliedToDisk', 'disabled'] as const

let last: UpdateInfo | null = null
const subscribers = new Set<AsyncSubscription<UpdateInfo>>()

/** Compare against the last received snapshot and fan out on a meaningful
 *  change. Records `info` even when silent so the connection seed stays
 *  current. */
export function publishUpdateInfo(info: UpdateInfo): void {
  const prev = last
  const changed = prev === null || MEANINGFUL_KEYS.some((key) => info[key] !== prev[key])
  last = info
  if (!changed) return
  for (const sub of subscribers) sub.push(info)
}

/** One always-on subscription: the latest received snapshot (null before any
 *  publish) plus the live change stream. Mirrors sm.subscribeGlobal()'s shape. */
export function subscribeUpdateInfo(): {
  iterable: AsyncIterable<UpdateInfo>
  snapshot: UpdateInfo | null
  unsubscribe: () => void
} {
  const sub = createAsyncSubscription<UpdateInfo>(() => {
    subscribers.delete(sub)
  })
  subscribers.add(sub)
  return {
    iterable: sub.iterable,
    get snapshot() {
      return last
    },
    unsubscribe: () => {
      sub.end()
      subscribers.delete(sub)
    },
  }
}

/** Test hook — clears module state between unit tests. */
export function __resetUpdateInfoHubForTests(): void {
  last = null
  for (const sub of subscribers) sub.end()
  subscribers.clear()
}