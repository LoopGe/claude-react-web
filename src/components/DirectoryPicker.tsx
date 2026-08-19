// Modal directory picker.
//
// Browser has no real folder-chooser (File System Access API requires HTTPS
// and user gesture, and Electron-style dialogs aren't available), so we
// browse the server's filesystem instead. Click into sub-dirs, use ".." to
// go up, "Home" / "CWD" shortcuts, or edit the path inline and press Enter.

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../hooks/useApi'
import { useAutoHeightTransition } from '../hooks/useAutoHeightTransition'
import { useOverlayScrollbar } from '../hooks/useOverlayScrollbar'
import { useMergedRef } from '../utils/mergedRef'
import { buildCrumbs } from '../utils/paths'
import { IconFolder, IconX } from './icons/ToolIcons'
import { AnimatedCollapse } from './AnimatedCollapse'

interface DirEntry {
  name: string
  path: string
  isDir: boolean
}

interface ListResult {
  path: string
  parent: string | null
  entries: DirEntry[]
}

interface HomeResult {
  home: string
  cwd: string
  sep: string
}

interface Props {
  open?: boolean
  initialPath?: string
  title?: string
  selectLabel?: string
  footerHint?: string
  onPick: (path: string) => void
  onClose: () => void
}

export function DirectoryPicker({
  open = true,
  initialPath,
  title = 'Pick a working directory',
  selectLabel = 'Select this folder',
  footerHint = 'Double-click to enter · Click to select path · Enter confirms',
  onPick,
  onClose,
}: Props) {
  const [path, setPath] = useState<string>(initialPath ?? '')
  const [draft, setDraft] = useState<string>(initialPath ?? '')
  const [home, setHome] = useState<HomeResult | null>(null)
  const [list, setList] = useState<ListResult | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [showCreateRow, setShowCreateRow] = useState(false)
  const [createName, setCreateName] = useState('')
  const [creating, setCreating] = useState(false)
  const listBoxRef = useRef<HTMLDivElement>(null)
  const setListBoxOs = useOverlayScrollbar({ autoHide: 'leave' })
  const listBoxRefMerged = useMergedRef(listBoxRef, setListBoxOs)
  const listContentRef = useRef<HTMLDivElement>(null)

  const listAnimationKey = [
    loading ? 'loading' : 'ready',
    list?.path ?? '',
    list?.entries.length ?? 0,
  ].join('|')

  const measureListHeight = useCallback(() => {
    const listBox = listBoxRef.current
    const content = listContentRef.current
    if (!listBox || !content) return null
    const modal = listBox.closest('.modal') as HTMLElement | null
    const footer = modal?.querySelector('.modal-footer') as HTMLElement | null
    const availableModalHeight = modal?.parentElement?.clientHeight
      ? modal.parentElement.clientHeight * 0.84
      : Number.POSITIVE_INFINITY
    const availableListHeight = Math.max(0, availableModalHeight - listBox.offsetTop - (footer?.offsetHeight ?? 0))
    const listStyle = window.getComputedStyle(listBox)
    const verticalPadding = parseFloat(listStyle.paddingTop) + parseFloat(listStyle.paddingBottom)
    const contentHeight = content.scrollHeight + verticalPadding
    return Math.min(contentHeight, availableListHeight || contentHeight)
  }, [])

  const { captureHeight: captureListHeight } = useAutoHeightTransition(listBoxRef, listAnimationKey, {
    measureTargetHeight: measureListHeight,
    observe: listContentRef,
  })

  const loadList = useCallback(async (p: string, hidden: boolean) => {
    captureListHeight()
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<ListResult>(`/fs/list?path=${encodeURIComponent(p)}&hidden=${hidden ? 1 : 0}`)
      setList(res)
      setPath(res.path)
      setDraft(res.path)
      setShowCreateRow(false)
      setCreateName('')
      listBoxRef.current?.scrollTo({ top: 0 })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [captureListHeight])

  // Bootstrap: load home + initial listing
  useEffect(() => {
    ;(async () => {
      try {
        const h = await api.get<HomeResult>('/fs/home')
        setHome(h)
        await loadList(initialPath || h.cwd, false)
      } catch (e) {
        setError((e as Error).message)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const gotoDraft = () => {
    if (!draft.trim()) return
    void loadList(draft.trim(), showHidden)
  }

  const createFolder = useCallback(async () => {
    const name = createName.trim()
    if (!name || !list || creating) return
    setCreating(true)
    setError(null)
    try {
      const res = await api.post<{ path: string }>('/fs/mkdir', { parent: list.path, name })
      setCreateName('')
      setShowCreateRow(false)
      // Enter the new directory (spec §1: post-create behavior = enter).
      await loadList(res.path, showHidden)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setCreating(false)
    }
  }, [createName, list, creating, showHidden, loadList])

  // Close on Escape. Registered in the CAPTURE phase + stopImmediatePropagation
  // so the picker wins the Escape regardless of listener registration order.
  // Without this, App's global Escape chain (registered at mount, i.e. before
  // this picker) fires first and closes the whole NewSessionDialog underneath
  // instead of just dismissing the picker. Capture beats bubble, so we get the
  // event first and stop it from reaching the dialog's local handler and the
  // global chain. This makes Escape ownership consistent: the topmost open
  // overlay always handles it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (open && e.key === 'Escape') {
        e.stopImmediatePropagation()
        e.preventDefault()
        // The create row is the topmost overlay: consume one Escape to
        // dismiss it before falling through to close the whole picker.
        if (showCreateRow) {
          setShowCreateRow(false)
          setCreateName('')
          return
        }
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, open, showCreateRow])

  const crumbs = buildCrumbs(path)

  return (
    <div
      className="modal-backdrop"
      data-state={open ? 'open' : 'closing'}
      aria-hidden={!open}
      onMouseDown={(e) => open && e.target === e.currentTarget && onClose()}
    >
      <div className="modal">
        <div className="modal-header">
          <h3>{title}</h3>
          <button className="btn" onClick={onClose} style={{ padding: '2px 10px' }} aria-label="Close">
            <IconX size={14} />
          </button>
        </div>

        <div className="modal-toolbar">
          <button
            className="btn"
            onClick={() => home && void loadList(home.home, showHidden)}
            disabled={!home || creating}
            title="Home directory"
          >
            Home
          </button>
          <button
            className="btn"
            onClick={() => home && void loadList(home.cwd, showHidden)}
            disabled={!home || creating}
            title="Server working directory"
          >
            Server CWD
          </button>
          <button
            className="btn"
            onClick={() => list?.parent && void loadList(list.parent, showHidden)}
            disabled={!list?.parent || creating}
          >
            ↑ Up
          </button>
          <label className="toggle">
            <input type="checkbox" checked={showHidden} onChange={(e) => {
              setShowHidden(e.target.checked)
              void loadList(path, e.target.checked)
            }} />
            Hidden
          </label>
          <button
            className="btn"
            onClick={() => { setShowCreateRow(true); setCreateName('') }}
            disabled={loading || !list || creating}
            title="Create a new folder here"
          >
            + New folder
          </button>
        </div>

        <div className="modal-path">
          <input
            className="input"
            value={draft}
            disabled={creating}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                gotoDraft()
              }
            }}
            aria-label="Path"
            placeholder="/absolute/path"
            spellCheck={false}
          />
          <button className="btn" onClick={gotoDraft} disabled={loading || creating}>
            Go
          </button>
        </div>

        <div className="modal-crumbs">
          {crumbs.map((c, i) => (
            <span key={c.path}>
              <button className="crumb" onClick={() => void loadList(c.path, showHidden)} disabled={creating}>
                {c.label}
              </button>
              {i < crumbs.length - 1 && <span className="crumb-sep">/</span>}
            </span>
          ))}
        </div>

        <AnimatedCollapse open={!!error} className="modal-error-collapse">
          {error && <div className="modal-error">{error}</div>}
        </AnimatedCollapse>

        <div className="modal-list" ref={listBoxRefMerged}>
          {showCreateRow && (
            <div className="modal-create-row">
              <span className="folder-icon"><IconFolder size={14} /></span>
              <input
                className="input modal-create-input"
                autoFocus
                aria-label="New folder name"
                placeholder="Folder name"
                value={createName}
                disabled={creating}
                onChange={(e) => setCreateName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void createFolder()
                  }
                }}
                spellCheck={false}
              />
              <button
                className="btn"
                onClick={() => void createFolder()}
                disabled={creating || !createName.trim()}
              >
                {creating ? 'Creating…' : 'Create'}
              </button>
              <button
                className="btn btn-icon-sm"
                onClick={() => { setShowCreateRow(false); setCreateName('') }}
                disabled={creating}
                aria-label="Cancel create folder"
              >
                <IconX size={12} />
              </button>
            </div>
          )}
          <div className="modal-list-content" ref={listContentRef}>
            {loading ? (
              <div className="modal-empty">Loading...</div>
            ) : list && list.entries.length > 0 ? (
              list.entries.map((e) => (
                <button
                  key={e.path}
                  className="modal-list-item"
                  onDoubleClick={() => !creating && void loadList(e.path, showHidden)}
                  onClick={() => setDraft(e.path)}
                  disabled={creating}
                >
                  <span className="folder-icon"><IconFolder size={14} /></span>
                  <span className="folder-name">{e.name}</span>
                </button>
              ))
            ) : (
              <div className="modal-empty">{list ? '(empty directory)' : 'Loading...'}</div>
            )}
          </div>
        </div>

        <div className="modal-footer">
          <span className="hint">{footerHint}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={() => onPick((draft.trim() || path))}
              disabled={!draft.trim() && !path}
            >
              {selectLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
