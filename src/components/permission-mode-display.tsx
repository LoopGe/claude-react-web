// Shared presentation for permission modes — icon + human-readable label.
//
// Used by ChatPanel's header badge and SessionCard's mode badge so the
// icon set and the accessible labels stay in sync across the app. The
// icons are SVG (not emoji) so they theme via currentColor and render
// identically across platforms.

import type { ReactElement } from 'react'
import type { PermissionMode } from '../types'
import { IconFileText, IconZap, IconPencil, IconBot, IconShield, IconLock } from './icons/ToolIcons'

/** Human-readable label for a permission mode — used for aria-label and
 *  tooltips so screen readers don't announce raw enum values like
 *  "bypassPermissions". The bypass / dontAsk pair is worded as opposites on
 *  purpose: they used to share an icon and "Don't ask" read like "don't
 *  bother me" (which is bypass, not lockdown). */
// eslint-disable-next-line react-refresh/only-export-components -- shared constants tightly coupled with this file's components
export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  default: 'Default (ask)',
  plan: 'Plan mode',
  acceptEdits: 'Auto-accept edits',
  bypassPermissions: 'Bypass (allow all)',
  dontAsk: 'Lockdown (deny unless pre-approved)',
  auto: 'Autonomous',
}

/** Compact label for chip bodies, context menus and selects — places where
 *  the full label would overflow but the raw camelCase enum (`dontAsk`)
 *  would misread as a developer string. */
// eslint-disable-next-line react-refresh/only-export-components -- shared constants tightly coupled with this file's components
export const PERMISSION_MODE_SHORT_LABELS: Record<PermissionMode, string> = {
  default: 'ask',
  plan: 'plan',
  acceptEdits: 'accept edits',
  bypassPermissions: 'bypass',
  dontAsk: 'lockdown',
  auto: 'auto',
}

// eslint-disable-next-line react-refresh/only-export-components -- shared helper tightly coupled with this file's components
export function permissionModeLabel(mode: PermissionMode | undefined): string {
  return mode ? (PERMISSION_MODE_LABELS[mode] ?? mode) : 'Default (ask)'
}

/** Short label with a raw-enum fallback, mirroring `permissionModeLabel` so
 *  an unexpected runtime mode string never renders an empty chip body. */
// eslint-disable-next-line react-refresh/only-export-components -- shared helper tightly coupled with this file's components
export function permissionModeShortLabel(mode: PermissionMode): string {
  return PERMISSION_MODE_SHORT_LABELS[mode] ?? mode
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
      return <IconZap size={size} aria-hidden />
    case 'dontAsk':
      // Lockdown: deny unless pre-approved. Deliberately NOT IconZap — that
      // glyph is bypass's "skip every prompt, allow all", the opposite policy.
      return <IconLock size={size} aria-hidden />
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
