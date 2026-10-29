// SessionSynchronizer — the framework-free WS/REST synchronization owner.
//
// This module owns the per-session WS listener, force subscribe/release,
// REST tail page, generation/clear-epoch page validation, and loadOlder
// paging. It is deliberately React-free: a Task-4 React adapter
// (useSessionSynchronizer) will drive start/stop from a `running` effect and
// expose paging via useSyncExternalStore.
//
// Task 2 (this file) implements the run-scoped paging core and run
// isolation. The full WS frame-routing switch (message, attached,
// permission-request, …) arrives in Task 3; the listener is registered
// here so the open-path contract (subscribe + tail fetch) is complete, but
// the frame body is intentionally minimal — only the session-cleared frame
// is handled, because it bumps the run's epoch/floor (which the validated
// fetch depends on) and clears the paging error pill.

import type { SessionStore } from '../session-store/store'
import type { WsServerFrame } from '../ws-types'
import type { TranscriptPageResponse } from '../../shared/transcript-page'
import type {
  DialogResolved,
  ElicitationRequestUi,
  ElicitationResolved,
  PermissionRequest,
  PermissionResolved,
  UserDialogRequestUi,
} from '../types'

// ── Public interfaces (verbatim from the task brief) ──────────────

export interface SessionSyncHub {
  addSessionListener(sessionId: string, listener: (frame: WsServerFrame) => void): () => void
  subscribe(sessionId: string, opts?: { force?: boolean }): () => void
}

export type SessionSyncGet = <T>(path: string) => Promise<T>

export interface TranscriptPagingSnapshot {
  loadingOlder: boolean
  olderError: string | null
}

/** Same fields as the current PermissionHandlers in useChatStream.ts —
 *  kept here so this module has no React import. */
export interface SessionSyncHandlers {
  onRequest: (req: PermissionRequest) => void
  onResolved: (res: PermissionResolved) => void
  onCleared?: () => void
  onElicitationRequest?: (req: ElicitationRequestUi) => void
  onElicitationResolved?: (res: ElicitationResolved) => void
  onDialogRequest?: (req: UserDialogRequestUi) => void
  onDialogResolved?: (res: DialogResolved) => void
  onEditPrompt?: (text: string) => void
}

// ── Run state ─────────────────────────────────────────────────────

/** Per-run mutable state. A new instance is created on every `start()`; the
 *  validated fetch and loadOlder capture this reference and bail (return
 *  null / 0) once `cancelled` is set or `this.run` no longer points here —
 *  so a stop/start cycle cannot let a late result from the old run dispatch
 *  a page or clobber the new run's paging snapshot. */
interface SyncRunState {
  /** True once `stop()` invalidated this run — every late result bails. */
  cancelled: boolean
  /** Armed by session-cleared and attached-generation-bump: a page at a
   *  LOWER generation is stale (pre-clear content that must not resurrect).
   *  Null until armed. */
  minGeneration: number | null
  /** Monotonic counter bumped by the session-cleared handler; invalidates
   *  in-flight page requests that were REQUESTED before the clear (the only
   *  signal that works before any generation has been adopted). */
  clearEpoch: number
  /** Highest missing seq the current gap-fill must reach (from an attached
   *  frame's headSeq - 1); null when no attached-driven gap is open. */
  gapTarget: number | null
  /** Serial gap-fill worker latch (at most one fillGap loop per run). */
  fillGapRunning: boolean
  fillGapRerun: boolean
  /** Older-history in-flight guard (at most one loadOlder per run). */
  olderInFlight: boolean
}

function createRun(): SyncRunState {
  return {
    cancelled: false,
    minGeneration: null,
    clearEpoch: 0,
    gapTarget: null,
    fillGapRunning: false,
    fillGapRerun: false,
    olderInFlight: false,
  }
}

// ── Implementation ────────────────────────────────────────────────

export class SessionSynchronizer {
  private readonly sessionId: string
  private readonly store: SessionStore
  private readonly hub: SessionSyncHub
  private readonly get: SessionSyncGet

  private handlers: SessionSyncHandlers
  private terminated = false

  /** The current run. Null when stopped; replaced on every start(). */
  private run: SyncRunState | null = null

  /** Teardown for the current run's WS listener + subscribe release. */
  private teardown: (() => void) | null = null

  /** Unsubscribe for the terminated-replayReady store gate. */
  private storeUnsub: (() => void) | null = null

  // Paging snapshot (owned here, NOT in the store reducer).
  private paging: TranscriptPagingSnapshot = { loadingOlder: false, olderError: null }
  private pagingListeners = new Set<() => void>()

  constructor(options: {
    sessionId: string
    store: SessionStore
    hub: SessionSyncHub
    get: SessionSyncGet
    handlers: SessionSyncHandlers
  }) {
    this.sessionId = options.sessionId
    this.store = options.store
    this.hub = options.hub
    this.get = options.get
    this.handlers = options.handlers
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  start(): void {
    // Tear down any current run first. Callers should stop() first, but be
    // robust — a double-start must not leak a listener or orphan a run.
    this.stopInternal()

    const sessionId = this.sessionId
    // Empty session path stays inert: no subscribe, no fetch.
    if (!sessionId) return

    const run = createRun()
    this.run = run

    // Reset the paging snapshot for the new run. The setPaging call fires a
    // notification ONLY if a value actually changed (e.g. an olderError from
    // the previous run), so a clean start is silent.
    this.setPaging({ loadingOlder: false, olderError: null })

    const { store, hub } = this

    const refetchTail = async (): Promise<void> => {
      try {
        const page = await this.fetchValidatedPage(
          run,
          `/sessions/${sessionId}/messages?limit=200`,
        )
        if (page == null) return // run invalidated — don't dispatch
        store.dispatch({
          type: 'WINDOW_PAGE',
          at: 'tail',
          generation: page.generation,
          headSeq: page.headSeq,
          messages: page.messages,
          tombstones: page.tombstones,
          hasMore: page.hasMore,
        })
      } catch {
        // Genuine fetch failure (network / retry exhaustion). Gate on the
        // run being active so a late failure from a stopped run doesn't
        // surface an error band on the new run's panel.
        if (!run.cancelled && this.run === run) {
          store.dispatch({ type: 'ERROR', message: 'Failed to load transcript history' })
        }
      }
    }

    // Tail subscription + listener setup. The open-path contract: subscribe
    // (force) and the REST tail fetch run concurrently. Frames that arrive
    // before the page lands are dropped by the window's generation guard.
    //
    // Non-paging frame routing (message, attached, permission-*, …) arrives
    // in Task 3. The session-cleared handler is included here because it
    // bumps the run's epoch/floor (which the validated fetch depends on) and
    // clears the paging error pill.
    const off = hub.addSessionListener(sessionId, (frame: WsServerFrame) => {
      if (frame.kind === 'session-cleared') {
        // Wipe to the empty live state (CLEAR_TRANSCRIPT preserves the
        // cursor values — meaningless until the next page re-anchors them),
        // arm both stale signals, and re-fetch the tail.
        store.dispatch({ type: 'CLEAR_TRANSCRIPT' })
        run.minGeneration = store.getSnapshot().generation + 1
        run.clearEpoch++
        this.handlers.onCleared?.()
        void refetchTail()
        // The stale failure pill must go with the transcript — its Retry
        // would refetch a cleared window and the pill would stick.
        this.setPaging({ ...this.paging, olderError: null })
      }
    })

    const release = hub.subscribe(sessionId, { force: true })
    void refetchTail()

    this.teardown = () => {
      run.cancelled = true
      off()
      release()
    }
  }

  stop(): void {
    this.stopInternal()
  }

  private stopInternal(): void {
    if (this.teardown) {
      this.teardown()
      this.teardown = null
    }
    if (this.run) {
      this.run.cancelled = true
      this.run = null
    }
    // Cancel the terminated-replayReady store gate too — a late
    // replayReady must not sweep a torn-down run.
    if (this.storeUnsub) {
      this.storeUnsub()
      this.storeUnsub = null
    }
    // Reset the terminated flag so a subsequent setTerminated(true) after
    // a re-mount (stop → start → setTerminated) re-arms the replayReady
    // gate instead of early-returning on the stale `true`.
    this.terminated = false
  }

  // ── Handlers / terminated ───────────────────────────────────────

  setHandlers(handlers: SessionSyncHandlers): void {
    this.handlers = handlers
  }

  setTerminated(terminated: boolean): void {
    if (this.terminated === terminated) return
    this.terminated = terminated

    // Cancel any pending replayReady subscription from a prior call.
    if (this.storeUnsub) {
      this.storeUnsub()
      this.storeUnsub = null
    }
    if (!terminated) return

    const { store } = this
    if (store.getSnapshot().replayReady) {
      store.dispatch({ type: 'SESSION_TERMINATED' })
      return
    }
    // replayReady not yet true — wait for it via store subscription. A
    // terminated session never delivers the `result` frame that drives the
    // turn-end sweep, so the store must sweep itself once the tail page
    // has landed (records exist and payloads are applied). Waiting for
    // replayReady means the records exist; an early sweep on an empty
    // store would leave just-windowed records unswept.
    this.storeUnsub = store.subscribe(() => {
      if (!store.getSnapshot().replayReady) return
      if (this.storeUnsub) {
        this.storeUnsub()
        this.storeUnsub = null
      }
      if (this.terminated) {
        store.dispatch({ type: 'SESSION_TERMINATED' })
      }
    })
  }

  // ── loadOlder (paging) ─────────────────────────────────────────

  async loadOlder(): Promise<number> {
    const run = this.run
    if (!run || run.cancelled) return 0

    const { store } = this
    const sessionId = this.sessionId
    const snap = store.getSnapshot()
    // Both guards read the WINDOW snapshot (single source of truth):
    //  · oldestSeq == null — the window is empty (hasOlder can be stale-true
    //    on an emptied window, and paging "before null" is meaningless);
    //  · !hasOlder — the last page reported nothing older.
    if (!snap.hasOlder || snap.oldestSeq == null) return 0

    // At most one in-flight request per run.
    if (run.olderInFlight) return 0
    run.olderInFlight = true

    // A new attempt supersedes the previous failure — the float flips from
    // the error pill to the loading pill while the retry runs.
    this.setPaging({ loadingOlder: true, olderError: null })

    try {
      // Through the validated fetch like every other page read: a head page
      // in flight when a session-cleared lands is pre-clear content, and
      // pageLoaded bootstraps ANY generation onto an emptied window — the
      // same resurrection hazard the tail and gap-fill paths guard against.
      const page = await this.fetchValidatedPage(
        run,
        `/sessions/${sessionId}/messages?before=${snap.oldestSeq}&limit=200`,
      )
      if (page == null) return 0 // run invalidated — don't dispatch
      store.dispatch({
        type: 'WINDOW_PAGE',
        at: 'head',
        generation: page.generation,
        headSeq: page.headSeq,
        messages: page.messages,
        tombstones: page.tombstones,
        hasMore: page.hasMore,
      })
      // hasOlder needs no setter: WINDOW_PAGE (at:'head') writes hasMore
      // into the window and the snapshot mirrors it.
      return page.messages.length
    } catch {
      // Network/parse error — leave hasOlder as-is (store-owned) so the user
      // can retry. Non-fatal: don't surface to the error banner. Gate on the
      // run being active so a late failure from a stopped run doesn't set
      // olderError on the new run's paging snapshot.
      if (!run.cancelled && this.run === run) {
        this.setPaging({ ...this.paging, olderError: "Couldn't load earlier messages" })
      }
      return 0
    } finally {
      // Skip the latch-clear when the run was invalidated: the new run's
      // start() already reset paging, and this stale closure must not break
      // the NEW run's in-flight guard or hide its loading pill mid-fetch.
      if (!run.cancelled && this.run === run) {
        run.olderInFlight = false
        this.setPaging({ ...this.paging, loadingOlder: false })
      }
    }
  }

  // ── Paging snapshot external store ──────────────────────────────

  getPagingSnapshot(): TranscriptPagingSnapshot {
    return this.paging
  }

  subscribePaging(listener: () => void): () => void {
    this.pagingListeners.add(listener)
    return () => {
      this.pagingListeners.delete(listener)
    }
  }

  // ── Private: paging snapshot mutation ────────────────────────────

  /** Replace the paging snapshot ONLY when a value actually changes
   *  (Object.is per field). Prevents spurious notifications: calling
   *  setPaging({loadingOlder:false, olderError:null}) when the snapshot is
   *  already {false, null} is a silent no-op. */
  private setPaging(next: TranscriptPagingSnapshot): void {
    const prev = this.paging
    if (prev.loadingOlder === next.loadingOlder && prev.olderError === next.olderError) {
      return
    }
    this.paging = next
    for (const listener of this.pagingListeners) listener()
  }

  // ── Private: validated fetch ────────────────────────────────────

  /** Every transcript page read — tail, gap-fill, AND loadOlder — funnels
   *  through this validation. Returns null when the run was invalidated
   *  (stop/start), so every caller can bail without dispatching.
   *
   *  TWO stale signals guard a page served before the server's reset landed
   *  (pre-clear content that must never be applied):
   *  · clear epoch — a monotonic counter bumped by session-cleared. Each
   *    attempt captures the epoch at request time; a result under an
   *    advanced epoch was REQUESTED before the clear.
   *  · generation floor (minGeneration) — a page at a LOWER generation is
   *    stale even when this client's own request raced nothing (another
   *    tab's clear moved the universe between our attach and our read).
   *  Retry on either signal; the cap turns a server that never resets into
   *  a loud error instead of a spin. */
  private async fetchValidatedPage(
    run: SyncRunState,
    url: string,
  ): Promise<TranscriptPageResponse | null> {
    const { get } = this
    for (let retries = 0; ; retries++) {
      const epochAtRequest = run.clearEpoch
      const page = await get<TranscriptPageResponse>(url)
      // Run invalidated while we were waiting (stop/start) — bail without
      // dispatching. This is what makes the restart-during-deferred-loadOlder
      // race safe: the old run's late page never reaches the store or the
      // new run's paging snapshot.
      if (run.cancelled || this.run !== run) return null
      const stale =
        run.clearEpoch !== epochAtRequest ||
        (run.minGeneration != null && page.generation < run.minGeneration)
      if (!stale) return page
      if (retries >= 5) throw new Error('transcript generation moved')
    }
  }
}

// The class is exported as `SessionSynchronizer` so callers can `new` it
// directly. Task 4's React adapter will import this class and drive
// start/stop from a `running` effect.
