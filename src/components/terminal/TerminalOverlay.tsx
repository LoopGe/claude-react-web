// Terminal overlay chrome + state banners. The xterm renderer lives in the
// lazy TerminalBody chunk (imported below) so startup never loads xterm.
//
// Keep-alive: Chat mounts this component ONCE per panel after the first open
// and keeps it mounted; `open` only toggles the Overlay chrome. With
// `keepMounted`, the backdrop persists hidden (.terminal-overlay.hidden) while
// closed or replaced by a sibling overlay, so the body inside it never
// remounts and the channel subscription stays live. The body unmounts only
// when the panel itself is evicted from App's keep-alive cache.
//
// Escape region: escapeBehavior='custom' routes Esc to the PTY (input '\x1b')
// instead of closing. The floating-surface registry gives a true modal opened
// over the terminal topmost Esc, and ignores Esc during IME composition.

import { Suspense, lazy, useCallback, useEffect, useRef } from 'react'
import { Overlay } from '../Overlay'
import { IconTerminal, IconTrash, IconX } from '../icons/ToolIcons'
import type { TerminalChannel } from '../../hooks/useTerminalChannel'

const TerminalBody = lazy(() => import('./TerminalBody').then((m) => ({ default: m.TerminalBody })))

export interface TerminalOverlayProps {
  sessionId: string
  open: boolean
  onClose: () => void
  /** From SessionInfo.terminalSupported — false renders the unavailable panel
   *  and never imports/instantiates xterm. */
  supported: boolean
  channel: TerminalChannel
}

export function TerminalOverlay({ sessionId, open, onClose, supported, channel }: TerminalOverlayProps) {
  // channel.state is the current status; channel.snapshot.state lags it (the
  // snapshot is the last SEED — Task 9 carry). Read state for live status.
  const state = channel.state
  const snapshot = channel.snapshot
  const status = state?.status ?? 'idle'
  // Persistent restored-history indicator (Task 6 carry): win32's restart
  // divider lands in scrollback above the fold, so the header badge is what
  // makes the boundary unmistakable. A fresh non-restored generation's
  // snapshot (restored=false) clears it — as does a server-confirmed idle
  // (the channel synthesizes the cleared anchor on close/dispose).
  const restored = snapshot?.restored === true
  // The kill affordance exists whenever close() would do something: a live
  // shell, an exited generation's retained screen, or restored history. A
  // fresh idle slot (nothing to kill, no screen) hides it.
  const killable = status === 'running' || status === 'exited' || restored

  const handleEscape = useCallback(() => {
    channel.input('\x1b')
  }, [channel])

  // Explicit kill (spec goal 3): close() kills the process tree and clears
  // the screen server-side; the X beside it only hides the keep-alive overlay.
  const handleKill = useCallback(() => {
    channel.close()
  }, [channel])

  // Spawn at the last known size; the body refits to the viewport when the
  // running generation anchors (TerminalBody's anchor listener), syncing the
  // PTY to xterm. `||`, not `??`: a never-created slot's state reports cols/rows
  // 0 (the server's idle seed — WS-probe-verified), and 0 must fall through to
  // the default, not ride into terminal-create where bounds reject it (E2E catch).
  const handleCreate = useCallback(() => {
    const cols = state?.cols || snapshot?.state.cols || 80
    const rows = state?.rows || snapshot?.state.rows || 24
    channel.create(cols, rows)
  }, [channel, state, snapshot])

  // Auto-spawn on open (approved entry design: "no process → spawn directly",
  // no guide page). A fresh idle slot with no restored history spawns once per
  // open episode — including a reopen after an explicit kill. Exited (Restart)
  // and restored-history fresh tabs stay manual. The latch marks an episode
  // "has a terminal" as soon as a non-idle state or restored history is seen,
  // so a kill WHILE open does not immediately respawn. The latch re-arms on any
  // hidden→shown transition of the overlay — explicit close→reopen OR a sibling
  // overlay (git/settings/…) replacing it and then being closed (the union sets
  // open=false while a sibling is up). Returning to an idle terminal view thus
  // spawns, consistent with "open = want a terminal". The `snapshot` guard orders
  // this AFTER the subscribe seed: the overlay is a child component whose passive
  // effect runs before Chat's subscribe effect, and the snapshot only exists once
  // the seed arrives — so terminal-create can never race ahead of terminal-subscribe.
  const spawnedRef = useRef(false)
  useEffect(() => {
    if (!open) {
      spawnedRef.current = false
      return
    }
    if (status !== 'idle' || restored) {
      spawnedRef.current = true
      return
    }
    if (supported && snapshot && !spawnedRef.current) {
      spawnedRef.current = true
      handleCreate()
    }
  }, [open, supported, status, restored, snapshot, handleCreate])

  return (
    <Overlay
      variant="terminal"
      ariaLabel="Terminal"
      open={open}
      onClose={onClose}
      renderCard={false}
      trapRefTarget="backdrop"
      focusEscapeSelector=".chat-panel"
      escapeBehavior="custom"
      onEscape={handleEscape}
      escapeRequiresFocus
      keepMounted
    >
      <aside className="terminal-panel" data-session-id={sessionId}>
        <header className="terminal-panel-header">
          <span className="terminal-panel-title">
            <IconTerminal size={14} />
            {state?.shell ?? 'terminal'}
          </span>
          <span className="terminal-panel-cwd" title={state?.cwd ?? undefined}>
            {state?.cwd ?? ''}
          </span>
          <span className="terminal-panel-status" data-status={status}>
            {status}
          </span>
          {restored && (
            <span
              className="terminal-restored-badge"
              title="Output above the restart divider is history from before the server restarted."
            >
              Restored history
            </span>
          )}
          {killable && (
            <button
              className="btn btn-icon terminal-panel-kill"
              onClick={handleKill}
              aria-label="Kill terminal"
              title="Kill the shell and clear its screen"
            >
              <IconTrash size={14} />
            </button>
          )}
          <button className="btn btn-icon terminal-panel-close" onClick={onClose} aria-label="Close terminal">
            <IconX size={14} />
          </button>
        </header>

        {channel.error && (
          <div className="terminal-error-notice" role="status">
            {channel.error}
          </div>
        )}

        {!supported ? (
          <div className="terminal-unavailable">
            <p>Terminal is unavailable on this host.</p>
          </div>
        ) : (
          <>
            {status === 'exited' && (
              <div className="terminal-banner">
                <span className="terminal-banner-message">
                  Process exited{state?.exitCode != null ? ` (code ${state.exitCode})` : ''}.
                </span>
                <button className="btn" onClick={handleCreate}>
                  Restart
                </button>
              </div>
            )}
            {status === 'idle' && (
              <div className="terminal-banner">
                <span className="terminal-banner-message">
                  {restored ? 'Previous session history restored.' : 'No terminal running.'}
                </span>
                <button className="btn" onClick={handleCreate}>
                  New terminal
                </button>
              </div>
            )}
            <Suspense fallback={null}>
              <TerminalBody channel={channel} visible={open} />
            </Suspense>
          </>
        )}
      </aside>
    </Overlay>
  )
}
