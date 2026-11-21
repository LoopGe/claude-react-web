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

import { Suspense, lazy, useCallback } from 'react'
import { Overlay } from '../Overlay'
import { IconTerminal, IconX } from '../icons/ToolIcons'
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
  // snapshot (restored=false) clears it.
  const restored = snapshot?.restored === true

  const handleEscape = useCallback(() => {
    channel.input('\x1b')
  }, [channel])

  // Spawn at the last known size; the body refits and resizes once revealed.
  // `||`, not `??`: a never-created slot's state reports cols/rows 0 (the
  // server's idle seed — WS-probe-verified), and 0 must fall through to the
  // default, not ride into terminal-create where bounds reject it (E2E catch).
  const handleCreate = useCallback(() => {
    const cols = state?.cols || snapshot?.state.cols || 80
    const rows = state?.rows || snapshot?.state.rows || 24
    channel.create(cols, rows)
  }, [channel, state, snapshot])

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
          <button className="btn btn-icon terminal-panel-close" onClick={onClose} aria-label="Close terminal">
            <IconX size={14} />
          </button>
        </header>

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
