// Canonical permission-mode vocabulary shared by the server (session routes,
// agent-definition store) and the browser (forms, chips). Lives in shared/ so
// the client form and the server cannot drift apart — the historical
// agent-definition list hand-copied these values and invented a non-SDK
// `'disabled'` mode.
//
// `import type` is erased at compile time, so the SDK never enters the browser
// bundle. The `satisfies readonly PermissionMode[]` assertion gives compile-
// time lockstep with @anthropic-ai/claude-agent-sdk: if the SDK adds, removes,
// or renames a mode, tsc fails here instead of silently drifting.

import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'

/** The permission modes this host offers in user-facing pickers. */
export const USER_SELECTABLE_PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
  'dontAsk',
  'auto',
] as const satisfies readonly PermissionMode[]

/** Union of the user-selectable modes (same set as the SDK PermissionMode
 *  values this host accepts). Client-side PermissionMode is this type. */
export type SdkAgentPermissionMode = (typeof USER_SELECTABLE_PERMISSION_MODES)[number]

export function isUserSelectablePermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (USER_SELECTABLE_PERMISSION_MODES as readonly string[]).includes(value)
}

/** Canonical error-message fragment listing the accepted modes. */
export function permissionModeList(modes: readonly PermissionMode[] = USER_SELECTABLE_PERMISSION_MODES): string {
  return modes.join(', ')
}
