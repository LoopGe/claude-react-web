// Resolve real file line numbers for Edit / MultiEdit diff chunks.
//
// The SDK's Edit tool input carries only { file_path, old_string, new_string }
// — no file line offset — so a chunk can't know where in the file it lands.
// This hook asks the server (POST /api/edit-locate) to read <cwd>/<path> and
// locate new_string (edit applied) or old_string (not applied / denied),
// returning the 1-based start line per anchor. null means the string couldn't
// be located (ambiguous / file changed / too large / missing) — callers render
// no gutter in that case rather than a misleading number.
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

const cache = new Map<string, (number | null)[]>()
const inflight = new Map<string, Promise<(number | null)[]>>()

function cacheKey(
  cwd: string | undefined,
  filePath: string | undefined,
  anchors: readonly EditAnchor[],
): string {
  return JSON.stringify({ cwd: cwd ?? '', filePath: filePath ?? '', anchors })
}

/** Returns an array aligned with `anchors`: each entry is the 1-based start
 *  line of that edit in the file, or null while loading / unlocatable.
 *  No-op (returns all-nulls) when cwd or filePath is missing. */
export function useEditStartLines(
  cwd: string | undefined,
  filePath: string | undefined,
  anchors: readonly EditAnchor[],
): (number | null)[] {
  const key = cacheKey(cwd, filePath, anchors)
  const [snapshot, setSnapshot] = useState<{ key: string; lines: (number | null)[] | undefined }>(
    () => ({ key, lines: cache.get(key) }),
  )

  // Key changed since last commit — reset from cache during render (React's
  // "adjust state during render" escape hatch) so a cwd/anchor switch shows
  // the cached result instantly instead of flashing nulls for a frame. No
  // setState-in-effect: this runs in the render phase, guarded so it fires
  // at most once per key change.
  if (snapshot.key !== key) {
    setSnapshot({ key, lines: cache.get(key) })
  }

  const reqId = useRef(0)
  useEffect(() => {
    if (!cwd || !filePath || anchors.length === 0) return
    // Already cached (or this very render just populated it) — no fetch.
    if (cache.get(key)) return
    let p = inflight.get(key)
    if (!p) {
      p = api
        .post<{ lines: (number | null)[] }>('/edit-locate', { cwd, path: filePath, anchors })
        .then((r) => {
          const lines = Array.isArray(r?.lines)
            ? r.lines.map((n) => (typeof n === 'number' ? n : null))
            : anchors.map(() => null)
          cache.set(key, lines)
          return lines
        })
        .catch(() => {
          const fallback = anchors.map(() => null)
          cache.set(key, fallback)
          return fallback
        })
        .finally(() => {
          inflight.delete(key)
        })
      inflight.set(key, p)
    }
    const myReq = ++reqId.current
    void p.then((lines) => {
      // Guard against a cwd/anchor switch racing the response.
      if (reqId.current === myReq) setSnapshot({ key, lines })
    })
  }, [key, cwd, filePath, anchors])

  return snapshot.lines ?? anchors.map(() => null)
}
