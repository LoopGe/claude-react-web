import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from './useApi'
import type { McpServerStatus } from '../types'

/**
 * MCP Apps (SEP-1865) client plumbing — the READ-ONLY half.
 *
 * The discovery surface is the session's existing `GET /sessions/:id/mcp-status`
 * proxy: the SDK's `McpServerStatus.tools[]` already carries each tool's
 * `_meta` (with `ui.resourceUri`), verified by the 2026-10 spike
 * (/tmp/mcpapps-spike — throwaway). This hook folds that response into a
 * lookup keyed by the FULL tool_use name the CLI assigns MCP tools
 * (`mcp__<server>__<tool>`) — exact-string lookup, no un-parsing, so server
 * or tool names containing `__` stay unambiguous.
 *
 * Rendering is the McpAppFrame component: the HTML arrives through
 * `GET /sessions/:id/mcp-app-resource` and goes into an iframe sandboxed
 * WITHOUT allow-same-origin. The UI↔session postMessage loop
 * (`ui_surface_v1`) is deliberately NOT implemented here — the sandbox has
 * no channel back to this app, which is what makes the read-only step safe.
 */

/** Narrow a tool's `_meta` to the MCP Apps UI resource URI, honoring both
 *  the structured `ui.resourceUri` and the deprecated flat `ui/resourceUri`
 *  key (the CLI emits both; the SDK validates and size-bounds the payload). */
export function extractMcpAppResourceUri(meta: Record<string, unknown> | undefined): string | undefined {
  if (!meta || typeof meta !== 'object') return undefined
  const ui = meta.ui
  if (typeof ui === 'object' && ui !== null) {
    const uri = (ui as { resourceUri?: unknown }).resourceUri
    if (typeof uri === 'string' && uri.startsWith('ui://')) return uri
  }
  const flat = meta['ui/resourceUri']
  if (typeof flat === 'string' && flat.startsWith('ui://')) return flat
  return undefined
}

/** One MCP Apps tool the session exposes. `server` rides along so renderers
 *  never re-parse the `mcp__<server>__<tool>` name (a server name containing
 *  `__` would make that ambiguous). */
export interface McpAppTool {
  server: string
  uri: string
}

/** tool_use block name → app descriptor, for every MCP Apps tool the
 *  session's connected servers expose. Empty when the status read failed or
 *  no server declares a UI. */
function buildAppUriMap(statuses: McpServerStatus[] | undefined): Map<string, McpAppTool> {
  const map = new Map<string, McpAppTool>()
  for (const s of statuses ?? []) {
    for (const t of s.tools ?? []) {
      const uri = extractMcpAppResourceUri(t._meta)
      if (uri) map.set(`mcp__${s.name}__${t.name}`, { server: s.name, uri })
    }
  }
  return map
}

export interface McpApps {
  /** Session the status was read from — McpAppFrame reads the resource
   *  through the same session's route. */
  readonly sessionId: string
  /** `mcp__<server>__<tool>` → app descriptor. Empty until the status fetch
   *  lands. */
  readonly uris: ReadonlyMap<string, McpAppTool>
  /** Demand signal for one tool name: tool-card renderers call this when
   *  they hit an `mcp__…` name that isn't in the map yet. Keeps the control
   *  round-trip off sessions whose transcript never touches an MCP tool.
   *  Known limitation: a successful fetch is cached for the session's
   *  lifetime — an MCP server added mid-session (dynamic mcp/servers route)
   *  does not appear until the transcript remounts or the session
   *  switches. */
  readonly ensureFetched: (toolName: string) => void
}

const McpAppsContext = createContext<McpApps | null>(null)
export { McpAppsContext }

/** Failed status reads are retried by re-demand (see the fetch effect) up to
 *  this many times per session, so a dormant session costs 2 round-trips,
 *  not a storm. Reset on success / session switch. */
const MAX_FETCH_FAILURES = 2

export function useMcpApps(sessionId: string | undefined): McpApps {
  const [uris, setUris] = useState<ReadonlyMap<string, McpAppTool>>(() => new Map())
  // Bumped on every fetch settle (success or failure). Riding in the context
  // value, it re-runs the consumers' demand effects — that's the retry
  // trigger: a failed fetch re-demands the mounted mcp__ names until the
  // failure cap, without any polling.
  const [epoch, setEpoch] = useState(0)
  // sessionId = fetched-and-cached for that session; undefined = in flight;
  // null = not fetched / last fetch failed.
  const fetchedRef = useRef<string | undefined | null>(null)
  const failuresRef = useRef(0)
  // Names already demanded in the current cycle — dedupes concurrent
  // re-demands from many tool cards after a failure bumps the epoch.
  const attemptedRef = useRef<Set<string>>(new Set())
  // Monotonic fetch generation. Bumped at every dispatch; a settle handler
  // whose generation is stale (a slow failure landing after a newer
  // successful fetch — observed with the retry flow) is ignored wholesale,
  // so it can neither clobber the newer result nor re-trigger the retry
  // epoch.
  const genRef = useRef(0)

  const ensureFetched = useCallback((toolName: string) => {
    if (!sessionId) return
    if (uris.has(toolName)) return
    if (fetchedRef.current === sessionId) return // fetched; genuinely no app
    if (fetchedRef.current === undefined) return // in flight
    if (failuresRef.current >= MAX_FETCH_FAILURES) return
    if (attemptedRef.current.has(toolName)) return
    attemptedRef.current.add(toolName)
    const gen = ++genRef.current
    fetchedRef.current = undefined
    api
      .get<{ mcp: McpServerStatus[] }>(`/sessions/${sessionId}/mcp-status`)
      .then((r) => {
        if (gen !== genRef.current) return // stale — a newer fetch owns the state
        failuresRef.current = 0
        attemptedRef.current.clear()
        fetchedRef.current = sessionId
        setUris(buildAppUriMap(r.mcp))
      })
      .catch(() => {
        if (gen !== genRef.current) return // stale — ditto
        failuresRef.current++
        attemptedRef.current.clear()
        fetchedRef.current = null
        // Retry trigger: the epoch bump changes the context value identity,
        // re-running the consumers' demand effects.
        setEpoch((e) => e + 1)
      })
  }, [sessionId, uris])

  // Session identity change — unconditional full reset, in a LAYOUT effect:
  // React runs layout effects before passive effects, so the reset (and its
  // generation bump) always lands BEFORE the children's demand effects
  // dispatch the new session's fetch — a passive reset here would retire the
  // fetch it was meant to clear the way for. Retiring via the generation bump
  // handles BOTH stale settles: a slow fetch landing after the switch (it
  // would otherwise commit the wrong session's tool map) and the in-flight
  // marker itself (a fetchedRef stuck at `undefined` would block the new
  // session's fetches forever). Skipped on the first mount — there is no
  // prior session whose state could linger.
  const prevSessionRef = useRef<string | undefined>(sessionId)
  useLayoutEffect(() => {
    if (prevSessionRef.current === sessionId) return
    prevSessionRef.current = sessionId
    genRef.current++
    fetchedRef.current = null
    failuresRef.current = 0
    attemptedRef.current.clear()
    setUris((m) => (m.size > 0 ? new Map() : m))
  }, [sessionId])

  return useMemo(
    () => ({ sessionId: sessionId as string, uris, ensureFetched }),
    // `epoch` is deliberately unused in the value but listed as a dep: its
    // bump must produce a fresh context value so consumers re-demand.
    [sessionId, uris, ensureFetched, epoch],
  )
}

/** Provider for the transcript subtree. Renders children unchanged when
 *  sessionId is absent (subagent overlays etc. inherit the outer context). */
export function McpAppsProvider({ sessionId, children }: { sessionId: string | undefined; children: ReactNode }) {
  const apps = useMcpApps(sessionId)
  if (!sessionId) return <>{children}</>
  return <McpAppsContext.Provider value={apps}>{children}</McpAppsContext.Provider>
}

/** Lookup for tool-card renderers. Null outside a provider — callers treat
 *  that as "not an MCP Apps tool". An `mcp__…` miss also fires the lazy
 *  demand signal (idempotent; no-op once fetched for this session), so a
 *  session whose transcript never touches an MCP tool pays no control
 *  round-trip at all. */
export function useMcpAppTool(toolName: string): McpAppTool | undefined {
  const apps = useContext(McpAppsContext)
  const app = apps?.uris.get(toolName)
  const demanded = toolName.startsWith('mcp__')
  useEffect(() => {
    if (demanded) apps?.ensureFetched(toolName)
  }, [apps, demanded, app, toolName])
  return app
}
