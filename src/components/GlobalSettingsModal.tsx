// Global application settings modal. Edits config.json fields and manages
// MCP server configs. All changes are persisted server-side on Save.

import { useCallback, useEffect, useState } from 'react'
import { api } from '../hooks/useApi'
import type { FullServerConfig } from '../types/config'
import type { McpServerConfigMeta } from '../types'
import { McpInstaller } from './McpInstaller'

type Tab = 'api' | 'models' | 'server' | 'mcp'

interface Props {
  onClose: () => void
  /** Called after config is saved so the parent can refresh its state. */
  onSaved?: () => void
}

export function GlobalSettingsModal({ onClose, onSaved }: Props) {
  const [tab, setTab] = useState<Tab>('api')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // ── API tab state ──
  const [authToken, setAuthToken] = useState('')
  const [authTokenMasked, setAuthTokenMasked] = useState<string | undefined>()
  const [authTokenDirty, setAuthTokenDirty] = useState(false)
  const [baseUrl, setBaseUrl] = useState('')

  // ── Models tab state ──
  const [modelList, setModelList] = useState<string[]>([])
  const [recapModel, setRecapModel] = useState('')
  const [newModel, setNewModel] = useState('')

  // ── Server tab state ──
  const [maxUploadBytes, setMaxUploadBytes] = useState(0)
  const [historyCap, setHistoryCap] = useState(500)
  const [maxOpenPanels, setMaxOpenPanels] = useState(3)
  const [workingStuckMs, setWorkingStuckMs] = useState(0)
  const [warmPoolSize, setWarmPoolSize] = useState(2)

  // ── MCP tab state ──
  const [mcpServers, setMcpServers] = useState<McpServerConfigMeta[]>([])
  const [showMcpInstaller, setShowMcpInstaller] = useState(false)
  const [mcpInstallerEdit, setMcpInstallerEdit] = useState<McpServerConfigMeta | undefined>()

  // Esc to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Load full config on mount
  useEffect(() => {
    const ac = new AbortController()
    ;(async () => {
      try {
        const cfg = await api.get<FullServerConfig>('/config/full', { signal: ac.signal })
        setBaseUrl(cfg.baseUrl ?? '')
        setAuthTokenMasked(cfg.authTokenMasked)
        setModelList(cfg.modelList ?? [])
        setRecapModel(cfg.recapModel ?? '')
        setMaxUploadBytes(cfg.maxUploadBytes ?? 0)
        setHistoryCap(cfg.historyCap ?? 500)
        setMaxOpenPanels(cfg.maxOpenPanels ?? 3)
        setWorkingStuckMs(cfg.workingStuckMs ?? 0)
        setWarmPoolSize(cfg.warmPoolSize ?? 2)
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setErr((e as Error).message)
      } finally {
        setLoading(false)
      }
    })()
    return () => { ac.abort() }
  }, [])

  // Load MCP servers on mount (with proper cleanup)
  useEffect(() => {
    const ac = new AbortController()
    ;(async () => {
      try {
        const r = await api.get<{ servers: McpServerConfigMeta[] }>('/mcp-config', { signal: ac.signal })
        setMcpServers(r.servers)
      } catch { /* no global config is fine */ }
    })()
    return () => { ac.abort() }
  }, [])

  // Imperative refresh for delete/toggle/save handlers
  const refreshMcp = useCallback(async () => {
    try {
      const r = await api.get<{ servers: McpServerConfigMeta[] }>('/mcp-config')
      setMcpServers(r.servers)
    } catch { /* no global config is fine */ }
  }, [])

  const handleSave = async () => {
    setSaving(true)
    setErr(null)
    try {
      const updates: Record<string, unknown> = {
        baseUrl: baseUrl.trim() || null,
        modelList: modelList.length > 0 ? modelList : null,
        recapModel: recapModel.trim() || null,
        maxUploadBytes: maxUploadBytes > 0 ? maxUploadBytes : null,
        historyCap: historyCap > 0 ? historyCap : null,
        maxOpenPanels,
        workingStuckMs,
        warmPoolSize,
      }
      if (authTokenDirty && authToken.trim()) {
        updates.authToken = authToken.trim()
      }
      await api.put('/config', updates)
      setAuthTokenDirty(false)
      setAuthToken('')
      onSaved?.()
      onClose()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const addModel = () => {
    const m = newModel.trim()
    if (!m || modelList.includes(m)) return
    setModelList([...modelList, m])
    setNewModel('')
  }

  const removeModel = (model: string) => {
    setModelList(modelList.filter((m) => m !== model))
    if (recapModel === model) setRecapModel('')
  }

  const deleteMcpServer = async (name: string) => {
    try {
      await api.delete(`/mcp-config/${encodeURIComponent(name)}`)
      await refreshMcp()
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  const toggleMcpServer = async (name: string, enabled: boolean) => {
    try {
      await api.post(`/mcp-config/${encodeURIComponent(name)}/toggle`, { enabled })
      await refreshMcp()
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: 'api', label: 'API' },
    { key: 'models', label: 'Models' },
    { key: 'server', label: 'Server' },
    { key: 'mcp', label: 'MCP Servers' },
  ]

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="global-settings-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3>Settings</h3>
          <button className="btn" onClick={onClose} style={{ padding: '2px 10px' }}>✕</button>
        </div>

        {/* Tab bar */}
        <div className="global-settings-tabs">
          {tabs.map((t) => (
            <button
              key={t.key}
              className={`global-settings-tab${tab === t.key ? ' active' : ''}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {err && <div className="modal-error">{err}</div>}

        <div className="global-settings-body">
          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--fg-muted)' }}>Loading…</div>
          ) : (
            <>
              {tab === 'api' && (
                <ApiTab
                  authToken={authToken}
                  authTokenMasked={authTokenMasked}
                  authTokenDirty={authTokenDirty}
                  baseUrl={baseUrl}
                  onAuthTokenChange={(v) => { setAuthToken(v); setAuthTokenDirty(true) }}
                  onBaseUrlChange={setBaseUrl}
                />
              )}
              {tab === 'models' && (
                <ModelsTab
                  modelList={modelList}
                  recapModel={recapModel}
                  newModel={newModel}
                  onRecapModelChange={setRecapModel}
                  onNewModelChange={setNewModel}
                  onAddModel={addModel}
                  onRemoveModel={removeModel}
                />
              )}
              {tab === 'server' && (
                <ServerTab
                  maxUploadBytes={maxUploadBytes}
                  historyCap={historyCap}
                  maxOpenPanels={maxOpenPanels}
                  workingStuckMs={workingStuckMs}
                  warmPoolSize={warmPoolSize}
                  onMaxUploadBytesChange={setMaxUploadBytes}
                  onHistoryCapChange={setHistoryCap}
                  onMaxOpenPanelsChange={setMaxOpenPanels}
                  onWorkingStuckMsChange={setWorkingStuckMs}
                  onWarmPoolSizeChange={setWarmPoolSize}
                />
              )}
              {tab === 'mcp' && (
                <McpTab
                  servers={mcpServers}
                  onAdd={() => { setMcpInstallerEdit(undefined); setShowMcpInstaller(true) }}
                  onEdit={(s) => { setMcpInstallerEdit(s); setShowMcpInstaller(true) }}
                  onDelete={deleteMcpServer}
                  onToggle={toggleMcpServer}
                />
              )}
            </>
          )}
        </div>

        <div className="modal-footer">
          <span className="hint">Changes are saved to config.json</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>

        {showMcpInstaller && (
          <McpInstaller
            server={mcpInstallerEdit}
            onSave={() => { setShowMcpInstaller(false); setMcpInstallerEdit(undefined); void refreshMcp() }}
            onClose={() => { setShowMcpInstaller(false); setMcpInstallerEdit(undefined) }}
          />
        )}
      </div>
    </div>
  )
}

// ── Tab contents ─────────────────────────────────────────────────

function ApiTab({
  authToken, authTokenMasked, authTokenDirty, baseUrl,
  onAuthTokenChange, onBaseUrlChange,
}: {
  authToken: string
  authTokenMasked?: string
  authTokenDirty: boolean
  baseUrl: string
  onAuthTokenChange: (v: string) => void
  onBaseUrlChange: (v: string) => void
}) {
  return (
    <>
      <Field label="Auth Token" hint={authTokenMasked && !authTokenDirty ? `Current: ${authTokenMasked}` : undefined}>
        <input
          className="input"
          type="password"
          value={authToken}
          onChange={(e) => onAuthTokenChange(e.target.value)}
          placeholder={authTokenMasked ? 'Enter new token to replace' : 'sk-ant-...'}
        />
      </Field>
      <Field label="Base URL" hint="API endpoint (default: https://api.anthropic.com)">
        <input
          className="input"
          value={baseUrl}
          onChange={(e) => onBaseUrlChange(e.target.value)}
          placeholder="https://api.anthropic.com"
        />
      </Field>
    </>
  )
}

function ModelsTab({
  modelList, recapModel, newModel,
  onRecapModelChange, onNewModelChange, onAddModel, onRemoveModel,
}: {
  modelList: string[]
  recapModel: string
  newModel: string
  onRecapModelChange: (v: string) => void
  onNewModelChange: (v: string) => void
  onAddModel: () => void
  onRemoveModel: (m: string) => void
}) {
  return (
    <>
      <Field label="Available Models" hint="First model is the default. Add model IDs one at a time.">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {modelList.map((m, i) => (
            <div key={m} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{
                fontSize: 11, color: 'var(--fg-muted)', width: 18, textAlign: 'right', flexShrink: 0,
              }}>
                {i === 0 ? '★' : ''}
              </span>
              <code style={{
                flex: 1, fontSize: 12, padding: '4px 8px',
                background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {m}
              </code>
              <button
                className="btn"
                style={{ padding: '2px 6px', fontSize: 11, flexShrink: 0 }}
                onClick={() => onRemoveModel(m)}
                title="Remove"
              >
                ✕
              </button>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
            <input
              className="input"
              style={{ flex: 1, fontSize: 12 }}
              value={newModel}
              onChange={(e) => onNewModelChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') onAddModel() }}
              placeholder="model-id (e.g. claude-sonnet-4-20250514)"
            />
            <button className="btn" style={{ fontSize: 11, padding: '2px 8px' }} onClick={onAddModel}>
              Add
            </button>
          </div>
        </div>
      </Field>
      <Field label="Recap Model" hint="Model used for AI session summaries (lighter model recommended)">
        <select
          className="input"
          value={recapModel}
          onChange={(e) => onRecapModelChange(e.target.value)}
        >
          <option value="">(default)</option>
          {modelList.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      </Field>
    </>
  )
}

function ServerTab({
  maxUploadBytes, historyCap, maxOpenPanels, workingStuckMs, warmPoolSize,
  onMaxUploadBytesChange, onHistoryCapChange, onMaxOpenPanelsChange,
  onWorkingStuckMsChange, onWarmPoolSizeChange,
}: {
  maxUploadBytes: number
  historyCap: number
  maxOpenPanels: number
  workingStuckMs: number
  warmPoolSize: number
  onMaxUploadBytesChange: (v: number) => void
  onHistoryCapChange: (v: number) => void
  onMaxOpenPanelsChange: (v: number) => void
  onWorkingStuckMsChange: (v: number) => void
  onWarmPoolSizeChange: (v: number) => void
}) {
  return (
    <>
      <NumberField
        label="Max Upload Size (bytes)"
        hint={`Current: ${formatBytes(maxUploadBytes)}. Default: 25 MB`}
        value={maxUploadBytes}
        onChange={onMaxUploadBytesChange}
        min={0}
      />
      <NumberField
        label="History Cap"
        hint="Max messages kept in memory per session"
        value={historyCap}
        onChange={onHistoryCapChange}
        min={1}
      />
      <NumberField
        label="Max Open Panels"
        hint="Side-by-side chat panels (2–5)"
        value={maxOpenPanels}
        onChange={onMaxOpenPanelsChange}
        min={2}
        max={5}
      />
      <NumberField
        label="Working Stuck Timeout (ms)"
        hint={workingStuckMs > 0 ? `~${Math.round(workingStuckMs / 60000)} min. 0 = disabled` : 'Disabled'}
        value={workingStuckMs}
        onChange={onWorkingStuckMsChange}
        min={0}
      />
      <NumberField
        label="Warm Pool Size"
        hint="Pre-warmed CLI processes. 0 = disabled"
        value={warmPoolSize}
        onChange={onWarmPoolSizeChange}
        min={0}
      />
    </>
  )
}

function McpTab({
  servers, onAdd, onEdit, onDelete, onToggle,
}: {
  servers: McpServerConfigMeta[]
  onAdd: () => void
  onEdit: (s: McpServerConfigMeta) => void
  onDelete: (name: string) => void
  onToggle: (name: string, enabled: boolean) => void
}) {
  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
          {servers.length} server{servers.length !== 1 ? 's' : ''} configured
        </span>
        <button className="btn" style={{ fontSize: 11, padding: '4px 12px' }} onClick={onAdd}>
          + Add Server
        </button>
      </div>
      {servers.length === 0 && (
        <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--fg-muted)', fontSize: 13 }}>
          No MCP servers configured. Click "Add Server" to get started.
        </div>
      )}
      {servers.map((srv) => (
        <McpCard key={srv.name} server={srv} onEdit={onEdit} onDelete={onDelete} onToggle={onToggle} />
      ))}
    </>
  )
}

function McpCard({
  server, onEdit, onDelete, onToggle,
}: {
  server: McpServerConfigMeta
  onEdit: (s: McpServerConfigMeta) => void
  onDelete: (name: string) => void
  onToggle: (name: string, enabled: boolean) => void
}) {
  const [confirmDelete, setConfirmDelete] = useState(false)

  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: 6, marginBottom: 6, overflow: 'hidden',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: 'var(--bg)',
      }}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
          background: server.enabled !== false ? 'var(--plugin-active)' : 'var(--plugin-inactive)',
        }} />
        <span style={{ fontWeight: 500, fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {server.name}
        </span>
        <span style={{
          fontSize: 11, color: 'var(--fg-muted)', background: 'var(--bg-elev-2)',
          padding: '1px 6px', borderRadius: 3, flexShrink: 0,
        }}>
          {server.type}
        </span>
        <button
          className="btn"
          style={{ padding: '2px 8px', fontSize: 11 }}
          onClick={() => onToggle(server.name, server.enabled === false)}
          title={server.enabled !== false ? 'Disable' : 'Enable'}
        >
          {server.enabled !== false ? 'ON' : 'OFF'}
        </button>
        <button className="btn" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => onEdit(server)}>
          Edit
        </button>
        {!confirmDelete ? (
          <button className="btn" style={{ padding: '2px 8px', fontSize: 11, color: 'var(--danger)' }} onClick={() => setConfirmDelete(true)}>
            Del
          </button>
        ) : (
          <div style={{ display: 'flex', gap: 2 }}>
            <button
              className="btn"
              style={{ padding: '2px 6px', fontSize: 11, color: 'var(--danger)' }}
              onClick={() => { onDelete(server.name); setConfirmDelete(false) }}
            >
              Confirm
            </button>
            <button className="btn" style={{ padding: '2px 6px', fontSize: 11 }} onClick={() => setConfirmDelete(false)}>
              ✕
            </button>
          </div>
        )}
      </div>
      {(server.command || server.url) && (
        <div style={{
          padding: '4px 10px 6px', fontSize: 11, color: 'var(--fg-muted)',
          fontFamily: 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          borderTop: '1px solid var(--border)', background: 'var(--bg-elev)',
        }}>
          {server.type === 'stdio'
            ? `${server.command} ${(server.args ?? []).join(' ')}`
            : server.url}
        </div>
      )}
    </div>
  )
}

// ── Shared primitives ────────────────────────────────────────────

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="settings-field" style={{ marginBottom: 12 }}>
      <label>{label}</label>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  )
}

function NumberField({
  label, hint, value, onChange, min, max,
}: {
  label: string; hint?: string; value: number
  onChange: (v: number) => void; min?: number; max?: number
}) {
  return (
    <Field label={label} hint={hint}>
      <input
        className="input"
        type="number"
        value={value}
        onChange={(e) => onChange(Math.round(Number(e.target.value) || 0))}
        min={min}
        max={max}
      />
    </Field>
  )
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = bytes
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(i > 0 ? 1 : 0)} ${units[i]}`
}
