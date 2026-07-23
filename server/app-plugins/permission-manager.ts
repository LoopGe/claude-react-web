// Per-plugin permission checker.
//
// Wraps the plugin's currently-granted NormalisedPermission set in a small
// object the Host API adapters call before fulfilling a request. This is the
// consent + feature-flag gate documented in shared/app-plugins/permissions.ts:
// it is NOT a security sandbox (the subprocess can `import node:fs`), but it
// makes the user's consent decisions real for the domain-scoped capabilities
// (notably network.fetch's host allowlist) and emits an audit line on every
// denial.

import { createLogger } from '../log.js'
import { hasPermission, type AppPluginPermission, type NormalisedPermission } from '../../shared/app-plugins/permissions.js'

const log = createLogger('app-plugins:perm')

export interface PermissionCallParams {
  /** For network.fetch: the target host (lowercased). */
  host?: string
}

export class PermissionChecker {
  constructor(
    private readonly pluginId: string,
    private grants: NormalisedPermission[],
  ) {}

  /** Replace the grant set (called when the user adjusts permissions). */
  setGrants(grants: NormalisedPermission[]): void {
    this.grants = grants
  }

  snapshot(): NormalisedPermission[] {
    return this.grants
  }

  /** True iff the call is permitted. Does NOT throw — callers decide. */
  permits(permission: AppPluginPermission, params?: PermissionCallParams): boolean {
    return hasPermission(this.grants, permission, params)
  }

  /** Assert the call is permitted; throw a typed error on denial. Adapters
   *  call this at the top of each method. */
  assert(permission: AppPluginPermission, params?: PermissionCallParams, detail?: string): void {
    if (this.permits(permission, params)) return
    log.info(`[${this.pluginId}] denied ${permission}${params?.host ? ` host=${params.host}` : ''}${detail ? ` (${detail})` : ''}`)
    const err = new PermissionDeniedError(permission, detail)
    throw err
  }
}

export class PermissionDeniedError extends Error {
  readonly permission: string
  constructor(permission: string, detail?: string) {
    super(`permission denied: ${permission}${detail ? ` — ${detail}` : ''}`)
    this.permission = permission
  }
}
