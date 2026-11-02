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
// Shared open/search/keyboard/positioning behavior lives in
// useSearchablePicker. This file owns option rows and presentation only.

import { useCallback } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { IconCheck, IconChevronDown, IconChevronUp, IconSearch, IconX } from './icons/ToolIcons'
import { useSearchablePicker } from '../hooks/useSearchablePicker'

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
  const getRows = useCallback(
    (typed: string) => {
      const q = typed.toLowerCase()
      const filtered = q
        ? options.filter(
            (option) =>
              option.label.toLowerCase().includes(q) || (option.sub?.toLowerCase().includes(q) ?? false),
          )
        : options
      // Custom row LAST (ModelPicker's order). Prepending it would make it the
      // active row after every keystroke, so Enter would commit the filter text
      // ("opus") instead of the matched option ("claude-opus-4-…").
      // Suppressed when a real option's label already equals the query — otherwise
      // typing a Model Group name would offer a spurious `Use "Balanced"` row
      // alongside the matching group.
      const exactLabel = typed && options.some((option) => option.label.toLowerCase() === q)
      const extra = exactLabel ? null : (customOption?.(typed) ?? null)
      return extra ? [...filtered, extra] : filtered
    },
    [options, customOption],
  )

  const {
    open,
    search,
    rows,
    active,
    setActiveIndex,
    listRef,
    listId,
    optionId,
    close,
    activate,
    clearSearch,
    triggerProps,
    menuProps,
    searchProps,
  } = useSearchablePicker<FieldPickerOption>({
    id: id ?? 'field-picker',
    rows: getRows,
    searchable,
    menuLabel,
    listMaxVar: '--field-picker-list-max',
    enterOnButtons: 'activate-row',
    onActivate: choose,
  })

  function choose(option: FieldPickerOption): void {
    option.onSelect()
    close(true)
  }

  const hasValue = label !== ''

  return (
    <>
      <button
        id={id}
        type="button"
        className="field-picker-trigger"
        title={title ?? (hasValue ? label : placeholder)}
        {...triggerProps}
      >
        {icon != null && (
          <span className="field-picker-icon" aria-hidden>
            {icon}
          </span>
        )}
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
          <div className="field-picker-menu" {...menuProps}>
            {searchable && (
              <div className="field-picker-search">
                <IconSearch size={13} aria-hidden />
                <input placeholder={searchPlaceholder} aria-label={searchLabel} {...searchProps} />
                {search && (
                  <button
                    type="button"
                    className="field-picker-clear"
                    aria-label="Clear search"
                    onClick={clearSearch}
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
                    {showHeading && <div className="field-picker-heading">{row.heading}</div>}
                    <div
                      className={`field-picker-row${i === active ? ' active' : ''}`}
                      onMouseEnter={() => setActiveIndex(i)}
                    >
                      <button
                        type="button"
                        id={optionId(i)}
                        data-index={i}
                        className="field-picker-item"
                        role="option"
                        aria-selected={row.selected ?? false}
                        tabIndex={-1}
                        onClick={() => activate(row)}
                      >
                        {row.icon != null && (
                          <span className="field-picker-item-icon" aria-hidden>
                            {row.icon}
                          </span>
                        )}
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
