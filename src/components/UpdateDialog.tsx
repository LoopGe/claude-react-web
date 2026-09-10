// What's New dialog — the action surface behind the update nag toast.
//
// Shell reuses the Overlay 'perm' variant (same as UploadsManagerDialog):
// dark/light theming comes from the shared sheets; only layout lives in
// update-dialog.css. Fetches release notes on open via useReleaseNotes.
//
// The single close path is props.onClose — the App host writes the nag
// dismissal key there, so every closure (Later, backdrop, Escape, a
// successful update) counts as "seen" and the toast never re-nags this
// version.

import { useState } from 'react'
import { Overlay } from './Overlay'
import { Markdown } from './Markdown'
import { useReleaseNotes } from '../hooks/useReleaseNotes'
import { useToast } from '../hooks/useToast'
import { reportUpdateResult } from '../utils/update-action'
import { buildUpgradeCommand } from '../utils/upgrade-command'
import { isVersionNewer, type UpdateActionResult, type UpdateInfo } from '../../shared/update-info'
import { IconX, IconCheck, IconAlertTriangle } from './icons/ToolIcons'

export type UpdateDialogMode = 'update' | 'deprecation'

interface Props {
  open: boolean
  mode: UpdateDialogMode
  info: UpdateInfo
  updating: boolean
  onUpdate: () => Promise<UpdateActionResult>
  onClose: () => void
}

/** "2026-09-10" from an ISO timestamp — enough precision for a release
 *  header; the full timestamp stays in the title tooltip. */
function dateShort(iso: string): string {
  return iso.slice(0, 10)
}

export function UpdateDialog({ open, mode, info, updating, onUpdate, onClose }: Props) {
  const toast = useToast()
  const { releases, loading, error } = useReleaseNotes(open, info.current, info.latest)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const latest = info.latest
  const deprecationMsg =
    typeof info.deprecated === 'string'
      ? info.deprecated
      : 'This version has been deprecated by the maintainer.'
  // Upgrade controls only when there's a strictly newer version to go to —
  // mirrors UpdateBanner's old `latest && latest !== current` gate (a bare
  // inequality would also fire on a downgrade; isVersionNewer is the same
  // comparison the rest of the update stack uses).
  const upgradeable = !!latest && isVersionNewer(info.current, latest)
  // In-app update only for global installs (npx/dev fall back to the
  // copy-command) — mirrors the About-tab gate.
  const canUpdateInApp = upgradeable && info.installMethod === 'global'

  const runUpdate = async () => {
    setUpdateError(null)
    try {
      const res = await onUpdate()
      reportUpdateResult(toast, res)
      if (res.performed && res.updateApplied) {
        onClose()
        return
      }
      // no-op / declined / unconfirmed — stay open so the user still has
      // the notes + copy-command in front of them.
    } catch (e) {
      setUpdateError(e instanceof Error ? e.message : String(e))
    }
  }

  const copyCommand = () => {
    if (!navigator.clipboard) return
    const cmd = buildUpgradeCommand(info.packageName, info.registry)
    navigator.clipboard.writeText(cmd).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      },
      (err: unknown) => {
        console.warn('clipboard write failed:', err)
      },
    )
  }

  const headerTitle =
    mode === 'deprecation'
      ? `Version ${info.current} is deprecated`
      : `What's new in ${latest ?? info.current}`

  return (
    <Overlay
      variant="perm"
      open={open}
      onClose={onClose}
      ariaLabel={headerTitle}
      cardClassName="update-dialog-card"
    >
      <div className="modal-header">
        <h3>
          {mode === 'deprecation' && <IconAlertTriangle size={16} aria-hidden />}
          {headerTitle}
        </h3>
        <button type="button" className="btn btn-icon" onClick={onClose} aria-label="Close">
          <IconX size={16} />
        </button>
      </div>

      <div className="update-dialog-body">
        {mode === 'deprecation' && (
          <div className="update-dialog-deprecation">
            <IconAlertTriangle size={14} aria-hidden />
            <span>{deprecationMsg}</span>
          </div>
        )}

        {loading && <div className="update-dialog-loading">Loading release notes...</div>}

        {!loading && releases && releases.length === 0 && (
          <p className="update-dialog-empty">
            {error
              ? `Release notes are unavailable right now (${error}).`
              : 'Release notes are unavailable right now.'}
          </p>
        )}

        {!loading &&
          releases?.map((r) => (
            <section key={r.version} className="update-dialog-release">
              <div className="update-dialog-release-head">
                <span className="update-dialog-release-version">{r.name || r.version}</span>
                {r.publishedAt && (
                  <span className="update-dialog-release-date">{dateShort(r.publishedAt)}</span>
                )}
                {r.url && (
                  <a
                    className="update-dialog-release-link"
                    href={r.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    GitHub
                  </a>
                )}
              </div>
              {r.body && <Markdown text={r.body} breaks />}
            </section>
          ))}
      </div>

      <div className="update-dialog-footer">
        {canUpdateInApp && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void runUpdate()}
            disabled={updating}
          >
            {updating ? 'Updating...' : 'Update now'}
          </button>
        )}
        <button type="button" className="btn" onClick={copyCommand} title="Copy upgrade command">
          {copied ? (
            <>
              <IconCheck size={12} aria-hidden /> Copied
            </>
          ) : (
            'Copy command'
          )}
        </button>
        <code className="update-dialog-cmd">
          {buildUpgradeCommand(info.packageName, info.registry)}
        </code>
        <span className="update-dialog-footer-spacer" />
        {updateError && <span className="update-dialog-error">{updateError}</span>}
        <button type="button" className="btn" onClick={onClose}>
          Later
        </button>
      </div>
    </Overlay>
  )
}
