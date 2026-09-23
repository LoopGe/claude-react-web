import { useCallback, useState } from 'react'
import { api } from './useApi'
import { inputHistoryStore } from '../state/inputHistoryStore'
import { clearAllSessionStorage } from '../session-store/store'
import { sessionStoreRegistry } from '../session-store/registry'
import { DRAFT_KEY_PREFIX, SIDEBAR_WIDTH_KEY, SIDEBAR_MIN_KEY, SIDEBAR_MAX_KEY, PANEL_RATIOS_KEY, PANEL_MIN_RATIO_KEY, LAST_SEEN_TURN_KEY } from '../constants/storageKeys'
import { RECENT_MODELS_KEY, RECENT_CWDS_KEY } from '../constants/recentKeys'
import { THEME_KEY, SKIN_KEY } from '../utils/theme'
import { ACCENT_COLOR_KEY, SESSION_COLORS_KEY, RECENT_COLORS_KEY } from '../theme'
import { NAG_DISMISS_STORAGE_KEY } from './useUpdateNag'
import type { ServerResetItem, BrowserDataItem, ResetResponse } from '../../shared/reset'

/** Every appearance-related localStorage key, built from the SAME exported
 *  key constants their owners read/write — a new key must be added at its
 *  owner module, which keeps this list from silently drifting. */
const APPEARANCE_KEYS = [
  THEME_KEY, SKIN_KEY, ACCENT_COLOR_KEY, SESSION_COLORS_KEY, RECENT_COLORS_KEY,
  SIDEBAR_WIDTH_KEY, SIDEBAR_MIN_KEY, SIDEBAR_MAX_KEY,
  PANEL_RATIOS_KEY, PANEL_MIN_RATIO_KEY,
  RECENT_MODELS_KEY, RECENT_CWDS_KEY,
  NAG_DISMISS_STORAGE_KEY, LAST_SEEN_TURN_KEY,
]

function clearBrowserItem(item: BrowserDataItem): void {
  if (item === 'input-history') inputHistoryStore.clear()
  else if (item === 'drafts') {
    // Drafts live in SESSION storage (Chat.tsx writes DRAFT_KEY_PREFIX /
    // DRAFT_BODIES_KEY_PREFIX there), so the scan must too — scanning
    // localStorage (the pre-fix behaviour) silently cleared nothing.
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i)
      if (k && k.startsWith(DRAFT_KEY_PREFIX)) sessionStorage.removeItem(k)
    }
  } else if (item === 'appearance') {
    for (const k of APPEARANCE_KEYS) localStorage.removeItem(k)
  }
}

export interface ResetOpts {
  server: ServerResetItem[]
  browser: BrowserDataItem[]
}

export function useResetConfig() {
  const [clearing, setClearing] = useState(false)
  const reset = useCallback(async ({ server, browser }: ResetOpts): Promise<ResetResponse> => {
    setClearing(true)
    try {
      const res = await api.post<ResetResponse>('/config/reset', { items: server }, { timeoutMs: 0 })
      // Server cleared; now clear requested browser items.
      for (const b of browser) clearBrowserItem(b)
      // If sessions were reset, clear client session caches for the deleted ids.
      if (server.includes('sessions')) {
        clearAllSessionStorage()
        for (const id of res.deletedSessionIds) {
          try { await sessionStoreRegistry.delete(id) } catch { /* best-effort */ }
        }
      }
      return res
    } finally {
      setClearing(false)
    }
  }, [])
  return { reset, clearing }
}
