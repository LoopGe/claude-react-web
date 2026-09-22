import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { DirectoryPicker } from '../DirectoryPicker'
import { ProjectPicker } from './ProjectPicker'
import { FieldPicker } from '../FieldPicker'
import type { FieldPickerOption } from '../FieldPicker'
import { IconX, IconPencil } from '../icons/ToolIcons'
import { PermissionModeIcon, permissionModeLabel } from '../permission-mode-display'
import { useLocalStorage } from '../../hooks/useLocalStorage'
import { api } from '../../hooks/useApi'
import { AccentPicker } from '../AccentPicker'
import type { McpServerConfigMeta, NewSessionForm, PermissionMode, SessionGroup } from '../../types'
import type { ModelGroupConfig } from '../../types/config'
import { PERMISSION_MODES, EFFORT_LEVELS } from '../../types'
import { useExitPresence } from '../../hooks/useExitPresence'
import { useAgentDefinitions } from '../../hooks/useAgentDefinitions'
import { Overlay } from '../Overlay'

// McpInstaller is only opened when the user clicks "Add MCP" from inside
// this dialog. Lazy-load to keep NewSessionDialog itself lean.
const McpInstaller = lazy(() =>
  import('../McpInstaller').then((m) => ({ default: m.McpInstaller })),
)
import { ONE_M_CONTEXT_BETA } from '../../constants/contextSteps'
import { RECENT_MODELS_KEY, RECENT_MODELS_CAP_KEY, RECENT_MODELS_CAP_DEFAULT, RECENT_CWDS_KEY, RECENT_CWDS_CAP_KEY, RECENT_CWDS_CAP_DEFAULT } from '../../constants/recentKeys'

/** useLocalStorage validator for the recent lists. A corrupt entry (other tab,
 *  older build, hand-edit) must collapse to [] — iterating a non-array would
 *  throw and white-screen the dialog. */
const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string')

export interface NewSessionDialogProps {
  open?: boolean
  defaults: { cwd?: string; model?: string }
  /** Overrides defaults.cwd when set. Used by the drag-to-new-session
   *  shortcut, which wants to prefill with the dropped folder rather
   *  than the server-configured default. */
  initialCwd?: string
  onSubmit: (form: NewSessionForm) => void
  onCancel: () => void
  /** Available groups for the group selector. May be empty. */
  groups: SessionGroup[]
  /** Server-configured model list (from /api/config). Shown first in the
   *  Model FieldPicker menu so the user always has a baseline. */
  serverModels?: string[]
  /** Model Groups from the same /config snapshot as `serverModels`. Threaded
   *  from App (not fetched here) so the menu never issues its own /config and
   *  the two lists cannot drift. */
  modelGroups?: ModelGroupConfig[]
  /** Pre-select this group in the "Add to group" picker. The sidebar's
   *  `activeGroupId` is threaded through so opening the dialog while a
   *  group is active keeps the user's mental model: "this is the group I
   *  was just looking at, so the new session goes here." Empty string
   *  means "no preselected group". */
  initialGroupId?: string
  /** Max sessions per group. */
  maxGroupSize: number
  /** Global first-party tool defaults (server config map, name → {enabled}).
   *  One checkbox row per entry; the initial checked state is the entry's
   *  `enabled` value. Omitted / empty map → the cluster is hidden. */
  firstPartyTools?: Record<string, { enabled: boolean }>
  /** When true the active skin locks the accent (Anthropic / HC), so the
   *  per-session accent picker is hidden in the new-session form. */
  accentLocked?: boolean
}

/** Stable empty default — a fresh `[]` per render would defeat modelOptions'
 *  useMemo (new array identity every keystroke). */
const NO_MODEL_GROUPS: ModelGroupConfig[] = []

export function NewSessionDialog({ open = true, defaults, initialCwd, onSubmit, onCancel, groups, serverModels, modelGroups = NO_MODEL_GROUPS, initialGroupId, maxGroupSize, accentLocked, firstPartyTools }: NewSessionDialogProps) {
  // Per-instance prefix for label↔control id linkage. useId keeps the
  // dialog's ids document-unique even if it ever mounts more than once.
  const uid = useId()
  // Declared before `cwd` so its lazy initializer can prefer the most recent
  // project: the last-used directory is the dialog's de facto default, with
  // the drag-and-drop prefill and the server-provided defaults.cwd as
  // fallbacks. useLocalStorage reads synchronously, so the first render
  // already sees the stored list.
  const [recentCwds, setRecentCwds] = useLocalStorage<string[]>(RECENT_CWDS_KEY, [], { validate: isStringArray })
  const [cwd, setCwd] = useState<string>(initialCwd ?? recentCwds[0] ?? defaults.cwd ?? '')
  const [model, setModel] = useState<string>(defaults.model ?? '')
  /** Model Group pin. Mutually exclusive with a concrete `model` — selecting
   *  one clears the other (ChatPanel's ModelPicker has the same contract). */
  const [modelGroupId, setModelGroupId] = useState('')
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [title, setTitle] = useState('')
  /** Accent colour chosen in the dialog. `undefined` means "use the
   *  global accent" — we don't write an entry to sessionColors unless
   *  the user explicitly picks one. */
  const [accent, setAccent] = useState<string | undefined>(undefined)
  // Seed the group picker with the active group (if any) BUT only when
  // it still has capacity — landing the new session into a group that
  // would immediately silently fail is worse than starting on "(none)".
  const [groupId, setGroupId] = useState<string>(() => {
    if (!initialGroupId) return ''
    const g = groups.find((x) => x.id === initialGroupId)
    if (!g) return ''
    if (g.sessionIds.length >= maxGroupSize) return ''
    return initialGroupId
  })
  const [showPicker, setShowPicker] = useState(false)
  const pickerPresence = useExitPresence(showPicker)
  // Guards against double-submit: the parent unmounts this dialog on
  // success, but a slow create call would otherwise let an impatient
  // user click "Create" twice and spawn duplicate sessions.
  const [submitting, setSubmitting] = useState(false)

  // Custom agent definitions (Task 5). The dropdown lists only ENABLED
  // definitions — a disabled def can't be used to start a session (the
  // server 400s on unknown/disabled names), so showing it would dead-end.
  const { agents } = useAgentDefinitions()
  const enabledAgents = agents.filter((a) => a.enabled)
  const [selectedAgent, setSelectedAgent] = useState('')

  /** Value each agent-prefilled field was set to, plus the user's prior
   *  choice. Reverted on agent change ONLY while the field still holds the
   *  agent's value — a later manual pick wins and must not be clobbered.
   *  Revert restores `before` (the user's pick), not the dialog defaults. */
  const agentPrefillsRef = useRef<
    Map<'model' | 'permissionMode' | 'effort', { before: string; after: string }>
  >(new Map())

  /** Selecting an agent PRE-FILLS the model / permission-mode / effort
   *  fields from the definition (each only when the def declares it). Fields
   *  the previous agent prefilled AND the user has not since overwritten are
   *  restored to the user's pre-agent value so deselecting the agent (or
   *  switching to a def that omits them) cannot leak the old def's values
   *  into the create request — nor clobber a deliberate Default pick. */
  const handleAgentChange = (value: string) => {
    const p = agentPrefillsRef.current
    const pre = p.get('model')
    if (pre && pre.after === model) {
      setModel(pre.before)
      setModelGroupId('')
    }
    const prePerm = p.get('permissionMode')
    if (prePerm && prePerm.after === permissionMode) {
      setPermissionMode((prePerm.before || 'default') as PermissionMode)
    }
    const preEffort = p.get('effort')
    if (preEffort && preEffort.after === effort) {
      setEffort(preEffort.before)
    }
    agentPrefillsRef.current = new Map()
    setSelectedAgent(value)
    if (!value) return
    const def = agents.find((a) => a.name === value)
    if (!def) return
    if (def.model) {
      agentPrefillsRef.current.set('model', { before: model, after: def.model })
      setModel(def.model)
      setModelGroupId('')
    }
    if (def.permissionMode) {
      agentPrefillsRef.current.set('permissionMode', {
        before: permissionMode,
        after: def.permissionMode,
      })
      setPermissionMode(def.permissionMode as PermissionMode)
    }
    if (def.effort != null && def.effort !== '') {
      const e = String(def.effort)
      agentPrefillsRef.current.set('effort', { before: effort, after: e })
      setEffort(e)
    }
  }

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
  // Custom env vars — key-value rows
  const [envRows, setEnvRows] = useState<Array<{ id: string; key: string; value: string }>>([])

  // Global MCP server config state
  const [globalMcpServers, setGlobalMcpServers] = useState<McpServerConfigMeta[]>([])
  const [enabledMcpServers, setEnabledMcpServers] = useState<Set<string>>(new Set())

  // Plugin picker state
  const [enabledPlugins, setEnabledPlugins] = useState<Set<string>>(new Set())
  const [allPluginKeys, setAllPluginKeys] = useState<string[]>([])
  const [showMcpInstaller, setShowMcpInstaller] = useState(false)
  const [mcpInstallerEdit, setMcpInstallerEdit] = useState<McpServerConfigMeta | undefined>(undefined)
  const mcpInstallerPresence = useExitPresence(showMcpInstaller)

  // First-party tool checkboxes. The state holds ONLY entries diverging from
  // the global default (`firstPartyDiffs[name] ?? default.enabled` is the
  // checked state; toggling back to the default deletes the entry), so submit
  // can pass the map verbatim — absent key = inherit global, per the server's
  // per-server override model.
  const [firstPartyDiffs, setFirstPartyDiffs] = useState<Record<string, boolean>>({})

  const [recentModels, setRecentModels] = useLocalStorage<string[]>(RECENT_MODELS_KEY, [], { validate: isStringArray })
  const [recentModelsCapRaw] = useLocalStorage<number>(RECENT_MODELS_CAP_KEY, RECENT_MODELS_CAP_DEFAULT)
  const [recentCwdsCapRaw] = useLocalStorage<number>(RECENT_CWDS_CAP_KEY, RECENT_CWDS_CAP_DEFAULT)
  const recentModelsCap = Math.max(3, Math.min(50, Math.round(recentModelsCapRaw)))
  const recentCwdsCap = Math.max(3, Math.min(50, Math.round(recentCwdsCapRaw)))

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
  const forgetModel = useCallback((name: string) => {
    setRecentModels((prev) => prev.filter((m) => m !== name))
  }, [setRecentModels])

  const rememberCwd = (raw: string) =>
    rememberIn(RECENT_CWDS_KEY, setRecentCwds, recentCwdsCap, raw)
  const forgetCwd = (name: string) => {
    setRecentCwds((prev) => prev.filter((c) => c !== name))
  }

  // Model menu rows: Model Groups first (ChatPanel ModelPicker order), then
  // "Default" (clears the pin so the server default wins), then server models,
  // then recents (forgettable), then the current value when it isn't in either
  // list (agent prefill / drag-in). Group ↔ concrete model are mutually
  // exclusive: picking one clears the other.
  const modelOptions: FieldPickerOption[] = useMemo(() => {
    // Derived (not raw modelGroupId): a group deleted while the dialog is open
    // must not stay "selected", and Default must light up instead.
    const activeMg = modelGroups.find((g) => g.id === modelGroupId)
    const rows: FieldPickerOption[] = []
    modelGroups.forEach((g) => {
      rows.push({
        key: `mg:${g.id}`,
        label: g.name,
        sub: [g.opus, g.sonnet, g.haiku].filter(Boolean).join(' · '),
        // Stamp on every row: FieldPicker shows it on the first VISIBLE row
        // of the section, so a filter that drops row 0 still labels the rest.
        heading: 'Model Groups',
        selected: activeMg?.id === g.id,
        onSelect: () => {
          setModelGroupId(g.id)
          setModel('')
        },
      })
    })
    rows.push({
      key: 'default',
      // Sub must NOT be a model id — FieldPicker filters on sub too, and a
      // model id here would make "Default" win the Enter key on a search
      // that was meant for that model.
      label: 'Default',
      sub: 'use server default',
      selected: !activeMg && model === '',
      onSelect: () => {
        setModelGroupId('')
        setModel('')
      },
    })
    const seen = new Set<string>()
    const modelRows: FieldPickerOption[] = []
    const addModelRow = (m: string, extra: Partial<FieldPickerOption>) => {
      if (!m || seen.has(m)) return
      seen.add(m)
      modelRows.push({
        key: extra.key ?? `m:${m}`,
        label: m,
        heading: 'Models',
        selected: !activeMg && model === m,
        onSelect: () => {
          setModelGroupId('')
          setModel(m)
        },
        ...extra,
      })
    }
    for (const m of serverModels ?? []) addModelRow(m, { key: `srv:${m}` })
    for (const m of recentModels) {
      addModelRow(m, {
        key: `recent:${m}`,
        onForget: () => forgetModel(m),
        forgetLabel: `Forget ${m}`,
      })
    }
    if (model && !seen.has(model)) {
      addModelRow(model, { key: `cur:${model}`, selected: !activeMg })
    }
    if (modelRows.length > 0) rows.push(...modelRows)
    return rows
  }, [modelGroups, modelGroupId, serverModels, recentModels, model, forgetModel])

  // Free-text model ids (proxy models the server list doesn't advertise) get
  // their own LAST row while typing — same contract as ModelPicker, so Enter
  // after a filter commits the matched option rather than the filter text.
  const modelCustomOption = useCallback((q: string): FieldPickerOption | null => {
    const raw = q.trim()
    if (!raw) return null
    const known =
      (serverModels ?? []).includes(raw) || recentModels.includes(raw) || raw === model
    if (known) return null
    return {
      key: 'custom',
      label: `Use “${raw}”`,
      sub: 'custom',
      onSelect: () => {
        setModelGroupId('')
        setModel(raw)
      },
    }
  }, [serverModels, recentModels, model])

  // Derived, not raw state: a group deleted while the dialog is open must not
  // show as selected on the trigger yet still submit. Submit reads this too.
  const activeGroup = groups.find((g) => g.id === groupId)
  const activeModelGroup = modelGroups.find((g) => g.id === modelGroupId)

  const permissionOptions: FieldPickerOption[] = useMemo(
    () =>
      PERMISSION_MODES.map((m) => ({
        key: m,
        label: permissionModeLabel(m),
        icon: <PermissionModeIcon mode={m} size={14} />,
        selected: m === permissionMode,
        onSelect: () => setPermissionMode(m),
      })),
    [permissionMode],
  )

  const groupOptions: FieldPickerOption[] = useMemo(
    () => [
      {
        key: '',
        label: 'None (Ungrouped)',
        selected: !activeGroup,
        onSelect: () => setGroupId(''),
      },
      ...groups.map((g) => {
        const full = g.sessionIds.length >= maxGroupSize
        return {
          key: g.id,
          label: g.name,
          sub: `${g.sessionIds.length}/${maxGroupSize}${full ? ' — will replace oldest' : ''}`,
          selected: groupId === g.id,
          onSelect: () => setGroupId(g.id),
        }
      }),
    ],
    [groups, groupId, activeGroup, maxGroupSize],
  )

  // Tiny static lists — left un-memoized on purpose so the React Compiler can
  // infer deps. Manual useMemo here made the compiler skip optimizing the
  // whole component (preserve-manual-memoization).
  const agentOptions: FieldPickerOption[] = [
    {
      key: '',
      label: 'None',
      selected: selectedAgent === '',
      onSelect: () => handleAgentChange(''),
    },
    ...enabledAgents.map((a) => ({
      key: a.name,
      label: a.name,
      sub: a.description,
      selected: selectedAgent === a.name,
      onSelect: () => handleAgentChange(a.name),
    })),
  ]

  const effortOptions: FieldPickerOption[] = [
    { key: '', label: '(default)', selected: effort === '', onSelect: () => setEffort('') },
    ...EFFORT_LEVELS.map((e) => ({
      key: e,
      label: e,
      selected: effort === e,
      onSelect: () => setEffort(e),
    })),
  ]

  const thinkingOptions: FieldPickerOption[] = [
    { key: '', label: '(default)', selected: thinkingMode === '', onSelect: () => setThinkingMode('') },
    ...(['adaptive', 'enabled', 'disabled'] as const).map((t) => ({
      key: t,
      label: t,
      selected: thinkingMode === t,
      onSelect: () => setThinkingMode(t),
    })),
  ]

  const submit = () => {
    if (submitting) return
    setSubmitting(true)
    rememberModel(model)
    rememberCwd(cwd)

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

    // Build env from key-value rows (only rows with non-empty key)
    const envEntries = envRows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value])
    const env = envEntries.length > 0 ? Object.fromEntries(envEntries) : undefined

    onSubmit({
      cwd: cwd.trim() || undefined,
      model: activeModelGroup ? undefined : model.trim() || undefined,
      // Derived (not raw state): a model group deleted while the dialog is
      // open must not be posted — create() 400s on an unknown group.
      modelGroupId: activeModelGroup?.id,
      agent: selectedAgent || undefined,
      permissionMode,
      systemPrompt: systemPrompt.trim() || undefined,
      title: title.trim() || undefined,
      betas: [ONE_M_CONTEXT_BETA],
      accent,
      groupId: activeGroup?.id,
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
      enabledPlugins: enabledPlugins.size === allPluginKeys.length
        ? undefined
        : Array.from(enabledPlugins),
      // Only entries diverging from the global default (the state never
      // holds agreeing entries) — absent key = inherit global.
      firstPartyTools: Object.keys(firstPartyDiffs).length > 0 ? { ...firstPartyDiffs } : undefined,
      mcpServers,
      env,
    })
  }

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

  // Fetch enabled plugins when dialog opens
  useEffect(() => {
    const ac = new AbortController()
    api
      .get<{ plugins: { key: string; name: string; marketplace: string }[] }>('/mp/enabled-plugins', { signal: ac.signal })
      .then((r) => {
        setAllPluginKeys(r.plugins.map((p) => p.key))
        // Pre-select all (default = carry every enabled plugin)
        setEnabledPlugins(new Set(r.plugins.map((p) => p.key)))
      })
      .catch(() => { /* no enabled plugins is fine */ })
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

  const togglePlugin = (key: string) => {
    setEnabledPlugins((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const toggleFirstParty = (name: string, globalEnabled: boolean) => {
    setFirstPartyDiffs((prev) => {
      const now = !(prev[name] ?? globalEnabled)
      const next = { ...prev }
      if (now === globalEnabled) delete next[name]
      else next[name] = now
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
      <Overlay
        variant="modal"
        cardClassName="modal-new-session"
        ariaLabel="New session"
        open={open}
        onClose={onCancel}
        // Esc closes the dialog, but not when the directory picker OR the MCP
        // installer is open — each is a modal-on-top-of-modal with its own Esc
        // handler, and one keypress must collapse only the top layer (otherwise
        // a stray Esc from dismissing the nested modal would discard the whole
        // new-session form the user was filling in).
        canCloseOnEscape={() => !showPicker && !showMcpInstaller}
      >
          <div className="modal-header">
            <h3>New session</h3>
            <button className="btn btn-icon-sm" onClick={onCancel} aria-label="Close dialog">
              <IconX size={14} />
            </button>
          </div>

          <div className="modal-section">
            <div className="settings-field">
              <label htmlFor={uid + '-project'}>Project</label>
              <ProjectPicker
                id={uid + '-project'}
                value={cwd}
                recents={recentCwds}
                onSelect={setCwd}
                onForget={forgetCwd}
                onBrowse={() => setShowPicker(true)}
              />
            </div>

            <div className="settings-field">
              <label htmlFor={uid + '-title'}>Title (optional)</label>
              <input
                className="input"
                id={uid + '-title'}
                placeholder="My session"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>

            <div className="settings-field">
              <label htmlFor={uid + '-agent'}>Agent</label>
              <FieldPicker
                id={uid + '-agent'}
                label={selectedAgent}
                placeholder="None"
                menuLabel="Agents"
                searchLabel="Search agents"
                searchPlaceholder="Search agents…"
                options={agentOptions}
              />
            </div>

            <div className="settings-field">
              <label htmlFor={uid + '-model'}>Model</label>
              <FieldPicker
                id={uid + '-model'}
                // Empty selection reads as "Default" (the chosen state), with
                // the effective model as the muted sub so the user still sees
                // what will run — not a concrete id that looks selected.
                label={activeModelGroup?.name ?? (model || 'Default')}
                sub={
                  activeModelGroup
                    ? [activeModelGroup.opus, activeModelGroup.sonnet, activeModelGroup.haiku]
                        .filter(Boolean)
                        .join(' · ') || undefined
                    : model
                      ? undefined
                      : (serverModels?.[0] ?? defaults.model)
                }
                placeholder={serverModels?.[0] ?? defaults.model ?? 'Default'}
                menuLabel="Models"
                searchLabel="Search models"
                searchPlaceholder="Search or type a model id…"
                options={modelOptions}
                customOption={modelCustomOption}
              />
            </div>

            <div className="settings-field">
              <label htmlFor={uid + '-permission-mode'}>Permission mode</label>
              <FieldPicker
                id={uid + '-permission-mode'}
                label={permissionModeLabel(permissionMode)}
                icon={<PermissionModeIcon mode={permissionMode} size={14} />}
                menuLabel="Permission modes"
                searchable={false}
                options={permissionOptions}
              />
            </div>

            <div className="settings-field">
              <label htmlFor={uid + '-group'}>Group</label>
              <FieldPicker
                id={uid + '-group'}
                label={activeGroup?.name ?? ''}
                sub={
                  activeGroup
                    ? `${activeGroup.sessionIds.length}/${maxGroupSize}${
                        activeGroup.sessionIds.length >= maxGroupSize ? ' — will replace oldest' : ''
                      }`
                    : undefined
                }
                placeholder="None"
                menuLabel="Groups"
                searchLabel="Search groups"
                searchPlaceholder="Search groups…"
                options={groupOptions}
              />
            </div>

            {!accentLocked && (
            <div className="settings-field">
              <label>Accent colour</label>
              <AccentPicker
                value={accent}
                onChange={setAccent}
                allowDefault
                ariaLabel="Session accent"
              />
            </div>
            )}

            <div className="settings-field">
              <label htmlFor={uid + '-system-prompt'}>System prompt (optional)</label>
              <textarea
                className="textarea"
                id={uid + '-system-prompt'}
                placeholder="You are a helpful assistant..."
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                rows={3}
              />
            </div>

            <details style={{ marginTop: 8 }}>
              <summary style={{ cursor: 'pointer', fontSize: 'var(--fs-base)', color: 'var(--fg-muted)', userSelect: 'none' }}>
                Advanced options
              </summary>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div className="settings-field">
                    <label htmlFor={uid + '-effort'}>Effort</label>
                    <FieldPicker
                      id={uid + '-effort'}
                      label={effort}
                      placeholder="(default)"
                      menuLabel="Effort levels"
                      searchable={false}
                      options={effortOptions}
                    />
                  </div>
                  <div className="settings-field">
                    <label htmlFor={uid + '-thinking'}>Thinking</label>
                    <FieldPicker
                      id={uid + '-thinking'}
                      label={thinkingMode}
                      placeholder="(default)"
                      menuLabel="Thinking modes"
                      searchable={false}
                      options={thinkingOptions}
                    />
                  </div>
                </div>
                {thinkingMode === 'enabled' && (
                  <div className="settings-field">
                    <label htmlFor={uid + '-thinking-budget'}>Thinking budget (tokens)</label>
                    <input
                      className="input"
                      id={uid + '-thinking-budget'}
                      type="number"
                      placeholder="10000"
                      value={thinkingBudget}
                      onChange={(e) => setThinkingBudget(e.target.value)}
                    />
                  </div>
                )}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div className="settings-field">
                    <label htmlFor={uid + '-max-turns'}>Max turns</label>
                    <input
                      className="input"
                      id={uid + '-max-turns'}
                      type="number"
                      placeholder="unlimited"
                      value={maxTurns}
                      onChange={(e) => setMaxTurns(e.target.value)}
                    />
                  </div>
                  <div className="settings-field">
                    <label htmlFor={uid + '-max-budget'}>Max budget (USD)</label>
                    <input
                      className="input"
                      id={uid + '-max-budget'}
                      type="number"
                      step="0.01"
                      placeholder="unlimited"
                      value={maxBudgetUsd}
                      onChange={(e) => setMaxBudgetUsd(e.target.value)}
                    />
                  </div>
                </div>
                <div className="settings-field">
                  <label htmlFor={uid + '-fallback-model'}>Fallback model</label>
                  <input
                    className="input"
                    id={uid + '-fallback-model'}
                    placeholder="model to use if primary fails"
                    value={fallbackModel}
                    onChange={(e) => setFallbackModel(e.target.value)}
                  />
                </div>
                <div className="settings-field">
                  <label htmlFor={uid + '-additional-dirs'}>Additional directories (comma-separated)</label>
                  <input
                    className="input"
                    id={uid + '-additional-dirs'}
                    placeholder="/path/a, /path/b"
                    value={additionalDirs}
                    onChange={(e) => setAdditionalDirs(e.target.value)}
                  />
                  <span className="hint">Extra paths the agent may read/write outside the working directory.</span>
                </div>
                <div className="settings-field">
                  <label htmlFor={uid + '-allowed-tools'}>Allowed tools (comma-separated)</label>
                  <input
                    className="input"
                    id={uid + '-allowed-tools'}
                    placeholder="Read, Write, Bash"
                    value={allowedToolsStr}
                    onChange={(e) => setAllowedToolsStr(e.target.value)}
                  />
                </div>
                <div className="settings-field">
                  <label htmlFor={uid + '-disallowed-tools'}>Disallowed tools (comma-separated)</label>
                  <input
                    className="input"
                    id={uid + '-disallowed-tools'}
                    placeholder="WebFetch, Agent"
                    value={disallowedToolsStr}
                    onChange={(e) => setDisallowedToolsStr(e.target.value)}
                  />
                </div>
                <div className="settings-field">
                  <label htmlFor={uid + '-tools'}>Tools (comma-separated)</label>
                  <input
                    className="input"
                    id={uid + '-tools'}
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
                      style={{ fontSize: 'var(--fs-xs)', padding: '2px 8px' }}
                      onClick={() => { setMcpInstallerEdit(undefined); setShowMcpInstaller(true) }}
                    >
                      + Add server
                    </button>
                  </div>
                  {globalMcpServers.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
                      {globalMcpServers.map((srv) => {
                        // Globally-disabled servers are off by default (not
                        // pre-checked) but the user can still opt into them
                        // for this session by checking the box. Surface that
                        // state so the unchecked default isn't confused with
                        // "just another enabled server".
                        const globallyOff = srv.enabled === false
                        return (
                          <label
                            key={srv.name}
                            style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-base)', cursor: 'pointer' }}
                          >
                            <input
                              type="checkbox"
                              checked={enabledMcpServers.has(srv.name)}
                              onChange={() => toggleGlobalMcp(srv.name)}
                            />
                            <span style={{ flex: 1 }}>{srv.name}</span>
                            {globallyOff && (
                              <span
                                style={{ fontSize: 'var(--fs-2xs)', color: 'var(--fg-muted)' }}
                                title="Globally disabled — opt in by checking the box"
                              >
                                off
                              </span>
                            )}
                            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--fg-muted)' }}>{srv.type}</span>
                            <button
                              className="btn"
                              style={{ fontSize: 'var(--fs-2xs)', padding: '1px 5px' }}
                              onClick={(e) => {
                                e.preventDefault()
                                e.stopPropagation()
                                setMcpInstallerEdit(srv)
                                setShowMcpInstaller(true)
                              }}
                              title="Edit server"
                              aria-label="Edit server"
                            >
                              <IconPencil size={12} />
                            </button>
                          </label>
                        )
                      })}
                    </div>
                  )}
                  {globalMcpServers.length === 0 && (
                    <span className="hint" style={{ marginTop: 4, display: 'block' }}>
                      No global MCP servers configured. Click "+ Add server" to create one.
                    </span>
                  )}
                </div>
                {firstPartyTools && Object.keys(firstPartyTools).length > 0 && (
                  <div className="settings-field" style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
                    <label style={{ margin: 0 }}>First-party tools</label>
                    <span className="hint" style={{ marginTop: 4, display: 'block' }}>
                      Built-in tools this app injects into the session. Unchecked = not injected.
                    </span>
                    {Object.entries(firstPartyTools).map(([name, def]) => {
                      const checked = firstPartyDiffs[name] ?? def.enabled
                      return (
                        <label
                          key={name}
                          style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-base)', cursor: 'pointer' }}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleFirstParty(name, def.enabled)}
                          />
                          <span style={{ flex: 1 }}>{name}</span>
                        </label>
                      )
                    })}
                  </div>
                )}
                {allPluginKeys.length > 0 && (
                  <div className="settings-field" style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
                    <label style={{ margin: 0 }}>Plugins</label>
                    <span className="hint" style={{ marginTop: 4, display: 'block' }}>
                      Plugins can't be added after the session starts — choose them here.
                    </span>
                    {allPluginKeys.map((key) => {
                      // Compound key is "<plugin>@<marketplace>"; neither
                      // segment contains '@' (assertSafeName enforces
                      // [a-zA-Z0-9._-] on both), so a single split is safe.
                      const [pluginName, marketplace] = key.split('@')
                      return (
                        <label
                          key={key}
                          style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-base)', cursor: 'pointer' }}
                        >
                          <input
                            type="checkbox"
                            checked={enabledPlugins.has(key)}
                            onChange={() => togglePlugin(key)}
                          />
                          <span style={{ flex: 1 }}>{pluginName}</span>
                          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--fg-muted)' }}>{marketplace}</span>
                        </label>
                      )
                    })}
                  </div>
                )}
                <div className="settings-field">
                  <label htmlFor={uid + '-mcp-overrides'}>Session MCP overrides (JSON)</label>
                  <textarea
                    className="textarea"
                    id={uid + '-mcp-overrides'}
                    rows={2}
                    placeholder='Optional — add session-only MCP servers as JSON'
                    value={mcpServersJson}
                    onChange={(e) => setMcpServersJson(e.target.value)}
                  />
                  <span className="hint">Additional MCP servers for this session only (merged with selected global servers).</span>
                </div>
                <div className="settings-field">
                  <label>Environment variables</label>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {envRows.map((row) => (
                      <div key={row.id} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                        <input
                          className="input"
                          style={{ flex: 1, fontSize: 'var(--fs-sm)' }}
                          aria-label="Environment variable key"
                          placeholder="key"
                          value={row.key}
                          onChange={(e) => {
                            const next = envRows.map((r) => (r.id === row.id ? { ...r, key: e.target.value } : r))
                            setEnvRows(next)
                          }}
                        />
                        <input
                          className="input"
                          style={{ flex: 1, fontSize: 'var(--fs-sm)' }}
                          aria-label="Environment variable value"
                          placeholder="value"
                          value={row.value}
                          onChange={(e) => {
                            const next = envRows.map((r) => (r.id === row.id ? { ...r, value: e.target.value } : r))
                            setEnvRows(next)
                          }}
                        />
                        <button
                          type="button"
                          className="btn btn-icon"
                          style={{ fontSize: 'var(--fs-xs)', padding: '2px 6px' }}
                          onClick={() => {
                            const next = envRows.filter((r) => r.id !== row.id)
                            setEnvRows(next)
                          }}
                          title="Remove variable"
                          aria-label="Remove variable"
                        >
                          <IconX size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="btn"
                    style={{ marginTop: 6, fontSize: 'var(--fs-sm)', padding: '2px 8px' }}
                    onClick={() => setEnvRows((prev) => [...prev, { id: `env-${Date.now()}-${prev.length}`, key: '', value: '' }])}
                  >
                    + Add variable
                  </button>
                  <span className="hint">Custom env vars merged into the subprocess environment.</span>
                </div>
              </div>
            </details>
          </div>

          <div className="modal-footer">
            <span className="hint">Press Esc or click outside to cancel.</span>
            <div className="modal-footer-actions">
              <button className="btn" onClick={onCancel} disabled={submitting}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={submit} disabled={submitting}>
                {submitting ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>
      </Overlay>

      {pickerPresence.shouldRender && (
        <DirectoryPicker
          open={showPicker}
          initialPath={cwd || defaults.cwd}
          onPick={(p) => {
            setCwd(p)
            setShowPicker(false)
          }}
          onClose={() => setShowPicker(false)}
        />
      )}

      {mcpInstallerPresence.shouldRender && (
        <Suspense fallback={null}>
          <McpInstaller
            open={showMcpInstaller}
            server={mcpInstallerEdit}
            onSave={handleMcpInstallerSave}
            onClose={() => { setShowMcpInstaller(false); setMcpInstallerEdit(undefined) }}
          />
        </Suspense>
      )}
    </>
  )
}
