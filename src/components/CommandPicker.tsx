// Popup that appears when the user types "/" in the composer, showing
// available slash commands with keyboard navigation and fuzzy filtering.
//
// Rendered through a portal on <body> — see the `createPortal` call below for
// why that is load-bearing, not cosmetic.

import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { SlashCommand } from '../types'
import { useFloatingSurface, FloatingSurfaceProvider } from '../hooks/useFloatingSurface'
import { useOutsideMouseDown } from '../hooks/useOutsideMouseDown'
import { useAutoHeightTransition } from '../hooks/useAutoHeightTransition'
import { PANEL_SELECTOR, markPortaledSurface } from '../theme'
import { pluginTagOf } from '../utils/text'
import { clamp } from '../utils/clamp'
import { measureCappedContentHeight } from '../utils/capped-height-measure'

interface Props {
  commands: SlashCommand[]
  /** Text type after the leading "/". Used to filter the list. */
  query: string
  /** Index of the keyboard-highlighted item (after filtering). */
  selectedIndex: number
  /** Ref to the editor the picker anchors against — used to position the
   *  picker above it. Only `getBoundingClientRect()` is ever called on it,
   *  so an `HTMLElement` view is enough and the caller need not lie about
   *  the element type. */
  anchorRef: React.RefObject<HTMLElement | null>
  /** Called when the user confirms a selection (Enter / Tab / click). */
  onSelect: (command: SlashCommand) => void
  /** Called on outside-click or Escape. */
  onClose: () => void
}

/** Case-insensitive prefix match against name and aliases. */
function matches(cmd: SlashCommand, query: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  if (cmd.name.toLowerCase().startsWith(q)) return true
  return cmd.aliases?.some((a) => a.toLowerCase().startsWith(q)) ?? false
}

interface CommandGroup {
  plugin: string | null
  commands: SlashCommand[]
}

/** Split commands into groups by plugin. A command marked `builtin` by the SDK
 *  is Claude Code's own; otherwise the SDK encodes the owning plugin as a
 *  leading "(plugin)" tag in the description (names are bare, with no
 *  "plugin:" prefix), and a missing tag also means built-in. */
function groupCommands(commands: SlashCommand[]): CommandGroup[] {
  const map = new Map<string, SlashCommand[]>()
  for (const cmd of commands) {
    const key = cmd.builtin === true ? '__builtin__' : pluginTagOf(cmd.description) ?? '__builtin__'
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(cmd)
  }
  const groups: CommandGroup[] = []
  // Named plugin groups first, then built-in
  for (const [key, cmds] of map) {
    if (key !== '__builtin__') groups.push({ plugin: key, commands: cmds })
  }
  const builtin = map.get('__builtin__')
  if (builtin?.length) groups.push({ plugin: null, commands: builtin })
  return groups
}

/** The flat render order of the picker (named plugin groups first, then
 *  built-in commands). groupCommands REGROUPES — the flat sequence differs
 *  from the source array whenever a plugin command follows a built-in one —
 *  so the keyboard-selected index must be resolved against THIS order, not
 *  the source array, or Enter/Tab inserts the wrong command. */
// eslint-disable-next-line react-refresh/only-export-components -- the picker's render order is defined by groupCommands in THIS file; splitting it into a util would divorce the mapping from the order it must mirror
export function pickerFlatCommands(commands: SlashCommand[]): SlashCommand[] {
  return groupCommands(commands).flatMap((g) => g.commands)
}

export function CommandPicker({ commands, query, selectedIndex, anchorRef, onSelect, onClose }: Props) {
  const filtered = commands.filter((c) => matches(c, query))
  const groups = useMemo(() => groupCommands(filtered), [filtered])
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const listContentRef = useRef<HTMLDivElement>(null)

  // --- Positioning: fixed, above the textarea, clamped to viewport ---
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const anchor = anchorRef.current
    // Portal compensation first: declare the surface portalled and stamp the
    // owning panel (both no-ops when there is no anchor to read from, and
    // geometry doesn't depend on the anchor being there yet).
    markPortaledSurface(el, anchor?.closest(PANEL_SELECTOR) ?? null)
    if (!anchor) return

    const rect = anchor.getBoundingClientRect()
    // Reset any prior viewport cap so the height read is the natural CSS-capped
    // size (the cap is re-applied below only for the flip-below case).
    el.style.maxHeight = ''
    const pickerH = el.offsetHeight
    const pickerW = el.offsetWidth
    const vw = window.innerWidth
    const vh = window.innerHeight
    const gap = 4

    // Left-align with the textarea, clamped to viewport.
    let left = rect.left
    if (left + pickerW > vw - 8) left = vw - pickerW - 8
    if (left < 8) left = 8
    el.style.left = `${left}px`

    // Glue the edge NEAREST the anchor, not a computed top: the height hook
    // tweens the list after this effect runs, so a top computed for the settled
    // height would teleport the bottom edge when the hook pins the list back to
    // its start height. Anchoring the bottom edge (above case) keeps it glued to
    // the anchor top while the height animates upward; the flip-below case glues
    // the top edge and grows downward.
    const roomAbove = rect.top - gap - 8
    if (pickerH <= roomAbove) {
      el.style.top = 'auto'
      el.style.bottom = `${vh - rect.top + gap}px`
    } else {
      const top = rect.bottom + gap
      el.style.bottom = 'auto'
      el.style.top = `${top}px`
      el.style.maxHeight = `${Math.max(0, vh - top - 8)}px`
    }
  }, [anchorRef, filtered.length])

  // The list grows/shrinks as the query filters; tween its height instead of
  // jumping. The measure caps at the card ceiling (pin-independent) so a short
  // list does not overshoot and snap. The observer watches the content-sized
  // wrapper; the key also drives the tween without ResizeObserver. The picker
  // mounts/unmounts with the open cycle, so each open starts from a fresh
  // baseline. The positioning effect above glues the bottom edge to the anchor,
  // so this height tween grows the picker upward from a fixed bottom — no
  // teleport (top-edge positioning jumped when the hook pinned the start height).
  const measureListHeight = useCallback(() => {
    const list = listRef.current
    const content = listContentRef.current
    const card = list?.closest('.cmd-picker') as HTMLElement | null
    if (!list || !content || !card) return null
    return measureCappedContentHeight(list, content, card)
  }, [])
  useAutoHeightTransition(listRef, `${query}|${filtered.length}`, {
    measureTargetHeight: measureListHeight,
    observe: listContentRef,
  })

  // --- Outside-click dismissal (Escape is owned by the shared stack below) ---
  // Capture phase, as before: this surface must collapse before any other
  // mousedown handler sees the press.
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

  // Clamp selectedIndex to valid range.
  const idx = clamp(selectedIndex, 0, filtered.length - 1)

  // Ref for the active item so we can scroll it into view on keyboard nav.
  const activeRef = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [idx])

  // Flatten groups for keyboard navigation index mapping.
  let flatIdx = 0

  // Portal to <body>, like the app's other floating surfaces. Load-bearing: the
  // layout effect above writes VIEWPORT coordinates into left/top, and a panel
  // takes over as this element's containing block whenever it carries
  // backdrop-filter (wallpaper on) or an entering transform — the canonical
  // statement is the body.has-bg note in layout.css. Pinned by
  // CommandPicker.test.tsx.
  return (
    <FloatingSurfaceProvider surfaceId={surfaceId}>
      {createPortal(
    <div className="cmd-picker" ref={rootRef}>
      <div className="cmd-picker-list os-hidden" ref={listRef} role="listbox">
        <div className="cmd-picker-list-content" ref={listContentRef} role="presentation">
          {filtered.length === 0 ? (
            <div className="cmd-picker-empty">No matching commands</div>
          ) : (
            groups.map((group) => (
              <div key={group.plugin ?? '__builtin__'}>
                {group.plugin && <div className="cmd-picker-group-header">{group.plugin}</div>}
                {group.commands.map((cmd) => {
                  const i = flatIdx++
                  const isActive = i === idx
                  return (
                    <button
                      key={cmd.name}
                      ref={isActive ? activeRef : undefined}
                      className={`cmd-picker-item${isActive ? ' active' : ''}`}
                      role="option"
                      aria-selected={isActive}
                      onMouseDown={(e) => {
                        e.preventDefault()
                        onSelect(cmd)
                      }}
                    >
                      <span className="cmd-picker-name">/{cmd.name}</span>
                      {cmd.argumentHint && <span className="cmd-picker-args">{cmd.argumentHint}</span>}
                      {cmd.description && <span className="cmd-picker-desc">{cmd.description}</span>}
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
      )}
    </FloatingSurfaceProvider>
  )
}
