# Agent Note: Bypass mode never bypasses a dialog (native interactive tools skipped the broker)

Status: implemented

## Problem

`AskUserQuestion` on the native provider never opened a dialog whenever the
session ran in `bypassPermissions`; the call came back as a tool error reading
`AskUserQuestion requires an interactive dialog; bypassPermissions has no
dialog`. The user's expectation — and the shipped contract on the claude path —
is that a question is an interaction, not a permission check, so no permission
mode suppresses it.

Root cause, by ordering. The host permission broker deliberately intercepts
`AskUserQuestion` and `ExitPlanMode` BEFORE its own `bypassPermissions`
auto-allow (`permission-broker.ts` — the interceptors sit at the top of the
callback, the bypass gate is ~200 lines later), so on the claude path bypass
still parks a question card. Native owns its own engine and re-implemented the
bypass decision upstream: `NativeSession.decidePermission` began with
`if (permissionMode === 'bypassPermissions') return { allowed: true, input }`,
AHEAD of the `this.opts.canUseTool` call. Bypass therefore short-circuited the
broker, the call reached the tool's own `run`, and `run` is the deliberate
loud-failure fallback (it refuses to fabricate an answer). `ExitPlanMode`
carried the identical defect — in bypass it ran without the plan-review card,
starting execution on an unapproved plan.

The two halves were authored by different changes, and neither was wrong alone:
the unconditional bypass return predates the tool (`a5752dc8`, the first native
session handle), and `ask-user-question.ts` landed later (`40af454b`, whose
message is literally "askUserQuestion through the permission broker's question
path") — but its test, `routes AskUserQuestion to the tool in bypassPermissions,
where it fails loudly`, pinned the short-circuit as intended behavior. That test
made a bug self-consistent and invisible: it asserted the symptom in place of a
missing requirement — "bypass must still ask the user" — that the claude side
honored and no native test ever stated.

## Decision

One shared contract + one exemption, not per-tool special-casing in native.

- `shared/interactive-tools.ts` declares `BYPASS_IMMUNE_INTERACTIVE_TOOLS`
  (`AskUserQuestion`, `ExitPlanMode`) and `isBypassImmuneInteractiveTool()`.
  It is a neutral module (no imports) on purpose: the native core may not
  value-import `server/permission-broker.ts` (the `host-free.test.ts` pin), so
  the set has to live where both sides can read it.
- Native's bypass return became
  `if (permissionMode === 'bypassPermissions' && !isBypassImmuneInteractiveTool(toolName))`,
  so the exempt tools fall through to the broker exactly as they do on the
  claude path. No broker or client change was needed — the dialog, the answer
  payload, and the `QUESTION_RESULT` marker plumbing already existed.
- `ask-user-question.ts`'s `run` stays a fail-loud fallback and its header
  comment was rewritten: it is now the no-answerer path (a session with no
  `canUseTool` registered), not "the bypass path".
- Drift protection: `permission-broker.test.ts` gained a bypass-mode pin naming
  both tools, plus a test iterating `BYPASS_IMMUNE_INTERACTIVE_TOOLS` and
  asserting the broker parks a pending request for every member — so a tool
  added to the shared set without a matching broker interceptor fails. The
  native side gained bypass tests for both tools.

## Alternatives considered

- Remove `AskUserQuestion` from the native tool list while the mode is bypass
  (the model then never tries to call it): rejected — it makes a capability
  vanish based on a mode that the UI can flip mid-session, so the model's tool
  surface would churn, and it still leaves `ExitPlanMode`'s silent-plan-execution
  bug. Bypass means "don't ask permission for tools", not "don't talk to the
  user".
- Exempt only `AskUserQuestion` and leave `ExitPlanMode` to the bypass
  auto-allow: rejected — the broker already declares both bypass-immune with an
  explicit "this check MUST come before the bypassPermissions early-return"
  comment, and the plan case is the more dangerous one (an unapproved plan
  starts executing).
- Let each provider keep its own copy of the exempt list: rejected — this bug
  is exactly the drift between two hand-maintained copies of one rule. The
  shared set plus the broker-side iteration pin makes drift a test failure.

## Consequences

- A bypass-mode native session now blocks on a question card like a claude one.
  An unattended bypass session (automation, a scheduled send) can stall on a
  pending question instead of erroring past it. Accepted: this matches the
  claude path's shipped behavior, and an interrupt resolves the pending request;
  silently proceeding is the outcome worth paying for here.
- Native's `structured-run` and dream/headless paths are untouched: `structured-run`
  builds its own tool list with no `AskUserQuestion` and resolves permissions in
  a local closure, so nothing there can park a dialog with no answerer.
- CLAUDE.md used to say the `canUseTool` callback is registered "unless
  `permissionMode === 'bypassPermissions'`", which was never true
  (`session-manager.ts` builds the broker for every mode; the bypass decision
  lives inside it). It now states the real rule — the callback is built
  unconditionally and `AskUserQuestion` / `ExitPlanMode` are bypass-immune — so
  the doc and both providers agree. That doc line landed on `main` alongside an
  unrelated commit; this note is its rationale.
