// React adapter for SessionSynchronizer.
//
// This is the Task-4 bridge between React and the framework-free
// SessionSynchronizer (Task 2/3). It owns exactly four responsibilities:
//
//   1. Construct one SessionSynchronizer per `sessionId` (re-created when the
//      session changes), injecting the live WsHub and `api.get`.
//   2. Drive start/stop from a `running` effect — the prior useChatStream
//      behavior where every `running` flip forces a fresh subscribe is
//      preserved (the synchronizer's `start()` calls `stopInternal()` first,
//      so a re-run cleanly tears down the previous run).
//   3. Forward `handlers` and `terminated` without resubscribing —
//      `setHandlers` swaps the callbacks in place (the listener reads
//      `this.handlers` at call time), and `setTerminated` drives the
//      replayReady-gated sweep.
//   4. Expose the narrow `TranscriptPaging` (loadingOlder / olderError /
//      loadOlder) via `useSyncExternalStore` over the synchronizer's paging
//      snapshot.
//
// It does NOT return items, messages, tool maps, context usage, or any other
// transcript data — those move to dedicated selectors in the rendering
// adapters (Task 5+). Empty `sessionId` is fully inert: no subscribe, no
// fetch, no store retain.

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { useWsHub } from '../hooks/useWsHub'
import { api } from '../hooks/useApi'
import { getSessionStore } from '../session-store/selectors'
import { sessionStoreRegistry } from '../session-store/registry'
import {
  SessionSynchronizer,
  type SessionSyncHandlers,
  type TranscriptPagingSnapshot,
} from './session-synchronizer'

/** The narrow paging interface this adapter returns. Adds the imperative
 *  `loadOlder` action to the snapshot fields the synchronizer already owns.
 *  The adapter memoizes so `loadOlder` is identity-stable per synchronizer
 *  instance (re-binding only when the session changes). */
export interface TranscriptPaging extends TranscriptPagingSnapshot {
  loadOlder: () => Promise<number>
}

export function useSessionSynchronizer(
  sessionId: string,
  handlers: SessionSyncHandlers,
  running: boolean,
  terminated: boolean,
): TranscriptPaging {
  const hub = useWsHub()

  // One synchronizer per session. `sessionId`/`hub` changes re-create it;
  // `handlers` is deliberately NOT in the deps — `setHandlers` swaps the
  // callbacks in place without re-subscribing (the listener reads
  // `this.handlers` at call time).
  const sync = useMemo(
    () =>
      new SessionSynchronizer({
        sessionId,
        store: getSessionStore(sessionId),
        hub,
        get: api.get,
        handlers,
      }),
    // handlers intentionally omitted — see setHandlers below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId, hub],
  )

  // Keep handlers current without resubscribing. The synchronizer's
  // handleFrame reads this.handlers at dispatch time, so the newest callbacks
  // take effect on the very next frame. An effect (not a render-time ref
  // write) forwards the latest handlers — setHandlers is a pure setter with
  // no side effects, so calling it on every handlers identity change is
  // cheap and never re-subscribes.
  useEffect(() => {
    sync.setHandlers(handlers)
  }, [sync, handlers])

  // Retain/release the store for this session. The registry's refCount keeps
  // the store alive while any consumer holds it; the idle GC sweeps after
  // the last release. Empty session is inert — no retain.
  useEffect(() => {
    if (!sessionId) return
    sessionStoreRegistry.retain(sessionId)
    return () => {
      sessionStoreRegistry.release(sessionId)
    }
  }, [sessionId])

  // Mount: start. Unmount: stop. running change: re-start. The synchronizer's
  // start() calls stopInternal() first, so a re-run cleanly tears down the
  // previous run before starting a fresh one — preserving the prior
  // useChatStream behavior where every running flip forces a fresh
  // subscribe with `force: true`. Empty session is inert — no start.
  useEffect(() => {
    if (!sessionId) return
    sync.start()
    return () => {
      sync.stop()
    }
  }, [sync, sessionId, running])

  // Forward terminated to the synchronizer. This effect runs AFTER the
  // start effect (React runs effects in declaration order), so a mount with
  // terminated already true sees the synchronizer started before
  // setTerminated is called. `running` is in the deps because a running flip
  // tears the synchronizer down and rebuilds it (the start effect above),
  // and `stopInternal()` resets `this.terminated = false` so a stale `true`
  // doesn't short-circuit the next setTerminated — which means this effect
  // MUST re-forward `terminated` after every running flip, or the
  // replayReady-gated SESSION_TERMINATED sweep is lost on a reloaded
  // terminated session whose panel re-subscribes before the tail page lands.
  // Empty session is inert — no terminated sweep.
  useEffect(() => {
    if (!sessionId) return
    sync.setTerminated(terminated)
  }, [sync, sessionId, terminated, running])

  // Paging snapshot — owned by the synchronizer, exposed via
  // useSyncExternalStore so consumers re-render only when loadingOlder or
  // olderError actually changes (the synchronizer's setPaging already does
  // the per-field Object.is check, so notifications are minimal).
  const subscribePaging = useCallback(
    (listener: () => void) => sync.subscribePaging(listener),
    [sync],
  )
  const getPagingSnapshot = useCallback(
    (): TranscriptPagingSnapshot => sync.getPagingSnapshot(),
    [sync],
  )
  const paging = useSyncExternalStore(
    subscribePaging,
    getPagingSnapshot,
    getPagingSnapshot,
  )

  // `loadOlder` is bound via useCallback so its identity is stable across
  // paging-snapshot changes (only `sync` — i.e. a session change — re-binds
  // it). The brief requires loadOlder identity to be stable per synchronizer;
  // spreading it into the memo below would re-create the arrow on every
  // paging flip, so it lives in its own callback.
  const loadOlder = useCallback(
    () => sync.loadOlder(),
    [sync],
  )

  // Memoized TranscriptPaging. The paging snapshot fields are spread in so
  // consumers read loadingOlder/olderError directly off the return value;
  // when the snapshot reference changes (a field flipped), the memo rebuilds
  // and the new fields flow to the consumer's next render. `loadOlder` is
  // the stable callback above — it does NOT change identity when paging
  // flips, so consumers that put loadOlder in a dep array are unaffected by
  // loadingOlder/olderError transitions.
  return useMemo(
    () => ({ ...paging, loadOlder }),
    [paging, loadOlder],
  )
}
