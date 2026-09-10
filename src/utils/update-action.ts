// Shared result handling for the in-app update action (POST /api/update).
// One place decides which toast fires for which UpdateActionResult so the
// What's New dialog and the About tab can't drift. (The old UpdateBanner
// duplicate dies with the banner.)

import type { UpdateActionResult } from '../../shared/update-info'

/** Minimal toast surface used — matches the success/info members of the
 *  useToast() handle. */
interface ToastLike {
  success: (message: string) => void
  info: (message: string) => void
}

export function reportUpdateResult(toast: ToastLike, res: UpdateActionResult): void {
  if (!res.performed) {
    // Server declined to install (npx / unknown) — point at the copy-command.
    toast.info("In-app update isn't available for this install — copy the command instead.")
    return
  }
  if (res.updateApplied) {
    // The on-disk package was verifiably upgraded — a restart applies it.
    toast.success(
      `Installed ${res.installedVersion ?? res.latest ?? 'the latest version'} on disk — restart the server to apply.`,
    )
    return
  }
  toast.info(
    res.installedVersion
      ? `Already on the latest version (${res.installedVersion}).`
      : 'Install completed, but the new version could not be confirmed on disk.',
  )
}
