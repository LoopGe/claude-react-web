// Dialog shown when the user clicks "+ Add profile" in the Profiles settings
// tab. Instead of silently templating the active profile (the old behavior),
// it asks where the new profile should start from: the built-in defaults
// ("Blank") or any existing profile. The auth token is never part of the
// template — the server only copies non-credential fields (baseUrl, model
// list, groups, recap/commit models), so the user still types a fresh token.
//
// Mirrors ProfileActivateDialog's structure and the .profile-activate-session
// CSS family (a radio dot instead of a checkmark); the `modal` variant's
// <body> portal is load-bearing for the same containment reasons — see the
// comment atop ProfileActivateDialog.

import { useState } from 'react'
import { Overlay } from './Overlay'
import { StatusBadge } from './StatusBadge'
import type { ProviderProfile } from '../types/config'
import { isReservedProfileTemplateId } from '../../shared/profile-templates'
import { cx } from '../utils/cx'

interface Props {
  /** Candidate template profiles; "Blank" is synthesized by the dialog. */
  profiles: ProviderProfile[]
  /** Disables the footer and radios while the create POST is in flight —
   *  the dialog STAYS MOUNTED until the create settles (success closes it,
   *  failure keeps it open with `error`), so this is live, not defensive. */
  busy?: boolean
  /** Create failure message, rendered inside the dialog so a retry keeps
   *  the chosen template. */
  error?: string
  /** Called with the chosen template on confirm: 'blank' or a profile id. */
  onConfirm: (template: string) => void | Promise<void>
  onCancel: () => void
}

export function ProfileCreateDialog({ profiles, busy = false, error, onConfirm, onCancel }: Props) {
  // Default pick = the active profile (preserves the pre-dialog behavior of
  // templating from it); with no active profile, fall back to Blank. The
  // choice is stored as `picked = null` until the user explicitly clicks, so
  // the preselection can arrive LATE: the dialog may open before the tab's
  // profiles fetch has landed, and the active profile must be picked up when
  // it does. An explicit pick always wins; a pick that no longer resolves to
  // a listed profile (deleted in another tab) falls back to auto. An ACTIVE
  // profile whose id is a reserved keyword is skipped for the auto pick —
  // 'blank' as a selection can only mean the keyword row, never that id.
  const [picked, setPicked] = useState<string | null>(null)
  const activeId = profiles.find((p) => p.isActive)?.id
  const activeTemplate = activeId != null && !isReservedProfileTemplateId(activeId) ? activeId : undefined
  const selected = picked != null && (picked === 'blank' || profiles.some((p) => p.id === picked))
    ? picked
    : activeTemplate ?? 'blank'

  return (
    <Overlay
      variant="modal"
      cardClassName="profile-create-card"
      ariaLabel="Add profile"
      onClose={onCancel}
      canCloseOnEscape={() => !busy}
      canCloseOnBackdrop={() => !busy}
    >
      <div className="modal-header">
        <h3>Add profile</h3>
      </div>
      <div className="modal-section">
        <p className="confirm-dialog-message">
          Choose what the new profile starts from. The auth token is never copied — enter it after creating.
        </p>
        {error && <div className="settings-card-error">{error}</div>}
        <ul className="profile-create-options">
          <li>
            <label className={cx('profile-create-option', selected === 'blank' && 'selected')}>
              <input
                type="radio"
                name="profile-create-template"
                checked={selected === 'blank'}
                disabled={busy}
                onChange={() => setPicked('blank')}
              />
              <span className="profile-create-option-meta">
                <span className="profile-create-option-title">
                  <span className="profile-create-option-name">Blank</span>
                </span>
                <span className="profile-create-option-hint">Built-in defaults — official API + stock model list</span>
              </span>
            </label>
          </li>
          {profiles.map((p) => {
            // POST /profiles resolves these ids as template KEYWORDS, so such
            // a profile can never be selected as a template by its id — the
            // row stays listed but not selectable (see the load-time warning
            // in server/profiles.ts).
            const reserved = isReservedProfileTemplateId(p.id)
            return (
              <li key={p.id}>
                <label
                  className={cx('profile-create-option', selected === p.id && !reserved && 'selected')}
                  title={reserved ? `"${p.id}" is a reserved template keyword — this profile cannot be selected as a template` : undefined}
                >
                  <input
                    type="radio"
                    name="profile-create-template"
                    checked={selected === p.id && !reserved}
                    disabled={busy || reserved}
                    onChange={() => setPicked(p.id)}
                  />
                  <span className="profile-create-option-meta">
                    <span className="profile-create-option-title">
                      {/* The name needs its own span: text-overflow on the flex
                          title row itself has no effect (see git-panel.css). */}
                      <span className="profile-create-option-name">{p.name}</span>
                      {p.isActive && <StatusBadge tone="accent">Active</StatusBadge>}
                    </span>
                    <span className="profile-create-option-hint">{p.baseUrl}</span>
                  </span>
                </label>
              </li>
            )
          })}
        </ul>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" onClick={() => { void onConfirm(selected) }} disabled={busy}>
          {busy ? 'Adding...' : 'Add'}
        </button>
      </div>
    </Overlay>
  )
}
