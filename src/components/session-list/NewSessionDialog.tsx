import { useEffect, useState } from 'react'
import { DirectoryPicker } from '../DirectoryPicker'
import { useLocalStorage } from '../../hooks/useLocalStorage'
import { api } from '../../hooks/useApi'
import { shortenPath } from '../../utils/paths'
import { ACCENT_COLORS } from '../../theme'
import type { McpServerConfigMeta, NewSessionForm, PermissionMode, SessionGroup } from '../../types'
import { PERMISSION_MODES } from '../../types'
import { McpInstaller } from '../McpInstaller'
import { StepSlider } from './StepSlider'
import { RECENT_MODELS_KEY, RECENT_MODELS_CAP_KEY, RECENT_MODELS_CAP_DEFAULT, RECENT_CWDS_KEY, RECENT_CWDS_CAP_KEY, RECENT_CWDS_CAP_DEFAULT } from '../../constants/recentKeys'
import { CONTEXT_STEPS, type ContextStepIdx } from '../../constants/contextSteps'

export interface NewSessionDialogProps {
  defaults: { cwd?: string; model?: string }
  /** Overrides defaults.cwd when set. Used by the drag-to-new-session
   *  shortcut, which wants to prefill with the dropped folder rather
   *  than the server-configured default. */
  initialCwd?: string
  onSubmit: (form: NewSessionForm) => void
  onCancel: () => void
  /** Available groups for the group selector. May be empty. */
  groups: SessionGroup[]
  /** Server-configured model list (from /api/config). Shown as chips
   *  above the recent-models chips so the user always has a baseline. */
  serverModels?: string[]
  /** Max sessions per group. */
  maxOpen: number
  /** Context-window size presets from server config. */
  contextSteps?: Array<{ value: number; label: string; beta?: string }>
}

export function NewSessionDialog({ defaults, initialCwd, onSubmit, onCancel, groups, serverModels, maxOpen, contextSteps: contextStepsProp }: NewSessionDialogProps) {
  const [cwd, setCwd] = useState<string>(initialCwd ?? defaults.cwd ?? '')
  const [model, setModel] = useState<string>(defaults.model ?? '')
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [title, setTitle] = useState('')
  /** Accent colour chosen in the dialog. `undefined` means "use the
   *  global accent" — we don't write an entry to sessionColors unless
   *  the user explicitly picks one. */
  const [accent, setAccent] = useState<string | undefined>(undefined)
  const [contextStepIdx, setContextStepIdx] = useState<ContextStepIdx>(1) // 200k default
  const [groupId, setGroupId] = useState<string>('')
  const [showPicker, setShowPicker] = useState(false)

  // Advanced options
  const [effort, setEffort] = useState('')
  const [thinkingMode, setThinkingMode] = useState('')
  const [thinkingBudget, setThinkingBudget] = useState('')
  const [additionalDirs, setAdditionalDirs] = useState('')
  const [fallbackModel, setFallbackModel] = useState('')
  const [maxTurns, setMaxTurns] = useState('')
  const [maxBudgetUsd, setMaxBudgetUsd] = useState('')
  const [allowedToolsStr, setAllowedToolsStr] = useState('')
  const [disallowedToolsStr, setDisallowedToolsStr] = useState('')
  const [toolsStr, setToolsStr] = useState('')
  const [mcpServersJson, setMcpServersJson] = useState('')

  // Global MCP server config state
  const [globalMcpServers, setGlobalMcpServers] = useState<McpServerConfigMeta[]>([])
  const [enabledMcpServers, setEnabledMcpServers] = useState<Set<string>>(new Set())
  const [showMcpInstaller, setShowMcpInstaller] = useState(false)
  const [mcpInstallerEdit, setMcpInstallerEdit] = useState<McpServerConfigMeta | undefined>(undefined)

  const [recentModels, setRecentModels] = useLocalStorage<string[]>(RECENT_MODELS_KEY, [])
  const [recentCwds, setRecentCwds] = useLocalStorage<string[]>(RECENT_CWDS_KEY, [])
  const [recentModelsCapRaw] = useLocalStorage<number>(RECENT_MODELS_CAP_KEY, RECENT_MODELS_CAP_DEFAULT)
  const [recentCwdsCapRaw] = useLocalStorage<number>(RECENT_CWDS_CAP_KEY, RECENT_CWDS_CAP_DEFAULT)
  const recentModelsCap = Math.max(3, Math.min(50, Math.round(recentModelsCapRaw)))
  const recentCwdsCap = Math.max(3, Math.min(50, Math.round(recentCwdsCapRaw)))

  // Use server-provided context steps if available; fall back to local defaults.
  const activeContextSteps = contextStepsProp && contextStepsProp.length > 0
    ? contextStepsProp
    : CONTEXT_STEPS
  // Clamp context step index if the server provides fewer/more steps than
  // the local defaults (e.g. user had index 3 but server only has 3 steps).
  const safeContextStepIdx = Math.min(contextStepIdx, activeContextSteps.length - 1)

  // Shared "remember recent …" helper: MRU-order, de-duped, capped.
  //
  // This dialog unmounts on the same tick as submit() (the parent flips
  // showDialog=false), so we CAN'T rely on the useLocalStorage hook's
  // effect to flush. We also can't put the side effect inside the setState
  // updater: React 19 will skip an updater whose resulting state is
  // discarded by an imminent unmount, which previously meant our second
  // call (rememberCwd, right after rememberModel) silently lost its write.
  //
  // So we do two independent things:
  //   1) compute `next` synchronously from the latest disk value and
  //      write it to localStorage right away — the important, persistent
  //      side effect.
  //   2) fire-and-forget the state update so that if the dialog happens
  //      to stay mounted, the chips list still reflects the new value.
  const rememberIn = (
    storageKey: string,
    setter: (next: string[]) => void,
    cap: number,
    raw: string,
  ) => {
    const v = raw.trim()
    if (!v) return
    let prev: string[] = []
    try {
      const existing = window.localStorage.getItem(storageKey)
      if (existing) {
        const parsed = JSON.parse(existing)
        if (Array.isArray(parsed)) prev = parsed.filter((x): x is string => typeof x === 'string')
      }
    } catch {
      /* fall through with prev=[] */
    }
    const next = [v, ...prev.filter((x) => x !== v)].slice(0, cap)
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next))
    } catch {
      /* quota / SecurityError — the in-memory state still wins this session */
    }
    setter(next)
  }

  const rememberModel = (raw: string) =>
    rememberIn(RECENT_MODELS_KEY, setRecentModels, recentModelsCap, raw)
  const forgetModel = (name: string) => {
    setRecentModels((prev) => prev.filter((m) => m !== name))
  }

  const rememberCwd = (raw: string) =>
    rememberIn(RECENT_CWDS_KEY, setRecentCwds, recentCwdsCap, raw)
  const forgetCwd = (name: string) => {
    setRecentCwds((prev) => prev.filter((c) => c !== name))
  }

  const submit = () => {
    rememberModel(model)
    rememberCwd(cwd)
    const step = activeContextSteps[safeContextStepIdx]

    // Parse comma-separated string into trimmed string[], or undefined if empty.
    const csv = (s: string) => {
      const arr = s.split(',').map((t) => t.trim()).filter(Boolean)
      return arr.length > 0 ? arr : undefined
    }

    // Build thinking config from mode + optional budget
    let thinking: NewSessionForm['thinking'] = undefined
    if (thinkingMode === 'adaptive') thinking = 'adaptive'
    else if (thinkingMode === 'disabled') thinking = 'disabled'
    else if (thinkingMode === 'enabled') {
      const budget = parseInt(thinkingBudget, 10)
      thinking = budget > 0 ? { type: 'enabled', budgetTokens: budget } : 'enabled'
    }

    // Parse mcpServers JSON if provided
    let mcpServers: unknown = undefined
    if (mcpServersJson.trim()) {
      try { mcpServers = JSON.parse(mcpServersJson) } catch { /* ignore — let server reject */ }
    }

    onSubmit({
      cwd: cwd.trim() || undefined,
      model: model.trim() || undefined,
      permissionMode,
      systemPrompt: systemPrompt.trim() || undefined,
      title: title.trim() || undefined,
      // Only include the beta flag for steps that require it (currently
      // just 1M) — keeps the wire payload clean for all other sizes.
      betas: step.beta ? [step.beta] : undefined,
      accent,
      groupId: groupId || undefined,
      // Advanced options — only include when non-empty
      effort: (effort || undefined) as NewSessionForm['effort'],
      thinking,
      additionalDirectories: csv(additionalDirs),
      fallbackModel: fallbackModel.trim() || undefined,
      maxTurns: maxTurns ? parseInt(maxTurns, 10) || undefined : undefined,
      maxBudgetUsd: maxBudgetUsd ? parseFloat(maxBudgetUsd) || undefined : undefined,
      allowedTools: csv(allowedToolsStr),
      disallowedTools: csv(disallowedToolsStr),
      tools: csv(toolsStr),
      enabledMcpServers: enabledMcpServers.size > 0 ? Array.from(enabledMcpServers) : undefined,
      mcpServers,
    })
  }

  // Esc closes the dialog, but not when the directory picker is open — that
  // picker has its own Esc handler and we don't want to collapse both modals
  // with one keypress.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !showPicker) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel, showPicker])

  // Fetch global MCP servers when dialog opens
  useEffect(() => {
    const ac = new AbortController()
    api
      .get<{ servers: McpServerConfigMeta[] }>('/mcp-config', { signal: ac.signal })
      .then((r) => {
        setGlobalMcpServers(r.servers)
        // Pre-select all enabled servers
        setEnabledMcpServers(new Set(r.servers.filter((s) => s.enabled !== false).map((s) => s.name)))
      })
      .catch(() => { /* ignore — empty list is fine */ })
    return () => { ac.abort() }
  }, [])

  const toggleGlobalMcp = (name: string) => {
    setEnabledMcpServers((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const handleMcpInstallerSave = () => {
    setShowMcpInstaller(false)
    setMcpInstallerEdit(undefined)
    // Refresh global server list
    api
      .get<{ servers: McpServerConfigMeta[] }>('/mcp-config')
      .then((r) => {
        setGlobalMcpServers(r.servers)
        setEnabledMcpServers((prev) => {
          const next = new Set(prev)
          for (const s of r.servers) {
            if (s.enabled !== false && !next.has(s.name)) next.add(s.name)
          }
          return next
        })
      })
      .catch(() => { /* ignore */ })
  }

  return (
    <>
      <div
        className="modal-backdrop"
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.target === e.currentTarget && onCancel()}
      >
        <div className="modal" style={{ width: 'min(560px, 92vw)' }}>
          <div className="modal-header">
            <h3>New session</h3>
            <button className="btn" onClick={onCancel} style={{ padding: '2px 10px' }}>
              ✕
            </button>
          </div>

          <div className="modal-section">
            <div className="settings-field">
              <label>Working directory</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  className="input"
                  placeholder="/path/to/project"
                  list="recent-cwds"
                  value={cwd}
                  onChange={(e) => setCwd(e.target.value)}
                  style={{ flex: 1 }}
                />
                <button type="button" className="btn" onClick={() => setShowPicker(true)} title="Browse server directories">
                  📁
                </button>
              </div>
              <datalist id="recent-cwds">
                {recentCwds.map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
              {recentCwds.length > 0 && (
                <div className="recent-chips">
                  {recentCwds.slice(0, 5).map((p) => (
                    <span key={p} className="recent-chip" title={p}>
                      <button
                        type="button"
                        className="recent-chip-use"
                        onClick={() => setCwd(p)}
                      >
                        {shortenPath(p)}
                      </button>
                      <button
                        type="button"
                        className="recent-chip-forget"
                        onClick={() => forgetCwd(p)}
                        title="Forget this path"
                        aria-label={`Forget ${p}`}
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="settings-field">
              <label>Title (optional)</label>
              <input
                className="input"
                placeholder="My session"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>

            <div className="settings-field">
              <label>Model</label>
              <input
                className="input"
                placeholder={serverModels?.[0] ?? defaults.model ?? ''}
                list="model-options"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
              <datalist id="model-options">
                {(serverModels ?? []).concat(
                  recentModels.filter((m) => !(serverModels ?? []).includes(m)),
                ).map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              {((serverModels && serverModels.length > 0) || recentModels.length > 0) && (
                <div className="recent-chips">
                  {(serverModels ?? []).map((m) => (
                    <span key={`srv:${m}`} className="recent-chip" title={`Use ${m}`}>
                      <button
                        type="button"
                        className="recent-chip-use"
                        onClick={() => setModel(m)}
                      >
                        {m}
                      </button>
                    </span>
                  ))}
                  {recentModels
                    .filter((m) => !(serverModels ?? []).includes(m))
                    .slice(0, 5)
                    .map((m) => (
                      <span key={m} className="recent-chip" title={`Use ${m}`}>
                        <button
                          type="button"
                          className="recent-chip-use"
                          onClick={() => setModel(m)}
                        >
                          {m}
                        </button>
                        <button
                          type="button"
                          className="recent-chip-forget"
                          onClick={() => forgetModel(m)}
                          title="Forget this model"
                          aria-label={`Forget ${m}`}
                        >
                          ✕
                        </button>
                      </span>
                    ))}
                </div>
              )}
            </div>

            <div className="settings-field">
              <label>Permission mode</label>
              <select
                className="select"
                value={permissionMode}
                onChange={(e) => setPermissionMode(e.target.value as PermissionMode)}
              >
                {PERMISSION_MODES.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>

            <div className="settings-field">
              <label>Group</label>
              <select
                className="select"
                value={groupId}
                onChange={(e) => setGroupId(e.target.value)}
              >
                <option value="">None (Ungrouped)</option>
                {groups.map((g) => {
                  const full = g.sessionIds.length >= maxOpen
                  return (
                    <option key={g.id} value={g.id} disabled={full}>
                      {g.name} ({g.sessionIds.length}/{maxOpen}){full ? ' — full' : ''}
                    </option>
                  )
                })}
              </select>
            </div>

            <div className="settings-field">
              <label>Accent colour</label>
              <div className="accent-picker" role="radiogroup" aria-label="Session accent">
                <button
                  type="button"
                  className={`accent-swatch accent-swatch-default ${accent === undefined ? 'active' : ''}`}
                  onClick={() => setAccent(undefined)}
                  role="radio"
                  aria-checked={accent === undefined}
                  aria-label="Use global accent"
                  title="Use global accent"
                >
                  ↺
                </button>
                {ACCENT_COLORS.map((c) => (
                  <button
                    key={c.accent}
                    type="button"
                    className={`accent-swatch ${accent === c.accent ? 'active' : ''}`}
                    style={{ ['--swatch' as string]: c.accent }}
                    onClick={() => setAccent(c.accent)}
                    role="radio"
                    aria-checked={accent === c.accent}
                    aria-label={c.name}
                    title={c.name}
                  />
                ))}
              </div>
            </div>

            <div className="settings-field">
              <label>Context size</label>
              <StepSlider
                steps={activeContextSteps}
                value={safeContextStepIdx}
                onChange={setContextStepIdx}
              />
              <span className="hint">
                {activeContextSteps[safeContextStepIdx]?.beta
                  ? '1M beta · Sonnet 4 / 4.5 only — other models fall back to their own limit.'
                  : 'Controls the context window the session is allowed to use.'}
              </span>
            </div>

            <div className="settings-field">
              <label>System prompt (optional)</label>
              <textarea
                className="textarea"
                placeholder="You are a helpful assistant..."
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                rows={3}
              />
            </div>

            <details style={{ marginTop: 8 }}>
              <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--fg-muted)', userSelect: 'none' }}>
                Advanced options
              </summary>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div className="settings-field">
                    <label>Effort</label>
                    <select className="select" value={effort} onChange={(e) => setEffort(e.target.value)}>
                      <option value="">(default)</option>
                      <option value="low">low</option>
                      <option value="medium">medium</option>
                      <option value="high">high</option>
                      <option value="xhigh">xhigh</option>
                      <option value="max">max</option>
                    </select>
                  </div>
                  <div className="settings-field">
                    <label>Thinking</label>
                    <select className="select" value={thinkingMode} onChange={(e) => setThinkingMode(e.target.value)}>
                      <option value="">(default)</option>
                      <option value="adaptive">adaptive</option>
                      <option value="enabled">enabled</option>
                      <option value="disabled">disabled</option>
                    </select>
                  </div>
                </div>
                {thinkingMode === 'enabled' && (
                  <div className="settings-field">
                    <label>Thinking budget (tokens)</label>
                    <input
                      className="input"
                      type="number"
                      placeholder="10000"
                      value={thinkingBudget}
                      onChange={(e) => setThinkingBudget(e.target.value)}
                    />
                  </div>
                )}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div className="settings-field">
                    <label>Max turns</label>
                    <input
                      className="input"
                      type="number"
                      placeholder="unlimited"
                      value={maxTurns}
                      onChange={(e) => setMaxTurns(e.target.value)}
                    />
                  </div>
                  <div className="settings-field">
                    <label>Max budget (USD)</label>
                    <input
                      className="input"
                      type="number"
                      step="0.01"
                      placeholder="unlimited"
                      value={maxBudgetUsd}
                      onChange={(e) => setMaxBudgetUsd(e.target.value)}
                    />
                  </div>
                </div>
                <div className="settings-field">
                  <label>Fallback model</label>
                  <input
                    className="input"
                    placeholder="model to use if primary fails"
                    value={fallbackModel}
                    onChange={(e) => setFallbackModel(e.target.value)}
                  />
                </div>
                <div className="settings-field">
                  <label>Additional directories (comma-separated)</label>
                  <input
                    className="input"
                    placeholder="/path/a, /path/b"
                    value={additionalDirs}
                    onChange={(e) => setAdditionalDirs(e.target.value)}
                  />
                  <span className="hint">Extra paths the agent may read/write outside the working directory.</span>
                </div>
                <div className="settings-field">
                  <label>Allowed tools (comma-separated)</label>
                  <input
                    className="input"
                    placeholder="Read, Write, Bash"
                    value={allowedToolsStr}
                    onChange={(e) => setAllowedToolsStr(e.target.value)}
                  />
                </div>
                <div className="settings-field">
                  <label>Disallowed tools (comma-separated)</label>
                  <input
                    className="input"
                    placeholder="WebFetch, Agent"
                    value={disallowedToolsStr}
                    onChange={(e) => setDisallowedToolsStr(e.target.value)}
                  />
                </div>
                <div className="settings-field">
                  <label>Tools (comma-separated)</label>
                  <input
                    className="input"
                    placeholder="leave empty for defaults"
                    value={toolsStr}
                    onChange={(e) => setToolsStr(e.target.value)}
                  />
                  <span className="hint">Override the built-in tool set. Leave empty to use defaults.</span>
                </div>
                <div className="settings-field">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <label style={{ margin: 0 }}>MCP servers</label>
                    <button
                      className="btn"
                      style={{ fontSize: 11, padding: '2px 8px' }}
                      onClick={() => { setMcpInstallerEdit(undefined); setShowMcpInstaller(true) }}
                    >
                      + Add server
                    </button>
                  </div>
                  {globalMcpServers.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
                      {globalMcpServers.map((srv) => (
                        <label
                          key={srv.name}
                          style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}
                        >
                          <input
                            type="checkbox"
                            checked={enabledMcpServers.has(srv.name)}
                            onChange={() => toggleGlobalMcp(srv.name)}
                          />
                          <span style={{ flex: 1 }}>{srv.name}</span>
                          <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>{srv.type}</span>
                          <button
                            className="btn"
                            style={{ fontSize: 10, padding: '1px 5px' }}
                            onClick={(e) => {
                              e.preventDefault()
                              e.stopPropagation()
                              setMcpInstallerEdit(srv)
                              setShowMcpInstaller(true)
                            }}
                            title="Edit server"
                          >
                            ✎
                          </button>
                        </label>
                      ))}
                    </div>
                  )}
                  {globalMcpServers.length === 0 && (
                    <span className="hint" style={{ marginTop: 4, display: 'block' }}>
                      No global MCP servers configured. Click "+ Add server" to create one.
                    </span>
                  )}
                </div>
                <div className="settings-field">
                  <label>Session MCP overrides (JSON)</label>
                  <textarea
                    className="textarea"
                    rows={2}
                    placeholder='Optional — add session-only MCP servers as JSON'
                    value={mcpServersJson}
                    onChange={(e) => setMcpServersJson(e.target.value)}
                  />
                  <span className="hint">Additional MCP servers for this session only (merged with selected global servers).</span>
                </div>
              </div>
            </details>
          </div>

          <div className="modal-footer">
            <span className="hint">Press Esc or click outside to cancel.</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" onClick={onCancel}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={submit}>
                Create
              </button>
            </div>
          </div>
        </div>
      </div>

      {showPicker && (
        <DirectoryPicker
          initialPath={cwd || defaults.cwd}
          onPick={(p) => {
            setCwd(p)
            setShowPicker(false)
          }}
          onClose={() => setShowPicker(false)}
        />
      )}

      {showMcpInstaller && (
        <McpInstaller
          server={mcpInstallerEdit}
          onSave={handleMcpInstallerSave}
          onClose={() => { setShowMcpInstaller(false); setMcpInstallerEdit(undefined) }}
        />
      )}
    </>
  )
}
