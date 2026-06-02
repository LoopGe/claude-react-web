// Global application settings modal. Edits config.json fields and manages
// MCP server configs. All changes are persisted server-side on Save.

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../hooks/useApi'
import { formatBytes } from '../utils/format'
import { IconX, IconCheck } from './icons/ToolIcons'
import { buildUpgradeCommand } from '../utils/upgrade-command'
import type { FullServerConfig } from '../types/config'
import type { McpServerConfigMeta } from '../types'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useToast } from '../hooks/useToast'
import type { UpdateActionResult, UpdateInfo } from '../../shared/update-info'

// MarketplaceTab pulls in catalog-rendering UI; McpInstaller is a heavy
// modal-within-modal. Both are only opened on demand from inside the
// settings dialog, so we load them lazily so the global-settings chunk
// isn't carrying their weight on every open.
const McpInstaller = lazy(() =>
  import('./McpInstaller').then((m) => ({ default: m.McpInstaller })),
)
const MarketplaceTab = lazy(() =>
  import('./MarketplaceTab').then((m) => ({ default: m.MarketplaceTab })),
)

type Tab = 'api' | 'models' | 'server' | 'mcp' | 'marketplace' | 'logs' | 'about'

type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace'

interface LogConfig {
  level: LogLevel
  scopes: string[] | null
  availableLevels: readonly LogLevel[]
}

interface Props {
  onClose: () => void
  /** Called after config is saved so the parent can refresh its state. */
  onSaved?: () => void
  /** Update-info shared from <App>. Lets the About tab show the same
   *  state the top banner uses, and hitting "Check now" updates both. */
  updateInfo?: UpdateInfo | null
  updateRefreshing?: boolean
  updateError?: string | null
  onRefreshUpdate?: () => void
  /** True while an in-app update (POST /api/update) is running. */
  updating?: boolean
  /** Trigger the in-app update; resolves with the action result. */
  onUpdate?: () => Promise<UpdateActionResult>
}

export function GlobalSettingsModal({
  onClose,
  onSaved,
  updateInfo,
  updateRefreshing,
  updateError,
  onRefreshUpdate,
  updating,
  onUpdate,
}: Props) {
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
  const [commitMessageModel, setCommitMessageModel] = useState('')
  const [newModel, setNewModel] = useState('')

  // ── Server tab state ──
  const [maxUploadBytes, setMaxUploadBytes] = useState(0)
  const [historyCap, setHistoryCap] = useState(500)
  const [maxOpenPanels, setMaxOpenPanels] = useState(3)
  const [workingStuckMs, setWorkingStuckMs] = useState(0)

  // ── About tab state ──
  // The registry URL is editable from the About tab. Empty string =
  // feature disabled (matches server-side semantics in
  // applyParsedConfig — empty trims to '' and the checker treats that
  // as `{ disabled: true }`).
  const [updateCheckRegistry, setUpdateCheckRegistry] = useState('')

  // ── MCP tab state ──
  const [mcpServers, setMcpServers] = useState<McpServerConfigMeta[]>([])
  const [showMcpInstaller, setShowMcpInstaller] = useState(false)
  const [mcpInstallerEdit, setMcpInstallerEdit] = useState<McpServerConfigMeta | undefined>()

  const dialogRef = useRef<HTMLDivElement>(null)

  // Esc to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Focus management: trap Tab inside the dialog, autofocus the first
  // focusable element on open, and restore focus to the trigger element
  // on close so keyboard navigation isn't lost in the void.
  useFocusTrap(dialogRef, { restoreFocus: true, excludeDisabled: true })

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
        setCommitMessageModel(cfg.commitMessageModel ?? '')
        setMaxUploadBytes(cfg.maxUploadBytes ?? 0)
        setHistoryCap(cfg.historyCap ?? 500)
        setMaxOpenPanels(cfg.maxOpenPanels ?? 3)
        setWorkingStuckMs(cfg.workingStuckMs ?? 0)
        setUpdateCheckRegistry(cfg.updateCheckRegistry ?? '')
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
        commitMessageModel: commitMessageModel.trim() || null,
        maxUploadBytes: maxUploadBytes > 0 ? maxUploadBytes : null,
        historyCap: historyCap > 0 ? historyCap : null,
        maxOpenPanels,
        workingStuckMs,
        // Empty / whitespace clears the override (server treats that as
        // "feature disabled"). PUT /config translates null/'' to a key
        // delete, so the next reload reverts to the default empty
        // string.
        updateCheckRegistry: updateCheckRegistry.trim() || null,
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
    if (commitMessageModel === model) setCommitMessageModel('')
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
    { key: 'marketplace', label: 'Marketplace' },
    { key: 'logs', label: 'Logs' },
    { key: 'about', label: 'About' },
  ]

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="global-settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3>Settings</h3>
          <button className="btn" onClick={onClose} style={{ padding: '2px 10px' }} aria-label="Close"><IconX size={14} /></button>
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
                  commitMessageModel={commitMessageModel}
                  newModel={newModel}
                  onRecapModelChange={setRecapModel}
                  onCommitMessageModelChange={setCommitMessageModel}
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
                  onMaxUploadBytesChange={setMaxUploadBytes}
                  onHistoryCapChange={setHistoryCap}
                  onMaxOpenPanelsChange={setMaxOpenPanels}
                  onWorkingStuckMsChange={setWorkingStuckMs}
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
              {tab === 'marketplace' && (
                <Suspense fallback={<div className="lazy-tab-loading">Loading marketplace…</div>}>
                  <MarketplaceTab />
                </Suspense>
              )}
              {tab === 'logs' && <LogsTab />}
              {tab === 'about' && (
                <AboutTab
                  info={updateInfo ?? null}
                  refreshing={!!updateRefreshing}
                  error={updateError ?? null}
                  onRefresh={onRefreshUpdate}
                  registry={updateCheckRegistry}
                  onRegistryChange={setUpdateCheckRegistry}
                  updating={!!updating}
                  onUpdate={onUpdate}
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
          <Suspense fallback={null}>
            <McpInstaller
              server={mcpInstallerEdit}
              onSave={() => { setShowMcpInstaller(false); setMcpInstallerEdit(undefined); void refreshMcp() }}
              onClose={() => { setShowMcpInstaller(false); setMcpInstallerEdit(undefined) }}
            />
          </Suspense>
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
  modelList, recapModel, commitMessageModel, newModel,
  onRecapModelChange, onCommitMessageModelChange, onNewModelChange, onAddModel, onRemoveModel,
}: {
  modelList: string[]
  recapModel: string
  commitMessageModel: string
  newModel: string
  onRecapModelChange: (v: string) => void
  onCommitMessageModelChange: (v: string) => void
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
                aria-label="Remove"
              >
                <IconX size={12} />
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
      <Field label="Commit Message Model" hint="Model used for AI-generated commit messages in Git panel">
        <select
          className="input"
          value={commitMessageModel}
          onChange={(e) => onCommitMessageModelChange(e.target.value)}
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
  maxUploadBytes, historyCap, maxOpenPanels, workingStuckMs,
  onMaxUploadBytesChange, onHistoryCapChange, onMaxOpenPanelsChange,
  onWorkingStuckMsChange,
}: {
  maxUploadBytes: number
  historyCap: number
  maxOpenPanels: number
  workingStuckMs: number
  onMaxUploadBytesChange: (v: number) => void
  onHistoryCapChange: (v: number) => void
  onMaxOpenPanelsChange: (v: number) => void
  onWorkingStuckMsChange: (v: number) => void
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
          className="btn btn-sm"
          onClick={() => onToggle(server.name, server.enabled === false)}
          title={server.enabled !== false ? 'Disable' : 'Enable'}
        >
          {server.enabled !== false ? 'ON' : 'OFF'}
        </button>
        <button className="btn btn-sm" onClick={() => onEdit(server)}>
          Edit
        </button>
        {!confirmDelete ? (
          <button className="btn btn-sm" style={{ color: 'var(--danger)' }} onClick={() => setConfirmDelete(true)}>
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
            <button className="btn" style={{ padding: '2px 6px', fontSize: 11 }} onClick={() => setConfirmDelete(false)} aria-label="Cancel">
              <IconX size={12} />
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

// ── Logs tab ─────────────────────────────────────────────────────

/** Runtime log-level / scope-filter control and file-logging toggle.
 *  Level/scopes are in-memory only (reset on restart). File logging is
 *  persisted to config.json. */
function LogsTab() {
  const [config, setConfig] = useState<LogConfig | null>(null)
  const [scopesInput, setScopesInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  // ── File logging state ──
  const [fileLogEnabled, setFileLogEnabled] = useState(false)
  const [fileLogPath, setFileLogPath] = useState<string | null>(null)
  const [fileBusy, setFileBusy] = useState(false)

  useEffect(() => {
    const ac = new AbortController()
    api
      .get<LogConfig>('/log', { signal: ac.signal })
      .then((cfg) => {
        setConfig(cfg)
        setScopesInput(cfg.scopes ? cfg.scopes.join(',') : '')
      })
      .catch((e) => {
        if ((e as Error).name !== 'AbortError') setErr((e as Error).message)
      })
    // Fetch file logging state
    api
      .get<{ enabled: boolean; path: string | null }>('/log/file', { signal: ac.signal })
      .then((r) => {
        setFileLogEnabled(r.enabled)
        setFileLogPath(r.path)
      })
      .catch(() => { /* non-critical */ })
    return () => ac.abort()
  }, [])

  const apply = useCallback(async (patch: { level?: LogLevel; scopes?: string[] | null }) => {
    setBusy(true)
    setErr(null)
    try {
      const next = await api.put<LogConfig>('/log', patch)
      setConfig(next)
      setScopesInput(next.scopes ? next.scopes.join(',') : '')
      setSavedAt(Date.now())
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [])

  const toggleFileLogging = useCallback(async () => {
    setFileBusy(true)
    setErr(null)
    try {
      const next = await api.put<{ enabled: boolean; path: string | null }>('/log/file', { enabled: !fileLogEnabled })
      setFileLogEnabled(next.enabled)
      setFileLogPath(next.path)
      setSavedAt(Date.now())
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setFileBusy(false)
    }
  }, [fileLogEnabled])

  if (!config) {
    return <div style={{ padding: 16, color: 'var(--fg-muted)' }}>Loading log config…</div>
  }

  const onScopesBlur = () => {
    const trimmed = scopesInput.trim()
    const parsed = trimmed ? trimmed.split(',').map((s) => s.trim()).filter(Boolean) : null
    const current = config.scopes ?? null
    // Only PUT if it changed.
    const changed =
      (parsed === null) !== (current === null) ||
      (parsed && current && (parsed.length !== current.length || parsed.some((s, i) => s !== current[i])))
    if (changed) void apply({ scopes: parsed && parsed.length > 0 ? parsed : null })
  }

  return (
    <div>
      <Field
        label="Level"
        hint="Threshold — only messages at this level or higher get printed. Affects all scopes."
      >
        <select
          className="input"
          value={config.level}
          disabled={busy}
          onChange={(e) => void apply({ level: e.target.value as LogLevel })}
        >
          {config.availableLevels.map((lvl) => (
            <option key={lvl} value={lvl}>{lvl}</option>
          ))}
        </select>
      </Field>

      <Field
        label="Scope filter"
        hint='Comma-separated scope names (e.g. "broker,pump"). Leave empty to allow all scopes. Use "*" to be explicit. Only listed scopes log at all when set.'
      >
        <input
          className="input"
          type="text"
          value={scopesInput}
          disabled={busy}
          placeholder="(empty = all scopes)"
          onChange={(e) => setScopesInput(e.target.value)}
          onBlur={onScopesBlur}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              ;(e.target as HTMLInputElement).blur()
            }
          }}
          style={{ width: '100%' }}
        />
      </Field>

      <div style={{ marginTop: 12, fontSize: 12, color: 'var(--fg-muted)' }}>
        Level / scope changes apply immediately but are <strong>not
        persisted</strong>. A restart reverts to the boot-time values
        (LOG_LEVEL / LOG_SCOPES env vars, default <code>info</code> / all).
      </div>

      <div style={{ borderTop: '1px solid var(--border)', margin: '16px 0 12px' }} />

      <Field
        label="Log to file"
        hint={fileLogEnabled && fileLogPath
          ? `Writing to ${fileLogPath}`
          : 'Write server logs to a daily-rotated file. Persisted across restarts.'}
      >
        <button
          className="btn"
          style={{ padding: '4px 16px', fontSize: 12 }}
          disabled={fileBusy}
          onClick={toggleFileLogging}
        >
          {fileBusy ? '…' : fileLogEnabled ? 'ON' : 'OFF'}
        </button>
      </Field>

      {err && <div className="modal-error" style={{ marginTop: 12 }}>{err}</div>}
      {savedAt && !err && (
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--ok)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <IconCheck size={13} /> Updated
        </div>
      )}
    </div>
  )
}

// ── About / Updates ──────────────────────────────────────────────
//
// Shows the running version, the latest npm version (or an error), the
// last-checked timestamp, and a "Check now" button. The data is owned
// by <App>'s useUpdateInfo hook so dismissing this modal and opening
// the banner stays in sync.

function AboutTab({
  info,
  refreshing,
  error,
  onRefresh,
  registry,
  onRegistryChange,
  updating,
  onUpdate,
}: {
  info: UpdateInfo | null
  refreshing: boolean
  error: string | null
  onRefresh?: () => void
  /** Pending value of `updateCheckRegistry` — saved when the modal's
   *  Save button fires `handleSave`. Empty string means "disable". */
  registry: string
  onRegistryChange: (v: string) => void
  updating: boolean
  onUpdate?: () => Promise<UpdateActionResult>
}) {
  const toast = useToast()
  // Error from the most recent in-app update attempt (POST /api/update),
  // shown inline below the Update button. Separate from the registry probe
  // error above.
  const [updateError, setUpdateError] = useState<string | null>(null)

  // Formatted "last checked" — relative time tends to read as fresher
  // than an absolute date for a quick "did this just check?" glance.
  const checkedAtLabel = info?.checkedAt ? formatRelative(info.checkedAt) : 'never'

  // The probe error from the server (info.error) is the more useful
  // value for the user — it describes WHY the registry couldn't be
  // reached. Only fall back to the local fetch error (`error`) when
  // the server itself was unreachable.
  const displayError = info?.error ?? error
  const hasUpdate = !!(info?.hasUpdate && info.latest)
  const disabled = !!info?.disabled
  const upToDate =
    !!info && !info.checking && !info.hasUpdate && info.latest && !displayError && !disabled
  // An in-app update can only replace a global install. For npx / dev runs
  // there's nothing to upgrade in place, so we show only the copy-command.
  const canUpdateInApp = hasUpdate && info?.installMethod === 'global' && !!onUpdate

  const runUpdate = async () => {
    if (!onUpdate) return
    setUpdateError(null)
    try {
      const res = await onUpdate()
      if (res.performed) {
        toast.success(
          `Updated to ${res.latest ?? 'the latest version'} — restart the server to apply.`,
        )
        onRefresh?.()
      } else {
        // Server declined to install (npx / unknown). Point the user at the
        // copy-command instead.
        toast.info('In-app update isn’t available for this install — copy the command below.')
      }
    } catch (e) {
      setUpdateError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div>
      <Field label="Project">
        <div style={{ fontSize: 13 }}>claude-react-web</div>
      </Field>
      <Field label="Current version">
        <div style={{ fontSize: 13, fontFamily: 'var(--mono)' }}>
          {info?.current ?? '—'}
        </div>
      </Field>
      <Field
        label="Update registry"
        hint="npm registry probed for the `latest` dist-tag. Leave empty to disable update checks. Changes take effect after Save."
      >
        <input
          className="input"
          type="url"
          value={registry}
          onChange={(e) => onRegistryChange(e.target.value)}
          placeholder="https://registry.npmjs.org"
          spellCheck={false}
        />
      </Field>
      <Field label="Latest version" hint={`Last checked: ${checkedAtLabel}`}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13, fontFamily: 'var(--mono)' }}>
            {disabled
              ? '—'
              : info?.latest ?? (info?.checking ? 'checking…' : '—')}
          </span>
          {hasUpdate && (
            <span
              style={{
                fontSize: 11,
                padding: '2px 8px',
                borderRadius: 10,
                background: 'var(--accent)',
                color: 'var(--on-accent)',
              }}
            >
              update available
            </span>
          )}
          {upToDate && (
            <span style={{ fontSize: 12, color: 'var(--ok)', display: 'inline-flex', alignItems: 'center', gap: 4 }}><IconCheck size={13} /> up to date</span>
          )}
          {disabled && (
            <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
              update checks disabled
            </span>
          )}
        </div>
      </Field>
      {hasUpdate && info && (
        <Field
          label="Upgrade command"
          hint={`If you installed globally, use \`${buildUpgradeCommand(info.packageName, info.registry, true)}\`.`}
        >
          <div style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
            {buildUpgradeCommand(info.packageName, info.registry)}
          </div>
        </Field>
      )}
      {displayError && !disabled && (
        <div className="modal-error" style={{ marginTop: 8 }}>
          Could not reach the registry: {displayError}
        </div>
      )}
      {updateError && (
        <div className="modal-error" style={{ marginTop: 8 }}>
          Update failed: {updateError}
        </div>
      )}
      <div style={{ marginTop: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          className="btn"
          onClick={onRefresh}
          disabled={refreshing || !onRefresh || disabled || updating}
          title={disabled ? 'Set a registry URL above and Save first.' : undefined}
        >
          {refreshing ? 'Checking…' : 'Check now'}
        </button>
        {canUpdateInApp && (
          <button
            className="btn btn-primary"
            onClick={() => void runUpdate()}
            disabled={updating || refreshing}
            title="Run `npm i -g …@latest` on the server, then restart to apply."
          >
            {updating ? 'Updating…' : 'Update now'}
          </button>
        )}
      </div>
    </div>
  )
}

/** Compact relative-time formatter for the "last checked" label.
 *  Avoids pulling in a full i18n lib for one line of UI text. */
function formatRelative(ms: number): string {
  const delta = Date.now() - ms
  if (delta < 0) return 'just now'
  const sec = Math.round(delta / 1000)
  if (sec < 5) return 'just now'
  if (sec < 60) return `${sec}s ago`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.round(hr / 24)
  return `${day}d ago`
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
