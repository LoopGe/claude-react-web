// SessionSynchronizer — the framework-free WS/REST synchronization owner.
//
// This module owns the per-session WS listener, force subscribe/release,
// REST tail page, generation/clear-epoch page validation, and loadOlder
// paging. It is deliberately React-free: a Task-4 React adapter
// (useSessionSynchronizer) will drive start/stop from a `running` effect and
// expose paging via useSyncExternalStore.
//
// The full WS frame-routing switch (message, attached, permission-*,
// session-cleared, …), the REST gap-fill worker, and the terminated
// replayReady-gated sweep all live here. Every async closure captures its
// SyncRunState so a stop/start cycle cannot let a late result from the old
// run dispatch a page or clobber the new run's state.

import type { SessionStore } from '../session-store/store'
import type { WsServerFrame } from '../ws-types'
import type { TranscriptPageResponse } from '../../shared/transcript-page'
import type {
  DialogResolved,
  ElicitationRequestUi,
  ElicitationResolved,
  PermissionRequest,
  PermissionResolved,
  SdkMessage,
  UserDialogRequestUi,
} from '../types'
import type { ContextUsage } from '../types/context-usage'
import { extractMessagePlainText } from '../../shared/search/extract'

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

/** The handler callbacks the host (useSessionSynchronizer) supplies —
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

    const { hub } = this

    // Tail subscription + listener setup. The open-path contract: subscribe
    // (force) and the REST tail fetch run concurrently. Frames that arrive
    // before the page lands are dropped by the window's generation guard.
    //
    // The full frame switch (message, attached, permission-*, session-cleared,
    // …) lives in handleFrame. Every async closure it spawns (refetchTail,
    // fillGap) captures `run` and bails once the run is invalidated, so a
    // stop/start cycle cannot let a late result from the old run dispatch a
    // page or clobber the new run's state.
    const off = hub.addSessionListener(sessionId, (frame: WsServerFrame) => {
      this.handleFrame(run, frame)
    })

    const release = hub.subscribe(sessionId, { force: true })
    void this.refetchTail(run)

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

  // ── Frame handling ───────────────────────────────────────────────

  /** Re-fetch the tail page and dispatch it. Run-scoped: bails (returns)
   *  once the run is invalidated so a late result from a stopped run cannot
   *  dispatch. The open-path fetch, the session-cleared re-fetch, and the
   *  attached-generation-bump re-fetch all go through here. */
  private async refetchTail(run: SyncRunState): Promise<void> {
    try {
      const page = await this.fetchValidatedPage(
        run,
        `/sessions/${this.sessionId}/messages?limit=200`,
      )
      if (page == null) return // run invalidated — don't dispatch
      this.store.dispatch({
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
        this.store.dispatch({ type: 'ERROR', message: 'Failed to load transcript history' })
      }
    }
  }

  /** REST gap-fill worker — the seq protocol's only hole-repair path.
   *
   *  One loop shape serves every caller:
   *   · a live frame whose seq jumped (the window parked it and marked
   *     `hole`) — anchor at the hole's top edge and walk down;
   *   · an `attached` reconnect catch-up (newestSeq < headSeq - 1, nothing
   *     parked yet) — anchor at headSeq and let the walk-down take over once
   *     the first page parks behind the hole.
   *  Every iteration re-reads the window snapshot, so frames that landed
   *  while a fetch was in flight are folded in without a second fetch chain.
   *
   *  Run-scoped: every await boundary checks `run.cancelled / this.run ===
   *  run` (via fetchValidatedPage returning null) so a late page from a
   *  stopped run never dispatches. The worker latch and rerun flag live on
   *  `run`, not on the instance — a new start() gets a fresh latch. */
  private async fillGap(run: SyncRunState): Promise<void> {
    if (run.fillGapRunning) {
      run.fillGapRerun = true
      return
    }
    run.fillGapRunning = true
    try {
      for (;;) {
        run.fillGapRerun = false
        for (;;) {
          if (run.cancelled || this.run !== run) return
          const snap = this.store.getSnapshot()
          const hole = snap.hole
          const target = run.gapTarget
          let before: number
          if (hole) {
            // The endpoint returns messages with seq < before, so anchoring
            // just above the missing range's top edge covers [from, to] on
            // the first page (limit 200) and walks further down on the next
            // iteration when the gap is wider than one page.
            before = hole[1] + 1
          } else if (target != null && snap.newestSeq != null && snap.newestSeq < target) {
            before = target + 1
          } else {
            run.gapTarget = null
            break
          }
          let page: TranscriptPageResponse | null
          try {
            page = await this.fetchValidatedPage(
              run,
              `/sessions/${this.sessionId}/messages?before=${before}&limit=200`,
            )
          } catch {
            // Network/parse error (or a generation floor that never
            // resolves) — stop; the next live frame (or the next attached
            // handshake) re-arms the fill.
            run.gapTarget = null
            return
          }
          if (page == null) return // run invalidated — don't dispatch
          const pre = this.store.getSnapshot()
          this.store.dispatch({
            type: 'WINDOW_PAGE',
            at: 'tail',
            generation: page.generation,
            headSeq: page.headSeq,
            messages: page.messages,
            // The page DECLARES the evicted seqs in its span (they can
            // never arrive): recording them lets the window's contiguity
            // check skip them, so a frame parked above a tombstoned hole
            // drains instead of stranding (the interrupt/withdraw vs
            // result race).
            tombstones: page.tombstones,
            // OR, not overwrite: a hole-fill page runs mid-transcript,
            // and the page's hasMore describes content below the PAGE —
            // which the window may already hold. OR-ing can only keep
            // hasOlder true (one wasted loadOlder at worst); overwriting
            // could flip it falsely false and strand the older history.
            hasMore: page.hasMore || pre.hasOlder,
          })
          const post = this.store.getSnapshot()
          const progressed =
            post.newestSeq !== pre.newestSeq ||
            post.hole?.[0] !== pre.hole?.[0] ||
            post.hole?.[1] !== pre.hole?.[1]
          if (!progressed) {
            // The page changed nothing (stale generation, all seqs already
            // owned, empty range): stop — otherwise this loops forever.
            // A tombstoned seq inside the hole is NOT a stall anymore: the
            // page declares it, the window records it, and recording
            // either drains the parked frames (advancing newestSeq or
            // clearing the hole) — so a pure tombstone gap converges in
            // one fetch. This closes the old "stranded until the panel is
            // reopened" residual.
            run.gapTarget = null
            break
          }
        }
        if (!run.fillGapRerun) return
      }
    } finally {
      run.fillGapRunning = false
    }
  }

  /** The full WS frame switch, ported from useChatStream. Synchronous
   *  dispatches run inline; async paths (refetchTail, fillGap) are kicked
   *  off as fire-and-forget with `run` captured so a stopped run's late
   *  result cannot dispatch. Reads `this.handlers` at call time so
   *  setHandlers takes effect without re-subscribing. */
  private handleFrame(run: SyncRunState, frame: WsServerFrame): void {
    const { store, handlers } = this
    switch (frame.kind) {
      case 'attached': {
        // Seq-space handshake (server sends it after every successful
        // subscribe — the reconnect catch-up trigger, spec §6).
        const snap = store.getSnapshot()
        if (snap.newestSeq == null) {
          // Empty window: the open path's tail page adopts the server's
          // generation — reconciling here would double-fetch on every
          // panel open (the handshake usually races the initial page).
          // Accepted trade: if the open fetch FAILED (error band up), an
          // attached frame arriving afterwards does not retry it — the
          // failure is surfaced loudly and the next subscribe (panel
          // reopen, running flip) re-fetches.
          break
        }
        if (frame.generation !== snap.generation) {
          // Dead universe (/clear or a server-side reset): whole-window
          // invalidation, then re-fetch the tail under the new generation.
          store.dispatch({ type: 'WINDOW_BUMP', generation: frame.generation, headSeq: frame.headSeq })
          run.minGeneration = frame.generation
          void this.refetchTail(run)
        } else if (snap.newestSeq < frame.headSeq - 1) {
          // Missed live frames while disconnected: page the REST gap
          // [newestSeq + 1, headSeq - 1] closed — the same paging code
          // path scroll-up loadOlder uses.
          run.gapTarget = frame.headSeq - 1
          void this.fillGap(run)
        }
        break
      }
      case 'message': {
        const message = frame.message as SdkMessage
        // system/session_state_changed is an ephemeral liveness frame
        // (idle / running / requires_action), NOT transcript content — the
        // server early-continues it out of the ring, so mirror it and skip
        // the transcript pipeline entirely.
        if (message.type === 'system' && message.subtype === 'session_state_changed') {
          const state = (message as { state?: unknown }).state
          if (state === 'idle' || state === 'running' || state === 'requires_action') {
            store.dispatch({ type: 'SESSION_STATE', state })
          }
          break
        }
        if (frame.seq != null && frame.generation != null) {
          // Seq-carrying frame — the seq-window protocol path. WINDOW_LIVE
          // REPLACES the legacy MESSAGE dispatch here (dispatching both
          // would append the message to the ordered log twice).
          store.dispatch({ type: 'WINDOW_LIVE', seq: frame.seq, generation: frame.generation, message })
          // Hole detection, snapshot convention (Task 7's plan decision —
          // the reducer keeps returning SessionState; no return-value side
          // channel): the parked-frame hole travels on the window and is
          // read from the snapshot after the dispatch. liveAppend parks
          // any seq beyond newestSeq + 1 and marks the hole; the REST page
          // over that range is fetched here.
          const snap = store.getSnapshot()
          if (snap.hole) void this.fillGap(run)
        } else {
          // No seq on the frame (synthetic / ephemeral frame: stream
          // events, pump errors) — legacy ordered-log append, no window
          // engagement.
          store.dispatch({ type: 'MESSAGE', message })
        }
        break
      }
      case 'messages-evicted': {
        // Server tombstones by seq (refusal-fallback retraction, resolved
        // user-dialog eviction). The reducer maps the seqs to their uuids
        // and reuses the uuid eviction machinery, so the ordered log and
        // the lifecycle maps stay in lockstep with the window.
        store.dispatch({ type: 'WINDOW_EVICT', seqs: frame.seqs })
        break
      }
      case 'permission-request': {
        // The external onRequest handler drives modal state outside the
        // store; the store action records it for derived selectors.
        handlers.onRequest(frame.payload)
        store.dispatch({ type: 'PERMISSION_REQUEST', request: frame.payload })
        break
      }
      case 'permission-resolved': {
        const resolved = {
          id: frame.id,
          ...frame.decision,
        }
        handlers.onResolved(resolved)
        store.dispatch({ type: 'PERMISSION_RESOLVED', id: frame.id, decision: frame.decision })
        break
      }
      case 'elicitation-request': {
        // External handler drives the auth dialog's local state; unlike
        // permissions there is no transcript-side store action because
        // elicitations render no inline cards.
        handlers.onElicitationRequest?.(frame.payload)
        break
      }
      case 'elicitation-resolved': {
        handlers.onElicitationResolved?.({ id: frame.id, decision: frame.decision })
        break
      }
      case 'dialog-request': {
        // External handler drives the dialog's local state; dialogs render
        // no inline transcript cards (same as elicitations).
        handlers.onDialogRequest?.(frame.payload)
        break
      }
      case 'dialog-resolved': {
        // Eviction is resolution-driven (CLI contract: any choice evicts
        // the refused leg's already-streamed messages) and runs in ONE
        // place — here — so decide/abort/cross-tab all behave the same.
        // For edit_prompt we first lift the evicted leg's last user
        // message text so Chat can prefill the composer with the original
        // question.
        if (frame.retractedMessageUuids?.length) {
          const uuidSet = new Set(frame.retractedMessageUuids)
          if (
            frame.decision.behavior === 'completed' &&
            frame.decision.result === 'edit_prompt'
          ) {
            const lastUserText = store
              .getSnapshot()
              .messages.filter(
                (m) =>
                  uuidSet.has((m as { uuid?: string }).uuid ?? '') &&
                  (m as { type?: string }).type === 'user',
              )
              .map((m) => extractMessagePlainText(m as Parameters<typeof extractMessagePlainText>[0]))
              .filter((t): t is string => !!t)
              .at(-1)
            if (lastUserText) handlers.onEditPrompt?.(lastUserText)
          }
          store.dispatch({ type: 'EVICT_MESSAGES', uuids: frame.retractedMessageUuids })
        }
        handlers.onDialogResolved?.({
          id: frame.id,
          decision: frame.decision,
          retractedMessageUuids: frame.retractedMessageUuids,
        })
        break
      }
      case 'context-usage': {
        store.dispatch({ type: 'CONTEXT_USAGE', usage: frame.usage as ContextUsage })
        break
      }
      case 'prompt-suggestion': {
        store.dispatch({ type: 'PROMPT_SUGGESTION', suggestion: frame.suggestion })
        break
      }
      case 'tasks-snapshot': {
        // Full task-list snapshot from the dedicated `tasks` channel.
        // The reducer also enriches matching activeSubagent records
        // (taskId / progressSummary / lastToolName / background flip).
        store.dispatch({ type: 'TASKS_SNAPSHOT', tasks: frame.tasks ?? [] })
        break
      }
      case 'message-consumed': {
        // Flip the matching user bubble from "queued" to "consumed". If
        // the message itself hasn't arrived yet (frame raced ahead), the
        // reducer stashes the timestamp in pendingConsumedMessages and the
        // message's own broadcast / next page folds it in. Either way
        // the placeholder lookup in applyMessageConsumed self-heals.
        store.dispatch({ type: 'MESSAGE_CONSUMED', uuid: frame.uuid, consumedAt: frame.consumedAt })
        break
      }
      case 'message-steered': {
        // Steered delivery transition: 'injected' flips the bubble chip to
        // "injected"; 'requeued' means the turn ended before delivery and
        // the message went back to the SDK input queue (chip falls back to
        // the normal queued→consumed flow).
        store.dispatch({ type: 'MESSAGE_STEERED', uuid: frame.uuid, state: frame.state })
        break
      }
      case 'messages-withdrawn': {
        // Queued user turns withdrawn by an interrupt with cancelQueued —
        // the server already removed them from its replay ring, so evict
        // the bubbles here too (same machinery as the refusal-fallback
        // eviction). The frame may list CLI-internal uuids this tab never
        // sent; the reducer's lookup simply finds nothing for those.
        if (frame.uuids.length > 0) {
          store.dispatch({ type: 'EVICT_MESSAGES', uuids: frame.uuids })
        }
        break
      }
      case 'error': {
        // If the transcript never became ready (e.g. the subscribe failed
        // because the session was already torn down), MessageList shows an
        // infinite skeleton. Force the ready state so the error becomes
        // visible. WINDOW_BUMP with the CURRENT cursor is the seq-protocol
        // equivalent of the old empty REPLAY_REPLACE: it wipes to the empty
        // live state and flips replayReady. Reached only while no tail page
        // has landed (a landed page sets replayReady) — so the window is
        // empty and nothing is lost by the wipe.
        const errorSnap = store.getSnapshot()
        if (!errorSnap.replayReady) {
          store.dispatch({ type: 'WINDOW_BUMP', generation: errorSnap.generation, headSeq: errorSnap.headSeq })
        }
        store.dispatch({ type: 'ERROR', message: frame.message })
        break
      }
      case 'subscribe-result': {
        // The state half of a subscribe answer (the `error` frame above
        // carries the prose). `ok` means this connection is being served —
        // so a band left by an earlier refusal is stale and must go, since
        // nothing else clears intent.error on a healed panel.
        if (frame.ok === true && store.getSnapshot().error != null) {
          store.dispatch({ type: 'ERROR', message: null })
        }
        break
      }
      case 'session-cleared': {
        // SDK-emitted `cleared` control event (forwarded at server/ws.ts).
        // The local `/clear` command mints a fresh session under a new id
        // and the client swaps panels, so there is no in-place transcript
        // for that path; this handler stays for the SDK's own in-band
        // clears, which append a new init to the on-disk transcript. The
        // server's transcript store bumped its generation
        // (transcript-store.reset: generation+1, seq space zeroed). Wipe
        // to the empty live state (CLEAR_TRANSCRIPT preserves the cursor
        // values — meaningless until the next page re-anchors them), arm
        // the generation floor, and re-fetch the tail: an in-flight tail
        // page that was read BEFORE the clear carries pre-clear content
        // at the old generation, and adopting it on the emptied window
        // would resurrect the cleared transcript AND pin the dead
        // generation (every later page would then mismatch and be
        // ignored). The floor makes such a page retry — the role
        // clearedRef played before the seq protocol.
        store.dispatch({ type: 'CLEAR_TRANSCRIPT' })
        // Arm both stale signals: the floor (post-adoption case) and the
        // epoch — the epoch is what actually invalidates in-flight page
        // requests when NO generation has been adopted yet (the window's
        // cursor is still −1 here, so `generation + 1` degenerates to a
        // floor of 0 that a pre-clear gen-0 page would pass).
        run.minGeneration = store.getSnapshot().generation + 1
        run.clearEpoch++
        handlers.onCleared?.()
        void this.refetchTail(run)
        // The stale failure pill must go with the transcript — its Retry
        // would refetch a cleared window and the pill would stick.
        this.setPaging({ ...this.paging, olderError: null })
        break
      }
      default:
        break
    }
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
