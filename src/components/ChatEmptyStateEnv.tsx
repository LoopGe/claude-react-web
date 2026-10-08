import { useEffect, useState } from 'react'
import { api } from '../hooks/useApi'
import type { ApiError } from '../transport/types'
import { useToast, apiErrorToastOpts } from '../hooks/useToast'
import { useMcpStatusLite } from '../hooks/useMcpStatusLite'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'

// Environment section of the default chat empty state: the MCP servers and
// plugins THIS session was spawned with, as small muted chips under the
// "Start a conversation" subtitle. Data comes straight off the session
// snapshot (SessionInfo.mcpServerNames / SessionInfo.enabledPlugins) — both
// persist and survive restarts, so dormant sessions show the same picture.
//
// Plugin semantics mirror the spawn contract:
//   - `undefined` = "all enabled" — only resolvable against the global
//     enabled list (/mp/enabled-plugins), so the row defers until it lands
//     and stays hidden if the lookup fails;
//   - `[]` = deliberately none — row hidden, lookup skipped;
//   - explicit keys render immediately (raw `key@marketplace` form), then
//     swap to friendly names once the lookup lands; keys missing from the
//     global list (marketplace removed since spawn) keep the raw form.
// The component renders null when neither row has anything to show, so
// legacy sessions (fields undefined, nothing resolvable) look exactly like
// the plain empty state.
//
// MCP names are the host-injected spawn set only — CLI-discovered servers
// (user/project scope) never travel in this field, so the row honestly
// represents what this app injected rather than everything the CLI sees.
//
// Freshness is row-asymmetric by design (static tier): the MCP row tracks
// the live session snapshot (dynamic setMcpServers updates mcpServerNames),
// while the plugin lookup is a one-shot per mount — the global plugin list
// is not observable from here, and the spawn-time plugin set is a historical
// fact anyway. The SettingsPanel MCP/plugins tabs stay the live authority.
//
// Quick actions (live tier): when the session is RUNNING, MCP chips render
// as buttons with a live status dot (useMcpStatusLite — silent degrade) and
// a click opens a small ContextMenu with Enable/Disable + Reconnect, the
// same endpoints the SettingsPanel MCP tab posts to. Plugin chips stay
// display-only in every state: the marketplace toggle is GLOBAL (it ripples
// to every session), which a per-session surface must not imply. Dormant /
// terminated sessions and callers without a sessionId render display-only
// spans — the server-side toggle/reconnect routes require a live Query.

interface EnabledPluginEntry {
  key: string
  name: string
  marketplace: string
}

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
}

export function ChatEmptyStateEnv({ mcpServerNames, enabledPlugins, sessionId, running }: ChatEmptyStateEnvProps) {
  const [globalPlugins, setGlobalPlugins] = useState<EnabledPluginEntry[] | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; name: string } | null>(null)
  const toast = useToast()
  const actionable = !!sessionId && running === true
  const { statuses, loading, refresh } = useMcpStatusLite(sessionId, actionable)

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

  if (!showMcp && !pluginChips) return null

  return (
    <div className="chat-empty-env">
      {showMcp && (
        <div className="chat-empty-env-row">
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
      )}
      {pluginChips && (
        <div className="chat-empty-env-row">
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
      )}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.name)} onClose={() => setMenu(null)} />
      )}
    </div>
  )
}
