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
 *      · seq >  newestSeq + 1 → parked in `pending`; the state carries the
 *        hole marker `{ from: newestSeq + 1, to: seq - 1 }` (readable via
 *        `windowHole(w)` / the `hole` field) — the hook fetches the REST
 *        page over that range to fill it.
 *      · seq <= newestSeq → idempotent drop (already applied, tombstoned,
 *        or a duplicate re-send). Returns `w` unchanged.
 *      · generation mismatch → no-op, returns `w` unchanged.
 *
 *  - `pending` draining: whenever the hole is filled — by `pageLoaded` or
 *    by live appends — the contiguous run starting at newestSeq + 1 is
 *    folded into the window.
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
  /** null = empty window. */
  oldestSeq: number | null
  newestSeq: number | null
  hasOlder: boolean
  hasNewer: boolean
  /** Out-of-order live frames parked while a hole precedes them. */
  pending: Map<number, SdkMessage>
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

/** Clone a window shallowly (fresh Maps) so operators stay pure. */
function clone(w: WindowState): WindowState {
  return {
    ...w,
    window: new Map(w.window),
    pending: new Map(w.pending),
  }
}

/** Recompute the derived boundary fields after any contents change. */
function rederive(w: WindowState): WindowState {
  if (w.window.size === 0) {
    w.oldestSeq = null
    w.newestSeq = null
  } else {
    let min = Infinity
    let max = -Infinity
    for (const seq of w.window.keys()) {
      if (seq < min) min = seq
      if (seq > max) max = seq
    }
    w.oldestSeq = min
    w.newestSeq = max
  }
  w.hole = windowHole(w)
  w.hasNewer = w.pending.size > 0
  return w
}

/** Insert one seq-keyed message into a window being built, keeping the
 *  tail contiguous: a seq at or below newest+1 lands in the window (with
 *  its seq becoming newest when it extends the tail, cascading any
 *  now-contiguous pending run behind it); a seq beyond the tail parks in
 *  `pending`. Shared by liveAppend and pageLoaded — the ONLY behavioural
 *  difference between the two is liveAppend's idempotent `seq <= newest`
 *  drop, which lives in liveAppend itself. */
function insertMessage(w: WindowState, seq: number, message: SdkMessage): void {
  if (w.window.has(seq) || w.pending.has(seq)) return
  if (w.newestSeq !== null && seq > w.newestSeq + 1) {
    w.pending.set(seq, message)
    return
  }
  w.window.set(seq, message)
  if (w.newestSeq === null || seq > w.newestSeq) {
    w.newestSeq = seq
    let nx = seq + 1
    while (w.pending.has(nx)) {
      w.window.set(nx, w.pending.get(nx)!)
      w.pending.delete(nx)
      w.newestSeq = nx
      nx++
    }
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

  for (const { seq, msg } of opts.messages) {
    // Pages never carry tombstoned seqs (the server filters them), so
    // membership — not the `seq <= newest` live-drop rule — decides
    // idempotence here. This is what lets a head page insert seqs below
    // oldestSeq that liveAppend's drop rule would have rejected.
    if (next.window.has(seq) || next.pending.has(seq)) continue
    insertMessage(next, seq, msg as SdkMessage)
  }
  next.hasOlder = opts.hasMore
  rederive(next)
  return next
}

export function evictSeqs(w: WindowState, seqs: number[]): WindowState {
  let touched = false
  const next = clone(w)
  for (const seq of seqs) {
    if (next.window.delete(seq)) touched = true
    if (next.pending.delete(seq)) touched = true
  }
  if (!touched) return w
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
