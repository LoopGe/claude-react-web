import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import {
  USER_SELECTABLE_PERMISSION_MODES as SHARED_USER_SELECTABLE_PERMISSION_MODES,
  isUserSelectablePermissionMode,
  permissionModeList,
} from '../shared/permission-modes.js'

// Re-export the shared vocabulary so existing `server/permission-modes.js`
// import sites keep working. The list itself lives in shared/ with a
// compile-time `satisfies readonly PermissionMode[]` lockstep to the SDK.
export {
  isUserSelectablePermissionMode,
  permissionModeList,
}
export const USER_SELECTABLE_PERMISSION_MODES = SHARED_USER_SELECTABLE_PERMISSION_MODES

/** Plan approval can only exit into these execution modes (never back into
 *  plan, and never into a lockdown mode the user didn't opt into). */
export const PLAN_APPROVAL_TARGET_MODES = [
  'default',
  'acceptEdits',
  'bypassPermissions',
] as const satisfies readonly PermissionMode[]

export function isPlanApprovalTargetMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PLAN_APPROVAL_TARGET_MODES as readonly string[]).includes(value)
}

/**
 * The permission modes forwarded to the SDK's Options.permissionMode /
 * Query.setPermissionMode instead of being enforced by our own canUseTool
 * broker. Single source of truth for BOTH forward sites:
 *   - spawn (claude-provider's sdkForwardMode) — forwards the mode, or pins
 *     'default' for anything else
 *   - mid-session (SessionManager.setPermissionMode) — forwards the mode, or
 *     'default' for anything else (explicitly releases the CLI-side mode)
 * Adding a mode here must consider both sites; see sdkForwardMode for why
 * only these two are forwarded.
 *
 * Why the spawn fallback is 'default' and NOT omission: SDK 0.3.286
 * redefined an omitted Options.permissionMode as "leave it to Claude Code" —
 * a settings.json `defaultMode` now applies, and on third-party providers /
 * with telemetry off the CLI starts in auto mode, whose classifier decides
 * BEFORE the host's canUseTool. Before 0.3.286 omission meant the CLI's
 * plain 'default' mode, where every tool escalates to our broker. This is
 * the canonical statement of that rationale; the forward sites and tests
 * reference it rather than repeating it.
 */
export const SDK_FORWARDED_PERMISSION_MODES = ['plan', 'auto'] as const satisfies readonly PermissionMode[]

export function isSdkForwardedMode(mode: PermissionMode): boolean {
  return (SDK_FORWARDED_PERMISSION_MODES as readonly string[]).includes(mode)
}
