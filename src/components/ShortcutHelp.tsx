// In-app help overlay — lists the available slash commands (when provided)
// and all registered keyboard shortcuts in scrollable tables. Triggered via
// the `/help` slash command (with commands) or Shift+/ / the command palette
// (shortcuts only).

import { useState } from 'react'
import type { Shortcut } from '../hooks/useKeyboardShortcuts'
import type { SlashCommand } from '../types'
import { formatCombo } from '../utils/format-combo'
import { Overlay } from './Overlay'

type Tab = 'commands' | 'shortcuts'

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
  // Default to the commands tab when commands are available (the `/help`
  // entry point); otherwise only the shortcuts tab exists. The parent
  // conditionally renders this component (mounts on open, unmounts on
  // close) so useState re-initializes fresh each time the dialog opens.
  const [tab, setTab] = useState<Tab>(commands.length > 0 ? 'commands' : 'shortcuts')

  return (
    <Overlay variant="modal" ariaLabel={showCommands ? 'Help' : 'Keyboard shortcuts'} open={open} onClose={onClose} cardStyle={{ maxWidth: 440 }}>
        <div className="modal-header">
          <h3>{showCommands ? 'Help' : 'Keyboard shortcuts'}</h3>
        </div>

        {showCommands && (
          <div className="global-settings-tabs">
            <button
              className={`global-settings-tab${tab === 'commands' ? ' active' : ''}`}
              onClick={() => setTab('commands')}
            >
              Slash commands
            </button>
            <button
              className={`global-settings-tab${tab === 'shortcuts' ? ' active' : ''}`}
              onClick={() => setTab('shortcuts')}
            >
              Keyboard shortcuts
            </button>
          </div>
        )}

        <div className="modal-section">
          {showCommands && tab === 'commands' && (
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
          )}

          {(!showCommands || tab === 'shortcuts') && (
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
          )}
        </div>

        <div className="modal-footer" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
    </Overlay>
  )
}
