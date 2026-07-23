// Command palette - fuzzy-searchable list of actions, sessions, and message hits.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { MessageSearchHit, MessageSearchResponse } from '../../shared/search-results.js'
import type { Shortcut } from '../hooks/useKeyboardShortcuts'
import { api } from '../hooks/useApi'
import { useExitPresence } from '../hooks/useExitPresence'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useOverlayScrollbar } from '../hooks/useOverlayScrollbar'
import { useMergedRef } from '../utils/mergedRef'
import type { SessionInfo } from '../types'
import { formatCombo } from '../utils/format-combo'

interface Props {
  open: boolean
  onClose: () => void
  shortcuts: Shortcut[]
  sessions: SessionInfo[]
  onSelectSession: (id: string) => void
  onSelectMessage: (hit: MessageSearchHit, query: string) => void
  /** Plugin-contributed commands (global, palette-visible) merged into the
   *  Commands section. Built by the app from the plugin registry. */
  pluginCommands?: PaletteItem[]
}

type PaletteSection = 'Commands' | 'Sessions' | 'Messages'

export interface PaletteItem {
  id: string
  section: PaletteSection
  label: string
  hint?: string
  detail?: string
  action: () => void
}

function messageLabel(hit: MessageSearchHit): string {
  return hit.sessionTitle || hit.sessionId.slice(0, 12)
}

export function CommandPalette({ open, onClose, shortcuts, sessions, onSelectSession, onSelectMessage, pluginCommands }: Props) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [messageHits, setMessageHits] = useState<MessageSearchHit[]>([])
  const [messageSearchLoading, setMessageSearchLoading] = useState(false)
  const [messageSearchError, setMessageSearchError] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const setListOs = useOverlayScrollbar({ autoHide: 'leave' })
  const listRefMerged = useMergedRef(listRef, setListOs)
  const paletteRef = useRef<HTMLDivElement>(null)
  // Focus trap + restore: the palette is opened from the toolbar / Mod+K and
  // closed by Esc / pick / backdrop. Without restore, focus fell to <body>
  // on close, stranding keyboard users. `active: open` releases the trap
  // during the exit animation so the input can unmount cleanly.
  useFocusTrap(paletteRef, { restoreFocus: true, active: open })
  const presence = useExitPresence(open)
  const trimmedQuery = query.trim()

  const localItems: PaletteItem[] = useMemo(() => {
    const result: PaletteItem[] = []
    for (const shortcut of shortcuts) {
      if (!shortcut.description) continue
      result.push({
        id: `shortcut:${shortcut.combo}`,
        section: 'Commands',
        label: shortcut.description,
        hint: formatCombo(shortcut.combo),
        action: () => shortcut.handler(new KeyboardEvent('keydown')),
      })
    }
    for (const session of sessions) {
      const label = session.title || session.id.slice(0, 12)
      result.push({
        id: `session:${session.id}`,
        section: 'Sessions',
        label,
        hint: session.cwd,
        action: () => onSelectSession(session.id),
      })
    }
    // Plugin-contributed commands (global, palette-visible). Each carries a
    // stable id prefixed `plugin:` so they never collide with shortcuts.
    for (const cmd of pluginCommands ?? []) {
      result.push({ ...cmd, id: cmd.id.startsWith('plugin:') ? cmd.id : `plugin:${cmd.id}` })
    }
    return result
  }, [shortcuts, sessions, onSelectSession, pluginCommands])

  useEffect(() => {
    if (!open || trimmedQuery.length < 2) {
      return
    }

    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setMessageSearchLoading(true)
      setMessageSearchError(false)
      void api
        .get<MessageSearchResponse>(`/search/messages?q=${encodeURIComponent(trimmedQuery)}&limit=20`, {
          signal: controller.signal,
          timeoutMs: 10_000,
        })
        .then((res) => {
          if (!controller.signal.aborted) setMessageHits(res.hits)
        })
        .catch((err) => {
          if (controller.signal.aborted) return
          console.warn('[command-palette] message search failed:', err)
          setMessageHits([])
          setMessageSearchError(true)
        })
        .finally(() => {
          if (!controller.signal.aborted) setMessageSearchLoading(false)
        })
    }, 180)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [open, trimmedQuery])

  const filtered = useMemo(() => {
    const local = (() => {
      if (!trimmedQuery) return localItems
      const q = trimmedQuery.toLowerCase()
      return localItems.filter(
        (item) => item.label.toLowerCase().includes(q) || item.hint?.toLowerCase().includes(q),
      )
    })()

    if (trimmedQuery.length < 2) return local

    return [
      ...local,
      ...messageHits.map((hit): PaletteItem => ({
        id: `message:${hit.id}`,
        section: 'Messages',
        label: messageLabel(hit),
        hint: hit.matchCount > 1 ? `${hit.matchCount} matches` : '1 match',
        detail: hit.snippet,
        action: () => onSelectMessage(hit, trimmedQuery),
      })),
    ]
  }, [localItems, messageHits, onSelectMessage, trimmedQuery])

  // Clamp selectedIndex to valid range (derived state, not effect)
  const clampedSelectedIndex = Math.min(selectedIndex, Math.max(0, filtered.length - 1))

  /* eslint-disable react-hooks/set-state-in-effect -- intentional UI reset on open */
  useLayoutEffect(() => {
    if (open) {
      setQuery('')
      setSelectedIndex(0)
      setMessageHits([])
      setMessageSearchLoading(false)
      setMessageSearchError(false)
    }
  }, [open])
  /* eslint-enable react-hooks/set-state-in-effect */

  useLayoutEffect(() => {
    if (presence.shouldRender) inputRef.current?.focus()
  }, [presence.shouldRender])

  useEffect(() => {
    const el = listRef.current?.querySelectorAll<HTMLElement>('[data-palette-option]')[clampedSelectedIndex]
    el?.scrollIntoView({ block: 'nearest' })
  }, [clampedSelectedIndex])

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

  if (!presence.shouldRender) return null

  const runSelected = () => {
    filtered[clampedSelectedIndex]?.action()
    onClose()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((index) => Math.min(index + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((index) => Math.max(index - 1, 0))
    } else if (e.key === 'Enter' && filtered.length > 0) {
      e.preventDefault()
      runSelected()
    } else if (e.key === 'Tab') {
      e.preventDefault()
      inputRef.current?.focus()
    }
  }

  let lastSection: PaletteSection | null = null
  const showSearching = trimmedQuery.length >= 2 && messageSearchLoading && messageHits.length === 0
  const showSearchError = trimmedQuery.length >= 2 && messageSearchError && messageHits.length === 0

  return (
    <div
      className="palette-backdrop"
      data-state={open ? 'open' : 'closing'}
      onMouseDown={(e) => { if (open && e.target === e.currentTarget) onClose() }}
    >
      <div ref={paletteRef} className="palette" role="dialog" aria-modal={open ? 'true' : 'false'} aria-label="Command palette" onKeyDown={handleKeyDown}>
        <input
          ref={inputRef}
          className="palette-input"
          type="text"
          placeholder="Search commands, sessions, and messages..."
          value={query}
          onChange={(e) => { setQuery(e.target.value); setSelectedIndex(0) }}
          aria-label="Search"
          aria-autocomplete="list"
          aria-controls="palette-list"
          aria-activedescendant={filtered[clampedSelectedIndex] ? `palette-item-${clampedSelectedIndex}` : undefined}
        />
        <div className="palette-list" ref={listRefMerged} id="palette-list" role="listbox">
          {filtered.length === 0 && !showSearching && !showSearchError && (
            <div className="palette-empty">No matches</div>
          )}
          {filtered.map((item, index) => {
            const showSection = item.section !== lastSection
            lastSection = item.section
            return (
              <div key={item.id}>
                {showSection && <div className="palette-section-label">{item.section}</div>}
                <button
                  id={`palette-item-${index}`}
                  className={`palette-item${index === clampedSelectedIndex ? ' selected' : ''}${item.detail ? ' palette-item-message' : ''}`}
                  role="option"
                  aria-selected={index === clampedSelectedIndex}
                  data-palette-option="true"
                  onMouseEnter={() => setSelectedIndex(index)}
                  onClick={() => { item.action(); onClose() }}
                >
                  <span className="palette-item-main">
                    <span className="palette-item-label">{item.label}</span>
                    {item.detail && <span className="palette-item-detail">{item.detail}</span>}
                  </span>
                  {item.hint && <span className="palette-item-hint">{item.hint}</span>}
                </button>
              </div>
            )
          })}
          {showSearching && <div className="palette-empty">Searching messages...</div>}
          {showSearchError && <div className="palette-empty">Message search failed</div>}
        </div>
      </div>
    </div>
  )
}
