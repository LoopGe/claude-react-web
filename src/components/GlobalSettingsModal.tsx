// Global application settings modal. Edits config.json fields and manages
// MCP server configs. All changes are persisted server-side on Save.

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { api } from '../hooks/useApi'
import { useAutoHeightTransition } from '../hooks/useAutoHeightTransition'
import { formatBytes } from '../utils/format'
import { IconX, IconCheck, IconArrowUp, IconArrowDown, IconChevronDown } from './icons/ToolIcons'
import { buildUpgradeCommand } from '../utils/upgrade-command'
import type { FullServerConfig } from '../types/config'
import type { SkillLoadMode, SkillRecord, SkillsListResponse } from '../../shared/skills'
import type { McpConnectionTestResult, McpServerConfigMeta, McpServerTool } from '../types'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useToast } from '../hooks/useToast'
import { useExitPresence } from '../hooks/useExitPresence'
import type { UpdateActionResult, UpdateInfo } from '../../shared/update-info'
import { isVersionNewer } from '../../shared/update-info'

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
// ShareTab pulls in the `qrcode` dependency ? lazy-load it so that weight
// only lands when the user opens the "Open on phone" tab.
const ShareTab = lazy(() =>
  import('./ShareTab').then((m) => ({ default: m.ShareTab })),
)

type Tab = 'api' | 'models' | 'server' | 'skills' | 'mcp' | 'marketplace' | 'share' | 'logs' | 'about'

type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace'

/** Result of POST /config/test-connection. `ok` true means the token and
 *  baseUrl are valid (we got past authentication); otherwise `status` (when
 *  it was an HTTP error) and `error` describe the failure. `baseUrl` echoes
 *  what was actually probed. */
interface ConnectionTestResult {
  ok: boolean
  status?: number
  error?: string
  baseUrl?: string
}

interface LogConfig {
  level: LogLevel
  scopes: string[] | null
  availableLevels: readonly LogLevel[]
}

interface Props {
  open?: boolean
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
  open = true,
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
  const settingsBodyRef = useRef<HTMLDivElement | null>(null)
  const settingsContentRef = useRef<HTMLDivElement | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // — API tab state ?
  const [authToken, setAuthToken] = useState('')
  const [authTokenMasked, setAuthTokenMasked] = useState<string | undefined>()
  const [authTokenDirty, setAuthTokenDirty] = useState(false)
  const [baseUrl, setBaseUrl] = useState('')

  // — Connection-test state (API tab) ?
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null)

  // — Models tab state ?
  const [modelList, setModelList] = useState<string[]>([])
  const [recapModel, setRecapModel] = useState('')
  const [commitMessageModel, setCommitMessageModel] = useState('')
  const [newModel, setNewModel] = useState('')

  // — Server tab state ?
  const [maxUploadBytes, setMaxUploadBytes] = useState(0)
  const [historyCap, setHistoryCap] = useState(500)
  const [maxOpenPanels, setMaxOpenPanels] = useState(3)
  const [workingStuckMs, setWorkingStuckMs] = useState(0)
  const [defaultCwd, setDefaultCwd] = useState('')

  // Skills tab state
  const [skillLoadMode, setSkillLoadMode] = useState<SkillLoadMode>('default')
  const [enabledSkills, setEnabledSkills] = useState<string[]>([])

  // — About tab state ?
  // The registry URL is editable from the About tab. Empty string =
  // feature disabled (matches server-side semantics in
  // applyParsedConfig — empty trims to '' and the checker treats that
  // as `{ disabled: true }`).
  const [updateCheckRegistry, setUpdateCheckRegistry] = useState('')

  // — MCP tab state ?
  const [mcpServers, setMcpServers] = useState<McpServerConfigMeta[]>([])
  const [showMcpInstaller, setShowMcpInstaller] = useState(false)
  const [mcpInstallerEdit, setMcpInstallerEdit] = useState<McpServerConfigMeta | undefined>()
  const mcpInstallerPresence = useExitPresence(showMcpInstaller)

  const dialogRef = useRef<HTMLDivElement>(null)

  // Esc to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (open && e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, open])

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
        setDefaultCwd(cfg.defaults?.cwd ?? '')
        setSkillLoadMode(cfg.skillLoadMode ?? 'default')
        setEnabledSkills(cfg.enabledSkills ?? [])
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

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === 'claude-react-web:mcp-oauth-complete') void refreshMcp()
    }
    const channel = 'BroadcastChannel' in window ? new BroadcastChannel('claude-react-web:mcp-oauth') : null
    channel?.addEventListener('message', () => void refreshMcp())
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener('storage', onStorage)
      channel?.close()
    }
  }, [refreshMcp])

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
        skillLoadMode,
        enabledSkills: enabledSkills.length > 0 ? enabledSkills : null,
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

  const handleTestConnection = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      // Send the token only when the user edited it (otherwise the server
      // falls back to the saved token — the client never holds the plaintext
      // of an already-saved token). Always send baseUrl so an unsaved URL
      // edit is what gets validate?.
      const r = await api.post<ConnectionTestResult>(
        '/config/test-connection',
        {
          authToken: authTokenDirty && authToken.trim() ? authToken.trim() : undefined,
          baseUrl: baseUrl.trim() || undefined,
        },
        { timeoutMs: 20_000 },
      )
      setTestResult(r)
    } catch (e) {
      setTestResult({ ok: false, error: (e as Error).message })
    } finally {
      setTesting(false)
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

  const moveModel = (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= modelList.length) return
    const next = [...modelList]
    ;[next[index], next[target]] = [next[target], next[index]]
    setModelList(next)
  }

  const sortModels = () => {
    setModelList([...modelList].sort((a, b) => a.localeCompare(b)))
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
    { key: 'skills', label: 'Skills' },
    { key: 'mcp', label: 'MCP Servers' },
    { key: 'marketplace', label: 'Marketplace' },
    { key: 'share', label: 'Open on phone' },
    { key: 'logs', label: 'Logs' },
    { key: 'about', label: 'About' },
  ]

  const heightAnimationKey = [
    tab,
    loading,
    err ?? '',
    modelList.length,
    mcpServers.length,
    skillLoadMode,
    enabledSkills.join(','),
    testing,
    testResult ? 'tested' : 'untested',
    updateInfo?.latest ?? '',
    updateError ?? '',
  ].join('|')
  const measureSettingsBodyHeight = useCallback(() => {
    const body = settingsBodyRef.current
    const content = settingsContentRef.current
    if (!body || !content) return null
    const modal = body.closest('.global-settings-modal') as HTMLElement | null
    const footer = modal?.querySelector('.modal-footer') as HTMLElement | null
    const availableModalHeight = modal?.parentElement?.clientHeight ? modal.parentElement.clientHeight * 0.84 : Number.POSITIVE_INFINITY
    const availableBodyHeight = Math.max(0, availableModalHeight - body.offsetTop - (footer?.offsetHeight ?? 0))
    const bodyStyle = window.getComputedStyle(body)
    const bodyVerticalPadding = parseFloat(bodyStyle.paddingTop) + parseFloat(bodyStyle.paddingBottom)
    const contentHeight = content.scrollHeight + bodyVerticalPadding
    return Math.min(contentHeight, availableBodyHeight || contentHeight)
  }, [])
  const { captureHeight: captureSettingsBodyHeight } = useAutoHeightTransition(settingsBodyRef, heightAnimationKey, {
    measureTargetHeight: measureSettingsBodyHeight,
    observe: settingsContentRef,
  })
  const switchTab = useCallback((nextTab: Tab) => {
    if (nextTab === tab) return
    captureSettingsBodyHeight()
    setTab(nextTab)
  }, [captureSettingsBodyHeight, tab])

  return (
    <div
      className="modal-backdrop"
      data-state={open ? 'open' : 'closing'}
      onClick={() => { if (open) onClose() }}
    >
      <div
        ref={dialogRef}
        className="global-settings-modal"
        role="dialog"
        aria-modal={open ? 'true' : 'false'}
        aria-hidden={!open}
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
              onClick={() => switchTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {err && <div className="modal-error">{err}</div>}

        <div ref={settingsBodyRef} className="global-settings-body">
          <div ref={settingsContentRef} className="global-settings-body-content">
          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--fg-muted)' }}>Loading...</div>
          ) : (
            <>
              {tab === 'api' && (
                <ApiTab
                  authToken={authToken}
                  authTokenMasked={authTokenMasked}
                  authTokenDirty={authTokenDirty}
                  baseUrl={baseUrl}
                  onAuthTokenChange={(v) => { setAuthToken(v); setAuthTokenDirty(true); setTestResult(null) }}
                  onBaseUrlChange={(v) => { setBaseUrl(v); setTestResult(null) }}
                  testing={testing}
                  testResult={testResult}
                  onTest={handleTestConnection}
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
                  onMoveModel={moveModel}
                  onSortModels={sortModels}
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
              {tab === 'skills' && (
                <SkillsTab
                  cwd={defaultCwd}
                  skillLoadMode={skillLoadMode}
                  enabledSkills={enabledSkills}
                  onSkillLoadModeChange={setSkillLoadMode}
                  onEnabledSkillsChange={setEnabledSkills}
                />
              )}
              {tab === 'mcp' && (
                <McpTab
                  servers={mcpServers}
                  onAdd={() => { setMcpInstallerEdit(undefined); setShowMcpInstaller(true) }}
                  onEdit={(s) => { setMcpInstallerEdit(s); setShowMcpInstaller(true) }}
                  onDelete={deleteMcpServer}
                  onToggle={toggleMcpServer}
                  onRefresh={refreshMcp}
                />
              )}
              {tab === 'marketplace' && (
                <Suspense fallback={<div className="lazy-tab-loading">Loading marketplace...</div>}>
                  <MarketplaceTab />
                </Suspense>
              )}
              {tab === 'share' && (
                <Suspense fallback={<div className="lazy-tab-loading">Loading...</div>}>
                  <ShareTab />
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
        </div>

        <div className="modal-footer">
          <span className="hint">Changes are saved to config.json</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>

        {mcpInstallerPresence.shouldRender && (
          <Suspense fallback={null}>
            <McpInstaller
              open={showMcpInstaller}
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

// — Tab contents ?????????????

function ApiTab({
  authToken, authTokenMasked, authTokenDirty, baseUrl,
  onAuthTokenChange, onBaseUrlChange,
  testing, testResult, onTest,
}: {
  authToken: string
  authTokenMasked?: string
  authTokenDirty: boolean
  baseUrl: string
  onAuthTokenChange: (v: string) => void
  onBaseUrlChange: (v: string) => void
  testing: boolean
  testResult: ConnectionTestResult | null
  onTest: () => void
}) {
  // Can only test if there's a token to test ?either a freshly-type one or
  // a previously-saved one (signalled by the masked value being present).
  const canTest = (authTokenDirty && !!authToken.trim()) || !!authTokenMasked
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
        <button
          className="btn"
          onClick={onTest}
          disabled={testing || !canTest}
          title={!canTest ? 'Enter a token first' : 'Send a minimal request to verify the token and URL'}
        >
          {testing ? 'Testing...' : 'Test connection'}
        </button>
        {testResult && (
          testResult.ok ? (
            <span style={{ fontSize: 12, color: 'var(--ok)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <IconCheck size={12} /> Token &amp; URL valid
            </span>
          ) : (
            <span style={{ fontSize: 12, color: 'var(--danger)' }}>
              ? {testResult.status ? `${testResult.status}: ` : ''}{testResult.error ?? 'Failed'}
            </span>
          )
        )}
      </div>
      <span className="hint" style={{ display: 'block', marginTop: 6 }}>
        Tests the token above (or your saved token if unchanged) without saving.
      </span>
    </>
  )
}

function ModelsTab({
  modelList, recapModel, commitMessageModel, newModel,
  onRecapModelChange, onCommitMessageModelChange, onNewModelChange, onAddModel, onRemoveModel,
  onMoveModel, onSortModels,
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
  onMoveModel: (index: number, direction: -1 | 1) => void
  onSortModels: () => void
}) {
  return (
    <>
      <Field label="Available Models" hint="First model is the default. Add model IDs one at a time.">
        <div className="settings-model-list">
          {modelList.length > 1 && (
            <div className="settings-model-list-toolbar">
              <button
                className="btn btn-xs settings-model-sort-btn"
                onClick={onSortModels}
                title="Sort alphabetically (A-Z)"
              >
                A-Z
              </button>
            </div>
          )}
          {modelList.map((m, i) => (
            <div key={m} className={`settings-model-row${i === 0 ? ' default' : ''}`}>
              <span className="settings-model-rank" title={i === 0 ? 'Default model' : undefined}>
                {i === 0 ? 'Default' : i + 1}
              </span>
              <code className="settings-model-id" title={m}>
                {m}
              </code>
              <div className="settings-model-move" role="group" aria-label="Move model priority">
                <button
                  className="btn-icon-sm settings-model-action"
                  onClick={() => onMoveModel(i, -1)}
                  disabled={i === 0}
                  title="Move up"
                  aria-label="Move up"
                >
                  <IconArrowUp size={12} />
                </button>
                <button
                  className="btn-icon-sm settings-model-action"
                  onClick={() => onMoveModel(i, 1)}
                  disabled={i === modelList.length - 1}
                  title="Move down"
                  aria-label="Move down"
                >
                  <IconArrowDown size={12} />
                </button>
              </div>
              <button
                className="btn-icon-sm settings-model-action danger"
                onClick={() => onRemoveModel(m)}
                title="Remove"
                aria-label="Remove"
              >
                <IconX size={12} />
              </button>
            </div>
          ))}
          <div className="settings-model-add-row">
            <input
              className="input settings-model-input"
              value={newModel}
              onChange={(e) => onNewModelChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') onAddModel() }}
              placeholder="model-id (e.g. claude-sonnet-4-20250514)"
            />
            <button className="btn btn-xs settings-model-add-btn" onClick={onAddModel}>
              Add
            </button>
          </div>
        </div>
      </Field>
      <Field label="Recap Model" hint="Model used for AI session summaries (lighter model recommended)">
        <div className="settings-model-select-wrap">
          <select
            className="input settings-model-select"
            value={recapModel}
            onChange={(e) => onRecapModelChange(e.target.value)}
          >
            <option value="">(default)</option>
            {modelList.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <IconChevronDown className="settings-model-select-icon" size={14} aria-hidden />
        </div>
      </Field>
      <Field label="Commit Message Model" hint="Model used for AI-generated commit messages in Git panel">
        <div className="settings-model-select-wrap">
          <select
            className="input settings-model-select"
            value={commitMessageModel}
            onChange={(e) => onCommitMessageModelChange(e.target.value)}
          >
            <option value="">(default)</option>
            {modelList.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <IconChevronDown className="settings-model-select-icon" size={14} aria-hidden />
        </div>
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
        hint="Side-by-side chat panels (2-5)"
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

function SkillsTab({
  cwd,
  skillLoadMode,
  enabledSkills,
  onSkillLoadModeChange,
  onEnabledSkillsChange,
}: {
  cwd: string
  skillLoadMode: SkillLoadMode
  enabledSkills: string[]
  onSkillLoadModeChange: (mode: SkillLoadMode) => void
  onEnabledSkillsChange: (skills: string[]) => void
}) {
  const [skills, setSkills] = useState<SkillRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<SkillRecord | null>(null)
  const [content, setContent] = useState('')
  const [draftName, setDraftName] = useState('')
  const [draftDescription, setDraftDescription] = useState('')
  const [draftScope, setDraftScope] = useState<'project' | 'user'>('project')
  const [savingSkill, setSavingSkill] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''
      const res = await api.get<SkillsListResponse>(`/skills${query}`)
      setSkills(res.skills ?? [])
      if (selected) {
        const next = (res.skills ?? []).find((s) => s.scope === selected.scope && s.name === selected.name) ?? null
        setSelected(next)
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [cwd, selected])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const skillNames = useMemo(() => Array.from(new Set(skills.map((s) => s.name))).sort((a, b) => a.localeCompare(b)), [skills])

  const toggleEnabled = (name: string) => {
    const exists = enabledSkills.includes(name)
    onEnabledSkillsChange(exists ? enabledSkills.filter((s) => s !== name) : [...enabledSkills, name].sort((a, b) => a.localeCompare(b)))
  }

  const openSkill = async (skill: SkillRecord) => {
    setError(null)
    try {
      const query = skill.scope === 'project' && cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''
      const res = await api.get<{ skill: SkillRecord }>(`/skills/${skill.scope}/${encodeURIComponent(skill.name)}${query}`)
      setSelected(res.skill)
      setContent(res.skill.content ?? '')
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const createNewSkill = async () => {
    const name = draftName.trim()
    if (!name) return
    setSavingSkill(true)
    setError(null)
    try {
      const res = await api.post<{ skill: SkillRecord }>('/skills', {
        scope: draftScope,
        cwd: draftScope === 'project' ? cwd : undefined,
        name,
        description: draftDescription.trim() || undefined,
      })
      setDraftName('')
      setDraftDescription('')
      await refresh()
      await openSkill(res.skill)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSavingSkill(false)
    }
  }

  const saveSelectedSkill = async () => {
    if (!selected) return
    setSavingSkill(true)
    setError(null)
    try {
      const res = await api.put<{ skill: SkillRecord }>(`/skills/${selected.scope}/${encodeURIComponent(selected.name)}`, {
        cwd: selected.scope === 'project' ? cwd : undefined,
        content,
      })
      setSelected(res.skill)
      setContent(res.skill.content ?? content)
      await refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSavingSkill(false)
    }
  }

  const deleteSelectedSkill = async () => {
    if (!selected) return
    if (!window.confirm(`Delete ${selected.scope} skill "${selected.name}"?`)) return
    setSavingSkill(true)
    setError(null)
    try {
      const query = selected.scope === 'project' && cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''
      await api.delete(`/skills/${selected.scope}/${encodeURIComponent(selected.name)}${query}`)
      setSelected(null)
      setContent('')
      await refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSavingSkill(false)
    }
  }

  return (
    <div className="settings-skills-tab">
      <Field label="Session Skill Loading" hint="Applies when a session starts. File edits below hot-reload active sessions when the SDK supports it.">
        <div className="settings-radio-stack">
          <label><input type="radio" checked={skillLoadMode === 'default'} onChange={() => onSkillLoadModeChange('default')} /> SDK default</label>
          <label><input type="radio" checked={skillLoadMode === 'all'} onChange={() => onSkillLoadModeChange('all')} /> Enable all discovered skills</label>
          <label><input type="radio" checked={skillLoadMode === 'allowlist'} onChange={() => onSkillLoadModeChange('allowlist')} /> Enable selected skills only</label>
        </div>
      </Field>

      {skillLoadMode === 'allowlist' && (
        <div className="settings-skill-allowlist">
          {skillNames.length === 0 && <div className="settings-empty-note">No skills discovered yet.</div>}
          {skillNames.map((name) => (
            <label key={name} className="settings-skill-check">
              <input type="checkbox" checked={enabledSkills.includes(name)} onChange={() => toggleEnabled(name)} />
              <span>{name}</span>
            </label>
          ))}
        </div>
      )}

      <div className="settings-section-head">
        <span className="settings-note">{skills.length} filesystem skill{skills.length !== 1 ? 's' : ''}</span>
        <button className="btn btn-sm" onClick={() => void refresh()} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button>
      </div>
      {error && <div className="settings-error">{error}</div>}

      <div className="settings-skill-grid">
        <div className="settings-skill-list">
          {skills.length === 0 && <div className="settings-empty-note">Create a project or user skill to get starte?.</div>}
          {skills.map((skill) => (
            <button
              key={`${skill.scope}:${skill.name}`}
              className={`settings-skill-row${selected?.scope === skill.scope && selected?.name === skill.name ? ' active' : ''}`}
              onClick={() => void openSkill(skill)}
            >
              <span className="settings-skill-name">{skill.name}</span>
              <span className="settings-card-badge">{skill.scope}</span>
              {!skill.valid && <span className="settings-card-badge">invalid</span>}
              <span className="settings-skill-desc">{skill.description || skill.errors[0] || 'No description'}</span>
            </button>
          ))}
        </div>

        <div className="settings-skill-editor">
          <div className="settings-card">
            <div className="settings-card-head">
              <span className="settings-card-name">New Skill</span>
            </div>
            <div className="settings-inline-fields">
              <select className="input" value={draftScope} onChange={(e) => setDraftScope(e.target.value as 'project' | 'user')}>
                <option value="project">Project</option>
                <option value="user">User</option>
              </select>
              <input className="input" placeholder="skill-name" value={draftName} onChange={(e) => setDraftName(e.target.value)} />
            </div>
            <input className="input" placeholder="Description" value={draftDescription} onChange={(e) => setDraftDescription(e.target.value)} />
            <button className="btn btn-sm" onClick={() => void createNewSkill()} disabled={savingSkill || !draftName.trim()}>Create</button>
          </div>

          {selected ? (
            <div className="settings-card settings-skill-edit-card">
              <div className="settings-card-head">
                <span className="settings-card-name">{selected.name}</span>
                <span className="settings-card-badge">{selected.scope}</span>
              </div>
              <div className="settings-card-path">{selected.path}</div>
              {selected.errors.length > 0 && (
                <div className="settings-error">{selected.errors.join('; ')}</div>
              )}
              <textarea className="input settings-skill-textarea" value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false} />
              <div className="settings-actions-row">
                <button className="btn btn-sm primary" onClick={() => void saveSelectedSkill()} disabled={savingSkill}>Save Skill</button>
                <button className="btn btn-sm" onClick={() => void deleteSelectedSkill()} disabled={savingSkill}>Delete</button>
              </div>
            </div>
          ) : (
            <div className="settings-empty-note">Select a skill to edit its SKILL.m?.</div>
          )}
        </div>
      </div>
    </div>
  )
}
function McpTab({
  servers, onAdd, onEdit, onDelete, onToggle, onRefresh,
}: {
  servers: McpServerConfigMeta[]
  onAdd: () => void
  onEdit: (s: McpServerConfigMeta) => void
  onDelete: (name: string) => void
  onToggle: (name: string, enabled: boolean) => void
  onRefresh: () => void | Promise<void>
}) {
  return (
    <>
      <div className="settings-section-head settings-mcp-head">
        <span className="settings-note settings-mcp-count">
          {servers.length} server{servers.length !== 1 ? 's' : ''} configured
        </span>
        <button className="btn btn-sm" onClick={onAdd}>
          + Add Server
        </button>
      </div>
      {servers.length === 0 && (
        <div className="settings-empty-note settings-mcp-empty">
          No MCP servers configure?. Click "Add Server" to get starte?.
        </div>
      )}
      {servers.map((srv) => (
        <McpCard key={srv.name} server={srv} onEdit={onEdit} onDelete={onDelete} onToggle={onToggle} onRefresh={onRefresh} />
      ))}
    </>
  )
}

function McpCard({
  server, onEdit, onDelete, onToggle, onRefresh,
}: {
  server: McpServerConfigMeta
  onEdit: (s: McpServerConfigMeta) => void
  onDelete: (name: string) => void
  onToggle: (name: string, enabled: boolean) => void
  onRefresh: () => void | Promise<void>
}) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [testing, setTesting] = useState(false)
  const [authBusy, setAuthBusy] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [testResult, setTestResult] = useState<McpConnectionTestResult | null>(null)

  const isRemote = server.type !== 'stdio'
  const currentTools = testResult?.tools ?? []
  const status = testResult?.status ?? (server.enabled === false ? 'disabled' : server.oauthAuthorized ? 'authorized' : 'idle')
  const statusColor = status === 'connected'
    ? 'var(--ok)'
    : status === 'needs-auth'
      ? 'var(--warn)'
      : status === 'failed'
        ? 'var(--danger)'
        : server.enabled !== false
          ? 'var(--plugin-active)'
          : 'var(--plugin-inactive)'

  const runTest = async () => {
    setTesting(true)
    try {
      const r = await api.post<{ result: McpConnectionTestResult }>(
        `/mcp-config/${encodeURIComponent(server.name)}/test`,
        undefined,
        { timeoutMs: 15_000 },
      )
      setTestResult(r.result)
    } catch (e) {
      setTestResult({
        success: false,
        status: 'failed',
        error: (e as Error).message,
      })
    } finally {
      setTesting(false)
    }
  }

  const listTools = async () => {
    setTesting(true)
    setToolsOpen(true)
    try {
      const r = await api.get<{ result: McpConnectionTestResult; tools: McpServerTool[] }>(
        `/mcp-config/${encodeURIComponent(server.name)}/tools`,
        { timeoutMs: 15_000 },
      )
      setTestResult({ ...r.result, tools: r.tools, toolCount: r.tools.length })
    } catch (e) {
      setTestResult({
        success: false,
        status: 'failed',
        tools: [],
        toolCount: 0,
        error: (e as Error).message,
      })
    } finally {
      setTesting(false)
    }
  }

  const startAuth = async () => {
    setAuthBusy(true)
    try {
      const r = await api.post<{ authorizationUrl: string }>(
        `/mcp-config/${encodeURIComponent(server.name)}/auth/start`,
        undefined,
        { timeoutMs: 15_000 },
      )
      window.open(r.authorizationUrl, '_blank', 'noopener,noreferrer')
      setTestResult({
        success: false,
        status: 'needs-auth',
        authRequired: true,
        error: 'Authorization window opene?. After finishing auth, this list refreshes automatically; click Test to verify.',
      })
    } catch (e) {
      setTestResult({ success: false, status: 'failed', error: (e as Error).message })
    } finally {
      setAuthBusy(false)
    }
  }

  const clearAuth = async () => {
    setAuthBusy(true)
    try {
      await api.delete(`/mcp-config/${encodeURIComponent(server.name)}/auth`)
      await onRefresh()
      setTestResult(null)
    } catch (e) {
      setTestResult({ success: false, status: 'failed', error: (e as Error).message })
    } finally {
      setAuthBusy(false)
    }
  }

  return (
    <div className="settings-card settings-mcp-card">
      <div className="settings-card-head settings-mcp-card-head">
        <span className="settings-card-dot" style={{ '--dot': statusColor } as CSSProperties} />
        <span className="settings-card-name">
          {server.name}
        </span>
        <span className="settings-card-badge">
          {server.type}
        </span>
        {server.oauthAuthorized && <span className="settings-card-badge global">auth</span>}
        {testResult?.toolCount != null && (
          <span className="settings-card-meta">{testResult.toolCount} tool{testResult.toolCount !== 1 ? 's' : ''}</span>
        )}
        <div className="settings-mcp-actions">
          <button className="btn btn-sm" onClick={() => void runTest()} disabled={testing || authBusy}>
            {testing ? 'Testing...' : 'Test'}
          </button>
          <button className="btn btn-sm" onClick={() => void listTools()} disabled={testing || authBusy}>
            List tools
          </button>
          {isRemote && (
            <button className="btn btn-sm" onClick={() => void startAuth()} disabled={testing || authBusy}>
              {authBusy ? 'Auth...' : server.oauthAuthorized ? 'Re-auth' : 'Auth'}
            </button>
          )}
          {isRemote && server.oauthAuthorized && (
            <button className="btn btn-sm btn-danger" onClick={() => void clearAuth()} disabled={testing || authBusy}>
              Clear auth
            </button>
          )}
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
            <button className="btn btn-sm btn-danger" onClick={() => setConfirmDelete(true)}>
              Del
            </button>
          ) : (
            <div className="settings-mcp-confirm">
              <button
                className="btn btn-sm btn-danger"
                onClick={() => { onDelete(server.name); setConfirmDelete(false) }}
              >
                Confirm
              </button>
              <button className="btn btn-sm" onClick={() => setConfirmDelete(false)} aria-label="Cancel">
                <IconX size={12} />
              </button>
            </div>
          )}
        </div>
      </div>
      {(server.command || server.url) && (
        <div className="settings-card-path settings-mcp-path" title={server.type === 'stdio' ? `${server.command} ${(server.args ?? []).join(' ')}` : server.url}>
          {server.type === 'stdio'
            ? `${server.command} ${(server.args ?? []).join(' ')}`
            : server.url}
        </div>
      )}
      {testResult && (
        <div className={`settings-mcp-result status-${testResult.status}`}>
          {testResult.success ? (
            <>
              <span><IconCheck size={12} /> Connected</span>
              {testResult.serverInfo?.name && <span>{testResult.serverInfo.name}</span>}
              {testResult.serverInfo?.version && <span>{testResult.serverInfo.version}</span>}
            </>
          ) : (
            <>
              <span>{testResult.status === 'needs-auth' ? 'Auth required' : 'Connection failed'}</span>
              {testResult.error && <span className="settings-mcp-result-error">{testResult.error}</span>}
            </>
          )}
        </div>
      )}
      {toolsOpen && (
        <McpToolsList tools={currentTools} loading={testing} onClose={() => setToolsOpen(false)} />
      )}
    </div>
  )
}

function McpToolsList({ tools, loading, onClose }: { tools: McpServerTool[]; loading: boolean; onClose: () => void }) {
  return (
    <div className="settings-card-body settings-mcp-tools">
      <div className="settings-mcp-tools-head">
        <span className="settings-card-grouplabel">Tools</span>
        <button className="btn btn-xs" onClick={onClose}>Hide</button>
      </div>
      {loading && <div className="settings-card-desc">Loading tools...</div>}
      {!loading && tools.length === 0 && <div className="settings-card-desc">No tools returned by this server.</div>}
      {!loading && tools.map((tool) => (
        <div key={tool.name} className="settings-card-item settings-mcp-tool-item">
          <code>{tool.name}</code>
          {tool.annotations?.readOnly && <span className="settings-tag readonly">read-only</span>}
          {tool.annotations?.destructive && <span className="settings-tag destructive">destructive</span>}
          {tool.annotations?.openWorld && <span className="settings-tag openworld">open-world</span>}
          {tool.description && <span className="settings-card-desc">{tool.description}</span>}
        </div>
      ))}
    </div>
  )
}

// — Logs tab ??????????????

/** Runtime log-level / scope-filter control and file-logging toggle.
 *  Level/scopes are in-memory only (reset on restart). File logging is
 *  persisted to config.json. */
function LogsTab() {
  const [config, setConfig] = useState<LogConfig | null>(null)
  const [scopesInput, setScopesInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  // — File logging state ?
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
    return <div style={{ padding: 16, color: 'var(--fg-muted)' }}>Loading log config...</div>
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
        hint="Threshold - only messages at this level or higher get printe?. Affects all scopes."
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
          {fileBusy ? '...' : fileLogEnabled ? 'ON' : 'OFF'}
        </button>
      </Field>

      {err && <div className="modal-error" style={{ marginTop: 12 }}>{err}</div>}
      {savedAt && !err && (
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--ok)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <IconCheck size={12} /> Updated
        </div>
      )}
    </div>
  )
}

// — About / Updates ????????????
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
  /** Force a fresh probe. The optional argument lets the caller probe a
   *  registry the user has type but not yet saved — passed by "Check now"
   *  so the result reflects the in-progress edit rather than the stale
   *  saved value. */
  onRefresh?: (registryOverride?: string) => void
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
  // The on-disk package was upgraded but the running process is still the old
  // build (in-app update applied, restart pending). Uses the same version
  // comparison as the server's `updateApplied` so the two ends agree — a
  // strict "installed is newer than running", NOT a bare inequality (which
  // would also fire on a downgrade and mislabel it "newer version").
  const restartPending =
    !!info?.installed && !!info.current && isVersionNewer(info.current, info.installed)
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
        if (res.updateApplied) {
          // The on-disk package was verifiably upgraded — tell the user the
          // exact version that landed and that a restart applies it.
          toast.success(
            `Installed ${res.installedVersion ?? res.latest ?? 'the latest version'} on disk - restart the server to apply.`,
          )
        } else {
          // Install ran but the on-disk version didn't advance — npm reported
          // the package was already current (a no-op), or the on-disk version
          // couldn't be confirmed. Either way, nothing to restart for.
          toast.info(
            res.installedVersion
              ? `Already on the latest version (${res.installedVersion}).`
              : 'Install completed, but the new version could not be confirmed on disk.',
          )
        }
        onRefresh?.()
      } else {
        // Server declined to install (npx / unknown). Point the user at the
        // copy-command instead.
        toast.info('In-app update is not available for this install - copy the command below.')
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
      <Field
        label="Running version"
        hint={restartPending ? undefined : 'The version of the currently running server process.'}
      >
        <div style={{ fontSize: 13, fontFamily: 'var(--mono)' }}>
          {info?.current ?? '?'}
        </div>
      </Field>
      {restartPending && (
        <Field
          label="Installed on disk"
          hint="A newer version was installed but the running server is still the old one."
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, fontFamily: 'var(--mono)' }}>
              {info?.installed}
            </span>
            <span
              style={{
                fontSize: 11,
                padding: '2px 8px',
                borderRadius: 10,
                background: 'var(--ok)',
                color: 'var(--on-accent)',
              }}
            >
              restart to apply
            </span>
          </div>
        </Field>
      )}
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
              ? '?'
              : info?.latest ?? (info?.checking ? 'checking...' : '?')}
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
            <span style={{ fontSize: 12, color: 'var(--ok)', display: 'inline-flex', alignItems: 'center', gap: 4 }}><IconCheck size={12} /> up to date</span>
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
          // Probe the CURRENTLY-TYPED registry, not the saved value - the
          // user may be editing the field and wants to validate the new URL
          // before committing it with Save. We no longer gate on the saved
          // `disabled` snapshot; instead we gate on the live input being
          // empty (probing an empty registry just yields `disabled` again).
          onClick={() => onRefresh?.(registry)}
          disabled={refreshing || !onRefresh || !registry.trim() || updating}
          title={!registry.trim() ? 'Enter a registry URL above first.' : undefined}
        >
          {refreshing ? 'Checking...' : 'Check now'}
        </button>
        {canUpdateInApp && (
          <button
            className="btn btn-primary"
            onClick={() => void runUpdate()}
            disabled={updating || refreshing}
            title="Run `npm i -g <package>@latest` on the server, then restart to apply."
          >
            {updating ? 'Updating...' : 'Update now'}
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

// — Shared primitives ???????????

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
