// Workspace adapter — read/write files inside the session's cwd boundary.
//
// All paths are validated against the cwd via shared/app-plugins/path-security
// `isPathInside` AFTER realpath-resolving both — so a symlink that escapes the
// cwd is rejected. This is the second real enforced boundary (after the
// network broker): a plugin that plays by the Host API rules cannot read
// `~/.claude-react-web/config.json`. (A plugin that bypasses via node:fs can
// — see the trust model — but the documented surface is safe.)

import { promises as fs } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { isPathInside } from '../../../shared/app-plugins/path-security.js'
import { LIMITS } from '../../../shared/app-plugins/validation.js'
import type { PermissionChecker } from '../permission-manager.js'

const READ_CAP = 256 * 1024

export class WorkspaceAdapter {
  constructor(private readonly perm: PermissionChecker) {}

  async read(cwd: string, relPath: string): Promise<string> {
    this.perm.assert('workspace.read')
    const file = await this.resolveInside(cwd, relPath)
    const stat = await fs.stat(file)
    if (!stat.isFile()) throw new Error('not a regular file')
    if (stat.size > READ_CAP) throw new Error(`file exceeds ${READ_CAP} bytes`)
    return fs.readFile(file, 'utf8')
  }

  async write(cwd: string, relPath: string, content: string): Promise<void> {
    this.perm.assert('workspace.write')
    if (Buffer.byteLength(content, 'utf8') > LIMITS.configValueBytes) {
      throw new Error(`content exceeds ${LIMITS.configValueBytes} bytes`)
    }
    const file = await this.resolveInside(cwd, relPath)
    await fs.mkdir(resolvePath(file, '..'), { recursive: true })
    await fs.writeFile(file, content, 'utf8')
  }

  /** Realpath-resolve `relPath` against `cwd` and assert it lands inside
   *  `cwd`. Rejects `..`, absolute, and symlink escape. */
  private async resolveInside(cwd: string, relPath: string): Promise<string> {
    if (typeof relPath !== 'string' || relPath.length === 0) throw new Error('path is required')
    if (/^[/\\]/.test(relPath) || /^[a-zA-Z]:[\\/]/.test(relPath)) throw new Error('path must be relative')
    if (relPath.includes('..')) throw new Error('path must not traverse above cwd (..)')
    const base = await fs.realpath(cwd).catch(() => cwd)
    const target = resolvePath(base, relPath)
    const real = await fs.realpath(target).catch(() => target)
    if (!isPathInside(real, base)) throw new Error(`path escapes workspace: ${relPath}`)
    return real
  }
}
