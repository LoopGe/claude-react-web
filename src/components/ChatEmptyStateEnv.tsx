import { useEffect, useState } from 'react'
import { api } from '../hooks/useApi'
import type { ApiError } from '../transport/types'
import { useToast, apiErrorToastOpts } from '../hooks/useToast'
import { useMcpStatusLite } from '../hooks/useMcpStatusLite'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import type { FirstPartyToolStatus } from '../../shared/first-party'

// Environment section of the default chat empty state: the MCP servers,
// built-in tools and plugins associated with THIS session, as small muted
// chips under the "Start a conversation" subtitle. MCP/plugin data comes
// straight off the session snapshot (SessionInfo.mcpServerNames /
// SessionInfo.enabledPlugins) — both persist and survive restarts, so dormant
// sessions show the same picture. Active built-ins come from the session's
// /tools endpoint, keeping only injected servers without a registration error.
//
// Plugin semantics mirror the spawn contract:
//   - `undefined` = "all enabled" — only resolvable against the global
//     enabled list (/mp/enabled-plugins), so the row defers until it lands
//     and stays hidden if the lookup fails;
//   - `[]` = deliberately none — row hidden, lookup skipped;
//   - explicit keys render immediately (raw `key@marketplace` form), then
//     swap to friendly names once the lookup lands; keys missing from the
//     global list (marketplace removed since spawn) keep the raw form.
// The component renders null when no row has anything to show, so callers
// without MCP/plugins or resolvable built-ins keep the plain empty state.
//
// MCP names are the host-injected spawn set only — CLI-discovered servers
// (user/project scope) never travel in this field, so the row honestly
// represents what this app injected rather than everything the CLI sees.
//
// Freshness is row-asymmetric by design: the MCP row tracks the live session
// snapshot (dynamic setMcpServers updates mcpServerNames), built-ins re-read
// when the server stamps a new injection revision, and the plugin lookup is a
// one-shot per mount — the global plugin list is not observable from here, and
// the spawn-time plugin set is a historical fact anyway. SettingsPanel remains
// the live authority for changing these sets.
//
// Quick actions (live tier): when the session is RUNNING, MCP chips render
// as buttons with a live status dot (useMcpStatusLite — silent degrade) and
// a click opens a small ContextMenu with Enable/Disable + Reconnect, the
// same endpoints the SettingsPanel MCP tab posts to. Plugin chips stay
// display-only because their marketplace toggle is GLOBAL (it ripples to
// every session), which a per-session surface must not imply. Built-in chips
// are display-only too: their enablement and lifecycle differ from external
// MCP servers, so SettingsPanel stays their control surface. Dormant /
// terminated sessions and callers without a sessionId render display-only
// spans — the server-side MCP toggle/reconnect routes require a live Query.

interface EnabledPluginEntry {
  key: string
  name: string
  marketplace: string
}

type BuiltInToolStatus = Pick<FirstPartyToolStatus, 'name' | 'description' | 'injected' | 'error'>

interface ChatEmptyStateEnvProps {
  /** Names of MCP servers the session was spawned with. Undefined (legacy)
   *  or empty → row hidden. */
  mcpServerNames?: string[]
  /** Compound keys (`<plugin>@<marketplace>`) of the plugin subset this
   *  session spawned with. Undefined = all enabled; [] = none. */
  enabledPlugins?: string[]
  /** Owning session id — enables the quick-action menu on MCP chips.
   *  Undefined → display-only chips (Side Chat / overlays without a live
   *  session scope). */
  sessionId?: string
  /** Whether the session's Query is running. Quick actions require a live
   *  subprocess (the server routes 410 otherwise); false → display-only. */
  running?: boolean
  /** Server-stamped first-party injection revision. Changes invalidate the
   *  current chips and trigger a fresh status read. */
  firstPartyRevision?: string
}

export function ChatEmptyStateEnv({ mcpServerNames, enabledPlugins, sessionId, running, firstPartyRevision }: ChatEmptyStateEnvProps) {
  const [globalPlugins, setGlobalPlugins] = useState<EnabledPluginEntry[] | null>(null)
  const [builtInResult, setBuiltInResult] = useState<{ sessionId: string; revision?: string; tools: BuiltInToolStatus[] } | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; name: string } | null>(null)
  const toast = useToast()
  const actionable = !!sessionId && running === true
  const { statuses, loading, refresh } = useMcpStatusLite(sessionId, actionable)
  // A session or server-stamped injection revision invalidates the previous
  // result during render, without a synchronous state reset in the effect.
  const builtInTools = sessionId
    && builtInResult?.sessionId === sessionId
    && builtInResult.revision === firstPartyRevision
    ? builtInResult.tools
    : []

  useEffect(() => {
    if (!sessionId) return
    const ac = new AbortController()
    let cancelled = false
    api
      .get<{ tools: BuiltInToolStatus[] }>(`/sessions/${sessionId}/tools?summary=1`, { signal: ac.signal })
      .then((r) => {
        if (!cancelled) {
          setBuiltInResult({
            sessionId,
            revision: firstPartyRevision,
            tools: r.tools
              .filter((tool) => tool.injected && tool.error === undefined)
              .map((tool) => ({ name: tool.name, description: tool.description, injected: tool.injected })),
          })
        }
      })
      // Keep MCP and plugins usable when built-in metadata is unavailable,
      // but surface the failure; only cancellation is silent.
      .catch((err) => {
        if (cancelled) return
        const e = err as ApiError
        toast.error(`Couldn't load built-in tools: ${e.message}`, apiErrorToastOpts(e))
      })
    return () => {
      cancelled = true
      ac.abort()
    }
  }, [sessionId, firstPartyRevision, toast])

  // An explicit [] hides the plugins row regardless, so the global lookup
  // has nothing to add and is skipped. Boolean (not array identity) so the
  // effect doesn't re-fire on every session snapshot re-parsing the array.
  const lookupMatters = enabledPlugins === undefined || enabledPlugins.length > 0

  useEffect(() => {
    if (!lookupMatters) return
    const ac = new AbortController()
    api
      .get<{ plugins: EnabledPluginEntry[] }>('/mp/enabled-plugins', { signal: ac.signal })
      .then((r) => setGlobalPlugins(r.plugins))
      // No enrichment is not an error state: undefined defers to hidden,
      // explicit subsets keep their raw keys.
      .catch(() => {})
    return () => {
      ac.abort()
    }
  }, [lookupMatters])

  const showMcp = !!mcpServerNames && mcpServerNames.length > 0

  const toggleMcp = async (name: string, enabled: boolean) => {
    try {
      await api.post(`/sessions/${sessionId}/mcp/${encodeURIComponent(name)}/toggle`, { enabled })
      // The toggle route mutates only the SDK-side state — the dot comes
      // from mcp-status, so it needs an explicit re-read.
      refresh()
    } catch (err) {
      const e = err as ApiError
      toast.error(`Couldn't ${enabled ? 'enable' : 'disable'} MCP server "${name}": ${e.message}`, apiErrorToastOpts(e))
    }
  }

  const reconnectMcp = async (name: string) => {
    try {
      await api.post(`/sessions/${sessionId}/mcp/${encodeURIComponent(name)}/reconnect`)
      refresh()
    } catch (err) {
      const e = err as ApiError
      toast.error(`Couldn't reconnect MCP server "${name}": ${e.message}`, apiErrorToastOpts(e))
    }
  }

  const menuItems = (name: string): ContextMenuItem[] => {
    // The posted `enabled` is the NEW state: a currently-disabled server
    // enables (true), a live one disables (false).
    const status = statuses[name]
    return [
      // Known state → only the applicable action. Unknown (the status lookup
      // silently degraded, or the server is missing from its response) →
      // both, so Enable stays reachable for a server disabled earlier —
      // guessing "Disable" here would post a silent no-op for exactly the
      // server the user most likely came to fix.
      ...(status !== undefined
        ? [{
            label: status === 'disabled' ? 'Enable' : 'Disable',
            onClick: () => void toggleMcp(name, status === 'disabled'),
          }]
        : [
            { label: 'Enable', onClick: () => void toggleMcp(name, true) },
            { label: 'Disable', onClick: () => void toggleMcp(name, false) },
          ]),
      { label: 'Reconnect', onClick: () => void reconnectMcp(name) },
    ]
  }

  const pluginChips: Array<{ key: string; label: string }> | null = (() => {
    if (enabledPlugins === undefined) {
      if (!globalPlugins || globalPlugins.length === 0) return null
      return globalPlugins.map((p) => ({ key: p.key, label: p.name }))
    }
    if (enabledPlugins.length === 0) return null
    const names = globalPlugins ? new Map(globalPlugins.map((p) => [p.key, p.name])) : null
    return enabledPlugins.map((key) => ({ key, label: names?.get(key) ?? key }))
  })()

  if (!showMcp && !pluginChips && builtInTools.length === 0) return null

  return (
    <div className="chat-empty-env">
      {showMcp && (
        <div className="chat-empty-env-row">
          {/* Inner wrapper: the row itself is the 0fr→1fr grid shell that
              grows the height in (env-row-grow), so the flex layout it
              animates must live one level down — grid would stack the label
              and the chips as separate tracks. See .chat-empty-env-row in
              chat.css. */}
          <div className="chat-empty-env-row-inner">
            <span className="chat-empty-env-label">MCP</span>
            <span className="chat-empty-env-chips">
              {mcpServerNames!.map((name) => {
                const status = actionable ? statuses[name] : undefined
                const chip = (
                  <>
                    {/* In-flight lookup → pulsing placeholder (data-status
                        "loading", CSS drives the pulse); once it lands the real
                        status color takes over. */}
                    {(status || (actionable && loading)) && (
                      <span
                        className="chat-empty-env-dot"
                        data-status={status ?? 'loading'}
                        aria-hidden
                      />
                    )}
                    <span className="chat-empty-env-chip-label">{name}</span>
                  </>
                )
                return actionable ? (
                  <button
                    key={name}
                    type="button"
                    className="chat-empty-env-chip"
                    title={`${name} — click for quick actions`}
                    onClick={(e) => {
                      // The one-shot status snapshot can be stale (the server
                      // may have been toggled from the SettingsPanel while this
                      // empty state sat mounted) — re-read on open so the menu
                      // offers the action the CURRENT state calls for.
                      refresh()
                      setMenu({ x: e.clientX, y: e.clientY, name })
                    }}
                  >
                    {chip}
                  </button>
                ) : (
                  <span key={name} className="chat-empty-env-chip">
                    {chip}
                  </span>
                )
              })}
            </span>
          </div>
        </div>
      )}
      {builtInTools.length > 0 && (
        <div className="chat-empty-env-row">
          <div className="chat-empty-env-row-inner">
            <span className="chat-empty-env-label">Built-in</span>
            <span className="chat-empty-env-chips">
              {builtInTools.map((tool) => (
                <span key={tool.name} className="chat-empty-env-chip" title={tool.description}>
                  {tool.name}
                </span>
              ))}
            </span>
          </div>
        </div>
      )}
      {pluginChips && (
        <div className="chat-empty-env-row">
          <div className="chat-empty-env-row-inner">
            <span className="chat-empty-env-label">Plugins</span>
            <span className="chat-empty-env-chips">
              {pluginChips.map((c) => (
                // title carries the compound key so ambiguous names stay
                // disambiguatable on hover without spending layout space
                <span key={c.key} className="chat-empty-env-chip" title={c.key}>
                  {c.label}
                </span>
              ))}
            </span>
          </div>
        </div>
      )}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.name)} onClose={() => setMenu(null)} />
      )}
    </div>
  )
}
