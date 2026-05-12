// Keyboard shortcut help overlay — lists all registered shortcuts in a
// scrollable table. Triggered via Shift+/ or the command palette.

import { useEffect } from 'react'
import type { Shortcut } from '../hooks/useKeyboardShortcuts'
import { formatCombo } from '../utils/format-combo'

interface Props {
  open: boolean
  onClose: () => void
  shortcuts: Shortcut[]
}

export function ShortcutHelp({ open, onClose, shortcuts }: Props) {
  // Filter to only shortcuts with a description (undocumented ones are
  // intentionally hidden from the cheat sheet).
  const visible = shortcuts.filter((s) => s.description)

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
        <h3 style={{ marginTop: 0 }}>Keyboard shortcuts</h3>
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
