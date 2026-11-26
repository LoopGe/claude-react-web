# Native Hook Engine (Project 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A hook execution engine in the neutral native core with CLI behavioral parity for 13 layer-1 events × 4 hook types, fed by the flag (`meta.hooks`) source through a multi-source collection seam.

**Architecture:** A core-internal engine (`server/providers/native/hooks/`) invoked from the existing turn-engine seams plus thin host dispatch points for host-driven events (compaction, user-prompt broadcast, permission broker). Activity emits as a neutral `hook/run` OperationalFrame projected through the existing adapter → pump → HooksPanel path (zero client/protocol/pump change). Collection is per-event so live `applyHooks` takes effect on the next event.

**Tech Stack:** TypeScript (ES2022), Node builtins (`child_process`, `fetch`), vitest (node environment for native tests), the native vocabulary + `shared/hooks.ts`.

**Spec:** `docs/superpowers/specs/2026-11-26-native-hook-engine-design.md` (approved). Behavioral contract: `docs/research/2026-11-26-cli-hook-semantics.md` (SDK 0.3.311 / CLI 2.1.311, source-verified; cited below as **RS §n**). Executors implement RS behavior — the plan pins interfaces, values, and tests, not executor bodies.

## Global Constraints

Every task implicitly includes these. Values copied from the spec / RS.

- **Neutrality:** core imports ONLY neutral `shared/*`, native vocabulary, sibling native modules, Node builtins. No SDK / host-domain value imports. Must pass `native/vocabulary/neutrality.test.ts` + `native/host-free.test.ts`. `child_process`/`fetch` are allowed (bash.ts precedent).
- **Parity reference = claude-in-CRW.** Same config → same observable behavior. Do NOT change the claude provider.
- **13 events:** PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit, Stop, StopFailure, SessionStart, SubagentStart, SubagentStop, PreCompact, PostCompact, PermissionRequest, PermissionDenied.
- **4 hook types:** command, http, prompt, agent. `mcp_tool` OUT.
- **SessionStart source ∈ {startup, resume, fork, compact}; NOT clear.** SessionEnd / Notification NOT fired.
- **`once` inert** for settings-shaped hooks (accept, ignore).
- **`if`** = permission-rule syntax (e.g. `Bash(git *)`), evaluable ONLY on PreToolUse/PostToolUse/PostToolUseFailure/PermissionRequest/PermissionDenied; non-tool event with `if` → skip that hook + log (RS §4.2).
- **matcher** (RS §4.1): empty / `*` / `.*` → match-all; literal-list (only `[a-zA-Z0-9_|, -]`) → split on `|`/`,`, trim, exact name-or-alias equality; else unanchored case-sensitive `new RegExp(matcher).test`; invalid regex → no match + log.
- **timeout defaults** (RS §4.5): command/http 600000ms, prompt 30000ms, agent 60000ms, UserPromptSubmit 30000ms; per-hook override clamped to 2147483647.
- **exit codes** (RS §2.3): 0 success / **2 block** / other non-blocking error. JSON block reason overrides stderr; exit 2 overrides `permissionDecision:"allow"`; `continue:false` overrides exit 2 on Stop.
- **stdout parsing** (RS §2.2): trimmed starts with `{` → JSON vs `SyncHookJSONOutput|AsyncHookJSONOutput`; else plain text. Invalid JSON → plain text + reported error, never crash.
- **onFailure:'block'** = failure-as-exit-2, command (non-async) + http ONLY (RS §2.4).
- **concurrency** (RS §4.9): command/http parallel cap **12**; prompt/agent serial. PostToolUse rewrites parallel last-write-wins.
- **Stop block cap = 8** (RS §5); `stop_hook_active` set on block.
- **command env** (RS §4.7): `CLAUDECODE="1"`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PROJECT_DIR`, `CLAUDE_EFFORT` (when effort), inherited process env. **NO `CLAUDE_TOOL_NAME`/`CLAUDE_TOOL_INPUT`** — tool facts are stdin-only.
- **prompt/agent model** (RS §6): default small-fast (`ANTHROPIC_SMALL_FAST_MODEL` else Haiku-class); agent gateway fallback to session model. prompt = single no-tool round, json_schema `{ok,reason,impossible?}`; agent = ≤50 rounds + verdict tool `{ok,reason?}`.
- **prompt/agent availability** (RS §12.2): Stop/SubagentStop/UserPromptSubmit/tool events; **agent rejected on PermissionRequest**; no-context (SessionStart/SubagentStart) / non-REPL (PreCompact/PostCompact/StopFailure) → non-blocking error, never silent success.
- **PostToolUse vs Failure** (RS §12.1): route by throw-vs-return, NOT `is_error` flag. Normal return (incl. soft `outcome.isError`) → PostToolUse; throw → Failure. MCP adapter converts `isError:true` → throw.
- **PermissionRequest** (RS §13.1): main-path allow for non-personOnly asks (NO `hooksMayAllow` gate); personOnly asks never hook-allowed; plugin-ask `dLr`/`Y6` branch OUT (Project 3).
- **PreCompact before summarization** (RS §13.3): exit-0 stdout shapes summary, exit-2 blocks before journal/summarization. Order: PreCompact → summarize → compactInPlace → PostCompact → SessionStart(compact).
- **transcript_path** = projected CLI-JSONL artifact (via `projectNativeEventToSdkLine`), not neutral v3 log.
- **UserPromptSubmit exit-2** erases native's log ONLY; host bubble stays; blocked turn emits consumption ack + result.
- **Live applyHooks** per-event re-collection (RS §12.3), never spawn-frozen.
- **Zero client / protocol / pump change.** Host manager gains thin dispatch seams only.
- **Repo ethos:** no speculative defensive code (errors surface loudly); prove behavior with evidence; review before commit (`code-review` on the full diff); write/update the owning `.agents/notes/` decision record in the same change.

## Review Focus

Input classes / failure modes the spec implies that are most likely to bite a user; each gets a test in its owning task (named below).

1. **A hook command that floods stdout/stderr** (`yes`-style) must not grow the heap unbounded — the runner survives and truncates (Task 4, `command-executor.test.ts` flood test; reuse bash.ts `CappedOutput` precedent).
2. **A hook printing `}`-terminated invalid JSON that starts with `{`** must degrade to plain text + a reported error and never crash the turn; a `{`-start without a closing `}` is plain-text success (CLI `zY`) (Task 3, `output.test.ts` invalid-JSON test).
3. **An invalid-regex matcher** must no-match + log, never throw (Task 2, `matcher.test.ts` invalid-regex test).
4. **A prompt/agent hook on a no-context event (SessionStart)** must produce a non-blocking error, not silent success or a crash (Task 12, availability test).
5. **A PreToolUse `updatedInput` carrying internal `_`-prefixed keys** must be rejected (deny), never passed to the tool (Task 8, PreToolUse dispatch test).

---

## File Structure

**New — `server/providers/native/hooks/`** (neutral core; each file one responsibility, tests alongside):

- `types.ts` — engine-internal neutral types: `HookDecision`, `HookSource`, `HookDispatchInput`, `HookExecResult`, `HookRunEmitter`. Re-exports the `shared/hooks.ts` config types it consumes.
- `collection.ts` — multi-source collection + CLI-precedence merge/dedup (RS §7). `collectForEvent(sources, event)`.
- `matcher.ts` — matcher language (RS §4.1) + per-event matcher-target map (RS §3 `qZe`). `matches(matcher, target)`, `matcherTarget(event, input)`.
- `output.ts` — stdout parsing (RS §2.2), exit-code contract (RS §2.3), onFailure rewrite (RS §2.4), per-event decision merge. `parseHookOutput(stdout, stderr, exitCode, hook)`, `mergeDecisions(event, results)`.
- `shell.ts` — hook shell resolution: bash via `resolveBashShell` (tools/shell.ts), powershell via PATH probe (pwsh/powershell). `resolveHookShell(shell?: 'bash'|'powershell')`. (Native has no powershell resolver today — this adds one.)
- `command-executor.ts` — command hook spawn (stdin JSON, env surface RS §4.7, timeout, capped output). `runCommandHook(hook, input, ctx)`.
- `http-executor.ts` — http hook (POST, header interpolation, URL gate, maxRedirects 0; RS §6.3). `runHttpHook(hook, input, ctx)`.
- `model.ts` — small-fast model resolution (RS §6). `resolveHookModel(opts)`.
- `availability.ts` — prompt/agent per-event availability gates (RS §12.2). `checkAvailability(type, event, hasContext)`.
- `prompt-executor.ts` — single no-tool LLM round (RS §6.1). `runPromptHook(hook, input, ctx)`.
- `agent-executor.ts` — ≤50-round agentic verdict loop reusing the nested runner (RS §6.2). `runAgentHook(hook, input, ctx)`.
- `if-condition.ts` — permission-rule `if` parser + per-tool matcher (RS §4.2; new infra). `evaluateIf(ifExpr, toolName, input)`.
- `engine.ts` — orchestrator: `HookEngine` class. `dispatch(event, input): Promise<HookDecision>`; per-event collection, matcher/if filter, concurrency (command/http cap 12 parallel, prompt/agent serial), decision merge, activity emission.
- `rewake.ts` — async/asyncRewake background execution + wake delivery (RS §4.4). `scheduleAsyncHook(...)`, wake queue.
- `transcript.ts` — `transcript_path` CLI-JSONL projection artifact (via `projectNativeEventToSdkLine`). `materializeTranscript(session)`.

**Modified:**

- `vocabulary/live-frame.ts` — add `hook/run` variant to `OperationalFrame` (closed union; carries `HookRuntimeEvent`).
- `native-host-frame-adapter.ts` — `projectNativeEventToSdk` `hook/run` case → SDK `system/hook_started|hook_progress|hook_response` (before the `assertNever` at :327).
- `native-session.ts` — `NativeSessionOptions` hooks field; construct `HookEngine`; `applyFlagSettings` allowlist + `hooks` (:2415); wire seams (init SessionStart :608-627, prompt dispatch :1573/:1659, pump catch StopFailure :1766-1812, compact :1994); `requestPermission` PermissionRequest/Denied (:1031/:1052).
- `loop.ts` — `LoopDeps` hook dispatch dep; PreToolUse before `requestPermission` (:217), PostToolUse/Failure (:250-260), Stop (:188-192/:294-307).
- `native-provider.ts` — read `sdkOptions.settings.hooks` (:255), pass to `NativeSession` (:281-315).
- `subagent.ts` — SubagentStart (descriptor :192-205) / SubagentStop (finalReport :249-260) seams via `AgentToolDeps`.
- `session-manager.ts` — host dispatch seams: PreCompact before `summarizeMergedForCompact` (:6142), PostCompact + SessionStart(compact) after splice; user-prompt broadcast coordination.
- native MCP adapter — convert MCP `isError:true` → throw (RS §12.1).

---

## Tasks

### Task 1: Engine types + multi-source collection seam

**Files:**
- Create: `server/providers/native/hooks/types.ts`, `server/providers/native/hooks/collection.ts`
- Test: `server/providers/native/hooks/collection.test.ts`

**Interfaces:**
- Consumes: `SessionHooksConfig`, `HookMatcherConfig`, `HookEvent` from `shared/hooks.ts`.
- Produces:
  - `interface HookSource { readonly kind: 'flag' | 'settings' | 'plugin' | 'agent'; collect(event: HookEvent): HookMatcherConfig[] }`
  - `collectForEvent(sources: readonly HookSource[], event: HookEvent): HookMatcherConfig[]` — concatenates in array order (caller passes CLI precedence flag→settings→plugin→agent), dedups identical hooks preferring the earlier source (RS §7 `a2`).
  - `interface HookDecision` — a MULTI-FACT object (NOT a single-variant union; controller ruling after T6 review): the CLI's `hookSpecificOutput` carries simultaneous facts, so the merged decision carries a primary action PLUS all side facts. Required shape (field names guided by RS §3 per-event hookSpecificOutput):
    - `action: 'continue' | 'block' | 'allow' | 'deny' | 'ask' | 'defer'` (rank-merge: block > deny > allow > ask > continue).
    - `block?: { reason: string; target: 'model' | 'user' }`; `permission?: { behavior; updatedInput?; reason?; message?; interrupt?; updatedPermissions? }`.
    - `additionalContext: string[]` — ALWAYS accumulated, never dropped when an action dominates.
    - `updatedToolOutput?: string` (PostToolUse, last-write-wins), `updatedMCPToolOutput?`, `classifierContext?`.
    - `continue?: boolean` + `stopReason?: string` (Stop forced-continuation; `continue:false` overrides exit-2).
    - `suppressOutput?: boolean`, `systemMessage?: string`.
    - `suppressOriginalPrompt?: boolean`, `sessionTitle?: string` (UserPromptSubmit/SessionStart).
    - `initialUserMessage?: string`, `watchPaths?: string[]`, `reloadSkills?: boolean` (SessionStart).
    - `retry?: boolean` (PermissionDenied); `customInstructions?: string` (PreCompact exit-0 stdout).
    - The ENGINE validates each hook's `hookSpecificOutput.hookEventName === event` (degrade mismatched payload per the CLI discriminated-union rejection) — this validation lives in the engine, the only place holding both `event` and the raw hso; seams cannot do it.

- [ ] **Step 1: Write the failing test** — `collection.test.ts`: `collectForEvent([flagSource, settingsSource], 'PreToolUse')` returns flag matchers before settings matchers; an identical hook present in both appears once (flag copy wins); empty sources → `[]`.
- [ ] **Step 2: Run to verify fail** — `npx vitest run server/providers/native/hooks/collection.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `types.ts` (the types above) and `collection.ts` (`collectForEvent` with order-preserving dedup keyed by hook type+command/url/prompt+matcher).
- [ ] **Step 4: Run to verify pass** — same command. Expected: PASS.
- [ ] **Step 5: Commit** — `git add server/providers/native/hooks/{types,collection}.ts server/providers/native/hooks/collection.test.ts && git commit -m "feat(native-hooks): multi-source collection seam + engine types"`

### Task 2: Matcher evaluation

**Files:**
- Create: `server/providers/native/hooks/matcher.ts`
- Test: `server/providers/native/hooks/matcher.test.ts`

**Interfaces:**
- Consumes: `HookEvent`.
- Produces: `matches(matcher: string | undefined, target: string | undefined): boolean`; `matcherTarget(event: HookEvent, input: Record<string, unknown>): string | undefined` (RS §3 `qZe` map: tool events→`tool_name`, SessionStart→`source`, Pre/PostCompact→`trigger`, SubagentStart/Stop→`agent_type`, PermissionRequest/Denied→`tool_name`, StopFailure→`error`; no-target events→undefined).

- [ ] **Step 1: Write the failing test** — `matcher.test.ts` cases: `matches(undefined, 'Bash')===true`; `matches('*', 'Bash')===true`; `matches('.*', 'Bash')===true`; `matches('Bash|Edit', 'Edit')===true` (literal list exact); `matches('Bash', 'BashTool')===false` (literal exact, not prefix); `matches('^Bash$', 'Bash')===true` (regex); `matches('bash', 'Bash')===false` (case-sensitive); `matches('Ba', 'Bash')===false` (all-letter matcher is a literal list → exact, NOT a prefix regex); `matches('B.sh', 'Bash')===true` (unanchored regex via metachar); **`matches('[', 'Bash')===false` (invalid regex no-match, never throws)** [Review Focus 3]; `matcherTarget('PreToolUse', {tool_name:'Bash'})==='Bash'`; `matcherTarget('Stop', {})===undefined`.
- [ ] **Step 2: Run to verify fail** — `npx vitest run server/providers/native/hooks/matcher.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `matcher.ts` per RS §4.1: empty/`*`/`.*`→true; literal-list charset `[a-zA-Z0-9_|, -]`→split `|`/`,` trim exact; else `new RegExp(matcher).test(target)` in try/catch (invalid→false + log). `matcherTarget` switch per the map.
- [ ] **Step 4: Run to verify pass** — same command. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(native-hooks): matcher language + per-event target map"`

### Task 3: Output contract (stdout parse + exit codes + onFailure)

**Files:**
- Create: `server/providers/native/hooks/output.ts`
- Test: `server/providers/native/hooks/output.test.ts`

**Interfaces:**
- Consumes: `HookConfig` (shared/hooks.ts).
- Produces:
  - `interface HookExecResult { outcome: 'success' | 'blocked' | 'error' | 'cancelled'; exitCode?: number; stdout: string; stderr: string; decision?: SyncHookDecision; async?: boolean }` (`SyncHookDecision` = the parsed `SyncHookJSONOutput` fields).
  - `parseHookOutput(stdout: string, stderr: string, exitCode: number, hook: HookConfig): HookExecResult` (RS §2.2/§2.3/§2.4).
  - `applyOnFailure(hook: HookConfig, result: HookExecResult): HookExecResult` (RS §2.4: command non-async + http only).

- [ ] **Step 1: Write the failing test** — `output.test.ts`: stdout `'plain'` exit 0 → outcome success, no decision; stdout `'{"decision":"block","reason":"no"}'` exit 0 → decision block reason 'no'; stdout `'{"continue":false}'` → parsed; **stdout `'{bad json}'` (`}`-terminated invalid JSON) exit 0 → outcome error, never throws** [Review Focus 2]; stdout `'{bad json'` (no closing `}`) exit 0 → plain text, outcome success (CLI `zY` no-`}` path); stdout `'{"async":true}'` → async true; exit 2 → outcome blocked (stderr is block message); exit 3 → outcome error non-blocking; JSON block reason overrides stderr; `applyOnFailure({type:'command',onFailure:'block'}, errorResult)` → blocked; `applyOnFailure({type:'command',async:true,onFailure:'block'}, errorResult)` → unchanged (async exempt); `applyOnFailure({type:'prompt',onFailure:'block'}, errorResult)` → unchanged (prompt exempt).
- [ ] **Step 2: Run to verify fail** — `npx vitest run server/providers/native/hooks/output.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `output.ts`: trim stdout, starts-with-`{` → JSON.parse + validate against the Sync|Async union (zod or hand validator matching RS §2.1 whitelist `continue/suppressOutput/stopReason/decision/systemMessage/terminalSequence/reason/metrics/rewakeSummary/hookSpecificOutput`); parse/validate failure → plain text + error outcome. Exit-code mapping + onFailure rewrite per RS §2.3/§2.4.
- [ ] **Step 4: Run to verify pass** — same command. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(native-hooks): hook output parsing + exit-code/onFailure contract"`

### Task 4: Command executor + shell resolution

**Files:**
- Create: `server/providers/native/hooks/shell.ts`, `server/providers/native/hooks/command-executor.ts`
- Test: `server/providers/native/hooks/command-executor.test.ts`

**Interfaces:**
- Consumes: `resolveBashShell` (tools/shell.ts:20), `parseHookOutput`/`applyOnFailure` (Task 3), `capToolText` (tools/bash.ts:78), `decodeShellBytes` (shell-encoding.ts), `killTreeWin32`/`captureBirthTime` (win32-job.ts).
- Produces:
  - `resolveHookShell(shell?: 'bash' | 'powershell'): { path: string; kind: 'bash' | 'powershell' }` — default: bash on POSIX, powershell on win32 without Git Bash (RS §4.8); explicit `shell` honored; powershell probes pwsh then powershell on PATH, throws loudly if absent.
  - `interface HookExecContext { cwd: string; sessionId: string; signal: AbortSignal; effortLevel?: string; env?: NodeJS.ProcessEnv }`
  - `runCommandHook(hook: CommandHookConfig, input: Record<string, unknown>, ctx: HookExecContext): Promise<HookExecResult>` — spawn shell `-c` (bash) or powershell command, stdin = `JSON.stringify(input)`, env per RS §4.7, timeout (hook.timeout*1000 ?? 600000, clamp 2147483647), capped stdout/stderr, kill tree on timeout/abort.

- [ ] **Step 1: Write the failing test** — `command-executor.test.ts` (use real shell, tmp cwd): a command echoing the stdin JSON returns it in stdout (verifies stdin delivery); `echo hi` exit 0 → success; `exit 2` with stderr → blocked; env contains `CLAUDECODE='1'` and `CLAUDE_CODE_SESSION_ID` and NOT `CLAUDE_TOOL_NAME`; timeout (hook.timeout tiny + `sleep`) → cancelled; **a flooding command (`yes`) is truncated and the promise settles, heap bounded** [Review Focus 1].
- [ ] **Step 2: Run to verify fail** — `npx vitest run server/providers/native/hooks/command-executor.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `shell.ts` (bash via resolveBashShell; powershell PATH probe) and `command-executor.ts` (spawn with stdio `['pipe','pipe','pipe']`, write stdin JSON, CappedOutput-style accumulation reusing capToolText, env surface RS §4.7, abort/timeout kill tree, parseHookOutput + applyOnFailure).
- [ ] **Step 4: Run to verify pass** — same command. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(native-hooks): command executor + bash/powershell shell resolution"`

### Task 5: hook/run frame + adapter projection

**Files:**
- Modify: `server/providers/native/vocabulary/live-frame.ts:57-90` (OperationalFrame union)
- Modify: `server/providers/native-host-frame-adapter.ts:243-329` (projectNativeEventToSdk)
- Test: `server/providers/native/hooks/emission.test.ts`

**Interfaces:**
- Consumes: `HookRuntimeEvent`, `HookRunRecord` (shared/hooks.ts), `OperationalEnvelope` (live-frame.ts:45).
- Produces: `OperationalFrame` gains `| ({ type: 'hook/run'; event: HookRuntimeEvent } & OperationalEnvelope)`. `projectNativeEventToSdk` maps it to SDK `{ type:'system', subtype:'hook_started'|'hook_progress'|'hook_response', hook_id, hook_name, hook_event, stdout?, stderr?, output?, outcome? }` matching what `hookLifecycleMessage` (session-pump.ts:1024) parses.

- [ ] **Step 1: Write the failing test** — `emission.test.ts`: `projectNativeEventToSdk({type:'hook/run', event:{kind:'started', run:{id:'h1',hookId:'h1',hookName:'PreToolUse',event:'PreToolUse',status:'started',startedAt:1,updatedAt:1}}, sessionId:'s', uuid:'u', parentToolUseId:null})` → `{type:'system', subtype:'hook_started', hook_id:'h1', hook_name:'PreToolUse', hook_event:'PreToolUse'}`; a `completed` run with exitCode → `hook_response` with outcome. Assert the existing `assertNever` still exhausts (typecheck).
- [ ] **Step 2: Run to verify fail** — `npx vitest run server/providers/native/hooks/emission.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the `hook/run` variant + the adapter case (kind→subtype: started→hook_started, progress→hook_progress, completed→hook_response; copy run fields; outcome from status). Keep neutrality (vocabulary imports only shared/hooks.ts type).
- [ ] **Step 4: Run to verify pass** — same command + `npm run typecheck`. Expected: PASS, no assertNever error.
- [ ] **Step 5: Commit** — `git commit -m "feat(native-hooks): hook/run operational frame + SDK projection"`

### Task 6: Engine orchestrator

**Files:**
- Create: `server/providers/native/hooks/engine.ts`
- Test: `server/providers/native/hooks/engine.test.ts`

**Interfaces:**
- Consumes: `collectForEvent` (T1), `matches`/`matcherTarget` (T2), `parseHookOutput`/`applyOnFailure` (T3), `runCommandHook` (T4), `HookSource`/`HookDecision` (T1), `HookRuntimeEvent`.
- Produces: `class HookEngine { constructor(opts: { sources: () => readonly HookSource[]; emit: (e: HookRuntimeEvent) => void; executors: Partial<Record<HookType, HookExecutor>>; cwd: string; sessionId: string; stream?: LoopDeps['stream']; tools?: ToolDef[] }); dispatch(event: HookEvent, input: Record<string, unknown>, ctx: { signal: AbortSignal; hasContext: boolean }): Promise<HookDecision> }`. `type HookExecutor = (hook: HookConfig, input: Record<string, unknown>, ctx: HookExecContext & { event: HookEvent; hasContext: boolean; stream?: LoopDeps['stream']; tools?: ToolDef[] }) => Promise<HookExecResult>` (the engine fills event/hasContext/stream/tools; prompt/agent executors consume them, command/http ignore them). Collects per dispatch (fresh sources() call), filters by matcher + if (if wired in T16), runs command/http parallel cap 12 + prompt/agent serial, merges decisions per event, emits started/completed activity per hook. **`once` is ignored** (no removal path).

- [ ] **Step 1: Write the failing test** — `engine.test.ts` (stub executors): dispatch with no matching hooks → `{behavior:'continue'}`; a matching command hook returning exit-2 block → block decision; two command hooks run concurrently (cap enforced — a 13th queues); prompt/agent hooks run serially; activity emitter receives started+completed per hook; sources() re-read each dispatch (mutate source between dispatches → new config used); **a `once:true` hook fires on every dispatch (once inert)**.
- [ ] **Step 2: Run to verify fail** — `npx vitest run server/providers/native/hooks/engine.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `engine.ts` orchestrator per RS §4.9 concurrency + per-event merge (delegate exit-2 target mapping to the calling seam; engine returns the merged decision facts). Activity emission via opts.emit.
- [ ] **Step 4: Run to verify pass** — same command. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(native-hooks): engine orchestrator (collection, concurrency, merge, activity)"`

### Task 7: Config lifecycle (spawn + live apply + re-collection)

**Files:**
- Modify: `server/providers/native/native-provider.ts:255-315`
- Modify: `server/providers/native/native-session.ts` (NativeSessionOptions :264-354, constructor :522, applyFlagSettings :2414-2472)
- Test: `server/providers/native/hooks/config-lifecycle.test.ts`

**Interfaces:**
- Consumes: `HookEngine` (T6), `HookSource` (T1), `toSdkHooksSettings`/`SessionHooksConfig` (shared/hooks.ts), `NativeProvider` fixture (`providerWithStreamer`, native-session.test.ts:288).
- Produces: `NativeSessionOptions` gains `hooks?: SessionHooksConfig`. NativeSession constructs a flag `HookSource` from `opts.hooks`, exposes `dispatchHook` to seams. `applyFlagSettings` allowlist gains `'hooks'`; on apply it replaces the flag source config (per-event re-collection makes it live). native-provider reads `sdkOptions.settings.hooks` and passes `hooks`.

- [ ] **Step 1: Write the failing test** — `config-lifecycle.test.ts` (provider fixture): `createSession({...providerExtras:{sdkOptions:{settings:{hooks:{PreToolUse:[...]}}}}})` → engine sees the config; `coreOf(handle).applyFlagSettings({hooks:{...new}})` resolves (no throw) and the next dispatch uses new config; `applyFlagSettings({hooks:{}})` clears; an unknown key still throws.
- [ ] **Step 2: Run to verify fail** — `npx vitest run server/providers/native/hooks/config-lifecycle.test.ts`. Expected: FAIL (hooks rejected / not read).
- [ ] **Step 3: Implement** the options field, flag source construction, allowlist addition + replace, native-provider read.
- [ ] **Step 4: Run to verify pass** — same command. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(native-hooks): spawn consumption + live applyFlagSettings hooks"`

### Task 8: PreToolUse seam

**Files:**
- Modify: `server/providers/native/loop.ts:47-87` (LoopDeps), `:205-217` (per-call block)
- Modify: `server/providers/native/native-session.ts:1717-1757` (deps literal)
- Test: `server/providers/native/hooks/pretooluse.test.ts`

**Interfaces:**
- Consumes: `HookEngine.dispatch` (T6/T7).
- Produces: `LoopDeps` gains `dispatchHook?: (event: HookEvent, input: Record<string, unknown>, ctx: { signal: AbortSignal; hasContext: boolean }) => Promise<HookDecision>`. The per-call block dispatches PreToolUse BEFORE `requestPermission`; allow/deny short-circuit permission; ask/no-decision enters permission flow; `updatedInput` validated (tool schema + reject `_`-prefixed keys); block → deny with reason; additionalContext collected.

- [ ] **Step 1: Write the failing test** — `pretooluse.test.ts` (provider fixture + a PreToolUse hook): a hook returning `permissionDecision:'deny'` prevents tool execution (tool not run, error result with reason); `allow` short-circuits the permission prompt; **`updatedInput` with `_internal` key → deny, tool not run** [Review Focus 5]; `updatedInput` valid → tool receives mutated input; exit-2 → block.
- [ ] **Step 2: Run to verify fail** — `npx vitest run server/providers/native/hooks/pretooluse.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the LoopDeps dep + wiring in the deps literal + the per-call PreToolUse dispatch before requestPermission, decision folding, updatedInput validation (RS §5 `Man`/`EWe` semantics: reject internal `_` keys).
- [ ] **Step 4: Run to verify pass** — same command. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(native-hooks): PreToolUse seam (pre-permission, updatedInput validation)"`

### Task 9: PostToolUse / PostToolUseFailure seams + MCP isError→throw

**Files:**
- Modify: `server/providers/native/loop.ts:250-260` (success path), `:256-259` (catch path)
- Modify: native MCP tool-result mapping (`server/providers/native/mcp/` — locate the `isError` handling on the call-result path)
- Test: `server/providers/native/hooks/posttooluse.test.ts`

**Interfaces:**
- Consumes: `LoopDeps.dispatchHook` (T8).
- Produces: success path dispatches PostToolUse (additionalContext, updatedToolOutput last-write-wins); catch path dispatches PostToolUseFailure. Routing is by throw-vs-return ONLY (RS §12.1). MCP adapter converts `isError:true` → throw so MCP errors reach Failure via the catch path.

- [ ] **Step 1: Write the failing test** — `posttooluse.test.ts`: a tool returning normally with soft `outcome.isError:true` fires **PostToolUse** (not Failure); a tool that throws fires **PostToolUseFailure**; an MCP tool returning `isError:true` fires **PostToolUseFailure** (via throw); PostToolUse `updatedToolOutput` rewrites the result (two rewrite hooks → last-write-wins); exit-2 stderr fed to model.
- [ ] **Step 2: Run to verify fail** — `npx vitest run server/providers/native/hooks/posttooluse.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the two dispatches on the existing success/catch paths (no `is_error` branch); MCP isError→throw in the MCP result mapping (mirror RS §12.1 `ys`).
- [ ] **Step 4: Run to verify pass** — same command. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(native-hooks): PostToolUse/Failure throw-vs-return routing + MCP isError→throw"`

### Task 10: Stop seam + block cap

**Files:**
- Modify: `server/providers/native/loop.ts:188-192` (zero-tool break), `:294-307` (result emission)
- Test: `server/providers/native/hooks/stop.test.ts`

**Interfaces:**
- Consumes: `LoopDeps.dispatchHook`.
- Produces: at turn end (zero-tool round) dispatch Stop with `stop_hook_active`; exit-2/block → feed stderr to model + force another round (continue conversation), cap **8** blocks then end; `continue:false` overrides exit-2; additionalContext → non-error continuation.

- [ ] **Step 1: Write the failing test** — `stop.test.ts`: a Stop hook returning exit-2 forces continuation (another API round happens) and sets stop_hook_active; after 8 blocks the turn ends (cap); `continue:false` ends the turn despite exit-2; a Stop hook with additionalContext injects context and continues; no Stop hook → normal turn end.
- [ ] **Step 2: Run to verify fail** — `npx vitest run server/providers/native/hooks/stop.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the Stop dispatch at the zero-tool break with a block counter (cap 8, RS §5), continuation loop, continue:false override.
- [ ] **Step 4: Run to verify pass** — same command. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(native-hooks): Stop seam with continuation + block cap 8"`

### Task 11: UserPromptSubmit seam

**Files:**
- Modify: `server/providers/native/native-session.ts:1573` (consumption), `:1659-1669` (durable user/message append)
- Test: `server/providers/native/hooks/userpromptsubmit.test.ts`

**Interfaces:**
- Consumes: `HookEngine.dispatch`.
- Produces: dispatch UserPromptSubmit before the prompt joins history; exit-2 → block processing + erase the prompt from native's log ONLY (host bubble untouched), emit consumption ack + a result so the bubble doesn't hang 'queued'; additionalContext/sessionTitle/suppressOriginalPrompt applied.

- [ ] **Step 1: Write the failing test** — `userpromptsubmit.test.ts`: a UserPromptSubmit exit-2 hook → the prompt is absent from native's log, a result frame is emitted (turn settles), the host-side user message is NOT retracted; additionalContext hook → context joins the turn; suppressOriginalPrompt → original prompt suppressed per RS §3.
- [ ] **Step 2: Run to verify fail** — `npx vitest run server/providers/native/hooks/userpromptsubmit.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the dispatch at prompt consumption; on block, skip the durable append (erase from native log), emit ack + result; apply specific output.
- [ ] **Step 4: Run to verify pass** — same command. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(native-hooks): UserPromptSubmit seam (native-log erase, ack+result)"`

### Task 12: prompt/agent availability + model resolution

**Files:**
- Create: `server/providers/native/hooks/availability.ts`, `server/providers/native/hooks/model.ts`
- Test: `server/providers/native/hooks/availability.test.ts`

**Interfaces:**
- Consumes: `HookType`, `HookEvent`, `ProviderProfile` / config port.
- Produces:
  - `checkAvailability(type: 'prompt' | 'agent', event: HookEvent, hasContext: boolean): { ok: true } | { ok: false; reason: string }` (RS §12.2: agent rejected on PermissionRequest; no-context events SessionStart/SubagentStart → error; non-REPL events PreCompact/PostCompact/StopFailure/SessionEnd → error; Stop/SubagentStop/UserPromptSubmit/tool events with context → ok).
  - `resolveHookModel(opts: { configured?: string; smallFastEnv?: string; sessionModel: string; gateway: boolean }): string` (RS §6: configured ?? smallFastEnv ?? Haiku-class default; agent gateway fallback to sessionModel).

- [ ] **Step 1: Write the failing test** — `availability.test.ts`: `checkAvailability('prompt','SessionStart',false).ok===false` [Review Focus 4]; `checkAvailability('agent','PermissionRequest',true).ok===false`; `checkAvailability('prompt','Stop',true).ok===true`; `checkAvailability('agent','PreToolUse',true).ok===true`; `checkAvailability('prompt','PreCompact',false).ok===false`; model resolution: configured wins; else smallFastEnv; else Haiku default; gateway agent fallback → sessionModel.
- [ ] **Step 2: Run to verify fail** — `npx vitest run server/providers/native/hooks/availability.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `availability.ts` (the gate matrix) + `model.ts` (resolution; the Haiku-class default constant + config field — pick `claude-haiku-5-5` as the default small-fast id, mark as my call).
- [ ] **Step 4: Run to verify pass** — same command. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(native-hooks): prompt/agent availability gates + small-fast model resolution"`

### Task 13: prompt executor

**Files:**
- Create: `server/providers/native/hooks/prompt-executor.ts`
- Test: `server/providers/native/hooks/prompt-executor.test.ts`

**Interfaces:**
- Consumes: `resolveHookModel` (T12), `checkAvailability` (T12), the core stream transport (`streamFor` / credentials port), `parseHookOutput` (T3).
- Produces: `runPromptHook(hook: PromptHookConfig, input: Record<string, unknown>, ctx: HookExecContext & { hasContext: boolean; event: HookEvent; stream: LoopDeps['stream'] }): Promise<HookExecResult>` — single no-tool LLM round, thinking disabled, json_schema `{ok:boolean,reason:string,impossible?:boolean}`, two system variants (Stop/SubagentStop stop-condition vs general), `$ARGUMENTS`→input JSON, anti-injection clause, 30s timeout; `ok:false`→block+reason.

- [ ] **Step 1: Write the failing test** — `prompt-executor.test.ts` (stub stream returning a json_schema verdict): `ok:true` → success no block; `ok:false,reason:'no'` → blocked reason 'no'; Stop event uses the stop-condition system variant (assert prompt text); `$ARGUMENTS` replaced with input JSON; timeout → cancelled; no-context event → non-blocking error (via availability).
- [ ] **Step 2: Run to verify fail** — `npx vitest run server/providers/native/hooks/prompt-executor.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `prompt-executor.ts` per RS §6.1 (system prompts copied from RS §6.1 evidence; single round via ctx.stream with outputFormat json_schema; map verdict to HookExecResult).
- [ ] **Step 4: Run to verify pass** — same command. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(native-hooks): prompt executor (single no-tool LLM verdict round)"`

### Task 14: agent executor

**Files:**
- Create: `server/providers/native/hooks/agent-executor.ts`
- Test: `server/providers/native/hooks/agent-executor.test.ts`

**Interfaces:**
- Consumes: `resolveHookModel`/`checkAvailability` (T12), the nested runner pattern (`subagent.ts` createAgentTool/runTurn :207-236), session tools.
- Produces: `runAgentHook(hook: AgentHookConfig, input, ctx: HookExecContext & { hasContext: boolean; event: HookEvent; tools: ToolDef[]; stream; frameCtx }): Promise<HookExecResult>` — ≤50-round agentic loop with filtered session tools + a verdict tool `{ok:boolean,reason?:string}` (must be called exactly once at end), thinking disabled, dontAsk permission, 60s timeout; verdict via structured output; ok:false→block.

- [ ] **Step 1: Write the failing test** — `agent-executor.test.ts` (stub stream): agent calls verdict tool `{ok:true}` → success; `{ok:false,reason:'no'}` → blocked; >50 rounds → aborted; verdict tool present in the tool list; recursion guard (hook-agent subagent) cancels nested prompt/agent.
- [ ] **Step 2: Run to verify fail** — `npx vitest run server/providers/native/hooks/agent-executor.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `agent-executor.ts` reusing the nested runTurn pattern (emitResult:false), verdict tool definition (RS §6.2 `sTn`), 50-round cap, structured-output verdict retrieval.
- [ ] **Step 4: Run to verify pass** — same command. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(native-hooks): agent executor (agentic verdict loop, reuse nested runner)"`

### Task 15: http executor

**Files:**
- Create: `server/providers/native/hooks/http-executor.ts`
- Test: `server/providers/native/hooks/http-executor.test.ts`

**Interfaces:**
- Consumes: `parseHookOutput`/`applyOnFailure` (T3).
- Produces: `runHttpHook(hook: HttpHookConfig, input, ctx: HookExecContext & { allowedUrls?: string[]; managedEnvVars?: string[] }): Promise<HookExecResult>` — POST input JSON, Content-Type application/json, accept all statuses (ok=2xx), maxRedirects 0, response body parsed as hook output; header `$VAR`/`${VAR}` interpolation restricted to `allowedEnvVars` ∩ `managedEnvVars`; URL gated by `allowedUrls` (undefined=allow all, []=deny all, wildcard `*`); 600s timeout.

- [ ] **Step 1: Write the failing test** — `http-executor.test.ts` (local http server): POST body equals input JSON; 2xx body parsed as decision; non-2xx → error (onFailure:block → blocked); redirect not followed (maxRedirects 0); header `$VAR` interpolated only when in allowedEnvVars; URL not in allowedUrls → refused; `allowedUrls:[]` → all refused.
- [ ] **Step 2: Run to verify fail** — `npx vitest run server/providers/native/hooks/http-executor.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `http-executor.ts` per RS §6.3 (fetch with redirect:'manual', header interpolation, URL gate).
- [ ] **Step 4: Run to verify pass** — same command. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(native-hooks): http executor (POST, env-interpolated headers, URL gate)"`

### Task 16: `if` permission-rule matcher

**Files:**
- Create: `server/providers/native/hooks/if-condition.ts`
- Test: `server/providers/native/hooks/if-condition.test.ts`

**Interfaces:**
- Consumes: tool input shapes.
- Produces: `evaluateIf(ifExpr: string, toolName: string, input: Record<string, unknown>): boolean` — parse `ToolName(ruleContent)` permission-rule syntax (RS §4.2 `Bn`), match tool name (+aliases), evaluate ruleContent with a per-tool matcher (Bash command-prefix at minimum). Non-tool events handled by the engine (skip hook + log) — `evaluateIf` is only called for the five tool events.

- [ ] **Step 1: Write the failing test** — `if-condition.test.ts`: `evaluateIf('Bash(git *)','Bash',{command:'git status'})===true`; `evaluateIf('Bash(git *)','Bash',{command:'rm -rf'})===false`; `evaluateIf('Edit','Edit',{})===true` (bare tool name); `evaluateIf('Bash(git *)','Read',{})===false` (tool mismatch); malformed rule → false + log (never throw).
- [ ] **Step 2: Run to verify fail** — `npx vitest run server/providers/native/hooks/if-condition.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `if-condition.ts`: rule parser + Bash command-prefix matcher (glob `*`); other tools' matchers as needed for the five tool events (builder determines coverage per RS §4.2). Wire engine to skip non-tool-event `if` hooks + log.
- [ ] **Step 4: Run to verify pass** — same command + engine test for non-tool skip. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(native-hooks): if permission-rule matcher (tool-events-only)"`

### Task 17: SessionStart seams (init + post-compact)

**Files:**
- Modify: `server/providers/native/native-session.ts:608-627` (init), post-compact splice (:1994 region)
- Test: `server/providers/native/hooks/sessionstart.test.ts`

**Interfaces:**
- Consumes: `HookEngine.dispatch`.
- Produces: SessionStart dispatch at init with `source` ∈ {startup, resume, fork} (from opts.resume/forkSession), and after the compact splice with `source:'compact'` (ordered after PostCompact, RS §13.2). NOT clear. specific output: additionalContext/initialUserMessage/sessionTitle/watchPaths/reloadSkills.

- [ ] **Step 1: Write the failing test** — `sessionstart.test.ts`: fresh session fires SessionStart source 'startup'; resume → 'resume'; fork → 'fork'; after auto-compact → SessionStart 'compact' fires once after PostCompact; a SessionStart additionalContext hook injects context into the first turn; NO SessionStart 'clear' on /clear-style fresh spawn.
- [ ] **Step 2: Run to verify fail** — `npx vitest run server/providers/native/hooks/sessionstart.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** init dispatch (source mapping) + post-compact dispatch; apply specific output (initialUserMessage seeds the first turn, reloadSkills triggers reload).
- [ ] **Step 4: Run to verify pass** — same command. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(native-hooks): SessionStart seams (startup/resume/fork/compact)"`

### Task 18: SubagentStart / SubagentStop seams

**Files:**
- Modify: `server/providers/native/subagent.ts:192-205` (descriptor), `:249-260` (finalReport); `AgentToolDeps` (:24-74)
- Test: `server/providers/native/hooks/subagent-hooks.test.ts`

**Interfaces:**
- Consumes: `HookEngine.dispatch` (via AgentToolDeps).
- Produces: `AgentToolDeps` gains hook dispatch; SubagentStart fires at descriptor append (agent_id/agent_type, additionalContext routes to subagent); SubagentStop fires at finalReport (exit-2 → subagent continues, additionalContext to subagent).

- [ ] **Step 1: Write the failing test** — `subagent-hooks.test.ts`: launching an Agent fires SubagentStart with agent_type; a SubagentStart additionalContext hook injects into the subagent prompt; SubagentStop fires on completion; SubagentStop exit-2 makes the subagent continue.
- [ ] **Step 2: Run to verify fail** — `npx vitest run server/providers/native/hooks/subagent-hooks.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the two dispatches in createAgentTool's runner + wire dispatch through AgentToolDeps from native-session.
- [ ] **Step 4: Run to verify pass** — same command. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(native-hooks): SubagentStart/SubagentStop seams"`

### Task 19: PreCompact / PostCompact host seams

**Files:**
- Modify: `server/session-manager.ts:6129-6161` (runAutoCompact), manual /compact path
- Modify: `server/providers/types.ts` (ProviderSessionHandle), `server/providers/native-host-frame-adapter.ts` (wrapNativeCore), `server/providers/native/native-session.ts`
- Test: `server/providers/native/hooks/compact-hooks.test.ts`

**Interfaces:**
- Consumes: `HookEngine.dispatch`.
- Produces: optional handle method `dispatchHook?(event: HookEvent, input: Record<string, unknown>): Promise<HookDecision>` (native implements; claude omits — CLI fires its own). Manager calls PreCompact BEFORE `summarizeMergedForCompact` (:6142): exit-0 stdout merged into custom instructions, exit-2 aborts before journal.prepare/summarization. PostCompact after splice; then SessionStart(compact) (T17). Manual /compact same placement.

- [ ] **Step 1: Write the failing test** — `compact-hooks.test.ts`: a PreCompact exit-0 stdout hook shapes the summary (custom instructions reach summarizeMergedForCompact); PreCompact exit-2 aborts compaction BEFORE summarization (summarize not called, journal not prepared); PostCompact fires after splice; order PreCompact→summarize→compactInPlace→PostCompact→SessionStart(compact).
- [ ] **Step 2: Run to verify fail** — `npx vitest run server/providers/native/hooks/compact-hooks.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the optional handle method + adapter wiring + manager pre-summarization dispatch (guard: only when handle.dispatchHook present) + PostCompact dispatch.
- [ ] **Step 4: Run to verify pass** — same command. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(native-hooks): PreCompact/PostCompact host seams (pre-summarization)"`

### Task 20: PermissionRequest / PermissionDenied seams + personOnly floor

**Files:**
- Modify: `server/providers/native/native-session.ts:1031-1052` (requestPermission/decidePermission)
- Test: `server/providers/native/hooks/permission-hooks.test.ts`

**Interfaces:**
- Consumes: `HookEngine.dispatch`, the broker ask/deny flow.
- Produces: PermissionRequest hook dispatch inside the permission flow when an ask is produced; allow honored for non-personOnly asks (NO hooksMayAllow gate, RS §13.1), updatedInput validated; personOnly asks (safety/plan-mode) never hook-allowed; deny may carry interrupt. PermissionDenied hook on deny resolution (retry flag).

- [ ] **Step 1: Write the failing test** — `permission-hooks.test.ts`: a PermissionRequest allow hook auto-allows a normal (non-personOnly) ask without a user prompt; a personOnly ask is NOT hook-allowed (floor); deny hook denies with message; PermissionDenied hook fires on denial with retry flag; agent-type hook on PermissionRequest rejected (T12).
- [ ] **Step 2: Run to verify fail** — `npx vitest run server/providers/native/hooks/permission-hooks.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the dispatch in the permission flow + personOnly floor (identify personOnly asks from the broker decision context) + PermissionDenied dispatch.
- [ ] **Step 4: Run to verify pass** — same command. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(native-hooks): PermissionRequest/Denied seams + personOnly floor"`

### Task 21: StopFailure seam

**Files:**
- Modify: `server/providers/native/native-session.ts:1766-1812` (pump catch)
- Test: `server/providers/native/hooks/stopfailure.test.ts`

**Interfaces:**
- Consumes: `HookEngine.dispatch`.
- Produces: StopFailure dispatch in the pump catch (error result path), fire-and-forget (output + exit code ignored, RS §3). matcher target = error.

- [ ] **Step 1: Write the failing test** — `stopfailure.test.ts`: a turn that errors fires StopFailure with the error; a StopFailure hook's output/exit code does NOT change the error result (fire-and-forget); interrupted turns classify correctly.
- [ ] **Step 2: Run to verify fail** — `npx vitest run server/providers/native/hooks/stopfailure.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the dispatch in the pump catch (await but ignore decision).
- [ ] **Step 4: Run to verify pass** — same command. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(native-hooks): StopFailure seam (fire-and-forget)"`

### Task 22: transcript_path projection

**Files:**
- Create: `server/providers/native/hooks/transcript.ts`
- Modify: `server/providers/native/native-session.ts` (stdin construction uses transcript_path)
- Test: `server/providers/native/hooks/transcript.test.ts`

**Interfaces:**
- Consumes: `projectNativeEventToSdkLine` (host history-read seam), the session's neutral log.
- Produces: `materializeTranscript(session): string` — writes a CLI-shaped JSONL artifact (neutral events → SDK RawLines → JSONL) at a stable per-session path; returns the path used as stdin `transcript_path`. Read-only projection; durable log stays v3.

- [ ] **Step 1: Write the failing test** — `transcript.test.ts`: materializeTranscript produces JSONL lines matching the SDK RawLine shape (user/assistant/tool_result) for a session with a turn; the path is stable across calls; content reflects the current log; agent/prompt hook stdin carries this path.
- [ ] **Step 2: Run to verify fail** — `npx vitest run server/providers/native/hooks/transcript.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `transcript.ts` (project + write JSONL) + wire transcript_path into hook stdin construction. Decide materialization timing (lazy on first dispatch + refresh per turn — my call).
- [ ] **Step 4: Run to verify pass** — same command. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(native-hooks): transcript_path CLI-JSONL projection artifact"`

### Task 23: async / asyncRewake wake delivery

**Files:**
- Create: `server/providers/native/hooks/rewake.ts`
- Modify: `server/providers/native/hooks/engine.ts` (async dispatch), `server/providers/native/native-session.ts` (wake queue → idle injection)
- Test: `server/providers/native/hooks/rewake.test.ts`

**Interfaces:**
- Consumes: `HookEngine`, task-manager notification analogy (task-manager.ts:101-109).
- Produces: `async:true` → background execution, immediate `{async:true,asyncTimeout}` return, action not blocked; command stdout `{async:true}` converts at runtime; `asyncRewake:true` exit-2 → enqueue a wake (summary default "Stop hook feedback", priority next, stopHookActive:true) delivered as a system turn when the session is next idle (NOT direct continuation). Non-rewake async → fire-and-forget.

- [ ] **Step 1: Write the failing test** — `rewake.test.ts`: an async hook returns immediately (action proceeds) and runs in background; an asyncRewake hook exiting 2 enqueues a wake that injects a system turn when idle (model re-invoked with stderr/stdout feedback); a rewake exiting 0 does NOT wake; mid-turn rewake delivery waits for idle (does not corrupt the active turn).
- [ ] **Step 2: Run to verify fail** — `npx vitest run server/providers/native/hooks/rewake.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `rewake.ts` (background scheduling + wake queue) + session idle-injection delivery matching RS §4.4 observable effect.
- [ ] **Step 4: Run to verify pass** — same command. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(native-hooks): async/asyncRewake background execution + idle wake delivery"`

### Task 24: Parity harness, neutrality pins, decision record, review

**Files:**
- Create: `server/providers/native/hooks/parity.test.ts`
- Create: `.agents/notes/implemented/feature/2026-11-26-native-hook-engine.md`
- Test: existing `native/vocabulary/neutrality.test.ts`, `native/host-free.test.ts`

**Interfaces:**
- Consumes: all prior tasks; the claude provider fixture for cross-provider comparison.
- Produces: a parity harness running the SAME hooks config against both providers (machine settings neutralized) and comparing observable decisions/activity for representative cases per event; neutrality pins pass with the new modules; the decision record.

- [ ] **Step 1: Write the parity harness** — `parity.test.ts`: for each layer-1 event, a representative config (command exit-2 block, allow, additionalContext) produces the same observable decision on native and claude (neutralize filesystem settings). Include the Review Focus cases end-to-end.
- [ ] **Step 2: Run the full native suite + neutrality pins** — `npx vitest run server/providers/native/ && npm run typecheck`. Expected: PASS, neutrality/host-free pins green.
- [ ] **Step 3: Write the decision record** — `.agents/notes/implemented/feature/2026-11-26-native-hook-engine.md` (why, alternatives lost — meta.hooks-only vs full-source phasing, what was knowingly deferred to Projects 2-4). Run `npm run verify:agent-notes`.
- [ ] **Step 4: Full self/peer review** — run `code-review` on the full branch diff; verify and fix confirmed findings; re-review non-trivial fixes (repo rule: never commit unreviewed code).
- [ ] **Step 5: Commit** — `git commit -m "test(native-hooks): parity harness + decision record"`

### Task 25 (OPTIONAL — the open layer-2 surfacing call): Hooks-panel no-trigger note

**Contingent:** implements the design's "proposed, open" decision (a passive note listing events with no native trigger). If the user rejects that call, SKIP this task — the fallback is no UI change (layer-2 config accepted-but-never-fires silently). This is an additive affordance, not a change to the activity/rendering path (the "zero client change" goal covers the latter).

**Files:**
- Modify: `src/components/HooksPanel.tsx`
- Test: `src/components/HooksPanel.no-trigger.test.tsx` (happy-dom)

**Interfaces:**
- Consumes: `session.provider`, the layer-2 event list (design "Excluded events").
- Produces: when `session.provider === 'native'`, a passive note listing configured events that have no native trigger (the 14 excluded events); no validation rejection (config stays valid on both providers).

- [ ] **Step 1: Write the failing test** — render HooksPanel for a native session whose config includes a layer-2 event (e.g. FileChanged): the note lists FileChanged as no-trigger; for a claude session the note is absent; a layer-1-only native config shows no note.
- [ ] **Step 2: Run to verify fail** — `npx vitest run src/components/HooksPanel.no-trigger.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the conditional note in HooksPanel (provider-gated, lists configured no-trigger events).
- [ ] **Step 4: Run to verify pass** — same command. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(hooks-panel): native no-trigger event note (layer-2 surfacing)"`
