// Composer file drafts: non-image attachments upload as soon as they are
// added, render as chips with progress/retry, and are consumed by the send.
// Only ready refs are persisted (the File handle dies with the page; the
// server-side upload survives).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FileAttachmentRef } from '../../shared/attachments'
import { FILE_DRAFT_KEY_PREFIX } from '../constants/storageKeys'
import { MAX_FILES_PER_MESSAGE } from '../../shared/upload-limits'
import { randomId } from '../utils/uuid'
import { uploadFile } from '../utils/upload-file'

export interface DraftFile {
  readonly key: string
  /** Absent for a restored ready chip (the browser File is gone after reload). */
  readonly file?: File
  readonly status: 'uploading' | 'ready' | 'error'
  readonly loaded: number
  readonly total: number
  readonly upload?: FileAttachmentRef
  readonly error?: string
}

export interface UseFileDrafts {
  readonly files: DraftFile[]
  /** True while any draft is still uploading; the composer blocks send. */
  readonly pending: boolean
  /** True when at least one draft failed to upload. */
  readonly failed: boolean
  /** Ready refs in draft order, ready to become FileBlocks. */
  readonly ready: FileAttachmentRef[]
  /** Queue files; returns a user-facing error when the cap drops some. */
  addFiles: (files: readonly File[]) => string | null
  removeFile: (key: string) => void
  retryFile: (key: string) => void
  clearFiles: () => void
}

const MAX_CONCURRENT_UPLOADS = 2

interface QueuedUpload {
  readonly key: string
  readonly file: File
}

function storageKey(sessionId: string): string {
  return FILE_DRAFT_KEY_PREFIX + sessionId
}

function loadPersisted(sessionId: string): FileAttachmentRef[] {
  try {
    const raw = sessionStorage.getItem(storageKey(sessionId))
    if (raw === null) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((value): FileAttachmentRef[] => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
      const v = value as Record<string, unknown>
      if (typeof v.id !== 'string' || typeof v.name !== 'string' || typeof v.size !== 'number') return []
      return [{
        id: v.id,
        name: v.name,
        size: v.size,
        ...(typeof v.digest === 'string' ? { digest: v.digest } : {}),
      }]
    })
  } catch {
    return []
  }
}

export function useFileDrafts(sessionId: string): UseFileDrafts {
  // Chat is mounted per session (the panel key changes on a session swap), so
  // the draft is initialized for this session and torn down with it.
  const [files, setFiles] = useState<DraftFile[]>(() => loadPersisted(sessionId).map((ref) => ({
    key: `restored-${ref.id}`,
    status: 'ready' as const,
    loaded: ref.size,
    total: ref.size,
    upload: ref,
  })))
  const filesRef = useRef(files)
  useEffect(() => { filesRef.current = files }, [files])
  // Synchronous chip count for the cap: filesRef lags a commit, so two
  // batches queued in one tick would otherwise both see the old length.
  const countRef = useRef(files.length)
  const controllers = useRef(new Map<string, AbortController>())
  const queue = useRef<QueuedUpload[]>([])
  const active = useRef(0)
  const lastPersisted = useRef('')
  const pumpRef = useRef<() => void>(() => {})
  const progressAt = useRef(new Map<string, number>())

  // Persist only the ready refs; progress ticks do not rewrite storage.
  useEffect(() => {
    const ready = files.flatMap((file) => file.status === 'ready' && file.upload !== undefined ? [file.upload] : [])
    const json = JSON.stringify(ready)
    if (json === lastPersisted.current) return
    lastPersisted.current = json
    try {
      if (ready.length === 0) sessionStorage.removeItem(storageKey(sessionId))
      else sessionStorage.setItem(storageKey(sessionId), json)
    } catch {
      // Storage unavailable: chips still work for this mount.
    }
  }, [files, sessionId])

  useEffect(() => () => {
    for (const controller of controllers.current.values()) controller.abort()
    controllers.current.clear()
    queue.current = []
  }, [])

  const update = useCallback((key: string, patch: Partial<DraftFile>) => {
    setFiles((prev) => prev.map((file) => file.key === key ? { ...file, ...patch } : file))
  }, [])

  const pump = useCallback(() => {
    while (active.current < MAX_CONCURRENT_UPLOADS) {
      const task = queue.current.shift()
      if (task === undefined) return
      active.current += 1
      const controller = new AbortController()
      controllers.current.set(task.key, controller)
      void uploadFile(task.file, {
        sessionId,
        signal: controller.signal,
        onProgress: (loaded, total) => {
          // Progress is React state owned by Chat; throttle it so a large
          // upload does not re-render the transcript several times a second.
          const now = Date.now()
          if (now - (progressAt.current.get(task.key) ?? 0) < 100 && loaded < total) return
          progressAt.current.set(task.key, now)
          update(task.key, { loaded, total })
        },
      }).then((uploaded) => {
        update(task.key, {
          status: 'ready',
          loaded: uploaded.size,
          total: uploaded.size,
          upload: {
            id: uploaded.id,
            name: uploaded.name,
            size: uploaded.size,
            ...(uploaded.digest === undefined ? {} : { digest: uploaded.digest }),
          },
        })
      }).catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        update(task.key, {
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        })
      }).finally(() => {
        controllers.current.delete(task.key)
        progressAt.current.delete(task.key)
        active.current -= 1
        pumpRef.current()
      })
    }
  }, [sessionId, update])

  useEffect(() => { pumpRef.current = pump }, [pump])

  const addFiles = useCallback((incoming: readonly File[]): string | null => {
    const room = MAX_FILES_PER_MESSAGE - countRef.current
    const accepted = incoming.slice(0, Math.max(0, room))
    if (accepted.length > 0) {
      countRef.current += accepted.length
      const items: DraftFile[] = accepted.map((file) => ({
        key: randomId(),
        file,
        status: 'uploading',
        loaded: 0,
        total: file.size,
      }))
      setFiles((prev) => [...prev, ...items])
      queue.current.push(...items.map((item) => ({ key: item.key, file: item.file as File })))
      pump()
    }
    return accepted.length < incoming.length
      ? `At most ${MAX_FILES_PER_MESSAGE} files can be attached to one message.`
      : null
  }, [pump])

  const removeFile = useCallback((key: string) => {
    controllers.current.get(key)?.abort()
    controllers.current.delete(key)
    queue.current = queue.current.filter((task) => task.key !== key)
    countRef.current = Math.max(0, countRef.current - 1)
    setFiles((prev) => prev.filter((file) => file.key !== key))
  }, [])

  const retryFile = useCallback((key: string) => {
    const target = filesRef.current.find((file) => file.key === key)
    if (target?.file === undefined) return
    update(key, { status: 'uploading', loaded: 0, total: target.file.size, error: undefined })
    queue.current.push({ key, file: target.file })
    pump()
  }, [pump, update])

  const clearFiles = useCallback(() => {
    for (const controller of controllers.current.values()) controller.abort()
    controllers.current.clear()
    queue.current = []
    progressAt.current.clear()
    countRef.current = 0
    setFiles([])
    // Remove the persisted record synchronously too: the success continuation
    // can run after this panel unmounted, where the persistence effect is
    // gone and a surviving record would restore already-sent chips.
    lastPersisted.current = '[]'
    try {
      sessionStorage.removeItem(storageKey(sessionId))
    } catch {
      // Storage unavailable: nothing to remove.
    }
  }, [sessionId])

  const pending = files.some((file) => file.status === 'uploading')
  const failed = files.some((file) => file.status === 'error')
  const ready = files.flatMap((file) => file.status === 'ready' && file.upload !== undefined ? [file.upload] : [])

  return useMemo(
    () => ({ files, pending, failed, ready, addFiles, removeFile, retryFile, clearFiles }),
    [files, pending, failed, ready, addFiles, removeFile, retryFile, clearFiles],
  )
}