// Client upload queue — XHR progress store + completion side-effects.
//
// Module-level store (NOT React state) so progress events don't re-render the
// app tree. `useUploadQueue` is a thin `useSyncExternalStore` view.

import { useSyncExternalStore } from 'react'
import { writeClipboard } from './useCopy'

// ── Types ─────────────────────────────────────────────────────────────

export interface UploadItem {
  key: string
  name: string
  size: number
  loaded: number
  total: number
  status: 'uploading' | 'done' | 'error'
  error?: string
  path?: string
}

export interface BatchCompletion {
  paths: string[]
  allSucceeded: boolean
  autoClose: boolean
}

// ── Module-level store ────────────────────────────────────────────────

let items: UploadItem[] = []
let lastCompletion: BatchCompletion | null = null
let batchCounter = 0

type Listener = () => void
const listeners = new Set<Listener>()

function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function notify(): void {
  for (const l of listeners) l()
}

// Stable empty array for the no-items case.
const EMPTY_ITEMS: UploadItem[] = []

function getSnapshot(): UploadItem[] {
  return items.length === 0 ? EMPTY_ITEMS : items
}

function getLastCompletion(): BatchCompletion | null {
  return lastCompletion
}

// ── Public API ────────────────────────────────────────────────────────

export function useUploadQueue(): {
  items: UploadItem[]
  lastCompletion: BatchCompletion | null
} {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const completion = useSyncExternalStore(subscribe, getLastCompletion, getLastCompletion)
  return { items: snap, lastCompletion: completion }
}

export function dismissItem(key: string): void {
  const idx = items.findIndex((it) => it.key === key)
  if (idx === -1) return
  items = items.filter((it) => it.key !== key)
  notify()
}

export function consumeCompletion(): void {
  if (lastCompletion === null) return
  lastCompletion = null
  notify()
}

export function startUploads(
  files: File[],
  opts?: { sessionId?: string; autoClose?: boolean },
): Promise<void> {
  // Capture the batch counter so stale XHR callbacks from a previous batch
  // are ignored. Old XHRs may complete server-side — we don't abort them,
  // but their progress/terminal events must not touch the new batch.
  const myBatch = ++batchCounter

  // Replace the current batch items with the new ones.
  const batchItems: UploadItem[] = files.map((file, i) => ({
    key: `${Date.now()}-${i}`,
    name: file.name,
    size: file.size,
    loaded: 0,
    total: file.size,
    status: 'uploading' as const,
  }))
  items = [...batchItems]
  lastCompletion = null
  notify()

  return new Promise<void>((resolve) => {
    if (files.length === 0) {
      // Nothing to upload — treat as an empty success.
      if (myBatch !== batchCounter) { resolve(); return }
      lastCompletion = { paths: [], allSucceeded: true, autoClose: opts?.autoClose ?? false }
      notify()
      resolve()
      return
    }

    let settled = 0
    const paths: string[] = []
    let allSucceeded = true

    function markTerminal(idx: number, item: UploadItem): void {
      if (myBatch !== batchCounter) { resolve(); return }
      // Update the item in the array immutably.
      items = items.map((it, i) => (i === idx ? item : it))
      notify()

      settled++
      if (settled === files.length) {
        if (myBatch !== batchCounter) { resolve(); return }
        // All files reached terminal state.
        if (paths.length > 0) {
          void writeClipboard(paths.join('\n')).catch(() => {
            // Clipboard failure is non-fatal.
          })
        }
        lastCompletion = {
          paths,
          allSucceeded,
          autoClose: opts?.autoClose ?? false,
        }
        notify()
        resolve()
      }
    }

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const item = batchItems[i]

      const xhr = new XMLHttpRequest()
      const baseUrl = '/api/uploads'
      const url = opts?.sessionId
        ? `${baseUrl}?sessionId=${encodeURIComponent(opts.sessionId)}`
        : baseUrl
      xhr.open('POST', url)

      xhr.upload.onprogress = (e: ProgressEvent) => {
        if (myBatch !== batchCounter) return
        const loaded = e.loaded
        const total = e.total ?? file.size
        // Update the item in-place and notify.
        items = items.map((it) =>
          it.key === item.key ? { ...it, loaded, total } : it,
        )
        notify()
      }

      xhr.onload = () => {
        if (myBatch !== batchCounter) { resolve(); return }
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const body = JSON.parse(xhr.responseText) as {
              uploads?: Array<{ path: string; name: string; size: number }>
            }
            const first = body.uploads?.[0]
            if (first) {
              paths.push(first.path)
            }
            markTerminal(i, { ...item, status: 'done', path: first?.path, loaded: item.total, total: item.total })
          } catch {
            allSucceeded = false
            markTerminal(i, { ...item, status: 'error', error: 'Invalid response', loaded: 0, total: item.size })
          }
        } else {
          // Parse error from response body.
          let errorMsg = `HTTP ${xhr.status}`
          try {
            const body = JSON.parse(xhr.responseText) as { error?: string }
            if (body.error) errorMsg = body.error
          } catch {
            // Use the default HTTP error message.
          }
          allSucceeded = false
          markTerminal(i, { ...item, status: 'error', error: errorMsg, loaded: 0, total: item.size })
        }
      }

      xhr.onerror = () => {
        if (myBatch !== batchCounter) { resolve(); return }
        allSucceeded = false
        markTerminal(i, { ...item, status: 'error', error: 'Upload failed', loaded: 0, total: item.size })
      }

      const form = new FormData()
      form.append('file', file, file.name)
      xhr.send(form)
    }
  })
}
