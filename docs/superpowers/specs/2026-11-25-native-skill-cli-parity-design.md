# Native skill CLI parity (A batch) — design

Date: 2026-11-25
Status: proposed

## Problem

The native provider already discovers user/project skills, exposes them through
`supportedCommands`, expands `/name` host-side, and serves a model-facing `Skill`
tool (P1.4, 2026-11-10). Three CLI contracts are still missing, and each breaks a
skill author's reasonable expectation:

1. **Argument placeholders are left literal.** `skillInvocationForTurn`
   (`server/providers/native/native-session.ts:221-222`) matches `/name args` but
   drops the args capture; `renderNativeSkillBody`
   (`server/providers/native/skill-render.ts:5`) takes no args. A skill whose
   instructions template on `$ARGUMENTS` receives the placeholder verbatim. Args
   ride only the raw user message, so a skill that says "run `$ARGUMENTS`" never
   sees the value substituted into its own body.
2. **The slash name grammar rejects `:`.** `SKILL_COMMAND_RE`
   (`native-session.ts:198`) and `VALID_SKILL_NAME` (`shared/skills.ts:14`) use
   `[A-Za-z0-9._-]`, so the CLI's canonical `plugin:skill` shape is inexpressible.
   This is the grammar prerequisite for plugin-sourced skills (B batch).
3. **The model listing has no budget.** `sectionFor`
   (`server/providers/native/skills.ts:186-194`) renders every listable skill's
   full description with no cap. A large skill set consumes unbounded context;
   the CLI caps the listing at roughly 1% of the context window.

Research basis: `docs/research/2026-11-25-native-slash-skill-discovery.md`
(§3.6 gap list, §5.4 CLI expansion, §5.7 substitution contract, §7 parity
analysis). CLI references below cite that doc's `claude.exe @ <byte-offset>`
evidence.

## Goals

- **G1 — Argument substitution (positional).** Both `/name args` and the `Skill`
  tool substitute `$ARGUMENTS` (whole raw args), `$ARGUMENTS[N]` and `$N`
  (0-based) into the skill body per the CLI contract (`GWe` @255663604). Args
  split quote-aware shell-style with a whitespace fallback (`rxo` @255663198);
  the CLI fallback append (`\n\nARGUMENTS: <args>`) applies under §5.7's
  condition. Substitution past 4,000,000 chars throws (`aMr` @255663144), never
  truncates. Named `$arg` placeholders are out of scope (see Non-goals).
- **G2 — Canonical name grammar.** The slash command grammar accepts the CLI
  `plugin:skill` shape (a single `:` separating two bare names). Filesystem
  basename validation is unchanged. Forward-compatible scaffolding for B.
- **G3 — Listing budget.** The `<available_skills>` section is capped at a
  budget derived from the model context window (~1%). Truncation is
  deterministic, never drops a skill name, and the `listing()` accessor reflects
  the same truncated lines so context accounting stays accurate.

## Non-goals and anti-goals

- **Not plugin discovery (B).** No plugin root scanning, no plugin-id composition
  source, no `supportsPlugins` change. G2 is grammar-only and inert until B
  lands. Anti-goal: building speculative plugin machinery now (CLAUDE.md
  no-speculative-code rule).
- **Not digest dedup.** The native listing is a system-prompt section rebuilt and
  re-sent on every API call (`native-session.ts:1495-1500`), not a persistent
  injected context message. There is no accumulation to dedup; CLI/DSH dedup
  exists because their listing is a persistent message. G3 is budget truncation
  only.
- **Not named `$arg` placeholders.** CLI named substitution requires a
  frontmatter `arguments` declaration (names bind positionally to args tokens;
  `eEe` @257732100, and the schema @255468600 marks the key `@internal` —
  `argument-hint` is the documented form). Implementing it would extend
  `shared/skills.ts`'s parser and `SkillRecord` — browser-compiled code shared
  with the skill-manager UI and REST routes — beyond A's contained server-only
  scope. Positional substitution covers the documented author surface. Deferred.
- **Not directory/session/effort body templating.** `${CLAUDE_SKILL_DIR}`,
  `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_SESSION_ID}`, `${CLAUDE_EFFORT}` are
  substituted by a separate function (`kJe` @257758569), not by `GWe`. This is a
  distinct body-templating step outside the §3.6 argument-substitution gap;
  deferred. Native already prepends the skill base directory to the body.
- **Not the rest of the gap list.** Forked execution, `allowed-tools`/model
  overrides, prose `/name` mention semantics, and a visible expansion marker stay
  out (B/C batches).
- **Not a change to the dual-event persistence model.** The substituted body is
  baked into the persisted `session/skill` event at expansion time; replay reads
  it verbatim and never re-substitutes. This preserves the recovery contract
  (`.agents/notes/implemented/architecture/2026-11-12-native-skill-invocation-recovery.md`).
- **Anti-goal: silently breaking existing pins.** `e2e-skill-invocation.test.ts:347-358`
  asserts the request carries args once and the body shape; substitution changes
  the body. Those pins are updated deliberately to the new contract, not loosened.

## Constraints

- **Dual-event model.** Raw `user/message` + hidden `session/skill {name, body}`.
  Substitution must happen at expansion (args are known there), never at replay.
- **One frozen view per turn.** Invocation, `section()`, the `Skill` tool, and
  `listing()` share one snapshot (`native-session.ts:1404`). The budget must be
  part of that consistent view, not a divergent per-call read.
- **`shared/skills.ts` compiles under the browser tsconfig** (no `node:path`).
  The grammar regex lives there and must stay browser-safe.
- **`section()` is synchronous; capacity resolution is async.**
  `NativeModelContextResolver.resolve` (`model-context.ts:52`) caches `lastGood`
  but returns a Promise. Budget plumbing must keep `section()` sync.
- **`estimateText` (`estimate.ts:35`) is native's token currency** (CJK-aware).
  `contextComposition` already prices the skill section with it
  (`native-session.ts:2005`); the budget should use the same currency so the cap
  and the accounting agree.

## Decided approach

### G1 — Argument substitution (positional)

- Add a pure `substituteSkillArguments(body: string, args: string): string` in
  `skill-render.ts` implementing the positional CLI contract (`GWe` @255663604,
  research §5.7): `$ARGUMENTS` → whole raw args; `$ARGUMENTS[N]`/`$N` → the Nth
  token, **0-based**, out-of-range left literal; args split quote-aware
  shell-style with a whitespace fallback (`rxo` @255663198). Apply the CLI
  fallback append (`\n\nARGUMENTS: <args>`) under §5.7's condition. Escaped `\$`
  is protected. No named-placeholder binding — no frontmatter `arguments` key is
  read.
- Oversize guard: accumulate substituted size and throw past 4,000,000 chars
  (`aMr` @255663144), matching the CLI's loud error rather than truncating.
- `renderNativeSkillBody` gains an `args` parameter and substitutes into the
  SKILL.md body. The `Base directory for this skill:` prefix is native's own,
  prepended before substitution (the CLI prepends it before `GWe` too), and
  carries no placeholders.
- The slash path threads the args capture: `skillInvocationForTurn` passes
  `match[2]` into `expand(name, args)` → `expandFor` → `canonicalBodyOf(entry, args)`.
- The `Skill` tool path passes `input.args` through the same substitution.
  `renderNativeSkillToolResult`'s native-invented `## User Request` suffix is
  replaced by the CLI fallback `ARGUMENTS:` rule, so both invocation paths agree
  on one contract. This is a deliberate behavior change for the tool path.
- The persisted `session/skill` body is the substituted body; replay is unchanged.

### G2 — Canonical name grammar

- Add a canonical-name grammar accepting an optional single `:suffix`:
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,79}(?::[A-Za-z0-9][A-Za-z0-9._-]{0,79})?$`.
  `SKILL_COMMAND_RE`'s name group uses it.
- `VALID_SKILL_NAME` stays the bare grammar for filesystem basenames and
  `frontmatter.name`: a plugin skill's `frontmatter.name` is bare, and the `:`
  is composed from the plugin id by the plugin source in B. `:` cannot be a
  Windows directory character, so it can only ever be a composed canonical name.
- The catalog's `byName` and the override map are string-keyed; they already
  accept `:` keys with no change.
- No plugin discovery is added. The grammar accepts a shape nothing produces yet.

### G3 — Listing budget

- The catalog gains a configurable listing budget in tokens, defaulting to
  `floor(DEFAULT_CONTEXT_WINDOW * fraction)` with `fraction ≈ 0.01` (the CLI's
  ~1%, verified via the bundled doctor skill quote @264704500). The session sets
  the budget from the resolved context window.
- `sectionFor`/`listingFor` apply deterministic truncation: render full lines;
  if `estimateText(section)` exceeds the budget, shorten descriptions (ellipsis)
  in a deterministic order until the section fits. A skill name is never dropped
  — a budgeted skill stays discoverable by name. `name-only` lines have no
  description to truncate.
- Budget plumbing keeps `section()` synchronous: the session resolves the context
  window through the cached resolver and writes the budget onto the catalog;
  `section()` reads the configured value. The budget refreshes on model switch /
  capacity refresh. The exact refresh trigger is left to the builder.
- `listing()` returns the truncated lines, so `contextComposition`'s
  `skillFrontmatter` token rows match the section actually sent.
- The precise CLI priority order for truncation was not fully extracted from the
  binary; the deterministic algorithm here is this design's call, while the ~1%
  fraction is CLI-verified.

## Left to builder

- Pin the exact fallback-append condition and the shell-split fallback against
  research §5.7 in unit tests. (0-based indexing and the 4,000,000-char throw are
  decided; named placeholders are out.)
- Choose the budget refresh trigger (where the session writes the catalog budget;
  the model-switch path) so a down-switch shrinks the cap promptly.
- Settle the truncation algorithm (per-description char cap vs drop-to-name-only
  ordering) and pin it deterministically.
- Update the affected pins (`e2e-skill-invocation.test.ts`,
  `native-session.test.ts` listing rows) to the new contract and add unit tests
  for substitution, the `:` grammar, and budget truncation.