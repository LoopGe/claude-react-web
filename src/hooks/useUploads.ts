// Client data layer for the Uploads Manager dialog.
//
// Fetch-on-open sync model (same as the snippets manager): the list is
// fetched when `open` flips true and refetched after every mutation. No
// WebSocket subscription — uploads change rarely and the dialog is the
// only consumer.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from './useApi'
import type { UploadListItem, UploadsListResponse } from '../../shared/uploads'

export interface UseUploads {
  /** null = initial load in flight. */
  uploads: UploadListItem[] | null
  error: string | null
  refresh: () => Promise<void>
  remove: (id: string) => Promise<void>
  removeMany: (ids: string[]) => Promise<void>
}

export function useUploads(open: boolean): UseUploads {
  const [uploads, setUploads] = useState<UploadListItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await api.get<UploadsListResponse>('/uploads')
      setUploads(res.uploads)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void (async () => {
      await refresh()
    })()
  }, [open, refresh])

  const remove = useCallback(
    async (id: string) => {
      await api.delete(`/uploads/${encodeURIComponent(id)}`)
      await refresh()
    },
    [refresh],
  )

  // Sequential deletes (registry sizes are small), one refresh at the end.
  const removeMany = useCallback(
    async (ids: string[]) => {
      for (const id of ids) {
        await api.delete(`/uploads/${encodeURIComponent(id)}`)
      }
      await refresh()
    },
    [refresh],
  )

  return useMemo(
    () => ({ uploads, error, refresh, remove, removeMany }),
    [uploads, error, refresh, remove, removeMany],
  )
}
