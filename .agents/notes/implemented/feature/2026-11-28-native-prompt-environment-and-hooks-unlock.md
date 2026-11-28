# Agent Note: Native prompt environment, agent roster, and hooks unlock

Status: implemented

## Problem

Two gaps made native sessions behave visibly worse than claude ones, and both
are on the default path now that
[auth-aware default selection](2026-11-27-native-default-flip.md) sends API-key
users to native:

1. **The system prompt said almost nothing about the world.** `renderSystem`
   composed the one-line identity section, per-tool guidance and
   `<available_skills>`; the only environment fact the model ever saw was the
   spawn-seeded user reminder `Working directory: … / Current time: <ISO>`
   (`session-log/replay.ts`). No platform, no git state, no calendar date, and
   no roster of the custom agents in the store — the Agent tool's schema only
   said "Defaults to general-purpose", so a `subagent_type` naming a real agent
   had to be guessed. The
   [capability fills design](../../../../docs/superpowers/specs/2026-11-26-native-capability-fills-design.md)
   deferred richer prompt context; this note lands the environment/roster half.

2. **Hooks were locked although the engine shipped.** The
   [gating projection](2026-11-26-native-gating-projection.md) set
   `supportsHooks: false` in both the server capability literal and the shared
   pre-create map, so the Settings Hooks tab rendered "requires the Claude CLI"
   and never fetched config. But the
   [hook engine](2026-11-26-native-hook-engine.md) landed the same day: the
   provider validates and passes `settings.hooks`, `applyFlagSettings({hooks})`
   swaps the live config, `dispatchHook` fires the 13 layer-1 events, and
   `HooksPanel` already carried native-specific copy
   (`NATIVE_NO_TRIGGER_EVENTS`). The gate was older than the engine — a stale
   lock hiding a working feature from native users.

## Decision

### `<env>` is a spawn-time snapshot built without a git subprocess

`prompt/environment.ts` (host-free, Node builtins only) reads the facts once at
`createSession`:

- **git state** from `.git/HEAD`, walking up from the working directory to the
  work tree and following the `.git` *file* a linked worktree carries
  (`gitdir: …`). A `ref: refs/heads/x` HEAD reports branch `x`; a raw object id
  reports `detached HEAD at <7-char sha>`; unreadable markers degrade to `no`.
  Never a spawned `git`: prompt assembly must not block on PATH or a slow
  binary, and must not fire user `PreToolUse` hooks for its own bookkeeping.
- **platform / arch / OS release** from `node:os`.
- **date** from local calendar fields (not UTC) so a session opened at 23:59
  is not told it is tomorrow.

The section (`harness:environment`, order 5) renders a CLI-shaped block:

```
<env>
Working directory: /Users/…
Is a git repository: yes (branch "main")
Platform: darwin (arm64)
OS release: 24.6.0
Today's date: 2026-11-28
</env>
```

It rides **both** prompts — a subagent runs in the same working directory, and
the same facts are just as true there.

### `<available_agents>` lists only agents that can actually run

`NativeProvider.availableAgents()` reads the injected `AgentDefinitionStore`
(`list()`, never `getEnabledDefinitions()` — the latter strips bookkeeping and
cannot be checked against the native profile), and keeps definitions that are
enabled AND free of fields the native profile rejects
(`unsupportedAgentFields`). Advertising an agent that would throw in
`profileFromDefinition` at call time is worse than omitting it. Rows are sorted
by name so the prompt is byte-stable for the same store, and the section is
**omitted entirely** when the roster is empty (only the built-in default would
be noise). The section states that `general-purpose` is the built-in default.

The roster is parent-only: a nested loop has no Agent tool, so
`renderSystem({withAgentSection: false})` drops it — same rule as the Agent
guidance section. Prompt sections are still rebuilt per conversation, never per
turn, so a definition added mid-session appears on the next resume, not
immediately.

### Hooks capability true; coverage is a note, not a lock

`supportsHooks` is now `true` in `ProviderCapabilities` and in the shared
pre-create map, so the Hooks tab mounts the live `HooksPanel` on native. What
native does **not** have is stated in the panel instead of being gated away:

- a new passive note: native executes hooks from **this session's config only**
  — settings-file (`settings.json` / `settings.local.json`), plugin and
  agent-frontmatter sources are not wired yet;
- the existing `NATIVE_NO_TRIGGER_EVENTS` note, unchanged: configured hooks on
  the 14 layer-2 events never fire.

The shared map and the server literal are kept in agreement by the existing
`provider-capabilities-pin.test.ts`; the projection test now asserts hooks is
`true` for both providers, live and dormant.

## Alternatives considered

- **Recompute the env block per turn** (fresh branch/date): rejected. The
  system prompt is the prompt-cache prefix; mutating it every turn invalidates
  the cache and re-bills the whole conversation. The CLI's own `<env>` block is
  likewise a process/session snapshot, and our existing contract is
  "sections stable per conversation (no hot-plug)". Staleness is documented
  rather than paid for on every request.
- **Shell out to `git rev-parse`**: rejected — prompt assembly would depend on
  a binary, a PATH, and (for hook-configured users) a `PreToolUse` hook run per
  spawn, for two lines of text. `.git/HEAD` parsing covers the cases sessions
  actually see (branch, detached, linked worktree, subdirectory).
- **Keep hooks locked until every source and event is wired**: rejected. The
  session config source is the surface the panel edits and the engine fully
  supports it; locking it hides working behavior to avoid explaining a partial
  one. The honest note is the smaller cost.
- **List agents straight from `getEnabledDefinitions()`**: rejected — that
  projection strips `enabled`/bookkeeping and cannot be filtered by native
  profile support, so it would advertise definitions native then refuses.

## Consequences

- Every native request carries roughly a dozen extra system-prompt lines; the
  context-usage estimate folds `baseSystem` as before, and no shape changed on
  the wire.
- Branch, date and agent roster are frozen at spawn: a `git checkout` mid-session
  leaves a stale branch line, and a newly created agent is invisible until
  `resume`. This mirrors the CLI and is the price of a stable cache prefix.
- The hooks lock is gone from both the server projection and the shared
  pre-create map; a native draft in the New Session dialog no longer hides the
  feature. Source coverage gaps are user-visible in the panel, and belong to
  the hook-engine follow-up work (Projects 2–4: filesystem/plugin/agent
  sources, plus the layer-2 trigger mechanisms and the known deviations
  recorded in the engine note).
- `CLAUDE.md` / instruction-file loading is still absent — a separate parity
  item, not touched here.

## Testing

- `prompt/environment.test.ts`: branch / detached / linked-worktree /
  subdirectory / no-repo detection, local-date formatting, env block text,
  empty-roster null, sorted rows with tool allowlists.
- `native-session.test.ts` (`native system prompt: environment + agent roster`):
  one real turn + one nested run through the scripted streamer; main prompt has
  `<env>` and the roster, nested keeps `<env>` and drops the roster.
- `HooksPanel.test.tsx`: native session shows the source-coverage note, claude
  does not.
- `SettingsPanel.test.tsx`: native Hooks tab mounts the live panel (no notice)
  and still shows the coverage note.
- `shared/provider-capabilities.test.ts` + `session-manager.test.ts`: hooks is
  supported on both providers; the other four stay locked on native.

## Related

- [Native capability gating projection](2026-11-26-native-gating-projection.md)
  — the hooks lock this supersedes (that note's other four locks stand).
- [Native hook engine](2026-11-26-native-hook-engine.md) — the engine and its
  source/event coverage + deviations.
- [Native default flip](2026-11-27-native-default-flip.md) — why these gaps sit
  on the default path.
- [Native capability fills design](../../../../docs/superpowers/specs/2026-11-26-native-capability-fills-design.md)
  — the deferred prompt/memory/sandbox items this partially lands.
