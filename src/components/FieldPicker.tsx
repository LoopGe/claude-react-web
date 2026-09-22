// Generic field-style dropdown for the New session dialog (and any form
// field that needs the same selection effect as ProjectPicker).
//
// Trigger + portaled searchable menu + selected check + optional per-row
// forget, mirroring ProjectPicker's shell but data-driven: callers pass
// options (label / sub / icon / selected / onSelect / onForget) instead of
// path-specific rows. The menu portals to <body> for the same load-bearing
// reason ProjectPicker documents: the dialog card is overflow:hidden and its
// section is overflow-y:auto, so an in-flow dropdown gets clipped.
//
// Escape / outside-mousedown / focus-trap behaviour is copied from
// ProjectPicker so a menu on top of the New session dialog never collapses
// the dialog underneath it.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { FocusEvent as ReactFocusEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { IconCheck, IconChevronDown, IconChevronUp, IconSearch, IconX } from './icons/ToolIcons'
import { useEscapeStack } from '../hooks/useEscapeStack'
import { useOutsideMouseDown } from '../hooks/useOutsideMouseDown'
import { markPortaledSurface } from '../theme'

export interface FieldPickerOption {
  key: string
  label: string
  /** Secondary muted text (right side of the trigger, under the label in rows). */
  sub?: string
  /** Leading node for the row (icon / avatar). */
  icon?: ReactNode
  /** Section heading shown above this row (only set it on the first row of a section). */
  heading?: string
  /** True when this option is the current selection (renders a check). */
  selected?: boolean
  /** Optional trailing forget action. When set, a forget button is shown on hover. */
  onForget?: () => void
  forgetLabel?: string
  onSelect: () => void
}

export interface FieldPickerProps {
  /** Trigger element id, so the field's <label htmlFor> can point at it. */
  id?: string
  /** Primary text on the trigger. Empty shows `placeholder`. */
  label: string
  /** Secondary muted text on the trigger (right side). */
  sub?: string
  /** Leading node on the trigger (icon / avatar). */
  icon?: ReactNode
  /** Shown on the trigger when `label` is empty. */
  placeholder?: string
  /** Trigger `title` attribute (defaults to label || placeholder). */
  title?: string
  options: FieldPickerOption[]
  /** Show the search box. Default true. */
  searchable?: boolean
  searchPlaceholder?: string
  /** aria-label for the search box. */
  searchLabel?: string
  /** aria-label for the menu. */
  menuLabel?: string
  emptyText?: string
  /** Extra row appended LAST when the query is non-empty (e.g. "Use «term»").
   *  Must stay last: a prepended custom row becomes the active row after every
   *  keystroke, so Enter would commit the filter text instead of the match. */
  customOption?: (query: string) => FieldPickerOption | null
}

/** Design maximum for the list, mirrored by the CSS default of
 *  `--field-picker-list-max`. Matches ProjectPicker's cap. */
const MAX_LIST_H = 240

export function FieldPicker({
  id,
  label,
  sub,
  icon,
  placeholder = 'Select…',
  title,
  options,
  searchable = true,
  searchPlaceholder = 'Search…',
  searchLabel = 'Search',
  menuLabel = 'Choose an option',
  emptyText = 'No matches',
  customOption,
}: FieldPickerProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)

  const close = useCallback((restoreFocus = false) => {
    // Same focus contract as ProjectPicker: keyboard-driven closes hand focus
    // back to the trigger; pointer-driven closes leave it wherever it's headed.
    const hadFocus = menuRef.current?.contains(document.activeElement) ?? false
    setOpen(false)
    setSearch('')
    setActiveIndex(0)
    if (restoreFocus && hadFocus) triggerRef.current?.focus()
  }, [])

  const typed = search.trim()

  const rows = useMemo(() => {
    const q = typed.toLowerCase()
    const filtered = q
      ? options.filter(
          (o) =>
            o.label.toLowerCase().includes(q) || (o.sub?.toLowerCase().includes(q) ?? false),
        )
      : options
    // Custom row LAST (ModelPicker's order). Prepending it would make it the
    // active row after every keystroke, so Enter would commit the filter text
    // ("opus") instead of the matched option ("claude-opus-4-…").
    // Suppressed when a real option's label already equals the query — otherwise
    // typing a Model Group name would offer a spurious `Use "Balanced"` row
    // alongside the matching group.
    const exactLabel = typed && options.some((o) => o.label.toLowerCase() === q)
    const extra = exactLabel ? null : (customOption?.(typed) ?? null)
    return extra ? [...filtered, extra] : filtered
  }, [options, typed, customOption])

  const active = rows.length > 0 ? Math.min(activeIndex, rows.length - 1) : -1

  // Escape closes only the menu — must register BEFORE the autofocus effect
  // (see ProjectPicker / ModelPicker for why the order is load-bearing).
  useEscapeStack({
    active: open,
    onEscape: () => close(true),
    getContainer: () => menuRef.current,
  })

  useOutsideMouseDown({ ref: menuRef, onClose: close, triggerRef, capture: true, active: open })

  useLayoutEffect(() => {
    if (open) {
      if (searchable) searchRef.current?.focus()
      else listRef.current?.focus()
    }
  }, [open, searchable])

  // Anchor the portaled menu to the trigger (flip up when tight below).
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
      // up-flipped menu floating well above its trigger.
      const posH = chromeH + Math.min(naturalList, listMax)
      menu.style.width = `${width}px`
      menu.style.left = `${left}px`
      menu.style.top = `${openUp ? Math.max(margin, rect.top - gap - posH) : rect.bottom + gap}px`
      menu.style.setProperty('--field-picker-list-max', `${listMax}px`)
    }
    update()
    window.addEventListener('resize', update)
    document.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      document.removeEventListener('scroll', update, true)
    }
  }, [open, rows.length])

  useEffect(() => {
    if (!open || active < 0) return
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  // Tab-out closes (null relatedTarget is NOT an exit — Safari blur).
  const handleMenuBlur = (e: ReactFocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget as Node | null
    if (!next) return
    if (e.currentTarget.contains(next) || triggerRef.current?.contains(next)) return
    close()
  }

  const choose = (option: FieldPickerOption) => {
    option.onSelect()
    close(true)
  }

  const handleMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // IME composition owns the arrows (candidate navigation) — don't steal them.
    if (e.key === 'ArrowDown' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (rows.length) setActiveIndex((i) => (Math.min(i, rows.length - 1) + 1) % rows.length)
      return
    }
    if (e.key === 'ArrowUp' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (rows.length) setActiveIndex((i) => (Math.min(i, rows.length - 1) - 1 + rows.length) % rows.length)
      return
    }
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      const row = rows[active]
      if (row) choose(row)
    }
  }

  const menuId = `${id ?? 'field-picker'}-menu`
  const listId = `${menuId}-list`
  const hasValue = label !== ''

  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className="field-picker-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={title ?? (hasValue ? label : placeholder)}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {icon != null && <span className="field-picker-icon" aria-hidden>{icon}</span>}
        <span className={`field-picker-label${hasValue ? '' : ' placeholder'}`}>
          {hasValue ? label : placeholder}
        </span>
        {sub && <span className="field-picker-sub">{sub}</span>}
        <span className="field-picker-chevron" aria-hidden>
          {open ? <IconChevronUp size={12} /> : <IconChevronDown size={12} />}
        </span>
      </button>

      {open &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            className="field-picker-menu"
            role="dialog"
            aria-label={menuLabel}
            onKeyDown={handleMenuKeyDown}
            onBlur={handleMenuBlur}
          >
            {searchable && (
              <div className="field-picker-search">
                <IconSearch size={13} aria-hidden />
                <input
                  ref={searchRef}
                  type="text"
                  value={search}
                  placeholder={searchPlaceholder}
                  aria-label={searchLabel}
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
                    className="field-picker-clear"
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
            )}

            <div
              ref={listRef}
              id={listId}
              className="field-picker-list"
              role="listbox"
              aria-label={menuLabel}
              tabIndex={searchable ? -1 : 0}
            >
              {rows.length === 0 && <div className="field-picker-empty">{emptyText}</div>}
              {rows.map((row, i) => {
                // Show a section heading on the first VISIBLE row of that
                // section. Stamping it only on the source list's first row
                // made it vanish whenever that row was filtered out.
                const prev = i > 0 ? rows[i - 1] : undefined
                const showHeading = row.heading !== undefined && row.heading !== prev?.heading
                return (
                <div key={row.key}>
                  {showHeading && (
                    <div className="field-picker-heading">{row.heading}</div>
                  )}
                  <div
                    className={`field-picker-row${i === active ? ' active' : ''}`}
                    onMouseEnter={() => setActiveIndex(i)}
                  >
                  <button
                    type="button"
                    id={`${menuId}-opt-${i}`}
                    data-index={i}
                    className="field-picker-item"
                    role="option"
                    aria-selected={row.selected ?? false}
                    tabIndex={-1}
                    onClick={() => choose(row)}
                  >
                    {row.icon != null && <span className="field-picker-item-icon" aria-hidden>{row.icon}</span>}
                    <span className="field-picker-item-main">
                      <span className="field-picker-item-name">{row.label}</span>
                      {row.sub && <span className="field-picker-item-sub">{row.sub}</span>}
                    </span>
                    <span className="field-picker-item-spacer" />
                    {row.selected && <IconCheck size={13} className="field-picker-check" aria-hidden />}
                  </button>
                  {row.onForget && (
                    <button
                      type="button"
                      className="field-picker-forget"
                      title={row.forgetLabel ?? 'Forget'}
                      aria-label={row.forgetLabel ?? `Forget ${row.label}`}
                      onClick={() => row.onForget?.()}
                    >
                      <IconX size={11} />
                    </button>
                  )}
                  </div>
                </div>
                )
              })}
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
