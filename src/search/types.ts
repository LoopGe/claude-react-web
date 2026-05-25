// Shared types for the in-session search subsystem.
//
// Keep this file dependency-free so it can be imported from anywhere
// (UI, tests, normalize layer) without pulling in the unified pipeline.

/** Half-open range [start, end) over the canonical plain-text view of a
 *  message.  Both indices are character offsets in that string. */
export interface Range {
  start: number
  end: number
}

/** A search match against a single TranscriptItem.
 *  `itemIdx` is the index in the unfiltered `items[]` array (so the same
 *  pointer the existing scrollToIndex / search-active-msg highlight is
 *  already consuming).  `count` is the number of `Range`s that matched
 *  the message — used to build the global "N matches" total without
 *  forcing every consumer to recompute ranges. */
export interface SearchHit {
  itemIdx: number
  count: number
}

/** Options accepted by findRanges.  Reserved for future case-sensitive /
 *  whole-word / regex toggles — defaults match the current behaviour
 *  (case-insensitive substring). */
export interface MatchOptions {
  caseSensitive?: boolean
}
