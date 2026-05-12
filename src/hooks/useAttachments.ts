// Attachment / file-upload state for the Chat composer.
//
// Owns three pieces of state:
// - `attachments`: files already uploaded, carrying the absolute path we'll
//   cite in the outgoing prompt.
// - `uploading`: in-flight POST indicator.
// - `dragOver`: true while a files-drag is over the drop zone.
//
// The actual prompt preamble (" Attached files: ...") is composed by the
// caller — this hook only manages the list and network round-trip.

import { useCallback, useMemo, useState } from 'react'

export interface Attachment {
  path: string
  name: string
  size: number
}

export interface UseAttachments {
  attachments: Attachment[]
  uploading: boolean
  dragOver: boolean
  error: string | null
  uploadFiles: (files: File[]) => Promise<void>
  removeAttachment: (path: string) => void
  clear: () => void
  setDragOver: (v: boolean) => void
  clearError: () => void
}

export function useAttachments(sessionId: string, sessionCwd: string | undefined): UseAttachments {
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const uploadFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return
      if (!sessionCwd) {
        setError('Session has no cwd; uploads require a working directory.')
        return
      }
      setUploading(true)
      setError(null)
      try {
        const form = new FormData()
        for (const f of files) form.append('file', f, f.name)
        const res = await fetch(`/api/sessions/${sessionId}/uploads`, {
          method: 'POST',
          body: form,
        })
        const body = (await res.json().catch(() => ({}))) as {
          uploads?: Attachment[]
          error?: string
        }
        if (!res.ok) throw new Error(body.error || `upload failed (HTTP ${res.status})`)
        setAttachments((prev) => [...prev, ...(body.uploads ?? [])])
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setUploading(false)
      }
    },
    [sessionId, sessionCwd],
  )

  const removeAttachment = useCallback((path: string) => {
    setAttachments((prev) => {
      const target = prev.find((a) => a.path === path)
      if (target) {
        // Fire-and-forget: delete the file from disk (best-effort).
        fetch(`/api/sessions/${sessionId}/uploads/${encodeURIComponent(target.name)}`, {
          method: 'DELETE',
        }).catch(() => {})
      }
      return prev.filter((a) => a.path !== path)
    })
  }, [sessionId])

  const clear = useCallback(() => {
    setAttachments([])
    setDragOver(false)
  }, [])

  const clearError = useCallback(() => setError(null), [])

  return useMemo(
    () => ({
      attachments,
      uploading,
      dragOver,
      error,
      uploadFiles,
      removeAttachment,
      clear,
      setDragOver,
      clearError,
    }),
    [attachments, uploading, dragOver, error, uploadFiles, removeAttachment, clear, clearError],
  )
}
