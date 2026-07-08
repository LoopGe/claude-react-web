// Line-level LCS diff — shared between the diff renderer (ToolUseBlock) and the
// search indexer (extract.ts), so the lines the indexer counts as "the
// modifications" are exactly the del/add lines the renderer draws.
//
// Pure, no deps → safe for both client and server (shared/ is imported by both).

/** One op in an interleaved (equal / delete / add) line diff. `oldIdx` / `newIdx`
 *  are 0-based line numbers in the old / new arrays. */
export type LineDiffOp =
  | { type: 'eq'; oldIdx: number; newIdx: number; text: string }
  | { type: 'del'; oldIdx: number; newIdx: number; text: string }
  | { type: 'add'; oldIdx: number; newIdx: number; text: string }

/** Line-level LCS diff of two line arrays → interleaved op sequence (eq / del /
 *  add) in unified-diff reading order (claude-code / `git diff`), not a
 *  before/after split.
 *
 *  O(M·N) DP is fine here: old_string / new_string are edit fragments, not
 *  whole files, so M and N are small (typically <100 lines). */
export function lineDiff(oldLines: readonly string[], newLines: readonly string[]): LineDiffOp[] {
  const m = oldLines.length
  const n = newLines.length
  if (m === 0) return newLines.map((text, j) => ({ type: 'add' as const, oldIdx: 0, newIdx: j, text }))
  if (n === 0) return oldLines.map((text, i) => ({ type: 'del' as const, oldIdx: i, newIdx: 0, text }))

  // LCS length DP, built from the bottom-right so we can walk forward.
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    const row = dp[i]
    const next = dp[i + 1]
    const oi = oldLines[i]
    for (let j = n - 1; j >= 0; j--) {
      row[j] = oi === newLines[j] ? next[j + 1] + 1 : Math.max(next[j], row[j + 1])
    }
  }

  const ops: LineDiffOp[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ type: 'eq', oldIdx: i, newIdx: j, text: oldLines[i] })
      i++; j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', oldIdx: i, newIdx: j, text: oldLines[i] })
      i++
    } else {
      ops.push({ type: 'add', oldIdx: i, newIdx: j, text: newLines[j] })
      j++
    }
  }
  while (i < m) {
    ops.push({ type: 'del', oldIdx: i, newIdx: j, text: oldLines[i] })
    i++
  }
  while (j < n) {
    ops.push({ type: 'add', oldIdx: i, newIdx: j, text: newLines[j] })
    j++
  }
  return ops
}
