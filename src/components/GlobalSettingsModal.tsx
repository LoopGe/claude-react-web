// Global application settings modal. Edits config.json fields and manages
// MCP server configs. All changes are persisted server-side on Save.

import { cloneElement, isValidElement, lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react'
import { api } from '../hooks/useApi'
import { parseSkillContent } from '../utils/skill-frontmatter'
import { useAutoHeightTransition } from '../hooks/useAutoHeightTransition'
import { formatBytes } from '../utils/format'
import { IconX, IconCheck, IconChevronDown, IconFolder, IconDownload, IconRefresh, IconFileText, IconSparkles, IconTerminal } from './icons/ToolIcons'
import { EmptyState } from './EmptyState'
import { buildUpgradeCommand } from '../utils/upgrade-command'
import type { FullServerConfig } from '../types/config'
import { ProfilesSettingsTab } from './ProfilesSettingsTab'
import type { SkillImportFile, SkillImportResponse, SkillLoadMode, SkillRecord, SkillsListResponse } from '../../shared/skills'
import type { McpConnectionTestResult, McpServerConfigMeta, McpServerTool } from '../types'
import { useOverlayScrollbar } from '../hooks/useOverlayScrollbar'
import { useMergedRef } from '../utils/mergedRef'
import { useToast } from '../hooks/useToast'
import { useExitPresence, usePresenceValue } from '../hooks/useExitPresence'
import { DirectoryPicker } from './DirectoryPicker'
import { Overlay } from './Overlay'
import { McpToolsList, firstPartyToolDefsAsMcpTools } from './McpToolsList'
import type { FirstPartyToolServerInfo } from '../../shared/first-party'
import type { PublishedVersions, UpdateActionResult, UpdateInfo } from '../../shared/update-info'
import { isUpdateNagNeeded, isVersionNewer } from '../../shared/update-info'

// MarketplaceTab pulls in catalog-rendering UI; McpInstaller is a heavy
// modal-within-modal. Both are only opened on demand from inside the
// settings dialog, so we load them lazily so the global-settings chunk
// isn't carrying their weight on every open.
const McpInstaller = lazy(() =>
  import('./McpInstaller').then((m) => ({ default: m.McpInstaller })),
)
const ResetConfigDialog = lazy(() =>
  import('./ResetConfigDialog').then((m) => ({ default: m.ResetConfigDialog })),
)
const MarketplaceTab = lazy(() =>
  import('./MarketplaceTab').then((m) => ({ default: m.MarketplaceTab })),
)
// AppPluginsTab pulls in the plugin registry + management surface;
// lazy-load so the weight only lands when the user opens the "App Plugins" tab.
const AppPluginsTab = lazy(() =>
  import('./AppPluginsTab').then((m) => ({ default: m.AppPluginsTab })),
)
const McpExportDialog = lazy(() =>
  import('./McpExportDialog').then((m) => ({ default: m.McpExportDialog })),
)
const McpImportDialog = lazy(() =>
  import('./McpImportDialog').then((m) => ({ default: m.McpImportDialog })),
)
// ShareTab pulls in the `qrcode` dependency — lazy-load it so that weight
// only lands when the user opens the "Open on phone" tab.
const ShareTab = lazy(() =>
  import('./ShareTab').then((m) => ({ default: m.ShareTab })),
)

type Tab = 'profiles' | 'server' | 'skills' | 'mcp' | 'marketplace' | 'app-plugins' | 'share' | 'logs' | 'about'

type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace'

interface DragFileEntry extends FileSystemEntry {
  file(callback: (file: File) => void, errorCallback?: (error: DOMException) => void): void
}

interface DragDirectoryReader {
  readEntries(callback: (entries: FileSystemEntry[]) => void, errorCallback?: (error: DOMException) => void): void
}

interface DragDirectoryEntry extends FileSystemEntry {
  createReader(): DragDirectoryReader
}


interface DroppedSkillFile {
  file: File
  path: string
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
  /** Trigger the in-app update; resolves with the action result. With a
   *  `version` arg it pins that published release (version switcher). */
  onUpdate?: (version?: string) => Promise<UpdateActionResult>
  /** Published-versions list for the About-tab version switcher. */
  versions?: PublishedVersions | null
  /** True while the versions list is fetching. */
  versionsLoading?: boolean
  /** Error from the most recent versions fetch. */
  versionsError?: string | null
  /** Fetch the published-versions list (on demand when the switcher opens). */
  onFetchVersions?: (force?: boolean) => void
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
  versions,
  versionsLoading,
  versionsError,
  onFetchVersions,
}: Props) {
  const [tab, setTab] = useState<Tab>('profiles')
  const settingsBodyRef = useRef<HTMLDivElement | null>(null)
  const setSettingsBodyOs = useOverlayScrollbar({ autoHide: 'leave' })
  const settingsBodyRefMerged = useMergedRef(settingsBodyRef, setSettingsBodyOs)
  const settingsContentRef = useRef<HTMLDivElement | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // — Server tab state ?
  const [maxUploadBytes, setMaxUploadBytes] = useState(0)
  const [historyCap, setHistoryCap] = useState(500)
  const [maxOpenPanels, setMaxOpenPanels] = useState(3)
  const [workingStuckMs, setWorkingStuckMs] = useState(0)
  const [defaultCwd, setDefaultCwd] = useState('')
  // Global UI-pref defaults (Server tab). Sessions without an explicit
  // per-session override inherit these. Sent as literal booleans — never
  // `|| null`, which PUT /config would treat as "delete key".
  const [showPinnedUserMessage, setShowPinnedUserMessage] = useState(true)
  const [autoRecap, setAutoRecap] = useState(true)
  const [allowSensitivePathEdits, setAllowSensitivePathEdits] = useState(false)

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
  const [showMcpExport, setShowMcpExport] = useState(false)
  const [showMcpImport, setShowMcpImport] = useState(false)
  const [mcpImportFile, setMcpImportFile] = useState<File | null>(null)
  const mcpImportInputRef = useRef<HTMLInputElement>(null)
  // Global first-party tool defaults (MCP tab). Staged like every other
  // field: edited locally, persisted as the structured `firstPartyTools`
  // key by the unified Save (the server derives the legacy `appToolsGit`
  // boolean from it at load — only the structured form is ever written).
  const [firstPartyTools, setFirstPartyTools] = useState<Record<string, { enabled: boolean }>>({})
  const mcpInstallerPresence = useExitPresence(showMcpInstaller)
  const [showResetConfig, setShowResetConfig] = useState(false)
  const resetConfigPresence = useExitPresence(showResetConfig)

  // Load full config on mount
  useEffect(() => {
    const ac = new AbortController()
    ;(async () => {
      try {
        const cfg = await api.get<FullServerConfig>('/config/full', { signal: ac.signal })
        setMaxUploadBytes(cfg.maxUploadBytes ?? 0)
        setHistoryCap(cfg.historyCap ?? 500)
        setMaxOpenPanels(cfg.maxOpenPanels ?? 3)
        setWorkingStuckMs(cfg.workingStuckMs ?? 0)
        setUpdateCheckRegistry(cfg.updateCheckRegistry ?? '')
        setDefaultCwd(cfg.defaults?.cwd ?? '')
        setSkillLoadMode(cfg.skillLoadMode ?? 'default')
        setEnabledSkills(cfg.enabledSkills ?? [])
        setShowPinnedUserMessage(cfg.showPinnedUserMessage ?? true)
        setAutoRecap(cfg.autoRecap ?? true)
        setAllowSensitivePathEdits(cfg.allowSensitivePathEdits ?? false)
        setFirstPartyTools(cfg.firstPartyTools ?? {})
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

  /** Stage a first-party default toggle. Local only — persisted by the
   *  unified Save as the structured `firstPartyTools` key. */
  const toggleFirstPartyDefault = (name: string, enabled: boolean) => {
    setFirstPartyTools((prev) => ({ ...prev, [name]: { enabled } }))
  }

  const handleSave = async () => {
    setSaving(true)
    setErr(null)
    try {
      const updates: Record<string, unknown> = {
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
        // Literal booleans — PUT /config treats null/'' as "delete key",
        // so `false` must be sent explicitly to persist a real OFF default.
        showPinnedUserMessage,
        autoRecap,
        allowSensitivePathEdits,
      }
      // Structured first-party defaults — written verbatim as the single
      // source of truth (legacy `appToolsGit` is never written; the server
      // derives it). An empty map is omitted rather than persisted.
      if (Object.keys(firstPartyTools).length > 0) {
        updates.firstPartyTools = { ...firstPartyTools }
      }
      await api.put('/config', updates)
      onSaved?.()
      onClose()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setSaving(false)
    }
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
    { key: 'profiles', label: 'Profiles' },
    { key: 'server', label: 'Server' },
    { key: 'skills', label: 'Skills' },
    { key: 'mcp', label: 'MCP Servers' },
    { key: 'marketplace', label: 'Marketplace' },
    { key: 'app-plugins', label: 'App Plugins' },
    { key: 'share', label: 'Open on phone' },
    { key: 'logs', label: 'Logs' },
    { key: 'about', label: 'About' },
  ]

  const heightAnimationKey = [
    tab,
    loading,
    err ?? '',
    mcpServers.length,
    skillLoadMode,
    enabledSkills.join(','),
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
    <Overlay
      variant="globalSettings"
      ariaLabel="Settings"
      open={open}
      onClose={onClose}
      // The card carries `inert` while closed (it stays mounted through the
      // exit animation); `inertOnExit` applies the same flag for that window.
      inertOnExit
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

        <div ref={settingsBodyRefMerged} className="global-settings-body">
          <div ref={settingsContentRef} className="global-settings-body-content" data-animate={tab}>
          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--fg-muted)' }}>Loading...</div>
          ) : (
            <>
              {tab === 'profiles' && (
                <ProfilesSettingsTab />
              )}
              {tab === 'server' && (
                <ServerTab
                  maxUploadBytes={maxUploadBytes}
                  historyCap={historyCap}
                  maxOpenPanels={maxOpenPanels}
                  workingStuckMs={workingStuckMs}
                  showPinnedUserMessage={showPinnedUserMessage}
                  autoRecap={autoRecap}
                  allowSensitivePathEdits={allowSensitivePathEdits}
                  onMaxUploadBytesChange={setMaxUploadBytes}
                  onHistoryCapChange={setHistoryCap}
                  onMaxOpenPanelsChange={setMaxOpenPanels}
                  onWorkingStuckMsChange={setWorkingStuckMs}
                  onShowPinnedUserMessageChange={setShowPinnedUserMessage}
                  onAutoRecapChange={setAutoRecap}
                  onAllowSensitivePathEditsChange={setAllowSensitivePathEdits}
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
                  firstPartyTools={firstPartyTools}
                  onToggleFirstParty={toggleFirstPartyDefault}
                  onAdd={() => { setMcpInstallerEdit(undefined); setShowMcpInstaller(true) }}
                  onEdit={(s) => { setMcpInstallerEdit(s); setShowMcpInstaller(true) }}
                  onDelete={deleteMcpServer}
                  onToggle={toggleMcpServer}
                  onRefresh={refreshMcp}
                  onImport={() => mcpImportInputRef.current?.click()}
                  onExport={() => setShowMcpExport(true)}
                />
              )}
              {tab === 'marketplace' && (
                <Suspense fallback={<div className="lazy-tab-loading">Loading marketplace...</div>}>
                  <MarketplaceTab />
                </Suspense>
              )}
              {tab === 'app-plugins' && (
                <Suspense fallback={<div className="lazy-tab-loading">Loading app plugins...</div>}>
                  <AppPluginsTab />
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
                  versions={versions ?? null}
                  versionsLoading={!!versionsLoading}
                  versionsError={versionsError ?? null}
                  onFetchVersions={onFetchVersions}
                  onOpenResetConfig={() => setShowResetConfig(true)}
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

        {showMcpExport && (
          <Suspense fallback={null}>
            <McpExportDialog
              open={showMcpExport}
              servers={mcpServers}
              onClose={() => setShowMcpExport(false)}
            />
          </Suspense>
        )}

        <input
          ref={mcpImportInputRef}
          type="file"
          accept=".json,application/json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) { setMcpImportFile(f); setShowMcpImport(true) }
            e.target.value = ''
          }}
        />
        {showMcpImport && (
          <Suspense fallback={null}>
            <McpImportDialog
              open={showMcpImport}
              file={mcpImportFile}
              onClose={() => setShowMcpImport(false)}
              onImported={() => void refreshMcp()}
            />
          </Suspense>
        )}

        {resetConfigPresence.shouldRender && (
          <Suspense fallback={null}>
            <ResetConfigDialog open={showResetConfig} onClose={() => setShowResetConfig(false)} />
          </Suspense>
        )}
    </Overlay>
  )
}

// ── Tab contents ─────────────────────────────────────────────────

function ServerTab({
  maxUploadBytes, historyCap, maxOpenPanels, workingStuckMs,
  showPinnedUserMessage, autoRecap, allowSensitivePathEdits,
  onMaxUploadBytesChange, onHistoryCapChange, onMaxOpenPanelsChange,
  onWorkingStuckMsChange,
  onShowPinnedUserMessageChange, onAutoRecapChange,
  onAllowSensitivePathEditsChange,
}: {
  maxUploadBytes: number
  historyCap: number
  maxOpenPanels: number
  workingStuckMs: number
  showPinnedUserMessage: boolean
  autoRecap: boolean
  allowSensitivePathEdits: boolean
  onMaxUploadBytesChange: (v: number) => void
  onHistoryCapChange: (v: number) => void
  onMaxOpenPanelsChange: (v: number) => void
  onWorkingStuckMsChange: (v: number) => void
  onShowPinnedUserMessageChange: (v: boolean) => void
  onAutoRecapChange: (v: boolean) => void
  onAllowSensitivePathEditsChange: (v: boolean) => void
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
      <div className="settings-section">
        <h4>Preferences (global defaults)</h4>
        <span className="hint" style={{ display: 'block', marginBottom: 8 }}>
          Defaults for every session. Individual sessions can override these in
          their own Settings panel.
        </span>
        <div className="settings-field">
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={showPinnedUserMessage}
              onChange={(e) => onShowPinnedUserMessageChange(e.target.checked)}
            />
            <span>Show pinned "current question" header</span>
          </label>
          <span className="hint">
            Pins the user message of the turn in view at the top of the chat
            when it scrolls out of sight.
          </span>
        </div>
        <div className="settings-field">
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={autoRecap}
              onChange={(e) => onAutoRecapChange(e.target.checked)}
            />
            <span>Auto-generate session recap</span>
          </label>
          <span className="hint">
            Automatically produces a session summary after the conversation has
            been idle. Manual recap (Alt+R) still works when this is off.
          </span>
        </div>
      </div>
      <div className="settings-section">
        <h4>Permissions (global)</h4>
        <span className="hint" style={{ display: 'block', marginBottom: 8 }}>
          Relaxes the sensitive-path safety check that still prompts in
          acceptEdits and bypassPermissions modes.
        </span>
        <div className="settings-field">
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={allowSensitivePathEdits}
              onChange={(e) => onAllowSensitivePathEditsChange(e.target.checked)}
            />
            <span>Allow editing sensitive paths in auto-approve modes</span>
          </label>
          <span className="hint">
            When on, acceptEdits and bypassPermissions also auto-approve edits
            and commands targeting <code>.git/</code>, <code>.claude/</code>,{' '}
            <code>.vscode/</code>, <code>.idea/</code>, and shell/git config
            files instead of prompting. Off (default) keeps the safe behavior.
            Plan review (ExitPlanMode) and questions (AskUserQuestion) still
            prompt regardless.
          </span>
        </div>
      </div>
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
  const [notice, setNotice] = useState<string | null>(null)
  const [previewSkill, setPreviewSkill] = useState<SkillRecord | null>(null)
  const [importScope, setImportScope] = useState<'project' | 'user'>('project')
  const [importPath, setImportPath] = useState('')
  const [importName, setImportName] = useState('')
  const [overwriteImport, setOverwriteImport] = useState(false)
  const [showImportPicker, setShowImportPicker] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const [importingSkill, setImportingSkill] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const directoryInputProps = { webkitdirectory: '', directory: '' } as Record<string, string>

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''
      const res = await api.get<SkillsListResponse>(`/skills${query}`)
      setSkills(res.skills ?? [])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [cwd])

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0)
    return () => window.clearTimeout(timer)
  }, [refresh])

  // Keep the SkillRecord alive during the exit animation so the modal
  // can render its content while the CSS outro plays.
  const previewPresence = usePresenceValue(previewSkill)
  const previewIsOpen = previewSkill !== null

  const skillNames = useMemo(() => Array.from(new Set(skills.map((s) => s.name))).sort((a, b) => a.localeCompare(b)), [skills])
  const userSkills = skills.filter((skill) => skill.scope === 'user')
  const projectSkills = skills.filter((skill) => skill.scope === 'project')
  const invalidCount = skills.filter((skill) => !skill.valid).length

  const parsed = useMemo(
    () => (previewPresence.value?.content ? parseSkillContent(previewPresence.value.content) : null),
    [previewPresence.value?.content],
  )
  const hasFields = parsed ? Object.keys(parsed.frontmatter).length > 0 : false

  const toggleEnabled = (name: string) => {
    const exists = enabledSkills.includes(name)
    onEnabledSkillsChange(exists ? enabledSkills.filter((s) => s !== name) : [...enabledSkills, name].sort((a, b) => a.localeCompare(b)))
  }

  const openSkill = async (skill: SkillRecord) => {
    setError(null)
    setNotice(null)
    try {
      const query = skill.scope === 'project' && cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''
      const res = await api.get<{ skill: SkillRecord }>(`/skills/${skill.scope}/${encodeURIComponent(skill.name)}${query}`)
      setPreviewSkill(res.skill)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const finishImport = async (result: SkillImportResponse) => {
    setNotice(`Imported ${result.skill.scope} skill "${result.skill.name}" from ${result.importedFiles} file${result.importedFiles !== 1 ? 's' : ''}.`)
    setImportName('')
    await refresh()
    await openSkill(result.skill)
  }

  const importFromServerPath = async (path: string = importPath) => {
    const trimmedPath = path.trim()
    if (!trimmedPath) return
    setImportingSkill(true)
    setError(null)
    setNotice(null)
    try {
      const result = await api.post<SkillImportResponse>('/skills/import/path', {
        scope: importScope,
        cwd: importScope === 'project' ? cwd : undefined,
        path: trimmedPath,
        name: importName.trim() || undefined,
        overwrite: overwriteImport,
      }, { timeoutMs: 60_000 })
      setImportPath(trimmedPath)
      await finishImport(result)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setImportingSkill(false)
    }
  }

  const fileToBase64 = (file: File) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const value = typeof reader.result === 'string' ? reader.result : ''
      resolve(value.includes(',') ? value.slice(value.indexOf(',') + 1) : value)
    }
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'))
    reader.readAsDataURL(file)
  })

  const importBrowserFiles = async (files: Array<File | DroppedSkillFile>) => {
    if (files.length === 0) return
    setImportingSkill(true)
    setError(null)
    setNotice(null)
    try {
      const payload: SkillImportFile[] = await Promise.all(files.map(async (item) => {
        const file = item instanceof File ? item : item.file
        const path = item instanceof File ? (file.webkitRelativePath || file.name) : item.path
        return {
          path: path.replace(/^\/+/, ''),
          data: await fileToBase64(file),
          encoding: 'base64' as const,
        }
      }))
      const result = await api.post<SkillImportResponse>('/skills/import/files', {
        scope: importScope,
        cwd: importScope === 'project' ? cwd : undefined,
        name: importName.trim() || undefined,
        overwrite: overwriteImport,
        files: payload,
      }, { timeoutMs: 60_000 })
      await finishImport(result)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setImportingSkill(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const readDroppedFile = (entry: DragFileEntry, path: string) => new Promise<DroppedSkillFile>((resolve, reject) => {
    entry.file((file) => resolve({ file, path }), reject)
  })

  const readDroppedDirectory = async (entry: DragDirectoryEntry, path: string): Promise<DroppedSkillFile[]> => {
    const reader = entry.createReader()
    const entries: FileSystemEntry[] = []
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject))
      if (batch.length === 0) break
      entries.push(...batch)
    }
    const nested = await Promise.all(entries.map((child) => readDroppedEntry(child, `${path}/${child.name}`)))
    return nested.flat()
  }

  const readDroppedEntry = async (entry: FileSystemEntry, path: string): Promise<DroppedSkillFile[]> => {
    if (entry.isFile) return [await readDroppedFile(entry as DragFileEntry, path)]
    if (entry.isDirectory) return readDroppedDirectory(entry as DragDirectoryEntry, path)
    return []
  }

  const filesFromDrop = async (dataTransfer: DataTransfer): Promise<Array<File | DroppedSkillFile>> => {
    const entries = Array.from(dataTransfer.items)
      .map((item) => item.webkitGetAsEntry())
      .filter((entry): entry is FileSystemEntry => !!entry)
    if (entries.length === 0) return Array.from(dataTransfer.files)
    const nested = await Promise.all(entries.map((entry) => readDroppedEntry(entry, entry.name)))
    return nested.flat()
  }

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragActive(false)
    void filesFromDrop(event.dataTransfer).then((files) => importBrowserFiles(files))
  }

  const loadModeOptions: Array<{ mode: SkillLoadMode; title: string; desc: string }> = [
    { mode: 'default', title: 'SDK default', desc: 'Leave skill discovery to the SDK.' },
    { mode: 'all', title: 'Enable all discovered skills', desc: 'Load every filesystem skill the SDK can discover.' },
    { mode: 'allowlist', title: 'Enable selected skills only', desc: 'Load only the checked skill names.' },
  ]

  return (
    <div className="settings-skills-tab">
      <div className="settings-skill-hero">
        <div>
          <div className="settings-skill-kicker">Skills</div>
          <h3>Manage reusable instructions</h3>
          <p>User skills live in your home profile. Project skills live under this workspace and can be shared with the repo.</p>
        </div>
        <div className="settings-skill-stats">
          <span><strong>{skills.length}</strong> total</span>
          <span><strong>{projectSkills.length}</strong> project</span>
          <span><strong>{userSkills.length}</strong> user</span>
          {invalidCount > 0 && <span className="warn"><strong>{invalidCount}</strong> invalid</span>}
        </div>
      </div>

      <div className="settings-skill-policy-card">
        <div className="settings-section-head compact">
          <div>
            <h4>Session Skill Loading</h4>
            <span className="settings-note">Applies when a session starts. File edits hot-reload active sessions when the SDK supports it.</span>
          </div>
        </div>
        <div className="settings-skill-mode-grid">
          {loadModeOptions.map((option) => (
            <label key={option.mode} className={`settings-skill-mode-card${skillLoadMode === option.mode ? ' active' : ''}`}>
              <input type="radio" checked={skillLoadMode === option.mode} onChange={() => onSkillLoadModeChange(option.mode)} />
              <span>
                <strong>{option.title}</strong>
                <small>{option.desc}</small>
              </span>
            </label>
          ))}
        </div>
        {skillLoadMode === 'allowlist' && (
          <div className="settings-skill-allowlist">
            {skillNames.length === 0 && <EmptyState icon={<IconSparkles size={16} />} title="No skills discovered yet" />}
            {skillNames.map((name) => (
              <label key={name} className={`settings-skill-check${enabledSkills.includes(name) ? ' active' : ''}`}>
                <input type="checkbox" checked={enabledSkills.includes(name)} onChange={() => toggleEnabled(name)} />
                <span>{name}</span>
              </label>
            ))}
          </div>
        )}
      </div>

      <div
        className={`settings-skill-import-card${dragActive ? ' dragging' : ''}`}
        onDragEnter={(event) => { event.preventDefault(); setDragActive(true) }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => { if (event.currentTarget === event.target) setDragActive(false) }}
        onDrop={handleDrop}
      >
        <div className="settings-skill-import-main">
          <span className="settings-skill-import-icon"><IconDownload size={16} /></span>
          <div>
            <h4>Install from folder</h4>
            <p>Choose a server-side directory or drag a local folder containing <code>SKILL.md</code>.</p>
          </div>
        </div>
        <div className="settings-skill-import-controls">
          <div className="settings-scope-toggle">
            <button
              type="button"
              className={`settings-scope-btn${importScope === 'project' ? ' active' : ''}`}
              onClick={() => setImportScope('project')}
            >
              Project
            </button>
            <button
              type="button"
              className={`settings-scope-btn${importScope === 'user' ? ' active' : ''}`}
              onClick={() => setImportScope('user')}
            >
              User
            </button>
          </div>
          <input className="input" placeholder="Optional import name" aria-label="Import name" value={importName} onChange={(e) => setImportName(e.target.value)} />
          <label className="settings-skill-overwrite"><input type="checkbox" checked={overwriteImport} onChange={(e) => setOverwriteImport(e.target.checked)} /> Replace existing</label>
        </div>
        <div className="settings-skill-path-row">
          <input className="input" placeholder="Absolute server path to a skill folder" aria-label="Server path to skill folder" value={importPath} onChange={(e) => setImportPath(e.target.value)} spellCheck={false} />
          <button className="btn" onClick={() => setShowImportPicker(true)} disabled={importingSkill}><IconFolder size={14} /> Browse</button>
          <button className="btn btn-primary" onClick={() => void importFromServerPath()} disabled={importingSkill || !importPath.trim()}>
            {importingSkill ? 'Installing…' : 'Install'}
          </button>
        </div>
        <div className="settings-actions-row settings-skill-import-actions">
          <button className="btn" onClick={() => fileInputRef.current?.click()} disabled={importingSkill}><IconFileText size={14} /> Select Local Folder</button>
          <span className="settings-note">Directory upload works in Chromium-based browsers; drag-and-drop uses the same importer.</span>
          <input
            ref={fileInputRef}
            className="settings-skill-file-input"
            type="file"
            multiple
            onChange={(event) => void importBrowserFiles(Array.from(event.currentTarget.files ?? []))}
            {...directoryInputProps}
          />
        </div>
      </div>

      <div className="settings-section-head">
        <span className="settings-note">{skills.length} filesystem skill{skills.length !== 1 ? 's' : ''}</span>
        <button className="btn" onClick={() => void refresh()} disabled={loading}><IconRefresh size={14} /> {loading ? 'Refreshing…' : 'Refresh'}</button>
      </div>
      {error && <div className="settings-error">{error}</div>}
      {notice && <div className="settings-success">{notice}</div>}

      <div className="settings-skill-grid">
        <div className="settings-skill-list">
          {skills.length === 0 && <EmptyState icon={<IconSparkles size={16} />} title="Create or import a project/user skill to get started" />}
          {skills.map((skill) => (
            <button
              key={`${skill.scope}:${skill.name}`}
              className={`settings-skill-row${previewPresence.value?.scope === skill.scope && previewPresence.value?.name === skill.name ? ' active' : ''}${!skill.valid ? ' invalid' : ''}`}
              onClick={() => void openSkill(skill)}
            >
              <span className="settings-skill-name">{skill.name}</span>
              <span className="settings-card-badge">{skill.scope}</span>
              {!skill.valid && <span className="settings-card-badge warn">invalid</span>}
              <span className="settings-skill-desc">{skill.description || skill.errors[0] || 'No description'}</span>
              <span className="settings-skill-path-mini">{skill.relativePath || skill.path}</span>
            </button>
          ))}
        </div>
      </div>

      {previewPresence.value != null && (() => {
        const ps = previewPresence.value!
        return (
          <Overlay
            variant="modal"
            cardClassName="settings-skill-preview-modal"
            ariaLabel={`Skill preview: ${ps.name}`}
            open={previewIsOpen}
            onClose={() => setPreviewSkill(null)}
          >
              <div className="modal-header">
                <div className="settings-skill-preview-title">
                  <span className="settings-card-name">{ps.name}</span>
                  <span className="settings-card-badge">{ps.scope}</span>
                  {!ps.valid && <span className="settings-card-badge warn">invalid</span>}
                </div>
                <button className="btn-icon" aria-label="Close" onClick={() => setPreviewSkill(null)}><IconX size={14} /></button>
              </div>
              <div className="settings-card-path">{ps.path}</div>
              {ps.errors.length > 0 && (
                <div className="settings-error">{ps.errors.join('; ')}</div>
              )}
              {hasFields && (
                <div className="settings-skill-frontmatter">
                  <div className="settings-skill-frontmatter-title">Frontmatter</div>
                  <table className="settings-skill-frontmatter-table">
                    <tbody>
                      {Object.entries(parsed!.frontmatter).map(([key, value]) => (
                        <tr key={key}>
                          <td className="settings-skill-fm-key">{key}</td>
                          <td className="settings-skill-fm-value">{value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <pre className="settings-skill-preview-content">{parsed ? parsed.body : (ps.content || '')}</pre>
          </Overlay>
        )
      })()}

      {showImportPicker && (
        <DirectoryPicker
          title="Pick a skill folder"
          selectLabel="Install this folder"
          footerHint="Select a folder that contains SKILL.md"
          initialPath={importPath || cwd}
          onPick={(path) => {
            setImportPath(path)
            setShowImportPicker(false)
            void importFromServerPath(path)
          }}
          onClose={() => setShowImportPicker(false)}
        />
      )}
    </div>
  )
}
function McpTab({
  servers, firstPartyTools, onToggleFirstParty, onAdd, onEdit, onDelete, onToggle, onRefresh, onImport, onExport,
}: {
  servers: McpServerConfigMeta[]
  /** Global first-party tool defaults, staged in the modal and persisted by
   *  the unified Save (NOT saved on toggle). Hidden when the map is empty. */
  firstPartyTools: Record<string, { enabled: boolean }>
  onToggleFirstParty: (name: string, enabled: boolean) => void
  onAdd: () => void
  onEdit: (s: McpServerConfigMeta) => void
  onDelete: (name: string) => void
  onToggle: (name: string, enabled: boolean) => void
  onRefresh: () => void | Promise<void>
  onImport: () => void
  onExport: () => void
}) {
  const firstPartyEntries = Object.entries(firstPartyTools)
  // Static registry listing (names/descriptions/tools) — the first-party
  // analog of the live listTools() probe the cards above use. One fetch per
  // tab mount; cards render from the staged map even before it lands.
  const [fpInfo, setFpInfo] = useState<Record<string, FirstPartyToolServerInfo>>({})
  const [fpError, setFpError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    api.get<{ servers: FirstPartyToolServerInfo[] }>('/first-party-tools')
      .then((r) => {
        if (live) setFpInfo(Object.fromEntries(r.servers.map((s) => [s.name, s])))
      })
      .catch((e) => {
        if (live) setFpError((e as Error).message)
      })
    return () => { live = false }
  }, [])
  return (
    <>
      <div className="settings-section-head settings-mcp-head">
        <span className="settings-note settings-mcp-count">
          {servers.length} server{servers.length !== 1 ? 's' : ''} configured
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={onImport}>Import</button>
          <button className="btn" onClick={onExport}>Export</button>
          <button className="btn" onClick={onAdd}>+ Add Server</button>
        </div>
      </div>
      {servers.length === 0 && (
        <EmptyState
          icon={<IconTerminal size={16} />}
          title="No MCP servers configured"
          body='Click "Add Server" to get started.'
        />
      )}
      {servers.map((srv) => (
        <McpCard key={srv.name} server={srv} onEdit={onEdit} onDelete={onDelete} onToggle={onToggle} onRefresh={onRefresh} />
      ))}
      {firstPartyEntries.length > 0 && (
        <>
          <div className="settings-section-head compact" style={{ marginTop: 16 }}>
            <span className="settings-note">First-party tools</span>
          </div>
          <div className="settings-note">
            Global default for new sessions. Open sessions without a per-session
            override keep their current state — use the panel toggle for instant
            control.
          </div>
          {fpError && <div className="settings-mcp-tools-error">Tool listing unavailable: {fpError}</div>}
          {firstPartyEntries.map(([name, def]) => (
            <FirstPartyCard
              key={name}
              info={fpInfo[name] ?? { name, description: '', tools: [] }}
              enabled={def.enabled}
              onToggle={onToggleFirstParty}
            />
          ))}
        </>
      )}
    </>
  )
}

/** One first-party tool server as a settings card — same card system as the
 *  MCP server cards above it (dot / name / badge / meta / .btn actions), so
 *  the two lists align. `onToggle` STAGES the new value; persistence happens
 *  on the modal's Save. The static tool listing expands via the shared
 *  McpToolsList, exactly like a normal MCP server's "List tools". */
function FirstPartyCard({ info, enabled, onToggle }: {
  info: FirstPartyToolServerInfo
  enabled: boolean
  onToggle: (name: string, enabled: boolean) => void
}) {
  const [toolsOpen, setToolsOpen] = useState(false)
  return (
    <div className="settings-card settings-mcp-card settings-first-party-card">
      <div className="settings-card-head settings-mcp-card-head">
        <span className="settings-card-dot" style={{ '--dot': enabled ? 'var(--plugin-active)' : 'var(--plugin-inactive)' } as CSSProperties} />
        <span className="settings-card-name">
          {info.name}
        </span>
        <span className="settings-card-badge">built-in</span>
        {info.tools.length > 0 && (
          <span className="settings-card-meta">{info.tools.length} tool{info.tools.length !== 1 ? 's' : ''}</span>
        )}
        <div className="settings-mcp-actions">
          <button className="btn" onClick={() => setToolsOpen(!toolsOpen)} disabled={info.tools.length === 0}>
            List tools
          </button>
          <button
            className="btn settings-first-party-toggle"
            onClick={() => onToggle(info.name, !enabled)}
            title={enabled ? 'Disable' : 'Enable'}
          >
            {enabled ? 'ON' : 'OFF'}
          </button>
        </div>
      </div>
      {info.description && <div className="settings-card-note">{info.description}</div>}
      {info.error && <div className="settings-first-party-error">{info.error}</div>}
      {toolsOpen && (
        <McpToolsList tools={firstPartyToolDefsAsMcpTools(info.tools)} loading={false} onClose={() => setToolsOpen(false)} />
      )}
    </div>
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
        error: 'Authorization window opened. After finishing auth, this list refreshes automatically; click Test to verify.',
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
          <button className="btn" onClick={() => void runTest()} disabled={testing || authBusy}>
            {testing ? 'Testing...' : 'Test'}
          </button>
          <button className="btn" onClick={() => void listTools()} disabled={testing || authBusy}>
            List tools
          </button>
          {isRemote && (
            <button className="btn" onClick={() => void startAuth()} disabled={testing || authBusy}>
              {authBusy ? 'Auth...' : server.oauthAuthorized ? 'Re-auth' : 'Auth'}
            </button>
          )}
          {isRemote && server.oauthAuthorized && (
            <button className="btn btn-danger" onClick={() => void clearAuth()} disabled={testing || authBusy}>
              Clear auth
            </button>
          )}
          <button
            className="btn"
            onClick={() => onToggle(server.name, server.enabled === false)}
            title={server.enabled !== false ? 'Disable' : 'Enable'}
          >
            {server.enabled !== false ? 'ON' : 'OFF'}
          </button>
          <button className="btn" onClick={() => onEdit(server)}>
            Edit
          </button>
          {!confirmDelete ? (
            <button className="btn btn-danger" onClick={() => setConfirmDelete(true)}>
              Del
            </button>
          ) : (
            <div className="settings-mcp-confirm">
              <button
                className="btn btn-danger"
                onClick={() => { onDelete(server.name); setConfirmDelete(false) }}
              >
                Confirm
              </button>
              <button className="btn" onClick={() => setConfirmDelete(false)} aria-label="Cancel">
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
  versions,
  versionsLoading,
  versionsError,
  onFetchVersions,
  onOpenResetConfig,
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
  onUpdate?: (version?: string) => Promise<UpdateActionResult>
  /** Published-versions list for the version switcher. */
  versions: PublishedVersions | null
  versionsLoading: boolean
  versionsError: string | null
  onFetchVersions?: (force?: boolean) => void
  onOpenResetConfig?: () => void
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
  // Suppress the "Update now" nag once the on-disk `installed` version
  // already satisfies `latest` (in-app update applied, restart pending) —
  // mirrors UpdateBanner. `restartPending` below then carries the
  // "restart to apply" message, so the two states don't contradict.
  const hasUpdate = isUpdateNagNeeded(info)
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
            `Installed ${res.installedVersion ?? res.latest ?? 'the latest version'} on disk — restart the server to apply.`,
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

  // ── Version switcher ──────────────────────────────────────────────
  // Lets the user pin/roll back to any published stable version. Collapsible
  // so it doesn't clutter the normal About view; fetches the versions list
  // on first expand. For a global install the "Install" button runs the
  // pinned install in-app (with an explicit confirm — a downgrade replaces
  // the installed package). For npx/unknown there's no in-place install, so
  // we show the copy-command instead: that's the recovery command that works
  // from a terminal even when the app is bricked.
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [pickedVersion, setPickedVersion] = useState('')
  const [installVersionError, setInstallVersionError] = useState<string | null>(null)

  // The versions list comes from a separate endpoint (heavier packument
  // fetch), so we only hit it when the switcher is first opened.
  useEffect(() => {
    if (switcherOpen && onFetchVersions && !versions && !versionsLoading) {
      onFetchVersions()
    }
  }, [switcherOpen, onFetchVersions, versions, versionsLoading])

  // The selected version, defaulting to the newest published one until the
  // user picks something. Derived in render (not via a setState-in-effect)
  // so we don't trip cascading renders — the user's explicit pick, when
  // present, always wins.
  const effectivePicked = pickedVersion || versions?.versions[0] || ''

  const versionsDisabled = !!versions?.disabled
  const canInstallVersion =
    !!onUpdate &&
    !versionsLoading &&
    !updating &&
    !!effectivePicked &&
    !versionsDisabled

  const runInstallVersion = async () => {
    if (!onUpdate || !effectivePicked) return
    // Downgrade replaces the installed package — confirm explicitly, unlike
    // the no-confirm "Update now" (which only ever moves forward to latest).
    const isDowngrade = !!info?.current && effectivePicked !== info.current
    if (
      isDowngrade &&
      !window.confirm(
        `Install claude-react-web@${effectivePicked} over the current ${info?.current}? ` +
          'This replaces the installed package - restart the server to apply.',
      )
    ) {
      return
    }
    setInstallVersionError(null)
    try {
      const res = await onUpdate(effectivePicked)
      if (res.performed) {
        if (res.versionChanged) {
          toast.success(
            `Installed ${res.installedVersion ?? res.targetVersion ?? effectivePicked} on disk - restart the server to apply.`,
          )
        } else {
          toast.info(
            res.installedVersion
              ? `Already on ${res.installedVersion}.`
              : 'Install completed, but the version could not be confirmed on disk.',
          )
        }
        onFetchVersions?.(true)
        onRefresh?.()
      } else {
        toast.info('In-app install is not available for this install - copy the command below.')
      }
    } catch (e) {
      setInstallVersionError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div>
      <Field label="Project">
        <div style={{ fontSize: 13 }}>claude-react-web</div>
      </Field>
      <Field label="Source" hint="Source code, issues, and releases.">
        <a
          href="https://github.com/LoopGe/claude-react-web"
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontSize: 13, color: 'var(--accent)', textDecoration: 'none' }}
        >
          github.com/LoopGe/claude-react-web
        </a>
      </Field>
      <Field
        label="Running version"
        hint={
          info?.deprecated
            ? typeof info.deprecated === 'string'
              ? info.deprecated
              : 'This version has been deprecated by the maintainer.'
            : restartPending
              ? undefined
              : 'The version of the currently running server process.'
        }
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13, fontFamily: 'var(--mono)' }}>
            {info?.current ?? '?'}
          </span>
          {info?.deprecated && (
            <span
              style={{
                fontSize: 11,
                padding: '2px 8px',
                borderRadius: 'var(--radius-lg)',
                background: 'var(--danger)',
                color: 'var(--bg)',
              }}
            >
              deprecated
            </span>
          )}
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
                borderRadius: 'var(--radius-lg)',
                background: 'var(--ok)',
                color: 'var(--on-accent)',
              }}
            >
              restart to apply
            </span>
          </div>
        </Field>
      )}
      {/* Claude Code CLI version — read from `<binary> --version` on the
          server. Reuses the same probe + cache as GET /health/claude, so
          this adds zero extra spawns on the happy path. We surface the
          binary path too so a "wrong CLI" footgun (multiple installs) is
          easy to diagnose without leaving this tab. */}
      {info?.claudeCli && (
        <Field
          label="Claude Code CLI"
          hint={
            info.claudeCli.binary
              ? `Detected at ${info.claudeCli.binary}`
              : 'CLI binary not detected on this server.'
          }
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, fontFamily: 'var(--mono)' }}>
              {info.claudeCli.ok ? info.claudeCli.version ?? 'unknown' : 'not detected'}
            </span>
            {!info.claudeCli.ok && info.claudeCli.error && (
              <span style={{ fontSize: 12, color: 'var(--danger)' }}>
                {info.claudeCli.error}
              </span>
            )}
          </div>
        </Field>
      )}
      {/* @anthropic-ai/claude-agent-sdk version — read once from
          node_modules at process start and cached. Hidden when the SDK
          can't be resolved (unusual install layout); the rest of the
          panel still works. */}
      {info?.agentSdk && (
        <Field
          label="Agent SDK"
          hint="Version of @anthropic-ai/claude-agent-sdk resolved from this server's node_modules."
        >
          <div style={{ fontSize: 13, fontFamily: 'var(--mono)' }}>
            {info.agentSdk.version}
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
              ? '—'
              : info?.latest ?? (info?.checking ? 'checking...' : '?')}
          </span>
          {hasUpdate && (
            <span
              style={{
                fontSize: 11,
                padding: '2px 8px',
                borderRadius: 'var(--radius-lg)',
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
          // Probe the CURRENTLY-TYPED registry, not the saved value — the
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
        {onOpenResetConfig && (
          <button
            className="btn btn-danger"
            onClick={onOpenResetConfig}
            style={{ marginLeft: 'auto' }}
          >
            Clear configuration &amp; data
          </button>
        )}
      </div>

      {/* Version switcher — pin/roll back to any published stable version.
          Collapsible; fetches the list on first expand. For global installs
          an in-app "Install" button runs the pinned install; for npx/unknown
          the copy-command is the recovery path that works from a terminal
          even when the app is bricked. */}
      <div style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
        <button
          className="btn"
          style={{ width: '100%', justifyContent: 'space-between' }}
          onClick={() => setSwitcherOpen((v) => !v)}
          aria-expanded={switcherOpen}
          title="Install or roll back to a specific published version."
        >
          <span>Switch version</span>
          <IconChevronDown
            size={14}
            style={{ transition: 'transform 0.15s', transform: switcherOpen ? 'rotate(180deg)' : 'none' }}
          />
        </button>
        {switcherOpen && (
          <div style={{ marginTop: 10 }}>
            {versionsDisabled ? (
              <div className="hint" style={{ marginTop: 0 }}>
                Update checks are disabled - set an update registry above and Save to enable version switching.
              </div>
            ) : (
              <>
                <Field
                  label="Published versions"
                  hint={
                    versions?.checkedAt
                      ? `Last checked: ${formatRelative(versions.checkedAt)}`
                      : 'Stable releases, newest first.'
                  }
                >
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <select
                      className="select"
                      value={effectivePicked}
                      onChange={(e) => setPickedVersion(e.target.value)}
                      disabled={versionsLoading || !versions?.versions.length}
                      style={{ flex: 1 }}
                    >
                      {versionsLoading && !versions?.versions.length && (
                        <option value="">Loading...</option>
                      )}
                      {versions?.versions.map((v) => {
                        const isCurrent = v === info?.current
                        const isInstalled = v === versions?.installed
                        const isLatest = v === versions?.latest
                        // A version is deprecated if it's in the published-versions'
                        // deprecated list, OR if it's the current version and
                        // UpdateInfo reports it as deprecated (fallback for stale
                        // versions-cache that predates the deprecatedVersions field).
                        const isDeprecated =
                          versions?.deprecatedVersions?.includes(v) ||
                          !!(isCurrent && info?.deprecated)
                        const tag = isCurrent
                          ? ' (current)'
                          : isInstalled
                            ? ' (installed on disk)'
                            : isLatest
                              ? ' (latest)'
                              : ''
                        const deprecatedTag = isDeprecated ? ' ⚠ deprecated' : ''
                        return (
                          <option key={v} value={v}>
                            {v}
                            {tag}
                            {deprecatedTag}
                          </option>
                        )
                      })}
                    </select>
                    {onFetchVersions && (
                      <button
                        className="btn"
                        onClick={() => onFetchVersions(true)}
                        disabled={versionsLoading}
                        title="Force a fresh fetch of the published-versions list."
                      >
                        <IconRefresh size={14} />
                      </button>
                    )}
                  </div>
                </Field>
                <button
                  className="btn btn-primary"
                  onClick={() => void runInstallVersion()}
                  disabled={!canInstallVersion}
                  title="Install the selected version, then restart to apply."
                >
                  {updating ? 'Installing...' : `Install ${effectivePicked || ''}`.trim()}
                </button>
                {versionsError && (
                  <div className="modal-error" style={{ marginTop: 8 }}>
                    Could not load versions: {versionsError}
                  </div>
                )}
                {installVersionError && (
                  <div className="modal-error" style={{ marginTop: 8 }}>
                    Install failed: {installVersionError}
                  </div>
                )}
              </>
            )}
          </div>
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

function Field({ label, hint, controlId, children }: { label: string; hint?: string; controlId?: string; children: React.ReactNode }) {
  // Link the visible label to the field's control (WCAG 1.3.1 / 3.3.2).
  // Field receives a single <input>/<select>/<textarea> child — give it a
  // stable generated id and point <label htmlFor> at it so clicking the
  // label focuses the control and ATs announce them as one unit.
  // Controls wrapped in a styling div (e.g. the model-select chevron wrapper)
  // aren't a direct child, so pass controlId and set id={controlId} on the
  // real control yourself — Field points the label at it either way.
  // Non-control children (a <div> model list, a toggle <button>, …) carry no
  // id — there's nothing to focus, so the label renders without htmlFor.
  const fieldId = useId()
  const isControl =
    isValidElement(children) &&
    (children.type === 'input' || children.type === 'select' || children.type === 'textarea')
  const linkedId = controlId ?? (isControl ? fieldId : undefined)
  const control = isControl
    ? cloneElement(children as React.ReactElement<{ id?: string }>, { id: fieldId })
    : children
  return (
    <div className="settings-field" style={{ marginBottom: 12 }}>
      <label htmlFor={linkedId}>{label}</label>
      {control}
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
