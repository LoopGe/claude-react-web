import { clamp } from '../utils/clamp'

export const SIDEBAR_WIDTH_KEY = 'claude-react-web:sidebar-width'
/** Desktop sidebar hide/show state (true = collapsed/hidden). */
export const SIDEBAR_COLLAPSED_KEY = 'claude-react-web:sidebar-collapsed'
export const SIDEBAR_MIN_KEY = 'claude-react-web:sidebar-min-px'
export const SIDEBAR_MAX_KEY = 'claude-react-web:sidebar-max-px'
export const SIDEBAR_MIN_DEFAULT = 180
export const SIDEBAR_MAX_DEFAULT = 480
/** Column-flex weights for the main grid (length === maxOpen). Ratios
 *  are normalised on use so values like [1, 0.5, 0.5] render correctly
 *  no matter how many panels are currently open. */
export const PANEL_RATIOS_KEY = 'claude-react-web:panel-col-ratios'
/** Minimum column ratio — keeps a panel from collapsing to nothing. */
export const PANEL_MIN_RATIO_KEY = 'claude-react-web:panel-min-ratio'
export const PANEL_MIN_RATIO_DEFAULT = 0.15
/** Per-session "last turn the user has seen" timestamps, used to decide
 *  whether a session shows an unread dot in the sidebar and panel header.
 *  Persisted so a reload doesn't mark every previously-answered session
 *  as unread. Pruned when sessions disappear from the server. */
export const LAST_SEEN_TURN_KEY = 'claude-react-web:last-seen-turn'

/** sessionStorage key prefix for per-session composer drafts, keyed by
 *  session id (`DRAFT_KEY_PREFIX + sessionId`). Shared by the composer
 *  (Chat) and the reset-config cleaner, which scans for the prefix. */
export const DRAFT_KEY_PREFIX = 'claude-react-web:draft:'
/** sessionStorage key prefix for per-session composer attachment state. */
export const DRAFT_BODIES_KEY_PREFIX = 'claude-react-web:draft-bodies:'

/** Allowed range for the max-group-panels / max-sessions-per-group setting. */
export const MAX_OPEN_MIN = 2
export const MAX_OPEN_MAX = 5
/** Clamp a user-supplied max-open value to the allowed range. */
export function clampMaxOpen(v: number): number {
  return clamp(Math.round(v), MAX_OPEN_MIN, MAX_OPEN_MAX)
}
