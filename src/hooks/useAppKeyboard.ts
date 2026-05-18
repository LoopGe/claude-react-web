// Global keyboard shortcuts for the app.
//
// Encapsulates the shortcut definitions (Mod+1/2/3, Alt+W, Alt+N, etc.)
// and the interrupt/recap callback registration system.

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useKeyboardShortcuts } from './useKeyboardShortcuts'
import { api } from './useApi'
import type { PermissionMode, SessionInfo } from '../types'
import { PERMISSION_MODES } from '../types'

export interface UseAppKeyboardOpts {
  openIds: string[]
  focusedId: string | null
  setFocusedId: (v: string | null) => void
  sessions: SessionInfo[]
  closeSession: (id: string) => void
  setNewSessionDialogOpen: (v: boolean) => void
  setPaletteOpen: (v: boolean | ((prev: boolean) => boolean)) => void
  setHelpOpen: (v: boolean | ((prev: boolean) => boolean)) => void
  setSettingsOpenFor: (v: string | null) => void
  setGlobalSettingsOpen: (v: boolean) => void
  settingsOpenFor: string | null
  paletteOpen: boolean
  helpOpen: boolean
  newSessionDialogOpen: boolean
  globalSettingsOpen: boolean
}

export interface UseAppKeyboardResult {
  interruptFnsRef: React.MutableRefObject<Map<string, () => void>>
  recapFnsRef: React.MutableRefObject<Map<string, () => void>>
  registerInterrupt: (sessionId: string, fn: () => void) => void
  registerRecap: (sessionId: string, fn: () => void) => void
}

export function useAppKeyboard(opts: UseAppKeyboardOpts): UseAppKeyboardResult {
  const {
    openIds, focusedId, setFocusedId, closeSession,
    setNewSessionDialogOpen, setPaletteOpen, setHelpOpen,
    setSettingsOpenFor, setGlobalSettingsOpen, settingsOpenFor,
    paletteOpen, helpOpen, newSessionDialogOpen, globalSettingsOpen,
  } = opts

  // Track the latest sessions array via ref so the keyboard handlers
  // (which only run on user input, after commit) read fresh data without
  // forcing useMemo to rebuild the shortcut list on every sessions change.
  const sessionsRef = useRef(opts.sessions)
  useEffect(() => {
    sessionsRef.current = opts.sessions
  })

  const interruptFnsRef = useRef<Map<string, () => void>>(new Map())
  const recapFnsRef = useRef<Map<string, () => void>>(new Map())

  const registerInterrupt = useCallback((sessionId: string, fn: () => void) => {
    interruptFnsRef.current.set(sessionId, fn)
  }, [])

  const registerRecap = useCallback((sessionId: string, fn: () => void) => {
    recapFnsRef.current.set(sessionId, fn)
  }, [])

  const shortcuts = useMemo(
    () => [
      {
        combo: 'mod+1',
        handler: () => { if (openIds[0]) setFocusedId(openIds[0]) },
        description: 'Focus slot 1',
      },
      {
        combo: 'mod+2',
        handler: () => { if (openIds[1]) setFocusedId(openIds[1]) },
        description: 'Focus slot 2',
      },
      {
        combo: 'mod+3',
        handler: () => { if (openIds[2]) setFocusedId(openIds[2]) },
        description: 'Focus slot 3',
      },
      {
        combo: 'alt+w',
        handler: () => { if (focusedId) closeSession(focusedId) },
        description: 'Close focused panel',
      },
      {
        combo: 'alt+n',
        handler: () => setNewSessionDialogOpen(true),
        description: 'New session',
      },
      {
        combo: 'mod+k',
        handler: () => setPaletteOpen((v) => !v),
        description: 'Command palette',
      },
      {
        combo: 'shift+?',
        handler: () => setHelpOpen((v) => !v),
        allowInInput: true,
        description: 'Keyboard shortcuts',
      },
      {
        combo: 'shift+tab',
        handler: () => {
          if (!focusedId) return
          const s = sessionsRef.current.find((x) => x.id === focusedId)
          if (!s) return
          const cur = (s.permissionMode ?? 'default') as PermissionMode
          const idx = PERMISSION_MODES.indexOf(cur)
          const next = PERMISSION_MODES[(idx + 1) % PERMISSION_MODES.length]
          void api.post(`/sessions/${focusedId}/permission-mode`, { mode: next })
        },
        description: 'Cycle permission mode',
      },
      {
        combo: 'alt+r',
        handler: () => { if (focusedId) recapFnsRef.current.get(focusedId)?.() },
        allowInInput: true,
        description: 'Refresh session recap',
      },
      {
        combo: 'escape',
        handler: () => {
          if (paletteOpen) setPaletteOpen(false)
          else if (helpOpen) setHelpOpen(false)
          else if (newSessionDialogOpen) setNewSessionDialogOpen(false)
          else if (globalSettingsOpen) setGlobalSettingsOpen(false)
          else if (settingsOpenFor) setSettingsOpenFor(null)
          else if (focusedId) {
            const focused = sessionsRef.current.find((s) => s.id === focusedId)
            if (focused?.working) {
              const fn = interruptFnsRef.current.get(focusedId)
              if (fn) { void fn() }
              else { void api.post(`/sessions/${focusedId}/interrupt`) }
            }
          }
        },
        allowInInput: true,
        description: 'Close overlay / Interrupt',
      },
    ],
    [openIds, focusedId, paletteOpen, helpOpen, newSessionDialogOpen, globalSettingsOpen, settingsOpenFor, closeSession, setFocusedId, setNewSessionDialogOpen, setPaletteOpen, setHelpOpen, setSettingsOpenFor, setGlobalSettingsOpen],
  )

  useKeyboardShortcuts(shortcuts)

  return { interruptFnsRef, recapFnsRef, registerInterrupt, registerRecap }
}
