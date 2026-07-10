// Searchable model dropdown anchored under the ChatPanel header chip.
//
// Replaces the old <input> + <datalist> combobox. Combines the patterns
// already used elsewhere in the app:
//   - CommandPalette: search input + listbox + arrow/Enter navigation
//   - ContextMenu: fixed positioning at an anchor point, viewport clamp,
//     outside-click / capture-phase Escape dismissal
//
// Items are shown in groups (Recent / Models). The first model in the
// list IS the default — when a session has no explicit model the first
// Models entry is marked selected. When the search term matches no known
// option, an extra "use <term> (custom)" row lets the user commit an
// arbitrary id — important for proxy models the SDK doesn't advertise.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'motion/react'
import type { ModelOptions } from '../hooks/useModelOptions'
import { useOverlayScrollbar } from '../hooks/useOverlayScrollbar'
import { useMergedRef } from '../utils/mergedRef'
import { MENU_ENTER_TRANSITION, EXIT_TRANSITION, useMotionTransition } from '../utils/transitions'
import { IconCheck, IconSearch } from './icons/ToolIcons'

interface Props {
  /** Client-coordinate anchor (typically the chip's bottom-left). */
  anchor: { x: number; y: number }
  /** Currently selected model id. Undefined/empty means the session has
   *  no explicit model — the first model in the list is treated as the
   *  effective default and marked selected. */
  current: string | undefined
  options: ModelOptions
  disabled?: boolean
  /** Called with the chosen concrete model id. */
  onSelect: (model: string) => void
  onClose: () => void
}

/** A flattened, selectable row. `kind` drives the value passed to onSelect. */
interface Row {
  key: string
  label: string
  /** Secondary muted text (e.g. the raw id under a display name). */
  sub?: string
  /** Group heading shown above this row (only on the first row of a group). */
  heading?: string
  /** True when this row corresponds to the current selection. */
  active: boolean
  select: () => void
}

export function ModelPicker({ anchor, current, options, disabled, onSelect, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const setListOs = useOverlayScrollbar({ autoHide: 'leave' })
  const listRefMerged = useMergedRef(listRef, setListOs)
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [pos, setPos] = useState<{ x: number; y: number }>(anchor)
  // Under reduced motion, snap (duration:0) instead of fading — see
  // useMotionTransition.
  const enterT = useMotionTransition(MENU_ENTER_TRANSITION)
  const exitT = useMotionTransition(EXIT_TRANSITION)

  // Build the flat, grouped, filtered row list.
  const rows: Row[] = useMemo(() => {
    const q = query.trim().toLowerCase()
    const match = (id: string, name?: string) =>
      !q || id.toLowerCase().includes(q) || (name?.toLowerCase().includes(q) ?? false)

    // Recents that aren't already in the model list (dedupe by id).
    const modelIds = new Set(options.models.map((m) => m.id))
    const recents = options.recents.filter((id) => id && !modelIds.has(id) && match(id))
    const models = options.models.filter((m) => match(m.id, m.displayName))

    const result: Row[] = []
    let firstInGroup = true

    if (recents.length > 0) {
      firstInGroup = true
      for (const id of recents) {
        result.push({
          key: `recent:${id}`,
          label: id,
          heading: firstInGroup ? 'Recent' : undefined,
          active: current === id,
          select: () => onSelect(id),
        })
        firstInGroup = false
      }
    }

    // When the session has no explicit model, mark the server's default
    // (config.modelList[0], reported by the hook) as selected — this is the
    // same id the server pins on create, so the two stay in lockstep. Fall
    // back to the first listed model only if the default is unknown (e.g.
    // /config hasn't resolved yet).
    const defaultId = options.defaultModel ?? options.models[0]?.id
    if (models.length > 0) {
      firstInGroup = true
      for (const m of models) {
        const hasName = !!m.displayName && m.displayName !== m.id
        result.push({
          key: `model:${m.id}`,
          label: m.displayName || m.id,
          sub: hasName ? m.id : undefined,
          heading: firstInGroup ? 'Models' : undefined,
          active: current ? current === m.id : m.id === defaultId,
          select: () => onSelect(m.id),
        })
        firstInGroup = false
      }
    }

    // Custom row: search term that exactly matches nothing known.
    const raw = query.trim()
    if (raw) {
      const known = modelIds.has(raw) || options.recents.includes(raw)
      if (!known) {
        result.push({
          key: 'custom',
          label: `Use “${raw}”`,
          sub: 'custom',
          heading: result.length > 0 ? ' ' : undefined,
          active: false,
          select: () => onSelect(raw),
        })
      }
    }

    return result
  }, [query, options, current, onSelect])

  // Clamp inline rather than in an effect: when the row set shrinks (e.g.
  // a search narrows the list) the stored index may exceed the new length,
  // so the rendered/active index is always derived, not stored stale.
  const activeIndex = Math.min(selectedIndex, Math.max(0, rows.length - 1))

  // Measure after layout and nudge inward to stay in the viewport.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const nx = Math.min(anchor.x, vw - rect.width - 4)
    const ny = Math.min(anchor.y, vh - rect.height - 4)
    setPos({ x: Math.max(4, nx), y: Math.max(4, ny) })
  }, [anchor.x, anchor.y, rows.length])

  // Autofocus the search box on open.
  useLayoutEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Keep the highlighted row in view.
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-row="${activeIndex}"]`) as
      | HTMLElement
      | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  // Outside-click + capture-phase Escape (so it wins even with the input
  // focused and doesn't bubble to other Escape handlers).
  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('mousedown', onDocMouseDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDocMouseDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((i) => Math.min(i + 1, rows.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      rows[activeIndex]?.select()
    }
  }

  return (
    <motion.div
      ref={ref}
      className="model-picker"
      style={{ left: pos.x, top: pos.y }}
      role="dialog"
      aria-label="Select model"
      // Pop in/out from the anchor — mirrors ctx-menu-in/ctx-menu-out
      // (scale 0.98 + small y nudge). pointerEvents:'none' on exit replaces
      // the old [data-state="closing"]{pointer-events:none} rule.
      initial={{ opacity: 0, scale: 0.98, y: -4, transition: enterT }}
      animate={{ opacity: 1, scale: 1, y: 0, transition: enterT }}
      exit={{ opacity: 0, scale: 0.98, y: -2, pointerEvents: 'none', transition: exitT }}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={handleKeyDown}
    >
      <div className="model-picker-search">
        <IconSearch size={14} aria-hidden />
        <input
          ref={inputRef}
          className="model-picker-input"
          type="text"
          placeholder="Search or type a model id…"
          value={query}
          disabled={disabled}
          onChange={(e) => {
            setQuery(e.target.value)
            setSelectedIndex(0)
          }}
          aria-label="Search models"
          aria-autocomplete="list"
        />
      </div>
      <div className="model-picker-list" ref={listRefMerged} role="listbox">
        {rows.length === 0 && <div className="model-picker-empty">No matches</div>}
        {rows.map((row, i) => (
          <div key={row.key}>
            {row.heading !== undefined && (
              <div className="model-picker-heading">{row.heading}</div>
            )}
            <button
              type="button"
              data-row={i}
              className={`model-picker-item${i === activeIndex ? ' selected' : ''}${row.active ? ' active' : ''}`}
              role="option"
              aria-selected={i === activeIndex}
              disabled={disabled}
              onMouseEnter={() => setSelectedIndex(i)}
              onClick={() => row.select()}
            >
              <span className="model-picker-item-text">
                <span className="model-picker-item-label">{row.label}</span>
                {row.sub && <span className="model-picker-item-sub">{row.sub}</span>}
              </span>
              {row.active && <IconCheck size={14} aria-hidden />}
            </button>
          </div>
        ))}
      </div>
    </motion.div>
  )
}
