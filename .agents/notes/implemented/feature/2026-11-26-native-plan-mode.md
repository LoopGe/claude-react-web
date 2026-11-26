# Agent Note: Native plan mode

Status: implemented

## Problem

The native provider (direct Anthropic API, no CLI subprocess) had no plan
mode. The permission-mode chip could be set to `plan`, but nothing enforced
it: native registered neither `EnterPlanMode` nor `ExitPlanMode`, appended no
plan guidance, and the broker had no plan-enforcement branch. A native
session whose chip read `plan` could still edit files, run mutating Bash, and
call mutating MCP/first-party tools — the mode was a label, not a contract.

The claude provider does not have this gap: its CLI enforces plan mode
internally before `canUseTool` ever fires. Native has no CLI to delegate to,
so the host must enforce. The requirement is cross-provider consistency — a
native `plan` must mean the same read-only thing as a claude `plan`, including
the CLI-equivalent mid-turn behavior where an approved plan executes in the
SAME turn.

## Decision

A hybrid: borrow DSH's plan-mode *architecture* (entry signal + per-round
guidance + a reviewed exit tool) but keep `plan` a permission-mode enum value
and enforce it hard in the permission broker, which is already the single
host enforcement point. The full contract lives in the
[native capability fills design](../../../../docs/superpowers/specs/2026-11-26-native-capability-fills-design.md)
(G1); this note records the decisions and what they beat. The provider
boundary follows the
[provider seam neutralization](../architecture/2026-11-18-provider-seam-neutralization.md):
the plan tools and guidance are neutral core, the enforcement and mode
ownership are host-side.

### Plan tools and tool-driven entry

`EnterPlanMode` (empty input) is the ENTRY signal, auto-allowed by the
broker's existing branch. It ENGAGES plan mode rather than merely marking the
transcript: the tool body drives `NativeSession.enterPlanMode`, which rides
the host-bound `requestPermissionModeChange` callback so the manager's
`setPermissionMode` updates the LIVE `session.permissionMode` (the broker gate
+ UI chip) and the handle (persistence + guidance) together. The callback is
bound on every spawn path through the spawn funnel AND re-bound on in-place
respawn (`respawnInPlace`), so a recovered session keeps tool-driven entry.
`ExitPlanMode` (`{ plan }`, markdown starting with a `#` heading) reaches the
broker's existing plan-review branch, which raises the plan card; approval
switches the handle to `planTargetMode`. Both tools ride the main AND the
nested (subagent) tool surfaces. The plan guidance section is appended to the
API system prompt PER ROUND from the LIVE mode, so a mid-turn entry adds it
and a mid-turn approval removes it.

### Hard enforcement: comprehensive read-only, fail-closed

The broker plan gate denies any tool NOT provably read-only. Read-only
evidence is the union of: `PLAN_READONLY_TOOL_NAMES` (the built-in read set
plus `WebFetch`/`WebSearch` — network reads are exploration, which is what
plan mode is for, unlike `dontAsk` which excludes them); Bash proven by
`isReadOnlyBash` (reused fail-closed — anything unprovable denies); the
registry-declared read-only first-party FQNs (`firstPartyReadOnlyTools()`);
and the provider-declared `ctx.readOnlyHint`. Everything else — edit-family
tools, mutating Bash, mutating MCP/first-party tools
(`mcp__git-tools__git_commit`, `mcp__skills-tools__create`,
`mcp__marketplace-tools__remove`, …), and any unknown tool — denies with the
plan message and `interrupt: false`, so the model sees the denial and
re-plans. The gate sits AFTER the `AskUserQuestion`/`EnterPlanMode`/
`ExitPlanMode` interceptors and BEFORE the `acceptEdits`/`bypassPermissions`
auto-allow paths, so no auto-allow can skip it, and reads the LIVE
`session.permissionMode` (not the per-call turn snapshot) so a mid-turn
transition binds the very next call.

### `readOnlyHint` threading seam

The SDK's `canUseTool` options do not surface a tool's `readOnlyHint`
annotation, so the host cannot read MCP read-only metadata from the call
itself. Native owns its tool definitions, so the loop threads the metadata
through the existing permission seam: `runTurn` resolves the `ToolDef` for
each call and passes `tool.readOnlyHint === true` as a new optional argument
to `LoopDeps.requestPermission`; `NativeSession.requestPermission` /
`decidePermission` forward it into the `canUseTool` ctx as `readOnlyHint`
(only present when proven true). MCP tools get the hint from `mcpToolDefs`
(the server's declared `annotations.readOnlyHint`); the nested subagent loop
forwards it through `AgentToolDeps.requestPermission` too. Absence is always
"not proven" — the gate fails closed.

### Claude scoping via `cliSidePlanSteering`

The gate fires ONLY for providers WITHOUT the `cliSidePlanSteering`
capability. The manager injects `(provider) => capsOf(provider).cliSidePlanSteering`
into the broker constructor (a narrow resolver, mirroring the aux-target
resolver, so the broker stays provider-agnostic). For claude
(`cliSidePlanSteering: true`) the gate never fires: the CLI has already
classified and allowed the calls that reach `canUseTool`, and re-classifying
them host-side would hard-deny tools the CLI proved read-only — e.g. a quoted
`grep "x" f` that the CLI allows but `isReadOnlyBash`'s metachar gate rejects.
For native (`false`) the gate enforces.

### Mid-turn transitions: plan-bounded snapshot refresh (the second seam)

Native captures `turnPermissionMode` once at turn start (a deliberate
invariant) and passes that snapshot to every broker call. To match the
CLI-equivalent semantics where an approved plan executes in the SAME turn,
the refresh seam is plan-bounded: the plan gate reads the LIVE mode, and
`setPermissionMode` refreshes the active-turn holder (`activeTurnMode`) in
place on a plan transition, so the `acceptEdits` auto-allow engages for the
rest of the live turn after an `ExitPlanMode` approval. Only plan transitions
refresh the holder; the general persona-field turn-start snapshot invariant
stays for non-plan fields.

### Mode validation at the host seam

`requestPermissionModeChange` accepts any string (the neutral core owns no
permission-mode vocabulary). Both manager binding sites validate the value
with `isUserSelectablePermissionMode` and throw loudly on anything outside the
`PermissionMode` enum, rather than casting an unvalidated string into the mode
setter.

### Plan card: zero change

`PlanCard`'s `input.plan` rendering, pending/approved/rejected lifecycle, and
"exited plan mode and started executing" status wording all stay true under
hard semantics. Native implements no approval-time permission-rule proposals,
so the card's `allowedPrompts` row hides gracefully (its `Array.isArray`
guard), and the CLI-disk-plan fallback is a dead branch for native because the
plan arrives in the tool input.

## Alternatives considered

- **DSH soft plan guidance (every tool remains callable).** Rejected: it
  diverges from claude's hard semantics, and cross-provider consistency
  matters more than DSH's softness. The broker is already the single
  enforcement point, so hard enforcement is the cheaper, consistent choice.
- **A separate DSH-style orthogonal `plan/mode` event.** Rejected: plan is a
  permission-mode enum value here, so it rides native's existing
  permission-mode persistence (`basePermissionMode` + live `permissionMode` +
  persona profile) and resume path instead of a second durable event.
- **Deny-only-edit-tools gate (the first cut).** Rejected: it denied
  edit-family tools and mutating Bash but let mutating MCP/first-party tools
  fall through to a normal permission PROMPT — a user who approved got a
  mutation while the chip said plan. Comprehensive read-only enforcement
  (deny anything not provably read-only) closes that hole.
- **A provider-agnostic gate.** Rejected: it re-classifies claude's
  CLI-allowed calls and hard-denies tools the CLI proved read-only (the quoted
  `grep` case) — a cross-provider regression. Scoping by `cliSidePlanSteering`
  keeps claude untouched.
- **A session-level name→readOnlyHint map looked up at permission time.**
  Rejected: it goes stale against nested/profile-filtered tool sets and
  late MCP discovery. The loop seam carries the EXACT `ToolDef` resolved for
  the call, so there is no parallel map to keep in sync.

## Consequences

Native plan mode is read-only enforced end to end: a mutating MCP/first-party
tool is denied, never prompted, and the model re-plans. Claude plan mode is
untouched (the gate stands down for `cliSidePlanSteering` providers). The
plan-bounded snapshot refresh gives CLI-equivalent same-turn approve→execute.

What it costs: native plan mode denies subagent dispatch outright — `Agent`/
`Task` are not provably read-only, so they fail closed. This diverges from
claude, which permits read-only subagent types (e.g. Explore) in plan mode;
the fail-closed direction is accepted for native rather than inspecting
`subagent_type`. The `readOnlyHint` evidence trusts the MCP server's own
declaration (the same trust model the CLI uses for annotations); a server
that mislabels a mutating tool read-only is outside this gate's threat model.

## Deferred

- **Nested subagent snapshot refresh.** Enforcement holds for nested calls
  via the LIVE-mode gate; the gap is auto-allow parity only. A subagent
  started while plan was live keeps its `plan` ctx snapshot after a mid-turn
  approval, so the `acceptEdits` auto-allow does not engage for the rest of
  that nested run (it prompts instead of auto-allowing). Parked.
- **`decide` opLock-contention window.** A pre-existing, narrow soft-failure
  window around the plan-approval mode switch under op-lock contention.
  Parked.

## Testing

`server/permission-broker.test.ts`'s plan-mode suite pins comprehensive
enforcement (mutating first-party/MCP/builtin deny; read-only built-ins,
read-only Bash, read-only first-party FQNs, and `readOnlyHint`-declared tools
pass), fail-closed unknown-tool denial, and the `cliSidePlanSteering` scoping
contrast (the same quoted grep prompts for a CLI-steering provider and denies
for a host-enforced one). `server/providers/native/native-session.test.ts`
pins the `readOnlyHint` threading through real MCP discovery
(`mixedReadOnlyServer`: true/false/absent). `server/providers/native/e2e-plan-mode.test.ts`
drives the capstone flows through the real broker and manager: same-turn
approve→execute, mid-turn model entry denying a following Edit, mode-chip
entry, guidance per round, persistence across sleep/resume, and respawn
re-binding.
