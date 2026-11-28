# Agent Note: The remaining hook events with a native seam

Status: implemented

## Problem

The first hook-engine pass wired the thirteen layer-1 events (RS §3). The CLI's
event table carries fourteen more, and for six of them native DOES have a real
trigger — it just never dispatched:

- `Notification` — the CLI fires `permission_prompt` right before a tool
  permission dialog reaches the user.
- `InstructionsLoaded` — fired as the CLAUDE.md chain is (re)loaded: first sight
  is `session_start`, and a post-compaction reload is `compact`.
- `TaskCreated` / `TaskCompleted` — fired from INSIDE the `TaskCreate` /
  `TaskUpdate` tool implementations, not the generic tool loop, so no lifecycle
  seam could ever see them.
- `WorktreeCreate` / `WorktreeRemove` — same, fired from inside
  `EnterWorktree` / `ExitWorktree`.

Meanwhile the eight remaining events have no native mechanism at all. Leaving
both groups undocumented made the gap list ambiguous (the first note's deferred
list was read as "no mechanism", which stopped being true once the Task and
worktree tools existed).

## Decision

- **TaskCreated** (tool-internal, after `store.create`): input carries
  `task_id` / `task_subject` / `task_description`. Exit-2 blocks the creation:
  the record is rolled back (`status: 'deleted'`) and the hook stderr becomes the
  tool error the model sees — the task never existed from the model's point of
  view. A dispatch that throws also rolls the record back before rethrowing.
  `TaskCreated`'s stderr feeds the model (`MODEL_TARGET_EVENTS`), like the CLI.
- **TaskCompleted** (tool-internal): fires only on the transition INTO
  `completed` (the record's previous status was something else), BEFORE the
  store mutates. Exit-2 leaves the task in its previous state and returns the
  stderr as the tool error. Subject/description come from the update when it
  supplies them, else the existing record.
- **WorktreeCreate** (tool-internal): with a configured hook, **the hook IS the
  creator** — native does not run `git worktree`, and it never falls back. The
  path comes from a structured hook's `worktreePath` or a command hook's
  stdout; a relative path resolves against the session cwd. Any hook failure —
  a `block`, or any non-success execution outcome (the CLI's any-non-zero rule)
  — fails the entry with the hook's stderr. No path after a successful run is
  also an error, not a silent fallback.
- **WorktreeRemove** (tool-internal, before `port.remove`): carries
  `worktree_path`. Observation-only: decisions and exit codes are ignored, the
  stderr never reaches the user from this seam.
- **Notification** (session, in `decidePermission` after every auto-allow /
  personOnly floor has returned and just before `canUseTool`): message is the
  CLI's own text `Claude needs your permission to use <tool>`, type
  `permission_prompt`, matcher target `notification_type`. `AskUserQuestion`
  does not fire it (it is a question dialog, not a tool-permission prompt), and
  neither does a PermissionRequest hook that already auto-allowed. Dispatch is
  **detached** — a slow hook must not delay the prompt. Its
  `additionalContext` joins the next turn through the same
  `pendingSessionStartContext` channel as SessionStart.
- **InstructionsLoaded** (session, right after the per-turn `memory.read()`):
  one dispatch per file in the chain. First sight is `session_start`; after
  `compactInPlace` the next memory read re-reports the chain as `compact`
  (including a file that only appeared post-compaction, since the reason it is
  loaded now is the reload). `memory_type` maps the chain's scope to
  `User` / `Project` / `Local`. Observation-only and detached — decisions are
  ignored, a failure only warns.
- Engine: `Notification` joined `ADDITIONAL_CONTEXT_EVENTS`; `matcherTarget` gained
  `Notification → notification_type` and `InstructionsLoaded → load_reason`;
  `foldEventFields` folds `WorktreeCreate`'s `worktreePath` from hso and the
  merge loop takes a success-only plain stdout as the path (last write wins);
  the merge carries a `failure` scalar ONLY for `WorktreeCreate`, because that is
  the one seam where any non-zero exit means failure. `shared/hooks.ts` exposes
  `worktreePath?` / `failure?` on `HookDecision` (both declaration-merge sites).
- Tools reach the hook engine through the new narrow `ToolHookPort`
  (`tools/hook-port.ts`): `configured(event)` plus `dispatch(event, fields,
  signal)`. The session owns the base facts (`session_id`, live `workingCwd`,
  `hook_event_name`) so a tool cannot mis-stamp them.

### Events deliberately left unwired

- `SessionEnd` — the claude SDK stack never fires it, and native `destroy()` has
  no user-facing end-of-session moment to mirror (existing parity ruling).
- `ConfigChange` — native has no settings-file watcher; `applyFlagSettings`
  changes runtime flags, which is not a config-file change.
- `Elicitation` / `ElicitationResult` — native MCP has no elicitation handling,
  so there is nothing to elicit.
- `Setup`, `TeammateIdle`, `CwdChanged`, `FileChanged` — no corresponding
  mechanism (no setup phase, no teammates, no cwd-watch, no file-watch).

## Alternatives considered

- **Fire TaskCreated/TaskCompleted from the generic tool loop** (match
  `tool_name`): rejected — it would fire on every `TaskCreate` call before the
  record exists, cannot roll back a creation, and cannot tell a `completed`
  transition from an unrelated status update. The CLI's call sites are inside
  the tools for exactly these reasons.
- **Keep `git worktree` as a fallback when the WorktreeCreate hook returns no
  path**: rejected — the CLI treats the hook as the creator, so a fallback would
  silently produce a worktree the hook never authorized, and hide a broken hook.
- **Await the Notification / InstructionsLoaded dispatch inline**: rejected —
  both are side effects of an interaction the user is waiting on (a permission
  dialog, a turn start); a 600 s hook timeout must not hold the prompt or the
  turn. Context is queued for the next turn instead.
- **Notify for `AskUserQuestion` and for hook auto-allows**: rejected — no
  permission dialog is shown in either case.
- **Map `TaskCreated` onto task-manager background runs**: rejected — those are
  process-level background tasks, a different concept from the `Task*` list.
- **Re-report the whole chain on every turn** instead of only first sight +
  post-compact: rejected — the CLI fires on load, not on read; it would flood
  hooks every turn.

## Consequences

- All six events now fire from the same `dispatchHook` seam as layer-1, with the
  CLI's input field names, so an existing hook config behaves the same on
  native; the Hooks panel shows their activity through the unchanged pump path.
- `TaskCreated` blocking burns the assigned id (the store rolls the record back),
  so task numbers can skip; the CLI's own counter behaves the same way.
- `TaskCreated` / `TaskCompleted` carry no `teammate_name` / `team_name` (native
  has no team concept) and `WorktreeRemove` `worktree_path` is the session's
  adopted path.
- `Notification` only covers `permission_prompt`: `idle_prompt`, `auth_success`
  and `elicitation_dialog` have no native producer. Its `additionalContext`
  lands on the next turn, not the in-flight one.
- `InstructionsLoaded` covers only `session_start` and `compact`; the CLI's
  `nested_traversal` / `path_glob_match` / `include` reasons have no native
  loader, and a changed file is not re-reported unless a compaction forces a
  reload (native re-reads but only reports transitions).
- The portable `ToolHookPort` keeps tools free of the session: a tool unit test
  can inject a fake port, and the session remains the single place that stamps
  dispatch facts.
- These six close the "layer-2, no native seam" entries for Task and worktree;
  the eight above stay documented deviations rather than silent gaps.

## Verification

- `server/providers/native/hooks/remaining-events.test.ts` — engine semantics
  (matcher targets, model-vs-user block routing, WorktreeCreate hso/stdout
  path + `failure`, Notification `additionalContext`) plus the two session
  seams: Notification fires once before a permission prompt and not for an
  auto-allowed call / AskUserQuestion; InstructionsLoaded reports each file once
  as `session_start` and re-reports the chain as `compact` after
  `compactInPlace`.
- `server/providers/native/tools/tool-hooks.test.ts` — TaskCreated block rolls
  the record back; TaskCompleted fires only on the transition and a block leaves
  the task unchanged; WorktreeCreate replaces creation (hso path / stdout path /
  no path / failure / block) and the unconfigured path still calls
  `port.create`; WorktreeRemove fires before removal and cannot block it.
- `npx vitest run server/providers/native` (141 files, 2621 passed / 11 skipped),
  both `tsc` configs, `eslint` on the changed files, `npm run verify:agent-notes`.

## Related

- [Native hook engine](2026-11-26-native-hook-engine.md) — the layer-1 engine and
  its knowing deviations; this note extends its event coverage.
- [CLI hook semantics research](../../../../docs/research/2026-11-26-cli-hook-semantics.md)
  §3 (event table, matcher targets, exit-2 targets) and §9.2/9.3 (seam analysis).
