# Agent Note: Native structured output

Status: implemented

## Problem

The native provider (direct Anthropic API, no CLI subprocess) had no
structured output. `NativeProvider` advertised
`supportsStructuredOutput: false` and implemented no `runStructured`, so the
app-level StructuredPanel 501'd against a native default; and `Agent`/`Task`
subagents could return
only a prose report — a caller who needed a schema-constrained value from a
nested run had no way to demand one. The claude provider has the one-shot
path (the SDK's `outputFormat` headless query), so this was a cross-provider
capability gap, not a missing UI.

The full contract lives in the
[native capability fills design](../../../../docs/superpowers/specs/2026-11-26-native-capability-fills-design.md)
(G2); this note records the decisions and what they beat. The mechanism
borrows DSH's `packages/subagent/subagent/src/structured.ts`; the sibling G1
work ([native plan mode](2026-11-26-native-plan-mode.md)) supplies the
read-only permission evidence this feature rides. The
[implementation plan](../../../../docs/superpowers/plans/2026-11-26-native-structured-output.md)
records the task breakdown.

## Decision

Borrow DSH's terminal-tool pattern, simplified to native's tool pipeline: a
`StructuredOutput` terminal tool whose parameter schema IS the caller's
schema, a guidance instruction demanding the run finish by calling it, strict
argument validation with in-turn retry, and a monotonic terminal guard. One
neutral runtime module (`server/providers/native/structured.ts`) serves both
entries; the provider boundary follows the
[provider seam neutralization](../architecture/2026-11-18-provider-seam-neutralization.md)
(the runtime and the one-shot runner stay inside the native core's
neutrality/host-free pins; the broker name-set entry is host-side).

### The terminal runtime

`attachStructuredRuntime(schema)` returns a `StructuredAttachment`: the
`StructuredOutput` `ToolDef` (its `schema` is the caller's schema verbatim),
`captured()` (the committed value, undefined until a valid call lands), and
`isClosed()` (monotonic — the run never reopens). The tool's `run` validates
arguments against the schema; a violation returns `{ text, isError: true }`
naming each violation and demanding a corrected call, so the model retries
within the same turn. A valid call captures the value and closes the run;
every later call — a second capture or any other tool — is rejected without
touching the capture. The attachers wire the other-tool denial through the
loop's `requestPermission` seam (checking `isClosed()` before consulting the
permission policy); the tool itself independently blocks a second capture.

Capture commits on the successful valid call. DSH's two-phase commit (stage
+ authoritative `tools/result`) simplifies away because native's loop has no
transformable tool-result waterfall — there is nothing to stage for.

The finish demand (`STRUCTURED_OUTPUT_GUIDANCE`: a plain-text answer does not
count as the result) travels with the tool and is appended LAST at both
attach sites — after the subagent instruction, after every other prompt
section — because `promptOrder` alone cannot guarantee trailing position once
MCP guidance is connected.

**Naming:** PascalCase `StructuredOutput`, matching this repo's tool
vocabulary (`Read`, `ExitPlanMode`, …). DSH's snake_case is its vocabulary,
not borrowed.

### Bounded validator, two failure classes

The validator is a bounded hand-rolled JSON-schema subset — no ajv direct
dependency. Supported: `type` (object / string / number / integer / boolean /
array / null), `properties`, `required`, `enum` (structural JSON equality, so
object/array members compare by value), single-schema `items`, and boolean
`additionalProperties`; `description`/`title` are skipped as pure
annotations. Two failure classes are deliberately separated:

- **Schema-unsupported** — a construct outside the subset (anyOf, `$ref`,
  `minimum`, `pattern`, tuple-form `items`, schema-form
  `additionalProperties`, …) is a caller/wiring error no corrected arguments
  can ever satisfy. A one-time, value-independent shape scan at attach
  (`assertSupportedSchema`) throws a clear Error naming the construct and its
  path. It recurses through `properties` and `items`, so e.g. tuple `items`
  fails even for an empty array — a value-driven walk would skip it. A root
  declaring `type` must declare `object`: tool arguments are always JSON
  objects, so a non-object root type is a shape-provable unsatisfiable
  `input_schema` (a properties-only root without `type` is accepted). It
  never reaches the model as a retry instruction.
- **Value-nonconforming** — a supported schema with bad arguments returns the
  retryable `isError` result above.

The separation is load-bearing: an unsupported construct is a caller error
no corrected arguments can satisfy — retrying it is a fruitless loop, so it
throws at attach instead of reaching the model. The subset covers the common
schema vocabulary (integer / null fields and boolean `additionalProperties`
included), so an ordinary caller schema validates instead of failing at
attach.

### Entry 1: Agent/Task `outputSchema`

`Agent`/`Task` gains an optional `outputSchema` parameter. When present,
`createAgentTool` attaches the runtime to the nested run: the capture tool
rides AFTER profile allow/deny/MCP/Explore filtering (the run's output
contract is not a profile tool — the subagent must always be able to finish,
whatever tool subset the profile selected), the guidance appends last, and
the nested `requestPermission` checks `isClosed()` before delegating to the
broker. The captured value IS the subagent result the parent continuation
reads, projected as JSON text (`JSON.stringify` — native `ToolOutcome` has no
structured field). A valid capture stands even if the run later hits its turn
cap. No capture is a failed output contract, not a silent text success: the
result is `isError` with the failure reason and the partial report riding
along. Without `outputSchema`, the text-report behavior is unchanged.

### Entry 2: one-shot `NativeProvider.runStructured`

`runStructured(req, signal)` implements the `AgentProvider.runStructured`
seam as a TRANSIENT `runTurn` context (`structured-run.ts`): no
`NativeSession`, no durable log, no live subscribers — model history lives in
a throwaway array and tool results are never persisted. The profile resolves
exactly like `createSession`; the model falls back to the exported native
default. `supportsStructuredOutput` is `true`.

The tool set is lean: the file/shell builtins (Bash, Read, Write, Edit, Grep,
Glob, LS, NotebookEdit) plus the terminal capture. No delegation (Agent/Task
need the session machinery), no MCP, no Skill, no network tools, no
AskUserQuestion (headless has no answerer).

The headless permission policy mirrors the broker's mode gates minus the
prompt: anything that would park for a human answer is denied immediately
(the claude one-shot's `permissionPrompts: 'none'` equivalent).
`bypassPermissions` allows everything; `acceptEdits` auto-allows in-cwd edits
and safe edit Bash (the sensitive-path opt-in stays fail-closed — a headless
run reads no host config); default / dontAsk / auto admit only provably
read-only calls. The read-only Bash and edit-scope classifiers are the SAME
pure helpers the broker uses, so the live and headless gates cannot drift.

Outcomes narrow to `StructuredRunResult` (`shared/structured.ts`) through
`coerceStructuredOutput`: a valid capture wins over a later turn-cap error;
max-turns exhaustion maps to `error_max_turns`; a plain-text finish (no
capture) and execution errors map to `error_during_execution` with the
partial answer attached. The external signal aborts the run (an
already-aborted signal returns without a round). `maxBudgetUsd` is rejected
loudly with 501 — native has no USD cost model (no pricing table, no cost
accumulation), so accepting a budget would silently drop the cap; the same
rule `createSession` applies to sandbox.

### Capture permission: hint AND name set

`StructuredOutput` declares `readOnlyHint: true` (the plan gate's read-only
evidence — the capture records the run's answer, no filesystem mutation, no
network) AND joins the broker's `READONLY_TOOL_NAMES` (the dontAsk gate
consults the name set, not the hint). Both are required, at both attach
sites, for the capture to flow under CI lockdown and plan mode. The name-set
entry is deliberate, NOT a dontAsk `readOnlyHint` exemption: the hint channel
would also admit native WebFetch/WebSearch (`readOnlyHint: true`), which
dontAsk excludes as network ops. The entry is inert for claude — no such tool
exists there (the CLI's structured output rides `outputFormat`, not a tool).

### Provider-only phase boundary (user-decided)

StructuredPanel is unchanged and does NOT route to native this phase.
`SessionManager.runStructured` delegates to `defaultProvider`, still
`'claude'` until the block-3 default flip; the live panel routes to native
only once the default flips. No provider-selection mechanism is added now.
This phase's acceptance is provider-side: tests construct a native-default
manager to drive `runStructured`, rather than driving the live panel.

## Alternatives considered

- **DSH's two-phase commit (stage + authoritative `tools/result`).**
  Rejected: native's loop has no transformable tool-result waterfall, so
  there is nothing to stage for. Capture commits on the successful valid
  call — one seam, not two.
- **A full JSON-schema validator (ajv) as a direct dependency.** Rejected:
  the bounded subset keeps the dependency surface unchanged and the two
  failure classes explicit. Full-schema semantics (and satisfiability
  detection) are beyond the mandate; an unsupported construct fails loudly
  at attach instead of being half-enforced.
- **Unsupported schema constructs as retryable value violations (the
  original cut).** Rejected: a schema the validator cannot handle sent the
  model into a fruitless retry loop — every value rejected, nothing
  correctable. Schema-unsupported is a caller/wiring error and throws at
  attach, value-independently; only value-nonconforming arguments retry.
- **A dontAsk `readOnlyHint` exemption instead of a name-set entry.**
  Rejected: the hint channel would also admit native WebFetch/WebSearch,
  which dontAsk deliberately excludes as network ops. The name set admits
  exactly the capture tool.
- **Routing StructuredPanel to native now (or adding provider selection).**
  Rejected (user-decided): the panel follows the default provider, and the
  default flip is block-3 work. A provider-selection mechanism for one
  panel would be a fourth extension surface; the provider-side capability
  ships now and the panel routes when the default flips.
- **Accepting `maxBudgetUsd` and ignoring it.** Rejected: silently dropping
  a cost cap the caller asked for is worse than refusing it. 501 names the
  gap, the same loud-refusal rule native applies to sandbox.
- **DSH's snake_case tool name.** Rejected: PascalCase is this repo's tool
  vocabulary; borrowing the mechanism does not borrow the naming.

## Consequences

Native gains both structured-output entries with one shared runtime, and
claude is untouched (the broker name-set entry is inert there; the panel
still rides the claude one-shot until the default flips). The terminal guard
makes the output contract monotonic: a captured value cannot be overwritten,
and a run that ends without one fails loudly instead of passing prose off as
a result.

What it costs:

- **`maxBudgetUsd` is a 501 on native.** Block-3 panel routing must omit the
  budget for native (or native gains a cost model first).
- **The one-shot tool set is lean.** No network, delegation, MCP, or Skill
  in a headless structured run — a parity follow-up, not an oversight.
- **Headless `auto` fails closed to read-only.** The auto-mode classifier
  answerer is session-scoped, so a headless run has none. Live auto-mode
  capture rides the AI classifier (`SAFE_AUTO_TOOLS` lacks
  `StructuredOutput`) — a parity follow-up.
- **The headless dontAsk gate admits any `readOnlyHint: true` tool**, while
  the live broker's dontAsk consults the name set. Latent drift if a network
  read tool ever joins the lean set; inert today (the set has none). The
  broker comment and name-set discipline are the guard — a follow-up if the
  set grows.
- **Supported-but-contradictory schemas reject every value retryably.**
  Satisfiability detection is beyond the bounded validator's mandate; the
  attach scan proves shape support, not logical consistency.

## Deferred

- **Live panel routing.** StructuredPanel reaches native only at the block-3
  default flip; the budget omission above is part of that work.
- **`outputSchema` is not recorded in the `subagent/descriptor` event.** An
  interrupted in-flight structured run would not recover its output contract
  on resume — parked with the native subagent resume work.
- **`abortedResult()` bypasses `coerceStructuredOutput`.** The literal it
  returns conforms today; routing it through the coercion is a consistency
  follow-up.

## Testing

`server/providers/native/structured.test.ts` pins the runtime: tool naming
and caller-schema parameters, the read-only declaration, capture / retryable
violation / monotonic guard, the attach-time scan (unsupported constructs
throw, value-independent `items` shape check, root object-typing with a
properties-only root accepted), integer / null / boolean
`additionalProperties` support, annotation skipping, and structural enum
equality. `server/providers/native/e2e-structured.test.ts` drives both
entries through the real manager: the subagent capture lands as the parent
Agent tool_result (and the no-schema text behavior is unchanged), in-turn
retry, post-capture denial, no-capture failure, loud unsupported-schema
error; the one-shot returns the captured value with no durable log, maps
max-turns / no-capture / abort outcomes, lets a valid capture stand over a
later turn cap, advertises the capability, exercises the headless dontAsk /
acceptEdits gates, delegates through a native-default manager, and rejects
`maxBudgetUsd` and unsupported schemas loudly.
`server/permission-broker.test.ts` pins the dontAsk auto-allow and the plan
gate passing the capture with its `readOnlyHint`.
