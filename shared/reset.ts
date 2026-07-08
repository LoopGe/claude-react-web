// shared/reset.ts
// Categories the "Clear configuration & data" dialog can clear. Shared so the
// server route and the client dialog agree on the exact item keys.

/** Server-side items handled by POST /config/reset. */
export type ServerResetItem =
  | 'app-settings'
  | 'mcp-configs'
  | 'marketplaces'
  | 'snippets'
  | 'ui-state'
  | 'logs'
  | 'credentials'
  | 'sessions'

/** Client-side items cleared by the browser after the server responds. */
export type BrowserDataItem = 'input-history' | 'drafts' | 'appearance'

export const SERVER_RESET_ITEMS: readonly ServerResetItem[] = [
  'app-settings',
  'mcp-configs',
  'marketplaces',
  'snippets',
  'ui-state',
  'logs',
  'credentials',
  'sessions',
]

/** Items in the isolated danger zone — default unchecked, require two-step confirm. */
export const DANGER_ITEMS: readonly ServerResetItem[] = ['credentials', 'sessions']

/** Per-item result in the reset response. */
export type ItemOutcome = { ok: true } | { ok: false; error: string }

export interface ResetResponse {
  results: Partial<Record<ServerResetItem, ItemOutcome>>
  /** Session ids whose metadata + live handles were removed (for client cache cleanup). */
  deletedSessionIds: string[]
}
