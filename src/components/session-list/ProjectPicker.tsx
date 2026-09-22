// Desktop-style project picker for the New session dialog.
//
// Replaces the old free-text "Working directory" input + <datalist> + recent
// chips. The trigger shows the current project (basename + parent path); the
// menu lists the current value first, then the recent list in MRU order, and
// accepts a pasted absolute path via the search box's "Use this path" row.
//
// The menu portals to <body> with viewport coordinates. Load-bearing, not
// cosmetic: the dialog card is `.modal` (overflow:hidden, animated) and its
// `.modal-section` is `overflow-y:auto`, so an in-flow dropdown is clipped by
// the scroll container the moment the visible section is shorter than the
// list — the same containing-block hazard documented for .model-picker /
// .cmd-picker. Because the menu is not a DOM descendant of the dialog, it
// registers in the shared Escape stack and outside-mousedown hook so Esc
// closes only the dropdown and the dialog's focus trap lets the search box
// keep focus (see isFocusInsideOtherOverlay).

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { FocusEvent as ReactFocusEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { IconCheck, IconChevronDown, IconChevronUp, IconFolder, IconSearch, IconX } from '../icons/ToolIcons'
import { useEscapeStack } from '../../hooks/useEscapeStack'
import { useOutsideMouseDown } from '../../hooks/useOutsideMouseDown'
import { markPortaledSurface } from '../../theme'
import { isAbsolutePath, shortenPath } from '../../utils/paths'

export interface ProjectPickerProps {
  /** Trigger element id, so the field's <label htmlFor> can point at it
   *  (a <button> is a labelable element). */
  id?: string
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

/** Last path segment — the project's display name. */
function basenameOf(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : p
}

/** Everything before the last separator (used for the dimmed sub-line). */
function parentOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i > 0 ? p.slice(0, i) : p
}

function initialOf(p: string): string {
  return (basenameOf(p)[0] ?? '?').toUpperCase()
}

/** Design maximum for the list, mirrored by the CSS default of
 *  `--project-picker-list-max`. The flip/height math below never grows the
 *  list past it. */
const MAX_LIST_H = 240

interface Row {
  kind: 'path' | 'project'
  path: string
}

export function ProjectPicker({ id, value, recents, onSelect, onForget, onBrowse }: ProjectPickerProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)

  const close = useCallback((restoreFocus = false) => {
    // Keyboard-driven closes (Escape / select) unmount the focused menu, which
    // would drop focus on <body>; hand it back to the trigger. Pointer-driven
    // closes (outside press, blur) must NOT steal focus from wherever the user
    // is headed, so they pass false (the default).
    const hadFocus = menuRef.current?.contains(document.activeElement) ?? false
    setOpen(false)
    setSearch('')
    setActiveIndex(0)
    if (restoreFocus && hadFocus) triggerRef.current?.focus()
  }, [])

  const typed = search.trim()
  // A pasted absolute path gets its own first row, preserving the old
  // free-text input's paste-a-path workflow without a text field.
  const showUsePath = isAbsolutePath(typed) && typed !== value

  const rows = useMemo<Row[]>(() => {
    // Current value first (drag-and-drop can prefill a path that isn't in the
    // recent list yet), then the MRU recents, de-duped.
    const all: string[] = []
    if (value) all.push(value)
    for (const p of recents) if (!all.includes(p)) all.push(p)
    const q = typed.toLowerCase()
    const filtered = q
      ? all.filter((p) => p.toLowerCase().includes(q) || basenameOf(p).toLowerCase().includes(q))
      : all
    const list: Row[] = filtered.map((path) => ({ kind: 'project', path }))
    if (showUsePath) list.unshift({ kind: 'path', path: typed })
    return list
  }, [value, recents, typed, showUsePath])

  const active = rows.length > 0 ? Math.min(activeIndex, rows.length - 1) : -1

  // Escape closes only the menu: the shared stack dispatches by containment,
  // and this entry is on top while open, so the New session dialog beneath it
  // stays put. Must be declared BEFORE the autofocus effect below — the stack
  // entry has to exist before focus moves into the portaled menu, or the
  // dialog's focus trap re-guards and steals it back.
  useEscapeStack({
    active: open,
    onEscape: () => close(true),
    getContainer: () => menuRef.current,
  })

  // Outside-click dismissal. The trigger is exempt (it toggles the menu), and
  // capture phase makes the menu collapse before any other mousedown handler.
  useOutsideMouseDown({ ref: menuRef, onClose: close, triggerRef, capture: true, active: open })

  // Focus the search box on open (layout phase, after the stack registration).
  useLayoutEffect(() => {
    if (open) searchRef.current?.focus()
  }, [open])

  // Anchor the portaled menu to the trigger and keep it in sync while the
  // dialog's scroll container (or the window) moves. Flips above the trigger
  // when the space below is too tight, and caps the list height through a CSS
  // variable so header/footer never get clipped.
  useLayoutEffect(() => {
    if (!open) return
    const menu = menuRef.current
    const trigger = triggerRef.current
    if (!menu || !trigger) return
    markPortaledSurface(menu)
    const update = () => {
      const rect = trigger.getBoundingClientRect()
      const vw = window.innerWidth
      const vh = window.innerHeight
      const gap = 6
      const margin = 8
      const listEl = listRef.current
      // Chrome height (search + footer + borders) is independent of the list's
      // max-height, so it stays stable while the cap below changes. The list's
      // natural height is its scrollHeight, capped at the design maximum —
      // measuring the rendered offsetHeight instead would read whatever cap a
      // previous update left behind and could pick the wrong side.
      const chromeH = Math.max(0, menu.offsetHeight - (listEl?.offsetHeight ?? 0))
      const naturalList = Math.min(listEl?.scrollHeight ?? 0, MAX_LIST_H)
      const menuH = chromeH + naturalList
      const width = Math.min(Math.max(rect.width, 264), vw - margin * 2)
      const left = Math.max(margin, Math.min(rect.left, vw - width - margin))
      const spaceBelow = vh - rect.bottom - margin
      const spaceAbove = rect.top - margin
      const openUp = spaceBelow < menuH && spaceAbove > spaceBelow
      const available = openUp ? spaceAbove : spaceBelow
      const listMax = Math.max(96, Math.min(MAX_LIST_H, available - chromeH - 8))
      // Position against the height we will actually render (`listMax` may be
      // smaller than `naturalList`). Using the uncapped `menuH` here left the
      // up-flipped menu floating well above its trigger. Same fix as
      // FieldPicker's update().
      const posH = chromeH + Math.min(naturalList, listMax)
      menu.style.width = `${width}px`
      menu.style.left = `${left}px`
      menu.style.top = `${openUp ? Math.max(margin, rect.top - gap - posH) : rect.bottom + gap}px`
      menu.style.setProperty('--project-picker-list-max', `${listMax}px`)
    }
    update()
    window.addEventListener('resize', update)
    document.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      document.removeEventListener('scroll', update, true)
    }
  }, [open, rows.length])

  // Keep the keyboard-highlighted row in view — the list scrolls under the
  // viewport-derived cap set by the positioning effect.
  useEffect(() => {
    if (!open || active < 0) return
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  // Tab-ing out of the menu closes it, so Escape can never land in the odd
  // state "menu visible but focus in the dialog" (where the stack's
  // containment scan would hand Esc to the dialog). Focus moving to the
  // trigger is exempt: the click that follows closes the menu anyway.
  //
  // A null `relatedTarget` is NOT an exit. Safari/WebKit blurs the focused
  // search box when a button is pressed (buttons don't take focus there), so a
  // plain click on a row or the footer would otherwise unmount the menu on
  // mousedown and swallow the ensuing click — the "nothing happens" bug. Real
  // pointer exits are owned by useOutsideMouseDown; this handler only needs to
  // catch keyboard focus moving to another control.
  const handleMenuBlur = (e: ReactFocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget as Node | null
    if (!next) return
    if (e.currentTarget.contains(next) || triggerRef.current?.contains(next)) return
    close()
  }

  const choose = (path: string) => {
    onSelect(path)
    close(true)
  }

  const handleMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (rows.length) setActiveIndex((i) => (Math.min(i, rows.length - 1) + 1) % rows.length)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (rows.length) setActiveIndex((i) => (Math.min(i, rows.length - 1) - 1 + rows.length) % rows.length)
      return
    }
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      const row = rows[active]
      if (row) choose(row.path)
    }
  }

  const menuId = `${id ?? 'project-picker'}-menu`
  const listId = `${menuId}-list`

  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className="project-picker-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={value || 'Choose a project'}
        onClick={() => (open ? close() : setOpen(true))}
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
          <div
            ref={menuRef}
            id={menuId}
            className="project-picker-menu"
            role="dialog"
            aria-label="Choose a project"
            onKeyDown={handleMenuKeyDown}
            onBlur={handleMenuBlur}
          >
            <div className="project-picker-search">
              <IconSearch size={13} aria-hidden />
              <input
                ref={searchRef}
                type="text"
                value={search}
                placeholder="Search projects…"
                aria-label="Search projects"
                aria-controls={listId}
                aria-activedescendant={active >= 0 ? `${menuId}-opt-${active}` : undefined}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => {
                  setSearch(e.target.value)
                  setActiveIndex(0)
                }}
              />
              {search && (
                <button
                  type="button"
                  className="project-picker-clear"
                  aria-label="Clear search"
                  onClick={() => {
                    setSearch('')
                    setActiveIndex(0)
                    searchRef.current?.focus()
                  }}
                >
                  <IconX size={12} />
                </button>
              )}
            </div>

            <div ref={listRef} id={listId} className="project-picker-list" role="listbox" aria-label="Projects">
              {rows.length === 0 && <div className="project-picker-empty">No matching projects</div>}
              {rows.map((row, i) => (
                <div
                  key={`${row.kind}:${row.path}`}
                  className={`project-picker-row${i === active ? ' active' : ''}`}
                  onMouseEnter={() => setActiveIndex(i)}
                >
                  <button
                    type="button"
                    id={`${menuId}-opt-${i}`}
                    data-index={i}
                    className="project-picker-item"
                    role="option"
                    aria-selected={row.kind === 'project' && row.path === value}
                    tabIndex={-1}
                    onClick={() => choose(row.path)}
                  >
                    {row.kind === 'path' ? (
                      <>
                        <span className="project-picker-use-icon" aria-hidden>↵</span>
                        <span className="project-picker-item-main">
                          <span className="project-picker-item-name">Use this path</span>
                          <code className="project-picker-item-path">{row.path}</code>
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="project-picker-avatar" aria-hidden>{initialOf(row.path)}</span>
                        <span className="project-picker-item-main">
                          <span className="project-picker-item-name">{basenameOf(row.path)}</span>
                          <span className="project-picker-item-path">{shortenPath(parentOf(row.path))}</span>
                        </span>
                        <span className="project-picker-item-spacer" />
                        {row.path === value && <IconCheck size={13} className="project-picker-check" aria-hidden />}
                      </>
                    )}
                  </button>
                  {row.kind === 'project' && (
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
