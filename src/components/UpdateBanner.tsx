// Top-of-page banner shown when the npm registry reports a newer version.
//
// Behaviour:
//   - Renders only when `info.hasUpdate && info.latest` AND the user
//     hasn't dismissed THIS specific version yet (sessionStorage'd).
//   - One-click copies the upgrade command (`npx claude-react-web@latest`).
//   - The dismiss state is keyed on the latest version, so when a still-
//     newer version appears the banner re-emerges. Stored in sessionStorage
//     (not localStorage) — across full reloads / restarts the user gets a
//     fresh nudge, which we want for a long-running CLI.
//
// All colours come from CSS variables (CLAUDE.md hard rule). The banner
// sits inline right after the .error-bar in App.tsx so the two stay in
// the same vertical "system messaging" band without overlapping.

import { useState } from 'react'
import type { UpdateActionResult, UpdateInfo } from '../../shared/update-info'
import { buildUpgradeCommand } from '../utils/upgrade-command'
import { useToast } from '../hooks/useToast'
import { IconX, IconCheck } from './icons/ToolIcons'

const DISMISS_KEY = 'claude-react-web:update-banner-dismissed-version'

interface Props {
  info: UpdateInfo | null
  /** True while POST /api/update is in flight (shared with the About tab). */
  updating?: boolean
  /** Trigger the in-app update. Resolves with the action result, or throws.
   *  Omitted when the host hasn't wired the update action — the banner then
   *  shows only the copy-command. */
  onUpdate?: () => Promise<UpdateActionResult>
}

export function UpdateBanner({ info, updating, onUpdate }: Props) {
  if (!info) return null

  const hasDeprecation = !!info.deprecated
  const hasUpdate = !!(info.hasUpdate && info.latest)

  if (!hasDeprecation && !hasUpdate) return null

  return (
    <>
      {hasDeprecation && (
        <DeprecatedBannerInner
          key={`deprecated-${info.current}`}
          current={info.current}
          deprecated={info.deprecated!}
          latest={info.latest}
          packageName={info.packageName}
          registry={info.registry}
          installMethod={info.installMethod}
          updating={!!updating}
          onUpdate={onUpdate}
        />
      )}
      {hasUpdate && (
        <UpdateBannerInner
          key={info.latest}
          current={info.current}
          latest={info.latest!}
          packageName={info.packageName}
          registry={info.registry}
          installMethod={info.installMethod}
          updating={!!updating}
          onUpdate={onUpdate}
        />
      )}
    </>
  )
}

function DeprecatedBannerInner({
  current,
  deprecated,
  latest,
  packageName,
  registry,
  installMethod,
  updating,
  onUpdate,
}: {
  current: string
  deprecated: string | true
  latest?: string
  packageName: string
  registry?: string
  installMethod: UpdateInfo['installMethod']
  updating: boolean
  onUpdate?: () => Promise<UpdateActionResult>
}) {
  const toast = useToast()
  const UPGRADE_COMMAND = buildUpgradeCommand(packageName, registry)
  const [dismissed, setDismissed] = useState(false)
  const [copied, setCopied] = useState(false)

  const canUpdateInApp = installMethod === 'global' && !!onUpdate

  if (dismissed) return null

  const deprecationMsg =
    typeof deprecated === 'string' ? deprecated : 'This version has been deprecated by the maintainer.'

  const runUpdate = () => {
    if (!onUpdate) return
    onUpdate().then(
      (res) => {
        if (res.performed) {
          if (res.updateApplied) {
            toast.success(
              `Installed ${res.installedVersion ?? res.latest ?? 'the latest version'} on disk — restart the server to apply.`,
            )
            setDismissed(true)
          } else {
            toast.info(
              res.installedVersion
                ? `Already on the latest version (${res.installedVersion}).`
                : 'Install completed, but the new version could not be confirmed on disk.',
            )
          }
        } else {
          toast.info("In-app update isn’t available for this install — copy the command instead.")
        }
      },
      (err: unknown) => {
        toast.error(`Update failed: ${err instanceof Error ? err.message : String(err)}`)
      },
    )
  }

  const copy = () => {
    if (!navigator.clipboard) return
    navigator.clipboard.writeText(UPGRADE_COMMAND).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      },
      (err: unknown) => {
        console.warn('clipboard write failed:', err)
      },
    )
  }

  return (
    <div className="update-banner update-banner-deprecated" role="alert" aria-live="assertive">
      <span className="update-banner-icon" aria-hidden="true">⚠</span>
      <span className="update-banner-text">
        Version <strong>{current}</strong> is deprecated
        {latest && latest !== current && <> — update to <strong>{latest}</strong></>}
        <span style={{ display: 'block', fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}>
          {deprecationMsg}
        </span>
      </span>
      {/* Only show upgrade controls when there's a newer version to upgrade to.
          When current === latest (the latest version itself is deprecated),
          the upgrade command would just reinstall the same deprecated version. */}
      {latest && latest !== current && canUpdateInApp && (
        <button
          type="button"
          className="update-banner-btn"
          onClick={runUpdate}
          disabled={updating}
          title="Run the upgrade on the server, then restart to apply."
        >
          {updating ? 'Updating…' : 'Update now'}
        </button>
      )}
      {latest && latest !== current && (
        <>
          <code className="update-banner-cmd">{UPGRADE_COMMAND}</code>
          <button
            type="button"
            className={canUpdateInApp ? 'update-banner-btn-ghost' : 'update-banner-btn'}
            onClick={copy}
            title="Copy upgrade command to clipboard"
          >
            {copied ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>Copied <IconCheck size={12} /></span> : 'Copy'}
          </button>
        </>
      )}
      <button
        type="button"
        className="update-banner-close"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss deprecation notice"
        title="Dismiss"
      >
        <IconX size={14} />
      </button>
    </div>
  )
}

function UpdateBannerInner({
  current,
  latest,
  packageName,
  registry,
  installMethod,
  updating,
  onUpdate,
}: {
  current: string
  latest: string
  packageName: string
  registry?: string
  installMethod: UpdateInfo['installMethod']
  updating: boolean
  onUpdate?: () => Promise<UpdateActionResult>
}) {
  const toast = useToast()
  const UPGRADE_COMMAND = buildUpgradeCommand(packageName, registry)
  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (typeof sessionStorage === 'undefined') return false
    return sessionStorage.getItem(DISMISS_KEY) === latest
  })
  const [copied, setCopied] = useState(false)

  // An in-app update can only replace a global install. For npx / dev runs
  // there's nothing to upgrade in place, so the button is hidden and the
  // user falls back to the copy-command. Mirrors the About-tab gate.
  const canUpdateInApp = installMethod === 'global' && !!onUpdate

  if (dismissed) return null

  // Run the in-app update and surface the outcome via toast — same result
  // handling as the GlobalSettingsModal About tab so the two entry points
  // behave identically. On success we dismiss the banner (a restart applies
  // the new version; nagging further adds nothing).
  const runUpdate = () => {
    if (!onUpdate) return
    onUpdate().then(
      (res) => {
        if (res.performed) {
          if (res.updateApplied) {
            toast.success(
              `Installed ${res.installedVersion ?? res.latest ?? 'the latest version'} on disk — restart the server to apply.`,
            )
            dismiss()
          } else {
            toast.info(
              res.installedVersion
                ? `Already on the latest version (${res.installedVersion}).`
                : 'Install completed, but the new version could not be confirmed on disk.',
            )
          }
        } else {
          toast.info('In-app update isn’t available for this install — copy the command instead.')
        }
      },
      (err: unknown) => {
        toast.error(`Update failed: ${err instanceof Error ? err.message : String(err)}`)
      },
    )
  }

  const dismiss = () => {
    try {
      sessionStorage.setItem(DISMISS_KEY, latest)
    } catch {
      /* sessionStorage unavailable (e.g. private mode quota) — fall back
       * to a soft dismiss for this tab session. */
    }
    setDismissed(true)
  }

  const copy = () => {
    if (!navigator.clipboard) return
    navigator.clipboard.writeText(UPGRADE_COMMAND).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      },
      (err: unknown) => {
        console.warn('clipboard write failed:', err)
      },
    )
  }

  return (
    <div className="update-banner" role="status" aria-live="polite">
      <span className="update-banner-icon" aria-hidden="true">↑</span>
      <span className="update-banner-text">
        New version available — <strong>{current}</strong> →{' '}
        <strong>{latest}</strong>
      </span>
      {canUpdateInApp && (
        <button
          type="button"
          className="update-banner-btn"
          onClick={runUpdate}
          disabled={updating}
          title="Run the upgrade on the server, then restart to apply."
        >
          {updating ? 'Updating…' : 'Update now'}
        </button>
      )}
      <code className="update-banner-cmd">{UPGRADE_COMMAND}</code>
      <button
        type="button"
        className={canUpdateInApp ? 'update-banner-btn-ghost' : 'update-banner-btn'}
        onClick={copy}
        title="Copy upgrade command to clipboard"
      >
        {copied ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>Copied <IconCheck size={12} /></span> : 'Copy'}
      </button>
      <button
        type="button"
        className="update-banner-close"
        onClick={dismiss}
        aria-label="Dismiss update notice"
        title="Dismiss until next version"
      >
        <IconX size={14} />
      </button>
    </div>
  )
}
