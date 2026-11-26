# Native provider hook engine — CLI parity (layer 1) — design

Date: 2026-11-26
Status: approved (2026-11-26)

## Problem

The `native` provider (direct Anthropic API, in-process turn engine) has no
hook engine. The session Settings **Hooks** tab is visible on native sessions
but unusable:

- `PUT /sessions/:id/hooks` → `SessionManager.applyHooks` →
  `applyFlagSettingAndPersist({ hooks })` → the native handle's
  `applyFlagSettings`, whose allowlist is `skillOverrides / effortLevel /
  fastMode / agent` (`native-session.ts:2415`). `hooks` is an unknown key →
  throw → wrapped 502 `hooks failed: native provider does not support flag
  settings: hooks`. The setting is never persisted (`mutate` runs after the
  await).
- At spawn the manager forwards `Options.settings.hooks`
  (`session-manager.ts:3371`), but `NativeProvider` reads only
  `sdkOptions.skills` and `settings.autoCompactWindow`
  (`native-provider.ts:255-260`) — hooks are silently dropped.
- The native core has no hook trigger points and never emits `hook-run`
  activity, so the panel's Hook Activity is permanently empty.

The `claude` provider executes user hooks inside the real CLI subprocess.
The goal is a hook engine in the native core so **the same hooks config
behaves identically on both providers**, for the events that have a real
native trigger seam ("layer 1").

## Reference: the behavioral spec

The CLI's **actual** behavior is the spec — not `shared/hooks.ts` comments,
not the embedded simplified help text, not our approximation. It is captured
in `docs/research/2026-11-26-cli-hook-semantics.md` (SDK 0.3.311 / CLI 2.1.311,
source-verified against the CLI binary with reproduction greps; §12 resolves
the first pass's open behavioral questions, §13 resolves the builder-check's
hooksMayAllow / SessionStart-lifecycle / PreCompact-ordering questions). **This
design cites that doc by section; the builder treats it as the authoritative
contract.**

**Parity reference = claude-as-embedded-in-CRW**, which is itself a subset of
the CLI's theoretical behavior. Probe-verified in
`server/providers/claude/inprocess-hooks.ts:140`: SessionEnd and Notification
hooks **do not fire** in CRW's claude SDK stack. "Same config, same behavior"
therefore means native also does not fire them — parity is with what the
claude provider actually does here, not with the full CLI TUI. We do **not**
change the claude provider.

## Program phasing (this doc = Project 1)

"All hook sources parity" is a program of four dependent projects, agreed
2026-11-26. This document is **Project 1**; the others get their own
brainstorm → recon → design → plan → build when reached.

| # | Project | Content | Depends on |
|---|---|---|---|
| **1** | **Hook execution engine + `meta.hooks`** (this doc) | 13 events × 4 types; matcher / if / output contract / asyncRewake; transcript projection; host dispatch seams; activity emission. The collection interface is **multi-source from the start** so later sources plug in without rework. | — |
| 2 | Filesystem-settings source + gates | settings-source resolution (user/project/local/managed), hook merge precedence, `disableAllHooks` / `allowManagedHooksOnly` / `allowedHttpHookUrls` / `httpHookAllowedEnvVars` | 1's collection interface |
| 3 | Plugin-hooks source | read hook declarations from enabled plugins (reuse the mp-store enabled-entry accessor); coordinate with the in-flight native plugin-skill discovery | 1; shared plugin infra |
| 4 | Agent-frontmatter-hooks source | extend the agent-definition format with hooks (none today), collect from agentStore | 1 |

Order 1→2→3→4: engine first, parity expands source by source; each project is
independently deliverable and testable. Project 1 wires ONLY the flag source
(`meta.hooks`); the merge contract (research §7) and gates arrive with Projects
2-4. Grounding for the split: `shared/agent-definitions.ts` has no hooks field;
`server/mp-store.ts` has no hook collection; native `supportsPlugins: false`.

## Goals

- A hook engine in the neutral native core executing user hooks with full
  behavioral parity for the **13 layer-1 events × 4 hook types**
  (command / http / prompt / agent): same config → same observable behavior
  (decisions, blocking, context injection, model continuation, activity) as
  the claude provider.
- Live `applyHooks` takes effect on the **next hook event** (per-event
  re-collection), matching the CLI (§12.3) — not a spawn-frozen snapshot.
- Spawn consumes `meta.hooks`; the setting persists and survives
  resume/fork/respawn (the manager already persists `meta.hooks`).
- Zero client / protocol / pump change: the existing HooksPanel, `hook-run`
  WS frame, and `GET /hooks` activity path work unchanged.
- The engine passes `native/vocabulary/neutrality.test.ts` and
  `native/host-free.test.ts` (no SDK / host-domain value imports in core).

## Non-goals

- **Project 1 collects only the flag source (`meta.hooks`).** Filesystem-settings
  hooks + gates, plugin hooks, and agent-frontmatter hooks are **Projects 2-4**
  (phased follow-ups, see "Program phasing"), not permanent non-goals. The
  collection seam is built multi-source so they plug in without engine rework.
- **Layer-2 events.** The 10 no-mechanism events (Setup, TeammateIdle,
  InstructionsLoaded, CwdChanged, FileChanged, WorktreeCreate, WorktreeRemove,
  Notification, Elicitation, ElicitationResult) and the 4 semantic-mismatch
  events (SessionEnd, ConfigChange, TaskCreated, TaskCompleted) are out. We do
  **not** build a settings-file watcher, team-task system, fs watcher,
  worktree tools, instructions loader, idle-notification mechanism, or MCP
  elicitation to trigger them. See "Excluded events" for the per-event reason.
- **SessionEnd on native destroy.** Native has a `destroy(reason)` seam
  (`native-session.ts:2521`), but parity requires NOT firing SessionEnd there,
  because claude-in-CRW never fires it (research §9.2). Firing it would be a
  deliberate divergence, explicitly rejected.
- **Extending the app's accepted config contract.** The CLI accepts fields the
  app rejects: command `args` (exec form), prompt `continueOnBlock`, the 5th
  type `mcp_tool`, and wire-only `metrics` / `rewakeSummary`. These stay
  rejected by `validateSessionHooksConfig` for BOTH providers (so parity holds
  for the accepted contract). Closing these gaps is a documented follow-up,
  not layer 1.
- **The 6 CLI events outside the app's 27** (PostToolBatch, UserPromptExpansion,
  PreModelSwitch, PostModelSwitch, DirectoryAdded, MessageDisplay).
- **Changing the claude provider** or the SDK in-process steering hooks
  (`inprocess-hooks.ts`) — those are app-internal governance, distinct from
  user settings hooks, and stay as they are.

## Anti-goals (failure even if it technically works)

- Any behavioral divergence between providers for the same layer-1 config —
  that is the entire point.
- Routing soft `is_error` results by the flag instead of by throw-vs-return
  (research §12.1) — would diverge from the CLI.
- Freezing hooks at spawn so live `applyHooks` only writes, never reads (the
  `autoCompactWindow` inert-gap pattern, research §12.3).
- Copying the stale "prompt/agent only on tool events" help text instead of the
  real context/REPL availability gates (research §12.2).
- Host-domain value imports in the native core (neutrality pin violation).
- Silent fallbacks that mask hook errors instead of surfacing them loudly
  (repo ethos: prove root causes, no speculative defensive code).

## Constraints

- **Neutrality.** The engine lives core-side and imports ONLY neutral
  `shared/*` (incl. `shared/hooks.ts`), the native vocabulary, sibling native
  modules, and Node builtins. `child_process` / `fetch` are Node builtins and
  allowed — `tools/bash.ts:106` already spawns a shell in core, the direct
  precedent. Host capabilities arrive through the existing injected ports
  (`NativeHostPorts`), never a host-service value import.
- **Existing seams** (research §9.1, line-verified): `loop.ts` tool dispatch
  (~205-261), `requestPermission` (~217), turn-end result (~188-192 / 294-307);
  `native-session.ts` prompt dispatch (~1573 / 1659), init (~608-627),
  compactInPlace (~1994-2017), pump catch (~1766-1812), applyFlagSettings
  (~2414); `subagent.ts` (~192-260); `permission-broker.ts` (~208-210 / 642-655).
- **Frame contract.** `shared/hooks.ts` `HookRunRecord` / `HookRuntimeEvent`
  are the activity shape; the pump's `hookLifecycleMessage`
  (`session-pump.ts:1024`) parses SDK `system/hook_started|hook_progress|
  hook_response` → `recordHookRun` → `hook-run` WS frame. This path is
  provider-agnostic and stays unchanged.
- **Config contract.** `shared/hooks.ts` `SessionHooksConfig` /
  `validateSessionHooksConfig` / `toSdkHooksSettings` are shared and neutral;
  the engine consumes the validated config, it does not re-validate.

## Scope: layer-1 events and hook types

**13 events** (research §9.1), each with a confirmed native seam:

| Event | Seam | Decision surface (research §3) |
|---|---|---|
| PreToolUse | loop.ts before requestPermission | permissionDecision allow/deny/ask/defer, updatedInput, additionalContext; exit 2 blocks tool |
| PostToolUse | loop.ts success result path | additionalContext, updatedToolOutput (last-write-wins); exit 2 → stderr to model |
| PostToolUseFailure | loop.ts throw catch path | additionalContext; exit 2 → stderr to model |
| UserPromptSubmit | native-session prompt dispatch | additionalContext, sessionTitle, suppressOriginalPrompt; exit 2 blocks + erases prompt |
| Stop | loop.ts zero-tool turn end | additionalContext (non-error continuation); exit 2 / block → force continuation, cap 8 |
| StopFailure | native-session pump catch | fire-and-forget (output + exit code ignored) |
| SessionStart | native-session init + post-compact | additionalContext, initialUserMessage, sessionTitle, watchPaths, reloadSkills; source ∈ {startup, resume, fork, compact} (§13.2) |
| SubagentStart | subagent.ts descriptor → runTurn | additionalContext (to subagent) |
| SubagentStop | subagent.ts finalReport | additionalContext (subagent continuation); exit 2 → subagent continues |
| PreCompact | manager runAutoCompact, BEFORE summarization (§13.3) | exit 2 blocks compaction; exit-0 plain stdout → custom compact instructions |
| PostCompact | native-session post-splice | exit-0 stdout to user |
| PermissionRequest | broker permission flow | allow/deny on non-personOnly asks (personOnly floor, §13.1), updatedInput |
| PermissionDenied | broker deny resolution | retry flag |

**4 hook types** (research §6): command, http, prompt, agent. `mcp_tool` (5th
CLI type) is out (non-goal).

### Excluded events and why (research §9.2 / §9.3)

- **SessionEnd** — claude-in-CRW never fires it; parity = native destroy does
  not fire it either.
- **ConfigChange** — CLI trigger is a settings-FILE watcher; native
  `applyFlagSettings` is SDK flag settings, a different mechanism. No watcher.
- **TaskCreated / TaskCompleted** — CLI events refer to the TEAM-task tools
  (TaskCreate/TaskUpdate, stdin carries task_subject/teammate_name/team_name);
  native's task-manager tracks background TOOL runs, a different concept.
  Mapping them would misreference "background shell finished" as "team task
  completed." No team-task system in native.
- **Notification** — native emits no idle/permission notification, AND
  claude-in-CRW does not fire it either (inert on both sides).
- **Setup / TeammateIdle / InstructionsLoaded / CwdChanged / FileChanged /
  WorktreeCreate / WorktreeRemove / Elicitation / ElicitationResult** — native
  lacks the triggering mechanism entirely (no setup phase, no team, no
  CLAUDE.md/memory loading, fixed cwd, no fs watcher, host-only worktree ops,
  no MCP elicitation handling).

A layer-2 event present in a native session's config is **accepted but never
fires** (no occasion). The UI surfacing of this fact is a small product
decision left open (see "Decisions I made" — proposed: a passive note in the
Hooks panel listing events that have no native trigger, rather than a
validation rejection, so the same config stays valid on both providers).

## Architecture

### 1. Engine placement

A new core-internal module group `server/providers/native/hooks/`, sibling to
`tools/` and `session-log/`. It speaks only the vocabulary + neutral
`shared/hooks.ts` + Node builtins. Responsibilities:

- **Config store + per-event collection**: holds the session's current
  `SessionHooksConfig`; collects the matchers for an event fresh on every
  dispatch (research §12.3 — never a frozen snapshot).
- **Matcher evaluation** (§4.1), **`if` evaluation** (§4.2, new component, see
  §7 below), **timeout / onFailure / output parsing / exit-code contract**
  (§2, §4.5), **concurrency** (§4.9).
- **Per-type executors**: command, http, prompt, agent (§4 below).
- **Decision merge**: per-event exit-2 semantics and JSON precedence (§3 / §5).
- **async / asyncRewake** background execution + wake delivery (§9 below).
- **Activity emission**: neutral `hook/run` operational frames (§6 below).

The engine is invoked from the seams via a small injected interface on
`LoopDeps` / `NativeSession` (e.g. `dispatchHook(event, input): Promise<HookDecision>`),
so the loop and session call one decision point rather than scattering hook
logic. The exact interface shape is left to the builder.

**Framing correction (builder-check):** the *execution engine* is core-internal,
but "zero host change" is false — it is zero **client / protocol / pump** change.
Several layer-1 events are host-driven and need host-side dispatch points that
call into the provider's engine: compaction (`runAutoCompact` owns
summarization, `session-manager.ts:6129`), the user-prompt broadcast/seq-store
(the manager broadcasts before the provider sees the prompt), and the
permission broker. The engine stays neutral; the manager gains thin dispatch
calls at these host-owned moments. This is the real architecture of parity for
these events, not a scope expansion beyond the agreed 13.

### 2. Config lifecycle and the multi-source collection interface

The engine does not consume a single config blob; it collects matchers per
event from an ordered set of **sources**, mirroring the CLI's collection
(research §7: flag → plugins → agent → registered, dedup preferring
flag/policy). Project 1 defines the collection seam and wires ONLY the flag
source; Projects 2-4 add sources behind the same seam:

```
interface HookSource {            // neutral, core-side
  readonly kind: 'flag' | 'settings' | 'plugin' | 'agent'   // 2-4 add the rest
  collect(event: HookEvent): HookMatcherConfig[]            // pre-dedup
}
```

The engine merges the sources' matchers in CLI precedence order and dedups
(the `a2` rule, research §7), then evaluates matcher / `if` per §5. The exact
interface shape and dedup implementation are left to the builder; the
requirement is that adding a source never changes the engine or the seams.
Gates (`disableAllHooks` etc.) are a Project-2 concern; Project 1's flag source
is ungated (parity harness neutralizes machine settings, see below).

- **Spawn**: `NativeProvider` reads `sdkOptions.settings.hooks` (alongside the
  existing `skills` / `autoCompactWindow` reads, `native-provider.ts:255`),
  coerces at the `unknown` boundary, and seeds the flag source.
- **Live**: add `hooks` to the `applyFlagSettings` allowlist
  (`native-session.ts:2415`); on apply, replace the flag source's config.
  Because collection is per-event, the next event uses the new config
  immediately (research §12.3). The manager's `applyHooks` /
  `applyFlagSettingAndPersist` / `mutate(s.hooks)` path then succeeds and
  persists as it does for claude.
- **Resume / fork / clear / respawn**: the engine config is re-seeded from
  `meta.hooks` on every spawn path (the manager already carries `meta.hooks`
  through these). A conversation reset replaces the config like other
  per-session state.

### 3. Event dispatch and ordering

Each seam constructs the event's stdin JSON (`BaseHookInput` common fields +
event-specific fields, research §3 / sdk.d.ts lines), calls the engine, and
applies the returned decision. Load-bearing ordering (research §5):

- **PreToolUse runs BEFORE the permission system.** Its allow/deny short-circuits
  `canUseTool`/`requestPermission`; ask (or no decision) enters the permission
  flow. `updatedInput` is validated against the tool input schema and internal
  `_`-prefixed keys are rejected (research §5). This requires the loop's
  per-call block (`loop.ts:205-217`) to dispatch PreToolUse before
  `requestPermission` and fold the hook decision into the permission request.
- **PermissionRequest hooks run INSIDE the permission flow** and CAN auto-allow.
  The SDK main path (`qMt`) honors a hook allow for any **non-personOnly** ask
  WITHOUT `hooksMayAllow` (research §13.1) — that field is a narrow plugin-ask
  wrapper gate (`Y6`/`dLr`), undefined for normal asks, NOT a global allow
  switch. The real safety boundary is the **personOnly floor**: safety /
  plan-mode asks cannot be hook-allowed. `updatedInput` is validated (internal
  `_` keys rejected); deny may carry `interrupt:true`. The plugin-ask pre-ask
  recheck (`dLr`/`Y6`) belongs to Project 3; Project 1 replicates the main-path
  allow + personOnly floor and omits the plugin-ask branch. Do NOT gate all
  allow on `hooksMayAllow` (would disable auto-allow) nor hardcode it true
  (would breach the personOnly floor).
- **PostToolUse vs PostToolUseFailure route by throw-vs-return, NOT by the
  result `is_error` flag** (research §12.1): a normal return (even with soft
  `outcome.isError`, `loop.ts:255`) → PostToolUse; a thrown error
  (`loop.ts:256-259`) → PostToolUseFailure. **Native's MCP adapter must convert
  MCP `isError:true` into a throw** (mirroring the CLI's `ys` normalizer) so MCP
  errors land in Failure via the throw path. Do not introduce an `is_error`
  branch.
- **Stop**: exit 2 / decision block → feed stderr to the model and CONTINUE the
  conversation (force another round), set `stop_hook_active`, enforce the
  block cap (default 8, research §5). `continue:false` overrides exit 2 on Stop
  (research §2.3). `additionalContext` is the non-error continuation channel.
- **UserPromptSubmit**: exit 2 blocks processing and erases the original prompt
  **from native's own log only** — matching claude, where the CLI erases the
  prompt from its JSONL but the host ring/broadcast keeps the user bubble (the
  manager broadcasts + seq-stores before the provider sees the prompt). Erasing
  host state would need retraction wiring the zero-protocol-change goal forbids,
  so the host bubble stays. The blocked turn still emits a consumption ack + a
  result so the bubble does not hang 'queued'. `suppressOriginalPrompt` /
  `additionalContext` / `sessionTitle` apply per research §3.
- **PreCompact / PostCompact (host-driven — needs a manager seam):** CRW's
  `runAutoCompact` generates the summary (`summarizeMergedForCompact`,
  `session-manager.ts:6142`) BEFORE `compactInPlace` (:6161), after
  `journal.prepare` (:6160). A PreCompact hook at `compactInPlace` entry would
  be too late: its exit-0 plain stdout (custom compact instructions) could no
  longer shape the summary, and an exit-2 block would unwind a prepared journal
  and a spent summarization call. So PreCompact dispatches in the manager's
  compaction path **before summarization** (CLI ordering confirmed in research
  §13 Q-C); exit-0 stdout feeds `summarizeMergedForCompact` as custom
  instructions, exit-2 aborts compaction before any journal/summarization work.
  PostCompact dispatches after the history splice. The manager calls the
  provider's hook dispatch at these points (the host-side dispatch seam noted
  in §1); manual `/compact` follows the same pre-summarization placement. The
  full CLI order (research §13.3): **PreCompact → (exit-2 block / exit-0 stdout
  merged into instructions) → summarize → compactInPlace → PostCompact →
  SessionStart(compact)**.
- **SessionStart lifecycle (research §13.2):** fires on **{startup, resume,
  fork, compact}** in the SDK stack. Native fires it at init (startup / resume /
  fork) AND after the compact splice (source `compact`, ordered after
  PostCompact per `m0o`). **Not `clear`**: CRW's `/clear` is a host-driven fresh
  spawn that never sends `/clear` to the CLI, so it surfaces as `startup` —
  adding a `clear` source would diverge from the claude provider.
- **SubagentStart/Stop**: additionalContext routes to the subagent; SubagentStop
  exit 2 makes the subagent continue.
- **StopFailure**: fire-and-forget.

The per-event exit-2 target (what gets blocked / who sees stderr) follows the
research §3 table exactly.

**`transcript_path` (builder-check Q5):** agent hooks Read the transcript and
prompt hooks receive transcript context, so the stdin `transcript_path` must
point at a **CLI-shaped JSONL artifact**, not native's neutral v3 log (passing
v3 or empty would change hook verdicts vs claude). Native materializes a
projected JSONL via the existing host history-read projection
(`projectNativeEventToSdkLine`, the neutral-event → SDK-RawLine seam) at a
stable per-session path, and exposes that path as `transcript_path`. The
artifact is a read-only projection for hooks; the durable log stays neutral v3.
Materialization timing (lazy on first hook dispatch vs kept current) and the
exact path are left to the builder; the contract is "hooks read CLI-format
transcript content equivalent to what claude's hooks read."

### 4. Hook executors (research §2, §6)

Shared output contract for all types (§2): stdout trimmed starting with `{` →
JSON parsed against the `SyncHookJSONOutput | AsyncHookJSONOutput` union;
otherwise plain text. Invalid JSON / validation failure → degrade to plain
text + reported error, never crash. exit 0 success / **exit 2 block** / other
non-blocking error. JSON block reason overrides stderr; exit 2 overrides
`permissionDecision:"allow"`; `continue:false` overrides exit 2 on Stop.
`onFailure:'block'` rewrites a failure (start failure / timeout / non-0-non-2
exit / invalid JSON) as exit-2-equivalent, for command (non-async) and http
only (§2.4).

- **command** (§4.7 / §4.8): spawn the resolved shell (`bash`/`powershell`,
  platform default; Windows without Git Bash → powershell), stdin = event JSON,
  env = inherited process env + the CLI env surface (`CLAUDECODE`,
  `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PROJECT_DIR`, `CLAUDE_EFFORT`, etc. —
  **NOT** `CLAUDE_TOOL_NAME`/`CLAUDE_TOOL_INPUT`, which do not exist; tool facts
  are stdin-only). Capture stdout/stderr/exit, enforce timeout, parse output.
  Reuse `tools/bash.ts` shell-resolution precedent. (`args` exec-form is a
  non-goal.)
- **http** (§6.3): POST the event JSON to `url`, `Content-Type:
  application/json`, accept all statuses (ok = 2xx), **maxRedirects 0**, parse
  the response body as hook output. Header `$VAR`/`${VAR}` interpolation
  restricted to `allowedEnvVars` ∩ managed `httpHookAllowedEnvVars`; URL gated
  by `allowedHttpHookUrls` (undefined = allow all, [] = deny all, wildcard `*`).
- **prompt** (§6.1): a single no-tool LLM round, thinking disabled,
  `json_schema {ok, reason, impossible?}`, default small-fast model (§8 below),
  30s timeout. Two system-prompt variants (Stop/SubagentStop stop-condition
  with `impossible` tri-state; general ok/reason). `$ARGUMENTS` replaced with
  the hook input JSON; anti-injection clause. `ok:false` → decision block +
  reason. (`continueOnBlock` is a non-goal.)
- **agent** (§6.2): an agentic loop ≤50 rounds with the session tools (filtered)
  + a verdict tool (`{ok, reason?}`, must be called exactly once at the end),
  thinking disabled, dontAsk permission, default small-fast model (gateway
  fallback to session model), 60s timeout. Verdict retrieved via structured
  output. Reuse the native nested subagent runner (`subagent.ts`) rather than a
  second turn engine.

**prompt/agent availability** follows the real gates (research §12.2), NOT the
stale "tool events only" text: supported on Stop / SubagentStop /
UserPromptSubmit / tool events; **agent explicitly rejected on
PermissionRequest**; on no-conversation-context events (SessionStart /
SubagentStart) and non-REPL events (PreCompact / PostCompact / SessionEnd /
StopFailure) they produce a **non-blocking error/failure**, never silent
success. A recursion guard cancels prompt/agent inside the hook evaluator's own
subagent.

**Concurrency** (§4.9): command/http run in parallel (cap 12); prompt/agent run
serially. PostToolUse rewrite hooks run in parallel on the original output,
last-write-wins.

### 5. Cross-cutting mechanics

- **matcher** (§4.1): empty / `*` / `.*` → match-all; a literal-list matcher
  (only `[a-zA-Z0-9_|, -]`) → split on `|`/`,`, trim, exact tool-name-or-alias
  equality; otherwise unanchored case-sensitive `new RegExp(matcher).test`,
  invalid regex → no match + log. Matcher target is per-event (§3 `qZe` map);
  events with no target ignore the matcher.
- **`if`** (§4.2): permission-rule syntax (e.g. `Bash(git *)`), evaluable ONLY
  on the five tool events (PreToolUse/PostToolUse/PostToolUseFailure/
  PermissionRequest/PermissionDenied); a non-tool event with `if` set → skip
  that hook + log. See §7 for the new matcher component.
- **once** (§4.3): inert for settings-shaped hooks (CLI honors it only for
  skill frontmatter). Native accepts and IGNORES `once` for parity — no
  one-shot removal path.
- **timeout** (§4.5): command/http 600s, prompt 30s, agent 60s,
  UserPromptSubmit 30s defaults; per-hook `timeout` override clamped to the
  32-bit setTimeout max; enforced via abort signal; timeout → cancelled result
  (exit-2-equivalent under onFailure:'block').
- **statusMessage** (§4.6): a hook-run display hint only; no CLI stream behavior
  to replicate.
- **async / asyncRewake** (§4.4): `async:true` → run in background, immediately
  return `{async:true, asyncTimeout}`, do not block the action; a command hook
  may also print `{async:true}` to convert at runtime. `asyncRewake:true`
  (implies async) → on exit 2, deliver a wake via the notification queue (§9).
  Non-rewake async hooks are fire-and-forget background tasks.

### 6. Activity emission (zero pump/UI change)

Add a neutral `hook/run` variant to `OperationalFrame`
(`native/vocabulary/live-frame.ts:57`) carrying a `HookRuntimeEvent`
(started/progress/completed + `HookRunRecord`). The core engine emits it
through the existing live emission channel. Add a `hook/run` case to
`projectNativeEventToSdk` (`native-host-frame-adapter.ts:243`) projecting to the
SDK `system/hook_started|hook_progress|hook_response` shape (hook_id /
hook_name / hook_event / outcome / stdout / stderr / output) that the pump's
`hookLifecycleMessage` (`session-pump.ts:1024`) already parses. From there the
existing `recordHookRun` → `hook-run` WS frame → HooksPanel path is unchanged.
The adapter comment at line 41 already anticipates `hook_*` subtypes.

Hook runs are ephemeral activity (like claude's): they ride the live channel
and `session.hookRuns`, not the durable history ring. `GET /hooks` returns
`meta.hooks` + runs as today.

### 7. The `if` permission-rule matcher (new component)

There is **no** permission-rule parser or per-tool `preparePermissionMatcher`
in native or shared today (verified: zero hits). The CLI evaluates `if` with a
rule parser (`Bn(rule)`) + each tool's own permission matcher (e.g. Bash
command-prefix matching). Parity requires a neutral component:

- Parse `ToolName(ruleContent)` permission-rule syntax.
- Match the tool name (and aliases), then evaluate `ruleContent` with a
  per-tool matcher. At minimum Bash command-prefix matching; the builder
  determines which tools' matchers are needed for the five tool events and
  whether to share this with native's permission-rule handling.

This is the one piece with no existing native infrastructure; it is a bounded,
self-contained neutral module. Its exact matcher coverage is left to the
builder, guided by the CLI's per-tool `preparePermissionMatcher` behavior.

### 8. prompt/agent model resolution

The CLI default is `ANTHROPIC_SMALL_FAST_MODEL` else a Haiku-class small-fast
model; agent falls back to the session model on a gateway without the
small-fast env (research §6). `server/config.ts` reads no `process.env`, so
native resolves the small-fast model through config/profile (a config field or
a sensible default constant), with the gateway fallback. The exact resolution
mechanism is left to the builder; the contract is "small-fast default, NOT the
session main model, gateway exception." The prompt/agent LLM round uses the
core's existing transport/credentials (the same port the turn loop streams
through), as a second API consumer with its own timeout/abort.

### 9. asyncRewake wake delivery (new mechanism)

The CLI delivers an asyncRewake exit-2 wake by enqueuing a pending notification
(summary default "Stop hook feedback", priority "next", `stopHookActive:true`)
that wakes the model when idle — NOT direct continuation of the current turn
(research §4.4). Native's task-manager notification (`task-manager.ts:101-109`)
is the nearest analogy but the wake-delivery path (notification queue → idle
system-turn injection) must be built. The builder designs this delivery to
match the CLI's observable effect: an asyncRewake hook exiting 2 causes the
model to be re-invoked with the hook's stderr/stdout as feedback, attributed to
the session, when the session is next idle. `rewakeSummary` (wire field) is a
non-goal input but the default summary behavior is replicated.

## Parity-critical behaviors (baked in from research §12 / §13)

1. **Throw/return routing** (§12.1): PostToolUse on normal return (incl. soft
   `outcome.isError`), PostToolUseFailure on throw; MCP adapter converts
   isError→throw. No `is_error`-flag branch.
2. **prompt/agent availability** (§12.2): context/REPL gates, support
   Stop/SubagentStop/UserPromptSubmit, reject agent on PermissionRequest,
   non-blocking error on no-context/non-REPL events.
3. **Live per-event re-collection** (§12.3): applyHooks effective next event,
   never spawn-frozen.
4. **PermissionRequest personOnly floor** (§13.1): main-path allow for
   non-personOnly asks (no `hooksMayAllow` gate); personOnly asks never
   hook-allowed; plugin-ask `dLr`/`Y6` branch deferred to Project 3.
5. **SessionStart trigger set** (§13.2): {startup, resume, fork, compact};
   compact fires after PostCompact; clear is NOT a trigger (CRW clear = fresh
   spawn = startup).
6. **PreCompact before summarization** (§13.3): exit-0 stdout shapes the summary,
   exit-2 blocks before any summarization/journal work.

## Decisions I made (my calls — override any of these)

- **Parity reference = claude-in-CRW**, 13 events; SessionEnd/Notification inert
  on both. (Confirmed by the user 2026-11-26.)
- **Keep the app's current accepted contract** (27 events × 4 types); CLI field
  gaps (args / continueOnBlock / mcp_tool / metrics / rewakeSummary) are a
  documented follow-up, not layer 1.
- **The 4 conditional events resolve to not-fire / layer-2** under strict
  parity (SessionEnd explicitly not fired on destroy).
- **`once` inert** for settings hooks (parity with CLI).
- **Full-source parity, phased 1→2→3→4** (agreed 2026-11-26): Project 1 = engine
  + flag source (`meta.hooks`); filesystem settings + gates, plugin hooks, agent
  frontmatter hooks are Projects 2-4. The collection seam is multi-source from
  the start.
- **Engine core-internal, host-driven events get host dispatch seams.** The
  execution engine lives in `native/hooks/` (command spawning via Node builtins,
  bash.ts precedent); but compaction, user-prompt broadcast, and the permission
  broker are host-owned moments where the manager calls the provider's hook
  dispatch. "Zero change" is client/protocol/pump only, not host.
- **PreCompact fires before summarization** in the manager's compaction path
  (exit-0 stdout shapes the summary, exit-2 aborts before journal/summarization).
- **`transcript_path` is a projected CLI-JSONL artifact** (via
  `projectNativeEventToSdkLine`), not the neutral v3 log.
- **UserPromptSubmit exit-2 erases native's log only**; the host bubble stays
  (matches claude); the blocked turn emits a consumption ack + result.
- **Emission reuses the existing pump path** via a new `hook/run`
  OperationalFrame + adapter projection; no pump/UI/protocol change.
- **Layer-2 config surfacing (proposed, open):** a passive Hooks-panel note
  listing events with no native trigger, NOT a validation rejection — so the
  same config stays valid on both providers. This is a small UI addition; if
  rejected, the fallback is no UI change (accepted-but-never-fires silently).

## Left to the builder

- Exact module decomposition within `native/hooks/` and the injected
  `dispatchHook` interface shape on LoopDeps/NativeSession.
- The `if` permission-rule matcher's per-tool coverage and whether it shares
  code with native permission-rule handling (§7).
- Small-fast model resolution mechanism (§8).
- asyncRewake wake-delivery mechanics (§9).
- Per-event stdin JSON construction details and decision-merge implementation
  (guided by research §3 / §5).
- Test strategy: unit tests for matcher/if/output-parsing/exit-code/onFailure/
  concurrency; per-event dispatch tests; neutrality pins; a parity test harness
  that runs the same config against both providers and compares observable
  decisions/activity. The repo's probe-verification ethos applies — behavioral
  claims must be evidenced, not assumed.
- Implementation order (suggested below).

## Suggested decomposition (for the plan, not prescriptive)

1. Engine skeleton: config store + per-event collection + matcher + output
   parsing + exit-code/onFailure contract + command executor + `hook/run`
   emission + applyFlagSettings/spawn wiring. Land PreToolUse/PostToolUse/
   PostToolUseFailure (the tool events) first — highest value, clearest seams.
2. Remaining command/http events: UserPromptSubmit, Stop/StopFailure,
   SessionStart, SubagentStart/Stop, Pre/PostCompact, PermissionRequest/
   PermissionDenied. http executor.
3. `if` permission-rule matcher component.
4. prompt/agent executors (LLM round + nested agent runner) + availability
   gates + small-fast model resolution.
5. async/asyncRewake background execution + wake-delivery mechanism.

Each stage is independently testable; parity is verified per event as it lands.

## Known contract gaps (follow-up, out of scope)

- command `args` (exec form, no shell) — research §4.8.
- prompt `continueOnBlock` — research §6.1.
- `mcp_tool` 5th hook type — research §6.4.
- wire-only `metrics` / `rewakeSummary` output fields — research §2.1.
- The 6 CLI events outside the app's 27.
- Layer-2 trigger mechanisms (file watcher, instructions loading, team tasks,
  worktree tools, settings-file watcher, notification, elicitation).