// Shared presentation for permission modes — icon + human-readable label.
//
// Used by ChatPanel's header badge and SessionCard's mode badge so the
// icon set and the accessible labels stay in sync across the app. The
// icons are SVG (not emoji) so they theme via currentColor and render
// identically across platforms.

import type { ReactElement } from 'react'
import type { PermissionMode } from '../types'
import { IconFileText, IconZap, IconPencil, IconBot, IconShield } from './icons/ToolIcons'

/** Human-readable label for a permission mode — used for aria-label and
 *  tooltips so screen readers don't announce raw enum values like
 *  "bypassPermissions". */
// eslint-disable-next-line react-refresh/only-export-components -- shared constants tightly coupled with this file's components
export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  default: 'Default (ask)',
  plan: 'Plan mode',
  acceptEdits: 'Auto-accept edits',
  bypassPermissions: 'Bypass permissions',
  dontAsk: "Don't ask",
  auto: 'Autonomous',
}

// eslint-disable-next-line react-refresh/only-export-components -- shared helper tightly coupled with this file's components
export function permissionModeLabel(mode: PermissionMode | undefined): string {
  return mode ? (PERMISSION_MODE_LABELS[mode] ?? mode) : 'Default (ask)'
}

/** Small SVG glyph for a permission mode. Default renders a neutral shield;
 *  unknown modes return null. `size` defaults to 13 to suit inline badges. */
export function PermissionModeIcon({
  mode,
  size = 13,
}: {
  mode: PermissionMode
  size?: number
}): ReactElement | null {
  switch (mode) {
    case 'plan':
      return <IconFileText size={size} aria-hidden />
    case 'bypassPermissions':
    case 'dontAsk':
      return <IconZap size={size} aria-hidden />
    case 'acceptEdits':
      return <IconPencil size={size} aria-hidden />
    case 'auto':
      return <IconBot size={size} aria-hidden />
    case 'default':
      return <IconShield size={size} aria-hidden />
    default:
      return null
  }
}
