// Proactive update nag — pushes ONE sticky toast per offered version, with
// three explicit actions and NO dismiss icon:
//
//   - Update            → opens the What's New dialog; writes nothing.
//   - Remind me later   → closes the reminder; writes NOTHING. The per-mount
//                         toastedRef is the whole "later" mechanism: this tab
//                         stays silent, the next mount (reload / new tab /
//                         restart) offers the version again.
//   - Skip this version → writes the persistent dismissal key.
//
// Gates (mandatory, see shared/update-info.ts):
//   - update branch:  isUpdateNagNeeded(info)  (suppresses once an in-app
//     update is on disk pending restart — hasUpdate alone re-nags every tab)
//   - deprecation branch: info.deprecated && !isUpdateAppliedToDisk(info)
//
// Persistence: localStorage NAG_DISMISS_STORAGE_KEY holds the SKIPPED value —
// the offered `latest` for the update branch, `deprecated:<current>` for the
// deprecation branch. A newer `latest` (or a new deprecation target) differs
// from the stored value → re-notify. Only the explicit Skip action (here and
// in the dialog's onSkip) writes it; a bare close never does.
//
// Per-mount dedup: toastedRef remembers the value already pushed by THIS
// hook instance so effect re-runs (info identity churn, StrictMode double
// invoke) can't stack toasts. Cross-tab skip dedup is the localStorage key.

import { useEffect, useRef } from 'react'
import { useToast } from './useToast'
import { isUpdateAppliedToDisk, isUpdateNagNeeded, type UpdateInfo } from '../../shared/update-info'

export const NAG_DISMISS_STORAGE_KEY = 'claude-react-web:update-nag-dismissed-version'

export type UpdateNagMode = 'update' | 'deprecation'

/** True for the modes that actually NAG — i.e. the dialog modes that own a
 *  dismissal key. `UpdateDialogMode` has a third, read-only member (`current`,
 *  the About tab's own-version notes); see `nagDismissValueFor`. Written as a
 *  positive list so a future non-nag mode can't inherit the write by default. */
function isNagMode(mode: string): mode is UpdateNagMode {
  return mode === 'update' || mode === 'deprecation'
}

/** The localStorage value a dialog close should record as "seen" for `mode` —
 *  or null when this mode must not write one at all.
 *
 *  The read-only `current` viewer returns null: that key suppresses the next
 *  notification for the version it names, and viewing your own version's notes
 *  says nothing about whether an update exists. Lives here rather than at the
 *  App call site so the whole "which closures count as seen" policy sits with
 *  the rest of the nag logic instead of being a negative list next to an
 *  unrelated onClose. */
export function nagDismissValueFor(mode: string, info: UpdateInfo): string | null {
  if (!isNagMode(mode)) return null
  return mode === 'update' && info.latest
    ? nagValueForUpdate(info.latest)
    : nagValueForDeprecated(info.current)
}

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
  // The toast's action button fires long after the effect that registered it has
  // returned, so the opener is read at CLICK time — while the effect that pushes
  // the toast must not re-run (and re-push) just because the caller's inline
  // arrow changed identity every render. A ref synced in its own effect gives
  // both: a stable identity whose value is always the latest callback. (Writing
  // it during render instead is what react-hooks/refs forbids.)
  const onOpenRef = useRef(onOpenDialog)
  useEffect(() => {
    onOpenRef.current = onOpenDialog
  }, [onOpenDialog])
  const toastedRef = useRef<string | null>(null)
  // The live toast's id, so an offer that becomes invalid (registry disabled,
  // update applied to disk) is WITHDRAWN, and a newer version REPLACES it —
  // sticky toasts are exempt from capacity eviction, so without this a
  // long-running tab would accumulate one stale nag per release.
  const toastIdRef = useRef<string | null>(null)

  // The three explicit choices. No onDismiss and no ✕ (hideDismiss): a bare
  // close must not silently mean "skip forever" — that was the misleading
  // part of the old single-action toast.
  const nagActions = (mode: UpdateNagMode, value: string) => [
    { label: 'Update', onClick: () => onOpenRef.current(mode) },
    { label: 'Remind me later', onClick: () => { /* stateless by design */ } },
    { label: 'Skip this version', onClick: () => writeNagDismiss(value) },
  ]

  useEffect(() => {
    const withdraw = () => {
      if (toastIdRef.current !== null) {
        toast.dismiss(toastIdRef.current)
        toastIdRef.current = null
      }
      // Clear the per-mount dedup too: a withdrawal (e.g. registry disabled)
      // must not silence the same version when the offer becomes valid again.
      toastedRef.current = null
    }

    if (!info || info.checking) return

    // Update branch wins over deprecation: upgrading escapes a deprecation,
    // so nagging both at once is redundant noise.
    if (isUpdateNagNeeded(info) && info.latest) {
      const value = nagValueForUpdate(info.latest)
      if (toastedRef.current === value) return
      if (readNagDismiss() === value) return
      withdraw() // replace any older offer instead of stacking
      toastedRef.current = value
      toastIdRef.current = toast.show('info', `${info.current} → ${info.latest} — see what changed`, {
        title: 'New version available',
        durationMs: 0, // sticky — the only proactive surface now that the banner is gone
        hideDismiss: true,
        actions: nagActions('update', value),
      })
      return
    }

    if (info.deprecated && !isUpdateAppliedToDisk(info)) {
      const value = nagValueForDeprecated(info.current)
      if (toastedRef.current === value) return
      if (readNagDismiss() === value) return
      withdraw()
      toastedRef.current = value
      const message =
        typeof info.deprecated === 'string'
          ? info.deprecated
          : 'This version has been deprecated by the maintainer.'
      toastIdRef.current = toast.show('info', message, {
        title: `Version ${info.current} is deprecated`,
        durationMs: 0,
        hideDismiss: true,
        actions: nagActions('deprecation', value),
      })
      return
    }

    // No branch applies (disabled, update on disk, nothing offered): a live
    // offer from an earlier snapshot is now stale — withdraw it.
    withdraw()
  }, [info, toast])
}
