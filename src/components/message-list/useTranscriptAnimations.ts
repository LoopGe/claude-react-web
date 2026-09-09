/**
 * Transcript entrance animations.
 *
 * Two independent one-shot animations, both driven by bookkeeping that has to
 * happen DURING render (so the armed flag commits in the same pass as the row
 * it belongs to) and cleaned up by writing classes straight onto the DOM node
 * (so a later re-render or a scroll-driven re-mount can't replay them):
 *
 *   ROW ENTRANCE  `.msg-enter` on a row that genuinely just arrived live.
 *   TRANSCRIPT REVEAL  a whole-list fade for the first ready transcript of a
 *                      key — a session switch is one transition, not a batch
 *                      of arrivals.
 *
 * Extracted from MessageList because the hard part isn't the CSS, it's the set
 * of cases that must NOT animate; keeping that reasoning in one file is the
 * only way it stays reviewable.
 */
import { useCallback, useLayoutEffect, useRef, type AnimationEvent, type RefObject } from 'react'
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

/** How many trailing rows get a staggered reveal delay, and the step. */
const REVEAL_STAGGER_TAIL = 8
const REVEAL_STAGGER_STEP_MS = 24

export interface UseTranscriptAnimationsOptions {
  rows: readonly TranscriptRow[]
  /** False while the initial replay is still streaming in. Gates both
   *  animations so a bulk load never animates. */
  replayReady: boolean
  /** Transcript identity. A new key is a new whole-list reveal. */
  transcriptRevealKey: string | undefined
}

export interface TranscriptAnimationsApi {
  /** Attach to the `.chat-messages` element — the reveal operates on it. */
  messagesElRef: RefObject<HTMLDivElement | null>
  /** True while the transcript is armed but not yet revealed, i.e. rendered at
   *  opacity 0. Callers also use this to suppress chrome that would otherwise
   *  flash over the invisible list. */
  isTranscriptRevealPending: boolean
  handleTranscriptRevealEnd: (e: AnimationEvent<HTMLDivElement>) => void
  /** Is this row playing its one-shot entrance animation? */
  isRowEntering: (rowId: string) => boolean
  /** Ref callback for an entering row's wrapper (arms the fallback cleanup). */
  enterNodeRef: (node: HTMLDivElement | null) => void
  handleEnterAnimationEnd: (e: AnimationEvent<HTMLDivElement>) => void
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
  } else if (replayReady && consumedTranscriptKeyRef.current !== transcriptRevealKey) {
    consumedTranscriptKeyRef.current = transcriptRevealKey
    pendingTranscriptRevealKeyRef.current = rows.length > 0 ? transcriptRevealKey : undefined
  }
  const isTranscriptRevealPending =
    transcriptRevealKey != null && pendingTranscriptRevealKeyRef.current === transcriptRevealKey
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

  const handleTranscriptRevealEnd = useCallback((e: AnimationEvent<HTMLDivElement>) => {
    if (e.animationName === 'transcript-item-reveal' && e.target instanceof HTMLElement) {
      e.target.classList.remove('transcript-item-reveal')
      e.target.style.animationDelay = ''
      return
    }
    if (e.target === e.currentTarget && e.animationName === 'transcript-reveal') {
      e.currentTarget.classList.remove('chat-messages-reveal')
    }
  }, [])

  // Release the reveal once Virtuoso has actually exposed its measured list.
  //
  // Virtuoso renders its item-list at `visibility: hidden` until it has
  // scrolled to `initialTopMostItemIndex`, so revealing before then would fade
  // in an empty box. Poll across frames for that visibility flip, then swap the
  // pending class for the running one and stagger the trailing rows.
  useLayoutEffect(() => {
    if (transcriptRevealKey == null || pendingTranscriptRevealKeyRef.current !== transcriptRevealKey) return

    let cancelled = false
    let raf1 = 0
    let raf2 = 0
    const waitForVisibleList = () => {
      if (cancelled) return
      const el = messagesElRef.current
      const list = el?.querySelector('[data-testid="virtuoso-item-list"]')
      const visible = list != null && getComputedStyle(list).visibility !== 'hidden'
      if (!visible) {
        raf2 = requestAnimationFrame(waitForVisibleList)
        return
      }
      if (!el || pendingTranscriptRevealKeyRef.current !== transcriptRevealKey) return
      pendingTranscriptRevealKeyRef.current = undefined
      el.classList.remove('chat-messages-reveal-pending')
      el.classList.add('chat-messages-reveal')
      const revealRows = Array.from(el.querySelectorAll<HTMLElement>('.virtuoso-item-wrapper'))
      const revealTailStart = Math.max(0, revealRows.length - REVEAL_STAGGER_TAIL)
      revealRows.forEach((row, index) => {
        row.classList.add('transcript-item-reveal')
        row.style.animationDelay = `${Math.max(0, index - revealTailStart) * REVEAL_STAGGER_STEP_MS}ms`
      })
    }
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(waitForVisibleList)
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, [transcriptRevealKey, replayReady, rows.length])

  return {
    messagesElRef,
    isTranscriptRevealPending,
    handleTranscriptRevealEnd,
    isRowEntering,
    enterNodeRef,
    handleEnterAnimationEnd,
  }
}
