// What's New dialog — the action surface behind the update nag toast, and
// (mode: 'current') the About tab's read-only "what did this version bring".
//
// Shell always mounts on the Overlay's portalled `modal` layer — see the
// variant note in the component for why the panel-scoped `perm` layer cannot be
// used. Dark/light theming comes from the shared sheets; layout plus the card's
// pinned chrome live in update-dialog.css. Fetches release notes on open via
// useReleaseNotes.
//
// The single close path is props.onClose. For the nag-driven modes the App
// host writes the nag dismissal key there, so every closure (Later, backdrop,
// Escape, a successful update) counts as "seen" and the toast never re-nags
// this version — but `current` mode must NOT write it: viewing your own
// version's notes says nothing about whether a newer version is available.

import { useState } from 'react'
import { Overlay } from './Overlay'
import { Markdown } from './Markdown'
import { useReleaseNotes } from '../hooks/useReleaseNotes'
import { useToast } from '../hooks/useToast'
import { reportUpdateResult } from '../utils/update-action'
import { buildUpgradeCommand } from '../utils/upgrade-command'
import { isVersionNewer, type UpdateActionResult, type UpdateInfo } from '../../shared/update-info'
import { IconX, IconCheck, IconAlertTriangle } from './icons/ToolIcons'

/** Which surface opened the dialog.
 *  - `update` / `deprecation`: the sticky nag toast — notes for `(current, latest]`.
 *  - `current`: the About tab — notes for the RUNNING version alone. */
export type UpdateDialogMode = 'update' | 'deprecation' | 'current'

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
  const isCurrent = mode === 'current'
  // The version the notes are FOR. `current` mode asks for the running
  // version's OWN release (from === to, lower bound made inclusive); the other
  // modes ask `(current, latest]` — "what did I miss since I'm on `current`".
  // Bound ONCE and read by both the request and the title, so the header can't
  // name a version whose notes were never asked for.
  const notesTo = isCurrent ? info.current : info.latest
  const { releases, loading, error } = useReleaseNotes(open, info.current, notesTo, isCurrent)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const latest = info.latest
  /** The title's version: the range's own upper bound, falling back to the
   *  running version while no probe has produced a `latest` yet. */
  const notesVersion = notesTo ?? info.current
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
      : `What's new in ${notesVersion}`

  // The empty state, decided in one place: an empty list means different things
  // per mode — in `current` mode "this version was never given a Release"
  // (worth a link to the releases page), elsewhere "GitHub has nothing for us
  // right now". Copy and link travel together so a transport failure can never
  // be rendered as "we looked and your version has none".
  const empty = loading || releases?.length
    ? null
    : error
      ? { text: `Release notes are unavailable right now (${error}).`, href: null }
      : isCurrent
        ? {
            text: 'This version has no release notes.',
            // The server-derived repo — the same slug these notes came from, so
            // the link can't point at a different project than the data.
            href: info.repoUrl ? `${info.repoUrl}/releases` : null,
          }
        : { text: 'Release notes are unavailable right now.', href: null }

  return (
    <Overlay
      // Always the portalled `modal` layer. The panel-scoped `perm` layer is
      // `position: absolute; z-index: 7` and cannot paint above a portalled
      // modal (`.modal-backdrop`, `--z-modal` = 2000) — and this dialog is
      // opened both from the About tab INSIDE GlobalSettingsModal and from the
      // toast while that modal may be open, so on `perm` it rendered
      // underneath: invisible, while its focus trap still took focus. One
      // constant layer also means a mode change can never move a live dialog
      // between layers. `.modal.update-dialog-card` re-pins the card's radius
      // and shadow, which is the whole of the card's look difference; the
      // backdrop behind it is now the standard full-viewport modal scrim.
      variant="modal"
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

        {empty && (
          <p className="update-dialog-empty">
            {empty.text}
            {empty.href && (
              <>
                {' '}
                <a
                  className="update-dialog-release-link"
                  href={empty.href}
                  target="_blank"
                  rel="noreferrer"
                >
                  Browse all releases on GitHub
                </a>
              </>
            )}
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
        {/* The whole upgrade cluster is one thing: `current` mode is not an
            upgrade surface — there is nothing to install for the version
            you're already running — so none of it renders and the footer is
            left with just the close button. */}
        {!isCurrent && (
          <>
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
          </>
        )}
        <span className="update-dialog-footer-spacer" />
        {updateError && <span className="update-dialog-error">{updateError}</span>}
        <button type="button" className="btn" onClick={onClose}>
          {isCurrent ? 'Close' : 'Later'}
        </button>
      </div>
    </Overlay>
  )
}
