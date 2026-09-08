# In-process hooks (read+react) — design

Date: 2026-09-08
Status: drafted for review
Scope: add the SDK's in-process `Options.hooks` as a narrow, opt-in **read+react** capability layer — NOT tool governance, NOT a replacement for the existing external settings-hooks.

## 1. Background & problem

`claude-react-web` drives hooks exclusively through the CLI's **external** `Settings.hooks`
mechanism (`command`/`http`/`prompt`/`agent` types executed by the CLI as subprocess/HTTP/prompt
injection). The SDK's **in-process** `Options.hooks` channel — TypeScript callbacks that run
synchronously in the server's `query()` host process — is never tapped.

Two probe runs (throwaway, deleted) established the ground truth:

1. **In-process callbacks fire and the SDK auto-emits `hook_started`/`hook_response` frames around
   them.** The existing `hookLifecycleMessage` → `HookRunRecord` → `WsHookRunEvent` → `HooksPanel`
   run log therefore shows in-process hook runs **for free** (verified live).
2. **The in-process `PreToolUse` callback cannot gate tool calls in this stack.** `permissionDecision`
   (and `permissions[]`) deny returns in both `bypassPermissions` and default mode did **not** stop a
   `Bash` call across three return-shape probes on the Ark/third-party base URL + third-party model.
   Per the SDK's own warning, `bypassPermissions` auto-approves before `canUseTool`; the in-process
   hook deny is not honored by this CLI host.

**Consequence:** the "tool governance" variant of this feature is **withdrawn on evidence**. Tool
permissioning stays on the existing, working `canUseTool`/permission-broker engine. This spec covers
only the read+react value that in-process hooks retain: surfacing **structured** hook input that the
SDK's `hook_*` frames do not contain.

## 2. Goal / non-goals

**Goal:** register a small, defensive set of in-process `Options.hooks` callbacks (`SessionEnd`,
`Notification`) in `claude-provider.ts:createSession`, and surface their **structured input**
(`reason` + `transcript_path` for SessionEnd; `message` for Notification) as visible `HookRunRecord`
detail in the existing `HooksPanel` run log. The consumer is the existing run-log UI — no new dead
storage, no new panel.

**Non-goals (explicitly out of scope):**
- No tool governance / `PreToolUse` blocking (disproven by probe; tooling stays on `canUseTool`).
- No replacement of the external `Settings.hooks` config UI, persistence, or `Settings.hooks`
  runtime — the two registries are independent and coexist.
- No new user-facing policy/editor surface.
- No `MessageDisplay`, `UserPromptExpansion`, `PostToolBatch` etc. unless a consumer is later added.

## 3. Architecture & data flow

Layers (all existing, one shared type gains a field):

```
SDK query() host process
  Options.hooks callbacks (SessionEnd, Notification)
     │  reads HookInput (.reason/.transcript_path/.message, .session_id)
     │  builds HookRunRecord{ hookName:"inproc:SessionEnd", status:"success", hookInput: JSON }
     ▼  onInProcessHook(sessionId, record)   [injected forward]
session-manager.recordHookRun(sessionId, event)
     ▼
session-broadcaster → WsHookRunEvent (channel "hooks")
     ▼
useWsHub/useChatStream → HooksPanel.upsertRun(runs, event)  [existing, by-run-id merge]
```

The SDK ALSO auto-emits `hook_started`/`hook_response` frames around in-process callbacks; the pump
parses those into `HookRunRecord`s with `hookName` = the SDK event name (e.g. `SessionEnd`). The
in-process callback's own record is written with hookName prefix `inproc:` so the two render as
distinct entries — SDK frame = the execution trace; `inproc:` record = the structured detail the
frame lacks. Coexistence is intentional, not duplicative.

## 4. Touchpoints

### 4.1 `server/providers/claude/claude-provider.ts` — inject `Options.hooks`

In `createSession`, alongside the existing `if (opts.includeHookEvents !== undefined) …` fold
(~line 296), **build the in-process hooks locally from the injected forward and assign directly**:

```ts
sdkOptions.hooks = buildInProcessHooks(opts.inProcessHookForward) as Options['hooks']
```

`buildInProcessHooks(forward)` is a small pure factory (in `claude-provider.ts` or a sibling
`server/providers/claude/inprocess-hooks.ts`) returning:

```ts
{
  SessionEnd: [{ hooks: [defensiveHook('SessionEnd', cb)] }],
  Notification: [{ hooks: [defensiveHook('Notification', cb)] }],
}
```

`defensiveHook` wraps each callback: `try/catch` (log + swallow, never throw into the pump), checks
`options.signal.aborted` and returns early, and caps the serialized `hookInput` (e.g. 4 KiB) via a
trim helper reused from history-utils. `stderr`/`abort` cannot stall the host.

The callbacks need a path to the session's `recordHookRun`. To avoid the provider depending on a
live `SessionManager`, the callback resolves the session from the input's own `session_id` and calls
an injected forward: `CreateSessionOptions.inProcessHookForward` (see 4.2). The provider receives it
via `providerExtras` and closes over it in `buildInProcessHooks`.

### 4.2 `server/providers/types.ts` — thread the forward

Add to `CreateSessionOptions`:
```ts
/** Injected by the session holder. Called by in-process read+react hook callbacks to surface
 *  structured input into the existing hook run-log channel. Never blocks the pump. */
inProcessHookForward?: (sessionId: string, event: HookRuntimeEvent) => void
```

### 4.3 `server/session-manager.ts` — provide the forward

Where `providerExtras`/create options are assembled (near the existing `includeHookEvents: true`
at ~2309/5287), supply:
```ts
inProcessHookForward: (sessionId, event) => this.recordHookRun(sessionId, event)
```
reusing the existing `recordHookRun(id, event)` → broadcaster path (manager ~4204). No new
transport.

### 4.4 `shared/hooks.ts` — extend `HookRunRecord`

Add one **optional** field (backwards compatible; existing consumers ignore it):
```ts
/** Structured hook input (in-process read+react only), serialized summary. Not present on
 *  external settings-hook frames. */
hookInput?: string
```
No change to `HookRunStatus`/`HookRuntimeEvent` shape.

### 4.5 `src/components/HooksPanel.tsx` — render `hookInput`

Where each run's detail body is rendered, append `{run.hookInput && <div className="hook-run-input">…}</di…>`
(theme variables only; CSS in the panel's existing styles). Shows the structured input next to the
run's stdout/output.

## 5. Error handling / resilience

- Every callback is inside `defensiveHook`: `try/catch` (log via `createLogger`, never rethrow),
  `signal.aborted` short-circuit, `hookInput` size-capped. A buggy/malformed input object must
  never crash the pump or stall the host.
- Forward is fire-and-forget; if `recordHookRun` throws it is caught in the callback's `try/catch`.
- SDK hook events that carry no `hookName`/`session_id` are skipped defensively.

## 6. Testing

- **`claude-provider.test.ts` / `structured-provider.test.ts`**: injecting `sdkOptions.hooks` sets
  `SessionEnd`+`Notification`; `defensiveHook` swallows an exceptioning callback without throwing;
  the injected `inProcessHookForward` is invoked with the input's `session_id` and a valid
  `HookRuntimeEvent`.
- **`shared/hooks` validation tests**: `HookRunRecord` accepts `hookInput` (optional-field no
  breakage).
- **`session-pump.test.ts`**: existing `hookLifecycleMessage` unchanged — an in-process SDK frame
  still parses (no `hookInput`).
- **Client (jsdom)**: `HooksPanel` renders `hookInput` when present; omits gracefully when absent.

## 7. Risks & open items

- **Dual entries in HooksPanel** (SDK frame + `inproc:` record) for the same event — by design (see
  §3). If it reads noisy, drop the `inproc:` forward and keep only the SDK-frame visibility; this is
  the fallback and requires just removing the forward, not the callback.
- **`session_id` presence**: in-process `BaseHookInput` carries `session_id` per the SDK type; if a
  host never supplies it, the forward cannot target a session — fallback is to skip (logged).
- **Not verified live**: whether `SessionEnd` in-process callback fires reliably in this CLI host on
  Ark/third-party models (the probe verified `UserPromptSubmit`/`Stop` fire; `SessionStart` did not,
  so per-event firing is not uniform). This is the gate for the **first implementation step**: run
  the minimal callback + log, confirm `SessionEnd`/`Notification` fire, then wire the forward. If
  they don't fire, reduce to `Stop`/`UserPromptSubmit` (verified) or document the limitation.

## 8. Rollout sequence (implementation order)

1. Provider injects `Options.hooks` with `defensiveHook` + a **spy-only** callback (logs, no forward).
2. Run live once; confirm `SessionEnd`/`Notification` fire in this stack (open item above).
3. Wire `inProcessHookForward` + `HookRunRecord.hookInput` + HooksPanel render.
4. Tests, typecheck, lint, code-review on the full diff.
5. Decide commit into `main` with the user (project forbids unreviewed commits).