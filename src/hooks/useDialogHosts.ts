// Shared confirm/prompt dialog state hosts — ONE busy-wrapping implementation
// for every surface that renders SessionContextMenu / buildGroupContextMenuItems
// dialogs (the sidebar's SessionList and App's collapsed-sidebar strip menus;
// ChatPanel's panel menus wire their own).
//
// The onConfirm stored in state wraps the caller's: busy flips on for the
// await and the dialog closes in `finally`, so double-clicking the confirm
// button can't double-fire the action (Restart, New-like-this, rename PATCH…).
// Callers render the visual hosts with <DialogHosts hosts={hosts} /> and open
// dialogs with askConfirm / askPrompt — the same `dialogs` contract
// SessionContextMenu and the group-menu builder expect.

import { useCallback, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

export interface ConfirmRequest {
  title: string
  message: ReactNode
  confirmLabel: string
  destructive?: boolean
  /** Owns its own error handling (toast on failure) — an unhandled rejection
   *  here surfaces in the console while the dialog still closes. */
  onConfirm: () => void | Promise<void>
}

export interface PromptRequest {
  title: string
  message: ReactNode
  defaultValue: string
  confirmLabel: string
  placeholder?: string
  /** Owns its own error handling (toast on failure) — see ConfirmRequest. */
  onConfirm: (value: string) => void | Promise<void>
}

export interface DialogHostsApi {
  confirm: ConfirmRequest | null
  confirmBusy: boolean
  prompt: PromptRequest | null
  promptBusy: boolean
  askConfirm: (config: ConfirmRequest) => void
  askPrompt: (config: PromptRequest) => void
  /** Direct dismissal — DialogHosts' onCancel paths (busy-guarded there). */
  setConfirm: (config: ConfirmRequest | null) => void
  setPrompt: (config: PromptRequest | null) => void
}

export function useDialogHosts(): DialogHostsApi {
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const [confirmBusy, setConfirmBusy] = useState(false)
  const [prompt, setPrompt] = useState<PromptRequest | null>(null)
  const [promptBusy, setPromptBusy] = useState(false)

  const askConfirm = useCallback((config: ConfirmRequest) => {
    setConfirm({
      title: config.title,
      message: config.message,
      confirmLabel: config.confirmLabel,
      destructive: config.destructive,
      onConfirm: async () => {
        setConfirmBusy(true)
        try {
          await config.onConfirm()
        } finally {
          setConfirmBusy(false)
          setConfirm(null)
        }
      },
    })
  }, [])

  const askPrompt = useCallback((config: PromptRequest) => {
    setPrompt({
      title: config.title,
      message: config.message,
      defaultValue: config.defaultValue,
      confirmLabel: config.confirmLabel,
      placeholder: config.placeholder,
      onConfirm: async (value) => {
        setPromptBusy(true)
        try {
          await config.onConfirm(value)
        } finally {
          setPromptBusy(false)
          setPrompt(null)
        }
      },
    })
  }, [])

  // Memoized: consumers key callbacks/props off this object (handleStripRename
  // deps, StripGroupMenu's dialogs prop) — every field is stable except the
  // request/busy state itself, so identity should change only then.
  return useMemo(
    () => ({ confirm, confirmBusy, prompt, promptBusy, askConfirm, askPrompt, setConfirm, setPrompt }),
    [confirm, confirmBusy, prompt, promptBusy, askConfirm, askPrompt, setConfirm, setPrompt],
  )
}
