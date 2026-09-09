import { describe, it, expect } from 'vitest'
import { countDiffDelta, countHunkDelta } from './diff-shared'
import type { EditDiffHunk } from '../../hooks/useEditDiffInfo'

describe('countDiffDelta', () => {
  it('counts pure additions', () => {
    expect(countDiffDelta('', 'a\nb')).toEqual({ add: 2, del: 0 })
  })

  it('counts pure deletions', () => {
    expect(countDiffDelta('a\nb', '')).toEqual({ add: 0, del: 2 })
  })

  it('counts a replacement as del + add', () => {
    expect(countDiffDelta('old line', 'new line')).toEqual({ add: 1, del: 1 })
  })

  it('reports no change for identical text', () => {
    expect(countDiffDelta('same\nlines', 'same\nlines')).toEqual({ add: 0, del: 0 })
  })

  it('ignores unchanged context lines', () => {
    // Insert a line between two kept lines: +1, no deletes
    expect(countDiffDelta('a\nb', 'a\nx\nb')).toEqual({ add: 1, del: 0 })
  })
})

describe('countHunkDelta', () => {
  const hunk = (lines: string[]): EditDiffHunk => ({
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
    lines,
  })

  it('counts del/add lines, skipping context and no-newline markers', () => {
    expect(
      countHunkDelta([hunk([' foo', '-del', '+add', '\\ No newline at end of file'])]),
    ).toEqual({ add: 1, del: 1 })
  })

  it('reconciles an EOF trailing-newline edit that countDiffDelta miscounts', () => {
    // countDiffDelta on 'foo\nbar\n' → 'foo\nbar' yields {add:0, del:1}: a
    // phantom empty-line deletion (split('\n') leaves a trailing '' element).
    expect(countDiffDelta('foo\nbar\n', 'foo\nbar')).toEqual({ add: 0, del: 1 })
    // structuredPatch materializes the same change as -bar/+bar (jsdiff folds
    // the newline difference onto the last line), which is what the renderer
    // shows when expanded. The hunk-based count above is the matching stat.
    expect(countHunkDelta([hunk(['-bar', '+bar', '\\ No newline at end of file'])])).toEqual({
      add: 1,
      del: 1,
    })
  })

  it('returns zero for an empty hunk set', () => {
    expect(countHunkDelta([])).toEqual({ add: 0, del: 0 })
  })
})
