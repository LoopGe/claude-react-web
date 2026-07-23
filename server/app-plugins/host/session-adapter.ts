// Session adapter — the only surface a plugin has to read/send into a
// session. Calls SessionManager's public methods and returns the shared-
// contract裁剪 shape (coarse metadata, never the transcript). Each method
// checks its permission first.

import type { SessionManager } from '../../session-manager.js'
import type { PermissionChecker } from '../permission-manager.js'

export class SessionAdapter {
  constructor(
    private readonly sm: SessionManager,
    private readonly perm: PermissionChecker,
  ) {}

  /** Coarse session metadata (provider, cwd, model). Never the transcript. */
  async read(sessionId: string): Promise<{ provider: string; cwd: string; model?: string } | null> {
    this.perm.assert('sessions.read')
    const sm = this.sm as unknown as {
      get(id: string): { provider?: string; cwd?: string; model?: string } | undefined
    }
    const s = sm.get(sessionId)
    if (!s) return null
    return { provider: s.provider ?? 'claude', cwd: s.cwd ?? '', model: s.model }
  }

  /** Enqueue a user-text turn into the session (same path as the composer). */
  async send(sessionId: string, text: string): Promise<void> {
    this.perm.assert('sessions.send')
    if (typeof text !== 'string' || text.length === 0) throw new Error('text is required')
    if (text.length > 20_000) throw new Error('text too long (max 20000 chars)')
    this.sm.send(sessionId, text)
  }

  /** Interrupt the session's current turn. */
  async interrupt(sessionId: string): Promise<void> {
    this.perm.assert('sessions.interrupt')
    this.sm.interrupt(sessionId)
  }
}
