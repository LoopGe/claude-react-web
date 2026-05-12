export const SIDEBAR_ORDER_KEY = 'claude-react-web:session-order'
export const SHOW_SYSTEM_EVENTS_KEY = 'claude-react-web:show-system-events'
export const SIDEBAR_WIDTH_KEY = 'claude-react-web:sidebar-width'
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
export const GROUPS_KEY = 'claude-react-web:session-groups'
export const COLLAPSED_GROUPS_KEY = 'claude-react-web:collapsed-groups'
export const MAX_OPEN_KEY = 'claude-react-web:max-open-panels'

/** Allowed range for the max-panels / max-sessions-per-group setting. */
export const MAX_OPEN_MIN = 2
export const MAX_OPEN_MAX = 5
export const MAX_OPEN_DEFAULT = 3
/** Clamp a user-supplied max-open value to the allowed range. */
export function clampMaxOpen(v: number): number {
  return Math.max(MAX_OPEN_MIN, Math.min(MAX_OPEN_MAX, Math.round(v)))
}
