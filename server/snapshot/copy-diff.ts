/**
 * Line comparison of two captured file sides (gitignored / out-of-scope
 * paths), bounded by a timeout that degrades to whole-file replacement.
 * The emitted patch is git-style unified text so the client's existing
 * `parseUnifiedDiff` / `DiffView` render it unchanged.
 */
import { readFile } from 'node:fs/promises'
import { structuredPatch } from 'diff'
import { MAX_DIFF_LINES } from '../constants.js'
import type { FileCopy } from './capture.js'

/** Context lines around each change, the unified-diff default. */
const CONTEXT_LINES = 3

/** What a captured pair compares to. */
export interface CopyComparison {
  added: number
  deleted: number
  binary: boolean
  oversized: boolean
  /** Absent when the sides hold the same lines, or when a side is binary/oversized. */
  patch?: string
  /** True when `patch` was clipped to MAX_DIFF_LINES. */
  truncated: boolean
  /** Unclipped line count of the patch body. */
  totalLines: number
}

/** A side larger than any stored copy already refused before this runs. */
const OVERSIZED = Symbol('oversized')

/** One side's text with every line terminated, so the last line compares by content alone. */
function terminated(text: string): string {
  return text === '' || text.endsWith('\n') ? text : `${text}\n`
}

/** Content lines of a terminated text; empty text is zero lines. */
function lineCount(text: string): number {
  return text === '' ? 0 : text.slice(0, -1).split('\n').length
}

async function readText(copy: FileCopy, maxBytes: number): Promise<string | null | typeof OVERSIZED> {
  switch (copy.kind) {
    case 'absent': return null
    case 'oversized': return OVERSIZED
    case 'file': {
      const bytes = await readFile(copy.file)
      return bytes.length > maxBytes ? OVERSIZED : bytes.toString('utf8')
    }
  }
}

/**
 * Compare two captured sides.
 * @param before - the turn-start capture.
 * @param after - the turn-end capture.
 * @param display - path label used in the patch headers.
 * @param maxBytes - inclusive byte cap on either side's stored copy.
 * @param timeoutMs - milliseconds the line comparison may run before degrading.
 * @returns counts, the patch, and its truncation state.
 */
export async function compareCopies(
  before: FileCopy,
  after: FileCopy,
  display: string,
  maxBytes: number,
  timeoutMs = 100,
): Promise<CopyComparison> {
  const empty: CopyComparison = { added: 0, deleted: 0, binary: false, oversized: false, truncated: false, totalLines: 0 }
  if (before.kind === 'oversized' || after.kind === 'oversized') return { ...empty, oversized: true }
  if ((before.kind === 'file' && before.binary) || (after.kind === 'file' && after.binary)) return { ...empty, binary: true }

  const [oldText, newText] = await Promise.all([readText(before, maxBytes), readText(after, maxBytes)])
  if (oldText === OVERSIZED || newText === OVERSIZED) return { ...empty, oversized: true }

  if (oldText === null && newText === null) return empty
  if (oldText === null) {
    const added = lineCount(terminated(newText!))
    return finish([
      `--- /dev/null`,
      `+++ b/${display}`,
      `@@ -1,0 +1,${added} @@`,
      ...terminated(newText!).slice(0, -1).split('\n').map((line) => `+${line}`),
    ], added, 0)
  }
  if (newText === null) {
    const deleted = lineCount(terminated(oldText))
    return finish([
      `--- a/${display}`,
      `+++ /dev/null`,
      `@@ -1,${deleted} +1,0 @@`,
      ...terminated(oldText).slice(0, -1).split('\n').map((line) => `-${line}`),
    ], 0, deleted)
  }

  const oldBody = terminated(oldText)
  const newBody = terminated(newText)
  if (oldBody === newBody) return empty
  const patch = structuredPatch('', '', oldBody, newBody, undefined, undefined, {
    context: CONTEXT_LINES,
    timeout: timeoutMs,
  })

  let hunkLines: string[]
  if (patch === undefined) {
    // Timed out: one hunk replacing every line, the documented degradation.
    const oldLines = oldBody === '' ? [] : oldBody.slice(0, -1).split('\n')
    const newLines = newBody === '' ? [] : newBody.slice(0, -1).split('\n')
    hunkLines = [
      `--- a/${display}`,
      `+++ b/${display}`,
      `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
      ...oldLines.map((line) => `-${line}`),
      ...newLines.map((line) => `+${line}`),
    ]
  } else {
    hunkLines = [
      `--- a/${display}`,
      `+++ b/${display}`,
      ...patch.hunks.flatMap(({ oldStart, oldLines, newStart, newLines, lines }) => [
        `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`,
        ...lines,
      ]),
    ]
  }

  let added = 0
  let deleted = 0
  for (const line of hunkLines) {
    if (line.startsWith('+') && !line.startsWith('+++')) added += 1
    else if (line.startsWith('-') && !line.startsWith('---')) deleted += 1
  }
  return finish(hunkLines, added, deleted)
}

/** Clip a patch body at MAX_DIFF_LINES, preserving the unclipped counts and line total. */
function finish(hunkLines: string[], added: number, deleted: number): CopyComparison {
  const totalLines = hunkLines.length
  const kept = hunkLines.slice(0, MAX_DIFF_LINES)
  return {
    added,
    deleted,
    binary: false,
    oversized: false,
    patch: kept.join('\n'),
    truncated: kept.length < totalLines,
    totalLines,
  }
}