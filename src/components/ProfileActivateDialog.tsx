// Dialog shown when the user switches the active provider profile from the
// top-left ProfileSwitcher. Lets them choose which live (idle, follow-global)
// sessions to restart into the newly-active profile now, instead of those
// sessions silently keeping their old spawn-time profile until a manual
// restart. Reuses the same Overlay `perm` variant + `.modal-*` chrome family
// as ConfirmDialog/PermissionDialog.

import { useState } from 'react'
import { Overlay } from './Overlay'
import type { SessionInfo } from '../types'

interface Props {
  /** Name of the profile being activated (for the dialog title). */
  profileName: string
  /** Candidate sessions — idle + running + follow-global (empty profileId). */
  sessions: SessionInfo[]
  /** Disables the footer while the mutation is in flight. */
  busy?: boolean
  /** Called with the selected session ids on confirm. */
  onConfirm: (ids: string[]) => void | Promise<void>
  onCancel: () => void
}

export function ProfileActivateDialog({ profileName, sessions, busy = false, onConfirm, onCancel }: Props) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(sessions.map((s) => s.id)))
  const anySelected = selected.size > 0

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <Overlay
      variant="perm"
      ariaLabel="Restart sessions"
      motion="motion"
      onClose={onCancel}
      canCloseOnEscape={() => !busy}
      canCloseOnBackdrop={() => !busy}
    >
      <div className="modal-header">
        <h3>Switch profile to “{profileName}”</h3>
      </div>
      <div className="modal-section">
        <p className="confirm-dialog-message">
          {sessions.length === 0
            ? 'No live sessions follow the global profile, so switching now applies only to new sessions.'
            : 'Select live sessions to restart into the new profile. Selecting none only switches the default for new sessions.'}
        </p>
        {sessions.length > 0 && (
          <ul className="profile-activate-sessions">
            {sessions.map((s) => (
              <li key={s.id}>
                <label className="profile-activate-session">
                  <input
                    type="checkbox"
                    checked={selected.has(s.id)}
                    onChange={() => toggle(s.id)}
                    disabled={busy}
                  />
                  <span className="profile-activate-session-meta">
                    <span className="profile-activate-session-title">{s.title || s.id}</span>
                    {s.model ? <span className="profile-activate-session-model">{s.model}</span> : null}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => { void onConfirm(Array.from(selected)) }}
          disabled={busy || (sessions.length > 0 && !anySelected)}
        >
          {busy ? 'Working...' : sessions.length === 0 ? 'Switch' : `Restart ${selected.size} session${selected.size === 1 ? '' : 's'}`}
        </button>
      </div>
    </Overlay>
  )
}