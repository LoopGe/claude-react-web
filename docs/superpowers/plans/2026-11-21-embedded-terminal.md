# Embedded Terminal (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-session interactive PTY terminal overlay (GitPanel-style) with host-retained processes, reload/restart screen restore, and Ctrl+` / palette / composer-button entries.

**Architecture:** node-pty (external native dep, koffi pattern) spawns one shell per session into a server-side `TerminalSession` that also feeds a headless xterm for serialized screen snapshots. Frames ride a dedicated per-connection terminal channel (subagent-transcript-subscribe pattern) through `frame-bridge.ts`. The client keeps xterm in a lazy chunk inside a keep-alive overlay body that never remounts on open/close.

**Tech Stack:** node-pty@1.2.0-beta.15 (N-API prebuilds), @xterm/headless + @xterm/addon-serialize (server, bundled), @xterm/xterm + @xterm/addon-fit (client, lazy), patch-package (Windows ConPTY drain fix, production dep + shipped patches/), vitest + Playwright.

**Spec:** `docs/superpowers/specs/2026-11-21-embedded-terminal-design.md` (read it fully before starting; the agent note `.agents/notes/proposed/feature/2026-11-21-embedded-terminal.md` carries the decision rationale).

## Global Constraints

- node-pty pinned `1.2.0-beta.15` in `optionalDependencies`; `'node-pty'` added to BOTH `external` arrays in `build.mjs`. Never bundle it inline (verified runtime crash).
- Windows ConPTY drain patch adopted from DSH `patches/node-pty@1.2.0-beta.15.patch` (the `windowsPtyAgent.js` hunk ONLY — the unix spawn-helper hunk is for DSH's pkg distribution, not ours). Check first whether a newer 1.2.0-beta already carries it; if so, pin that and skip patch-package.
- Shortcut is `Ctrl+Backquote` with **Control on ALL platforms** (never Meta/Cmd — macOS OS window cycling). Requires the dispatcher extension in Task 3.
- Exact values: scrollback `1000` rows; input cap `65_536` UTF-8 bytes per frame; max cols `500`, max rows `200`; screen persist debounce `2000` ms; crash window ≤2s accepted.
- Divider copy (in-screen, ANSI-styled): `── server restarted · previous shell ended · output above is history ──`
- All server diagnostics via `createLogger('terminal')`; session-id context in message bodies; never bare `console.*`. Metrics labels: finite enums only, never session ids.
- CSS: theme variables only, defined in BOTH `:root` and `[data-theme="light"]`; no hex literals.
- xterm + FitAddon stay a lazy chunk; startup client bundle must not grow (verify with `npm run analyze:bundle` before/after Task 10).
- Terminal output NEVER enters the history ring, the message channel, or model context.
- No speculative defensive code: real errors throw/reject loudly (repo rule). Guards only for proven states or API contracts.
- Terminal ops work on live AND dormant sessions and NEVER wake the SDK subprocess (DSH parity: viewing an offline session doesn't activate the agent).
- Every commit message ends with: `Co-Authored-By: Claude Code <noreply@anthropic.com>`
- Run `npm run typecheck` (both tsconfigs) after every task; `npm run test` for the touched suites.

## Review Focus

Failure modes the spec implies but no happy-path test exercises — each is pinned to a task below:

1. **Stale-generation race** — input/resize arriving for a terminalId that died (close/respawn) must reject without touching the new shell. → Task 5 test.
2. **Corrupt persisted screen** (crash mid-write leaves truncated JSON) — boot/attach must treat it as absent and log, never crash. → Task 4 test.
3. **Output burst + slow consumer** — a `yes`-style flood must not block the producer or other channels; a lagging viewer recovers via seq-gap resync. → Tasks 5/8 tests.
4. **Permission modal arrives while terminal focused** — the modal wins Esc/keys (floating-surface registry topmost-wins); Ctrl+` is suppressed under true modals. → Tasks 10/11 tests.
5. **IME composition (CJK) in the terminal** — Ctrl+` must not fire mid-composition; composition text must not double-send through the input path. → Tasks 10/11 tests.

---

### Task 1: Dependencies, packaging, capability probe

**Files:**
- Modify: `package.json` (optionalDependencies, dependencies, scripts)
- Create: `patches/node-pty@1.2.0-beta.15.patch` (via patch-package, if still needed)
- Modify: `build.mjs:21` and `build.mjs:50` (external arrays)
- Modify: `desktop/electron-builder.yml:57` (asarUnpack list)
- Create: `server/terminal-capability.ts`
- Test: `server/terminal-capability.test.ts`

**Interfaces:**
- Produces: `terminalCapability(): { supported: boolean; reason?: string }` — cached, lazy `createRequire` load of node-pty; `reason` is a short human-readable failure cause when unsupported. Every later task gates on this.

- [ ] **Step 1: Install deps.** `npm install --save-optional node-pty@1.2.0-beta.15` then `npm install --save @xterm/headless @xterm/addon-serialize @xterm/xterm @xterm/addon-fit` (ruling: `@xterm/xterm`, NOT deprecated `xterm@5.3.0`; align the family to compatible versions and smoke headless+serialize). Verify `node_modules/node-pty/prebuilds/win32-x64/conpty.node` exists (zero compilation expected). Lockfile entries MUST resolve to registry.npmjs.org (no private mirror), and regeneration must not strip `libc`/`optional` fields from pre-existing entries.
- [ ] **Step 2: Windows drain patch.** Check newer 1.2.0-beta changelogs for the conout-dispose fix. If unfixed: apply the one-line fix from DSH's patch to `node_modules/node-pty/lib/windowsPtyAgent.js` (`this._conoutSocketWorker.dispose()` immediately after `this._ptyNative.kill(...)` in the kill path), run `npx patch-package node-pty`, add `patch-package` to **dependencies** (ruling: production dep, so the patch applies on npx-consumer and desktop prod-deps installs too), add `"patches"` to the `files` array, and `"postinstall": "patch-package"` to scripts (keep the existing `prepare` script untouched). Patch filename uses patch-package's `+` separator.
- [ ] **Step 3: build.mjs + electron-builder.** Add `'node-pty'` to both `external` arrays. Add `node_modules/node-pty/**` to `asarUnpack` in `desktop/electron-builder.yml` (follow the koffi entry's comment style).
- [ ] **Step 4: Write the failing capability test.**

```ts
// server/terminal-capability.test.ts
import { describe, expect, it } from 'vitest'
import { terminalCapability } from './terminal-capability.js'

describe('terminalCapability', () => {
  it('reports supported on this dev host with prebuilds installed', () => {
    expect(terminalCapability().supported).toBe(true)
  })
  it('caches the probe result (same object identity)', () => {
    expect(terminalCapability()).toBe(terminalCapability())
  })
})
```

- [ ] **Step 5: Run, verify FAIL** (`npx vitest run server/terminal-capability.test.ts` — module not found).
- [ ] **Step 6: Implement `server/terminal-capability.ts`** — signature above; probe = `require('node-pty')` inside try/catch (this catch is an API-contract guard: optional dep may be absent), cache module-level. Log the failure once via `createLogger('terminal')`.
- [ ] **Step 7: Run, verify PASS.** Then `npm run build:server` — must succeed with node-pty external.
- [ ] **Step 8: Commit.** `feat(terminal): node-pty dependency, packaging, capability probe`

---

### Task 2: Shared terminal types + WS frames

**Files:**
- Create: `shared/terminal.ts`
- Modify: `shared/ws-protocol.ts` (WsClientFrame union ~line 71, WsServerFrame union, new frame interfaces)
- Test: `shared/terminal.test.ts`

**Interfaces:**
- Produces (all later tasks import these exact names):

```ts
// shared/terminal.ts
export type TerminalStatus = 'idle' | 'running' | 'exited'
export interface TerminalState {
  status: TerminalStatus
  exitCode?: number
  shell: string   // display name: 'cmd.exe' | 'pwsh' | 'bash' | …
  cwd: string
  cols: number
  rows: number
}
export interface TerminalSnapshot {
  terminalId: string  // uuid per spawn generation; '' when no live generation
  seq: number         // last applied output seq; 0 when none
  screen: string      // serialize-addon output; '' when empty
  state: TerminalState
  restored: boolean   // screen contains pre-restart persisted history
}
export const TERMINAL_SCROLLBACK = 1000
export const TERMINAL_MAX_INPUT_BYTES = 65_536
export const TERMINAL_MAX_COLS = 500
export const TERMINAL_MAX_ROWS = 200
export const TERMINAL_SCREEN_DEBOUNCE_MS = 2000
export const TERMINAL_DIVIDER_TEXT =
  '── server restarted · previous shell ended · output above is history ──'
```

```ts
// shared/ws-protocol.ts additions (follow existing interface doc-comment style).
// Interface names are exact — later tasks import them:
// client → server: WsTerminalSubscribe, WsTerminalUnsubscribe, WsTerminalCreate,
//   WsTerminalInput, WsTerminalResize, WsTerminalResync, WsTerminalClose
{ kind: 'terminal-subscribe'; sessionId: string }
{ kind: 'terminal-unsubscribe'; sessionId: string }
{ kind: 'terminal-create'; sessionId: string; cols: number; rows: number }
{ kind: 'terminal-input'; sessionId: string; terminalId: string; data: string }
{ kind: 'terminal-resize'; sessionId: string; terminalId: string; cols: number; rows: number }
{ kind: 'terminal-resync'; sessionId: string; terminalId: string }
{ kind: 'terminal-close'; sessionId: string }
// server → client: WsTerminalSnapshot, WsTerminalOutput, WsTerminalState
{ kind: 'terminal-snapshot'; sessionId: string; snapshot: TerminalSnapshot }
{ kind: 'terminal-output'; sessionId: string; terminalId: string; seq: number; data: string }
{ kind: 'terminal-state'; sessionId: string; terminalId: string; state: TerminalState }
```

- [ ] **Step 1: Write the failing test** — `shared/terminal.test.ts`: assert the five constants equal the exact values above; assert `TERMINAL_DIVIDER_TEXT` contains `'output above is history'`.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Create `shared/terminal.ts`** with the exact block above; add the ten frame interfaces to `shared/ws-protocol.ts` and union them into `WsClientFrame` / `WsServerFrame` (mirror `WsSubagentTranscriptSubscribe` at line 57 as the structural template).
- [ ] **Step 4: Run, verify PASS** + `npm run typecheck` (the thin aliases `server/ws-protocol.ts` / `src/ws-types.ts` bind generics — update them if the union binding requires it).
- [ ] **Step 5: Commit.** `feat(terminal): shared types and WS frame vocabulary`

---

### Task 3: Keyboard dispatcher — distinct `ctrl` modifier

**Files:**
- Modify: `src/hooks/useKeyboardShortcuts.ts:84-106` (eventCombo + normalise + matcher)
- Test: `src/hooks/useKeyboardShortcuts.test.ts` (extend existing)

**Interfaces:**
- Produces: combo token `ctrl` matches ONLY `e.ctrlKey` (all platforms); existing `mod` semantics unchanged (matches ctrl OR meta). Task 11 registers `combo: 'ctrl+`'`.

- [ ] **Step 1: Write failing tests** (jsdom): (a) `ctrl+`` fires on `{key:'`', ctrlKey:true}` and does NOT fire on `{key:'`', metaKey:true}`; (b) existing `mod+1` still fires on both ctrl and meta variants (regression); (c) `ctrl+`` does not fire when `isComposing:true` (Review Focus 5).
- [ ] **Step 2: Run, verify FAIL** (normalise currently collapses ctrl→mod).
- [ ] **Step 3: Implement.** `eventCombo`: push `'ctrl'` for ctrlKey, `'meta'` for metaKey (separate tokens, fixed order ctrl/meta/alt/shift). `normalise`: keep `ctrl` and `meta` distinct; `mod` stays its own token. Matcher: a registered `mod` combo matches an event carrying ctrl OR meta; `ctrl` matches ctrl only; `meta` matches meta only. Update the file's header comment.
- [ ] **Step 4: Run, verify PASS** (full dispatcher suite — no regression to existing combos).
- [ ] **Step 5: Commit.** `feat(shortcuts): distinct ctrl modifier for platform-fixed combos`

---

### Task 4: TerminalScreenStore (persistence)

**Files:**
- Create: `server/terminal-store.ts`
- Test: `server/terminal-store.test.ts`

**Interfaces:**
- Consumes: `TerminalState` (Task 2), `TERMINAL_SCREEN_DEBOUNCE_MS`.
- Produces:

```ts
export interface PersistedTerminal { screen: string; state: TerminalState; savedAt: number }
export class TerminalScreenStore {
  constructor(stateDir: string)  // files: <stateDir>/terminal-screens/<sessionId>.json
  schedule(sessionId: string, data: PersistedTerminal): void  // debounce 2000ms, trailing
  flush(sessionId: string): void   // cancel timer + synchronous write
  load(sessionId: string): PersistedTerminal | null
  remove(sessionId: string): void  // file + pending timer
}
```

- [ ] **Step 1: Write failing tests** (vitest fake timers + temp dir): (a) schedule→advance 1999ms→no file; advance 1ms→file with exact JSON; (b) two schedules within the window write ONCE with the last data; (c) flush writes immediately and cancels the timer; (d) load round-trips; absent file → null; (e) **corrupt/truncated JSON → null + one warn log, never throws** (Review Focus 2); (f) remove deletes file and cancels a pending timer.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** — signatures above; write via temp-file + rename (atomic against crash-truncation, the proven failure this guards); `load` catch is the contract guard for corrupt files, logged via `createLogger('terminal')`.
- [ ] **Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit.** `feat(terminal): bounded screen persistence store`

---

### Task 5: TerminalSession core (PTY + headless + state machine)

**Files:**
- Create: `server/terminal.ts`
- Test: `server/terminal.test.ts`

**Interfaces:**
- Consumes: `terminalCapability()` (Task 1), shared types/constants (Task 2), `TerminalScreenStore` (Task 4).
- Produces:

```ts
export interface TerminalEvents {
  onOutput: (terminalId: string, seq: number, data: string) => void
  onState: (terminalId: string, state: TerminalState) => void
}
export class TerminalSession {
  constructor(opts: {
    sessionId: string; cwd: string; store: TerminalScreenStore; events: TerminalEvents
  })
  create(cols: number, rows: number): TerminalSnapshot  // idempotent attach when running
  input(terminalId: string, data: string): void  // throws HttpError(409) on stale generation, 400 on oversize
  resize(terminalId: string, cols: number, rows: number): void  // same fences; bounds 500×200
  close(): void        // kill tree, store.remove, state → idle (terminalId '')
  snapshot(): TerminalSnapshot
  dispose(): void      // kill tree, KEEP persistence (unload/shutdown path)
  flush(): void        // store.flush if running/exited-with-history
  get running(): boolean  // status === 'running' — the sleep-guard signal
}
```

- [ ] **Step 1: Write failing tests** (real node-pty; dev host has prebuilds; use `cmd.exe /c echo …`-style short-lived spawns and a long-lived shell for input tests; win32 + posix branches):
  - create spawns → state running, snapshot.shell/cwd correct; second create returns the SAME terminalId (attach, no second spawn)
  - input round-trip: write `echo crw-pty-marker\r` → onOutput fires with data containing the marker; seq strictly monotonic from 1
  - exit: shell `exit` → onState exited with exitCode; snapshot.screen contains prior output (headless serialize)
  - **stale generation**: capture terminalId, close, create again → `input(oldId, 'x')` throws 409 and the NEW shell receives nothing (Review Focus 1)
  - oversize input (>65_536 bytes) throws 400; resize 501 cols throws 400
  - close kills the process (pid no longer alive) and removes the persisted file
  - **burst**: spawn a command emitting >1MB quickly → every onOutput seq contiguous, no throw, producer settles (Review Focus 3)
  - schedule called on output (fake-timer assertion against the store)
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement.** node-pty spawn: shell resolution mirrors `server/exec.ts:53-58` (ComSpec/cmd.exe win32, SHELL//bin/sh posix); args: posix `['-i']` interactive, pwsh `['-NoLogo']`, cmd `[]`; env `{...process.env, TERM: 'xterm-256color'}`. Headless: `new Terminal({ cols, rows, scrollback: TERMINAL_SCROLLBACK, allowProposedApi: true })` from @xterm/headless + SerializeAddon; every onData chunk → headless.write + store.schedule + events.onOutput with `++seq`. Generation: `crypto.randomUUID()` per spawn; input/resize compare terminalId first. Kill: reuse `killTreeWin32` + `captureBirthTime` from `server/win32-job.ts` (posix: `process.kill(-pid, 'SIGKILL')` with detached process group — spawn with `detached: true` on posix ONLY if needed for group kill; verify against the existing subprocess-tree-containment note's approach and follow it). Exit detection: pty.onExit → state exited + serialize snapshot + store.flush.
- [ ] **Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit.** `feat(terminal): PTY session core with headless screen retention`

---

### Task 6: Restart flow (restore + divider + auto-spawn semantics)

**Files:**
- Modify: `server/terminal.ts` (constructor load + create branch)
- Test: `server/terminal-restart.test.ts`

**Interfaces:**
- Consumes: Task 5 class, `PersistedTerminal` (Task 4), `TERMINAL_DIVIDER_TEXT`.
- Produces: `create()` semantics extended — when constructed with a persisted screen present and no live process: snapshot BEFORE create is `{ screen: persisted.screen, state: { ...persisted.state, status: 'idle' }, restored: true }`; `create()` then writes the ANSI-styled divider into the headless terminal, spawns a fresh shell, and new output appends after it. Persisted status `exited` → snapshot keeps `exited` + exitCode, `restored: true`, and `create()` is still allowed (manual restart) but nothing auto-spawns at construction.

- [ ] **Step 1: Write failing tests:** (a) seed store with running-state screen → new TerminalSession → snapshot().restored === true, status idle, screen equals persisted; (b) create() → snapshot.screen contains TERMINAL_DIVIDER_TEXT BEFORE the new shell's first output; (c) persisted exited → snapshot status exited + exitCode preserved, no spawn until create; (d) no persistence → restored false, plain idle; (e) corrupt persistence (Task 4 guard) → plain idle, no throw.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement.** Constructor: `store.load(sessionId)` → write persisted screen into headless, set restored flag, derive initial state. Divider: write `\x1b[2m` + TERMINAL_DIVIDER_TEXT + `\x1b[0m\r\n` (dim ANSI — exact escape choice is the implementer's, the text is fixed) into headless AND fan it out as the first output chunk of the new generation so live viewers see it too.
- [ ] **Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit.** `feat(terminal): restart restore with divider and auto-spawn semantics`

---

### Task 7: SessionManager integration + sleep guard + lifecycle

**Files:**
- Modify: `server/session-manager.ts` (terminals map, ops, phaseOf ~line 11709, sleep ~line 6061, delete path, shutdown path, SessionInfo build)
- Modify: `shared/session-info.ts` (add flag near taskControlSupported ~line 270)
- Modify: `server/session-types.ts` (if SessionInfo plumbing touches it)
- Test: `server/session-manager.terminal.test.ts` (new focused file; follow existing session-manager.test.ts harness patterns)

**Interfaces:**
- Consumes: TerminalSession (Tasks 5/6), TerminalScreenStore, terminalCapability.
- Produces (frame-bridge and routes call exactly these):

```ts
// SessionManager methods — all capability-gated (HttpError 400 'terminal not supported' when unsupported),
// all work on live OR dormant sessions (meta lookup, never requireLive/requireRunnable):
terminalCreate(id: string, cols: number, rows: number): TerminalSnapshot
terminalInput(id: string, terminalId: string, data: string): void
terminalResize(id: string, terminalId: string, cols: number, rows: number): void
terminalClose(id: string): void
terminalSnapshot(id: string): TerminalSnapshot
subscribeTerminal(id: string): {
  iterable: AsyncIterable<WsTerminalSnapshot | WsTerminalOutput | WsTerminalState>
  snapshot: TerminalSnapshot | null
  unsubscribe: () => void
} | null   // Pushable-backed, mirrors subscribePromptSuggestion's shape
// SessionInfo:
terminalSupported?: boolean  // three-state like taskControlSupported; from terminalCapability()
```

- [ ] **Step 1: Write failing tests:** (a) terminalCreate on a DORMANT session succeeds and does NOT spawn an SDK subprocess (assert no query spawn via the harness's fake provider); (b) **sleep rejected 409 while terminal running**, message blames the terminal (mirror the backgroundSubagent blame branch at line 6067); after close, sleep succeeds; exited terminal does not block; (c) phaseOf returns 'working' with a running terminal; (d) session delete → process killed + persisted file removed; (e) shutdown/dispose → killed, file KEPT; (f) unsupported capability → 400 on every op; (g) subscribeTerminal seeds snapshot and fans output/state frames; unsubscribe stops fan-out.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement.** Manager fields: `private terminals = new Map<string, TerminalSession>()`, `private terminalStore: TerminalScreenStore` (constructed with stateDir). Lazy TerminalSession per id from meta.cwd; events fan into a per-session Pushable subscriber set (mirror the prompt-suggestion channel plumbing). phaseOf: add `if (this.terminals.get(s.id)?.running) return 'working'` after the backgroundSubagent check. sleep: terminal-specific blame message. delete: `close()` (kills + removes file). unload/shutdown: `dispose()` + `flush()`. SessionInfo: set terminalSupported from the probe. Metrics: `terminal_spawn_total` counter, `terminal_active` gauge on the GC tick, `terminal_output_bytes` counter — register in `server/metrics.ts` following existing definitions.
- [ ] **Step 4: Run, verify PASS** + full session-manager suite (no regression).
- [ ] **Step 5: Commit.** `feat(terminal): session-manager integration, sleep guard, lifecycle`

---

### Task 8: frame-bridge terminal channel

**Files:**
- Modify: `server/frame-bridge.ts` (client-frame switch ~line 382 region; subscribe drive loop ~line 759 region; cleanup list ~line 807/814)
- Test: `server/frame-bridge.terminal.test.ts` (follow frame-bridge.test.ts:1267+ subagent-transcript patterns)

**Interfaces:**
- Consumes: Task 7 manager methods, Task 2 frames.
- Produces: wire behavior — `terminal-subscribe` validates sessionId, answers via the terminal channel (snapshot seeded first, then live frames); control frames delegate and surface manager HttpErrors as prose `error` frames; `terminal-unsubscribe` and connection cleanup release the subscription.

- [ ] **Step 1: Write failing tests:** (a) subscribe → first frame is terminal-snapshot with current state; (b) create → state frame running; input → output frames with contiguous seq; (c) **seq-gap resync**: client sends terminal-resync → fresh terminal-snapshot (Review Focus 3 recovery half); (d) input for stale terminalId → error frame, channel stays live; (e) unsubscribe → no further frames; (f) missing sessionId → error frame; (g) unsupported session → error frame, no crash; (h) two connections subscribed to one session both receive output (fan-out), one unsubscribing doesn't affect the other.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement.** Add cases to the client-frame switch delegating to Task 7 methods; drive the subscribeTerminal iterable with the existing `drive()` helper → sink.send; add the sub to the cleanup arrays. No ring, no message-channel touch.
- [ ] **Step 4: Run, verify PASS** + full frame-bridge suite.
- [ ] **Step 5: Commit.** `feat(terminal): WS terminal channel in frame-bridge`

---

### Task 9: Client channel hook + association memory

**Files:**
- Modify: `src/hooks/useWsHub.ts` (add subscribeTerminal next to subscribeSubagentTranscript ~line 475; WsHubApi interface ~line 78)
- Create: `src/hooks/useTerminalChannel.ts`
- Modify: `src/constants/storageKeys.ts` (binding key factory)
- Test: `src/hooks/useTerminalChannel.test.ts` (jsdom, mock hub)

**Interfaces:**
- Consumes: Task 2 frames, hub listener API.
- Produces:

```ts
// useWsHub addition:
subscribeTerminal: (sessionId: string) => () => void  // ref-counted, sends terminal-subscribe/unsubscribe
// useTerminalChannel:
export interface TerminalChannel {
  supported: boolean            // from SessionInfo.terminalSupported
  state: TerminalState | null   // re-renders host ONLY on state transitions
  snapshot: TerminalSnapshot | null
  subscribeOutput(cb: (data: string) => void): () => void  // leaf-level, zero host re-renders
  create(cols: number, rows: number): void
  input(data: string): void
  resize(cols: number, rows: number): void
  close(): void
}
export function useTerminalChannel(sessionId: string, supported: boolean): TerminalChannel
```

- [ ] **Step 1: Write failing tests:** (a) subscribe on mount, unsubscribe on unmount (ref-count via mock hub); (b) snapshot frame sets state+snapshot; output frames do NOT re-render the host (render-count assertion, mirror streaming-render-isolation.test.tsx pattern) but reach subscribeOutput listeners; (c) **seq gap** (receive seq 5 after seq 2) → sends terminal-resync exactly once; (d) state frame transitions update state; (e) binding memory: after a running snapshot, localStorage `crw.terminal.binding.<sessionId>` holds terminalId; on a later `restored:true + idle` snapshot with a stored binding → auto-sends terminal-create (the restart auto-create); without binding → no auto-create; (f) close clears the binding.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement.** Hook filters session frames by the three terminal kinds via addSessionListener; output seq tracking in a ref; binding in localStorage (key factory in storageKeys.ts). Auto-create effect keys on (snapshot.restored, snapshot.state.status, binding) — fires once per restored-idle snapshot.
- [ ] **Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit.** `feat(terminal): client channel hook with resync and restart auto-create`

---

### Task 10: TerminalOverlay + union membership + keep-alive + escape region

**Files:**
- Modify: `src/app/useAppOverlays.ts:8` (add `'terminal'` to PanelOverlayKind + derived field + adapter handlers, follow the search overlay's exact pattern at lines 95-100)
- Create: `src/components/terminal/TerminalOverlay.tsx` (chrome + state banners)
- Create: `src/components/terminal/TerminalBody.tsx` (xterm owner — the lazy chunk)
- Create: `src/styles/terminal.css` (theme vars in BOTH themes)
- Modify: `src/components/Chat.tsx` (mount site near GitPanel ~line 2623; keep-alive container)
- Modify: `src/App.tsx` (overlay union wiring: terminalOpenFor + handlers passthrough)
- Test: `src/components/terminal/TerminalOverlay.test.tsx` (jsdom, xterm mocked)
- Test: `src/app/useAppOverlays.test.ts` (extend if exists, else create)

**Interfaces:**
- Consumes: `useTerminalChannel` (Task 9), Overlay component (`escapeBehavior='custom'` + `onEscape`, Overlay.tsx:144-147), floating-surface registry.
- Produces: `<TerminalOverlay sessionId open onClose supported channel />`; Chat renders the body ONCE per panel after first open, in a container that is `display:none` when the union's active overlay ≠ terminal — **xterm must NEVER remount on open/close** (single persistent body container; chrome/registry engagement toggles around it; moving the body between DOM parents is the trap this forbids).

- [ ] **Step 1: Write failing tests:** (a) union: opening terminal replaces git; opening git replaces terminal (type-level + behavior); (b) open → body mounted; close → body STILL mounted (container display:none), channel NOT unsubscribed; (c) **Esc with terminal focused** → onEscape forwards `\x1b` to channel.input, overlay does NOT close, and the global escapeAction interrupt path is not reached (assert via the floating-surface registry's topmost-wins: terminal registers as consumer while focused) (Review Focus 4 half); (d) exited state renders exitCode + Restart button → Restart calls create; (e) supported=false renders unavailable panel, no xterm import; (f) **permission modal over focused terminal**: registry gives the modal topmost Esc (Review Focus 4); (g) IME: xterm onData during composition forwards exactly once (mock-level assertion) (Review Focus 5 half); (h) restored-idle snapshot with NO binding (fresh tab) renders the history + a "New terminal" affordance and does NOT auto-create.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement.** TerminalBody: `React.lazy(() => import('./TerminalBody'))` boundary lives in TerminalOverlay; xterm Terminal + FitAddon, theme read from computed CSS vars (both themes), onData → channel.input, onResize → fit → channel.resize, snapshot.screen written on mount and on every new snapshot (resync), subscribeOutput → term.write. Fit suppressed while hidden (clientWidth 0 — same stand-down rule as useTranscriptScroll). Overlay chrome: header shell+cwd+status+X; Overlay escapeBehavior='custom', onEscape → input('\x1b') when focused. Focus: open → term.focus(); close → composer focus signal.
- [ ] **Step 4: Run, verify PASS.** Then `npm run analyze:bundle` — startup chunk unchanged vs pre-task baseline; xterm lands in its own lazy chunk.
- [ ] **Step 5: Commit.** `feat(terminal): keep-alive overlay with xterm body and escape region`

---

### Task 11: Ctrl+` registration + palette + composer button

**Files:**
- Modify: `src/App.tsx` (shortcut registration in the useMemo shortcut array ~line 3407 region)
- Modify: `src/components/Composer.tsx` (props ~line 179 region; button JSX after the Tasks block ~line 1169)
- Modify: `src/components/Chat.tsx` / `ChatPanel.tsx` (prop passthrough: terminalRunning + onOpenTerminal)
- Test: `src/components/Composer.terminal-button.test.tsx`
- Test: extend App shortcut tests if present (else assert via dispatcher-level test in Task 3's file)

**Interfaces:**
- Consumes: Task 3 `ctrl` token, Task 10 union handlers, Task 9 channel state.
- Produces: Composer props `onOpenTerminal?: () => void` and `terminalRunning?: boolean`; button renders ONLY when `onOpenTerminal && terminalRunning`, immediately right of the Tasks button, `className 'btn btn-icon composer-terminal'`, aria-label `'Open terminal'`, HoverHint label `'Terminal running — click to open'`. Shortcut: `{ combo: 'ctrl+`', allowInInput: true, description: 'Toggle terminal', handler }` — toggles the focused panel's terminal overlay (open replaces any sibling overlay; close when already open); suppressed when a true modal is open (check the existing modal/escape-stack state the palette uses). Palette entry comes free from `description` (CommandPalette.tsx:60-66).

- [ ] **Step 1: Write failing tests:** (a) Composer: terminalRunning=false → no button; true → button right of Tasks (DOM order assertion); click → onOpenTerminal; running→false transition removes it; (b) shortcut: ctrl+` toggles overlay for focused panel; meta+` does NOT (Task 3 matcher); fires with xterm textarea focused (allowInInput); **suppressed under an open ConfirmDialog/palette** (Review Focus 4); **not fired during isComposing** (Review Focus 5).
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** per signatures above; terminalRunning derives from the panel's terminal channel state (lift the minimal boolean to ChatPanel — do NOT subscribe the whole channel at Chat level; leaf-subscription rule).
- [ ] **Step 4: Run, verify PASS** + Composer suite.
- [ ] **Step 5: Commit.** `feat(terminal): ctrl-backquote toggle, palette action, composer entry`

---

### Task 12: Browser E2E, manual acceptance, docs

**Files:**
- Create: `tests/browser/terminal.spec.ts` (follow existing playwright.app.config.ts patterns)
- Modify: `CLAUDE.md` (architecture section: terminal service, channel, overlay, packaging)
- Move: `.agents/notes/proposed/feature/2026-11-21-embedded-terminal.md` → `.agents/notes/implemented/feature/` (Status: implemented; update facts to match shipped paths/names)
- Modify: `docs/superpowers/specs/2026-11-21-embedded-terminal-design.md` (Status line → implemented)

**Interfaces:**
- Consumes: everything shipped.

- [ ] **Step 1: Write the E2E spec** — against the real built app: open session → Ctrl+` → terminal visible → type `echo crw-e2e-marker` + Enter → marker renders in xterm → resize window → no crash → reload page → reopen → screen restored (marker present) → close terminal → composer button gone. Assert each as a Playwright expect.
- [ ] **Step 2: Run** `npx playwright test tests/browser/terminal.spec.ts --config playwright.app.config.ts` — iterate to green.
- [ ] **Step 3: Manual acceptance script** (run against `npm run dev`, record results in the PR/commit body): ssh-style password prompt (use `ssh localhost` or a local prompt simulation), sudo-style prompt, vim (alternate screen; Esc reaches vim — overlay stays, turn NOT interrupted), server restart → remembered tab auto-creates with divider + history, sleep 409 while running, Node 20 load check (`npx -p node@20 node dist/cli.mjs` smoke or documented CI equivalent), Electron desktop smoke (`npm run desktop` — terminal spawns, asarUnpack effective).
- [ ] **Step 4: Docs.** CLAUDE.md: add terminal to the architecture narrative (service, channel frames, overlay keep-alive, packaging/patch, sleep guard) in the existing style; move + update the agent note; `npm run verify:agent-notes` green.
- [ ] **Step 5: Full verify** — `npm run verify` (typecheck + lint + notes + tests + build) green.
- [ ] **Step 6: Commit.** `feat(terminal): E2E coverage and architecture docs` + note move in the same commit.
- [ ] **Step 7: Whole-branch review** — run the `code-review` skill on the full branch diff before any merge (repo rule: never commit unreviewed code to main; each task was reviewed at its gate, this is the final sweep).