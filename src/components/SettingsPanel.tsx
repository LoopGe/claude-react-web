// Right-side settings drawer. Focuses on mid-session controls — options that
// can only be set at session creation are shown read-only at the top.

import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { api } from '../hooks/useApi'
import { useToast } from '../hooks/useToast'
import type { AgentInfo, McpServerConfigMeta, McpServerStatus, ModelInfo, PermissionMode, Plugin, SessionInfo, SlashCommand } from '../types'
import { PERMISSION_MODES } from '../types'
import { FlagSettingsEditor } from './FlagSettingsEditor'
import { ContextBar } from './ContextBar'
import { Skeleton } from './Skeleton'

// MarketplaceBrowser and McpInstaller are heavy modal-within-modal
// components opened only on user intent (Browse plugins / Add MCP).
// Lazy-load both so SettingsPanel itself stays thin.
const McpInstaller = lazy(() =>
  import('./McpInstaller').then((m) => ({ default: m.McpInstaller })),
)
const MarketplaceBrowser = lazy(() =>
  import('./MarketplaceBrowser').then((m) => ({ default: m.MarketplaceBrowser })),
)
import { formatTokens, formatJson } from '../utils/format'
import type { ContextUsage } from '../hooks/useChatStream'

interface Props {
  session: SessionInfo
  onClose: () => void
  onSessionUpdate: (s: SessionInfo) => void
  commands?: SlashCommand[]
  agents?: AgentInfo[]
  /** Live context-usage pushed over the WebSocket (the "lite" shape from
   *  session-pump.ts: totalTokens/maxTokens/rawMaxTokens/percentage/model).
   *  Enough to paint ContextBar immediately, with zero blocking SDK round-
   *  trip. The full breakdown (skills/agents/memoryFiles) is lazy-loaded
   *  only when the user expands the detail sections. */
  contextUsage?: ContextUsage | null
  onPluginsReloaded?: () => void
}

export const SettingsPanel = memo(function SettingsPanel({ session, onClose, onSessionUpdate, commands = [], agents = [], contextUsage, onPluginsReloaded }: Props) {
  const [models, setModels] = useState<ModelInfo[]>([])
  const [settingsText, setSettingsText] = useState('{}')
  // Full context-usage breakdown from the (blocking) REST endpoint. Null
  // until the user expands a detail section — see loadDetailedUsage().
  // ContextBar itself runs off the WS-pushed `contextUsage` prop and never
  // waits on this.
  const [detailedUsage, setDetailedUsage] = useState<ContextUsage | null>(null)
  const [loadingUsage, setLoadingUsage] = useState(false)
  // One-shot guard so re-opening a <details> doesn't re-fire the request.
  const usageFetchedRef = useRef(false)
  const [mcp, setMcp] = useState<McpServerStatus[]>([])
  const [globalMcpNames, setGlobalMcpNames] = useState<Set<string>>(new Set())
  const [showMcpInstaller, setShowMcpInstaller] = useState(false)
  const [mcpInstallerEdit, setMcpInstallerEdit] = useState<McpServerConfigMeta | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  // True until the initial models/MCP/usage fetch settles. Drives skeleton
  // placeholders so the lists don't flash "No MCP servers" before data lands.
  const [loadingMeta, setLoadingMeta] = useState(true)
  // All settings success/error feedback rides on the global toast hub.
  // The previous in-panel `err` state and the inline success banner have
  // been removed in favour of right-bottom toasts.
  const toast = useToast()
  const [reloadedPlugins, setReloadedPlugins] = useState<Plugin[]>([])
  const [showMarketplace, setShowMarketplace] = useState(false)

  // Load supported models and MCP status when the panel opens. Parent
  // remounts this component on session switch (via `key={session.id}`),
  // so there's no need to imperatively reset state here. All three calls
  // forward SDK control requests to the subprocess — if the session isn't
  // running the server returns 410; skip them rather than surface noise.
  //
  // We also fetch server-configured models from /api/config and merge
  // them in so that custom models (e.g. xiaomi/mimo-*) always appear
  // even if the SDK subprocess doesn't list them.
  useEffect(() => {
    if (!session.running) return
    const ac = new AbortController()
    ;(async () => {
      // Fetch server-configured models and SDK models in parallel.
      // SDK models merge depends on server config, so those two are
      // awaited together; the rest are independent fire-and-forget.
      //
      // NOTE: /context-usage is intentionally NOT fetched here. It's a
      // blocking SDK control request that hangs the whole panel open while
      // the subprocess is mid-turn or the proxy init handshake stalls.
      // ContextBar runs off the WebSocket-pushed `contextUsage` prop
      // instead (zero round-trip); the full breakdown is lazy-loaded only
      // when a detail section is expanded — see loadDetailedUsage().
      const [cfgResult, modelsResult, mcpResult, gcResult] =
        await Promise.allSettled([
          api.get<{ models?: string[] }>('/config', { signal: ac.signal }),
          api.get<{ models: ModelInfo[] }>(
            `/sessions/${session.id}/models`,
            { signal: ac.signal },
          ),
          api.get<{ mcp: McpServerStatus[] }>(
            `/sessions/${session.id}/mcp-status`,
            { signal: ac.signal },
          ),
          api.get<{ servers: McpServerConfigMeta[] }>(
            '/mcp-config',
            { signal: ac.signal },
          ),
        ])

      if (ac.signal.aborted) return

      // Models: merge SDK models with server-configured ones.
      // The SDK→wire translation in /sessions/:id/models already filters
      // entries with no id, so we don't need to defend against empties
      // here.
      const serverModelIds =
        cfgResult.status === 'fulfilled' ? (cfgResult.value.models ?? []) : []
      if (modelsResult.status === 'fulfilled') {
        const sdkIds = new Set(modelsResult.value.models.map((x) => x.id))
        const merged = [
          ...modelsResult.value.models,
          ...serverModelIds
            .filter((id) => !sdkIds.has(id))
            .map((id): ModelInfo => ({ id })),
        ]
        setModels(merged)
      } else {
        // Supported models fails if SDK hasn't initialized yet — fall
        // back to server-configured models so the dropdown isn't empty.
        if ((modelsResult.reason as Error)?.name !== 'AbortError') {
          console.warn('could not load models:', (modelsResult.reason as Error)?.message)
          if (serverModelIds.length) {
            setModels(serverModelIds.map((id): ModelInfo => ({ id })))
          }
        }
      }

      if (mcpResult.status === 'fulfilled') {
        setMcp(mcpResult.value.mcp)
      }
      if (gcResult.status === 'fulfilled') {
        setGlobalMcpNames(new Set(gcResult.value.servers.map((s) => s.name)))
      }
      setLoadingMeta(false)
    })()
    return () => { ac.abort() }
  }, [session.id, session.running])

  // Lazy-load the full context-usage breakdown (skills / agents /
  // memoryFiles / mcpTools). This is the BLOCKING SDK control request we
  // deliberately keep off the panel-open path; it only fires when the user
  // actually expands a detail section. Fetched once per panel mount.
  const loadDetailedUsage = useCallback(() => {
    if (usageFetchedRef.current || !session.running) return
    usageFetchedRef.current = true
    setLoadingUsage(true)
    api
      .get<{ usage: unknown }>(`/sessions/${session.id}/context-usage`)
      .then((r) => setDetailedUsage(r.usage as ContextUsage))
      .catch(() => { usageFetchedRef.current = false /* allow retry */ })
      .finally(() => setLoadingUsage(false))
  }, [session.id, session.running])

  // Merge: WS-pushed lite usage paints the bar immediately; the detailed
  // REST payload (when loaded) supplies skills/agents/memoryFiles. The
  // detailed payload, once present, is the more complete object, so prefer
  // it for the bar fields too.
  const usage: ContextUsage | null = detailedUsage ?? contextUsage ?? null

  const runAndRefresh = async (fn: () => Promise<{ session: SessionInfo }>) => {
    setBusy(true)
    try {
      const r = await fn()
      onSessionUpdate(r.session)
      toast.success('Settings applied')
    } catch (e) {
      toast.error(`Couldn't apply settings: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const changeModel = (model: string) =>
    runAndRefresh(() => api.post<{ session: SessionInfo }>(`/sessions/${session.id}/model`, { model: model || undefined }))

  const changePermissionMode = (mode: PermissionMode) =>
    runAndRefresh(() => api.post<{ session: SessionInfo }>(`/sessions/${session.id}/permission-mode`, { mode }))

  const applySettings = async () => {
    let parsed: unknown
    try {
      parsed = JSON.parse(settingsText || '{}')
    } catch (e) {
      toast.error(`Invalid JSON: ${(e as Error).message}`)
      return
    }
    await runAndRefresh(() =>
      api.post<{ session: SessionInfo }>(`/sessions/${session.id}/settings`, { settings: parsed }),
    )
  }

  const refreshMcp = async () => {
    try {
      const r = await api.get<{ mcp: McpServerStatus[] }>(`/sessions/${session.id}/mcp-status`)
      setMcp(r.mcp)
    } catch { /* ignore */ }
  }

  const reconnectMcp = async (name: string) => {
    try {
      await api.post(`/sessions/${session.id}/mcp/${encodeURIComponent(name)}/reconnect`)
      await refreshMcp()
    } catch (e) {
      toast.error(`Couldn't reconnect MCP: ${(e as Error).message}`)
    }
  }

  const toggleMcp = async (name: string, enabled: boolean) => {
    try {
      await api.post(`/sessions/${session.id}/mcp/${encodeURIComponent(name)}/toggle`, { enabled })
      await refreshMcp()
    } catch (e) {
      toast.error(`Couldn't toggle MCP: ${(e as Error).message}`)
    }
  }

  const reloadPlugins = async () => {
    try {
      const res = await api.post<{ result: { plugins?: Plugin[] } }>(`/sessions/${session.id}/plugins/reload`)
      if (res.result?.plugins) setReloadedPlugins(res.result.plugins)
      await refreshMcp()
      onPluginsReloaded?.()
    } catch (e) {
      toast.error(`Couldn't reload plugins: ${(e as Error).message}`)
    }
  }

  const handleMcpInstallerSave = () => {
    setShowMcpInstaller(false)
    setMcpInstallerEdit(undefined)
    // Refresh both global names and MCP status
    api.get<{ servers: McpServerConfigMeta[] }>('/mcp-config')
      .then((r) => setGlobalMcpNames(new Set(r.servers.map((s) => s.name))))
      .catch(() => { /* ignore */ })
    void refreshMcp()
  }

  // Derive plugin groups from commands (split on first ':') + reload metadata.
  const pluginGroups = useMemo(() => {
    const groups = new Map<string, { plugin: Plugin | undefined; commands: SlashCommand[]; agents: AgentInfo[] }>()
    // Index reloaded plugins by name for path/source info
    const pluginMeta = new Map(reloadedPlugins.map((p) => [p.name, p]))
    for (const cmd of commands) {
      const colon = cmd.name.indexOf(':')
      const pluginName = colon > 0 ? cmd.name.slice(0, colon) : null
      const key = pluginName ?? '__builtin__'
      if (!groups.has(key)) groups.set(key, { plugin: pluginMeta.get(pluginName ?? ''), commands: [], agents: [] })
      groups.get(key)!.commands.push(cmd)
    }
    // Assign agents to their plugin namespace if they match a plugin name
    const pluginNames = new Set(reloadedPlugins.map((p) => p.name))
    for (const agent of agents) {
      const match = [...pluginNames].find((n) => agent.name.includes(n))
      const key = match ?? '__builtin__'
      if (!groups.has(key)) groups.set(key, { plugin: match ? pluginMeta.get(match) : undefined, commands: [], agents: [] })
      groups.get(key)!.agents.push(agent)
    }
    // Move built-in group to end
    const result = [...groups.entries()]
    const builtinIdx = result.findIndex(([k]) => k === '__builtin__')
    if (builtinIdx >= 0) {
      const [builtin] = result.splice(builtinIdx, 1)
      result.push(builtin)
    }
    return result
  }, [commands, agents, reloadedPlugins])

  return (
    <aside className="settings-panel" aria-label="Session settings">
      <div className="settings-panel-header">
        <h3>Session settings</h3>
        <button className="btn btn-sm" onClick={onClose}>
          Close
        </button>
      </div>

      {/* All settings feedback (success/error) flows through the global
          toast hub now (see ToastHost). The toast itself is the live
          region; screen readers pick up the role=alert from there. */}

      <div className="settings-section">
        <h4>Read-only (set at create)</h4>
        <ReadOnlyField label="Session ID" value={session.id} mono />
        <ReadOnlyField label="CWD" value={session.cwd ?? '—'} mono />
        <ReadOnlyField label="Title" value={session.title ?? '—'} />
        <ReadOnlyField label="Created" value={new Date(session.createdAt).toLocaleString()} />
      </div>

      <div className="settings-section">
        <h4>Live controls</h4>
        <div className="settings-field">
          <label>Model</label>
          <select
            className="select"
            value={session.model ?? ''}
            onChange={(e) => void changeModel(e.target.value)}
            disabled={busy || session.terminated}
          >
            <option value="">(default)</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {/* `||` not `??` — SDK has been observed to return
                 *  display_name as an empty string for some proxy
                 *  providers, which would render a blank label even
                 *  though the id is well-formed. */}
                {m.display_name || m.id}
              </option>
            ))}
          </select>
          <span className="hint">Changes apply to the next assistant turn.</span>
        </div>

        <div className="settings-field">
          <label>Permission mode</label>
          <select
            className="select"
            value={session.permissionMode ?? 'default'}
            onChange={(e) => void changePermissionMode(e.target.value as PermissionMode)}
            disabled={busy || session.terminated}
          >
            {PERMISSION_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <span className="hint">
            Enforced by the server's own <code>canUseTool</code> callback, so
            switches take effect on the very next tool call without needing
            to restart the session.
          </span>
        </div>

        <FlagSettingsEditor
          value={settingsText}
          onChange={setSettingsText}
          disabled={busy || session.terminated}
        />
        <button className="btn btn-primary settings-apply-btn" onClick={applySettings} disabled={busy || session.terminated}>
          Apply settings
        </button>
      </div>

      <div className="settings-section">
        <h4>Context usage</h4>
        {/* ContextBar runs off the WS-pushed lite usage — paints instantly,
            no blocking request. The detail disclosures below lazy-load the
            full breakdown (a blocking SDK control request) only when the
            user actually opens one. */}
        <ContextBar usage={usage} />
        {usage?.skills && (
          <details className="settings-detail">
            <summary>
              Skills: {usage.skills.includedSkills}/{usage.skills.totalSkills} loaded, {formatTokens(usage.skills.tokenCount)}
            </summary>
            <div className="settings-detail-body">
              {usage.skills.skillFrontmatter?.map((s) => (
                <div key={s.name} className="settings-kv-row">
                  <code>{s.name}</code>
                  <span className="settings-kv-source">{s.source}</span>
                  <span className="settings-kv-tokens">{formatTokens(s.tokens)}</span>
                </div>
              ))}
            </div>
          </details>
        )}
        {usage?.agents && (
          <details className="settings-detail settings-detail-tight">
            <summary>
              Agents: {usage.agents.agents?.length ?? 0}, {formatTokens(usage.agents.tokenCount)}
            </summary>
            <div className="settings-detail-body">
              {usage.agents.agents?.map((a, i) => (
                <div key={i} className="settings-kv-row">
                  <code>{a.agentType}</code>
                  <span className="settings-kv-source">{a.source}</span>
                  <span className="settings-kv-tokens">{formatTokens(a.tokens)}</span>
                </div>
              ))}
            </div>
          </details>
        )}
        {/* Always-present disclosure: opening it triggers the lazy fetch of
            the full breakdown. The skills/agents sections above light up
            once it resolves (they read from the same merged `usage`). */}
        <details
          className="settings-detail"
          onToggle={(e) => { if ((e.currentTarget as HTMLDetailsElement).open) loadDetailedUsage() }}
        >
          <summary>
            Detailed breakdown{!detailedUsage && loadingUsage ? ' (loading…)' : ''}
          </summary>
          <pre className="tool-input settings-raw-pre">
            {detailedUsage
              ? formatJson(detailedUsage)
              : loadingUsage
                ? 'Loading…'
                : usage
                  ? formatJson(usage)
                  : '—'}
          </pre>
        </details>
      </div>

      <div className="settings-section">
        <div className="settings-section-head">
          <h4>Plugins</h4>
          <button className="btn btn-sm" onClick={reloadPlugins} disabled={busy || session.terminated}>
            Reload plugins
          </button>
        </div>
        {pluginGroups.length === 0 && !commands.length && (
          <div className="settings-note">No plugins loaded</div>
        )}
        {pluginGroups.map(([key, group]) => (
          <PluginCard
            key={key}
            name={key === '__builtin__' ? 'Built-in' : key}
            plugin={group.plugin}
            commands={group.commands}
            agents={group.agents}
            sessionId={session.id}
            disabled={busy || session.terminated}
          />
        ))}
      </div>

      <div className="settings-section">
        <div className="settings-section-head">
          <h4>MCP servers</h4>
          <div className="settings-section-head-actions">
            <button
              className="btn btn-sm"
              onClick={() => { setMcpInstallerEdit(undefined); setShowMcpInstaller(true) }}
            >
              Manage
            </button>
          </div>
        </div>
        {loadingMeta && mcp.length === 0 && <Skeleton rows={2} />}
        {!loadingMeta && mcp.length === 0 && <div className="settings-empty-note">No MCP servers</div>}
        {mcp.map((srv) => (
          <McpServerCard
            key={srv.name}
            server={srv}
            isGlobal={globalMcpNames.has(srv.name)}
            onReconnect={reconnectMcp}
            onToggle={toggleMcp}
            disabled={busy || session.terminated}
          />
        ))}
      </div>

      <div className="settings-section">
        <div className="settings-section-head">
          <h4>Marketplace</h4>
          <button className="btn btn-sm" onClick={() => setShowMarketplace(true)}>
            Browse plugins
          </button>
        </div>
        <div className="settings-note">
          Browse and install plugins from registered marketplaces.
        </div>
      </div>

      {showMarketplace && (
        <Suspense fallback={null}>
          <MarketplaceBrowser
            onClose={() => setShowMarketplace(false)}
            onInstalled={() => { onPluginsReloaded?.() }}
          />
        </Suspense>
      )}

      {showMcpInstaller && (
        <Suspense fallback={null}>
          <McpInstaller
            server={mcpInstallerEdit}
            onSave={handleMcpInstallerSave}
            onClose={() => { setShowMcpInstaller(false); setMcpInstallerEdit(undefined) }}
          />
        </Suspense>
      )}
    </aside>
  )
})

function ReadOnlyField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="settings-field">
      <label>{label}</label>
      <div
        className={`settings-readonly-value${mono ? ' mono' : ''}`}
        title={value}
      >
        {value}
      </div>
    </div>
  )
}

function PluginCard({
  name,
  plugin,
  commands,
  agents,
  sessionId,
  disabled,
}: {
  name: string
  plugin?: Plugin
  commands: SlashCommand[]
  agents: AgentInfo[]
  sessionId?: string
  disabled?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  // The SDK doesn't expose enabled state, so we default to true and let the
  // user toggle. After a page refresh the toggle resets — acceptable since
  // the session-level override is ephemeral anyway.
  const [enabled, setEnabled] = useState(true)
  const [toggling, setToggling] = useState(false)

  const toggle = async () => {
    if (!sessionId || name === 'Built-in') return
    setToggling(true)
    try {
      await api.post(`/sessions/${sessionId}/plugins/${encodeURIComponent(name)}/toggle`, { enabled: !enabled })
      setEnabled(!enabled)
    } catch { /* ignore */ }
    setToggling(false)
  }

  const isBuiltin = name === 'Built-in'
  const dotColor = isBuiltin || enabled ? 'var(--plugin-active)' : 'var(--plugin-inactive)'

  return (
    <div className="settings-card">
      <div className="settings-card-head">
        <span className="settings-card-dot" style={{ '--dot': dotColor } as CSSProperties} />
        <span className="settings-card-name">{name}</span>
        {plugin?.source && (
          <span className="settings-card-badge">{plugin.source}</span>
        )}
        <span className="settings-card-meta">
          {commands.length} skill{commands.length !== 1 ? 's' : ''}
          {agents.length > 0 && `, ${agents.length} agent${agents.length !== 1 ? 's' : ''}`}
        </span>
        {!isBuiltin && sessionId && (
          <button
            className="btn btn-xs"
            onClick={toggle}
            disabled={disabled || toggling}
          >
            {enabled ? 'Disable' : 'Enable'}
          </button>
        )}
        {(commands.length > 0 || agents.length > 0) && (
          <button className="btn btn-xs" onClick={() => setExpanded(!expanded)}>
            {expanded ? '▲' : '▼'}
          </button>
        )}
      </div>
      {plugin?.path && (
        <div className="settings-card-path">{plugin.path}</div>
      )}
      {expanded && (
        <div className="settings-card-body">
          {commands.length > 0 && (
            <div className="settings-card-grouplabel">Skills</div>
          )}
          {commands.map((cmd) => (
            <div key={cmd.name} className="settings-card-item">
              <code>/{cmd.name}</code>
              <span className="settings-card-desc">{cmd.description}</span>
            </div>
          ))}
          {agents.length > 0 && (
            <div className="settings-card-grouplabel spaced">Agents</div>
          )}
          {agents.map((agent) => (
            <div key={agent.name} className="settings-card-item">
              <code>{agent.name}</code>
              <span className="settings-card-desc">{agent.description}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// Map MCP server status to existing semantic theme tokens. Keeps light/dark
// parity (CLAUDE.md forbids hardcoded hex in components — every colour must
// resolve via a CSS variable defined in both :root and [data-theme="light"]).
const STATUS_COLORS: Record<string, string> = {
  connected: 'var(--ok)',
  failed: 'var(--danger)',
  'needs-auth': 'var(--warn)',
  disabled: 'var(--fg-muted)',
  pending: 'var(--accent)',
}

function McpServerCard({
  server,
  isGlobal,
  onReconnect,
  onToggle,
  disabled,
}: {
  server: McpServerStatus
  isGlobal: boolean
  onReconnect: (name: string) => void
  onToggle: (name: string, enabled: boolean) => void
  disabled: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const color = STATUS_COLORS[server.status] ?? 'var(--fg-muted)'
  const canReconnect = server.status === 'failed' || server.status === 'disabled'
  const canDisable = server.status !== 'disabled'
  const canEnable = server.status === 'disabled'

  return (
    <div className="settings-card">
      <div className="settings-card-head">
        <span className="settings-card-dot" style={{ '--dot': color } as CSSProperties} />
        <span className="settings-card-name">
          {server.name}
          {isGlobal && (
            <span className="settings-card-badge global">global</span>
          )}
        </span>
        {server.tools && (
          <span className="settings-card-meta">{server.tools.length} tool{server.tools.length !== 1 ? 's' : ''}</span>
        )}
        {canReconnect && (
          <button className="btn btn-xs" onClick={() => onReconnect(server.name)} disabled={disabled}>
            Reconnect
          </button>
        )}
        {canDisable && (
          <button className="btn btn-xs" onClick={() => onToggle(server.name, false)} disabled={disabled}>
            Disable
          </button>
        )}
        {canEnable && (
          <button className="btn btn-xs" onClick={() => onToggle(server.name, true)} disabled={disabled}>
            Enable
          </button>
        )}
        {server.tools && server.tools.length > 0 && (
          <button className="btn btn-xs" onClick={() => setExpanded(!expanded)}>
            {expanded ? '▲' : '▼'}
          </button>
        )}
      </div>
      {server.error && (
        <div className="settings-card-error">{server.error}</div>
      )}
      {expanded && server.tools && (
        <div className="settings-card-body">
          {server.tools.map((t) => (
            <div key={t.name} className="settings-card-item">
              <code>{t.name}</code>
              {t.annotations?.readOnly && <span className="settings-tag readonly">read-only</span>}
              {t.annotations?.destructive && <span className="settings-tag destructive">destructive</span>}
              {t.annotations?.openWorld && <span className="settings-tag openworld">open-world</span>}
              {t.description && <span className="settings-card-desc">{t.description}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
