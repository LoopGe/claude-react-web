# Embedded Terminal — Phase 1 Design (User Terminal)

Date: 2026-11-21
Status: implemented
Agent Note: [.agents/notes/implemented/feature/2026-11-21-embedded-terminal.md](../../../.agents/notes/implemented/feature/2026-11-21-embedded-terminal.md)

## Intent

Interactive shell work is impossible in the app today. The `!`/`!!` bash mode
(`server/exec.ts`) spawns `shell -c` with `stdio: ['ignore', pipe, pipe]` —
stdin is ignored, there is no TTY. Any command that asks a question hangs or
fails: ssh password / host-key confirmation, sudo, `gh auth login`, npm login,
REPLs, full-screen programs (vim, top). The driving user scenario is
**interactive login flows** in the session's cwd.

DSH (deepseek-harness) ships a full embedded terminal; its contracts were
surveyed (`packages/api/terminal-controller`, `packages/terminal/terminal`,
`packages/client/ui-sidebar-terminal` READMEs) and its node-pty packaging was
re-verified experimentally on this repo's build configuration (see
"Packaging" below). This design ports the user-terminal half of that
experience into our existing per-panel overlay architecture.

## Decided by the user

- **Placement**: a per-session overlay, like GitPanel — one terminal per
  session, opened inside the session's chat panel. Not a global sidebar,
  not a bottom drawer, not a resource-modal tab.
- **Entry points (phase 1)**: `Ctrl+Backquote` toggle + Command Palette
  action + a **composer button to the right of the Tasks button**, visible
  only while a terminal is running, disappearing when the terminal is
  closed. A HEADER chip entry was proposed and deliberately rejected —
  the composer placement is the user's chosen live-indicator entry.
- **Restart semantics**: after a server restart, a tab that remembers the
  terminal AUTO-CREATES a new shell and restores the previous OUTPUT
  history, with an honest divider marking that the old process died.
  Process state (vim/ssh sessions) is explicitly NOT restored — the user
  confirmed this exact semantics.
- **Sleep**: a running terminal BLOCKS session sleep (option A — the
  repo's background-subagent convention). The user must close the
  terminal first; an ssh session is never silently killed by sleep.
- **Priority**: functionality first; entry polish later.

## Goals

1. Full PTY interactivity in the session cwd: stdin duplex, TTY semantics,
   alternate screen, resize, control characters, IME/paste.
2. The process and screen outlive the UI: closing the overlay, switching
   panels, and reloading the page all preserve the running shell; reopening
   reattaches to the current screen (DSH host-retention + snapshot model).
3. Clean lifecycle: explicit close kills the process tree and clears the
   persisted screen; session delete kills it and removes the persistence;
   a running terminal blocks session sleep (409, same convention as
   background subagents). Server restart kills the process but RESTORES
   the output history: a remembered tab auto-creates a fresh shell whose
   output appends after a persisted-screen divider (see "Restart flow").
4. Keyboard region semantics: with the terminal focused, Esc and all
   printable keys go to the PTY — they must not dismiss the overlay, fire
   the global Esc-interrupt, or trigger app shortcuts. `Ctrl+Backquote`
   remains a global escape hatch that toggles the overlay even from inside
   the terminal.
5. Graceful degradation: where node-pty is unavailable (optional dep failed,
   unsupported platform), the feature is hidden/disabled, nothing else
   changes.

## Non-goals (phase 2 or later, explicitly out)

- Agent-opened terminals and the agent→human control handoff (DSH's
  `openForAgent` / "Agent" badge / first-keystroke takeover).
- Multiple terminal tabs per session; shell picker / discovery menu.
- Header entry button / live-running indicator (deferred by user).
- Terminal output entering model context (no `!!`-style sharing from the
  terminal; DSH keeps the same separation).
- Restoring PROCESS state across server restart (vim/ssh sessions die
  with the server; only output history is restored, above a divider).
- Unattended idle reclamation (DSH's 2h timer). Our sessions persist until
  deleted; the terminal lives while its session lives. [builder call]

## Anti-goals (failure even if it "works")

- Regressing `!`/`!!`, the Esc-interrupt decision table, or the overlay
  escape stack for any non-terminal surface.
- Growing the startup client bundle with xterm (must stay a lazy chunk).
- A slow terminal viewer blocking the session pump or other WS channels.
- A terminal process outliving its session (delete/unload must kill the
  tree, reusing the existing win32 job containment).

## Constraints

- esbuild single-file bundle (`build.mjs`): native addons stay external.
  Verified experimentally: bundling node-pty inline crashes at runtime
  (dynamic `.node` require resolves relative to `dist/`); external +
  the existing `createRequire` banner works (681-byte test bundle, ConPTY
  round-trip OK on Win11/Node 24).
- Repo conventions: `createLogger('terminal')` for all diagnostics; metrics
  with finite enum labels only; theme colors via CSS variables in both
  themes; no speculative defensive code — real errors surface loudly.
- Wire protocol additions go through `shared/ws-protocol.ts` generics with
  the thin server/client instantiation aliases, not duplicated mirrors.

## Architecture

### Server: terminal service

New module `server/terminal.ts` (or `server/terminal/` if it grows), owned
by the session holder as a single slot — the same ownership shape as
`execAbort` today. SessionManager exposes create/input/resize/close/attach
operations; routes/WS delegate, capability-gated.

- **Spawn**: node-pty `spawn(shell, [], { cwd: session.cwd, env, cols, rows,
  name: 'xterm-256color' })`. Shell resolution mirrors `exec.ts`
  (`ComSpec`/`cmd.exe` on win32, `SHELL`/`/bin/sh` otherwise). Env posture
  matches `exec.ts` (the user's own server environment; this is the same
  trust boundary as `!` mode — the user types into it directly).
  Interactive POSIX shells start interactive; PowerShell gets `-NoLogo`
  (DSH parity). [builder call: exact arg list]
- **State machine**: `idle → running → exited(exitCode)`; explicit close
  returns to `idle`; session unload/delete kills the tree from any state.
  One terminal per session; `create` while running is an attach, not a
  second spawn (idempotent).
- **Screen retention**: a server-side headless xterm
  (`@xterm/headless` + `@xterm/addon-serialize`, pure JS, bundled) consumes
  every output chunk; scrollback 1000 rows (DSH default). Attach/reconnect
  serves the serialized screen plus the current seq — this is why raw
  output-ring replay was rejected (trimming splits escape sequences).
- **Screen persistence** (user-decided restart semantics): the serialized
  screen + terminal meta (status, exitCode, shell, cwd) is written to
  `<stateDir>/terminal-screens/<sessionId>.json`, debounced ~2s after the
  last output chunk, plus a best-effort flush on graceful shutdown.
  Bounded by the scrollback cap. Explicit close and session delete remove
  the file. Crash window: the last ≤2s of output may be lost — stated,
  accepted. [builder call: exact debounce/flush mechanics]
- **Sleep guard** (user decision, option A): a RUNNING terminal joins the
  session idle guard (`phaseOf`) — `sleep()` is rejected (409) while the
  terminal runs, exactly like a live background subagent. An exited
  terminal does not block sleep.
- **Restart flow**: on boot the persisted screen is loaded into the
  headless terminal. When a remembered tab attaches and no live process
  exists: if the persisted status was `running`, the server writes an
  ANSI-styled divider line into the restored screen ("server restarted —
  previous shell ended — output above is history"), auto-spawns a fresh
  shell (user decision: auto, not DSH's manual button), and new output
  appends after the divider; if the persisted status was `exited`, the
  history + exit banner restore with NO auto-spawn. [builder call: exited
  case] The divider lives IN the screen content, so it survives
  re-serialization and needs no extra protocol field.
- **Output fan-out**: `pty.onData` → headless write + broadcast to the
  session's terminal-channel subscribers with a monotonic per-generation
  seq. Ephemeral: never enters the history ring or the message channel.
  Per-subscriber WS queues already isolate slow clients; a viewer that
  detects a seq gap requests a fresh snapshot (resync), it never blocks
  the producer.
- **Kill**: reuse `killTreeWin32` with the spawn-time birth-time fence
  (win32) and process-group kill (posix) — the infrastructure from
  [win32-job-containment](../../../.agents/notes/implemented/architecture/2026-11-17-win32-job-containment.md)
  and [subprocess-tree-containment](../../../.agents/notes/implemented/architecture/2026-11-09-subprocess-tree-containment.md).
- **Capability**: boot-time probe loads node-pty once; the result rides
  `SessionInfo.terminalSupported` (three-state boolean, same shape as
  `taskControlSupported`). Unsupported → client hides the palette action
  and the shortcut no-ops with a toast.

### Wire protocol (new per-session `terminal` channel)

Ref-counted subscribe through `useWsHub`, `subscribe-result` semantics
identical to existing channels. Frames (canonical definitions in
`shared/ws-protocol.ts`):

Server → client:
- `terminal-snapshot` — `{ terminalId, seq, screen, state }` where state is
  `{ status: 'running'|'exited'|'idle', exitCode?, shell, cwd, cols, rows }`.
  Sent on subscribe and on resync. `terminalId` is a fresh uuid per spawn
  (generation fence: late frames from a dead generation are dropped).
- `terminal-output` — `{ terminalId, seq, data }`, monotonic seq per
  generation.
- `terminal-state` — `{ terminalId, state }` on spawn/exit/close
  transitions.

Client → server:
- `terminal-create` — `{ cols, rows }`; spawns if idle, attaches if
  running.
- `terminal-input` — `{ terminalId, data }`; raw UTF-8 capped at 64 KiB
  per frame (DSH `maxInputBytes` parity); oversize rejects loudly.
- `terminal-resize` — `{ terminalId, cols, rows }`; bounds 500×200
  (DSH `maxCols`/`maxRows` parity).
- `terminal-resync` — `{ terminalId }`; server answers with a fresh
  `terminal-snapshot`.
- `terminal-close` — kill + clear to idle.

Phase-1 simplifications vs DSH, deliberate [builder calls]:
- **No ack/input-window flow control.** DSH's window exists for its
  carrier mux limits; our direct WS + bounded frames + per-subscriber
  queues cover the same failures. Input is small and human-paced.
- **No single-writer arbitration.** DSH gives the latest attachment
  exclusive input. We let any attached tab write (shared-terminal, tmux
  semantics). Two panels showing one session is rare; last-write-wins is
  honest for a shared shell. Revisit if it bites.
- **No REST control surface.** Everything rides the WS channel; capability
  rides SessionInfo. (The `!`/`!!` REST `/exec` path stays as it is.)

### Client

- **`useTerminalChannel`** hook: per-session channel filter over the hub
  (same shape as other per-session hooks), exposes state + snapshot +
  output subscription + send operations. Subscribed at the LEAF (the
  terminal overlay body), never by `useChatStream` — the live-output
  render isolation rule applies: output churn must not re-render Chat.
- **`TerminalOverlay`**: per-panel overlay sibling of GitPanel inside
  Chat. xterm.js + `@xterm/addon-fit` load as a lazy chunk on first mount
  (DSH pattern; keeps startup bundle clean). Theme follows app CSS
  variables (both themes); font: existing monospace stack, terminal font
  size honors the appearance pref if trivially wireable, else fixed
  [builder call].
- **Overlay union membership** [builder call, resolved at review]: the
  terminal joins the `useAppOverlays` discriminated union as `'terminal'`
  — "like GitPanel" means the mutual-exclusion invariant holds: opening
  Git/Settings/etc. replaces the terminal overlay. The terminal-specific
  twist is keep-alive: when a sibling overlay replaces it, the terminal
  body stays MOUNTED (`display:none`) with xterm and the channel alive,
  unlike the other union members which unmount. `Ctrl+Backquote` while a
  sibling overlay is open toggles the terminal IN (replacing the sibling)
  — "blocked under modals" means true dialogs only (ConfirmDialog,
  CommandPalette, pickers), not sibling overlays.
- **Keep-alive**: closing the overlay hides it (`display:none`) without
  unmounting xterm or dropping the channel — same philosophy as the panel
  keep-alive cache. When the PANEL itself is evicted from the cache, the
  component unmounts and detaches; the host process survives, and the next
  mount reattaches via snapshot.
- **Focus**: open → focus xterm; close → return focus to the composer.
- **Keyboard**:
  - `Ctrl+Backquote` registered in `useKeyboardShortcuts` with
    `allowInInput: true`, **Control on ALL platforms** (VS Code / DSH
    parity; Cmd+Backquote is macOS OS-level window cycling). Toggles the
    focused panel's terminal overlay. Palette action comes from the
    registration.
  - Terminal-focused region exclusion: the overlay registers in the
    escape stack as an Esc CONSUMER while focused (so the global
    Esc-interrupt never fires), but unlike GitPanel it does not dismiss on
    Esc — Esc goes to the PTY. Dismiss is X button / backdrop click.
    Other app shortcuts are suppressed while the terminal has focus
    (DSH registers the toggle in `['page','editable','terminal']` regions
    and blocks it under modals — mirror that: toggle works inside the
    terminal, not under a modal).
- **Exited state**: exit-code banner + "Restart" button (new generation);
  never auto-respawn on natural exit (DSH parity).
- **Unavailable state** (node-pty missing only): localized panel, creation
  disabled. Restart loss is NOT an unavailable state anymore — it
  auto-restores (server "Restart flow").
- **Restart reattach** (user-decided): the CLIENT remembers the
  per-session association (DSH-style binding); a remembered tab
  reconnecting after a server restart auto-sends `terminal-create`, and
  the server answers with restored history + divider + a fresh shell. A
  fresh tab with no memory sees the restored history in idle state with
  a "New terminal" affordance — creating runs the same server flow. The
  divider makes the process-death boundary unmistakable.
- **Composer entry button** (user decision): mounted to the RIGHT of the
  Tasks button, same wiring pattern as `onOpenTasks` (an `onOpenTerminal`
  prop, capability-gated). Visible ONLY while the terminal status is
  `running`; disappears when the terminal is closed or exits [builder
  call: running-only visibility — an exited shell needs no attention;
  Ctrl+`/palette still reach its exit banner]. Click opens the overlay
  (focuses it if already open). This is the live-process indicator +
  entry, replacing the rejected header chip.

### Packaging (experimentally verified)

- `node-pty@1.2.0-beta.15` (the exact pin DSH uses) in
  `optionalDependencies`, koffi-style. Tarball ships prebuilds for all 6
  platforms (N-API); installs in ~7s with zero compilation, and works
  under `--ignore-scripts` (verified). Tarball cost: 7.15 MB.
- `build.mjs`: add `'node-pty'` to BOTH `external` arrays.
- **Windows ConPTY drain patch**: DSH's
  `patches/node-pty@1.2.0-beta.15.patch` fixes a real Windows bug — when
  the process exits with no further output, the conout socket worker is
  never disposed. Adopt the same one-line fix via `patch-package`
  (postinstall). The unix spawn-helper half of DSH's patch is for their
  pkg single-executable distribution and is NOT needed for our npm/npx
  shape. Check whether a newer beta already carries the fix before
  patching. [builder call]
- Server screen deps `@xterm/headless` + `@xterm/addon-serialize`: regular
  deps, bundled (pure JS).
- Client `xterm` + `@xterm/addon-fit`: regular deps, lazy chunk.
- Desktop: electron-builder `asarUnpack` for node-pty (its loader already
  handles `app.asar.unpacked` path replacement). Electron 33 load is
  untested — verify during implementation.

### Logging & metrics

`createLogger('terminal')`; session-id context in message bodies. Metrics:
`terminal_spawn_total` counter, `terminal_active` gauge,
`terminal_output_bytes` counter — finite labels only, recorded on the
existing GC tick where gauges belong.

## Testing

- Server unit tests: state machine transitions, idempotent create/attach,
  seq monotonicity + generation fencing, snapshot serialize correctness,
  bounded input rejection, kill-on-delete/unload (win32 fence included),
  resync-after-gap.
- Protocol tests through the existing WS test harness patterns.
- Client: jsdom tests for overlay logic with xterm mocked (focus, escape
  consumption, keep-alive detach/reattach, exited/unavailable states);
  real-xterm round-trip in the Playwright browser suite (`tests/browser`):
  spawn → type → output → resize → reload-reattach.
- Manual acceptance: an ssh-style interactive login (password prompt),
  sudo prompt, vim (alternate screen + Esc reaches vim, not the app),
  page reload mid-session, Ctrl+` toggle from inside the terminal,
  session delete kills the tree, server restart → remembered tab
  auto-creates a new shell with restored history + divider, sleep
  rejected (409) while the terminal runs, composer button appears on
  spawn and disappears on close/exit.

## Alternatives that lost

- **Extend `!` exec with stdin support.** No TTY means no alternate
  screen, no resize, no line discipline — a half-measure that still
  can't do vim or ssh host-key prompts cleanly.
- **Raw output ring + replay on attach.** Scrollback trimming splits
  escape sequences; replay reconstructs a corrupted screen. DSH chose
  headless xterm serialization for exactly this reason.
- **Right sidebar / bottom drawer / resource-modal tab.** User chose the
  GitPanel-style per-panel overlay; it reuses the existing overlay,
  keep-alive, and escape-stack machinery.
- **Header chip entry with live dot.** Proposed, deferred by the user.
- **Bundling node-pty inline.** Verified broken at runtime; external is
  mandatory, same as the SDK and koffi.
- **DSH-style ack/window flow control and single-writer arbitration.**
  Deferred as phase-1 simplifications with stated rationale above.
- **Unavailable panel + manual re-create after restart (DSH parity).**
  Initially proposed; the user chose auto-create + output-history
  restore instead. The bounded screen-persistence layer is the cost of
  that decision, and the divider banner is its honesty requirement.
- **Sleep kills the terminal (option B).** Rejected by the user in favor
  of the repo's background-subagent convention: running work blocks
  sleep.

## Risks

- node-pty 1.2.0 is a beta line; DSH pins the same beta plus a patch.
  Upstream fixes may shift the patch; track it.
- Node 20 (minimum engine) and Electron 33 load are untested — N-API is
  designed to be version-stable, but verify both during implementation.
- Platforms without prebuilds (e.g. Alpine musl) fall back to node-gyp;
  optionalDependencies + capability probe degrade gracefully there.
- ConPTY quirks beyond the known drain bug may surface; the manual
  acceptance list is the net.
- xterm under jsdom is limited; browser-suite coverage is the real
  guarantee for rendering/input fidelity.

## Left to the builder

Exact module file layout, shell arg lists, xterm theme/font wiring
details, frame field naming within the protocol conventions, test file
organization, and the patch-vs-newer-beta decision — all marked
[builder call] above where they touch behavior.