import { useCallback, useRef, useState } from 'react'
import type { SettingsTabName } from '../local-commands'
import type { SlashCommand } from '../types'

export function useAppOverlays() {
  /** When non-null, the Settings overlay is rendered on top of this chat panel. */
  const [settingsOpenFor, setSettingsOpenFor] = useState<string | null>(null)
  // Deep-link request to a specific Settings tab. The nonce makes every
  // request distinct so SettingsPanel re-applies it while already mounted.
  const [settingsTabRequest, setSettingsTabRequest] = useState<{
    sessionId: string
    tab: SettingsTabName
    nonce: number
  } | null>(null)
  const [gitPanelOpenFor, setGitPanelOpenFor] = useState<string | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const [helpCommands, setHelpCommands] = useState<SlashCommand[]>([])

  const handleCloseSettings = useCallback(() => setSettingsOpenFor(null), [])
  const handleOpenSettings = useCallback((id: string) => {
    setSettingsOpenFor(id)
    setGitPanelOpenFor(null)
  }, [])
  const handleCloseGitPanel = useCallback(() => setGitPanelOpenFor(null), [])
  const handleOpenGitPanel = useCallback((id: string) => {
    setGitPanelOpenFor(id)
    setSettingsOpenFor(null)
  }, [])

  const settingsTabNonceRef = useRef(0)
  const openSettingsTab = useCallback((id: string, tab: SettingsTabName) => {
    setSettingsOpenFor(id)
    setGitPanelOpenFor(null)
    settingsTabNonceRef.current += 1
    setSettingsTabRequest({ sessionId: id, tab, nonce: settingsTabNonceRef.current })
  }, [])

  const showHelpWithCommands = useCallback((commands: SlashCommand[]) => {
    setHelpCommands(commands)
    setHelpOpen(true)
  }, [])

  const toggleShortcutHelp = useCallback((currentlyOpen: boolean) => {
    if (!currentlyOpen) setHelpCommands([])
    setHelpOpen((value) => !value)
  }, [])

  return {
    settingsOpenFor,
    setSettingsOpenFor,
    settingsTabRequest,
    gitPanelOpenFor,
    setGitPanelOpenFor,
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
