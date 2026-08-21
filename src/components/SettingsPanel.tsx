// Right-side settings drawer. Focuses on mid-session controls — options that
// can only be set at session creation are shown read-only at the top.

import { lazy, memo, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { api } from '../hooks/useApi'
import { useAutoHeightTransition } from '../hooks/useAutoHeightTransition'
import { useOverlayScrollbar } from '../hooks/useOverlayScrollbar'
import { useMergedRef } from '../utils/mergedRef'
import { useToast } from '../hooks/useToast'
import type { AgentInfo, McpServerConfigMeta, McpServerStatus, ModelInfo, PermissionMode, Plugin, SessionInfo, SessionSkillOverride, SkillLoadMode, SlashCommand } from '../types'
import { PERMISSION_MODES } from '../types'
import type { SkillRecord } from '../../shared/skills'
import { FlagSettingsEditor } from './FlagSettingsEditor'
import { ContextBar } from './ContextBar'
import { IconChevronUp, IconChevronDown, IconLoader, IconSparkles, IconTerminal } from './icons/ToolIcons'
import { EmptyState } from './EmptyState'
import { Skeleton } from './Skeleton'
import { useExitPresence } from '../hooks/useExitPresence'
import { AnimatedCollapse, AnimatedDetails } from './AnimatedCollapse'
import { HooksPanel } from './HooksPanel'
import { Overlay } from './Overlay'

// MarketplaceTab and McpInstaller are heavy modal-within-modal
// components opened only on user intent (Browse plugins / Add MCP).
// Lazy-load both so SettingsPanel itself stays thin.
const McpInstaller = lazy(() =>
  import('./McpInstaller').then((m) => ({ default: m.McpInstaller })),
)
const MarketplaceTab = lazy(() =>
  import('./MarketplaceTab').then((m) => ({ default: m.MarketplaceTab })),
)
import { formatTokens, formatJson } from '../utils/format'
import { pluginTagOf } from '../utils/text'
import type { ContextUsage } from '../hooks/useChatStream'

type SettingsTab = 'general' | 'context' | 'hooks' | 'plugins' | 'mcp'

interface Props {
  session: SessionInfo
  /** Global UI-pref defaults (server-backed). Used to compute the effective
   *  value shown by each pref checkbox (`session.<field> ?? global`) and to
   *  label the "Inheriting global (ON/OFF)" hint when no override is set. */
  globalPrefs: { showPinnedUserMessage: boolean; autoRecap: boolean }
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
  /** Nonce-stamped request to switch tabs (the `/mcp` local command). The
   *  nonce changes on every request so the switch re-applies even when the
   *  panel is already mounted on another tab. */
  tabRequest?: { tab: SettingsTab; nonce: number } | null
  onPluginsReloaded?: () => void
  onSkillsReloaded?: () => void
}

export const SettingsPanel = memo(function SettingsPanel({ session, globalPrefs, onClose, onSessionUpdate, commands = [], agents = [], contextUsage, tabRequest, onPluginsReloaded, onSkillsReloaded }: Props) {
  const [models, setModels] = useState<ModelInfo[]>([])
  // Stable per-instance prefix for label/control id linkage. SettingsPanel
  // mounts once per Chat panel (up to 3), so ids must not collide across
  // instances — useId guarantees document-unique values.
  const panelUid = useId()
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
  const mcpInstallerPresence = useExitPresence(showMcpInstaller)
  const [busy, setBusy] = useState(false)
  // True until the initial models/MCP/usage fetch settles. Drives skeleton
  // placeholders so the lists don't flash "No MCP servers" before data lands.
  const [loadingMeta, setLoadingMeta] = useState(true)
  // All settings success/error feedback rides on the global toast hub.
  // The previous in-panel `err` state and the inline success banner have
  // been removed in favour of right-bottom toasts.
  const toast = useToast()
  const [reloadedPlugins, setReloadedPlugins] = useState<Plugin[]>([])
  // Per-server optimistic state for MCP toggle (Disable/Enable). The SDK's
  // mcp-status control read is flaky and may not reflect a toggle promptly,
  // so we flip the card status locally on click and reconcile against the
  // refreshed truth afterwards. `pendingMcp` tracks in-flight names so the
  // clicked button shows a spinner instead of silently awaiting a round-trip.
  const [pendingMcp, setPendingMcp] = useState<Set<string>>(new Set())
  const [mcpOverride, setMcpOverride] = useState<Record<string, Partial<McpServerStatus>>>({})
  const clearMcpOverride = useCallback((name: string) => {
    setMcpOverride((o) => {
      if (!(name in o)) return o
      const { [name]: _dropped, ...rest } = o
      return rest
    })
  }, [])
  // One-shot guard so opening the Plugins tab auto-loads the plugin list
  // exactly once per mount (the panel remounts per session via key=).
  const pluginsAutoLoadedRef = useRef(false)
  const [showMarketplace, setShowMarketplace] = useState(false)
  // Active tab. Mirrors the global settings modal's tabbed layout so the
  // session panel reads as one long scroll no more — each concern is its
  // own tab (General controls, Context usage, Plugins, MCP servers).
  const [tab, setTab] = useState<SettingsTab>('general')

  // Effective UI prefs: a per-session override wins, else the global default.
  const effShowPinned = session.showPinnedUserMessage ?? globalPrefs.showPinnedUserMessage
  const effAutoRecap = session.autoRecap ?? globalPrefs.autoRecap
  /** POST a per-session pref override. A boolean pins it; `null` clears the
   *  override so the session re-inherits the global default. No success toast
   *  — checkbox toggles are too frequent to toast on every change; only
   *  failures surface. The response carries the updated SessionInfo, which
   *  onSessionUpdate propagates optimistically (the server's follow-up
   *  session-update frame confirms). */
  const changePref = async (
    partial: { showPinnedUserMessage?: boolean | null; autoRecap?: boolean | null },
  ) => {
    try {
      const r = await api.post<{ session: SessionInfo }>(`/sessions/${session.id}/prefs`, partial)
      onSessionUpdate(r.session)
    } catch (e) {
      toast.error(`Couldn't update preference: ${(e as Error).message}`)
    }
  }

  // Apply an external deep-link tab request (e.g. the `/mcp` local command).
  // Uses React's "adjust state during render" pattern
  // (https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes):
  // we track the last-seen nonce in state, and when a fresh request arrives
  // we switch tabs. Keying on the nonce (not the tab value) means the same
  // target tab re-applies on every request even when the panel is already
  // mounted on a different tab — without an effect or a cascading render.
  const [appliedTabNonce, setAppliedTabNonce] = useState<number | null>(null)
  if (tabRequest && tabRequest.nonce !== appliedTabNonce) {
    setAppliedTabNonce(tabRequest.nonce)
    setTab(tabRequest.tab)
  }

  // The marketplace overlay is portaled to <body>, so it lives OUTSIDE App's
  // global Escape chain (which would otherwise close the settings panel
  // underneath it, orphaning the portal on screen). It's rendered as
  // <Overlay variant="marketplace" portal>, which registers in the escape
  // stack: the settings overlay is registered first, so the marketplace lands
  // on top and wins by containment — one Esc dismisses just the marketplace
  // and leaves the settings panel open.

  // Load the model list and MCP status when the panel opens. Parent
  // remounts this component on session switch (via `key={session.id}`),
  // so there's no need to imperatively reset state here. The MCP calls
  // forward SDK control requests to the subprocess — if the session isn't
  // running the server returns 410; skip them rather than surface noise.
  //
  // Models come ONLY from /api/config (the user's configured modelList).
  // We deliberately do NOT query the SDK's supportedModels: the gateway
  // advertises extra models (e.g. *-omni) the user didn't configure, and
  // we don't want those leaking into the picker.
  useEffect(() => {
    if (!session.running) return
    const ac = new AbortController()
    // NOTE: /context-usage is intentionally NOT fetched here. It's a
    // blocking SDK control request that hangs the whole panel open while
    // the subprocess is mid-turn or the proxy init handshake stalls.
    // ContextBar runs off the WebSocket-pushed `contextUsage` prop
    // instead (zero round-trip); the full breakdown is lazy-loaded only
    // when a detail section is expanded — see loadDetailedUsage().

    // models + global MCP config are plain server-side reads — fetch once.
    ;(async () => {
      const [cfgResult, gcResult] = await Promise.allSettled([
        api.get<{ models?: string[] }>('/config', { signal: ac.signal }),
        api.get<{ servers: McpServerConfigMeta[] }>(
          '/mcp-config',
          { signal: ac.signal },
        ),
      ])

      if (ac.signal.aborted) return

      // Models: only the user's configured modelList.
      const serverModelIds =
        cfgResult.status === 'fulfilled' ? (cfgResult.value.models ?? []) : []
      setModels(serverModelIds.map((id): ModelInfo => ({ id })))

      if (gcResult.status === 'fulfilled') {
        // Only include enabled servers — disabled ones can never be
        // connected (toSdkConfig filters them), so showing them as
        // "Available" with an Add button is always misleading.
        setGlobalMcpNames(new Set(
          gcResult.value.servers.filter((s) => s.enabled !== false).map((s) => s.name),
        ))
      }
    })()

    // mcp-status forwards an SDK control request to the subprocess and
    // depends on its init handshake. While the handshake is still in
    // flight (common on proxy backends, or right after spawn) the call
    // times out or fails — and a single failure would otherwise leave the
    // panel stuck on an empty list forever. Retry with a short timeout and
    // exponential backoff so the list fills in once the subprocess is ready.
    ;(async () => {
      const delays = [0, 1_000, 2_000, 4_000, 8_000, 8_000]
      for (let attempt = 0; attempt < delays.length; attempt++) {
        if (delays[attempt] > 0) {
          await new Promise<void>((res) => setTimeout(res, delays[attempt]))
        }
        if (ac.signal.aborted) return
        try {
          const r = await api.get<{ mcp: McpServerStatus[] }>(
            `/sessions/${session.id}/mcp-status`,
            { signal: ac.signal, timeoutMs: 10_000 },
          )
          if (ac.signal.aborted) return
          setMcp(r.mcp)
          setLoadingMeta(false)
          return
        } catch {
          // Failed (timeout / handshake not ready / 410) — fall through to
          // the next backoff attempt. An aborted signal is caught at the
          // top of the next iteration and bails out.
        }
      }
      // Retries exhausted: stop the skeleton so the empty-state note shows.
      if (!ac.signal.aborted) setLoadingMeta(false)
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

  // Merge: WS-pushed lite usage paints the bar and keeps tracking every
  // turn; the detailed REST payload (when loaded) supplies the extra
  // breakdown sections (skills/agents/memoryFiles/mcpTools). We spread
  // detailedUsage FIRST and contextUsage LAST so the live lite fields
  // (totalTokens/maxTokens/percentage/model) always win — otherwise the
  // one-shot detailed snapshot would shadow the live prop and freeze the
  // ContextBar at the moment the user first expanded the breakdown.
  const usage: ContextUsage | null =
    detailedUsage || contextUsage
      ? { ...detailedUsage, ...contextUsage }
      : null

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

  // Editable session title. Seeded from `session.title`; re-synced from the
  // server-propagated value when the input isn't focused (e.g. the title was
  // changed from the sidebar's inline rename while this panel was open).
  // Commits on Enter / blur; Escape cancels and stops propagation so the
  // first Esc cancels the edit instead of closing the panel.
  const [titleDraft, setTitleDraft] = useState(session.title ?? '')
  const titleInputRef = useRef<HTMLInputElement>(null)
  // Set by the Escape handler to tell the synchronous blur→commitTitle path
  // to skip committing. blur() fires onBlur synchronously inside the same
  // keydown call, before the queued setTitleDraft(state reset) is applied —
  // so commitTitle would otherwise read the stale (edited) draft and treat
  // Escape as a submit. The ref is the one safe channel across that gap.
  const skipCommitRef = useRef(false)
  useEffect(() => {
    if (titleInputRef.current && document.activeElement === titleInputRef.current) return
    setTitleDraft(session.title ?? '')
  }, [session.title])

  const commitTitle = async () => {
    if (skipCommitRef.current) {
      skipCommitRef.current = false
      setTitleDraft(session.title ?? '')
      return
    }
    const title = titleDraft.trim()
    if (title === (session.title ?? '').trim()) {
      setTitleDraft(session.title ?? '')
      return
    }
    try {
      const r = await api.patch<{ session: SessionInfo }>(`/sessions/${session.id}`, { title })
      onSessionUpdate(r.session)
    } catch (e) {
      toast.error(`Couldn't rename session: ${(e as Error).message}`)
      setTitleDraft(session.title ?? '')
    }
  }

  const changeModel = (model: string) =>
    runAndRefresh(() => api.post<{ session: SessionInfo }>(`/sessions/${session.id}/model`, { model: model || undefined }))

  const changePermissionMode = (mode: PermissionMode) =>
    runAndRefresh(() => api.post<{ session: SessionInfo }>(`/sessions/${session.id}/permission-mode`, { mode }))

  const setSkillOverride = (override: SessionSkillOverride) =>
    runAndRefresh(() => api.post<{ session: SessionInfo }>(`/sessions/${session.id}/skill-override`, { override }))

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

  // ── Auto-memory (enable / directory / auto-dream) ──────────────────
  // Persisted per-session intent: forwarded to the SDK via
  // applyFlagSettings and re-applied on every re-spawn, so unlike the
  // FlagSettingsEditor above these survive resume / fork / clear.
  // Dormant sessions have no live Query (setMemorySettings 404s), so the
  // controls are disabled until resumed.
  const memoryDisabled = busy || session.terminated || !session.running

  const changeMemory = (
    partial: { autoMemoryEnabled?: boolean | null; autoMemoryDirectory?: string | null; autoDreamEnabled?: boolean | null },
  ) =>
    runAndRefresh(() => api.post<{ session: SessionInfo }>(`/sessions/${session.id}/memory`, partial))

  // Editable memory directory — same draft pattern as the title input:
  // seeded from the server value, re-synced while unfocused, commits on
  // Enter / blur, Escape cancels. Clearing the input commits null (back
  // to the default directory).
  const [memoryDirDraft, setMemoryDirDraft] = useState(session.memory?.autoMemoryDirectory ?? '')
  const memoryDirInputRef = useRef<HTMLInputElement>(null)
  const memoryDirSkipCommitRef = useRef(false)
  useEffect(() => {
    if (memoryDirInputRef.current && document.activeElement === memoryDirInputRef.current) return
    setMemoryDirDraft(session.memory?.autoMemoryDirectory ?? '')
  }, [session.memory?.autoMemoryDirectory])

  const commitMemoryDir = async () => {
    if (memoryDirSkipCommitRef.current) {
      memoryDirSkipCommitRef.current = false
      setMemoryDirDraft(session.memory?.autoMemoryDirectory ?? '')
      return
    }
    const dir = memoryDirDraft.trim()
    if (dir === (session.memory?.autoMemoryDirectory ?? '')) {
      setMemoryDirDraft(session.memory?.autoMemoryDirectory ?? '')
      return
    }
    await runAndRefresh(() =>
      api.post<{ session: SessionInfo }>(`/sessions/${session.id}/memory`, { autoMemoryDirectory: dir || null }),
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
    if (pendingMcp.has(name)) return
    // Optimistic status shown while the round-trip is in flight. Disable lands
    // on 'disabled'; Enable passes through 'pending' on its way to connected.
    const optimisticStatus: McpServerStatus['status'] = enabled ? 'pending' : 'disabled'
    // Confirm against a direction-aware predicate, not a single expected value:
    // Disable is done once the SDK reports 'disabled'; Enable is done once it
    // reports anything *but* 'disabled' (connected / failed / needs-auth …).
    // Equality against 'pending' would never match a successful Enable that
    // lands as 'connected', leaving the card stuck on the optimistic state.
    const isConfirmed = (s: McpServerStatus['status'] | undefined): boolean =>
      s === undefined ? false : enabled ? s !== 'disabled' : s === 'disabled'
    setPendingMcp((s) => new Set(s).add(name))
    // Optimistically flip the card so the dot + button react instantly —
    // don't make the user wait on the SDK round-trip to see anything happen.
    setMcpOverride((o) => ({ ...o, [name]: { ...o[name], status: optimisticStatus } }))
    try {
      await api.post(`/sessions/${session.id}/mcp/${encodeURIComponent(name)}/toggle`, { enabled })
      const r = await api.get<{ mcp: McpServerStatus[] }>(`/sessions/${session.id}/mcp-status`)
      setMcp(r.mcp)
      // If the SDK now confirms the toggle, the override is redundant. If it
      // doesn't (flaky read / not yet propagated), KEEP the override so the
      // card doesn't flicker back to the pre-toggle state — a later refresh
      // will correct it.
      if (isConfirmed(r.mcp.find((s) => s.name === name)?.status)) {
        clearMcpOverride(name)
      }
    } catch (e) {
      toast.error(`Couldn't toggle MCP: ${(e as Error).message}`)
      // Revert to the real status — drop the optimistic override and re-sync.
      clearMcpOverride(name)
      void refreshMcp()
    } finally {
      setPendingMcp((s) => {
        const n = new Set(s)
        n.delete(name)
        return n
      })
    }
  }

  const [reloadingPlugins, setReloadingPlugins] = useState(false)
  const reloadPlugins = async () => {
    if (reloadingPlugins) return
    setReloadingPlugins(true)
    try {
      const res = await api.post<{ result: { plugins?: Plugin[] } }>(`/sessions/${session.id}/plugins/reload`)
      if (res.result?.plugins) setReloadedPlugins(res.result.plugins)
      await refreshMcp()
      onPluginsReloaded?.()
    } catch (e) {
      toast.error(`Couldn't reload plugins: ${(e as Error).message}`)
    } finally {
      setReloadingPlugins(false)
    }
  }

  const [reloadingSkills, setReloadingSkills] = useState(false)
  const reloadSkills = async () => {
    if (reloadingSkills) return
    setReloadingSkills(true)
    try {
      await api.post(`/sessions/${session.id}/skills/reload`)
      onSkillsReloaded?.()
    } catch (e) {
      toast.error(`Couldn't reload skills: ${(e as Error).message}`)
    } finally {
      setReloadingSkills(false)
    }
  }

  // Global MCP servers not yet connected to this session.
  // Prefer the snapshot-derived mcpServerNames (reliable, arrives via WS)
  // over the mcp-status result (flaky SDK control request that may fail).
  // Fallback to mcp for sessions created before mcpServerNames was added.
  const availableMcpNames = useMemo(() => {
    const currentNames = new Set(
      session.mcpServerNames ?? mcp.map((s) => s.name),
    )
    return [...globalMcpNames].filter((n) => !currentNames.has(n)).sort()
  }, [session.mcpServerNames, mcp, globalMcpNames])

  // Merge the SDK-reported mcp list with session.mcpServerNames so that
  // servers known to be connected (from the snapshot) always show up —
  // even when the mcp-status SDK control request fails or times out.
  // Servers present in mcpServerNames but missing from mcp are rendered
  // as "pending" cards (the existing McpServerCard already styles that
  // status and shows a Reconnect button).
  const effectiveMcp = useMemo(() => {
    const names = session.mcpServerNames
    if (!names || names.length === 0) return mcp
    const byName = new Map(mcp.map((s) => [s.name, s]))
    const result: McpServerStatus[] = []
    for (const name of names) {
      result.push(byName.get(name) ?? { name, status: 'pending' })
    }
    // Append SDK-reported servers NOT in mcpServerNames (inline / session-only).
    for (const s of mcp) {
      if (!names.includes(s.name)) result.push(s)
    }
    return result
  }, [session.mcpServerNames, mcp])
  // Apply optimistic overrides (toggle in-flight) on top of the resolved list.
  const effectiveMcpWithOverride = useMemo(() => {
    if (!mcpOverride || Object.keys(mcpOverride).length === 0) return effectiveMcp
    return effectiveMcp.map((s) =>
      mcpOverride[s.name] ? { ...s, ...mcpOverride[s.name] } : s,
    )
  }, [effectiveMcp, mcpOverride])

  const addMcpServer = async (name: string) => {
    try {
      setBusy(true)
      // setMcpServers has REPLACE semantics over the dynamic set. Build
      // the new set from the snapshot baseline (reliable) + the new name,
      // then send only the global subset as enabledMcpServers. Inline
      // (non-global) servers already in the session are forwarded via the
      // `servers` map so they aren't dropped by the replace.
      const baseline = new Set(
        session.mcpServerNames ?? mcp.map((s) => s.name),
      )
      baseline.add(name)
      // enabledMcpServers: only names that exist in the global config.
      const enabledMcpServers = [...baseline]
        .filter((n) => globalMcpNames.has(n))
        .sort()
      // Inline (non-global) session servers — preserve them so replace
      // doesn't silently drop them.
      const servers: Record<string, unknown> = {}
      for (const srv of mcp) {
        if (!globalMcpNames.has(srv.name) && srv.config) {
          servers[srv.name] = srv.config
        }
      }
      const body: { enabledMcpServers: string[]; servers?: Record<string, unknown> } = { enabledMcpServers }
      if (Object.keys(servers).length > 0) body.servers = servers
      await api.post(`/sessions/${session.id}/mcp/servers`, body)
      await refreshMcp()
      toast.success(`Added MCP server "${name}"`)
    } catch (e) {
      toast.error(`Couldn't add MCP: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  // Auto-load the plugin list the first time the Plugins tab is opened. The
  // reload response carries the plugin NAMES the grouping logic needs to
  // associate skills/agents with their owning plugin (the description's
  // "(plugin)" tag is matched against these names) — without it everything
  // falls back to "Built-in". Fires once per mount; the panel remounts per
  // session, so a new session re-loads. Skipped if a manual reload already
  // populated the list.
  useEffect(() => {
    if (tab !== 'plugins') return
    if (pluginsAutoLoadedRef.current) return
    if (!session.running || session.terminated) return
    pluginsAutoLoadedRef.current = true
    // Defer out of the synchronous effect body — reloadPlugins() awaits an
    // HTTP round-trip before any setState, so the state update never happens
    // during this effect's render pass.
    const t = setTimeout(() => { void reloadPlugins() }, 0)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, session.running, session.terminated])

  const handleMcpInstallerSave = () => {
    setShowMcpInstaller(false)
    setMcpInstallerEdit(undefined)
    // Refresh both global names and MCP status
    api.get<{ servers: McpServerConfigMeta[] }>('/mcp-config')
      .then((r) => setGlobalMcpNames(new Set(r.servers.filter((s) => s.enabled !== false).map((s) => s.name))))
      .catch(() => { /* ignore */ })
    void refreshMcp()
  }

  // Derive plugin groups. The SDK does NOT namespace plugin commands as
  // `plugin:command` — it returns bare skill names and encodes the owning
  // plugin as a leading `(pluginName)` tag in the description (e.g.
  // "(skills) Use this skill…"). We associate a command/agent with a plugin
  // when that tag matches a name from the reloadPlugins response; everything
  // else is genuinely built-in (core CLI commands, core agents).
  const pluginGroups = useMemo(() => {
    const groups = new Map<string, { plugin: Plugin | undefined; commands: SlashCommand[]; agents: AgentInfo[] }>()
    const pluginMeta = new Map(reloadedPlugins.map((p) => [p.name, p]))
    const pluginNames = new Set(reloadedPlugins.map((p) => p.name))
    // Per-group seen-sets guard against residual SDK duplicates (the same
    // skill surfacing twice — see the dedupe note in mp-store).
    const seenCommands = new Map<string, Set<string>>()
    const seenAgents = new Map<string, Set<string>>()

    const keyFor = (description: string | undefined): string => {
      const tag = pluginTagOf(description)
      return tag && pluginNames.has(tag) ? tag : '__builtin__'
    }
    const ensure = (key: string) => {
      if (!groups.has(key)) {
        groups.set(key, { plugin: pluginMeta.get(key), commands: [], agents: [] })
        seenCommands.set(key, new Set())
        seenAgents.set(key, new Set())
      }
      return groups.get(key)!
    }

    for (const cmd of commands) {
      const key = keyFor(cmd.description)
      ensure(key)
      if (seenCommands.get(key)!.has(cmd.name)) continue
      seenCommands.get(key)!.add(cmd.name)
      groups.get(key)!.commands.push(cmd)
    }
    for (const agent of agents) {
      const key = keyFor(agent.description)
      ensure(key)
      if (seenAgents.get(key)!.has(agent.name)) continue
      seenAgents.get(key)!.add(agent.name)
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

  const tabs: { key: SettingsTab; label: string }[] = [
    { key: 'general', label: 'General' },
    { key: 'context', label: 'Context' },
    { key: 'hooks', label: 'Hooks' },
    { key: 'plugins', label: 'Plugins' },
    { key: 'mcp', label: 'MCP Servers' },
  ]

  const panelBodyRef = useRef<HTMLDivElement | null>(null)
  const setPanelBodyOs = useOverlayScrollbar({ autoHide: 'leave' })
  const panelBodyRefMerged = useMergedRef(panelBodyRef, setPanelBodyOs)
  const panelContentRef = useRef<HTMLDivElement | null>(null)
  const heightAnimationKey = [
    tab,
    busy,
    loadingMeta,
    loadingUsage,
    models.length,
    mcp.length,
    commands.length,
    agents.length,
    pluginGroups.length,
    reloadedPlugins.length,
    detailedUsage ? 'detailed' : 'summary',
    usage?.totalTokens ?? 0,
  ].join('|')
  const measureSettingsBodyHeight = useCallback(() => {
    const body = panelBodyRef.current
    const content = panelContentRef.current
    if (!body || !content) return null
    const overlay = body.closest('.settings-overlay') as HTMLElement | null
    const availablePanelHeight = overlay?.clientHeight ?? Number.POSITIVE_INFINITY
    const availableBodyHeight = Math.max(0, availablePanelHeight - body.offsetTop)
    return Math.min(content.scrollHeight, availableBodyHeight || content.scrollHeight)
  }, [])
  const { captureHeight: captureSettingsHeight } = useAutoHeightTransition(panelBodyRef, heightAnimationKey, {
    measureTargetHeight: measureSettingsBodyHeight,
    observe: panelContentRef,
  })

  const switchTab = useCallback((nextTab: SettingsTab) => {
    if (nextTab === tab) return
    captureSettingsHeight()
    setTab(nextTab)
  }, [captureSettingsHeight, tab])

  return (
    <aside className="settings-panel" aria-label="Session settings">
      <div className="settings-panel-header">
        <h3>Session settings</h3>
        <button className="btn btn-sm" onClick={onClose}>
          Close
        </button>
      </div>

      {/* Tab bar — reuses the global settings modal's tab styling for
          visual consistency. */}
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

      {/* All settings feedback (success/error) flows through the global
          toast hub now (see ToastHost). The toast itself is the live
          region; screen readers pick up the role=alert from there. */}

      {/* Scrollable body — header + tab bar stay pinned above it, mirroring
          the global settings modal (where only .global-settings-body scrolls). */}
      <div ref={panelBodyRefMerged} className="settings-panel-body">
        <div ref={panelContentRef} className="settings-panel-content" data-animate={tab}>
      {tab === 'general' && (
      <>
      <div className="settings-section">
        <h4>Read-only (set at create)</h4>
        <ReadOnlyField label="Session ID" value={session.id} mono />
        <ReadOnlyField label="CWD" value={session.cwd ?? '—'} mono />
        <ReadOnlyField label="Created" value={new Date(session.createdAt).toLocaleString()} />
      </div>

      <div className="settings-section">
        <h4>Live controls</h4>
        <div className="settings-field">
          <label htmlFor={panelUid + '-title'}>Title</label>
          <input
            id={panelUid + '-title'}
            ref={titleInputRef}
            className="input"
            value={titleDraft}
            placeholder="(auto)"
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={() => void commitTitle()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                ;(e.currentTarget as HTMLInputElement).blur()
              } else if (e.key === 'Escape') {
                // Only intercept Escape when there are pending edits —
                // otherwise let it propagate so the global Escape chain
                // closes the panel as usual.
                if (titleDraft.trim() !== (session.title ?? '').trim()) {
                  e.preventDefault()
                  e.stopPropagation()
                  skipCommitRef.current = true
                  setTitleDraft(session.title ?? '')
                }
                ;(e.currentTarget as HTMLInputElement).blur()
              }
            }}
          />
        </div>
        <div className="settings-field">
          <label htmlFor={panelUid + '-model'}>Model</label>
          <select
            id={panelUid + '-model'}
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
          <label htmlFor={panelUid + '-permission-mode'}>Permission mode</label>
          <select
            id={panelUid + '-permission-mode'}
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
        <h4>Memory</h4>
        {!session.running && !session.terminated && (
          <span className="hint">Resume the session to change memory settings.</span>
        )}
        <div className="settings-field">
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={session.memory?.autoMemoryEnabled === true}
              disabled={memoryDisabled}
              onChange={() =>
                void changeMemory({ autoMemoryEnabled: session.memory?.autoMemoryEnabled === true ? false : true })
              }
            />
            <span>Auto-memory</span>
          </label>
          <span className="hint">
            Lets Claude read from and write to this project's auto-memory directory; recalled
            memories appear in the transcript.{' '}
            {session.memory?.autoMemoryEnabled === undefined
              ? 'Not set (following project default).'
              : session.memory.autoMemoryEnabled
                ? 'Enabled.'
                : 'Disabled.'}
            {session.memory?.autoMemoryEnabled !== undefined && (
              <button
                type="button"
                className="settings-reset-link"
                disabled={memoryDisabled}
                onClick={() => void changeMemory({ autoMemoryEnabled: null })}
              >
                Reset (use default)
              </button>
            )}
          </span>
        </div>

        <div className="settings-field">
          <label htmlFor={panelUid + '-memory-dir'}>Memory directory</label>
          <input
            id={panelUid + '-memory-dir'}
            ref={memoryDirInputRef}
            type="text"
            className="input"
            value={memoryDirDraft}
            placeholder="~/.claude/projects/<this project>/memory/ (default)"
            disabled={memoryDisabled}
            onChange={(e) => setMemoryDirDraft(e.target.value)}
            onBlur={() => void commitMemoryDir()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                memoryDirInputRef.current?.blur()
              } else if (e.key === 'Escape') {
                memoryDirSkipCommitRef.current = true
                memoryDirInputRef.current?.blur()
              }
            }}
          />
          <span className="hint">
            Overrides the default memory directory (supports <code>~/</code>). Ignored when pinned
            in project settings. Clearing the field restores the default.
            {session.memory?.autoMemoryDirectory !== undefined && (
              <button
                type="button"
                className="settings-reset-link"
                disabled={memoryDisabled}
                onClick={() => void changeMemory({ autoMemoryDirectory: null })}
              >
                Reset (use default)
              </button>
            )}
          </span>
        </div>

        <div className="settings-field">
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={session.memory?.autoDreamEnabled === true}
              disabled={memoryDisabled}
              onChange={() =>
                void changeMemory({ autoDreamEnabled: session.memory?.autoDreamEnabled === true ? false : true })
              }
            />
            <span>Background memory consolidation</span>
          </label>
          <span className="hint">
            Auto-dream: consolidates accumulated memories in the background so recall stays
            relevant.{' '}
            {session.memory?.autoDreamEnabled === undefined
              ? 'Not set (following server default).'
              : session.memory.autoDreamEnabled
                ? 'Enabled.'
                : 'Disabled.'}
            {session.memory?.autoDreamEnabled !== undefined && (
              <button
                type="button"
                className="settings-reset-link"
                disabled={memoryDisabled}
                onClick={() => void changeMemory({ autoDreamEnabled: null })}
              >
                Reset (use default)
              </button>
            )}
          </span>
        </div>
      </div>

      <div className="settings-section">
        <h4>Preferences</h4>
        {/* Per-session overrides on top of the global defaults (set in the
            Global Settings modal). The checkbox reflects the EFFECTIVE value
            (session override ?? global); toggling writes a per-session
            override. "Reset" clears the override so the session re-inherits
            the global default live. */}
        <div className="settings-field">
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={effShowPinned}
              disabled={busy || session.terminated}
              onChange={() => void changePref({ showPinnedUserMessage: !effShowPinned })}
            />
            <span>Show pinned "current question" header</span>
          </label>
          <span className="hint">
            Pins the user message of the turn in view at the top of the chat
            when it scrolls out of sight, so you keep context while reading a
            long reply.{' '}
            {session.showPinnedUserMessage === undefined
              ? `Inheriting global (${globalPrefs.showPinnedUserMessage ? 'ON' : 'OFF'}).`
              : 'Session override.'}
            {session.showPinnedUserMessage !== undefined && (
              <button
                type="button"
                className="settings-reset-link"
                disabled={busy || session.terminated}
                onClick={() => void changePref({ showPinnedUserMessage: null })}
              >
                Reset (inherit global)
              </button>
            )}
          </span>
        </div>

        <div className="settings-field">
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={effAutoRecap}
              disabled={busy || session.terminated}
              onChange={() => void changePref({ autoRecap: !effAutoRecap })}
            />
            <span>Auto-generate session recap</span>
          </label>
          <span className="hint">
            Automatically produces a session summary after the conversation has
            been idle. Manual recap (Alt+R) still works when this is off.{' '}
            {session.autoRecap === undefined
              ? `Inheriting global (${globalPrefs.autoRecap ? 'ON' : 'OFF'}).`
              : 'Session override.'}
            {session.autoRecap !== undefined && (
              <button
                type="button"
                className="settings-reset-link"
                disabled={busy || session.terminated}
                onClick={() => void changePref({ autoRecap: null })}
              >
                Reset (inherit global)
              </button>
            )}
          </span>
        </div>
      </div>
      </>
      )}

      {tab === 'context' && (
      <div className="settings-section">
        <SessionSkillPolicyCard
          session={session}
          disabled={busy || session.terminated}
          onApply={setSkillOverride}
        />
        <h4>Context usage</h4>
        {/* ContextBar runs off the WS-pushed lite usage — paints instantly,
            no blocking request. The detail disclosures below lazy-load the
            full breakdown (a blocking SDK control request) only when the
            user actually opens one. */}
        <ContextBar usage={usage} />
        {usage?.skills && (
          <div className="settings-skill-reload-row">
            <AnimatedDetails
              className="settings-detail"
              summary={`Skills: ${usage.skills.includedSkills}/${usage.skills.totalSkills} loaded, ${formatTokens(usage.skills.tokenCount)}`}
            >
              <div className="settings-detail-body">
                {usage.skills.skillFrontmatter?.map((s) => (
                  <div key={s.name} className="settings-kv-row">
                    <code>{s.name}</code>
                    <span className="settings-kv-source">{s.source}</span>
                    <span className="settings-kv-tokens">{formatTokens(s.tokens)}</span>
                  </div>
                ))}
              </div>
            </AnimatedDetails>
            <button className="btn btn-sm" onClick={reloadSkills} disabled={busy || session.terminated || reloadingSkills}>
              {reloadingSkills ? <IconLoader size={12} className="settings-card-spin" /> : 'Reload skills'}
            </button>
          </div>
        )}
        {usage?.agents && (
          <AnimatedDetails
            className="settings-detail settings-detail-tight"
            summary={`Agents: ${usage.agents.agents?.length ?? 0}, ${formatTokens(usage.agents.tokenCount)}`}
          >
            <div className="settings-detail-body">
              {usage.agents.agents?.map((a, i) => (
                <div key={i} className="settings-kv-row">
                  <code>{a.agentType}</code>
                  <span className="settings-kv-source">{a.source}</span>
                  <span className="settings-kv-tokens">{formatTokens(a.tokens)}</span>
                </div>
              ))}
            </div>
          </AnimatedDetails>
        )}
        {/* Always-present disclosure: opening it triggers the lazy fetch of
            the full breakdown. The skills/agents sections above light up
            once it resolves (they read from the same merged `usage`). */}
        <AnimatedDetails
          className="settings-detail"
          onOpenChange={(nextOpen) => { if (nextOpen) loadDetailedUsage() }}
          summary={`Detailed breakdown${!detailedUsage && loadingUsage ? ' (loading...)' : ''}`}
        >
          <pre className="tool-input settings-raw-pre">
            {detailedUsage
              ? formatJson(detailedUsage)
              : loadingUsage
                ? 'Loading...'
                : usage
                  ? formatJson(usage)
                  : '-'}
          </pre>
        </AnimatedDetails>
      </div>
      )}

      {tab === 'hooks' && (
        <HooksPanel
          session={session}
          disabled={busy || session.terminated}
          onSessionUpdate={onSessionUpdate}
        />
      )}

      {tab === 'plugins' && (
      <>
      <div className="settings-section">
        <div className="settings-section-head">
          <h4>Plugins</h4>
          <button className="btn btn-sm" onClick={reloadPlugins} disabled={busy || session.terminated || reloadingPlugins}>
            {reloadingPlugins ? <IconLoader size={12} className="settings-card-spin" /> : 'Reload plugins'}
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
          <h4>Marketplace</h4>
          <button className="btn btn-sm" onClick={() => setShowMarketplace(true)}>
            Browse plugins
          </button>
        </div>
        <div className="settings-note">
          Browse and install plugins from registered marketplaces.
        </div>
      </div>
      </>
      )}

      {tab === 'mcp' && (
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
        {loadingMeta && effectiveMcpWithOverride.length === 0 && <Skeleton rows={2} />}
        {!loadingMeta && effectiveMcpWithOverride.length === 0 && <EmptyState icon={<IconTerminal size={16} />} title="No MCP servers" />}
        {effectiveMcpWithOverride.map((srv) => (
          <McpServerCard
            key={srv.name}
            server={srv}
            isGlobal={globalMcpNames.has(srv.name)}
            onReconnect={reconnectMcp}
            onToggle={toggleMcp}
            pending={pendingMcp.has(srv.name)}
            disabled={busy || session.terminated}
          />
        ))}
        {availableMcpNames.length > 0 && (
          <div className="settings-mcp-available">
            <div className="settings-section-head compact">
              <span className="settings-note">Available from global config</span>
            </div>
            {availableMcpNames.map((name) => (
              <div key={name} className="settings-mcp-available-row">
                <span className="settings-mcp-available-name">{name}</span>
                <button
                  className="btn btn-sm"
                  onClick={() => void addMcpServer(name)}
                  disabled={busy || session.terminated}
                >
                  Add
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      )}
        </div>
      </div>

      <Overlay
        variant="marketplace"
        portal
        ariaLabel="Plugin Marketplace"
        open={showMarketplace}
        onClose={() => setShowMarketplace(false)}
        trapFocus
        // The `.marketplace-overlay` has no CSS transition, so match the old
        // immediate unmount behavior with a zero-length exit window.
        exitDurationMs={0}
      >
        <div className="modal-header">
          <h3>Plugin Marketplace</h3>
          <button className="btn btn-sm" onClick={() => setShowMarketplace(false)}>Close</button>
        </div>
        <div style={{ overflowY: 'auto', padding: 16 }}>
          <Suspense fallback={<div className="lazy-tab-loading">Loading marketplace…</div>}>
            <MarketplaceTab onPluginToggled={() => { onPluginsReloaded?.() }} />
          </Suspense>
        </div>
      </Overlay>

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

// ── Session skill policy card ─────────────────────────────────────
//
// Per-session override of the global skill loading policy. Mirrors the
// global Settings → Skills card visually so both pages feel like one
// system, but adds two extra options that only make sense at the session
// scope:
//   - Inherit  : follow the server-wide config (the implicit default).
//   - Disabled : force every skill 'off' for this session, regardless of
//                the global mode.
// Plus the same default / all / allowlist trio as the global card.
//
// RAM-only by design (see shared/skills.ts SessionSkillOverride): pinning
// a session-level override is a "for the current run" gesture; it resets
// when the live Query is unloaded so multi-panel users can run two
// sessions side-by-side with different skill policies without having to
// remember to clear them.

type SessionSkillKind = 'inherit' | 'default' | 'all' | 'allowlist' | 'disabled'

const SESSION_SKILL_OPTIONS: { kind: SessionSkillKind; title: string; desc: string }[] = [
  { kind: 'inherit', title: 'Inherit (use global)', desc: 'Follow the server-wide policy from Settings → Skills.' },
  { kind: 'default', title: 'SDK default', desc: 'Leave skill discovery to the SDK (name-only surfacing).' },
  { kind: 'all', title: 'Enable all discovered skills', desc: 'Load every filesystem skill the SDK can discover.' },
  { kind: 'allowlist', title: 'Enable selected skills only', desc: 'Load only the checked skill names.' },
  { kind: 'disabled', title: 'Disable all skills', desc: 'Force every skill off for this session.' },
]

function overrideToKind(override: SessionSkillOverride | undefined): SessionSkillKind {
  if (!override || override.kind === 'inherit') return 'inherit'
  if (override.kind === 'disabled') return 'disabled'
  return override.mode
}

function kindToOverride(kind: SessionSkillKind, allowlist: string[]): SessionSkillOverride {
  if (kind === 'inherit') return { kind: 'inherit' }
  if (kind === 'disabled') return { kind: 'disabled' }
  if (kind === 'allowlist') return { kind: 'mode', mode: 'allowlist', allowlist }
  return { kind: 'mode', mode: kind }
}

function SessionSkillPolicyCard({
  session,
  disabled,
  onApply,
}: {
  session: SessionInfo
  disabled: boolean
  onApply: (override: SessionSkillOverride) => Promise<void>
}) {
  const [skills, setSkills] = useState<SkillRecord[]>([])
  const [globalPolicy, setGlobalPolicy] = useState<{ mode: SkillLoadMode; enabledSkills: string[] } | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Fetch the available skill set + the current global policy. Scoped to
  // session.cwd so project-only skills surface in the allowlist for the
  // right workspace. Re-runs when cwd changes (rare — usually never on
  // a live session, but the hook is dirt cheap and bug-correct this way).
  useEffect(() => {
    const ac = new AbortController()
    const cwdParam = session.cwd ? `?cwd=${encodeURIComponent(session.cwd)}` : ''
    api
      .get<{ skills: SkillRecord[]; policy: { mode: SkillLoadMode; enabledSkills: string[] } }>(
        `/skills${cwdParam}`,
        { signal: ac.signal },
      )
      .then((r) => {
        setSkills(r.skills.filter((s) => s.valid))
        setGlobalPolicy(r.policy)
        setLoaded(true)
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return
        setError((e as Error).message || 'Failed to load skills')
        setLoaded(true)
      })
    return () => { ac.abort() }
  }, [session.cwd])

  const override = session.skillOverride
  const kind = overrideToKind(override)
  const currentAllowlist = useMemo(() => {
    if (override?.kind === 'mode' && override.mode === 'allowlist') {
      return override.allowlist ?? []
    }
    return []
  }, [override])
  const allowlistSet = useMemo(() => new Set(currentAllowlist), [currentAllowlist])

  // Skill names ordered scope (project first — the more local / opinionated
  // surface) then alpha, mirroring the global Skills tab.
  const skillNames = useMemo(() => {
    const names = skills
      .slice()
      .sort((a, b) => {
        if (a.scope !== b.scope) return a.scope === 'project' ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      .map((s) => s.name)
    // De-duplicate (a project skill can shadow a user skill of the same
    // name; the SDK uses one of them but the user only needs one checkbox).
    return [...new Set(names)]
  }, [skills])

  const onPickKind = (next: SessionSkillKind) => {
    if (next === kind) return
    void onApply(kindToOverride(next, currentAllowlist))
  }

  const toggleAllow = (name: string) => {
    const set = new Set(currentAllowlist)
    if (set.has(name)) set.delete(name); else set.add(name)
    void onApply(kindToOverride('allowlist', [...set]))
  }

  // Effective hint — what the SDK is actually loading right now. Mirrors
  // the resolveEffectiveSkillPolicy logic used on the server (inherit ⇒
  // follow global; everything else ⇒ this session's pin).
  const effectiveHint = useMemo(() => {
    if (kind === 'disabled') return 'Effective: all skills disabled for this session.'
    if (kind === 'inherit') {
      if (!globalPolicy) return 'Effective: inherit (loading global policy…)'
      const m = globalPolicy.mode
      if (m === 'allowlist') return `Effective: inherit → allowlist (${globalPolicy.enabledSkills.length} pinned globally).`
      if (m === 'all') return 'Effective: inherit → all skills enabled globally.'
      return 'Effective: inherit → SDK default (name-only).'
    }
    if (kind === 'allowlist') {
      return `Effective: allowlist (${currentAllowlist.length} of ${skillNames.length}).`
    }
    if (kind === 'all') return 'Effective: all skills enabled for this session.'
    return 'Effective: SDK default (name-only) for this session.'
  }, [kind, globalPolicy, currentAllowlist, skillNames])

  return (
    <div className="settings-skill-policy-card">
      <div className="settings-section-head compact">
        <div>
          <h4>Session skill policy</h4>
          <span className="settings-note">
            Override the global skill loading policy for just this session.
            RAM-only — resets to inherit when the session is resumed or the server restarts.
          </span>
        </div>
      </div>
      <div className="settings-skill-mode-grid">
        {SESSION_SKILL_OPTIONS.map((option) => (
          <label
            key={option.kind}
            className={`settings-skill-mode-card${kind === option.kind ? ' active' : ''}`}
          >
            <input
              type="radio"
              name={`session-skill-${session.id}`}
              checked={kind === option.kind}
              disabled={disabled}
              onChange={() => onPickKind(option.kind)}
            />
            <span>
              <strong>{option.title}</strong>
              <small>{option.desc}</small>
            </span>
          </label>
        ))}
      </div>
      <span className="hint" style={{ display: 'block', marginTop: 8 }}>{effectiveHint}</span>
      {kind === 'allowlist' && (
        <div className="settings-skill-allowlist">
          {!loaded && <div className="settings-empty-note">Loading skills…</div>}
          {loaded && error && <div className="settings-empty-note">Couldn't load skills: {error}</div>}
          {loaded && !error && skillNames.length === 0 && (
            <EmptyState icon={<IconSparkles size={16} />} title="No skills discovered for this workspace" />
          )}
          {skillNames.map((name) => (
            <label
              key={name}
              className={`settings-skill-check${allowlistSet.has(name) ? ' active' : ''}`}
            >
              <input
                type="checkbox"
                checked={allowlistSet.has(name)}
                disabled={disabled}
                onChange={() => toggleAllow(name)}
              />
              <span>{name}</span>
            </label>
          ))}
        </div>
      )}
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
  const toast = useToast()

  const toggle = async () => {
    if (!sessionId || name === 'Built-in' || toggling) return
    const next = !enabled
    // Optimistically flip the dot + label so the user sees the change
    // instantly — the SDK doesn't expose authoritative state to reconcile
    // against, so local state is the source of truth (ephemeral by design).
    setEnabled(next)
    setToggling(true)
    try {
      await api.post(`/sessions/${sessionId}/plugins/${encodeURIComponent(name)}/toggle`, { enabled: next })
    } catch (e) {
      setEnabled(!next) // rollback
      toast.error(`Couldn't toggle plugin: ${(e as Error).message}`)
    } finally {
      setToggling(false)
    }
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
          toggling ? (
            <span className="settings-card-pending" aria-label="updating">
              <IconLoader size={12} className="settings-card-spin" />
            </span>
          ) : (
            <button
              className="btn btn-xs"
              onClick={toggle}
              disabled={disabled}
            >
              {enabled ? 'Disable' : 'Enable'}
            </button>
          )
        )}
        {(commands.length > 0 || agents.length > 0) && (
          <button className="btn btn-xs" onClick={() => setExpanded(!expanded)} aria-label={expanded ? 'Collapse' : 'Expand'} aria-expanded={expanded}>
            {expanded ? <IconChevronUp size={12} /> : <IconChevronDown size={12} />}
          </button>
        )}
      </div>
      {plugin?.path && (
        <div className="settings-card-path">{plugin.path}</div>
      )}
      <AnimatedCollapse open={expanded}>
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
      </AnimatedCollapse>
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
  pending,
}: {
  server: McpServerStatus
  isGlobal: boolean
  onReconnect: (name: string) => void
  onToggle: (name: string, enabled: boolean) => void
  disabled: boolean
  pending: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const color = STATUS_COLORS[server.status] ?? 'var(--fg-muted)'
  // Allow reconnecting any server that isn't disabled — even a healthy
  // `connected` one, since users sometimes need to force a refresh (e.g. the
  // upstream server changed its tool set). Disabled servers use Enable instead.
  const canReconnect = server.status !== 'disabled'
  const canDisable = server.status !== 'disabled'
  const canEnable = server.status === 'disabled'
  const inert = disabled || pending

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
          <button className="btn btn-xs" onClick={() => onReconnect(server.name)} disabled={inert}>
            Reconnect
          </button>
        )}
        {pending ? (
          // While a toggle is in flight, hide both Disable/Enable and show a
          // spinner. Re-rendering the *other* button (status flips optimistically)
          // would be confusing — e.g. clicking Disable then seeing a spinning
          // Enable. A dedicated spinner avoids that ambiguity.
          <span className="settings-card-pending" aria-label="updating">
            <IconLoader size={12} className="settings-card-spin" />
          </span>
        ) : (
          <>
            {canDisable && (
              <button className="btn btn-xs" onClick={() => onToggle(server.name, false)} disabled={inert}>
                Disable
              </button>
            )}
            {canEnable && (
              <button className="btn btn-xs" onClick={() => onToggle(server.name, true)} disabled={inert}>
                Enable
              </button>
            )}
          </>
        )}
        {server.tools && server.tools.length > 0 && (
          <button className="btn btn-xs" onClick={() => setExpanded(!expanded)} aria-label={expanded ? 'Collapse' : 'Expand'} aria-expanded={expanded}>
            {expanded ? <IconChevronUp size={12} /> : <IconChevronDown size={12} />}
          </button>
        )}
      </div>
      {server.error && (
        <div className="settings-card-error">{server.error}</div>
      )}
      {server.status === 'needs-auth' && (
        <div className="settings-card-desc">
          Authorization required — clicking Reconnect opens an authorization prompt in the chat panel.
        </div>
      )}
      <AnimatedCollapse open={expanded && !!server.tools}>
        <div className="settings-card-body">
          {server.tools?.map((t) => (
            <div key={t.name} className="settings-card-item">
              <code>{t.name}</code>
              {t.annotations?.readOnly && <span className="settings-tag readonly">read-only</span>}
              {t.annotations?.destructive && <span className="settings-tag destructive">destructive</span>}
              {t.annotations?.openWorld && <span className="settings-tag openworld">open-world</span>}
              {t.description && <span className="settings-card-desc">{t.description}</span>}
            </div>
          ))}
        </div>
      </AnimatedCollapse>
    </div>
  )
}
