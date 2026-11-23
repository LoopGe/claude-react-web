// Lazy candidate menu for the composer's @file/@folder trigger. Isomorphic to
// CommandPicker (portal to <body>, fixed positioning above the editor, floating
// -surface Escape/outside-click ownership), but fed by the debounced file-search
// hook and owned by the Composer's keyboard routing — the editor keeps focus, so
// navigation is aria-activedescendant, not roving tabindex.
//
// Loaded through React.lazy so the startup bundle never carries the menu. The
// rows arrive pre-grouped (folders first, then files) from the Composer, which
// resolves the keyboard-selected index against that same flat order.

import { Fragment, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useFloatingSurface, FloatingSurfaceProvider } from '../hooks/useFloatingSurface'
import { useOutsideMouseDown } from '../hooks/useOutsideMouseDown'
import { PANEL_SELECTOR, markPortaledSurface } from '../theme'
import { clamp } from '../utils/clamp'
import type { FileSearchResult } from '../hooks/useFileSearch'
import { IconFolder, IconFileText, IconChevronRight } from './icons/ToolIcons'

interface Props {
  /** Flat render order: folders first, then files (the Composer's nav order). */
  results: FileSearchResult[]
  loading: boolean
  /** The raw search query (no `@`/quote). A trailing `/` is the drill state. */
  query: string
  selectedIndex: number
  anchorRef: React.RefObject<HTMLElement | null>
  /** Settle a candidate (Enter on any row, Tab/mousedown on a file). */
  onPick: (result: FileSearchResult) => void
  /** Descend into a folder (Tab/chevron/mousedown on a folder, breadcrumb). */
  onDrill: (result: FileSearchResult) => void
  onClose: () => void
}

export default function FilePicker({
  results,
  loading,
  query,
  selectedIndex,
  anchorRef,
  onPick,
  onDrill,
  onClose,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef<HTMLDivElement>(null)

  // --- Positioning: fixed, above the editor, clamped to viewport (CommandPicker
  // parity — the portal exists because these are viewport coordinates). ---
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const anchor = anchorRef.current
    markPortaledSurface(el, anchor?.closest(PANEL_SELECTOR) ?? null)
    if (!anchor) return
    const rect = anchor.getBoundingClientRect()
    const pickerH = el.offsetHeight
    const pickerW = el.offsetWidth
    const vw = window.innerWidth
    const vh = window.innerHeight
    const gap = 4
    let top = rect.top - gap - pickerH
    if (top < 8) top = rect.bottom + gap
    let left = rect.left
    if (left + pickerW > vw - 8) left = vw - pickerW - 8
    if (left < 8) left = 8
    if (top + pickerH > vh - 8) el.style.maxHeight = `${vh - top - 8}px`
    el.style.left = `${left}px`
    el.style.top = `${top}px`
  }, [anchorRef, results.length, query])

  const { surfaceId } = useFloatingSurface({
    kind: 'popover',
    active: true,
    phase: 'open',
    getContainer: () => rootRef.current,
    getTrigger: () => anchorRef.current,
    onDismiss: onClose,
    onEscape: onClose,
  })
  useOutsideMouseDown({ ref: rootRef, onClose, surfaceId, capture: true })

  const idx = clamp(selectedIndex, 0, Math.max(0, results.length - 1))
  useLayoutEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [idx])

  const folderCount = results.filter((r) => r.dir).length
  // Breadcrumbs only in the scoped drill state (query ends with `/`); they
  // navigate back up the drilled directory.
  const drillDir = query.endsWith('/') ? query.slice(0, -1) : ''
  const segments = drillDir ? drillDir.split('/').filter(Boolean) : []

  const row = (r: FileSearchResult, i: number) => (
    <div
      key={r.path}
      id={`file-picker-opt-${i}`}
      ref={i === idx ? activeRef : undefined}
      role="option"
      aria-selected={i === idx}
      className={`file-picker-item${i === idx ? ' active' : ''}${r.dir ? ' is-dir' : ''}`}
      onMouseDown={(e) => {
        // Keep focus in the editor; the pick/drill splices via the handle.
        e.preventDefault()
        if (r.dir) onDrill(r)
        else onPick(r)
      }}
    >
      {r.dir ? <IconFolder size={14} aria-hidden /> : <IconFileText size={14} aria-hidden />}
      <span className="file-picker-name">{r.path}{r.dir ? '/' : ''}</span>
      {r.dir && <IconChevronRight size={14} className="file-picker-chevron" aria-hidden />}
    </div>
  )

  return (
    <FloatingSurfaceProvider surfaceId={surfaceId}>
      {createPortal(
        <div
          className="file-picker os-hidden"
          ref={rootRef}
          role="listbox"
          aria-label="File and folder candidates"
          aria-activedescendant={results.length > 0 ? `file-picker-opt-${idx}` : undefined}
        >
          {query.endsWith('/') && (
            <div className="file-picker-crumbs">
              <button
                type="button"
                className="file-picker-crumb"
                onMouseDown={(e) => { e.preventDefault(); onDrill({ path: '', dir: true }) }}
              >
                root
              </button>
              {segments.map((seg, i) => (
                <Fragment key={`${seg}-${i}`}>
                  <span className="file-picker-crumb-sep" aria-hidden>/</span>
                  <button
                    type="button"
                    className="file-picker-crumb"
                    onMouseDown={(e) => {
                      e.preventDefault()
                      onDrill({ path: segments.slice(0, i + 1).join('/'), dir: true })
                    }}
                  >
                    {seg}
                  </button>
                </Fragment>
              ))}
            </div>
          )}
          {query === '' ? (
            <div className="file-picker-empty">Type to search files and folders</div>
          ) : results.length === 0 ? (
            <div className="file-picker-empty">{loading ? 'Searching…' : 'No matching files'}</div>
          ) : (
            <>
              {folderCount > 0 && <div className="file-picker-group-header">Folders</div>}
              {results.slice(0, folderCount).map((r, i) => row(r, i))}
              {folderCount < results.length && <div className="file-picker-group-header">Files</div>}
              {results.slice(folderCount).map((r, i) => row(r, folderCount + i))}
            </>
          )}
        </div>,
        document.body,
      )}
    </FloatingSurfaceProvider>
  )
}
