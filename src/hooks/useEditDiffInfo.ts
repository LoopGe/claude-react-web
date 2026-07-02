// Resolve real file line numbers + context for Edit / MultiEdit diff chunks.
//
// The SDK's Edit tool input carries only { file_path, old_string, new_string }
// — no file line offset — so a chunk can't know where in the file it lands.
// This hook asks the server (POST /api/edit-locate) to read <cwd>/<path>,
// reconstruct the old/new file contents, and run `diff`'s structuredPatch to
// produce canonical unified-diff hunks (with real old/new line numbers and K
// lines of context). null hunks means the edit couldn't be located
// (ambiguous / file changed / too large / missing) — callers fall back to
// rendering the bare interleaved +/- fragment with no gutter.
//
// Results are cached for the tab lifetime by (cwd, path, anchors) and a single
// in-flight request per key is shared across concurrent callers, so a
// MultiEdit card and a re-render don't double-fetch.

import { useEffect, useRef, useState } from 'react'
import { api } from './useApi'

export interface EditAnchor {
  old: string
  new: string
}

/** A unified-diff hunk, mirroring `diff`'s StructuredPatchHunk. oldStart /
 *  newStart are 1-based; lines are prefixed ' ' (ctx) / '-' (del) / '+'
 *  (add). */
export interface EditDiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

export interface EditDiffInfo {
  /** Unified-diff hunks for this edit, or null when unlocatable. */
  hunks: EditDiffHunk[] | null
}

// Results are cached for the tab lifetime by (cwd, path, anchors) and a single
// in-flight request per key is shared across concurrent callers, so a
// MultiEdit card and a re-render don't double-fetch. The cache is capped
// (FIFO by insertion order) so a long-lived tab churning through many distinct
// edits can't grow it without bound; `inflight` self-clears via .finally.
const CACHE_CAP = 200
const cache = new Map<string, EditDiffInfo[]>()
const inflight = new Map<string, Promise<EditDiffInfo[]>>()

function cacheSet(key: string, value: EditDiffInfo[]) {
  cache.set(key, value)
  if (cache.size > CACHE_CAP) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
}

function cacheKey(
  cwd: string | undefined,
  filePath: string | undefined,
  anchors: readonly EditAnchor[],
): string {
  return JSON.stringify({ cwd: cwd ?? '', filePath: filePath ?? '', anchors })
}

function emptyResult(anchors: readonly EditAnchor[]): EditDiffInfo[] {
  return anchors.map(() => ({ hunks: null }))
}

/** Returns an array aligned with `anchors`: each entry is the edit's
 *  { hunks }. hunks is null while loading or unlocatable. No-op when cwd or
 *  filePath is missing. */
export function useEditDiffInfo(
  cwd: string | undefined,
  filePath: string | undefined,
  anchors: readonly EditAnchor[],
): EditDiffInfo[] {
  const key = cacheKey(cwd, filePath, anchors)
  const [snapshot, setSnapshot] = useState<{ key: string; info: EditDiffInfo[] | undefined }>(
    () => ({ key, info: cache.get(key) }),
  )

  // Key changed since last commit — reset from cache during render (React's
  // "adjust state during render" escape hatch) so a cwd/anchor switch shows
  // the cached result instantly instead of flashing nulls for a frame.
  if (snapshot.key !== key) {
    setSnapshot({ key, info: cache.get(key) })
  }

  const reqId = useRef(0)
  useEffect(() => {
    if (!cwd || !filePath || anchors.length === 0) return
    if (cache.get(key)) return
    let p = inflight.get(key)
    if (!p) {
      p = api
        .post<{ results: EditDiffInfo[] }>('/edit-locate', { cwd, path: filePath, anchors })
        .then((r) => {
          const info = Array.isArray(r?.results)
            ? r.results.map((it) => ({
                hunks: Array.isArray(it?.hunks) ? it.hunks.map(normalizeHunk) : null,
              }))
            : emptyResult(anchors)
          cacheSet(key, info)
          return info
        })
        .catch(() => {
          const fallback = emptyResult(anchors)
          cacheSet(key, fallback)
          return fallback
        })
        .finally(() => {
          inflight.delete(key)
        })
      inflight.set(key, p)
    }
    const myReq = ++reqId.current
    void p.then((info) => {
      if (reqId.current === myReq) setSnapshot({ key, info })
    })
  }, [key, cwd, filePath, anchors])

  return snapshot.info ?? emptyResult(anchors)
}

/** Coerce a server-supplied hunk to the EditDiffHunk shape, tolerating any
 *  stray fields. */
function normalizeHunk(h: unknown): EditDiffHunk {
  const o = (h ?? {}) as Record<string, unknown>
  return {
    oldStart: typeof o.oldStart === 'number' ? o.oldStart : 0,
    oldLines: typeof o.oldLines === 'number' ? o.oldLines : 0,
    newStart: typeof o.newStart === 'number' ? o.newStart : 0,
    newLines: typeof o.newLines === 'number' ? o.newLines : 0,
    lines: Array.isArray(o.lines) ? o.lines.map(String) : [],
  }
}
