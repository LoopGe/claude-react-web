/**
 * Seq window — the client-side transcript window of the seq-paginated
 * protocol (transcript-seq refactor, Task 7).
 *
 * The window holds the seq-keyed slice of the transcript this tab currently
 * renders, plus the out-of-order buffer (`pending`) for live frames that
 * arrived ahead of their predecessors. All operators are PURE: they clone
 * on write, never mutate the input, and return the SAME object reference
 * when nothing changed (identity-stability is what lets the reducer skip
 * snapshot churn and lets the hook detect holes by comparing snapshots).
 *
 * Semantics (authoritative — from the task brief):
 *
 *  - `liveAppend(w, seq, message, generation)`
 *      · seq === newestSeq + 1 (or the window is empty) → tail append.
 *        If the seq sits in `pending`, it is consumed and any now-contiguous
 *        pending run cascades into the window behind it.
 *      · seq >  newestSeq + 1 → parked in `pending` UNLESS every missing
 *        seq in between is a tombstone (see below — an all-tombstone gap
 *        is unfillable by design, so the seq skips across it); the state
 *        carries the hole marker `{ from: newestSeq + 1, to: seq - 1 }`
 *        (readable via `windowHole(w)` / the `hole` field) — the hook
 *        fetches the REST page over that range to fill it.
 *      · seq <= newestSeq → idempotent drop (already applied, tombstoned,
 *        or a duplicate re-send). Returns `w` unchanged.
 *      · generation mismatch → no-op, returns `w` unchanged.
 *
 *  - `pending` draining: whenever the hole is filled — by `pageLoaded` or
 *    by live appends — the contiguous run starting at newestSeq + 1 is
 *    folded into the window. Tombstoned seqs (see below) are skipped, not
 *    folded: they never carry content.

 *  - Tombstones (`tombstones: Set<number>`): seqs the server has evicted
 *    and will NEVER re-send (interrupt withdrawal tombstones a steered
 *    message while the turn's `result` frame registers on a higher seq —
 *    pages can never return the tombstoned seq, so treating it as a hole
 *    would strand every later frame in `pending` forever). Recorded from
 *    `evictSeqs` (the seq-carrying `messages-evicted` frame / uuid evictions
 *    of server-dead rows) and from `pageLoaded` (`tombstones` on the page
 *    response). The contiguity check and the pending drain skip them; a
 *    live frame AT a tombstoned seq is dropped (never resurrects).
 *
 *  - `pageLoaded(w, { at, messages, hasMore, generation })`
 *      · at 'tail': the newest page (or a hole-filling page in between).
 *      · at 'head': a strictly-older page below `oldestSeq`; `hasMore`
 *        becomes `hasOlder`.
 *      · An empty window adopts the page's generation (the bootstrap —
 *        the store's initial window carries generation -1 precisely so the
 *        first page always matches). A NON-empty window with a mismatched
 *        generation means the page is from a dead universe (/clear or
 *        remote reset): it is ignored and the caller must `bumpGeneration`
 *        first. Task 8's hook detects this by snapshot comparison.
 *
 *  - `evictSeqs(w, seqs)`: removes from window AND pending (server
 *    tombstones — refusal-fallback retraction, dialog-resolved eviction);
 *    oldestSeq/newestSeq recomputed from the remaining contents.
 *
 *  - `bumpGeneration(w, generation, headSeq)`: whole-window invalidation
 *    (/clear, generation mismatch on reconnect). Everything resets; the
 *    transcript above the window is wiped by the reducer, not here.
 *
 * The reducer is the only writer: every WINDOW_* action routes through one
 * of these operators and then applies the newly-windowed messages to the
 * ordered mirror log through the existing applyMessage/prependMessages
 * machinery (see reducer.ts windowPage / windowLive).
 */
import { isEmptyResultFrame } from '../../shared/results.js'
import type { SdkMessage } from '../types'

/** Inclusive hole range [newestSeq + 1, lowestPendingSeq - 1] of missing
 *  seqs between the applied tail and the parked pending frames. Null when
 *  nothing is missing. (Tuple form per the brief's `hole` marker.) */
export type HoleRange = [number, number]

export interface WindowState {
  generation: number
  headSeq: number
  /** seq → message for everything currently applied to the transcript.
   *  Sparse only where evictions tombstoned seqs. */
  window: Map<number, SdkMessage>
  /** null = empty window. Otherwise the seq of the oldest message that
   *  reached the ordered log — slot-routed frames (api_retry slot, empty
   *  results) occupying seqs at the window top are skipped (see
   *  isSlotRouted), because this value is the RENDER ANCHOR
   *  (MessageList's firstItemIndex), not the numeric window minimum. */
  oldestSeq: number | null
  newestSeq: number | null
  hasOlder: boolean
  hasNewer: boolean
  /** Out-of-order live frames parked while a hole precedes them. */
  pending: Map<number, SdkMessage>
  /** Seqs known permanently dead (server tombstones — `TranscriptStore`
   *  never reuses or re-sends them). The contiguity check and the pending
   *  drain skip them; they are never inserted. Cleared by bumpGeneration
   *  (a fresh seq space has no tombstones). */
  tombstones: Set<number>
  /** Live hole marker — set while `pending` holds frames ahead of the
   *  applied tail, cleared when they drain. Derived on every write. */
  hole: HoleRange | null
}

export function emptyWindow(generation: number, headSeq: number): WindowState {
  return {
    generation,
    headSeq,
    window: new Map<number, SdkMessage>(),
    oldestSeq: null,
    newestSeq: null,
    hasOlder: false,
    hasNewer: false,
    pending: new Map<number, SdkMessage>(),
    tombstones: new Set<number>(),
    hole: null,
  }
}

/** The hole a non-empty `pending` implies: [newestSeq + 1, minPending - 1].
 *  Exported for callers that prefer the derivation over the stored field. */
export function windowHole(w: WindowState): HoleRange | null {
  if (w.pending.size === 0) return null
  let min: number | null = null
  for (const seq of w.pending.keys()) {
    if (min === null || seq < min) min = seq
  }
  if (min === null || w.newestSeq === null) return null
  return [w.newestSeq + 1, min - 1]
}

/** Clone a window shallowly (fresh Maps/Set) so operators stay pure. */
function clone(w: WindowState): WindowState {
  return {
    ...w,
    window: new Map(w.window),
    pending: new Map(w.pending),
    tombstones: new Set(w.tombstones),
  }
}

/** Slot-routed frames: the server seq-assigns every isRenderableSdkMessage
 *  frame, a set WIDER than the client's ordered log. `system/api_retry`
 *  renders from its transient slot (applyMessage never lets it into
 *  items/messages) and an empty `result` frame is suppressed outright
 *  (toTranscriptItem → null). Both still enter the window map — membership
 *  is what makes pages/live re-sends idempotent — but they never become
 *  transcript rows, so they must not count toward `oldestSeq`: Task 9
 *  anchors virtuoso's firstItemIndex on it, and a slot-routed seq at the
 *  window top would offset the whole row grid relative to the seq space.
 *  newestSeq is NOT filtered — the tail-contiguity / hole logic is numeric
 *  seq arithmetic and needs the true max. */
function isSlotRouted(msg: SdkMessage): boolean {
  const m = msg as { type?: unknown; subtype?: unknown }
  return (m.type === 'system' && m.subtype === 'api_retry') || isEmptyResultFrame(msg)
}

/** Recompute the derived boundary fields after any contents change. */
function rederive(w: WindowState): WindowState {
  if (w.window.size === 0) {
    w.oldestSeq = null
    w.newestSeq = null
  } else {
    let min = Infinity
    let minAny = Infinity
    let max = -Infinity
    for (const [seq, msg] of w.window) {
      if (seq < minAny) minAny = seq
      if (seq > max) max = seq
      if (!isSlotRouted(msg) && seq < min) min = seq
    }
    // `oldestSeq !== null` must keep meaning "window non-empty" (loadOlder
    // and the empty-window bootstrap gate on it), so a window holding ONLY
    // slot-routed frames falls back to the true min — the anchor is then off
    // by a constant, which virtuoso's row-count arithmetic never sees.
    w.oldestSeq = min !== Infinity ? min : minAny
    w.newestSeq = max
  }
  w.hole = windowHole(w)
  w.hasNewer = w.pending.size > 0
  return w
}

/** Fold the contiguous run at newestSeq+1 into the window: pending frames
 *  move in (their seq becomes newest); tombstoned seqs are skipped WITHOUT
 *  entering the window — they never carry content. newestSeq is only ever
 *  advanced ONTO an inserted pending seq: rederive() recomputes it as the
 *  max window key, so it must never be pushed past a tombstone run.
 *
 *  An EMPTY window (newestSeq === null — a withdrawal can evict every
 *  applied row) has no contiguity anchor: insertMessage treats any seq as
 *  appendable there, so parked frames all drain, in seq order — otherwise a
 *  late tombstone closing the hole could never release them. */
function drainContiguous(w: WindowState): void {
  if (w.newestSeq === null) {
    if (w.pending.size === 0) return
    for (const seq of [...w.pending.keys()].sort((a, b) => a - b)) {
      const message = w.pending.get(seq)
      w.pending.delete(seq)
      if (message !== undefined && !w.tombstones.has(seq)) w.window.set(seq, message)
    }
    return
  }
  let nx = w.newestSeq + 1
  while (w.pending.has(nx) || w.tombstones.has(nx)) {
    if (w.pending.has(nx)) {
      w.window.set(nx, w.pending.get(nx)!)
      w.pending.delete(nx)
      w.newestSeq = nx
    }
    nx++
  }
}

/** Insert one seq-keyed message into a window being built, keeping the
 *  tail contiguous: a seq at or below newest+1 lands in the window (with
 *  its seq becoming newest when it extends the tail, draining any
 *  now-contiguous pending run behind it); a seq beyond the tail parks in
 *  `pending` — but ONLY when a real hole precedes it. A gap of nothing
 *  but tombstones is unfillable by design (pages never return evicted
 *  seqs), so it is skipped across. A seq the server has tombstoned never
 *  resurrects. Shared by liveAppend and pageLoaded — the ONLY behavioural
 *  difference between the two is liveAppend's idempotent `seq <= newest`
 *  drop, which lives in liveAppend itself. */
function insertMessage(w: WindowState, seq: number, message: SdkMessage): void {
  if (w.window.has(seq) || w.pending.has(seq)) return
  if (w.tombstones.has(seq)) return
  if (w.newestSeq !== null && seq > w.newestSeq + 1) {
    for (let nx = w.newestSeq + 1; nx < seq; nx++) {
      if (!w.tombstones.has(nx)) {
        w.pending.set(seq, message)
        return
      }
    }
  }
  w.window.set(seq, message)
  if (w.newestSeq === null || seq > w.newestSeq) {
    w.newestSeq = seq
    drainContiguous(w)
  }
}

export function liveAppend(
  w: WindowState,
  seq: number,
  message: SdkMessage,
  generation: number,
): WindowState {
  if (generation !== w.generation) return w
  // Duplicate of an already-parked frame — idempotent drop.
  if (w.pending.has(seq)) return w
  if (w.newestSeq !== null && seq <= w.newestSeq) return w
  // A tombstoned seq will never (re-)enter the window — drop BEFORE the
  // clone so the identity-stability contract holds for duplicates the
  // server re-sends. A tombstoned seq is always < headSeq (it was
  // allocated), so no headSeq advance is lost here.
  if (w.tombstones.has(seq)) return w

  const next = clone(w)
  // headSeq tracks "next seq the server will allocate" — a live frame at
  // headSeq proves headSeq + 1 is next.
  if (seq >= next.headSeq) next.headSeq = seq + 1
  insertMessage(next, seq, message)
  rederive(next)
  return next
}

export function pageLoaded(
  w: WindowState,
  opts: {
    at: 'tail' | 'head'
    messages: Array<{ seq: number; msg: unknown }>
    hasMore: boolean
    generation: number
    headSeq?: number
    /** Evicted seqs inside this page's covered span — frames that will
     *  never arrive. Recorded BEFORE the insert loop so the contiguity
     *  check skips them (a page can span a tombstone below a visible
     *  newer seq — the interrupt/withdraw race). Recorded unconditionally:
     *  a fresh tab may learn tombstones before it holds any frame. */
    tombstones?: number[]
  },
): WindowState {
  const empty =
    w.window.size === 0 && w.pending.size === 0 && w.oldestSeq === null && w.newestSeq === null
  // Bootstrap: an empty window adopts whatever generation the server page
  // carries. A non-empty window with a mismatched generation is a page from
  // a dead universe — ignore it; the caller must bumpGeneration first.
  if (opts.generation !== w.generation && !empty) return w

  const next = clone(w)
  if (empty) next.generation = opts.generation
  if (opts.headSeq !== undefined && opts.headSeq > next.headSeq) next.headSeq = opts.headSeq
  for (const seq of opts.tombstones ?? []) next.tombstones.add(seq)

  for (const { seq, msg } of opts.messages) {
    // Pages never carry tombstoned seqs (the server filters them and
    // declares them via opts.tombstones instead), so membership — not the
    // `seq <= newest` live-drop rule — decides idempotence here. This is
    // what lets a head page insert seqs below oldestSeq that liveAppend's
    // drop rule would have rejected.
    if (next.window.has(seq) || next.pending.has(seq)) continue
    insertMessage(next, seq, msg as SdkMessage)
  }
  drainContiguous(next)
  next.hasOlder = opts.hasMore
  rederive(next)
  return next
}

export function evictSeqs(
  w: WindowState,
  seqs: number[],
  opts?: { tombstone?: boolean },
): WindowState {
  // Default true: every caller except trimFront evicts SERVER-tombstoned
  // rows (WINDOW_EVICT rides the server-resolved seqs; uuid evictions —
  // withdrawal, refusal-fallback, dialog — are server-dead rows too, with
  // the seqs co-broadcast on messages-evicted). trimFront is a client-side
  // memory trim of rows the server still holds and passes
  // `{ tombstone: false }`.
  const record = opts?.tombstone !== false
  let touched = false
  const next = clone(w)
  for (const seq of seqs) {
    if (next.window.delete(seq)) touched = true
    if (next.pending.delete(seq)) touched = true
    if (record && !next.tombstones.has(seq)) {
      next.tombstones.add(seq)
      touched = true
    }
  }
  if (!touched) return w
  drainContiguous(next)
  rederive(next)
  return next
}

export function bumpGeneration(
  _w: WindowState,
  generation: number,
  headSeq: number,
): WindowState {
  // Whole-window invalidation: nothing survives, so the input is discarded.
  return emptyWindow(generation, headSeq)
}
