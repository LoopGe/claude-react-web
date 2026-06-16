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

export function permissionModeList(modes: readonly PermissionMode[] = USER_SELECTABLE_PERMISSION_MODES): string {
  return modes.join(', ')
}
