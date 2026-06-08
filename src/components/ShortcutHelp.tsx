// In-app help overlay — lists the available slash commands (when provided)
// and all registered keyboard shortcuts in scrollable tables. Triggered via
// the `/help` slash command (with commands) or Shift+/ / the command palette
// (shortcuts only).

import { useEffect } from 'react'
import type { Shortcut } from '../hooks/useKeyboardShortcuts'
import type { SlashCommand } from '../types'
import { formatCombo } from '../utils/format-combo'

interface Props {
  open: boolean
  onClose: () => void
  shortcuts: Shortcut[]
  /** Slash commands to list above the keyboard shortcuts. Empty when help is
   *  opened via the Mod+? shortcut (shortcuts-only view). */
  commands?: SlashCommand[]
}

export function ShortcutHelp({ open, onClose, shortcuts, commands = [] }: Props) {
  // Filter to only shortcuts with a description (undocumented ones are
  // intentionally hidden from the cheat sheet).
  const visible = shortcuts.filter((s) => s.description)
  const showCommands = commands.length > 0

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

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal" style={{ maxWidth: 440, padding: '16px 20px' }}>
        <h3 style={{ marginTop: 0 }}>{showCommands ? 'Help' : 'Keyboard shortcuts'}</h3>

        {showCommands && (
          <>
            <h4 style={{ margin: '0 0 8px' }}>Slash commands</h4>
            <table className="shortcut-table">
              <thead>
                <tr>
                  <th>Command</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {commands.map((c) => (
                  <tr key={c.name}>
                    <td><kbd>/{c.name}</kbd></td>
                    <td>{c.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <h4 style={{ margin: '16px 0 8px' }}>Keyboard shortcuts</h4>
          </>
        )}

        <table className="shortcut-table">
          <thead>
            <tr>
              <th>Shortcut</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((s) => (
              <tr key={s.combo}>
                <td><kbd>{formatCombo(s.combo)}</kbd></td>
                <td>{s.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ textAlign: 'right', marginTop: 12 }}>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
