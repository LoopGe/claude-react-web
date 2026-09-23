/** Display title for a session: its title when set, else a short id prefix.
 *  The single home for the `session.title ?? session.id.slice(0, 8)` fallback
 *  that was previously inlined at ~15 call sites (exports, notifications,
 *  context menus, drawer headers, …). */
export interface SessionTitleLike {
  title?: string | null
  id: string
}

export function sessionTitleOrFallback(session: SessionTitleLike, idChars = 8): string {
  return session.title ?? session.id.slice(0, idChars)
}
