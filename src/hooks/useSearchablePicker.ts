import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { FocusEvent as ReactFocusEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useEscapeStack } from './useEscapeStack'
import { useOutsideMouseDown } from './useOutsideMouseDown'
import { markPortaledSurface } from '../theme'
import { clamp } from '../utils/clamp'

const MAX_LIST_H = 240

interface Options<T> {
  id?: string
  /** Build visible rows from the trimmed query. Business filtering, custom
   *  rows and MRU/path logic stay with the caller. */
  rows: (query: string) => readonly T[]
  searchable?: boolean
  disabled?: boolean
  menuLabel?: string
  listMaxVar: string
  /** Project keeps native button Enter; Field activates the highlighted row. */
  enterOnButtons?: 'activate-row' | 'native'
  /** Called for keyboard and pointer activation. The caller decides whether
   *  activation closes immediately or after async work. */
  onActivate: (row: T) => void | Promise<void>
  /** Per-open caller state to clear on close/disable. */
  onReset?: () => void
}

/** Shared controller for the FieldPicker / ProjectPicker interaction shell.
 *  Rendering, business rows, validation and scrollbar adapters stay outside. */
export function useSearchablePicker<T>({
  id,
  rows: getRows,
  searchable = true,
  disabled = false,
  menuLabel = 'Options',
  listMaxVar,
  enterOnButtons = 'activate-row',
  onActivate,
  onReset,
}: Options<T>) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)

  const close = useCallback(
    (restoreFocus = false) => {
      // Keyboard closes restore focus only when focus was inside the menu;
      // pointer closes leave it wherever the user is headed.
      const hadFocus = menuRef.current?.contains(document.activeElement) ?? false
      setOpen(false)
      setSearch('')
      setActiveIndex(0)
      onReset?.()
      if (restoreFocus && hadFocus) triggerRef.current?.focus()
    },
    [onReset],
  )

  const toggle = useCallback(() => {
    if (open) close()
    else setOpen(true)
  }, [open, close])

  // Disabling retires an open menu in render, not an effect, so it cannot
  // paint once more while the caller is busy. This mirrors ProjectPicker.
  const [wasDisabled, setWasDisabled] = useState(disabled)
  if (wasDisabled !== disabled) {
    setWasDisabled(disabled)
    if (disabled) {
      setOpen(false)
      setSearch('')
      setActiveIndex(0)
      onReset?.()
    }
  }

  const typed = search.trim()
  const rows = useMemo(() => getRows(typed), [getRows, typed])
  const active = rows.length > 0 ? Math.min(activeIndex, rows.length - 1) : -1

  // Register before autofocus so a parent dialog's focus trap cannot reclaim
  // focus from the portaled menu during its first open render.
  useEscapeStack({
    active: open,
    onEscape: () => close(true),
    getContainer: () => menuRef.current,
  })

  useOutsideMouseDown({ ref: menuRef, onClose: close, triggerRef, capture: true, active: open })

  useLayoutEffect(() => {
    if (!open) return
    if (searchable) searchRef.current?.focus()
    else listRef.current?.focus()
  }, [open, searchable])

  // Anchor the portaled menu and keep the list cap/flip in sync with resize
  // and capture-scroll. Chrome height stays independent of the list cap.
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
      const width = clamp(rect.width, 264, vw - margin * 2)
      const left = clamp(rect.left, margin, vw - width - margin)
      const spaceBelow = vh - rect.bottom - margin
      const spaceAbove = rect.top - margin
      const openUp = spaceBelow < menuH && spaceAbove > spaceBelow
      const available = openUp ? spaceAbove : spaceBelow
      const listMax = clamp(available - chromeH - 8, 96, MAX_LIST_H)
      const posH = chromeH + Math.min(naturalList, listMax)
      menu.style.width = `${width}px`
      menu.style.left = `${left}px`
      menu.style.top = `${openUp ? Math.max(margin, rect.top - gap - posH) : rect.bottom + gap}px`
      menu.style.setProperty(listMaxVar, `${listMax}px`)
    }
    update()
    window.addEventListener('resize', update)
    document.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      document.removeEventListener('scroll', update, true)
    }
  }, [open, rows.length, listMaxVar])

  useEffect(() => {
    if (!open || active < 0) return
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  const handleMenuBlur = (event: ReactFocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null
    // Safari blurs without a relatedTarget on button mousedown; that is not
    // an exit. Real pointer exits belong to useOutsideMouseDown.
    if (!next) return
    if (event.currentTarget.contains(next) || triggerRef.current?.contains(next)) return
    close()
  }

  const activate = useCallback(
    (row: T) => {
      void onActivate(row)
    },
    [onActivate],
  )

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (rows.length) setActiveIndex((index) => (Math.min(index, rows.length - 1) + 1) % rows.length)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (rows.length)
        setActiveIndex((index) => (Math.min(index, rows.length - 1) - 1 + rows.length) % rows.length)
      return
    }
    if (event.key === 'Enter') {
      if (enterOnButtons === 'native' && (event.target as HTMLElement).closest('button')) return
      event.preventDefault()
      const row = rows[active]
      if (row) activate(row)
    }
  }

  const clearSearch = useCallback(() => {
    setSearch('')
    setActiveIndex(0)
    searchRef.current?.focus()
  }, [])

  const menuId = `${id ?? 'searchable-picker'}-menu`
  const listId = `${menuId}-list`
  const optionId = (index: number) => `${menuId}-opt-${index}`

  return {
    open,
    search,
    typed,
    rows,
    active,
    setActiveIndex,
    listRef,
    menuId,
    listId,
    optionId,
    close,
    toggle,
    activate,
    clearSearch,
    triggerProps: {
      ref: triggerRef,
      'aria-haspopup': 'dialog' as const,
      'aria-expanded': open,
      'aria-controls': open ? menuId : undefined,
      onClick: toggle,
    },
    menuProps: {
      ref: menuRef,
      id: menuId,
      role: 'dialog',
      'aria-label': menuLabel,
      onKeyDown: handleMenuKeyDown,
      onBlur: handleMenuBlur,
    },
    searchProps: {
      ref: searchRef,
      type: 'text' as const,
      value: search,
      'aria-controls': listId,
      'aria-activedescendant': active >= 0 ? optionId(active) : undefined,
      spellCheck: false,
      autoComplete: 'off',
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
        setSearch(event.target.value)
        setActiveIndex(0)
      },
    },
  }
}
