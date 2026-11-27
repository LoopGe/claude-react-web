# Native capability fills (plan mode, structured output, slash surface) — design

Date: 2026-11-26
Status: proposed

## Problem

The native provider is becoming the default provider; the Claude CLI becomes an
optional install in a later phase. For native to be a credible default, three
capability gaps must close. This document covers those three fills (the "block 2"
capability work agreed in brainstorming). The unified gating projection and the
default flip itself (blocks 1/3), and the CLI-optional packaging mechanism, are
separate phases and out of scope here.

Verified against the current working tree (2026-11-26), not the older research
snapshot:

1. **Plan mode is absent.** Native has no `EnterPlanMode`/`ExitPlanMode` tools
   (`server/providers/native/tools/` has neither), so the broker's plan-review
   interception (`server/permission-broker.ts:319`) never fires and the
   `PlanCard` never appears. The permission-mode chip can still be set to `plan`,
   but nothing enforces it — a silent no-op.
2. **Structured output is absent.** `NativeProvider` has no `runStructured`
   (`supportsStructuredOutput: false`), so the app-level `StructuredPanel` 501s
   on native. The `Agent`/`Task` tool (`server/providers/native/subagent.ts:94`)
   has no `outputSchema` parameter.
3. **The builtin slash surface is absent.** `supportedCommands`
   (`native-session.ts:2325`) returns skill rows only; there are no builtin
   command rows and no host-side discovery of `.claude/commands/*.md`. Typing
   `/compact`, `/init`, or a custom command name passes through to the model as
   plain text.

`$ARGUMENTS` substitution is **already implemented**
(`server/providers/native/skill-render.ts:83`, `substituteSkillArguments`) under
the A batch of `2026-11-25-native-skill-cli-parity-design.md`. It is NOT part of
this work.

DSH (`D:\codes\deepseek-harness`) is a selective architectural reference: borrow
its design where it is better, not strict parity. Plan mode borrows
`packages/plan/plan-mode`; structured output borrows
`packages/subagent/subagent/src/structured.ts`.

## Goals

- **G1 — Plan mode in native with CLI-equivalent hard semantics.** While plan
  mode is active, mutating tools are denied; the model explores read-only and
  exits through a reviewed `ExitPlanMode` plan card. The existing `PlanCard` and
  permission dialog are reused with **zero UI change**.
- **G2 — Structured output in native.** A schema-constrained terminal-tool
  mechanism (DSH pattern) usable both by the app-level `StructuredPanel`
  (one-shot run) and by the `Agent`/`Task` tool (`outputSchema` on a subagent).
- **G3 — Builtin slash surface in native.** `/compact` triggers native
  compaction; `/init` and `/review` work as builtin prompt commands; custom
  `.claude/commands/*.md` are discovered and expanded host-side.

## Non-goals and anti-goals

- **Not the locked features.** Hooks, auto-memory, sandbox, plugins, account/plan
  windows, refusal-fallback dialog, and worktree model tools stay locked/deferred
  (separate decisions). This work does not gate their UI — that is the gating
  projection phase (block 1).
- **Not the CLI-optional packaging mechanism** (later phase) and **not the
  default flip / auth-aware selection** (block 3).
- **Not the skill-parity A/B/C batches.** Skill discovery, the `:` name grammar,
  listing budget (A), plugin-skill discovery (B, active parallel work in
  `server/plugin-skills.ts`), and forked execution / `allowed-tools` / model
  overrides / prose mention / visible expansion marker (C) are owned by
  `2026-11-25-native-skill-cli-parity-design.md` and
  `2026-11-25-native-plugin-skill-discovery-design.md`. G3 here is the **builtin
  command + custom command** surface, which is distinct from skills.
- **Not named `$arg` / `${CLAUDE_*}` templating** (already deferred by A batch).
- **Anti-goal: divergent plan semantics across providers.** A native `plan` mode
  that is soft while claude's is hard would make the same mode chip mean different
  things. G1 matches claude's hard semantics.
- **Anti-goal: a fourth extension framework.** Structured output and plan tools
  are native builtins, not a new plugin system.
- **Anti-goal: removing shipped UI.** `StructuredPanel` stays; native gains a
  `runStructured` backend rather than the panel being retired.
- **Anti-goal: changing the claude provider.** The SDK 0.3.311 / CLI 2.1.311
  probe-verified contract is untouched; all changes are native-side plus the
  shared broker plan-enforcement branch (which claude never reaches because the
  CLI enforces plan mode before `canUseTool`).

## Constraints

- **Host stays SDK-shaped; native core stays neutral.** New tools and frames live
  in the neutral vocabulary; the host adapter projects them. The neutrality pins
  (`native/vocabulary/neutrality.test.ts`, `native/host-free.test.ts`) must hold.
- **PascalCase tool names.** `ExitPlanMode`, `EnterPlanMode`, `StructuredOutput`
  — matching every existing native tool (`Read`, `Edit`, `AttachmentRead`,
  `TaskOutput`, …) and the app's name-keyed machinery (`PLAN_TOOL_NAMES`,
  `MUTATING_TOOL_NAMES`, tool-views, broker). DSH's snake_case is its vocabulary,
  not borrowed.
- **The broker is the single enforcement point.** Plan-mode hard enforcement is a
  broker branch, not scattered tool-level guards.
- **Plan stays a permission-mode enum value**, not an orthogonal layer. The mode
  chip, `SessionInfo.permissionMode`, and the manager's `planTargetMode`
  post-approval plumbing (`session-manager.ts:6640`, `cliSidePlanSteering: false`
  path) are reused unchanged.
- **Shared dirty worktree.** A parallel session is editing `server/plugin-skills.ts`
  and native skill files. Implementation must isolate (worktree) and avoid the
  skill-parity files; this work touches plan tools, structured output, the broker
  plan branch, and builtin/custom command handling.

## Decided approach

### G1 — Plan mode (hybrid: DSH architecture + broker hard enforcement)

Borrow DSH's plan-mode *architecture* (entry signal + guidance section + reviewed
exit tool), but keep plan a mode enum value and enforce hard in the broker. DSH's
own plan mode is soft guidance ("every tool remains callable"); this design
deliberately diverges to match claude's hard semantics, because the broker is
already the single enforcement point and cross-provider consistency matters more
than DSH's softness. (User-decided.)

- **Tools.**
  - `EnterPlanMode`: empty input, the plan-mode ENTRY signal. Auto-allowed by the
    existing broker branch (`permission-broker.ts:307`); renders the existing
    `EnterPlanModeMarker`. **It ENGAGES plan mode, not merely a marker** — under
    claude the CLI flips the mode internally on this call, so CLI-equivalence
    requires native to do the same (otherwise model-driven entry is a silent
    no-op, the exact defect G1 closes). The switch is owned by the native session
    (the tool body drives a session mode setter that rides `updateAgentBase`
    persistence and broadcasts the chip update, like a mode-chip switch). The
    user can also enter via the mode chip. (Ownership mechanism: my call.)
  - `ExitPlanMode`: `{ plan: string }`. The plan must be markdown starting with a
    `#` heading (DSH's validation). The tool call reaches the broker, whose
    existing `ExitPlanMode` branch (`permission-broker.ts:319`) raises the plan
    review card. On approval the manager switches the native handle's mode to
    `planTargetMode` (the existing `cliSidePlanSteering: false` path).
- **Mid-turn transitions (required by the decided CLI-equivalent semantics).**
  Native captures `turnPermissionMode` once at turn start
  (`native-session.ts:1608`, a deliberate invariant) and passes that snapshot to
  every broker call (`permission-broker.ts:248` reads `ctx.permissionMode`). Under
  claude, an approved plan executes in the SAME turn (the CLI releases its plan
  lock mid-turn). To match, native plan-mode transitions must take effect inside
  the live turn: after `ExitPlanMode` approval the next tool must see the new
  mode, not the `'plan'` snapshot, and the guidance section must stop saying "do
  not execute". This needs a deliberate, plan-scoped relaxation of the turn-start
  snapshot — the plan-enforcement branch reads the LIVE mode (or the snapshot is
  refreshed on a plan transition), and the plan guidance is rebuilt/removed
  mid-turn. The general persona-field snapshot invariant stays for non-plan
  fields. (Refresh seam: my call; the mid-turn effectiveness itself is required by
  the user's CLI-equivalent decision, not optional.)
- **Guidance.** A prompt section active when `permissionMode === 'plan'`
  (DSH `plan:policy` style): explore and design, present the plan through
  `ExitPlanMode`, do not execute. Rebuilt per request like native's other prompt
  sections.
- **Hard enforcement.** A new broker branch: `mode === 'plan'` → deny mutating
  tools with a "plan mode is active" message (the model re-plans). The
  mutating-tool set reuses the broker's existing edit-tool detection
  (`isInScopeEditTool` / the `acceptEdits` fast-path classification) plus mutating
  Bash; read-only tools pass. Placed before the `acceptEdits`/bypass paths so plan
  review and read-only enforcement are never skipped. Claude never reaches this
  branch (the CLI enforces plan mode internally before `canUseTool`).
- **State persistence (my call).** Plan rides native's existing permission-mode
  persistence (`basePermissionMode` + live `permissionMode` + persona profile,
  `native-session.ts:528/534/664`), not a separate DSH-style orthogonal `plan/mode`
  event — because plan is a mode value here. The builder verifies the resume path
  restores an active plan mode and its guidance.
- **`allowedPrompts` (user-decided absent).** Native does not implement the SDK's
  approval-time permission-rule proposals; the `PlanCard` `allowedPrompts` row
  hides gracefully (`Array.isArray` guard). The card's CLI-disk-plan fallback
  (`usePlanContent`) is a dead branch for native because the plan arrives in the
  tool input.
- **Plan card: zero change** (verified `src/components/tool-views/PlanCard.tsx`).
  `input.plan` rendering, pending/approved/rejected lifecycle, and the
  "exited plan mode and started executing" status wording all stay true under
  hard semantics.

### G2 — Structured output (DSH terminal-tool pattern)

Borrow `packages/subagent/subagent/src/structured.ts`: a schema-constrained
terminal tool the run must call to finish, with validation-retry and a terminal
guard. (User-decided mechanism + naming + entry points.)

- **Tool.** `StructuredOutput` (PascalCase). Its parameter schema IS the caller's
  `outputSchema`. A trailing guidance instruction demands the run finish by
  calling it (plain text does not count). Arguments are validated against the
  schema; a violation returns an error result so the model retries within the
  turn (DSH `ToolArgsError` semantics). After a successful capture, a terminal
  guard denies further tool calls (the run is complete). DSH's two-phase commit
  (stage + authoritative `tools/result`) simplifies to native's tool pipeline:
  capture commits on the successful tool result (builder settles the exact seam).
- **Subagent entry.** `Agent`/`Task` gains an optional `outputSchema` parameter
  (`subagent.ts:101` schema + `AgentToolInput`). When present, `createAgentTool`
  attaches the `StructuredOutput` tool to `nestedTools`, the guidance to
  `nestedSystem`, and the terminal guard; the captured value is returned as the
  subagent result to the parent (projected into the parent continuation).
- **App-level entry (provider-only this phase — user-decided).**
  `NativeProvider.runStructured(req, signal)` implements the
  `AgentProvider.runStructured` seam (`providers/types.ts:434`) as a one-shot
  native run riding the same terminal mechanism, returning the
  `StructuredRunResult` shape (`shared/structured.ts`).
  `supportsStructuredOutput` flips to `true`. **`StructuredPanel` is unchanged and
  does NOT route to native this phase**: `SessionManager.runStructured` delegates
  to `defaultProvider` (`session-manager.ts:7422`), still `'claude'` until the
  block-3 flip (out of scope). The live panel routes to native only once the
  default flips. This phase's acceptance is provider-side: tests construct a
  native-default manager (as `session-manager.test.ts` already does) to drive
  `runStructured`, rather than driving the live panel. No provider-selection
  mechanism is added now.
- **Schema source.** The caller's schema is trusted input (the panel validates
  JSON; the Agent tool receives model-emitted schema). The builder settles
  validation/assertion of the schema subset (DSH `assertObjectJsonSchema`).

### G3 — Builtin slash surface + custom commands

Distinct from the skill-parity batches (skills are `.claude/skills/*/SKILL.md`;
this is builtin commands + `.claude/commands/*.md`).

- **`/compact` in native (my call on mechanism).** Trigger native in-place
  compaction through the manager's existing host-driven path
  (`compactInPlace`, `native-session.ts:1990`; the manager owns the client-facing
  divider/reset). Recommended direction: a native builtin-command interception
  that signals the manager's compaction flow, rather than passing `/compact` to
  the model as text. The builder settles the exact wiring (native-side
  interception vs a provider-aware client local command); `/handoff`
  (`src/local-commands.ts`) is the existing app-side compaction precedent.
- **`/init` and `/review`.** Builtin prompt commands (host-side prompt templates)
  surfaced as `builtin: true` rows in `supportedCommands` and expanded host-side.
  The builder settles the template source (bundled vs generated).
- **Custom `.claude/commands/*.md`.** Host-side discovery (project
  `<cwd>/.claude/commands` + user `claudeConfigDir()/commands`), markdown +
  frontmatter, surfaced as command rows and expanded host-side reusing the
  existing `substituteSkillArguments` for `$ARGUMENTS`. The builder settles the
  frontmatter schema, dedupe with skills/builtins, and the expansion event model
  (reuse the skill dual-event pattern where it fits).
- **CLI-ecosystem commands** (`/login`, `/logout`, `/upgrade`, `/doctor`, …) stay
  absent on native (locked; they appear only with the CLI in the later phase).
- **UI-equivalent builtins** (`/model`, `/usage`, `/config`, …) are optional
  local-command deep-links into existing UI; deferred / optional, not required
  for G3.

## Left to builder

- **G1:** the exact mutating-tool set for the plan branch (reuse broker edit
  detection); the mid-turn refresh seam (live-mode read for the plan branch +
  guidance rebuild on a plan transition, relaxing the turn snapshot only for
  plan); the `EnterPlanMode` mode-switch ownership wiring (session setter +
  persistence + chip broadcast); verify resume restores active plan mode +
  guidance; pin the `ExitPlanMode` `#`-heading validation and the broker plan-card
  path end-to-end, including approve→execute in the SAME turn; regression-pin that
  `PlanCard` is unchanged.
- **G2:** the capture-commit seam in native's tool pipeline; the structured
  result projection into the parent continuation; schema-subset assertion; the
  one-shot `runStructured` run construction (maxTurns/budget/permissionMode per
  `StructuredRunRequest`); flip `supportsStructuredOutput` and update its pins.
- **G3:** the `/compact` interception wiring; `/init`/`/review` template source;
  custom-command discovery roots, frontmatter schema, dedupe, and expansion event
  model; `supportedCommands` builtin rows + `commands-changed` broadcast on
  discovery changes.
- **All:** keep neutrality/host-free pins green; add unit + e2e tests per feature;
  isolate implementation in a worktree away from the parallel skill-parity files.