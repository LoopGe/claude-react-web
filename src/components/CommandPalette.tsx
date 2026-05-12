// Command palette — fuzzy-searchable list of actions and sessions.
//
// Triggered globally via Mod+K. Shows a search input at the top and a
// scrollable list of matching commands below. Users can navigate with
// arrow keys, confirm with Enter, and dismiss with Escape.
//
// Two kinds of items appear in the list:
//   1. Registered keyboard shortcuts (from useKeyboardShortcuts) —
//      labelled with their combo and a description.
//   2. Open sessions — labelled with their title or id so the user can
//      quick-switch without touching the sidebar.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Shortcut } from '../hooks/useKeyboardShortcuts'
import type { SessionInfo } from '../types'

interface Props {
  open: boolean
  onClose: () => void
  shortcuts: Shortcut[]
  sessions: SessionInfo[]
  onSelectSession: (id: string) => void
}

interface PaletteItem {
  id: string
  label: string
  hint?: string
  action: () => void
}

export function CommandPalette({ open, onClose, shortcuts, sessions, onSelectSession }: Props) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Build the full item list once per open.
  const items: PaletteItem[] = useMemo(() => {
    const result: PaletteItem[] = []
    // Keyboard shortcuts
    for (const s of shortcuts) {
      if (!s.description) continue
      result.push({
        id: `shortcut:${s.combo}`,
        label: s.description,
        hint: formatCombo(s.combo),
        action: () => s.handler(new KeyboardEvent('keydown')),
      })
    }
    // Sessions
    for (const s of sessions) {
      const label = s.title || s.id.slice(0, 12)
      result.push({
        id: `session:${s.id}`,
        label,
        hint: s.cwd,
        action: () => onSelectSession(s.id),
      })
    }
    return result
  }, [shortcuts, sessions, onSelectSession])

  const filtered = useMemo(() => {
    if (!query) return items
    const q = query.toLowerCase()
    return items.filter(
      (it) => it.label.toLowerCase().includes(q) || it.hint?.toLowerCase().includes(q),
    )
  }, [items, query])

  // Reset state when opening. The synchronous setState is intentional:
  // this is a UI-level reset that must happen before the first paint so
  // the user never sees stale content from a previous invocation.
  /* eslint-disable react-hooks/set-state-in-effect -- intentional UI reset on open */
  useLayoutEffect(() => {
    if (open) {
      setQuery('')
      setSelectedIndex(0)
    }
  }, [open])
  /* eslint-enable react-hooks/set-state-in-effect */

  // Auto-focus the input on mount / open.
  useLayoutEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  // Keep selected item in view.
  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  // Capture-phase Escape so it fires even if a child is focused.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  if (!open) return null

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && filtered.length > 0) {
      e.preventDefault()
      filtered[selectedIndex]?.action()
      onClose()
    } else if (e.key === 'Tab') {
      // Focus trap: keep Tab inside the palette.
      e.preventDefault()
      inputRef.current?.focus()
    }
  }

  return (
    <div className="palette-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={handleKeyDown}>
        <input
          ref={inputRef}
          className="palette-input"
          type="text"
          placeholder="Search commands and sessions…"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setSelectedIndex(0) }}
          aria-label="Search"
          aria-autocomplete="list"
          aria-controls="palette-list"
          aria-activedescendant={filtered[selectedIndex] ? `palette-item-${selectedIndex}` : undefined}
        />
        <div className="palette-list" ref={listRef} id="palette-list" role="listbox">
          {filtered.length === 0 && (
            <div className="palette-empty">No matches</div>
          )}
          {filtered.map((item, i) => (
            <button
              key={item.id}
              id={`palette-item-${i}`}
              className={`palette-item${i === selectedIndex ? ' selected' : ''}`}
              role="option"
              aria-selected={i === selectedIndex}
              onMouseEnter={() => setSelectedIndex(i)}
              onClick={() => { item.action(); onClose() }}
            >
              <span className="palette-item-label">{item.label}</span>
              {item.hint && <span className="palette-item-hint">{item.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Pretty-print a combo string: "mod+shift+e" → "⌘⇧E" / "Ctrl+Shift+E". */
function formatCombo(combo: string): string {
  const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform)
  const parts = combo.toLowerCase().split('+')
  const key = parts[parts.length - 1]
  const mods = parts.slice(0, -1)
  if (isMac) {
    const macMods = mods.map((m) => {
      if (m === 'mod') return '⌘'
      if (m === 'alt') return '⌥'
      if (m === 'shift') return '⇧'
      return m
    })
    return [...macMods, key.toUpperCase()].join('')
  }
  const winMods = mods.map((m) => {
    if (m === 'mod') return 'Ctrl'
    if (m === 'alt') return 'Alt'
    if (m === 'shift') return 'Shift'
    return m
  })
  return [...winMods, key.length === 1 ? key.toUpperCase() : key].join('+')
}
