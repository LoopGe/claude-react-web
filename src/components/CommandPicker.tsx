// Popup that appears when the user types "/" in the composer, showing
// available slash commands with keyboard navigation and fuzzy filtering.

import { useLayoutEffect, useMemo, useRef } from 'react'
import type { SlashCommand } from '../types'
import { useEscapeStack } from '../hooks/useEscapeStack'
import { pluginTagOf } from '../utils/text'

interface Props {
  commands: SlashCommand[]
  /** Text type after the leading "/". Used to filter the list. */
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

interface CommandGroup {
  plugin: string | null
  commands: SlashCommand[]
}

/** Split commands into groups by plugin. The SDK encodes a command's owning
 *  plugin as a leading "(plugin)" tag in its description (names are bare, with
 *  no "plugin:" prefix); fall back to "__builtin__" when there's no tag. */
function groupCommands(commands: SlashCommand[]): CommandGroup[] {
  const map = new Map<string, SlashCommand[]>()
  for (const cmd of commands) {
    const key = pluginTagOf(cmd.description) ?? '__builtin__'
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

  // --- Outside-click dismissal (Escape is owned by the shared stack below) ---
  useLayoutEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    window.addEventListener('mousedown', handleMouseDown, true)
    return () => {
      window.removeEventListener('mousedown', handleMouseDown, true)
    }
  }, [onClose])

  // Esc closes via the shared escape stack (its dispatch already prevents
  // default + stops propagation), so a typed "/" never bubbles Escape to the
  // composer's App-level handlers.
  useEscapeStack({
    active: true,
    onEscape: onClose,
    getContainer: () => rootRef.current,
  })

  // Clamp selectedIndex to valid range.
  const idx = Math.max(0, Math.min(selectedIndex, filtered.length - 1))

  // Ref for the active item so we can scroll it into view on keyboard nav.
  const activeRef = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [idx])

  if (filtered.length === 0) {
    return (
      <div className="cmd-picker os-hidden" ref={rootRef} role="listbox">
        <div className="cmd-picker-empty">No matching commands</div>
      </div>
    )
  }

  // Flatten groups for keyboard navigation index mapping.
  let flatIdx = 0

  return (
    <div className="cmd-picker os-hidden" ref={rootRef} role="listbox">
      {groups.map((group) => (
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
      ))}
    </div>
  )
}
