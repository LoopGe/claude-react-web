// Resolve real file line numbers + surrounding context for Edit / MultiEdit
// diff chunks.
//
// The SDK's Edit tool input carries only { file_path, old_string, new_string }
// — no file line offset — so a chunk can't know where in the file it lands.
// This hook asks the server (POST /api/edit-locate) to read <cwd>/<path> and
// locate new_string (edit applied) or old_string (not applied / denied),
// returning the 1-based start line plus K unchanged context lines above and
// below (git-diff style) so the hunk renders with its real neighbourhood.
// startLine null means the string couldn't be located (ambiguous / file
// changed / too large / missing) — callers render no gutter and no context
// rather than a misleading number.
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

export interface EditDiffInfo {
  /** 1-based file line where old_string / new_string begins, or null when
   *  unlocatable. */
  startLine: number | null
  /** Unchanged lines immediately above the edit (oldest first). Empty when
   *  unlocatable or at file start. */
  before: string[]
  /** Unchanged lines immediately below the edit (top first). Empty when
   *  unlocatable or at file end. */
  after: string[]
}

const cache = new Map<string, EditDiffInfo[]>()
const inflight = new Map<string, Promise<EditDiffInfo[]>>()

function cacheKey(
  cwd: string | undefined,
  filePath: string | undefined,
  anchors: readonly EditAnchor[],
): string {
  return JSON.stringify({ cwd: cwd ?? '', filePath: filePath ?? '', anchors })
}

function emptyResult(anchors: readonly EditAnchor[]): EditDiffInfo[] {
  return anchors.map(() => ({ startLine: null, before: [], after: [] }))
}

/** Returns an array aligned with `anchors`: each entry is the edit's
 *  { startLine, before, after }. startLine is null (and context empty) while
 *  loading or unlocatable. No-op when cwd or filePath is missing. */
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
                startLine: typeof it?.startLine === 'number' ? it.startLine : null,
                before: Array.isArray(it?.before) ? it.before.map(String) : [],
                after: Array.isArray(it?.after) ? it.after.map(String) : [],
              }))
            : emptyResult(anchors)
          cache.set(key, info)
          return info
        })
        .catch(() => {
          const fallback = emptyResult(anchors)
          cache.set(key, fallback)
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
