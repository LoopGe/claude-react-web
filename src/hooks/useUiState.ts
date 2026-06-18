// Server-synced UI state hook: session groups, sidebar order, collapsed groups.
//
// Replaces the three independent useLocalStorage calls for these keys.
// Loads from the backend on mount, debounces writes back on every mutation.
// One-time migration from localStorage on first load (same pattern as
// useComposerSnippets).
//
// The returned setters accept functional updaters `(prev => next)` just
// like useLocalStorage, so callers don't need to change their code.

import { useCallback, useEffect, useRef, useState } from 'react'
import { apiRequest } from './useApi.js'
import type { SessionGroup } from '../types.js'

// Legacy localStorage keys — read for migration, then cleared.
const LEGACY_KEYS = {
  groups: 'claude-react-web:session-groups',
  order: 'claude-react-web:session-order',
  collapsed: 'claude-react-web:collapsed-groups',
} as const

interface UiState {
  groups: SessionGroup[]
  sidebarOrder: string[]
  collapsedGroups: Record<string, boolean>
}

const EMPTY: UiState = { groups: [], sidebarOrder: [], collapsedGroups: {} }

function readLegacy(): UiState | null {
  if (typeof window === 'undefined') return null
  let hasData = false
  const result: UiState = { groups: [], sidebarOrder: [], collapsedGroups: {} }
  try {
    const g = window.localStorage.getItem(LEGACY_KEYS.groups)
    if (g) {
      const parsed = JSON.parse(g)
      if (Array.isArray(parsed) && parsed.length > 0) {
        result.groups = parsed
        hasData = true
      }
    }
  } catch { /* ignore */ }
  try {
    const o = window.localStorage.getItem(LEGACY_KEYS.order)
    if (o) {
      const parsed = JSON.parse(o)
      if (Array.isArray(parsed) && parsed.length > 0) {
        result.sidebarOrder = parsed
        hasData = true
      }
    }
  } catch { /* ignore */ }
  try {
    const c = window.localStorage.getItem(LEGACY_KEYS.collapsed)
    if (c) {
      const parsed = JSON.parse(c)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length > 0) {
        result.collapsedGroups = parsed
        hasData = true
      }
    }
  } catch { /* ignore */ }
  return hasData ? result : null
}

function clearLegacy(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(LEGACY_KEYS.groups)
    window.localStorage.removeItem(LEGACY_KEYS.order)
    window.localStorage.removeItem(LEGACY_KEYS.collapsed)
  } catch { /* ignore */ }
}

export function useUiState(): {
  groups: SessionGroup[]
  setGroups: (fn: (prev: SessionGroup[]) => SessionGroup[]) => void
  sidebarOrder: string[]
  setSidebarOrder: (fn: (prev: string[]) => string[]) => void
  collapsedGroups: Record<string, boolean>
  setCollapsedGroups: (fn: (prev: Record<string, boolean>) => Record<string, boolean>) => void
  loading: boolean
} {
  const [state, setState] = useState<UiState>(EMPTY)
  const [loading, setLoading] = useState(true)
  const stateRef = useRef(state)
  stateRef.current = state

  // Debounced flush to server
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flushTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      // Snapshot the latest state at flush time
      const snapshot = stateRef.current
      void apiRequest('/ui-state', {
        method: 'PUT',
        body: JSON.stringify(snapshot),
      }).catch((err) => {
        console.warn('[useUiState] sync failed:', (err as Error).message)
      })
    }, 500)
  }, [])

  // Load from server on mount, with one-time localStorage migration.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await apiRequest<{ uiState: UiState }>('/ui-state')
        if (cancelled) return
        const serverState = res.uiState
        const isEmpty = serverState.groups.length === 0
          && serverState.sidebarOrder.length === 0
          && Object.keys(serverState.collapsedGroups).length === 0

        if (isEmpty) {
          // Server has no data — try migrating from localStorage
          const legacy = readLegacy()
          if (legacy) {
            try {
              await apiRequest<{ applied: boolean }>('/ui-state/import', {
                method: 'POST',
                body: JSON.stringify(legacy),
              })
              // Only clear localStorage after successful import
              clearLegacy()
              // Re-read from server to get the canonical state
              const fresh = await apiRequest<{ uiState: UiState }>('/ui-state')
              if (!cancelled) setState(fresh.uiState)
            } catch {
              // Import failed — use legacy data locally so it's not lost
              if (!cancelled) setState(legacy)
            }
          }
          // else: truly empty, nothing to migrate
        } else {
          setState(serverState)
          // Server has data — clear any leftover localStorage
          clearLegacy()
        }
      } catch {
        // Server unreachable — try localStorage as fallback
        const legacy = readLegacy()
        if (legacy && !cancelled) setState(legacy)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const setGroups = useCallback((fn: (prev: SessionGroup[]) => SessionGroup[]) => {
    setState((prev) => {
      const next = fn(prev.groups)
      // Avoid no-op updates
      if (next === prev.groups) return prev
      const updated = { ...prev, groups: next }
      // Schedule flush with the ref so the timer closure sees the latest
      stateRef.current = updated
      flushTimer()
      return updated
    })
  }, [flushTimer])

  const setSidebarOrder = useCallback((fn: (prev: string[]) => string[]) => {
    setState((prev) => {
      const next = fn(prev.sidebarOrder)
      if (next === prev.sidebarOrder) return prev
      const updated = { ...prev, sidebarOrder: next }
      stateRef.current = updated
      flushTimer()
      return updated
    })
  }, [flushTimer])

  const setCollapsedGroups = useCallback((fn: (prev: Record<string, boolean>) => Record<string, boolean>) => {
    setState((prev) => {
      const next = fn(prev.collapsedGroups)
      if (next === prev.collapsedGroups) return prev
      const updated = { ...prev, collapsedGroups: next }
      stateRef.current = updated
      flushTimer()
      return updated
    })
  }, [flushTimer])

  return {
    groups: state.groups,
    setGroups,
    sidebarOrder: state.sidebarOrder,
    setSidebarOrder,
    collapsedGroups: state.collapsedGroups,
    setCollapsedGroups,
    loading,
  }
}
