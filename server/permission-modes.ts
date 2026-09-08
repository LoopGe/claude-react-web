import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'

export const USER_SELECTABLE_PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
  'dontAsk',
  'auto',
] as const satisfies readonly PermissionMode[]

export const PLAN_APPROVAL_TARGET_MODES = [
  'default',
  'acceptEdits',
  'bypassPermissions',
] as const satisfies readonly PermissionMode[]

export function isUserSelectablePermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (USER_SELECTABLE_PERMISSION_MODES as readonly string[]).includes(value)
}

export function isPlanApprovalTargetMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PLAN_APPROVAL_TARGET_MODES as readonly string[]).includes(value)
}

/**
 * The permission modes forwarded to the SDK's Options.permissionMode /
 * Query.setPermissionMode instead of being enforced by our own canUseTool
 * broker. Single source of truth for BOTH forward sites:
 *   - spawn (claude-provider's sdkForwardMode) — forwards the mode, or
 *     `undefined` for anything else (no SDK-side mode)
 *   - mid-session (SessionManager.setPermissionMode) — forwards the mode, or
 *     'default' for anything else (explicitly releases the CLI-side mode)
 * Adding a mode here must consider both sites; see sdkForwardMode for why
 * only these two are forwarded.
 */
export const SDK_FORWARDED_PERMISSION_MODES = ['plan', 'auto'] as const satisfies readonly PermissionMode[]

export function isSdkForwardedMode(mode: PermissionMode): boolean {
  return (SDK_FORWARDED_PERMISSION_MODES as readonly string[]).includes(mode)
}

export function permissionModeList(modes: readonly PermissionMode[] = USER_SELECTABLE_PERMISSION_MODES): string {
  return modes.join(', ')
}
