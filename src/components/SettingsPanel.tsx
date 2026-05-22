// Right-side settings drawer. Focuses on mid-session controls — options that
// can only be set at session creation are shown read-only at the top.

import { useEffect, useMemo, useState } from 'react'
import { api } from '../hooks/useApi'
import type { AgentInfo, McpServerConfigMeta, McpServerStatus, ModelInfo, PermissionMode, Plugin, SessionInfo, SlashCommand } from '../types'
import { PERMISSION_MODES } from '../types'
import { McpInstaller } from './McpInstaller'
import { FlagSettingsEditor } from './FlagSettingsEditor'
import { ContextBar } from './ContextBar'
import { MarketplaceBrowser } from './MarketplaceBrowser'
import { formatTokens, formatJson } from '../utils/format'
import type { ContextUsage } from '../hooks/useChatStream'

interface Props {
  session: SessionInfo
  onClose: () => void
  onSessionUpdate: (s: SessionInfo) => void
  commands?: SlashCommand[]
  agents?: AgentInfo[]
  onPluginsReloaded?: () => void
}

export function SettingsPanel({ session, onClose, onSessionUpdate, commands = [], agents = [], onPluginsReloaded }: Props) {
  const [models, setModels] = useState<ModelInfo[]>([])
  const [settingsText, setSettingsText] = useState('{}')
  const [usage, setUsage] = useState<ContextUsage | null>(null)
  const [mcp, setMcp] = useState<McpServerStatus[]>([])
  const [globalMcpNames, setGlobalMcpNames] = useState<Set<string>>(new Set())
  const [showMcpInstaller, setShowMcpInstaller] = useState(false)
  const [mcpInstallerEdit, setMcpInstallerEdit] = useState<McpServerConfigMeta | undefined>(undefined)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
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
      const [cfgResult, modelsResult, usageResult, mcpResult, gcResult] =
        await Promise.allSettled([
          api.get<{ models?: string[] }>('/config', { signal: ac.signal }),
          api.get<{ models: ModelInfo[] }>(
            `/sessions/${session.id}/models`,
            { signal: ac.signal },
          ),
          api.get<{ usage: unknown }>(
            `/sessions/${session.id}/context-usage`,
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

      if (usageResult.status === 'fulfilled') {
        setUsage(usageResult.value.usage as ContextUsage)
      }
      if (mcpResult.status === 'fulfilled') {
        setMcp(mcpResult.value.mcp)
      }
      if (gcResult.status === 'fulfilled') {
        setGlobalMcpNames(new Set(gcResult.value.servers.map((s) => s.name)))
      }
    })()
    return () => { ac.abort() }
  }, [session.id, session.running])

  const runAndRefresh = async (fn: () => Promise<{ session: SessionInfo }>) => {
    setBusy(true)
    setErr(null)
    try {
      const r = await fn()
      onSessionUpdate(r.session)
    } catch (e) {
      setErr((e as Error).message)
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
      setErr(`Invalid JSON: ${(e as Error).message}`)
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
    setErr(null)
    try {
      await api.post(`/sessions/${session.id}/mcp/${encodeURIComponent(name)}/reconnect`)
      await refreshMcp()
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  const toggleMcp = async (name: string, enabled: boolean) => {
    setErr(null)
    try {
      await api.post(`/sessions/${session.id}/mcp/${encodeURIComponent(name)}/toggle`, { enabled })
      await refreshMcp()
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  const reloadPlugins = async () => {
    setErr(null)
    try {
      const res = await api.post<{ result: { plugins?: Plugin[] } }>(`/sessions/${session.id}/plugins/reload`)
      if (res.result?.plugins) setReloadedPlugins(res.result.plugins)
      await refreshMcp()
      onPluginsReloaded?.()
    } catch (e) {
      setErr((e as Error).message)
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
    <aside className="settings-panel">
      <h3>
        Session settings
        <button className="btn btn-sm" onClick={onClose}>
          Close
        </button>
      </h3>

      {err && <div className="error-bar">{err}</div>}

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
                {m.display_name ?? m.id}
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
        <button className="btn btn-primary" onClick={applySettings} disabled={busy || session.terminated} style={{ alignSelf: 'flex-start' }}>
          Apply settings
        </button>
      </div>

      <div className="settings-section">
        <h4>Context usage</h4>
        <ContextBar usage={usage} />
        {usage?.skills && (
          <details style={{ marginTop: 6 }}>
            <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--fg-muted)' }}>
              Skills: {usage.skills.includedSkills}/{usage.skills.totalSkills} loaded, {formatTokens(usage.skills.tokenCount)}
            </summary>
            <div style={{ marginTop: 4 }}>
              {usage.skills.skillFrontmatter?.map((s) => (
                <div key={s.name} style={{ fontSize: 12, padding: '2px 0', display: 'flex', gap: 6 }}>
                  <code style={{ fontWeight: 500 }}>{s.name}</code>
                  <span style={{ color: 'var(--fg-muted)', fontSize: 11 }}>{s.source}</span>
                  <span style={{ marginLeft: 'auto', color: 'var(--fg-muted)', fontSize: 11 }}>{formatTokens(s.tokens)}</span>
                </div>
              ))}
            </div>
          </details>
        )}
        {usage?.agents && (
          <details style={{ marginTop: 4 }}>
            <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--fg-muted)' }}>
              Agents: {usage.agents.agents?.length ?? 0}, {formatTokens(usage.agents.tokenCount)}
            </summary>
            <div style={{ marginTop: 4 }}>
              {usage.agents.agents?.map((a, i) => (
                <div key={i} style={{ fontSize: 12, padding: '2px 0', display: 'flex', gap: 6 }}>
                  <code style={{ fontWeight: 500 }}>{a.agentType}</code>
                  <span style={{ color: 'var(--fg-muted)', fontSize: 11 }}>{a.source}</span>
                  <span style={{ marginLeft: 'auto', color: 'var(--fg-muted)', fontSize: 11 }}>{formatTokens(a.tokens)}</span>
                </div>
              ))}
            </div>
          </details>
        )}
        <details style={{ marginTop: 6 }}>
          <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--fg-muted)' }}>Raw data</summary>
          <pre className="tool-input" style={{ maxHeight: 200, overflow: 'auto', marginTop: 6 }}>
            {usage ? formatJson(usage) : '—'}
          </pre>
        </details>
      </div>

      <div className="settings-section">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h4 style={{ margin: 0 }}>Plugins</h4>
          <button className="btn btn-sm" onClick={reloadPlugins} disabled={busy || session.terminated}>
            Reload plugins
          </button>
        </div>
        {pluginGroups.length === 0 && !commands.length && (
          <div style={{ color: 'var(--fg-muted)', fontSize: 13, marginTop: 6 }}>No plugins loaded</div>
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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h4 style={{ margin: 0 }}>MCP servers</h4>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              className="btn btn-sm"
              onClick={() => { setMcpInstallerEdit(undefined); setShowMcpInstaller(true) }}
            >
              Manage
            </button>
          </div>
        </div>
        {mcp.length === 0 && <div style={{ color: 'var(--fg-muted)', fontSize: 13, marginTop: 6 }}>No MCP servers</div>}
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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h4 style={{ margin: 0 }}>Marketplace</h4>
          <button className="btn btn-sm" onClick={() => setShowMarketplace(true)}>
            Browse plugins
          </button>
        </div>
        <div style={{ color: 'var(--fg-muted)', fontSize: 13, marginTop: 6 }}>
          Browse and install plugins from registered marketplaces.
        </div>
      </div>

      {showMarketplace && (
        <MarketplaceBrowser
          onClose={() => setShowMarketplace(false)}
          onInstalled={() => { onPluginsReloaded?.() }}
        />
      )}

      {showMcpInstaller && (
        <McpInstaller
          server={mcpInstallerEdit}
          onSave={handleMcpInstallerSave}
          onClose={() => { setShowMcpInstaller(false); setMcpInstallerEdit(undefined) }}
        />
      )}
    </aside>
  )
}

function ReadOnlyField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="settings-field">
      <label>{label}</label>
      <div
        style={{
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          padding: '6px 8px',
          borderRadius: 6,
          fontFamily: mono ? 'var(--mono)' : undefined,
          fontSize: mono ? 12 : undefined,
          color: 'var(--fg-muted)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
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
    <div style={{ border: '1px solid var(--border)', borderRadius: 6, marginTop: 8, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: 'var(--bg)' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: dotColor, flexShrink: 0 }} />
        <span style={{ fontWeight: 500, fontSize: 13, flex: 1 }}>{name}</span>
        {plugin?.source && (
          <span style={{ fontSize: 10, color: 'var(--fg-muted)', padding: '1px 4px', border: '1px solid var(--border)', borderRadius: 3 }}>
            {plugin.source}
          </span>
        )}
        <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
          {commands.length} skill{commands.length !== 1 ? 's' : ''}
          {agents.length > 0 && `, ${agents.length} agent${agents.length !== 1 ? 's' : ''}`}
        </span>
        {!isBuiltin && sessionId && (
          <button
            className="btn"
            style={{ padding: '1px 6px', fontSize: 11 }}
            onClick={toggle}
            disabled={disabled || toggling}
          >
            {enabled ? 'Disable' : 'Enable'}
          </button>
        )}
        {(commands.length > 0 || agents.length > 0) && (
          <button className="btn" style={{ padding: '1px 6px', fontSize: 11 }} onClick={() => setExpanded(!expanded)}>
            {expanded ? '▲' : '▼'}
          </button>
        )}
      </div>
      {plugin?.path && (
        <div style={{ padding: '2px 10px', fontSize: 11, color: 'var(--fg-muted)', fontFamily: 'var(--mono)', background: 'var(--bg)' }}>
          {plugin.path}
        </div>
      )}
      {expanded && (
        <div style={{ padding: '4px 10px 8px', background: 'var(--bg)' }}>
          {commands.length > 0 && (
            <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--fg-muted)', marginBottom: 2 }}>Skills</div>
          )}
          {commands.map((cmd) => (
            <div key={cmd.name} style={{ fontSize: 12, padding: '2px 0', display: 'flex', gap: 6, alignItems: 'baseline' }}>
              <code style={{ fontWeight: 500 }}>/{cmd.name}</code>
              <span style={{ color: 'var(--fg-muted)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {cmd.description}
              </span>
            </div>
          ))}
          {agents.length > 0 && (
            <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--fg-muted)', marginTop: 4, marginBottom: 2 }}>Agents</div>
          )}
          {agents.map((agent) => (
            <div key={agent.name} style={{ fontSize: 12, padding: '2px 0', display: 'flex', gap: 6, alignItems: 'baseline' }}>
              <code style={{ fontWeight: 500 }}>{agent.name}</code>
              <span style={{ color: 'var(--fg-muted)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {agent.description}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const STATUS_COLORS: Record<string, string> = {
  connected: '#4caf50',
  failed: '#f44336',
  'needs-auth': '#ff9800',
  disabled: '#9e9e9e',
  pending: '#2196f3',
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
  const color = STATUS_COLORS[server.status] ?? '#9e9e9e'
  const canReconnect = server.status === 'failed' || server.status === 'disabled'
  const canDisable = server.status !== 'disabled'
  const canEnable = server.status === 'disabled'

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 6, marginTop: 8, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: 'var(--bg)' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
        <span style={{ fontWeight: 500, fontSize: 13, flex: 1 }}>
          {server.name}
          {isGlobal && (
            <span style={{ fontSize: 10, color: '#2196f3', marginLeft: 6, fontWeight: 400, padding: '1px 4px', border: '1px solid #2196f3', borderRadius: 3 }}>
              global
            </span>
          )}
        </span>
        {server.tools && (
          <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>{server.tools.length} tool{server.tools.length !== 1 ? 's' : ''}</span>
        )}
        {canReconnect && (
          <button className="btn" style={{ padding: '1px 6px', fontSize: 11 }} onClick={() => onReconnect(server.name)} disabled={disabled}>
            Reconnect
          </button>
        )}
        {canDisable && (
          <button className="btn" style={{ padding: '1px 6px', fontSize: 11 }} onClick={() => onToggle(server.name, false)} disabled={disabled}>
            Disable
          </button>
        )}
        {canEnable && (
          <button className="btn" style={{ padding: '1px 6px', fontSize: 11 }} onClick={() => onToggle(server.name, true)} disabled={disabled}>
            Enable
          </button>
        )}
        {server.tools && server.tools.length > 0 && (
          <button
            className="btn"
            style={{ padding: '1px 6px', fontSize: 11 }}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? '▲' : '▼'}
          </button>
        )}
      </div>
      {server.error && (
        <div style={{ padding: '4px 10px', fontSize: 12, color: '#f44336', background: 'var(--bg)' }}>
          {server.error}
        </div>
      )}
      {expanded && server.tools && (
        <div style={{ padding: '4px 10px 8px', background: 'var(--bg)' }}>
          {server.tools.map((t) => (
            <div key={t.name} style={{ fontSize: 12, padding: '2px 0', display: 'flex', gap: 6, alignItems: 'baseline' }}>
              <code style={{ fontWeight: 500 }}>{t.name}</code>
              {t.annotations?.readOnly && <span style={{ fontSize: 10, color: '#4caf50' }}>read-only</span>}
              {t.annotations?.destructive && <span style={{ fontSize: 10, color: '#f44336' }}>destructive</span>}
              {t.annotations?.openWorld && <span style={{ fontSize: 10, color: '#ff9800' }}>open-world</span>}
              {t.description && <span style={{ color: 'var(--fg-muted)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.description}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
