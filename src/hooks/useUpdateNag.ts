// Proactive update nag — pushes ONE sticky toast per offered version.
//
// Gates (mandatory, see shared/update-info.ts):
//   - update branch:  isUpdateNagNeeded(info)  (suppresses once an in-app
//     update is on disk pending restart — hasUpdate alone re-nags every tab)
//   - deprecation branch: info.deprecated && !isUpdateAppliedToDisk(info)
//
// Persistence: localStorage NAG_DISMISS_STORAGE_KEY holds the dismissed
// value — the offered `latest` for the update branch, `deprecated:<current>`
// for the deprecation branch. A newer `latest` (or a new deprecation target)
// differs from the stored value → re-notify. The toast's onDismiss callback
// writes the key on ANY dismissal (✕, action-click auto-dismiss); the App
// host also writes it when the dialog closes — one nag per version, any
// closure counts as "seen".
//
// Per-mount dedup: toastedRef remembers the value already pushed by THIS
// hook instance so effect re-runs (info identity churn, StrictMode double
// invoke) can't stack toasts. Cross-tab dedup is the localStorage key.

import { useEffect, useRef } from 'react'
import { useToast } from './useToast'
import { isUpdateAppliedToDisk, isUpdateNagNeeded, type UpdateInfo } from '../../shared/update-info'

export const NAG_DISMISS_STORAGE_KEY = 'claude-react-web:update-nag-dismissed-version'

export type UpdateNagMode = 'update' | 'deprecation'

export function nagValueForUpdate(latest: string): string {
  return latest
}

export function nagValueForDeprecated(current: string): string {
  return `deprecated:${current}`
}

export function readNagDismiss(): string | null {
  try {
    return localStorage.getItem(NAG_DISMISS_STORAGE_KEY)
  } catch {
    return null
  }
}

export function writeNagDismiss(value: string): void {
  try {
    localStorage.setItem(NAG_DISMISS_STORAGE_KEY, value)
  } catch {
    /* private-mode / quota — the per-mount ref still suppresses this tab. */
  }
}

export function useUpdateNag(
  info: UpdateInfo | null,
  onOpenDialog: (mode: UpdateNagMode) => void,
): void {
  const toast = useToast()
  // Stable identity so the effect doesn't re-run (and re-push) when the
  // caller's inline arrow changes every render.
  const onOpenRef = useRef(onOpenDialog)
  onOpenRef.current = onOpenDialog
  const toastedRef = useRef<string | null>(null)

  useEffect(() => {
    if (!info || info.checking) return

    // Update branch wins over deprecation: upgrading escapes a deprecation,
    // so nagging both at once is redundant noise.
    if (isUpdateNagNeeded(info) && info.latest) {
      const value = nagValueForUpdate(info.latest)
      if (toastedRef.current === value) return
      if (readNagDismiss() === value) return
      toastedRef.current = value
      toast.show('info', `${info.current} → ${info.latest} — see what changed`, {
        title: 'New version available',
        durationMs: 0, // sticky — the only proactive surface now that the banner is gone
        actionLabel: 'Update',
        onClick: () => {
          writeNagDismiss(value)
          onOpenRef.current('update')
        },
        onDismiss: () => writeNagDismiss(value),
      })
      return
    }

    if (info.deprecated && !isUpdateAppliedToDisk(info)) {
      const value = nagValueForDeprecated(info.current)
      if (toastedRef.current === value) return
      if (readNagDismiss() === value) return
      toastedRef.current = value
      const message =
        typeof info.deprecated === 'string'
          ? info.deprecated
          : 'This version has been deprecated by the maintainer.'
      toast.show('info', message, {
        title: `Version ${info.current} is deprecated`,
        durationMs: 0,
        actionLabel: 'Update',
        onClick: () => {
          writeNagDismiss(value)
          onOpenRef.current('deprecation')
        },
        onDismiss: () => writeNagDismiss(value),
      })
    }
  }, [info, toast])
}
