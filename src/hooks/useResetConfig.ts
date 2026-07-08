import { useCallback, useState } from 'react'
import { api } from './useApi'
import { inputHistoryStore } from '../state/inputHistoryStore'
import { clearAllSessionStorage } from '../session-store/store'
import { sessionStoreRegistry } from '../session-store/registry'
import type { ServerResetItem, BrowserDataItem, ResetResponse } from '../../shared/reset'

const DRAFT_PREFIX = 'claude-react-web:draft:'
const APPEARANCE_KEYS = [
  'claude-react-web:theme', 'claude-react-web:skin', 'claude-react-web:accent-color',
  'claude-react-web:session-colors', 'claude-react-web:recent-colors',
  'claude-react-web:sidebar-width', 'claude-react-web:sidebar-min-px', 'claude-react-web:sidebar-max-px',
  'claude-react-web:panel-col-ratios', 'claude-react-web:panel-min-ratio',
  'claude-react-web:recent-models', 'claude-react-web:recent-cwds',
  'claude-react-web:update-banner-dismissed-version', 'claude-react-web:last-seen-turn',
]

function clearBrowserItem(item: BrowserDataItem): void {
  if (item === 'input-history') inputHistoryStore.clear()
  else if (item === 'drafts') {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i)
      if (k && k.startsWith(DRAFT_PREFIX)) localStorage.removeItem(k)
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
