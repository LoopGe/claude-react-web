// Popup that appears when the user types "/" in the composer, showing
// available slash commands with keyboard navigation and fuzzy filtering.

import { useLayoutEffect, useRef } from 'react'
import type { SlashCommand } from '../types'

interface Props {
  commands: SlashCommand[]
  /** Text typed after the leading "/". Used to filter the list. */
  query: string
  /** Index of the keyboard-highlighted item (after filtering). */
  selectedIndex: number
  /** Ref to the textarea — used to position the picker above it. */
  anchorRef: React.RefObject<HTMLTextAreaElement | null>
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

export function CommandPicker({ commands, query, selectedIndex, anchorRef, onSelect, onClose }: Props) {
  const filtered = commands.filter((c) => matches(c, query))
  const rootRef = useRef<HTMLDivElement>(null)

  // --- Positioning: fixed, above the textarea, clamped to viewport ---
  useLayoutEffect(() => {
    const el = rootRef.current
    const anchor = anchorRef.current
    if (!el || !anchor) return

    const rect = anchor.getBoundingClientRect()
    const pickerH = el.offsetHeight
    const pickerW = el.offsetWidth
    const vw = window.innerWidth
    const vh = window.innerHeight
    const gap = 4

    // Prefer above the textarea; flip below if not enough room.
    let top = rect.top - gap - pickerH
    if (top < 8) top = rect.bottom + gap

    // Left-align with the textarea, clamped to viewport.
    let left = rect.left
    if (left + pickerW > vw - 8) left = vw - pickerW - 8
    if (left < 8) left = 8

    // If overflows bottom, cap height via max-height.
    if (top + pickerH > vh - 8) {
      el.style.maxHeight = `${vh - top - 8}px`
    }

    el.style.left = `${left}px`
    el.style.top = `${top}px`
  }, [anchorRef, filtered.length])

  // --- Outside-click + Escape dismissal ---
  useLayoutEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('mousedown', handleMouseDown, true)
    window.addEventListener('keydown', handleKeyDown, true)
    return () => {
      window.removeEventListener('mousedown', handleMouseDown, true)
      window.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [onClose])

  if (filtered.length === 0) {
    return (
      <div className="cmd-picker" ref={rootRef} role="listbox">
        <div className="cmd-picker-empty">No matching commands</div>
      </div>
    )
  }

  // Clamp selectedIndex to valid range.
  const idx = Math.max(0, Math.min(selectedIndex, filtered.length - 1))

  return (
    <div className="cmd-picker" ref={rootRef} role="listbox">
      {filtered.map((cmd, i) => (
        <button
          key={cmd.name}
          className={`cmd-picker-item${i === idx ? ' active' : ''}`}
          role="option"
          aria-selected={i === idx}
          onMouseDown={(e) => {
            // Prevent the textarea from losing focus.
            e.preventDefault()
            onSelect(cmd)
          }}
          onMouseEnter={() => {
            // Visual feedback on hover — no state change needed since the
            // parent owns selectedIndex; we just highlight via CSS :hover.
          }}
        >
          <span className="cmd-picker-name">/{cmd.name}</span>
          {cmd.argumentHint && <span className="cmd-picker-args">{cmd.argumentHint}</span>}
          {cmd.description && <span className="cmd-picker-desc">{cmd.description}</span>}
        </button>
      ))}
    </div>
  )
}
