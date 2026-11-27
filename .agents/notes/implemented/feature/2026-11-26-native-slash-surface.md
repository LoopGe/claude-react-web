# Agent Note: Native slash-command surface

Status: implemented

## Problem

The native provider (direct Anthropic API, no CLI subprocess) had a skill
slash surface but no command surface. `/compact` reached the model as literal
text — a user who typed it expected the context compressed, not a model reply
about compacting. `/init` and `/review` did not exist, custom
`.claude/commands/*.md` were neither discovered nor expanded, and
`supportedCommands` answered skill rows only. The claude provider gets all of
this from the CLI subprocess, so this was a cross-provider capability gap.

The full contract lives in the
[native capability fills design](../../../../docs/superpowers/specs/2026-11-26-native-capability-fills-design.md)
(G3); this note records the decisions and what they beat. G3 is the **builtin
command + custom command** surface, distinct from the skill-parity A/B/C
batches owned by the
[native skill CLI-parity design](../../../../docs/superpowers/specs/2026-11-25-native-skill-cli-parity-design.md)
and the plugin-skill discovery work — skills are `.claude/skills/*/SKILL.md`,
commands are flat `.claude/commands/*.md` plus host-authored builtins. The
[implementation plan](../../../../docs/superpowers/plans/2026-11-26-native-slash-surface.md)
records the task breakdown. The mechanism extends the
[native skill invocation recovery](../architecture/2026-11-12-native-skill-invocation-recovery.md)
dual-event model to commands without changing the skill decision, and the
`/compact` trigger reuses the in-place compaction tail whose window semantics
the [pin-aware auto-compact](2026-11-25-native-pin-aware-auto-compact.md) note
owns.

## Decision

Command handling stays host-side in the native session, consistent with skill
invocation: one neutral discovery/catalog module
(`server/providers/native/commands.ts`) finds custom commands and holds the
builtin prompt templates, the turn loop intercepts a leading `/name` and
expands it through the existing skill machinery, and `/compact` is a control
action that signals the manager's in-place compaction flow through a
host-bound callback. The neutral core stays neutral under the
[provider seam neutralization](../architecture/2026-11-18-provider-seam-neutralization.md)
pins (`neutrality.test.ts` / `host-free.test.ts`); the claude provider and the
SDK contract are untouched, and skill invocation behavior is unchanged.

### Discovery + builtin catalog

`discoverCommands(cwd, userRoot)` scans the user root `<userRoot>/commands`
first and the project root `<cwd>/.claude/commands` second, returning custom
rows only (builtins are concatenated by the session catalog). Commands are
FLAT regular `.md` files — not skill subdirectories:

- **Path safety** mirrors `server/skills.ts` `ensureInside`. Entry names come
  from `readdir` and pass `VALID_SKILL_NAME`; `entry.isFile()` rejects
  directories AND symlinks (lstat semantics), so a link pointing outside the
  root is never read; a throwing containment invariant on the resolved path
  guards future name-derivation changes. Escape is impossible by construction.
- **Frontmatter is optional metadata, not a validity gate** (CLI
  custom-command parity, unlike SKILL.md): a plain markdown file with no
  leading `---` is a valid command whose whole text is the body; an unclosed
  frontmatter block is a broken document and is skipped; a missing
  `description` yields `''`. A valid frontmatter `name` overrides the
  filename; an invalid one falls back to it. The shared neutral parser
  (`shared/skills.ts` `parseSkillFrontmatter`) is reused, not reimplemented.
- **Project-wins dedupe**: a Map keyed by name lets the project overwrite a
  same-name user command (the project is the more specific owner, mirroring
  the skill catalog). Within one root, a frontmatter-name collision is
  readdir-order dependent — a pathological case the CLI shares.
- **Size cap** `MAX_SKILL_BYTES` (1 MiB); oversized files are skipped. Missing
  roots (`ENOENT`/`ENOTDIR`) yield an empty list (the ordinary case); any
  other readdir error propagates loudly. An absent/empty `cwd` means user-only
  discovery — the core never falls back to `process.cwd()`.

`userRoot` is PASSED IN: the composition root (`native-provider.ts
createSession`) resolves `claudeConfigDir()` host-side and hands it to
`NativeSessionOptions.commandsUserRoot`. The neutral core never derives host
config.

`BUILTIN_COMMANDS` holds `/init` and `/review` as host-authored prompt
templates (bundled, not generated) and `/compact` as a bodyless control row.
Neither prompt template carries a `$ARGUMENTS` placeholder, so user arguments
ride the shared substitution contract's `\n\nARGUMENTS: <args>` fallback.

### Expansion reuses the skill machinery

`expandCommandBody(cmd, args)` is a one-line delegation to
`substituteSkillArguments` (`skill-render.ts`) — the SAME CLI contract skills
use (`$ARGUMENTS` / `$N` / the ARGUMENTS fallback). Substitution is not
reimplemented; a body-less row throws loudly rather than returning an empty
prompt.

A command expansion persists the **same** `session/skill` dual-event as a
skill invocation: the raw typed `user/message` followed immediately by the
hidden instruction event (`{name, body, timestamp}`, name = authored command
name, body = expanded body). The durable event already means "hidden
instruction paired with the preceding raw user turn", so replay
(`historyFromEvents`) inserts the stored body verbatim, fork cuts extend over
the pair, and compaction preserves it — all without consulting current
catalogs. Two consumers pair by adjacency on the main thread:
`getSkillCompactionEntries` (a `user/message` immediately followed by a
`session/skill`) and the fork-cut pairing. The fork pairing
(`isSkillInstructionForRawUser`, `session-log/fork.ts`) folds case on both
sides because command lookup is case-insensitive (`/FOO` expands the authored
`foo`); skill lookup is exact, so skill pairings are unaffected by the fold.

### Interception order + precedence

In the turn loop (`native-session.ts` pumpLoop), after the per-turn catalog
awaits and the skill-view freeze:

1. `/compact` control interception (`isCompactControlInvocation`) — BEFORE any
   prompt expansion.
2. Command expansion (`commandInvocationForTurn`) — builtin > custom.
3. Skill matching (`skillInvocationForTurn`).
4. Plain-text passthrough — an unknown `/name` matches neither and reaches the
   model as ordinary text (no instruction event).

Lookup is case-insensitive (the typed token and catalog names are lowercased);
the returned/displayed name stays the authored catalog name. The command list
is captured once per turn (a wholesale-replaced array reference), so a
mid-turn reload cannot mix into the running turn — the same snapshot
discipline as the skill view. `commandInvocationForTurn` reuses the skill
grammar (`SKILL_COMMAND_RE`) and first-text-block extraction (a shared
`invocationTextOf` helper).

Precedence is **builtin > custom > skill**, deduped by lowercased name,
first-wins. Command-wins-over-skill mirrors DSH/CLI. Builtin-wins-over-custom
protects the host-authored control surface from hijack by a file named e.g.
`init.md` or `compact.md` — the `/compact` control action depends on it.

### Catalog + reload

`commandCatalog(custom, skillCommands)` merges builtin rows (`builtin: true`,
no body exposed) + custom rows + skill rows. `supportedCommands()` awaits both
ready promises (`skillsReady`, `commandsReady`) and returns the merged rows.
`reloadSkills()` re-discovers BOTH roots, reassigns both ready promises, and
returns `{ skills: mergedRows }` — the `skills` key is the manager's existing
broadcast contract (`SessionSkillManager.reloadSkills` relays it as
`commands-changed`), so the full surface reaches the picker through the
existing path with no new broadcast plumbing. Command reload carries the same
observed-but-loud failure contract as skills plus a generation fence so a
slower earlier pass cannot overwrite a newer committed snapshot.

### `/compact` is an in-place control action

`/compact` triggers the manager's **in-place** compaction (`compactInPlace`,
SAME session id) — never the `/handoff` fresh-session continuation
(`manager.compact`). The wiring mirrors the existing auto-compact lifecycle
exactly, because `compactInPlace` refuses an in-flight turn or queued input and
the manager reads `working` until the pump settles the turn — the control turn
IS a turn, so the callback cannot compact inline during it:

1. **Core interception**: the raw `/compact` turn is persisted normally (no
   hidden instruction), the consumed ack fires, then
   `await this.opts.requestCompact?.()` runs BEFORE the terminal result so the
   manager's request flag is set before the pump settles the turn. The branch
   emits a zero-turn success result (`numTurns: 0`, zero usage) with non-empty
   text `'Compaction requested.'` — deliberate, so `isEmptyResultFrame`
   classifies a REAL turn settlement (`settlesTurn = true`); an empty bookend
   would skip queued-input materialization and strand a prompt queued behind
   `/compact`. No `runTurn`, no model round for the literal text.
2. **Manager binding**: `requestCompact` on `CreateSessionOptions` (a neutral
   `() => Promise<void>`, the G1 `requestPermissionModeChange` callback seam)
   records `s.manualCompactRequested = true` on the live Session. It is a
   request recorder, not an inline compactor. Bound at BOTH spawn sites — the
   spawn funnel and `respawnInPlace`.
3. **Post-settle trigger**: in `buildPumpDeps.onTurnSettling`'s `setImmediate`
   (the SAME macrotask point as the auto trigger, where the pump has cleared
   `turnActive`/`pendingTurns`), a set `manualCompactRequested` flag is consumed
   and `runManualCompact(s)` runs; otherwise the pressure-gated
   `maybeAutoCompact(s)`. Manual wins over auto for that settle.
4. **`runManualCompact`**: identical guards to `maybeAutoCompact` (identity,
   degraded seq fence, `compactInPlace` capability, `phaseOf === 'idle'`,
   `autoCompacting` in-flight guard) MINUS the pressure gate and the
   `nativeAutoCompact` policy toggle — an explicit user request compacts
   regardless of context fullness. Tracked in `autoCompactOperations` so
   `autoCompactBeforeSend` joins an in-flight manual compact.
5. **Shared tail**: `runAutoCompact`'s post-gate body is extracted into
   `runInPlaceCompact(s, compactInPlace, preTokens, trigger, threshold?)` on
   the retain-history append flow (`2026-11-26-native-compact-retain-history-design.md`)
   — summarize the LOCAL FLOOR SPAN (the merged ring after the last
   `compact_boundary`, D6: the ring retains pre-compact history, so the
   summarizer must see only what the model still sees; manual shares the same
   span) → post-await identity/phase re-check → mint one `summaryUuid` (D8) →
   `compactInPlace(summary, { uuid, timestamp, summaryUuid })` (the provider
   appends its durable `retainHistory` marker and swaps its model history) →
   clear the cached context usage → `pushCompactFrames` APPENDS the boundary +
   summary to the retained ring + seq space. No reset journal, no generation
   bump, no sidecar deletion, no `session-cleared`. `pushCompactFrames` takes
   both `summaryUuid` and `trigger`, so the manual boundary carries
   `compact_metadata.trigger: 'manual'` (the client renders a user-invoked
   compaction) and the live summary frame dedupes to the disk-synthesized one
   on restart. Auto behavior is preserved.

Mid-turn gating follows the manager's existing idle/compact gating: input
queued BEHIND `/compact` keeps the session `working` → compaction skips (same
as auto); `/compact` queued behind a live turn compacts once the session
settles idle.

### Locked scope

CLI-ecosystem commands (`/login`, `/logout`, `/upgrade`, `/doctor`, `/ide`, …)
stay ABSENT on native — they appear only with the CLI in a later phase.
UI-equivalent builtins (`/model`, `/usage`, `/config`, …) as local-command
deep-links into existing UI are out of scope (deferred).

## Alternatives considered

- **A sibling `session/command` durable event.** Rejected: the `session/skill`
  event already means "hidden instruction paired with the preceding raw user
  turn". A new event would touch the vocabulary map, format
  parser/validator/projector, migration, replay, fork, compaction, the host
  seam and the neutrality pins for zero behavioral gain. Reuse keeps replay,
  fork and compaction owning the pair unchanged.
- **Reimplementing `$ARGUMENTS` substitution for commands.** Rejected:
  `substituteSkillArguments` already implements the CLI contract; a second
  implementation would drift. `expandCommandBody` delegates.
- **`/compact` as the `/handoff` continuation (`manager.compact`, a fresh
  session).** Rejected: the spec calls for in-place compaction with the same
  session id; handoff is a different product flow (a new-session continuation).
- **Inline compaction inside the control turn.** Rejected: `compactInPlace`
  refuses an in-flight turn or queued input, and the control turn itself keeps
  the manager `working` until settle. A request recorder + post-settle idle
  trigger mirrors the auto lifecycle instead of fighting it.
- **Expanding `/compact` as a prompt / passing it to the model as text.**
  Rejected: this is the defect G3 closes — the user expects the context
  compressed, not a model reply about compacting.
- **A provider-aware client local command for `/compact`** (the other wiring
  the spec left to the builder). Rejected: native-side interception keeps the
  whole slash surface on one seam in the turn loop (consistent with skills),
  keeps the client provider-agnostic, and reuses the G1 host-callback pattern.
- **Custom-wins-over-builtin precedence.** Rejected: a file named `init.md` or
  `compact.md` could hijack the host-authored control surface; builtin-wins
  keeps `/compact` unconditionally a control action.
- **Deriving `userRoot` inside the neutral core** (reading host config or a
  `process.cwd()` fallback). Rejected: the core stays neutral — the
  composition root resolves `claudeConfigDir()` and passes the root in.
- **Frontmatter as a validity gate (skill-style required description).**
  Rejected: CLI custom-command parity makes frontmatter optional metadata; a
  plain `.md` file is a valid command.

## Consequences

Native gains the builtin + custom command surface and a working `/compact`,
all host-side and neutral; claude and the SDK contract are untouched, and skill
invocation is unchanged (the regression suites stay green). The dual-event
reuse means replay, fork and compaction own command expansions with no new
machinery, and the shared `runInPlaceCompact` tail keeps auto and manual
compaction on one code path.

What it costs / discloses:

- **The `reloadSkills` result key widened.** `skills` now carries the full
  slash surface (builtin + custom + skill), not skill rows alone — required so
  the picker keeps builtins after a reload. All in-repo consumers are updated;
  the key name is the manager's broadcast contract and was deliberately kept.
- **`userRoot` is spawn-time-fixed.** `claudeConfigDir()` resolves at
  `createSession`; a mid-session config-dir change is picked up by skill
  reloads but not command reloads. No such path exists in the app.
- **Same-root frontmatter-name collisions are readdir-order dependent** (OS
  ordering) — a pathological case shared with the CLI.
- **The control result renders an `ok · 0 turns` footer** and a result-frame
  sidecar entry pairing it with the previous turn's assistant uuid; the
  `TurnChangesCard` on that footer may re-show the previous turn's changes
  (empty patch — the control turn edits nothing). Functionally safe
  (idempotent anchor/resume updates); a cosmetic nuance (see Deferred).

This note extends the skill-invocation-recovery dual-event mechanism to
commands; that note remains authoritative for the skill decision. The
pin-aware-auto-compact note remains authoritative for window semantics and
the retain-history design (`docs/superpowers/specs/2026-11-26-native-compact-retain-history-design.md`)
for the append/retain contract — the manual trigger reuses their shared tail
and adds no new threshold policy or presentation.

## Deferred

- **Live/replay model-history divergence on a skipped/failed compact.** The
  control `/compact` user event is durable and replays into model history on
  resume, but the live control branch never pushes it to the in-memory model
  history. When compaction skips or fails, a resume re-introduces a dangling
  `/compact` turn the live model never saw. Benign — the next successful
  compaction restarts history past it — but live ≠ replay until a neutral
  replay-exclusion marker (a `local_command` equivalent) restores parity.
- **One-shot manual request silently dropped when idle gating skips.** The
  success result (`'Compaction requested.'`) over-promises when the post-settle
  guards skip the flow. Consider deferring flag consumption until the guards
  pass, or a clearer skipped result.
- **`/compact [instructions]` arguments are ignored.** The host summarizer
  takes no focus instructions; CLI focus parity is a separate feature.
- **Control-result footer nuance.** Eliminating the `ok · 0 turns` footer /
  `TurnChangesCard` re-show needs a neutral `local_command`-equivalent result
  marker (vocabulary + adapter + pump change).
- **No fs-watcher freshness for custom commands.** Discovery is reload-driven,
  like skills. Command discovery-failure / generation-fence / mid-turn reload
  snapshot e2e coverage gaps remain (they mirror the pinned skill pattern).
- **UI-equivalent builtin deep-links** (`/model`, `/usage`, `/config`, …) into
  existing UI — optional, not required for G3.

## Testing

`server/providers/native/commands.test.ts` pins the builtin catalog, the
discovery semantics (project frontmatter, user-only, project-wins collision,
plain-markdown whole-file body, frontmatter name override, unclosed-frontmatter
skip, non-`.md`/directory/invalid-name ignores, a real symlink escape, the
1 MiB cap, missing roots) and the substitution reuse (`$ARGUMENTS`, `$N` +
fallback, no-placeholder fallback, body-less throw).
`server/providers/native/e2e-slash.test.ts` drives the surface through the real
SessionManager / NativeProvider / log: catalog completeness, `/init` template
expansion (ring keeps the typed text), `$ARGUMENTS`/`$N` substitution +
compaction pairing, skill regression, unknown passthrough, command-wins and
builtin-wins precedence, case-insensitive lookup + authored display names,
user-root discovery + project-wins, reload re-discovery + full-catalog
`commands-changed`, resume rebuild + case-insensitive fork cut; and the
`/compact` control action (callback not a model turn, builtin row, manager
in-place compaction with `trigger: 'manual'` + same id + retained history —
the ring keeps the pre-compact turns and appends the boundary + summary, the
live `summaryUuid` matches the durable compact event, and the next model
request floors at the summary — plus both mid-turn gating cases). `session-log/fork.test.ts` pins the case-folded
raw↔instruction pairing. The sibling catalog-shape suites carry additive
builtin-row updates; `neutrality.test.ts` / `host-free.test.ts` stay green and
`e2e-context-window` pins the byte-equivalent auto path.
