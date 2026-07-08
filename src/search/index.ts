// Public API for the in-session search subsystem.  Consumers should
// import from "../search" (this barrel) and never reach into individual
// implementation files — that keeps the module's surface area small
// and migrations contained.

export { extractPlainText, extractMessagePlainText, extractToolUseDiffText } from './extract'
export { findRanges, countMatches } from './match'
export { rehypeHighlightQuery } from './rehype-highlight'
export { lineDiff, type LineDiffOp } from './line-diff'
export type { Range, SearchHit, MatchOptions } from './types'
