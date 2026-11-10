// Desktop-style project picker for the New session dialog.
//
// Replaces the old free-text "Working directory" input + <datalist> + recent
// chips. The trigger shows the current project (basename + parent path); the
// menu lists the current value first, then the recent list in MRU order, and
// accepts a pasted absolute path via the search box's "Use this path" row.
//
// Shared open/search/keyboard/positioning behavior lives in
// useSearchablePicker. Directory validation, preflight, recents, the footer
// action and the overlay-scrollbar adapter remain ProjectPicker concerns.

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconCheck, IconChevronDown, IconChevronUp, IconFolder, IconX } from '../icons/ToolIcons'
import { SearchField } from '../SearchField'
import { useOverlayScrollbar } from '../../hooks/useOverlayScrollbar'
import { useSearchablePicker } from '../../hooks/useSearchablePicker'
import { useMergedRef } from '../../utils/mergedRef'
import { directoryMissing } from '../../utils/fs-validation'
import { isAbsolutePath, shortenPath, basenameOf, parentOf, initialOf } from '../../utils/paths'

export interface ProjectPickerProps {
  /** Trigger element id, so the field's <label htmlFor> can point at it
   *  (a <button> is a labelable element). */
  id?: string
  /** Accessible name for the trigger (e.g. the field's aria-label). */
  ariaLabel?: string
  /** Disable the trigger (e.g. user-scope installs, or an install in flight). */
  disabled?: boolean
  /** Currently selected directory. Empty string = none chosen yet. */
  value: string
  /** Recently used directories, MRU order (most recent first). */
  recents: string[]
  /** Choose a directory (fills the dialog's cwd field). */
  onSelect: (path: string) => void
  /** Drop one entry from the recent list. */
  onForget: (path: string) => void
  /** Open the server-side directory browser (the "Open project…" action). */
  onBrowse: () => void
}

interface Row {
  kind: 'path' | 'project'
  path: string
}

export function ProjectPicker({
  id,
  ariaLabel,
  disabled,
  value,
  recents,
  onSelect,
  onForget,
  onBrowse,
}: ProjectPickerProps) {
  // Directories confirmed gone by /fs/resolve-cwd (404). Recents can point at
  // folders that were moved or deleted since they were remembered.
  const [missingPaths, setMissingPaths] = useState<ReadonlySet<string>>(() => new Set())
  // Verdicts already proven GOOD this session (skips the choose preflight),
  // and a per-path generation so a stale concurrent response can never
  // overwrite a newer verdict.
  const knownGoodRef = useRef<Set<string>>(new Set())
  const validationGenRef = useRef(new Map<string, number>())
  // The project's unified overlay scrollbar (same attach as ModelPicker).
  const setListOs = useOverlayScrollbar({ autoHide: 'leave' })

  const resetValidation = useCallback(() => {
    setMissingPaths(new Set())
    knownGoodRef.current.clear()
  }, [])

  const getRows = useCallback(
    (typed: string): Row[] => {
      const showUsePath = isAbsolutePath(typed) && typed !== value
      // Current value first (drag-and-drop can prefill a path that isn't in the
      // recent list yet), then the MRU recents, de-duped.
      const all: string[] = []
      if (value) all.push(value)
      for (const path of recents) if (!all.includes(path)) all.push(path)
      const q = typed.toLowerCase()
      const filtered = q
        ? all.filter((path) => path.toLowerCase().includes(q) || basenameOf(path).toLowerCase().includes(q))
        : all
      const list: Row[] = filtered.map((path) => ({ kind: 'project', path }))
      // A pasted absolute path gets its own first row, preserving the old
      // free-text input's paste-a-path workflow without a text field.
      if (showUsePath) list.unshift({ kind: 'path', path: typed })
      return list
    },
    [value, recents],
  )

  const {
    open,
    search,
    typed,
    rows,
    active,
    hover,
    listRef,
    listId,
    optionId,
    close,
    activate,
    searchRef,
    setSearchValue,
    triggerProps,
    menuProps,
  } = useSearchablePicker<Row>({
    id: id ?? 'project-picker',
    rows: getRows,
    disabled,
    menuLabel: 'Choose a project',
    listMaxVar: '--project-picker-list-max',
    enterOnButtons: 'native',
    onReset: resetValidation,
    onActivate: choose,
  })
  const listRefMerged = useMergedRef(listRef, setListOs)
  const showUsePath = isAbsolutePath(typed) && typed !== value

  /** Check one directory against /fs/resolve-cwd. Only a definite "gone"
   *  (404, or a FILE at that path) disables the row — any other failure
   *  clears the flag again (fail-open: a flaky check must not lock the user
   *  out of a directory that may be perfectly fine). */
  const checkPath = (path: string, signal: AbortSignal) => {
    const gen = (validationGenRef.current.get(path) ?? 0) + 1
    validationGenRef.current.set(path, gen)
    void directoryMissing(path, signal).then((gone) => {
      // A stale response (an older concurrent check, or one fired before the
      // session was aborted) must never overwrite the newer verdict.
      if (signal.aborted || validationGenRef.current.get(path) !== gen) return
      if (gone) knownGoodRef.current.delete(path)
      else knownGoodRef.current.add(path)
      setMissingPaths((prev) => {
        if (gone === prev.has(path)) return prev
        const next = new Set(prev)
        if (gone) next.add(path)
        else next.delete(path)
        return next
      })
    })
  }

  // While the menu is open, check that the listed directories still exist.
  // One AbortController per OPEN SESSION: changing recents mid-flight must
  // not abort the other entries' pending checks (and `validatedRef` dedupes
  // so a Forget never restarts the batch). Closing aborts everything and
  // clears the cache so the next open revalidates fresh.
  const validatedRef = useRef<Set<string>>(new Set())
  const validationSessionRef = useRef<AbortController | null>(null)
  useEffect(() => {
    if (!open) {
      validationSessionRef.current?.abort()
      validationSessionRef.current = null
      validatedRef.current.clear()
      knownGoodRef.current.clear()
      return
    }
    if (!validationSessionRef.current) validationSessionRef.current = new AbortController()
    const paths = Array.from(new Set([value, ...recents].filter(Boolean)))
    const signal = validationSessionRef.current.signal
    for (const path of paths) {
      if (validatedRef.current.has(path)) continue
      validatedRef.current.add(path)
      checkPath(path, signal)
    }
  }, [open, value, recents])
  // Unmount aborts whatever is still pending.
  useEffect(() => () => validationSessionRef.current?.abort(), [])

  // The typed "Use this path" row is validated too (debounced per keystroke
  // pause) — a typo'd absolute path must not install into an unintended new
  // directory.
  useEffect(() => {
    if (!open || !showUsePath) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => checkPath(typed, controller.signal), 400)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [open, showUsePath, typed])

  async function choose(row: Row): Promise<void> {
    const path = row.path
    if (missingPaths.has(path)) return
    // A path whose verdict isn't known yet gets preflighted before it can be
    // selected — clicking fast must not slip a deleted project through.
    if (!knownGoodRef.current.has(path)) {
      const gone = await directoryMissing(path, new AbortController().signal)
      if (gone) {
        setMissingPaths((prev) => new Set(prev).add(path))
        return
      }
      knownGoodRef.current.add(path)
    }
    onSelect(path)
    close(true)
  }

  return (
    <>
      <button
        id={id}
        type="button"
        className="project-picker-trigger"
        aria-label={ariaLabel ? (value ? `${ariaLabel}: ${value}` : ariaLabel) : undefined}
        disabled={disabled}
        title={value || 'Choose a project'}
        {...triggerProps}
      >
        <span className={`project-picker-avatar${value ? '' : ' empty'}`} aria-hidden>
          {value ? initialOf(value) : '?'}
        </span>
        <span className={`project-picker-name${value ? '' : ' placeholder'}`}>
          {value ? basenameOf(value) : 'Choose a project'}
        </span>
        {value && <span className="project-picker-path">{shortenPath(parentOf(value))}</span>}
        <span className="project-picker-chevron" aria-hidden>
          {open ? <IconChevronUp size={12} /> : <IconChevronDown size={12} />}
        </span>
      </button>

      {open &&
        createPortal(
          <div className="project-picker-menu" {...menuProps}>
            <SearchField
              value={search}
              onChange={setSearchValue}
              placeholder="Search projects…"
              ariaLabel="Search projects"
              wrapperClassName="project-picker-search"
              inputRef={searchRef}
              ariaControls={listId}
              ariaActiveDescendant={active >= 0 ? optionId(active) : undefined}
            />

            <div
              ref={listRefMerged}
              id={listId}
              className="project-picker-list"
              role="listbox"
              aria-label="Projects"
            >
              {rows.length === 0 && <div className="project-picker-empty">No matching projects</div>}
              {rows.map((row, i) => (
                <div
                  key={`${row.kind}:${row.path}`}
                  className={`project-picker-row${i === active ? ' active' : ''}`}
                  onMouseEnter={() => hover(i)}
                >
                  <button
                    type="button"
                    id={optionId(i)}
                    data-index={i}
                    className="project-picker-item"
                    role="option"
                    aria-selected={row.kind === 'project' && row.path === value}
                    disabled={missingPaths.has(row.path)}
                    tabIndex={-1}
                    onClick={() => activate(row)}
                  >
                    {row.kind === 'path' ? (
                      <>
                        <span className="project-picker-use-icon" aria-hidden>
                          ↵
                        </span>
                        <span className="project-picker-item-main">
                          <span className="project-picker-item-name">Use this path</span>
                          <code className="project-picker-item-path">{row.path}</code>
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="project-picker-avatar" aria-hidden>
                          {initialOf(row.path)}
                        </span>
                        <span className="project-picker-item-main">
                          <span className="project-picker-item-name">{basenameOf(row.path)}</span>
                          <span className="project-picker-item-path">{shortenPath(parentOf(row.path))}</span>
                        </span>
                        <span className="project-picker-item-spacer" />
                        {row.path === value && (
                          <IconCheck size={13} className="project-picker-check" aria-hidden />
                        )}
                      </>
                    )}
                    {missingPaths.has(row.path) && (
                      <span className="project-picker-missing">Directory not found</span>
                    )}
                  </button>
                  {row.kind === 'project' && recents.includes(row.path) && (
                    <button
                      type="button"
                      className="project-picker-forget"
                      title="Forget this path"
                      aria-label={`Forget ${row.path}`}
                      onClick={() => onForget(row.path)}
                    >
                      <IconX size={11} />
                    </button>
                  )}
                </div>
              ))}
            </div>

            <div className="project-picker-foot">
              <button
                type="button"
                onClick={() => {
                  close()
                  onBrowse()
                }}
              >
                <IconFolder size={13} aria-hidden />
                Open project…
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
