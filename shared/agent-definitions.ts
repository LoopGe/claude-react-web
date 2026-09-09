// Agent-definition vocabulary. Permission modes are re-exported from
// shared/permission-modes.ts (the canonical list) so the agent form and the
// session pickers cannot diverge.

export {
  USER_SELECTABLE_PERMISSION_MODES as SDK_AGENT_PERMISSION_MODES,
  isUserSelectablePermissionMode as isSdkAgentPermissionMode,
  permissionModeList,
  type SdkAgentPermissionMode,
} from './permission-modes.js'

/**
 * Historical value this host used to accept by mistake on agent definitions.
 * Load-time migration strips it (never drops the whole agent) so old on-disk
 * definitions keep working with the session default permission mode.
 *
 * `'disabled'` was never an SDK PermissionMode — the app-level on/off switch
 * is the separate `enabled` boolean on StoredAgentDefinition.
 */
export const LEGACY_INVALID_PERMISSION_MODE = 'disabled'
