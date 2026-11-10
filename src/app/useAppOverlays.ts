import { useCallback, useRef, useState } from 'react'
import type { SettingsTabName } from '../local-commands'
import type { SlashCommand } from '../types'

/** The four panel overlays that share one mutual-exclusion group: opening any
 *  one of them closes the rest. Modeled as a discriminated union so the type
 *  system makes the "two overlays open at once" state unrepresentable. */
export type PanelOverlayKind = 'settings' | 'git' | 'tasks' | 'worktree' | 'search'

/** The single source of truth for which panel overlay (if any) is open. `null`
 *  means no overlay is rendered. The `sessionId` identifies the chat panel the
 *  overlay is anchored to. */
export type PanelOverlay = { kind: PanelOverlayKind; sessionId: string } | null

export function useAppOverlays() {
  /** The active panel overlay, or null. Replaces the four independent
   *  `settingsOpenFor` / `gitPanelOpenFor` / `tasksPanelOpenFor` /
   *  `worktreeOpenFor` states that previously each had to manually clear the
   *  other three on open. */
  const [panelOverlay, setPanelOverlay] = useState<PanelOverlay>(null)
  // Deep-link request to a specific Settings tab. The nonce makes every
  // request distinct so SettingsPanel re-applies it while already mounted.
  // Kept OUTSIDE the union: a tab request is meaningful only against the
  // settings overlay, and its nonce lifecycle is independent of which overlay
  // is currently open.
  const [settingsTabRequest, setSettingsTabRequest] = useState<{
    sessionId: string
    tab: SettingsTabName
    nonce: number
  } | null>(null)
  // Help dialog state is unrelated to the panel-overlay group and stays
  // independent — toggling help must never close an open overlay and vice
  // versa.
  const [helpOpen, setHelpOpen] = useState(false)
  const [helpCommands, setHelpCommands] = useState<SlashCommand[]>([])

  /** Open the given overlay kind for `sessionId`, replacing any overlay that is
   *  currently open. The single setter call is the whole mutual-exclusion
   *  story — no manual "clear the other three" bookkeeping. */
  const openPanelOverlay = useCallback(
    (kind: PanelOverlayKind, sessionId: string) => {
      setPanelOverlay({ kind, sessionId })
    },
    [],
  )

  /** Close the overlay only when its kind matches the one currently open. A
   *  mismatched kind is a no-op, preserving the existing kind-specific close
   *  semantics (e.g. closing settings must not dismiss a git panel that happens
   *  to be open). */
  const closePanelOverlay = useCallback((kind: PanelOverlayKind) => {
    setPanelOverlay((current) => (current?.kind === kind ? null : current))
  }, [])

  // ── Derived compatibility fields ───────────────────────────────────
  // One source of truth (panelOverlay) drives all four `*OpenFor` reads so App
  // and ChatPanel props stay unchanged. These are plain per-render derivations
  // (string | null), so referential identity is value identity — no memo needed.
  const settingsOpenFor =
    panelOverlay?.kind === 'settings' ? panelOverlay.sessionId : null
  const gitPanelOpenFor = panelOverlay?.kind === 'git' ? panelOverlay.sessionId : null
  const tasksPanelOpenFor = panelOverlay?.kind === 'tasks' ? panelOverlay.sessionId : null
  const worktreeOpenFor =
    panelOverlay?.kind === 'worktree' ? panelOverlay.sessionId : null
  const searchOpenFor = panelOverlay?.kind === 'search' ? panelOverlay.sessionId : null

  // ── Adapter handlers ───────────────────────────────────────────────
  // The existing open/close handler names App already destructures, kept as
  // thin delegates over the union so no JSX rewiring is required.
  const handleOpenSettings = useCallback(
    (id: string) => openPanelOverlay('settings', id),
    [openPanelOverlay],
  )
  const handleCloseSettings = useCallback(() => closePanelOverlay('settings'), [closePanelOverlay])
  const handleOpenGitPanel = useCallback(
    (id: string) => openPanelOverlay('git', id),
    [openPanelOverlay],
  )
  const handleCloseGitPanel = useCallback(() => closePanelOverlay('git'), [closePanelOverlay])
  const handleOpenTasksPanel = useCallback(
    (id: string) => openPanelOverlay('tasks', id),
    [openPanelOverlay],
  )
  const handleCloseTasksPanel = useCallback(() => closePanelOverlay('tasks'), [closePanelOverlay])
  /** The Worktree-changes overlay joins the same mutual-exclusion group as
   *  settings / git / tasks: opening any one of them closes the rest. */
  const handleOpenWorktree = useCallback(
    (id: string) => openPanelOverlay('worktree', id),
    [openPanelOverlay],
  )
  const handleCloseWorktree = useCallback(
    () => closePanelOverlay('worktree'),
    [closePanelOverlay],
  )
  /** Session search joins the same mutual-exclusion group. */
  const handleOpenSearch = useCallback(
    (id: string) => openPanelOverlay('search', id),
    [openPanelOverlay],
  )
  const handleCloseSearch = useCallback(() => closePanelOverlay('search'), [closePanelOverlay])

  const settingsTabNonceRef = useRef(0)
  /** Open the settings overlay AND emit a fresh `{sessionId, tab, nonce}`
   *  deep-link request. The overlay transition goes through the union (so a
   *  previously-open git/tasks/worktree overlay is replaced), while the tab
   *  request + nonce ride their own state so SettingsPanel's nonce-keyed
   *  re-apply contract is preserved. */
  const openSettingsTab = useCallback(
    (id: string, tab: SettingsTabName) => {
      openPanelOverlay('settings', id)
      settingsTabNonceRef.current += 1
      setSettingsTabRequest({ sessionId: id, tab, nonce: settingsTabNonceRef.current })
    },
    [openPanelOverlay],
  )

  const showHelpWithCommands = useCallback((commands: SlashCommand[]) => {
    setHelpCommands(commands)
    setHelpOpen(true)
  }, [])

  const toggleShortcutHelp = useCallback((currentlyOpen: boolean) => {
    if (!currentlyOpen) setHelpCommands([])
    setHelpOpen((value) => !value)
  }, [])

  return {
    panelOverlay,
    openPanelOverlay,
    closePanelOverlay,
    settingsOpenFor,
    settingsTabRequest,
    gitPanelOpenFor,
    tasksPanelOpenFor,
    handleCloseTasksPanel,
    handleOpenTasksPanel,
    worktreeOpenFor,
    searchOpenFor,
    handleOpenWorktree,
    handleCloseWorktree,
    handleOpenSearch,
    handleCloseSearch,
    helpOpen,
    setHelpOpen,
    helpCommands,
    handleCloseSettings,
    handleOpenSettings,
    handleCloseGitPanel,
    handleOpenGitPanel,
    openSettingsTab,
    showHelpWithCommands,
    toggleShortcutHelp,
  }
}
