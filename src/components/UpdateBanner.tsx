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
import type { UpdateInfo } from '../../shared/update-info'
import { buildUpgradeCommand } from '../utils/upgrade-command'
import { IconX, IconCheck } from './icons/ToolIcons'

const DISMISS_KEY = 'claude-react-web:update-banner-dismissed-version'

interface Props {
  info: UpdateInfo | null
}

export function UpdateBanner({ info }: Props) {
  if (!info || !info.hasUpdate || !info.latest) return null
  // The inner component is keyed on the latest version so a fresh
  // version remounts it — automatically resetting the local
  // `dismissed` / `copied` state without needing an effect.
  return (
    <UpdateBannerInner
      key={info.latest}
      current={info.current}
      latest={info.latest}
      packageName={info.packageName}
      registry={info.registry}
    />
  )
}

function UpdateBannerInner({
  current,
  latest,
  packageName,
  registry,
}: {
  current: string
  latest: string
  packageName: string
  registry?: string
}) {
  const UPGRADE_COMMAND = buildUpgradeCommand(packageName, registry)
  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (typeof sessionStorage === 'undefined') return false
    return sessionStorage.getItem(DISMISS_KEY) === latest
  })
  const [copied, setCopied] = useState(false)

  if (dismissed) return null

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
      <code className="update-banner-cmd">{UPGRADE_COMMAND}</code>
      <button
        type="button"
        className="update-banner-btn"
        onClick={copy}
        title="Copy upgrade command to clipboard"
      >
        {copied ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>Copied <IconCheck size={13} /></span> : 'Copy'}
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
