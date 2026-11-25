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

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, useIsPresent } from 'motion/react'
import type { ModelOptions } from '../hooks/useModelOptions'
import { useOverlayScrollbar } from '../hooks/useOverlayScrollbar'
import { useFloatingSurface, FloatingSurfaceProvider } from '../hooks/useFloatingSurface'
import { useListSelection } from '../hooks/useListSelection'
import { useOutsideMouseDown } from '../hooks/useOutsideMouseDown'
import { useAutoHeightTransition } from '../hooks/useAutoHeightTransition'
import { PANEL_SELECTOR, markPortaledSurface } from '../theme'
import { useMergedRef } from '../utils/mergedRef'
import { measureCappedContentHeight } from '../utils/capped-height-measure'
import { usePopoverMotion } from '../utils/transitions'
import { IconCheck } from './icons/ToolIcons'
import { SearchField } from './SearchField'

interface Props {
  /** Client-coordinate anchor (typically the chip's bottom-left). `source` is
   *  required, not optional: the picker portals to <body> and needs the clicked
   *  chip to resolve the owning panel for the `[data-portaled]` ownership stamp
   *  (see `markPortaledSurface`) — an omitted source silently unowns the
   *  surface, so it is a type error instead. */
  anchor: { x: number; y: number; source: Element | null }
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
  const listContentRef = useRef<HTMLDivElement>(null)
  const setListOs = useOverlayScrollbar({ autoHide: 'leave' })
  const listRefMerged = useMergedRef(listRef, setListOs)
  const [query, setQuery] = useState('')
  const [pos, setPos] = useState<{ x: number; y: number }>(anchor)
  // Under reduced motion, snap (duration:0) instead of fading — see
  // useMotionTransition.
  const { popover } = usePopoverMotion()

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

  // Hover only moves the highlight; arrow keys and the query reset also scroll
  // the selected row into view (see useListSelection). The displayed index is
  // clamped inside the hook: when the row set shrinks (a search narrows the
  // list) the stored index may exceed the new length, so the active index is
  // always derived, never stored stale.
  const { activeIndex, hover, reset, handleKeyDown } = useListSelection({
    count: rows.length,
    getRow: (i) => listRef.current?.querySelector<HTMLElement>(`[data-row="${i}"]`),
    onActivate: (i) => {
      rows[i]?.select()
    },
  })

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
    // The picker is a <body> child, so it sits outside the panel it belongs
    // to — stamp the owner off the clicked chip's panel.
    markPortaledSurface(el, anchor.source?.closest(PANEL_SELECTOR) ?? null)
  }, [anchor.x, anchor.y, anchor.source, rows.length])

  // The list grows/shrinks as the query filters; tween its height instead of
  // jumping. The measure caps at the card ceiling (pin-independent) so a short
  // list does not overshoot and snap. The observer watches the content-sized
  // wrapper; the key also drives the tween without ResizeObserver. The picker
  // mounts/unmounts with the open cycle, so each open starts from a fresh
  // baseline. The viewport clamp above reads the card's current height, so a
  // keystroke landing mid-tween clamps for the transient pinned size; tracking
  // the animated height would need a transition-safe settled-height read —
  // machinery beyond the committed height primitives, so it is left as a known
  // limit of animating this one-shot-positioned popover.
  const measureListHeight = useCallback(() => {
    const list = listRef.current
    const content = listContentRef.current
    const card = list?.closest('.model-picker') as HTMLElement | null
    if (!list || !content || !card) return null
    return measureCappedContentHeight(list, content, card)
  }, [])
  useAutoHeightTransition(listRef, `${query}|${rows.length}`, {
    measureTargetHeight: measureListHeight,
    observe: listContentRef,
  })

  // Esc closes via the shared escape stack, so it wins over the chat panel's
  // handlers and never closes the panel beneath this popover. Must be called
  // BEFORE the autofocus layout effect below: this popover renders via
  // createPortal on body (see the return below), so it is not a DOM descendant
  // of any parent trap, and unless this entry is registered first a parent
  // trap's focusin re-guard sees isFocusInsideOtherOverlay=false and steals
  // focus back — and the Escape dispatch then resolves by containment to the
  // parent layer instead of this popover.
  const isPresent = useIsPresent()
  const { surfaceId } = useFloatingSurface({
    kind: 'popover',
    active: true,
    phase: isPresent ? 'open' : 'exiting',
    getContainer: () => ref.current,
    onDismiss: onClose,
    onEscape: onClose,
  })

  // Autofocus the search box on open.
  useLayoutEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Outside-click dismissal (Escape is owned by the shared stack above).
  // No trigger: this picker's chip only opens it (see ChatPanel), so a press
  // on the chip is an ordinary outside press.
  useOutsideMouseDown({ ref, onClose, surfaceId })

  return (
    <FloatingSurfaceProvider surfaceId={surfaceId}>
      {createPortal(
    <motion.div
      ref={ref}
      className="model-picker"
      style={{ left: pos.x, top: pos.y }}
      role="dialog"
      aria-label="Select model"
      // Pop in/out from the anchor — mirrors ctx-menu-in/ctx-menu-out
      // (scale 0.98 + small y nudge). pointerEvents:'none' on exit replaces
      // the old [data-state="closing"]{pointer-events:none} rule.
      initial={popover.initial}
      animate={popover.animate}
      exit={popover.exit}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={handleKeyDown}
    >
      <SearchField
        value={query}
        onChange={(value) => {
          setQuery(value)
          reset()
        }}
        placeholder="Search or type a model id…"
        ariaLabel="Search models"
        wrapperClassName="model-picker-search"
        inputClassName="model-picker-input"
        inputRef={inputRef}
        iconSize={14}
        showClear={false}
        disabled={disabled}
        ariaAutocomplete="list"
      />
      <div className="model-picker-list" ref={listRefMerged} role="listbox">
        <div className="model-picker-list-content" ref={listContentRef} role="presentation">
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
                onMouseEnter={() => hover(i)}
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
      </div>
    </motion.div>,
    // Portal to <body>: `anchor` arrives in VIEWPORT coordinates and the clamp
    // above compares them against the window, so a panel carrying
    // backdrop-filter (wallpaper on) would take over as the containing block
    // and displace the whole list. Canonical statement: the body.has-bg note in
    // layout.css. Pinned by ModelPicker.test.tsx.
    document.body,
      )}
    </FloatingSurfaceProvider>
  )
}
