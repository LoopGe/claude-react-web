# CLI stderr 诊断 (CLI Stderr Diagnostics)

Date: 2026-09-09
Status: Approved design (brainstorming complete)
Scope: Server + client diagnostic surface for the Claude Agent SDK subprocess

## 1. Problem

Each session spawns a local `claude` CLI subprocess. Diagnostics the CLI emits
go to **stderr** (errors, stack traces, proxy failures, `--debug` logging),
separate from the stream-json protocol on stdout.

Today the app:
- already taps `child.stderr` in `server/process-monitor.ts` and logs each
  line at `log.warn` with `[process-monitor] stderr[<sid>]: ...` — but that is
  only in the server log (console / rotated file when `logToFile` is on);
- does **not** set the SDK `Options.debug` / `debugFile` / `stderr` options;
- has **no** per-session debug toggle, no UI surface, and no independent
  per-session log file.

Goal: give a user/troubleshooter per-session visibility into what the CLI was
doing when something went wrong — a persistent stderr tail and an optional CLI
debug log file — plus a Settings UI to control it.

## 2. Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Scope | **Both**: SDK `debug`/`debugFile` (CLI debug log) **and** per-session stderr tail + spawn-failure display |
| UI surface | `SettingsPanel` → new **Diagnostics** tab (fetched on open, Refresh button) |
| stderr tail lifetime | Persisted to `<stateDir>/logs/cli-stderr-<id>.jsonl`; viewable after session close |
| Debug toggle | Global default in `config.json` (`cliDebug`, default **false**) + per-session override in `SessionMeta` |
| Spawn-failure display | Only the **current** crashing session's error card (collapsible stderr tail), no global failure list |
| Cleanup | `<stateDir>/logs/` retention of 14 days + single-file size cap ~5 MB |
| Effective timing of debug toggle | Spawn-time only (SDK has no runtime setter) — applies on next spawn/resume/restart |

## 3. Config & data model

### 3.1 Global default — `server/config.ts`

```ts
interface ConfigFile {
  // ...
  /** Global default for per-session CLI debug logging (Options.debug +
   *  debugFile). SessionMeta.cliDebug overrides when set. Default false. */
  cliDebug?: boolean
}
```

Lives in the frozen `defaultConfig` object, read by the provider/session-manager
the same way other defaults are.

### 3.2 Per-session override — `server/persistence.ts` `SessionMeta`

```ts
/** User intent: per-session CLI debug logging. undefined = inherit the
 *  global config default. Persisted so resume/fork/restart keep the intent.
 *  Spawn-time only — takes effect on the next spawn. */
cliDebug?: boolean
```

Mirrors the existing intent fields (`fastMode`, `thinking`, `sandbox`,
`effortLevel`, `autoCompactWindow`).

### 3.3 Effective value (resolved at every spawn/respawn)

```
effectiveCliDebug = session.cliDebug ?? defaultConfig.cliDebug ?? false
```

SessionManager resolves this at spawn time and passes it into
`CreateSessionOptions.cliDebug`.

## 4. Files on disk

All under `<stateDir>/logs/` (same dir the server file-log uses):

| File | Written by | When | Retention |
|---|---|---|---|
| `cli-<id>.log` | SDK/CLI (`Options.debugFile`) | only when `cliDebug` effective true | 14 days (cleanup) |
| `cli-stderr-<id>.jsonl` | our `appendStderrLine` | **every** spawn, regardless of debug | 14 days + 5 MB cap |

`cli-stderr-<id>.jsonl` line shape: `{"ts": <epochMs>, "line": "<stderr line>"}`.

## 5. Provider spawn wiring

### 5.1 Thread `logsDir` to the provider

- `SessionManager` computes `logsDir = join(this.store.getDir(), 'logs')`
- `createDefaultProviders` / `ClaudeProviderOptions` gain `logsDir?: string`
- `ClaudeProvider` stores it and uses it for `debugFile` and the stderr sink

### 5.2 `CreateSessionOptions.cliDebug` (`server/providers/types.ts`)

```ts
/** Effective per-session CLI debug intent (resolved global/per-session
 *  override). Spawn-time only. */
cliDebug?: boolean
```

### 5.3 `ClaudeProvider.createSession` (`claude-provider.ts`)

```ts
if (opts.cliDebug) {
  await fs.mkdir(this.logsDir, { recursive: true })
  sdkOptions.debug     = true
  sdkOptions.debugFile = join(this.logsDir, `cli-${opts.id}.log`)
}
```

- `debug`/`debugFile` are **spawn-time Options**; there is no runtime setter,
  so toggling takes effect on the next spawn (resume/restart/fork).

## 6. stderr tail capture (always on)

### 6.1 `ProcessMonitor` gains a sink

Add to the constructor options:

```ts
stderrSink?: (sessionId: string, line: string) => void
```

In `spawnFor`, each captured stderr line is:
- still `log.warn`ed into the server log (unchanged), **and**
- passed to `stderrSink(sid, line)` when provided.

The existing tap already fires for every spawn (registered or stray); the sink
tee is appended in the same place, so stray-post-view spawns still get a line.

Provider constructs it as:

```ts
new ProcessMonitor(onExit, { stderrSink: (sid, line) => appendStderrLine(this.logsDir, sid, line) })
```

### 6.2 New helper — `server/cli-diagnostics.ts` (pure, unit-testable)

```ts
appendStderrLine(logsDir, sid, line): Promise<void>
readStderrTail(logsDir, sid, n = 200): Promise<string[]>
cliLogInfo(logsDir, sid): Promise<{ exists: boolean; path?: string; size?: number }>
cleanupCliLogs(logsDir, maxAgeMs = 14 * 24 * 3600 * 1000): Promise<number>
```

`appendStderrLine`:
- appends `{ts, line}` to `cli-stderr-<sid>.jsonl`;
- when the file exceeds ~5 MB, rewrites keeping the last ~1 MB (read tail,
  rewrite, append) so the file stays bounded.

`cleanupCliLogs`:
- deletes `*.log` and `cli-stderr-*.jsonl` under `logs/` older than `maxAgeMs`;
- invoked at boot and alongside the existing file-log rotation path.

## 7. REST API — `server/routes/diagnostics.ts`

New subrouter, mounted at `/api/sessions/:id/diagnostics` mirroring the
skills/hooks subrouter pattern.

```
GET /sessions/:id/diagnostics
  → 200 {
      cliDebug: {
        global: boolean,
        perSession?: boolean,   // present only when an override is set
        effective: boolean,
      },
      stderrTail: string[],       // last 200 lines, oldest→newest
      debugLog: { exists, path?, size? },
    }

PUT /sessions/:id/diagnostics
  body { cliDebug: boolean | null }
  → writes SessionMeta.cliDebug (null clears the override, back to global)
  → 200 { cliDebug: { global, perSession?, effective } }
  → body field response notes "applies on next spawn"
```

- `null` body clears the per-session override (inherit global).
- No respawn is triggered; toggle is effective on next spawn.

## 8. Client

### 8.1 `src/hooks/useDiagnostics.ts`

`getDiagnostics(sessionId)` and `setCliDebug(sessionId, value: boolean | null)`
wrapping the REST endpoints.

### 8.2 `SettingsPanel` → new Diagnostics tab

- **CLI debug**: three-state select `Global (<value>)` / `On` / `Off`, with a
  note "applies on the next session start". Setting `Global` sends `null` to
  clear the override.
- **stderr tail**: fetches `stderrTail` on tab open + a Refresh button; renders
  in monospace with the newest lines at the bottom; shows line count.
- **debug log file**: when `debugLog.exists`, shows the path and file size.

### 8.3 Spawn-failure card (current session only)

When a session is in an error / crash state, the client's error card shows a
collapsible `<details>` with the stderr tail (last ~30 lines). The tail is
**fetched** via the existing `GET /sessions/:id/diagnostics` when the error
card renders — the error frame wire shape is unchanged. No global failure
list.

## 9. Cleanup

- `cleanupCliLogs(logsDir)` runs at boot and with the file-log rotation path.
- Removes `cli-<id>.log` / `cli-stderr-<id>.jsonl` older than 14 days.
- `appendStderrLine` self-caps each jsonl at ~5 MB.

## 10. Testing

| Area | File | Coverage |
|---|---|---|
| helper | `server/cli-diagnostics.test.ts` | append/readTail round-trip, 5 MB cap + truncate, cleanup age filter |
| provider | `claude-provider.*.test.ts` | `cliDebug: true` → options carry `debug`+`debugFile`; false → absent |
| manager | `session-manager.test.ts` | effective resolution (global / per-session / null), PUT persists override, null clears |
| routes | `server/routes/diagnostics.*.test.ts` | GET/PUT shapes, 404 on unknown session, null-clear semantics |
| client | `useDiagnostics.*.test.ts` + tab render test | fetch/render tail, toggle sends boolean/null |

## 11. Non-goals

- No runtime (mid-session) debug flip — spawn-time only.
- No global cross-session failure list / search over stderr.
- No `Options.stderr` SDK callback path (the local stdio tap already capture);
  revisit only if a remote/daemon transport is introduced.
- No per-session debug file rotation — the SDK owns `cli-<id>.log`; we only
  clean it up by age.
- No download/open endpoint for the debug file (path + size shown only).