// Git adapter — read-only git access scoped to a session's cwd.
//
// Every call goes through server/git.ts's exported safe functions (never
// `runGit`, which is private; never a shell). Paths are validated by
// `validateRepoRelativePath` (rejects absolute + `..`, prefixes `--`). The
// adapter only exposes read ops in v1; git.write is declared as a permission
// but the host API surface for writes is deferred.

import { getStatus, getDiff, getLog, validateRepoRelativePath } from '../../git.js'
import type { PermissionChecker } from '../permission-manager.js'

export class GitAdapter {
  constructor(private readonly perm: PermissionChecker) {}

  async read(op: 'status' | 'diff' | 'log', cwd: string, params?: { path?: string; limit?: number }): Promise<unknown> {
    // The host-api resolves `cwd` from the session the plugin named; the
    // adapter itself only needs the cwd + op. Read-only in v1.
    this.perm.assert('git.read')
    if (!cwd) throw new Error('git.read requires a cwd')
    switch (op) {
      case 'status':
        return getStatus(cwd)
      case 'diff': {
        const path = params?.path ? validateRepoRelativePath(params.path) : undefined
        return getDiff(cwd, path ?? '', false)
      }
      case 'log':
        return getLog(cwd, params?.limit ?? 20)
    }
  }
}
