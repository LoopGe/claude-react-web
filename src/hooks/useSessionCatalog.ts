// Session catalog — commands + agents fetched per session, with race-guarded
// initial fetch, manual refresh, and commands-changed WS updates.
//
// Extracts the two highly similar catalog-fetch blocks that were inlined in
// Chat.tsx into a single generic `useCatalogResource`, adding operation tokens
// so that late REST responses from a previous session, running state, or
// refresh can never overwrite the current visible list or cache.
//
// Design (see docs/superpowers/specs/2026-11-03-session-catalog-design.md):
// - Each resource owns a session-tagged React state:
//     { sessionId, running, token, cache: ReadonlyMap, items: T[] }
// - session/running drift is corrected via render-time state adjustment
//   (React's "storing previous render info" pattern) + a fresh token.
// - initial fetch fires only when running + cache miss; cache hit adopts.
// - refresh mints a new token, clears the current session cache, preserves
//   items, and fires a request only when running.
// - replaceFromFrame (commands WS) mints a new token, checks session only,
//   replaces cache+items, preserves running.
// - REST .then commits cache+items in ONE pure functional update guarded by
//   session + running(true) + token; failure is silent.
// - Effect deps exclude token/items/cache so refresh/WS don't re-trigger
//   an extra initial request.

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './useApi'
import { useWsHub } from './useWsHub'
import type { SlashCommand, AgentInfo } from '../types'

export interface SessionCatalog {
  commands: SlashCommand[]
  agents: AgentInfo[]
  refreshCommands: () => void
  refreshAgents: () => void
}

interface CatalogResourceState<T> {
  sessionId: string
  running: boolean
  token: symbol
  cache: ReadonlyMap<string, T[]>
  items: T[]
}

interface CatalogResourceConfig<T> {
  sessionId: string
  running: boolean
  path: 'commands' | 'agents'
  select: (response: unknown) => T[]
}

interface CatalogResource<T> {
  items: T[]
  refresh: () => void
  replaceFromFrame: (items: T[]) => void
}

function useCatalogResource<T>(cfg: CatalogResourceConfig<T>): CatalogResource<T> {
  // Stable select — captured once via useState's lazy initializer so inline
  // closures from the parent don't churn effect/callback identities. Unlike a
  // ref, this doesn't read a mutable value during render (react-hooks/refs).
  const [select] = useState(() => cfg.select)

  const [state, setState] = useState<CatalogResourceState<T>>(() => ({
    sessionId: cfg.sessionId,
    running: cfg.running,
    token: Symbol('init'),
    cache: new Map<string, T[]>(),
    items: [],
  }))

  // Render-time state adjustment: when props drift from state, queue an update
  // with a fresh token. session change → items from cache/[]; running-only
  // change → items preserved. cache is never cleared by a switch.
  // This is React's documented "adjust state during render" pattern — React
  // discards the current render and re-renders with the new state immediately,
  // so consumers never see a frame with mismatched props+state.
  if (state.sessionId !== cfg.sessionId || state.running !== cfg.running) {
    const token = Symbol('adjust')
    const nextSessionId = cfg.sessionId
    const nextRunning = cfg.running
    setState((prev) => {
      if (prev.sessionId === nextSessionId && prev.running === nextRunning) return prev
      const sessionChanged = prev.sessionId !== nextSessionId
      const items = sessionChanged
        ? (prev.cache.get(nextSessionId) ?? [])
        : prev.items
      return {
        sessionId: nextSessionId,
        running: nextRunning,
        token,
        cache: prev.cache,
        items,
      }
    })
  }

  // stateRef synced in an effect (never during render) so the initial-fetch
  // effect can read the latest state without adding state to its deps.
  // Declared BEFORE the fetch effect so it runs first on dep-change renders.
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])

  // Initial fetch: running + cache miss → request; cache hit → adopt cached.
  // Effect deps exclude token/items/cache so refresh/WS don't re-trigger it.
  useEffect(() => {
    const cur = stateRef.current
    if (cur.sessionId !== cfg.sessionId) return
    if (!cfg.running) return
    const cached = cur.cache.get(cfg.sessionId)
    if (cached) {
      setState((prev) =>
        prev.sessionId === cfg.sessionId && prev.running
          ? { ...prev, items: cached }
          : prev,
      )
      return
    }
    let cancelled = false
    const capturedSession = cfg.sessionId
    const capturedToken = cur.token
    api
      .get<unknown>(`/sessions/${cfg.sessionId}/${cfg.path}`)
      .then((res) => {
        if (cancelled) return
        const items = select(res)
        setState((prev) => {
          if (
            prev.sessionId !== capturedSession ||
            prev.running !== true ||
            prev.token !== capturedToken
          ) {
            return prev
          }
          const nextCache = new Map(prev.cache)
          nextCache.set(capturedSession, items)
          return { ...prev, cache: nextCache, items }
        })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [cfg.sessionId, cfg.running, cfg.path, select])

  // Refresh: new token, clear current session cache, preserve items.
  // Fire request only when running.
  const refresh = useCallback(() => {
    const capturedSession = cfg.sessionId
    const capturedRunning = cfg.running
    const token = Symbol('refresh')
    setState((prev) => {
      if (prev.sessionId !== capturedSession) return prev
      const nextCache = new Map(prev.cache)
      nextCache.delete(capturedSession)
      return { ...prev, token, cache: nextCache, items: prev.items }
    })
    if (!capturedRunning) return
    api
      .get<unknown>(`/sessions/${capturedSession}/${cfg.path}`)
      .then((res) => {
        const items = select(res)
        setState((prev) => {
          if (
            prev.sessionId !== capturedSession ||
            prev.running !== true ||
            prev.token !== token
          ) {
            return prev
          }
          const nextCache = new Map(prev.cache)
          nextCache.set(capturedSession, items)
          return { ...prev, cache: nextCache, items }
        })
      })
      .catch(() => {})
  }, [cfg.sessionId, cfg.running, cfg.path, select])

  // replaceFromFrame (commands WS): new token, check session only, replace
  // cache+items, preserve running. Does NOT check running so the authoritative
  // full-list event updates even when the session is non-running.
  const replaceFromFrame = useCallback(
    (items: T[]) => {
      const capturedSession = cfg.sessionId
      const token = Symbol('frame')
      setState((prev) => {
        if (prev.sessionId !== capturedSession) return prev
        const nextCache = new Map(prev.cache)
        nextCache.set(capturedSession, items)
        return { ...prev, token, cache: nextCache, items, running: prev.running }
      })
    },
    [cfg.sessionId],
  )

  return { items: state.items, refresh, replaceFromFrame }
}

export function useSessionCatalog(sessionId: string, running: boolean): SessionCatalog {
  const hub = useWsHub()

  const commands = useCatalogResource<SlashCommand>({
    sessionId,
    running,
    path: 'commands',
    select: (r) => (r as { commands?: SlashCommand[] }).commands ?? [],
  })

  const agents = useCatalogResource<AgentInfo>({
    sessionId,
    running,
    path: 'agents',
    select: (r) => (r as { agents?: AgentInfo[] }).agents ?? [],
  })

  // Only commands subscribes to WS; agents has no live event.
  // The listener is re-registered when sessionId changes (replaceFromFrame
  // identity changes on session switch), tearing down the old session's
  // listener so stale frames can't reach the new session.
  const { items: commandItems, refresh: refreshCommands, replaceFromFrame: replaceCommandsFromFrame } = commands
  const { items: agentItems, refresh: refreshAgents } = agents
  useEffect(() => {
    return hub.addSessionListener(sessionId, (frame) => {
      if (typeof frame !== 'object' || frame === null) return
      const k = (frame as { kind?: string }).kind
      if (k !== 'commands-changed') return
      const next = (frame as { commands?: SlashCommand[] }).commands ?? []
      replaceCommandsFromFrame(next)
    })
  }, [hub, sessionId, replaceCommandsFromFrame])

  return {
    commands: commandItems,
    agents: agentItems,
    refreshCommands,
    refreshAgents,
  }
}
