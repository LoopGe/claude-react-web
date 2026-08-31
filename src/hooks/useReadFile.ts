// Per-session read-only file content hook. GETs /sessions/:id/read-file,
// auto-fetching whenever the path changes (or refetch() is called). Mirrors
// the plain useApi.get pattern (no streaming); SDK permission gating means
// `available` is false when the read was denied or the file is missing.

import { useCallback, useEffect, useState } from 'react'
import { api } from './useApi'
import type { FileReadResult } from '../../shared/read-file'

export function useReadFile(sessionId: string, path: string | null) {
  const [data, setData] = useState<FileReadResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    if (!path) {
      // Reset state when no file is selected so the viewer's body falls back
      // to the "not available" hint instead of showing stale content from a
      // previously viewed file. Same cache-invalidation-on-input-change pattern
      // useGitStatus / useChatStream use.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reset on input change
      setData(null)
      setError(null)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    api
      .get<FileReadResult>(`/sessions/${sessionId}/read-file?path=${encodeURIComponent(path)}`)
      .then((res) => {
        if (cancelled) return
        setData(res)
        setLoading(false)
      })
      .catch((e) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        setData(null)
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, path, version])

  const refetch = useCallback(() => setVersion((v) => v + 1), [])

  return {
    // Raw result — null until the first response lands, so callers can
    // distinguish "still pending" from a settled `available: false`.
    data,
    contents: data?.contents,
    available: data?.available ?? false,
    truncated: data?.truncated,
    error,
    loading,
    refetch,
  }
}