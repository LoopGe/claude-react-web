# Agent Note: In-process hook no-op output is `{}`, never `undefined`

Status: implemented

## Problem

The server log filled with one ZodError per tool call, tee'd from the CLI
subprocess's stderr by `process-monitor`:

```
[process-monitor] stderr[<sessionId>]: Error in hook callback hook_3: ZodError:
  invalid_union — expected object, received undefined (both branches)
```

Root-cause chain (each link read out of the pinned SDK 0.3.311 source):

1. The app's in-process hooks (`server/providers/claude/inprocess-hooks.ts`)
   returned `undefined` on every no-op path — `defensiveHook` always,
   `stopHook`/`boundaryHook` whenever steering had nothing pending. The
   boundary wrappers even normalized `handleBoundary`'s already-valid `{}`
   into `undefined` via `Object.keys(out).length > 0 ? out : undefined`.
2. The SDK's `handleHookCallbacks` passes the callback's return value
   verbatim into `{ subtype: 'success', response: r }` and `JSON.stringify`s
   it — an `undefined` payload is dropped from the wire entirely.
3. The CLI validates the hook response against
   `SyncHookJSONOutput | AsyncHookJSONOutput` (both object types — the two
   `invalid_union` branches in the log). A missing payload parses as
   `undefined`, fails, and the CLI prints the error to stderr. `hook_3` is
   the PostToolUse steering boundary: the SDK numbers callbacks
   `hook_${nextCallbackId++}` in `Object.entries(hooks)` insertion order
   (Stop, SubagentStop, PreToolUse, PostToolUse, PostToolUseFailure), so the
   error fired after every tool call.

The SDK type says `HookCallback = (…) => Promise<HookJSONOutput>`, but the
wrappers are typed `Promise<unknown>` and the provider casts
`as Options['hooks']`, so typecheck never saw the violation. Functionally
the no-op semantics survived (the CLI applies no decision from a rejected
response) — the defect was contract noise, not a behavior break.

## Decision

Every no-op path returns `{}` — a valid empty `SyncHookJSONOutput` (all
fields optional), which the CLI parses into "no decision, continue":

- `defensiveHook`: abort and normal paths return `{}`.
- `stopHook` / `boundaryHook`: abort returns `{}`; otherwise return
  `handleBoundary`'s output verbatim — it is already `{}` when there is
  nothing to deliver, so the empty-output normalization is deleted rather
  than rewritten.

`inprocess-hooks.test.ts` pins the object contract on every no-op path
(Stop without forward, SubagentStop unusable payload + abort + throwing
handler, steering empty-pending / subagent-filtered / aborted boundaries).

## Alternatives considered

- **Tighten the wrapper return type to `Promise<HookJSONOutput>`.** Rejected
  for this fix: `handleBoundary` returns `Record<string, unknown>`, so the
  type would need another cast at the boundary — moving the escape hatch,
  not removing it. The tests now pin the runtime contract instead.
- **Leave `undefined` and treat the CLI log as benign.** Rejected: one
  multi-line ZodError per tool call buries real stderr diagnostics, which is
  exactly what the `process-monitor` capture exists to surface.

## Consequences

The stderr noise is gone at the cost of nothing functional: `{}` carries no
decision fields, so the CLI's behavior matches the old rejected-`undefined`
outcome minus the log spam. The wrappers still return `Promise<unknown>`
(the provider's `as Options['hooks']` cast stays), so the runtime contract
is pinned by tests rather than the type system — a future no-op path that
returns `undefined` fails `inprocess-hooks.test.ts`, not typecheck. The
steering design spec
(`docs/superpowers/specs/2026-10-14-mid-run-steering-design.md` §5.3)
carries the corrected `{}` contract with a pointer back to this note.