/**
 * Transcript entrance animations.
 *
 * Two independent one-shot animations:
 *
 *   ROW ENTRANCE  `.msg-enter` on a row that genuinely just arrived live.
 *   TRANSCRIPT REVEAL  a whole-list fade for the first ready transcript of a
 *                      key — a session switch is one transition, not a batch
 *                      of arrivals. Driven by React STATE: a pending hold at
 *                      opacity 0, then a flip that (in ONE commit) puts
 *                      `.chat-messages-reveal` on the container and the
 *                      snapshot-scoped `.transcript-reveal-row` class on the
 *                      rows that were in the DOM at the flip. React is the
 *                      single writer of every class — an imperatively-added
 *                      class here was being stripped by the next className
 *                      commit before the animation ever started.
 *
 * Row-entrance bookkeeping still happens DURING render (so the armed flag
 * commits in the same pass as the row it belongs to) and is cleaned up by
 * writing classes straight onto the DOM node (so a later re-render or a
 * scroll-driven re-mount can't replay them).
 *
 * Extracted from MessageList because the hard part isn't the CSS, it's the set
 * of cases that must NOT animate; keeping that reasoning in one file is the
 * only way it stays reviewable.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type AnimationEvent, type RefObject } from 'react'
import { shouldArmEnterAnimation } from '../../utils/enter-animation'
import type { TranscriptRow } from './transcript-rows'

/** Entrance-animation gate tunables.
 *  MAX_ENTER_BATCH — only animate when the tail grows by at most this many ids
 *    at once; a larger jump means a bulk load (replay / page), not a live
 *    trickle.
 *  ENTER_MAX_AGE_MS — a tail id only animates if its receivedAt is within this
 *    window, so disk-restored history can't animate even if it somehow reaches
 *    the tail path.
 *  KNOWN_IDS_CAP — hard bound on the seen-id set for very long sessions. */
const MAX_ENTER_BATCH = 4
const ENTER_MAX_AGE_MS = 10_000
const KNOWN_IDS_CAP = 4000

/** Fallback window for clearing an armed flag when `animationend` never fires
 *  (the row was scrolled out and unmounted mid-animation). The CSS animation is
 *  ~240ms, so this is comfortably past it. */
const ENTER_CLEANUP_MS = 400

/** Tail window and step for the reveal stagger, applied once at the flip
 *  (DOM-order formula over the rows present, frozen into the snapshot) —
 *  module-private because nothing outside this hook reads them. */
const REVEAL_STAGGER_TAIL = 8
const REVEAL_STAGGER_STEP_MS = 24

/** The transcript row wrapper class. Single source for MessageList's
 *  itemContent (where it's applied), this hook's release poll (where its
 *  presence in the DOM is the "Virtuoso has rendered rows" gate), and
 *  chat.css's `.transcript-reveal-row` companion rule (textual — CSS can't
 *  import TS; a rename here must be mirrored there). */
export const TRANSCRIPT_ROW_CLASS = 'virtuoso-item-wrapper'

/** Row class applied — via MessageList's itemContent, from React state — to
 *  the rows present in the DOM at the reveal flip. Drives the per-row
 *  transcript-item-reveal animation (chat.css). Snapshot-scoped ON PURPOSE:
 *  rows that mount AFTER the flip are live arrivals and keep their own
 *  msg-enter semantics instead of inheriting a staggered reveal whose
 *  time-boxed window can't cover them. */
export const TRANSCRIPT_REVEAL_ROW_CLASS = 'transcript-reveal-row'

/** Fallback close for `.chat-messages-reveal`, used only when a snapshot
 *  row's animationend never arrives (it was unmounted mid-animation by a
 *  scroll). The primary close is the LAST row's animationend
 *  (handleRevealRowAnimationEnd), so a token retune that lengthens the row
 *  animation extends the real window automatically; this fallback just needs
 *  to outlive the plausible maximum (delay 7×24 + --motion-duration-moderate
 *  240ms ≈ 408ms per tokens.css — keep the comment in sync) plus margin. */
const REVEAL_WINDOW_FALLBACK_MS = (REVEAL_STAGGER_TAIL - 1) * REVEAL_STAGGER_STEP_MS + 240 + 900

export interface UseTranscriptAnimationsOptions {
  rows: readonly TranscriptRow[]
  /** False while the initial replay is still streaming in. Gates both
   *  animations so a bulk load never animates. */
  replayReady: boolean
  /** Transcript identity. A new key is a new whole-list reveal. */
  transcriptRevealKey: string | undefined
}

/** Frozen reveal state: the row ids present in the DOM at the flip (the only
 *  rows that play the entrance) and each one's stagger delay in ms. Null
 *  before the flip and after the close window. */
export interface RevealSnapshot {
  rowIds: ReadonlySet<string>
  staggerById: ReadonlyMap<string, number>
}

export interface TranscriptAnimationsApi {
  /** Attach to the `.chat-messages` element — the reveal operates on it. */
  messagesElRef: RefObject<HTMLDivElement | null>
  /** True while the transcript is armed but not yet revealed, i.e. rendered at
   *  opacity 0. Callers also use this to suppress chrome that would otherwise
   *  flash over the invisible list. */
  isTranscriptRevealPending: boolean
  /** Non-null while `.chat-messages-reveal` is on the container (declared by
   *  the caller's className from this state) and the snapshot rows are
   *  animating. Shrinks as rows report their animationend; null once every
   *  row finished (or via the fallback timer). */
  reveal: RevealSnapshot | null
  /** Is this row playing its one-shot entrance animation? */
  isRowEntering: (rowId: string) => boolean
  /** Ref callback for an entering row's wrapper (arms the fallback cleanup). */
  enterNodeRef: (node: HTMLDivElement | null) => void
  handleEnterAnimationEnd: (e: AnimationEvent<HTMLDivElement>) => void
  /** Record a snapshot row's transcript-item-reveal animationend: drops it
   *  from the snapshot (so a scroll-driven remount inside the window renders
   *  plain instead of replaying) and closes the reveal entirely when it was
   *  the last one. */
  handleRevealRowAnimationEnd: (rowId: string) => void
}

export function useTranscriptAnimations({
  rows,
  replayReady,
  transcriptRevealKey,
}: UseTranscriptAnimationsOptions): TranscriptAnimationsApi {
  // --- Row entrance gate --------------------------------------------------
  // Goal: play a one-shot "rise + blur-in" on rows that genuinely just
  // ARRIVED live — never on the initial replay, session switches, loadOlder
  // history prepends, the optimistic echo user-message swap, or Virtuoso
  // re-mounting an off-screen row as the user scrolls.
  //
  // The discriminator is "a small batch of previously-unseen ids appended at
  // the TAIL of a non-empty list, each stamped with a recent wall-clock
  // receivedAt". That single rule excludes every non-arrival case:
  //   - initial replay / session switch — grows from empty (prevLen 0) or adds
  //     many ids at once — skipped by the prevLen>0 + batch-size guards.
  //   - loadOlder prepend — ids appear at the FRONT, not at indices >= prevLen
  //     — not tail-appends — skipped.
  //   - optimistic echo swap — in-place replace at an existing index, list
  //     length unchanged — no index >= prevLen — skipped (the optimistic
  //     insert already animated the pop).
  //   - scroll re-mount — id already in knownIdsRef and already consumed from
  //     enterIdsRef — skipped.
  // receivedAt recency disambiguates a freshly-typed first message (animate)
  // from a replayed single-message session (history timestamp is stale).
  const knownIdsRef = useRef<Set<string>>(new Set())
  const enterIdsRef = useRef<Set<string>>(new Set())
  // ids for which the post-animation cleanup timeout has already been
  // scheduled, so we schedule exactly one per armed row (see enterNodeRef).
  const enterCleanupScheduledRef = useRef<Set<string>>(new Set())
  const prevLenRef = useRef(0)
  // Tracks the id of the last row so the gate can detect an in-place echo
  // replacement (optimistic id → server uuid at the same tail position) and
  // transfer the entering flag for a seamless animation.
  const prevLastIdRef = useRef<string | null>(null)
  // Whole-transcript reveal gate. It arms only for the first ready transcript
  // for a key, so an empty session's first live message keeps using the
  // row-level msg-enter animation instead of also fading the whole scroller.
  const consumedTranscriptKeyRef = useRef<string | undefined>(undefined)
  const pendingTranscriptRevealKeyRef = useRef<string | undefined>(undefined)
  const messagesElRef = useRef<HTMLDivElement | null>(null)
  // Release phase in React STATE — the single writer of the reveal classes.
  // Flipping state (instead of adding classes from the rAF poll) means the
  // className commit that removes the pending hold ALSO applies the reveal —
  // atomically and declaratively — so later re-renders re-commit the identical
  // strings instead of stripping DOM-written classes before the animation
  // starts. The snapshot freezes WHICH rows animate (those in the DOM at the
  // flip) and their stagger (original DOM-order tail formula), so the
  // time-boxed window only ever covers rows that existed when it opened —
  // rows mounting later keep their own msg-enter semantics.
  const [reveal, setReveal] = useState<RevealSnapshot | null>(null)
  // Reset the phase when the transcript identity changes (session switch /
  // overlay retarget — the key CAN change within one MessageList instance,
  // e.g. SubagentOverlay's `subagent:${currentId}`). Render-phase adjustment
  // (setState-during-render for the SAME component), mirroring the
  // expandedBodies reset above it in MessageList.
  const [prevRevealPhaseKey, setPrevRevealPhaseKey] = useState(transcriptRevealKey)
  if (prevRevealPhaseKey !== transcriptRevealKey) {
    setPrevRevealPhaseKey(transcriptRevealKey)
    setReveal(null)
  }

  /* eslint-disable react-hooks/refs -- ref reads/writes during render commit
     the enter-set together with the row list, mirroring the row-anchor block
     in MessageList. Both are idempotent w.r.t. the current render. */
  {
    const prevLen = prevLenRef.current
    const curLen = rows.length
    // Tail-append candidates: ids at index >= prevLen that we've never seen.
    // Only considered when the list grew by a small delta (live arrivals
    // trickle in 1-2 at a time; bulk loads add many at once).
    //
    // prevLen may be 0 for the very first message in a session — that case is
    // fine because receivedAt recency (ENTER_MAX_AGE_MS) and the batch-size
    // guard (MAX_ENTER_BATCH) together prevent initial replay / session-switch
    // bulk loads from animating. A disk-restored single-message session also
    // won't animate (receivedAt is undefined).
    const delta = curLen - prevLen
    const armed = shouldArmEnterAnimation(replayReady, delta, prevLen, MAX_ENTER_BATCH)
    if (armed) {
      // eslint-disable-next-line react-hooks/purity -- Date.now() gates animation recency; a stale value at worst skips one animation, never corrupts state.
      const now = Date.now()
      for (let i = prevLen; i < curLen; i++) {
        const row = rows[i]
        if (knownIdsRef.current.has(row.id)) continue
        if (typeof row.receivedAt === 'number' && now - row.receivedAt < ENTER_MAX_AGE_MS) {
          enterIdsRef.current.add(row.id)
        }
      }
    }
    // Echo-replacement transfer: when the server echo replaces the optimistic
    // placeholder in-place (same index, same list length, different id), the
    // new id should inherit the entering flag so the animation continues
    // seamlessly rather than snapping to a static bubble mid-transition. Only
    // the last row is checked — the tail window where replacements actually
    // happen — to keep this O(1) instead of scanning the whole list.
    {
      const prevLastId = prevLastIdRef.current
      const curLastId = curLen > 0 ? rows[curLen - 1].id : null
      if (
        prevLastId != null &&
        curLastId != null &&
        curLastId !== prevLastId &&
        enterIdsRef.current.has(prevLastId)
      ) {
        enterIdsRef.current.delete(prevLastId)
        enterIdsRef.current.add(curLastId)
      }
      prevLastIdRef.current = curLastId
    }
    // Record every current id so a later in-place swap / re-mount of the same
    // message is recognised as already-seen and never re-animates.
    //
    // Gated on `delta !== 0` (the list actually grew or shrank) so the O(n)
    // loop doesn't run on every streaming-token render — during streaming the
    // row list keeps the same length (LIVE_TURN_FLUSH only mutates liveTurn,
    // not items), so the set is already fully populated and every add here
    // would be a no-op. For a 1000-message transcript at ~12fps streaming
    // that's ~12k wasted Set.add calls/sec otherwise.
    //
    // A length-preserving in-place swap (optimistic echo → server uuid at the
    // same index, delta === 0) skips this — the swapped-in id is recorded on
    // the next genuine append. That's safe: re-mounts never re-animate anyway
    // (the `armed` gate requires delta > 0), and the transfer block above
    // already moved the entering flag to the new id.
    if (delta !== 0) {
      for (const row of rows) knownIdsRef.current.add(row.id)
      // Bound the set so a multi-thousand-message session doesn't leak ids.
      if (knownIdsRef.current.size > KNOWN_IDS_CAP) {
        const live = new Set(rows.map((r) => r.id))
        for (const id of enterIdsRef.current) live.add(id)
        knownIdsRef.current = live
      }
    }
    prevLenRef.current = curLen
  }

  // Whole-transcript reveal arming. Deliberately in render (not an effect) so
  // the pending flag — which renders the list at opacity 0 — commits in the
  // same pass as the ready transcript, and the first visible frame is hidden
  // until Virtuoso exposes its measured list.
  if (transcriptRevealKey == null) {
    pendingTranscriptRevealKeyRef.current = undefined
  } else if (
    pendingTranscriptRevealKeyRef.current === transcriptRevealKey &&
    rows.length === 0
  ) {
    // Armed but the transcript emptied before the release landed (EVICT_MESSAGES,
    // mid-replay /clear) — drop the hold so the empty state isn't stuck at
    // opacity 0 with the poll waiting on rows that will never come.
    pendingTranscriptRevealKeyRef.current = undefined
  } else if (replayReady && consumedTranscriptKeyRef.current !== transcriptRevealKey) {
    consumedTranscriptKeyRef.current = transcriptRevealKey
    pendingTranscriptRevealKeyRef.current = rows.length > 0 ? transcriptRevealKey : undefined
  }
  const isTranscriptRevealPending =
    transcriptRevealKey != null && pendingTranscriptRevealKeyRef.current === transcriptRevealKey
  // Ids of the CURRENT rows, refreshed every render of the pending window
  // (after the arming block above, so the render that arms is covered too).
  // The release poll cross-checks the wrappers it found in the DOM against
  // this set: on a reused MessageList whose transcriptRevealKey changes
  // (SubagentOverlay / WorkflowOverlay retargets), Virtuoso swaps its rows on
  // its own rAF-scheduled cycle, so the poll's tick can land while the DOM
  // still holds the OUTGOING transcript's rows — snapshotting those would
  // consume the one-shot against ids that are about to unmount, leaving the
  // new transcript's rows with no reveal. Requiring EVERY found wrapper to
  // belong to the current rows closes that stale-DOM variant the same way the
  // rowsRendered gate closed the empty-DOM one.
  const pendingRowIdsRef = useRef<Set<string>>(new Set())
  if (isTranscriptRevealPending) {
    pendingRowIdsRef.current = new Set(rows.map((r) => r.id))
  }
  /* eslint-enable react-hooks/refs */

  const isRowEntering = useCallback((rowId: string) => enterIdsRef.current.has(rowId), [])

  // Consume an entrance flag when the animation ends and strip the class off
  // the DOM node directly, so the next render and any later scroll-driven
  // re-mount of the same row can't replay it.
  const handleEnterAnimationEnd = useCallback((e: AnimationEvent<HTMLDivElement>) => {
    const id = e.currentTarget.dataset.enterId
    if (id) {
      enterIdsRef.current.delete(id)
      enterCleanupScheduledRef.current.delete(id)
    }
    e.currentTarget.classList.remove('msg-enter')
  }, [])

  // Ref callback attached to the entering row's wrapper on mount. Schedules a
  // single fallback timeout that clears the armed flag after the animation
  // duration (+ buffer). Safety net for the case a "delete on first render"
  // approach was trying to plug: if Virtuoso unmounts the row before
  // `animationend` fires (the user scrolled it out mid-animation), the event
  // never arrives and the flag would linger in `enterIdsRef` — so a later
  // scroll-back remount would replay the entrance. The timeout clears the flag
  // so that remount renders without the class. (The common path — row stays
  // mounted — clears via animationend, well under the timeout.)
  const enterNodeRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return
    const id = node.dataset.enterId
    if (!id) return
    if (enterCleanupScheduledRef.current.has(id)) return
    enterCleanupScheduledRef.current.add(id)
    setTimeout(() => {
      enterIdsRef.current.delete(id)
      enterCleanupScheduledRef.current.delete(id)
    }, ENTER_CLEANUP_MS)
  }, [])

  // Release the reveal once Virtuoso has actually exposed its measured list —
  // and has actually RENDERED rows into it.
  //
  // Two gates, because each alone mis-fires:
  //
  //  1. visibility — Virtuoso renders its item-list at `visibility: hidden`
  //     until it has scrolled to `initialTopMostItemIndex`, so revealing
  //     before then would fade in an empty box. Poll across frames for that
  //     visibility flip.
  //  2. rendered rows — the item-list ELEMENT mounts visible (the hidden-flip
  //     is applied asynchronously after mount), so on a warm transcript the
  //     first poll tick can pass gate 1 while Virtuoso's listState is still
  //     empty. Releasing there consumed the one-shot reveal into an empty
  //     container and left every subsequently-mounted row with NO entrance
  //     animation — the intermittent group-switch / reload skip. Requiring a
  //     rendered row wrapper closes it.
  //
  // The flip itself is React state, not a DOM class write: see `reveal`.
  // The stagger snapshot is taken from DOM order at the flip — the exact
  // formula the original imperative implementation used — and frozen there,
  // so a message arriving during the window can't shift an already-running
  // row's animation-delay.
  useLayoutEffect(() => {
    if (transcriptRevealKey == null || pendingTranscriptRevealKeyRef.current !== transcriptRevealKey) return

    let cancelled = false
    let raf1 = 0
    let raf2 = 0
    const waitForRenderedRows = () => {
      if (cancelled) return
      const el = messagesElRef.current
      const list = el?.querySelector('[data-testid="virtuoso-item-list"]')
      const exposed = list != null && getComputedStyle(list).visibility !== 'hidden'
      const wrappers = el?.querySelectorAll<HTMLElement>(`.${TRANSCRIPT_ROW_CLASS}`)
      // EVERY wrapper must belong to the CURRENT rows — a reused MessageList
      // retargeting its key can briefly show the outgoing transcript's rows
      // (see pendingRowIdsRef above).
      const rowsRendered =
        (wrappers?.length ?? 0) > 0 &&
        Array.from(wrappers!).every((w) => {
          const id = w.dataset.messageId
          return id != null && pendingRowIdsRef.current.has(id)
        })
      if (!exposed || !rowsRendered) {
        raf2 = requestAnimationFrame(waitForRenderedRows)
        return
      }
      if (!el || pendingTranscriptRevealKeyRef.current !== transcriptRevealKey) return
      pendingTranscriptRevealKeyRef.current = undefined
      const snapshotRows = Array.from(wrappers!)
      const staggerFloor = Math.max(0, snapshotRows.length - REVEAL_STAGGER_TAIL)
      const rowIds = new Set<string>()
      const staggerById = new Map<string, number>()
      snapshotRows.forEach((row, index) => {
        const id = row.dataset.messageId
        if (!id) return
        rowIds.add(id)
        staggerById.set(id, Math.max(0, index - staggerFloor) * REVEAL_STAGGER_STEP_MS)
      })
      setReveal({ rowIds, staggerById })
    }
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(waitForRenderedRows)
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, [transcriptRevealKey, replayReady, rows.length])

  // A snapshot row finished its entrance: drop it from the snapshot so a
  // scroll-driven remount inside the window renders plain instead of
  // replaying, and close the reveal entirely when it was the last one — the
  // primary window close, which tracks the ACTUAL animation end (the fallback
  // timer below only covers rows whose animationend never fires because a
  // scroll unmounted them mid-flight).
  const handleRevealRowAnimationEnd = useCallback((rowId: string) => {
    setReveal((prev) => {
      if (!prev || !prev.rowIds.has(rowId)) return prev
      const rowIds = new Set(prev.rowIds)
      rowIds.delete(rowId)
      if (rowIds.size === 0) return null
      const staggerById = new Map(prev.staggerById)
      staggerById.delete(rowId)
      return { rowIds, staggerById }
    })
  }, [setReveal])

  // Fallback close for the reveal window: fires only if some snapshot row's
  // animationend never arrives (it was unmounted mid-animation by a scroll).
  useEffect(() => {
    if (!reveal) return
    const timer = window.setTimeout(() => setReveal(null), REVEAL_WINDOW_FALLBACK_MS)
    return () => window.clearTimeout(timer)
  }, [reveal])

  return {
    messagesElRef,
    isTranscriptRevealPending,
    reveal,
    isRowEntering,
    enterNodeRef,
    handleEnterAnimationEnd,
    handleRevealRowAnimationEnd,
  }
}
