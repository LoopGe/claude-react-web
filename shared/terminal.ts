// Embedded-terminal types and policy constants shared by the server terminal
// service and the browser terminal overlay.
//
// The shapes ride the per-session `terminal` WS channel (frame definitions in
// shared/ws-protocol.ts); the constants bound the PTY input/resize, the
// headless screen's scrollback, and the screen-persistence debounce. Both
// sides import them so the limits cannot drift apart.

/** Lifecycle of a session's single terminal slot: `idle` (no live shell —
 *  never created or explicitly closed), `running` (live PTY), `exited`
 *  (the shell ended on its own; `exitCode` is set). */
export type TerminalStatus = 'idle' | 'running' | 'exited'

/** Terminal meta, pushed on spawn / exit / close transitions. */
export interface TerminalState {
  status: TerminalStatus
  exitCode?: number
  shell: string   // display name: 'cmd.exe' | 'pwsh' | 'bash' | …
  cwd: string
  cols: number
  rows: number
}

/** Full attach/reconnect seed: the serialized headless screen plus the
 *  generation, seq, and state it reflects. Served on subscribe and resync. */
export interface TerminalSnapshot {
  terminalId: string  // uuid per spawn generation; '' when no live generation
  seq: number         // last applied output seq; 0 when none
  screen: string      // serialize-addon output; '' when empty
  state: TerminalState
  restored: boolean   // screen contains pre-restart persisted history
}

/** Headless-terminal scrollback rows (server screen retention). */
export const TERMINAL_SCROLLBACK = 1000

/** Raw UTF-8 bytes accepted in one `terminal-input` frame; oversize rejects
 *  loudly. */
export const TERMINAL_MAX_INPUT_BYTES = 65_536

/** Resize bounds enforced on `terminal-resize`. */
export const TERMINAL_MAX_COLS = 500
export const TERMINAL_MAX_ROWS = 200

/** Trailing debounce before the serialized screen is persisted to disk. */
export const TERMINAL_SCREEN_DEBOUNCE_MS = 2000

/** Divider written into the restored screen when a server restart killed the
 *  previous shell — the honesty boundary between history and new output. */
export const TERMINAL_DIVIDER_TEXT =
  '── server restarted · previous shell ended · output above is history ──'
