// Session adapter — the only surface a plugin has to read/send into a
// session. Calls SessionManager's public methods and returns the shared-
// contract裁剪 shape (coarse metadata, never the transcript). Each method
// checks its permission first.

import type { SessionManager } from '../../session-manager.js'
import type { SessionActivity } from '../../session-types.js'
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

  /** Enumerate live sessions as coarse activity snapshots (never the
   *  transcript). The background-watcher surface for picking an idle
   *  candidate. */
  async list(): Promise<SessionActivity[]> {
    this.perm.assert('sessions.read')
    return this.sm.listActivity()
  }

  /** Cached context-usage snapshot for a session, or null when unknown /
   *  no snapshot yet. Cheap — reads the pump's cache, no SDK round-trip. */
  async contextUsage(sessionId: string): Promise<{
    totalTokens: number
    maxTokens: number
    rawMaxTokens: number
    percentage: number
    model: string
    autoCompactThreshold?: number
  } | null> {
    this.perm.assert('sessions.read')
    return this.sm.getCachedContextUsage(sessionId)
  }

  /** Compact an idle session: summarise the conversation and swap to a fresh
   *  session seeded with the hand-off summary. Throws for unknown / working /
   *  terminated / dormant sessions (see SessionManager.compact guards). */
  async compact(sessionId: string): Promise<{ ok: true; sessionId: string }> {
    this.perm.assert('sessions.compact')
    const fresh = await this.sm.compact(sessionId)
    return { ok: true, sessionId: fresh.id }
  }
}
