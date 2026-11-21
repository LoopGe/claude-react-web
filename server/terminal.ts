// Embedded-terminal session core: one PTY shell per session slot, a server-side
// headless xterm that retains the serialized screen, and the idle → running →
// exited state machine. Owned by the session holder (SessionManager) as a single
// slot; routes/WS delegate here, capability-gated. Terminal output never enters
// the history ring or the message channel — it rides a dedicated terminal
// channel via the TerminalEvents callbacks.
//
// Screen consistency invariant: every output chunk is parsed into the headless
// terminal SYNCHRONOUSLY before its seq is emitted, so snapshot() (a synchronous
// serialize) always reflects exactly the chunks counted by `seq`. This is what
// makes attach/resync lossless: a viewer seeds from the snapshot screen at seq N
// and applies live frames N+1… with no gap. xterm's write buffer defers an
// empty-buffer write to a macrotask by default; `input('')` marks the next write
// as user-input-priority, which xterm parses synchronously (the documented
// user-input echo path). We never subscribe to the headless onData, so the empty
// input event has no effect beyond setting that priority flag.

import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { createRequire } from 'node:module'
import headlessPkg, { type Terminal as HeadlessTerminal } from '@xterm/headless'
import { createLogger } from './log.js'
import { HttpError } from './errors.js'
import { terminalCapability } from './terminal-capability.js'
import { captureBirthTime, killTreeWin32 } from './win32-job.js'
import type { TerminalScreenStore } from './terminal-store.js'
import {
  TERMINAL_DIVIDER_TEXT,
  TERMINAL_MAX_COLS,
  TERMINAL_MAX_INPUT_BYTES,
  TERMINAL_MAX_ROWS,
  TERMINAL_SCROLLBACK,
  type TerminalSnapshot,
  type TerminalState,
  type TerminalStatus,
} from '../shared/terminal.js'

const log = createLogger('terminal')

export interface TerminalEvents {
  onOutput: (terminalId: string, seq: number, data: string) => void
  onState: (terminalId: string, state: TerminalState) => void
}

// Minimal structural shape of the node-pty surface used here (the koffi
// precedent in win32-job.ts): node-pty is an optionalDependency, so typecheck
// must not require the native package to be installed. The runtime load is lazy
// (createRequire on first create) and gated by terminalCapability().
interface PtyDisposable {
  dispose(): void
}
interface PtyHandle {
  readonly pid: number
  onData(listener: (data: string) => void): PtyDisposable
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): PtyDisposable
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}
interface PtyModule {
  spawn(
    file: string,
    args: string[],
    opts: { cwd: string; env: Record<string, string | undefined>; cols: number; rows: number; name: string },
  ): PtyHandle
}
let ptyModule: PtyModule | null = null
function loadPty(): PtyModule {
  if (!ptyModule) ptyModule = createRequire(import.meta.url)('node-pty') as PtyModule
  return ptyModule
}

// The serialize addon is loaded via createRequire with a local structural type
// (the koffi/node-pty precedent) rather than a static import: the package's own
// typings import '@xterm/xterm', whose declaration carries `/// <reference
// lib="dom"/>`. A static import would inject lib.dom into the DOM-free server
// program (tsconfig.node) and shift the Uint8Array/ReadableStream/BodyInit
// globals, breaking unrelated files. The local type keeps the server program
// DOM-free; the addon is a regular dependency, so the runtime require resolves
// on every host. Only `serialize()` is used beyond the ITerminalAddon lifecycle.
interface SerializeAddonLike {
  serialize(): string
  activate(terminal: HeadlessTerminal): void
  dispose(): void
}
interface SerializeModule {
  SerializeAddon: new () => SerializeAddonLike
}
let serializeModule: SerializeModule | null = null
function loadSerialize(): SerializeModule {
  if (!serializeModule) {
    serializeModule = createRequire(import.meta.url)('@xterm/addon-serialize') as SerializeModule
  }
  return serializeModule
}

/** Resolve the interactive shell binary + args + display name. Mirrors
 *  exec.ts's resolveShell (ComSpec/cmd.exe on win32, SHELL//bin/sh on posix);
 *  posix shells start interactive (-i), PowerShell gets -NoLogo (DSH parity),
 *  cmd takes no args. */
function resolveShell(): { binary: string; args: string[]; name: string } {
  const binary =
    process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : (process.env.SHELL ?? '/bin/sh')
  const name = basename(binary)
  const args = /pwsh|powershell/i.test(name) ? ['-NoLogo'] : process.platform === 'win32' ? [] : ['-i']
  return { binary, args, name }
}

function validateBounds(cols: number, rows: number): void {
  if (
    !Number.isInteger(cols) ||
    cols < 1 ||
    cols > TERMINAL_MAX_COLS ||
    !Number.isInteger(rows) ||
    rows < 1 ||
    rows > TERMINAL_MAX_ROWS
  ) {
    throw new HttpError(
      400,
      `terminal dimensions out of bounds (1..${TERMINAL_MAX_COLS} x 1..${TERMINAL_MAX_ROWS})`,
    )
  }
}

export interface TerminalSessionOptions {
  sessionId: string
  cwd: string
  store: TerminalScreenStore
  events: TerminalEvents
}

export class TerminalSession {
  private readonly sessionId: string
  private readonly cwd: string
  private readonly store: TerminalScreenStore
  private readonly events: TerminalEvents
  private readonly shell: { binary: string; args: string[]; name: string }

  private status: TerminalStatus = 'idle'
  private terminalId = ''
  private seq = 0
  private exitCode: number | undefined
  private cols = 0
  private rows = 0
  private pty: PtyHandle | null = null
  private birthTime: string | null = null
  private headless: HeadlessTerminal | null = null
  private serializer: SerializeAddonLike | null = null
  /** The current screen contains pre-restart persisted history. True from a
   *  restoring constructor until the history is discarded (a non-restoring
   *  create, close, or dispose). */
  private restored = false

  constructor(opts: TerminalSessionOptions) {
    this.sessionId = opts.sessionId
    this.cwd = opts.cwd
    this.store = opts.store
    this.events = opts.events
    this.shell = resolveShell()
    // Restart restore: a persisted screen means a previous server lifetime's
    // shell died with the server. Seed it into a headless so snapshot() serves
    // the history before any create; nothing auto-spawns here — the remembered
    // tab's create() drives the fresh shell. Persisted 'exited' keeps its exit
    // code (the exit banner is part of the screen); 'running' becomes idle
    // because the process is gone. SerializeAddon output re-parses byte-
    // identically at the same dimensions, so the seeded snapshot's screen
    // equals the persisted string.
    const persisted = this.store.load(this.sessionId)
    if (persisted) {
      const { cols, rows } = persisted.state
      const term = new headlessPkg.Terminal({
        cols,
        rows,
        scrollback: TERMINAL_SCROLLBACK,
        allowProposedApi: true,
      })
      const ser = new (loadSerialize().SerializeAddon)()
      term.loadAddon(ser)
      // Synchronous parse (the module-header trick) so the very first
      // snapshot already reflects the full persisted screen.
      term.input('')
      term.write(persisted.screen)
      this.headless = term
      this.serializer = ser
      this.cols = cols
      this.rows = rows
      this.status = persisted.state.status === 'exited' ? 'exited' : 'idle'
      this.exitCode = persisted.state.exitCode
      this.restored = true
    }
  }

  /** The sleep-guard signal: a live shell blocks session sleep. */
  get running(): boolean {
    return this.status === 'running'
  }

  /** Spawn a shell (idle/exited) or attach to the live one (running). Attach is
   *  idempotent: it returns the current snapshot without a second spawn or a
   *  resize — the caller resizes explicitly. */
  create(cols: number, rows: number): TerminalSnapshot {
    if (this.status === 'running') return this.snapshot()
    validateBounds(cols, rows)
    const cap = terminalCapability()
    if (!cap.supported) {
      throw new HttpError(400, `terminal not supported: ${cap.reason ?? 'node-pty unavailable'}`)
    }

    // Restore handoff: the constructor-seeded pre-restart history is carried
    // into the first new generation exactly once, with the divider as that
    // generation's first output chunk. terminalId === '' distinguishes the
    // pending restore from a later manual restart (exited → create starts
    // fresh, like any non-restored session — one divider per server restart).
    const restoring = this.restored && this.terminalId === ''
    const carry = restoring ? this.serializer!.serialize() : ''

    const id = randomUUID()
    const term = new headlessPkg.Terminal({
      cols,
      rows,
      scrollback: TERMINAL_SCROLLBACK,
      allowProposedApi: true,
    })
    const SerializeAddon = loadSerialize().SerializeAddon
    const ser = new SerializeAddon()
    term.loadAddon(ser)
    const pty = loadPty().spawn(this.shell.binary, this.shell.args, {
      cwd: this.cwd,
      env: { ...process.env, TERM: 'xterm-256color' },
      cols,
      rows,
      name: 'xterm-256color',
    })

    // Spawn succeeded: release the previous screen (the restored seed or an
    // exited generation's) before replacing it. A failed spawn above leaves
    // the old headless and restored state untouched.
    this.headless?.dispose()
    this.pty = pty
    this.headless = term
    this.serializer = ser
    this.terminalId = id
    this.seq = 0
    this.exitCode = undefined
    this.cols = cols
    this.rows = rows
    this.status = 'running'
    this.birthTime = null
    this.restored = restoring

    if (restoring) {
      // The history is the attach seed (not a counted chunk); the divider IS
      // the new generation's first output chunk, so live viewers see the
      // boundary too. One synchronous parse keeps screen == seq (the module
      // header invariant): the snapshot at seq 1 already contains both.
      const divider = `\r\n\x1b[2m${TERMINAL_DIVIDER_TEXT}\x1b[0m\r\n`
      // win32 ConPTY emits a startup screen-clear (CSI 2J + CSI H, probe-
      // verified) that erases the viewport WITHOUT saving to scrollback — it
      // would wipe the restored history + divider ~100ms after spawn. Scroll
      // them into scrollback first so the clear only hits an empty viewport.
      // Newline-driven scroll saves to scrollback (CSI S discards — probe-
      // verified); `rows` newlines push the whole viewport out regardless of
      // cursor position, then home. The scroll rides IN the fanned-out chunk
      // so a live viewer's xterm scrolls identically (screen == seq parity).
      // posix shells do not clear on startup, so the divider stays visible in
      // the viewport there — the design's unmistakable boundary.
      const chunk = process.platform === 'win32' ? `${divider}${'\r\n'.repeat(rows)}\x1b[H` : divider
      term.input('')
      term.write(carry + chunk)
      const s = ++this.seq
      this.store.schedule(this.sessionId, {
        screen: ser.serialize(),
        state: this.state(),
        savedAt: Date.now(),
      })
      this.events.onOutput(id, s, chunk)
    }

    pty.onData((data) => {
      // Late frames from a dead generation (close/dispose/respawn) are dropped.
      if (this.terminalId !== id) return
      // Birth identity for the win32 PID-reuse fence (posix group kill needs
      // none). node-pty's Windows pid is 0 until the pseudoconsole is ready, so
      // capture on the first output chunk — the earliest point the real pid is
      // readable. Before that, killTreeWin32 refuses an unverified kill (safe).
      if (this.birthTime === null && process.platform === 'win32' && pty.pid > 0) {
        this.birthTime = captureBirthTime(pty.pid)
      }
      // Synchronous parse keeps screen == seq (see the module header).
      term.input('')
      term.write(data)
      const s = ++this.seq
      this.store.schedule(this.sessionId, {
        screen: ser.serialize(),
        state: this.state(),
        savedAt: Date.now(),
      })
      this.events.onOutput(id, s, data)
    })
    pty.onExit(({ exitCode }) => {
      if (this.terminalId !== id || this.status !== 'running') return
      this.status = 'exited'
      this.exitCode = exitCode
      // Persist the final screen + exited meta synchronously (the debounce
      // window must not swallow the exit state on a graceful shutdown). This
      // callback runs inside node-pty's exit emitter — a caller-less context
      // like the store's debounce timer — so a write failure (ENOSPC, Windows
      // EPERM on a locked tmp) is caught and logged here, never thrown into the
      // emitter where it would crash the server. The route-driven flush() still
      // propagates to its caller, which can surface a 500.
      try {
        this.store.schedule(this.sessionId, {
          screen: ser.serialize(),
          state: this.state(),
          savedAt: Date.now(),
        })
        this.store.flush(this.sessionId)
      } catch (err) {
        log.error(`[${this.sessionId}] exit screen persistence failed: ${(err as Error).message}`)
      }
      // Clients learn the shell exited regardless of persistence success.
      this.events.onState(id, this.state())
      log.info(`[${this.sessionId}] shell exited (code ${exitCode})`)
    })

    // The win32 pid is not readable until the pseudoconsole is ready, so it is
    // omitted here (captured silently on first output for the kill fence).
    log.info(`[${this.sessionId}] spawned ${this.shell.name} (${cols}x${rows})`)
    this.events.onState(id, this.state())
    return this.snapshot()
  }

  /** Write raw input to the live shell. Stale/dead generation → 409 (checked
   *  first); oversize UTF-8 payload → 400. */
  input(terminalId: string, data: string): void {
    const pty = this.livePty(terminalId)
    if (Buffer.byteLength(data, 'utf8') > TERMINAL_MAX_INPUT_BYTES) {
      throw new HttpError(400, `terminal input exceeds ${TERMINAL_MAX_INPUT_BYTES} bytes`)
    }
    pty.write(data)
  }

  /** Resize the live shell and its headless screen. Same fences as input;
   *  dimensions bounded to 1..500 x 1..200. */
  resize(terminalId: string, cols: number, rows: number): void {
    const pty = this.livePty(terminalId)
    validateBounds(cols, rows)
    pty.resize(cols, rows)
    this.headless!.resize(cols, rows)
    this.cols = cols
    this.rows = rows
  }

  /** Explicit close: kill the tree, remove persistence, return to idle. A
   *  restored-but-never-created slot is idle yet holds a seeded headless, so
   *  the no-op guard requires BOTH idle and no screen — closing it clears the
   *  restored history like any other close. */
  close(): void {
    if (this.status === 'idle' && this.headless === null) return
    this.killAndClear()
    this.status = 'idle'
    this.exitCode = undefined
    this.store.remove(this.sessionId)
    this.events.onState('', this.state())
  }

  /** Unload/shutdown path: kill the tree but KEEP persistence (a later restart
   *  restores the screen). No state event — the holder is discarding this slot.
   *  flush() writes any pending screen afterwards. Same restored-seed guard as
   *  close(): a never-created restored slot still releases its headless. */
  dispose(): void {
    if (this.status === 'idle' && this.headless === null) return
    this.killAndClear()
    this.status = 'idle'
    this.exitCode = undefined
  }

  /** Flush pending persistence. Delegates unconditionally: the store no-ops
   *  when nothing is pending, which is exactly the running/exited-with-history
   *  condition (close cancels the pending write via remove; a never-created or
   *  already-flushed slot has nothing pending). */
  flush(): void {
    this.store.flush(this.sessionId)
  }

  snapshot(): TerminalSnapshot {
    return {
      terminalId: this.terminalId,
      seq: this.seq,
      screen: this.serializer ? this.serializer.serialize() : '',
      state: this.state(),
      restored: this.restored,
    }
  }

  /** The live pty for a generation, or a 409 fence. A generation is live only
   *  while running and matching the current terminalId — exited and idle slots
   *  both reject (their terminalId is dead or ''). */
  private livePty(terminalId: string): PtyHandle {
    if (this.status !== 'running' || terminalId !== this.terminalId || this.pty === null) {
      throw new HttpError(409, 'terminal generation is not live')
    }
    return this.pty
  }

  private state(): TerminalState {
    return {
      status: this.status,
      ...(this.exitCode !== undefined ? { exitCode: this.exitCode } : {}),
      shell: this.shell.name,
      cwd: this.cwd,
      cols: this.cols,
      rows: this.rows,
    }
  }

  /** Kill the live tree (if running) and clear the generation. The dead-
   *  generation fence is set FIRST so late onData/onExit from the killed shell
   *  cannot transition state or resurrect persistence. */
  private killAndClear(): void {
    const pty = this.pty
    const running = this.status === 'running'
    const birth = this.birthTime
    this.terminalId = ''
    this.seq = 0
    this.pty = null
    this.birthTime = null
    this.headless?.dispose()
    this.headless = null
    this.serializer = null
    this.restored = false
    if (!running || !pty) return
    if (process.platform === 'win32') {
      // Guarded tree kill first (while the pid is still identity-verifiable),
      // then release the ConPTY handles. taskkill /T reaps descendants the
      // pseudoconsole close alone would leave behind. A pid of 0 means the
      // pseudoconsole never became ready (close raced the first output): there
      // is no tree to enumerate yet, and pty.kill() terminates the shell once
      // ready — so skip the tree kill rather than refuse on an unreadable pid.
      if (pty.pid > 0) killTreeWin32(pty.pid, birth)
      pty.kill()
    } else {
      // node-pty's forkpty/posix_spawn child is a session leader (pid == pgid),
      // so the negative-pgid group kill reaches the whole foreground tree — the
      // subprocess-tree-containment approach. The pid>0 guard keeps -0 (which
      // would signal the server's own group) out of the syscall. ESRCH means
      // the group already exited (natural exit racing close); the master fd
      // self-closes via EIO.
      if (pty.pid > 0) {
        try {
          process.kill(-pty.pid, 'SIGKILL')
        } catch {
          /* group already gone */
        }
      }
    }
  }
}
