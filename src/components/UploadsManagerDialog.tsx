// Uploads Manager dialog — app-level inventory of composer file uploads.
//
// Lists every recorded upload (path-keyed registry on the server) with
// provenance (cwd tail + session title snapshot), per-row Copy path /
// Delete, a "Clean missing entries" batch action, and client-derived
// usage stats. Fetch-on-open via useUploads — no WS subscription.
//
// Shell reuses the Overlay 'perm' variant (.perm-overlay/.perm-card) and
// the modal-header/modal-section family, so dark/light theming comes from
// the shared sheets; only the row layout gets scoped CSS
// (src/styles/uploads-manager.css).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Overlay } from './Overlay'
import { ConfirmDialog } from './ConfirmDialog'
import { useToast } from '../hooks/useToast'
import { writeClipboard } from '../hooks/useCopy'
import { useUploads } from '../hooks/useUploads'
import { useUploadQueue, startUploads, dismissItem, consumeCompletion, type BatchCompletion } from '../hooks/useUploadQueue'
import { formatBytes, formatRelativeTime } from '../utils/format'
import type { UploadListItem } from '../../shared/uploads'
import {
  IconCopy,
  IconFolderSearch,
  IconLoader,
  IconPaperclip,
  IconTrash,
  IconX,
} from './icons/ToolIcons'

/** Tail of the cwd for display: last two segments. */
function cwdTail(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean)
  return parts.length <= 2 ? cwd : `…/${parts.slice(-2).join('/')}`
}

interface Props {
  open?: boolean
  onClose: () => void
}

export function UploadsManagerDialog({ open = true, onClose }: Props) {
  const { uploads, error, refresh, remove, removeMany } = useUploads(open)
  const toast = useToast()
  const { items, lastCompletion } = useUploadQueue()

  const [filter, setFilter] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<UploadListItem | null>(null)
  const [cleanMissingOpen, setCleanMissingOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // ── Completion effect ──────────────────────────────────────────────
  // Capture completion data BEFORE consumeCompletion() — the notify()
  // it calls can trigger synchronous re-renders that empty `items`.
  const processedCompletionRef = useRef<BatchCompletion | null>(null)
  useEffect(() => {
    if (!lastCompletion || lastCompletion === processedCompletionRef.current) return
    const { allSucceeded, paths, autoClose } = lastCompletion
    const failed = items.filter((it) => it.status === 'error').length
    processedCompletionRef.current = lastCompletion
    consumeCompletion()
    void refresh()
    if (allSucceeded) {
      toast.success(paths.length === 1 ? 'Path copied' : `${paths.length} paths copied`)
      if (autoClose) onClose()
    } else {
      toast.error(`${failed} upload(s) failed`)
    }
  }, [lastCompletion, refresh, toast, onClose, items])

  // ── Drag handlers (mirroring Chat.tsx composer drop zone) ──────────
  const onDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      setDragOver(true)
    },
    [],
  )

  const onDragLeave = useCallback(
    (e: React.DragEvent) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
      setDragOver(false)
    },
    [],
  )

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      const files = Array.from(e.dataTransfer.files)
      if (files.length > 0) void startUploads(files)
    },
    [],
  )

  // ── Paperclip file input ───────────────────────────────────────────
  const onFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? [])
      if (files.length > 0) void startUploads(files)
      // Reset so the same file can be picked again.
      e.target.value = ''
    },
    [],
  )

  const rows = useMemo(() => {
    const list = uploads ?? []
    const q = filter.trim().toLowerCase()
    if (!q) return list
    return list.filter(
      (u) =>
        u.name.toLowerCase().includes(q) ||
        u.cwd.toLowerCase().includes(q) ||
        u.sessionTitle.toLowerCase().includes(q),
    )
  }, [uploads, filter])

  const stats = useMemo(() => {
    const list = uploads ?? []
    return {
      count: list.length,
      bytes: list.reduce((s, u) => s + u.size, 0),
      missing: list.filter((u) => !u.exists).length,
    }
  }, [uploads])

  const copyPath = async (u: UploadListItem) => {
    // Plain `writeClipboard`: this row reports BOTH outcomes itself, with
    // wording that names the fallback ("select the path manually").
    if (await writeClipboard(u.path)) toast.success('Path copied')
    else toast.error('Copy failed — select the path manually.')
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    setBusy(true)
    try {
      await remove(deleteTarget.id)
      setDeleteTarget(null)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const confirmCleanMissing = async () => {
    if (!uploads) return
    const ids = uploads.filter((u) => !u.exists).map((u) => u.id)
    setBusy(true)
    try {
      await removeMany(ids)
      toast.success(`Removed ${ids.length} missing ${ids.length === 1 ? 'entry' : 'entries'}`)
      setCleanMissingOpen(false)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Overlay
      variant="perm"
      open={open}
      onClose={onClose}
      ariaLabel="Uploaded files"
      cardClassName={`uploads-manager-card${dragOver ? ' uploads-manager-drag' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="modal-header">
        <h3>
          <IconFolderSearch size={16} aria-hidden /> Uploaded files
        </h3>
        <span className="uploads-stats">
          {stats.count} {stats.count === 1 ? 'file' : 'files'} · {formatBytes(stats.bytes)}
        </span>
        <button type="button" className="btn btn-icon" onClick={onClose} aria-label="Close">
          <IconX size={16} />
        </button>
      </div>

      {/* ── In-flight upload progress ─────────────────────────────── */}
      {items.length > 0 && (
        <div className="modal-section uploads-progress-section">
          {items.map((it) => {
            const pct = it.total > 0 ? Math.round((it.loaded / it.total) * 100) : 0
            return (
              <div key={it.key} className={`uploads-progress-row uploads-progress-${it.status}`}>
                <span className="uploads-progress-name">{it.name}</span>
                {it.status === 'uploading' && (
                  <div className="uploads-progress-bar">
                    <div className="uploads-progress-fill" style={{ width: `${pct}%` }} />
                  </div>
                )}
                {it.status === 'done' && (
                  <span className="uploads-progress-done">&#10003;</span>
                )}
                {it.status === 'error' && (
                  <>
                    <span className="uploads-progress-error">{it.error}</span>
                    <button
                      type="button"
                      className="btn btn-icon uploads-progress-dismiss"
                      aria-label="Dismiss"
                      onClick={() => dismissItem(it.key)}
                    >
                      <IconX size={12} />
                    </button>
                  </>
                )}
              </div>
            )
          })}
        </div>
      )}

      {uploads === null && error === null && (
        <div className="modal-section uploads-state">
          <IconLoader size={16} className="glyph-spin" /> Loading…
        </div>
      )}

      {error !== null && (
        <div className="modal-section uploads-state">
          <span>{error}</span>
          <button type="button" className="btn" onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      )}

      {uploads !== null && (
        <>
          <div className="modal-section uploads-toolbar">
            <input
              className="input"
              type="text"
              placeholder="Filter by name, cwd, or session…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label="Filter uploads"
            />
            {/* Paperclip: hidden file input + icon button */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={onFileInputChange}
            />
            <button
              type="button"
              className="btn btn-icon"
              title="Upload files"
              aria-label="Upload files"
              onClick={() => fileInputRef.current?.click()}
            >
              <IconPaperclip size={16} />
            </button>
            {stats.missing > 0 && (
              <button type="button" className="btn" onClick={() => setCleanMissingOpen(true)}>
                Clean missing entries
              </button>
            )}
          </div>

          {uploads.length === 0 && items.length === 0 && (
            <div className="modal-section uploads-state uploads-empty">
              No files uploaded yet. Attach files from any composer's paperclip, or drop files here
              to add them to the shared folder.
            </div>
          )}

          {uploads.length > 0 && (
            <div className="uploads-list">
              {rows.length === 0 && <div className="uploads-state">No uploads match the filter.</div>}
              {rows.map((u) => (
              <div key={u.id} className={`uploads-row${u.exists ? '' : ' uploads-row-missing'}`}>
                <div className="uploads-row-main">
                  <span className="uploads-name">
                    {u.name}
                    {!u.exists && <span className="uploads-missing-badge">missing</span>}
                    {u.origin === 'common' && <span className="uploads-common-badge">common</span>}
                  </span>
                  <span className="uploads-meta truncate" title={u.path}>
                    {u.origin === 'common'
                      ? `${formatBytes(u.size)} · ${formatRelativeTime(new Date(u.uploadedAt).toISOString())}`
                      : <>
                          {formatBytes(u.size)} · {cwdTail(u.cwd)}
                          {u.sessionTitle ? ` · ${u.sessionTitle}` : ''} ·{' '}
                          {formatRelativeTime(new Date(u.uploadedAt).toISOString())}
                        </>
                    }
                  </span>
                </div>
                <div className="uploads-row-actions">
                  <button
                    type="button"
                    className="btn btn-icon"
                    title="Copy absolute path"
                    aria-label="Copy path"
                    onClick={() => void copyPath(u)}
                  >
                    <IconCopy size={14} />
                  </button>
                  <button
                    type="button"
                    className="btn btn-icon"
                    title="Delete file"
                    aria-label="Delete file"
                    onClick={() => setDeleteTarget(u)}
                  >
                    <IconTrash size={14} />
                  </button>
                </div>
              </div>
            ))}
            </div>
          )}
        </>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="Delete uploaded file?"
          message={
            <>
              This permanently deletes the file from disk:
              <br />
              <code>{deleteTarget.path}</code>
            </>
          }
          confirmLabel="Delete"
          destructive
          busy={busy}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {cleanMissingOpen && (
        <ConfirmDialog
          title="Clean missing entries?"
          message={
            <>
              {stats.missing} registry {stats.missing === 1 ? 'entry' : 'entries'} point to files
              that no longer exist on disk. They will be removed from the list (the files are
              already gone).
            </>
          }
          confirmLabel={`Clean ${stats.missing} ${stats.missing === 1 ? 'entry' : 'entries'}`}
          destructive
          busy={busy}
          onConfirm={() => void confirmCleanMissing()}
          onCancel={() => setCleanMissingOpen(false)}
        />
      )}
    </Overlay>
  )
}
