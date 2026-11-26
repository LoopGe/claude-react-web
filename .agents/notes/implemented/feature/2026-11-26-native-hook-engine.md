# Agent Note: Native hook engine — CLI parity for the flag source (Project 1)

Status: implemented

## Problem

The `native` provider (direct Anthropic API, in-process turn engine) had no hook
engine, while the `claude` provider executes user hooks inside the real CLI
subprocess. The session Settings **Hooks** tab was visible on native sessions but
unusable: `PUT /sessions/:id/hooks` reached the native handle's `applyFlagSettings`
allowlist (`skillOverrides / effortLevel / fastMode / agent`), where `hooks` was an
unknown key → throw → wrapped 502, and the setting never persisted. At spawn the
manager forwarded `Options.settings.hooks`, but `NativeProvider` read only `skills`
and `settings.autoCompactWindow` — hooks were silently dropped. The native core had
no hook trigger points and never emitted `hook-run` activity, so the panel's Hook
Activity was permanently empty.

The goal is **the same hooks config behaving identically on both providers** for
the events that have a real native trigger seam. The parity reference is
claude-as-embedded-in-CRW (itself a subset of the CLI's theoretical behavior —
SessionEnd and Notification hooks do not fire in CRW's claude SDK stack), and the
CLI's actual behavior is the contract, source-verified against the pinned binary
(SDK 0.3.311 / CLI 2.1.311) in the
[CLI hook semantics research](../../../../docs/research/2026-11-26-cli-hook-semantics.md)
(cited as RS). The full design is the
[native hook engine design](../../../../docs/superpowers/specs/2026-11-26-native-hook-engine-design.md).

## Decision

A hook execution engine lives core-side in `server/providers/native/hooks/`,
sibling to `tools/` and `session-log/`, executing user hooks with behavioral parity
for the **13 layer-1 events × 4 hook types** (command / http / prompt / agent). It
speaks only the neutral vocabulary + `shared/hooks.ts` + Node builtins, respecting
the [provider seam neutralization](../architecture/2026-11-18-provider-seam-neutralization.md)
boundary: `child_process` / `fetch` are Node builtins (the `tools/bash.ts`
precedent), and host capabilities arrive through injected ports, never a
host-service value import. The engine passes `native/vocabulary/neutrality.test.ts`
and `native/host-free.test.ts`.

### Multi-source collection seam, flag source only wired

The engine collects matchers per event from an ordered set of `HookSource`s
(`flag → settings → plugin → agent`, CLI precedence), re-invoked on **every**
dispatch so a live `applyHooks` takes effect on the next event (RS §12.3) — never a
spawn-frozen snapshot. Project 1 wires ONLY the flag source (`meta.hooks`): spawn
reads `sdkOptions.settings.hooks` (validated at the `unknown` boundary), and
`applyFlagSettings` accepts `hooks` and replaces the flag config. The collection
interface is multi-source from the start so Projects 2-4 (filesystem settings +
gates, plugin hooks, agent-frontmatter hooks) plug in without engine rework. The
merge contract (RS §7) and gates (`disableAllHooks` / `allowManagedHooksOnly` /
`allowedHttpHookUrls` / `httpHookAllowedEnvVars`) arrive with those projects; the
flag source is ungated here.

### Multi-fact HookDecision

The merged decision is a **multi-fact object**, not a single-variant union: a
primary `action` (rank-merge block > deny > allow > ask > defer > continue) PLUS all
simultaneous side facts — `additionalContext` always accumulated, PostToolUse
rewrites last-write-wins, `continue`/`stopReason` (sticky-false: any hook's
`continue:false` wins, never resurrected), `suppressOriginalPrompt` / `sessionTitle`
/ `initialUserMessage` / `watchPaths` / `reloadSkills` / `retry` /
`customInstructions` / `systemMessage` / `suppressOutput` / `updatedPermissions`.
The CLI's `hookSpecificOutput` carries simultaneous facts (a hook can allow AND add
context, rewrite output AND assert classifier context), so a single-variant union
would discard honored facts. The engine validates each hook's
`hookSpecificOutput.hookEventName === event` (the only place holding both event and
raw payload) and gates per-event field applicability; the per-event ACTION
semantics (does exit-2 block this event, deny-vs-erase-vs-continue, rewrite
application) live in the dispatch seams.

### Trigger seams and host dispatch points

The execution engine is core-internal, but "zero change" is client / protocol /
pump only — several layer-1 events are host-driven and need host-side dispatch
points. The loop dispatches PreToolUse BEFORE the permission request (allow/deny
short-circuit `canUseTool`; `updatedInput` validated against the tool schema with
internal `_`-prefixed keys rejected), PostToolUse / PostToolUseFailure by
throw-vs-return (NOT the `is_error` flag; the MCP adapter converts `isError:true`
into a throw), and Stop at the zero-tool turn end (exit-2 forces continuation, cap
8, `stop_hook_active` set). The session dispatches UserPromptSubmit (exit-2 erases
native's OWN log only — the host bubble stays; the blocked turn still emits a
consumption ack + result), SessionStart at init {startup, resume, fork} and after
the compact splice {compact} (NOT clear — CRW clear is a fresh spawn = startup),
StopFailure in the pump catch (fire-and-forget), and PermissionRequest /
PermissionDenied inside the permission flow (main-path allow for non-personOnly
asks, no `hooksMayAllow` gate; the personOnly floor — plan-mode / ExitPlanMode —
skips the hook entirely). The subagent runner dispatches SubagentStart /
SubagentStop with sidechain activity attribution. The MANAGER owns PreCompact
(before summarization, so exit-0 stdout shapes the summary and exit-2 aborts before
any journal/summarization work) and the core's `compactInPlace` owns PostCompact
(after the splice, before SessionStart(compact)). The optional handle
`dispatchHook(event, input)` is the host seam for the compact lifecycle events;
native implements it, claude omits it (the CLI fires its own compact hooks).

### Activity emission and transcript projection

Hook activity emits as a neutral `hook/run` OperationalFrame projected through the
existing adapter → pump `hookLifecycleMessage` → `hook-run` WS frame → HooksPanel
path (zero pump/UI/protocol change). Hook runs are ephemeral activity, never the
durable history ring. `transcript_path` is a **projected CLI-JSONL artifact** (via
the injected `NativeTranscriptPort` over `projectNativeEventToSdkLine`), not the
neutral v3 log — agent hooks Read it and prompt hooks receive transcript context,
so it must be CLI-shaped to match claude's hook verdicts. The durable log stays
neutral v3; the artifact is a read-only projection materialized lazily per dispatch
(skipped entirely on the hook-less path).

### async / asyncRewake

`async:true` runs in background and returns an immediate `{async:true, asyncTimeout}`
merge-no-op ack so the action proceeds; a command may print `{async:true}` to
convert at runtime. `asyncRewake:true` (implies async) on exit-2 enqueues a wake
through the session's idle-injection queue, delivered as a system turn when next
idle (default summary "Stop hook feedback", `stopHookActive:true` on the wake
turn's Stop dispatch) — not direct continuation of the current turn (RS §4.4).

## Alternatives considered

- **Full-source parity in one project vs phased 1→2→3→4.** Rejected the single
  big-bang: filesystem-settings resolution + gates, plugin hooks, and
  agent-frontmatter hooks each depend on separate infrastructure (settings-file
  readers, the mp-store enabled-entry accessor, an agent-definition hooks field
  that does not exist today). Phasing ships the engine + flag source first —
  independently deliverable and testable — with a multi-source collection seam so
  later sources add no engine rework. The cost is a knowing, documented source gap
  until Projects 2-4 land (see below).
- **Single-variant HookDecision union vs multi-fact object.** The first engine
  sketch returned a single-variant union (one action OR one side fact). Rejected
  after the T6 review: the CLI carries simultaneous facts, so a union discards
  honored `additionalContext` alongside an allow, drops a PostToolUse rewrite that
  co-occurs with a decision, and makes `hookEventName` validation impossible
  downstream (the seam no longer holds the raw payload). The multi-fact object plus
  engine-side event validation is the load-bearing correction.
- **Host materializer value-imported into core vs injected transcript port.**
  Core importing the host history-read projection directly would breach the
  host-free pin. Rejected: the materializer takes an injected
  `NativeTranscriptPort` (the neutral event → SDK-RawLine seam), so the core
  materializes a CLI-shaped artifact without a host-domain value import. The
  projection itself stays adapter-side.
- **Firing SessionEnd on native destroy.** Native has a `destroy(reason)` seam, but
  claude-in-CRW never fires SessionEnd. Rejected: firing it would be a deliberate
  divergence from the parity reference; native destroy does not fire it either.
- **Gating all PermissionRequest allow on `hooksMayAllow`.** Rejected: that field
  is a narrow plugin-ask wrapper gate (undefined for normal asks), not a global
  allow switch — gating on it would disable auto-allow, and hardcoding it true
  would breach the personOnly floor. The main-path allow + personOnly floor is the
  faithful replication; the plugin-ask branch is Project 3.

## Consequences

The same flag-source hooks config now behaves identically on both providers for the
13 layer-1 events: the Hooks tab works on native, `applyHooks` persists and takes
effect on the next event, spawn/resume/fork/respawn re-seed the config, and the
HooksPanel shows native hook activity through the unchanged pump path. The
neutrality and host-free structural pins hold with the new modules. The cost is the
phased source gap (flag only) and the knowing parity deviations below — deliberate,
documented, and bounded, not silent divergences.

## Knowing parity deviations

Deliberate gaps accumulated during implementation; each is documented rather than
silently absorbed. Source phasing: **Project 1 = flag source (`meta.hooks`) only**;
filesystem-settings + gates (Project 2), plugin hooks (Project 3), agent-frontmatter
hooks (Project 4) are deferred. Accepted-contract gaps (rejected by
`validateSessionHooksConfig` for BOTH providers, so parity holds for the accepted
contract): command `args`/exec-form, prompt `continueOnBlock`, the `mcp_tool` 5th
type, wire-only `metrics`/`rewakeSummary`.

Behavioral deviations:

- **Manual `/compact` fires PreCompact(manual) but NO PostCompact** — manual compact
  is a clear-with-seed fresh spawn (no splice), so the PostCompact seam never runs;
  `compactInPlace`'s trigger constant is `'auto'`.
- **SubagentStop continuation gives fresh maxTurns per continuation** (up to 8× the
  profile, cap-bounded) vs Stop's single budget; `numTurns` undercounts.
- **acceptEdits/auto sensitive-path fall-through ask** (`.git`/`.claude`/shell
  configs) is hook-allowable — not a confirmed RS personOnly source; the PreToolUse
  seam already short-circuits, and the personOnly floor is plan-mode + ExitPlanMode.
- **additionalContext / Stop feedback / SessionStart seed are live-history-only**
  (not persisted to log/frame) — a replay/resume gap; the CLI persists them.
- **classifierContext** is carried to the `persistToolResult` boundary but dropped
  at tool/result persist — the app has no result-side classifier consumer.
- **Non-Bash `if` content matchers** (Edit path glob, WebFetch domain) under-fire —
  only the Bash full matcher is implemented.
- **http URL-glob is a full-URL glob**, not the CLI's URL-aware Pee (IDN/port/bare
  host); the credential guard is not ported.
- **prompt GWe edges** not replicated: `$N`/`$ARGUMENTS[N]` forms, the aMr length
  budget, value-side U+FFFF/U+FFFE sanitization, the block-tag prompt transform.
- **agent refusal-retry + exact PTr harness-tool exclusions** are out of scope.
- **StopFailure error is hardcoded `'unknown'`** — the `rate_limit` matcher cannot
  fire even for classifiable API errors.
- **Non-rewake async hooks are not registered in NativeTaskManager**; an interrupt
  cancels in-flight async (RS-silent).
- **SubagentStop agent-evaluator Read target uses the main artifact** (which
  contains sidechain lines).
- **Hook rounds**: same-model effort inheritance + unconditional `fastMode:false`
  (the CLI's is conditional); the same-model gate uses raw ids vs the CLI's
  normalized ids.

## Testing

`server/providers/native/hooks/parity.test.ts` is the parity harness. A live
cross-provider comparison (real CLI subprocess vs native) is nondeterministic in a
unit test, so it pins parity in two deterministic layers: **config-channel parity**
(the shared validator accepts the same config; the claude provider delivers the
projected `settings.hooks` to the CLI unchanged through the SDK-stub fixture; native
accepts the same config and the engine observes it; the same invalid config is
rejected with the same errors) and **decision parity** (each layer-1 event's
representative config — command exit-2 block, allow, additionalContext — dispatched
through `NativeSession.dispatchHook`, the single decision point every seam calls,
asserted against the RS-derived CLI expectation). The Review Focus failure modes
(flood truncation, invalid-JSON degrade, invalid-regex matcher, no-context
prompt/agent error, `updatedInput` `_`-key refusal) and asyncRewake wake delivery are
pinned end-to-end. The test header documents the strategy and a manual live
cross-provider procedure. The per-seam suites (`pretooluse` / `posttooluse` / `stop`
/ `userpromptsubmit` / `sessionstart` / `subagent-hooks` / `compact-hooks` /
`permission-hooks` / `stopfailure` / `rewake` / `transcript` and the engine /
matcher / output / availability / executor unit tests) pin each seam's application
semantics; `neutrality.test.ts` and `host-free.test.ts` pin the structural boundary.

## Related

The [in-process hook no-op output](../bug-fix/2026-11-24-hook-noop-output-object.md)
note owns the distinct claude in-process steering-hook contract (`Options.hooks`
callbacks, app-internal governance) — deliberately separate from these user
settings hooks (`Options.settings.hooks`), which the claude provider forwards to the
CLI unchanged and the native engine executes here.
