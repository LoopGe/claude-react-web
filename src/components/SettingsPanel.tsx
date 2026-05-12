// Right-side settings drawer. Focuses on mid-session controls — options that
// can only be set at session creation are shown read-only at the top.

import { useEffect, useState } from 'react'
import { api } from '../hooks/useApi'
import type { McpServerStatus, ModelInfo, PermissionMode, SessionInfo } from '../types'
import { PERMISSION_MODES } from '../types'

interface Props {
  session: SessionInfo
  onClose: () => void
  onSessionUpdate: (s: SessionInfo) => void
}

export function SettingsPanel({ session, onClose, onSessionUpdate }: Props) {
  const [models, setModels] = useState<ModelInfo[]>([])
  const [settingsText, setSettingsText] = useState('{}')
  const [usage, setUsage] = useState<unknown>(null)
  const [mcp, setMcp] = useState<McpServerStatus[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

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
      // Fetch server-configured models (non-blocking, best-effort)
      let serverModelIds: string[] = []
      try {
        const cfg = await api.get<{ models?: string[] }>('/config', {
          signal: ac.signal,
        })
        serverModelIds = cfg.models ?? []
      } catch {
        /* ignore — we'll still have SDK models */
      }
      try {
        const m = await api.get<{ models: ModelInfo[] }>(
          `/sessions/${session.id}/models`,
          { signal: ac.signal },
        )
        // Merge: SDK models first, then append any server-configured
        // models that the SDK didn't already include.
        const sdkIds = new Set(m.models.map((x) => x.id))
        const merged = [
          ...m.models,
          ...serverModelIds
            .filter((id) => !sdkIds.has(id))
            .map((id): ModelInfo => ({ id })),
        ]
        setModels(merged)
      } catch (e) {
        if ((e as Error).name === 'AbortError') return
        // Supported models fails if SDK hasn't initialized yet — fall
        // back to server-configured models so the dropdown isn't empty.
        console.warn('could not load models:', (e as Error).message)
        if (serverModelIds.length) {
          setModels(serverModelIds.map((id): ModelInfo => ({ id })))
        }
      }
      try {
        const u = await api.get<{ usage: unknown }>(
          `/sessions/${session.id}/context-usage`,
          { signal: ac.signal },
        )
        setUsage(u.usage)
      } catch (e) {
        if ((e as Error).name === 'AbortError') return
      }
      try {
        const r = await api.get<{ mcp: McpServerStatus[] }>(
          `/sessions/${session.id}/mcp-status`,
          { signal: ac.signal },
        )
        setMcp(r.mcp)
      } catch (e) {
        if ((e as Error).name === 'AbortError') return
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
      await api.post(`/sessions/${session.id}/plugins/reload`)
      await refreshMcp()
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  return (
    <aside className="settings-panel">
      <h3>
        Session settings
        <button className="btn" style={{ padding: '2px 8px', fontSize: 11 }} onClick={onClose}>
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

        <div className="settings-field">
          <label>Merge flag settings (JSON)</label>
          <textarea
            className="textarea"
            rows={6}
            value={settingsText}
            onChange={(e) => setSettingsText(e.target.value)}
            placeholder='{"permissions": {...}, "env": {...}}'
          />
          <span className="hint">
            Calls <code>Query.applyFlagSettings()</code>. Top-level keys are shallow-merged across calls.
          </span>
          <button className="btn btn-primary" onClick={applySettings} disabled={busy || session.terminated}>
            Apply settings
          </button>
        </div>
      </div>

      <div className="settings-section">
        <h4>Context usage</h4>
        <pre className="tool-input" style={{ maxHeight: 220, overflow: 'auto' }}>
          {usage ? formatJson(usage) : '—'}
        </pre>
      </div>

      <div className="settings-section">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h4 style={{ margin: 0 }}>MCP servers</h4>
          <button className="btn" style={{ padding: '2px 8px', fontSize: 11 }} onClick={reloadPlugins} disabled={busy || session.terminated}>
            Reload plugins
          </button>
        </div>
        {mcp.length === 0 && <div style={{ color: 'var(--fg-muted)', fontSize: 13, marginTop: 6 }}>No MCP servers</div>}
        {mcp.map((srv) => (
          <McpServerCard
            key={srv.name}
            server={srv}
            onReconnect={reconnectMcp}
            onToggle={toggleMcp}
            disabled={busy || session.terminated}
          />
        ))}
      </div>
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

function formatJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
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
  onReconnect,
  onToggle,
  disabled,
}: {
  server: McpServerStatus
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
        <span style={{ fontWeight: 500, fontSize: 13, flex: 1 }}>{server.name}</span>
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
