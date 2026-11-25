# Native Skill CLI Parity (A Batch) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the native provider's skill invocation with three CLI contracts — positional argument substitution, the `plugin:skill` name grammar, and a budgeted model listing.

**Architecture:** G1 adds a pure positional-substitution function and threads args through the existing dual-event expansion (substituted body baked into the persisted `session/skill` event at expansion; replay unchanged). G2 widens the slash name grammar to the CLI canonical shape without touching filesystem validation. G3 caps the `<available_skills>` system section at a token budget derived from the model context window, sharing one budgeted renderer between `section()` and `listing()`.

**Tech Stack:** TypeScript, Node 20, vitest (server tests run in Node), esbuild bundle. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-25-native-skill-cli-parity-design.md`
**Research:** `docs/research/2026-11-25-native-slash-skill-discovery.md` (§5.7 is the substitution contract oracle)

## Global Constraints

- Neutral core: `server/providers/native/skills.ts`, `skill-render.ts`, `estimate.ts` import only neutral `shared/*` + sibling vocabulary + Node builtins. Do NOT import `model-context.ts` / `model-discovery.ts` into `skills.ts` (neutrality pin `native/vocabulary/neutrality.test.ts`).
- `shared/skills.ts` compiles under the browser tsconfig — no `node:path`, no Node-only imports.
- Dual-event model: substitution happens at expansion only; the persisted `session/skill` body is replayed verbatim, never re-substituted.
- `VALID_SKILL_NAME` (bare grammar) stays the filesystem-basename / `frontmatter.name` validator. The `:` shape is a composed canonical name only.
- Named `$arg` placeholders and `${CLAUDE_*}` directory templating are OUT of scope (spec Non-goals).
- All diagnostic logging via `createLogger(scope)`; never bare `console.*`.
- Every commit ends with: `Co-Authored-By: Claude Code <noreply@anthropic.com>`
- Verify commands: targeted `npx vitest run <file>`; full gate `npm run typecheck` (both tsconfigs) before the final commit.

## Review Focus

- Args whose text looks like a placeholder (e.g. args = `$0`) must be inserted literally, never re-substituted. (Task 1 test)
- An escaped `\$` in a skill body must render a literal `$`, not trigger substitution. (Task 1 test)
- Out-of-range `$N` / `$ARGUMENTS[N]` stays literal — no crash, no empty replacement. (Task 1 test)
- Substitution past 4,000,000 chars throws loudly; it never silently truncates. (Task 1 test)
- A budget smaller than the name-only floor never drops a skill name (best-effort over budget). (Task 4 test)

## File Structure

- `server/providers/native/skill-render.ts` — add `substituteSkillArguments` + `splitSkillArgs`; `renderNativeSkillBody` gains `args`; remove `renderNativeSkillToolResult`.
- `server/providers/native/skills.ts` — thread `args` through `canonicalBodyOf`/`expandFor`/`bodyOfFor`/view; add listing budget field + setter + shared budgeted renderer.
- `server/providers/native/native-session.ts` — `SKILL_COMMAND_RE` from canonical source; `skillInvocationForTurn` passes args; `getContextUsage` sets the budget; `snapshot` carries budget (via catalog).
- `server/providers/native/tools/skill.ts` — pass args to `bodyOf`, return its text directly.
- `shared/skills.ts` — export `CANONICAL_SKILL_NAME_SOURCE` + `CANONICAL_SKILL_NAME`.
- Tests: `skill-render.test.ts`, `skills.test.ts`, `shared/skills.test.ts`, `e2e-skill-invocation.test.ts`, `native-session.test.ts`.

---

### Task 1: Positional argument substitution (pure function)

**Files:**
- Modify: `server/providers/native/skill-render.ts`
- Test: `server/providers/native/skill-render.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `substituteSkillArguments(body: string, args: string): string` — throws `Error` when accumulated size > 4,000,000 chars.
  - `splitSkillArgs(args: string): string[]` — quote-aware tokens, whitespace fallback.

- [ ] **Step 1: Write the failing tests** — add a `describe('substituteSkillArguments')` block to `skill-render.test.ts` (import the new function). Cases (each `it`, exact expectation):

```ts
it('substitutes $ARGUMENTS with the whole raw args', () => {
  expect(substituteSkillArguments('Run: $ARGUMENTS', 'a b')).toBe('Run: a b')
})
it('substitutes $N and $ARGUMENTS[N] 0-based', () => {
  expect(substituteSkillArguments('$0/$1', 'a b')).toBe('a/b\n\nARGUMENTS: a b')
  expect(substituteSkillArguments('$ARGUMENTS[0]', 'a b')).toBe('a\n\nARGUMENTS: a b')
})
it('leaves out-of-range indices literal', () => {
  expect(substituteSkillArguments('$5', 'a b')).toBe('$5\n\nARGUMENTS: a b')
  expect(substituteSkillArguments('$ARGUMENTS[9]', 'a b')).toBe('$ARGUMENTS[9]\n\nARGUMENTS: a b')
})
it('appends ARGUMENTS when $ARGUMENTS is absent and args non-empty', () => {
  expect(substituteSkillArguments('Body', 'a b')).toBe('Body\n\nARGUMENTS: a b')
})
it('still appends ARGUMENTS when only $N matched (no $ARGUMENTS)', () => {
  expect(substituteSkillArguments('$0', 'a b')).toBe('a\n\nARGUMENTS: a b')
})
it('does not append when $ARGUMENTS matched', () => {
  expect(substituteSkillArguments('$ARGUMENTS', 'a b')).toBe('a b')
})
it('does not append for empty args', () => {
  expect(substituteSkillArguments('Body', '')).toBe('Body')
})
it('renders escaped \\$ literally and still appends ARGUMENTS', () => {
  expect(substituteSkillArguments('\\$ARGUMENTS', 'x')).toBe('$ARGUMENTS\n\nARGUMENTS: x')
})
it('does not re-substitute inserted args text', () => {
  expect(substituteSkillArguments('$ARGUMENTS', '$0')).toBe('$0')
})
it('splits quoted args shell-style', () => {
  expect(substituteSkillArguments('$0/$1', '"a b" c')).toBe('a b/c\n\nARGUMENTS: "a b" c')
})
it('throws past 4,000,000 chars', () => {
  expect(() => substituteSkillArguments('$ARGUMENTS', 'x'.repeat(4_000_001))).toThrow(/4,000,000/)
})
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run server/providers/native/skill-render.test.ts`. Expected: FAIL (`substituteSkillArguments is not a function` / import error).

- [ ] **Step 3: Implement** in `skill-render.ts`:
  - `splitSkillArgs(args)`: tokenize respecting single/double-quoted spans and backslash escapes, strip outer quotes, unescape `\x`; fall back to `args.split(/\s+/).filter(Boolean)` when no tokens. (Lightweight quote-aware tokenizer — a deliberate simplification of the CLI's tree-sitter shell path; native substitutes into instruction text, never executes a shell, so unsafe-node rejection is not needed.)
  - `substituteSkillArguments(body, args)`: protect `\$` via a sentinel; replace in order `$ARGUMENTS[N]` (`/\$ARGUMENTS\[(\d+)\]/g`, 0-based, out-of-range → restore literal), `$N` (`/\$(\d+)(?!\w)/g`, 0-based, out-of-range → literal), `$ARGUMENTS` (whole raw args, set a `matched` flag); wrap inserted values so they are not re-scanned; restore sentinels; if `!matched && args` append `\n\nARGUMENTS: ${args}`. Track accumulated size (start at `body.length`, add `max(raw, inserted)` per replacement incl. the append); throw `Error('...more than 4,000,000 characters...')` when > 4,000,000. Lazy-split args via `splitSkillArgs` only when an index form is present.

- [ ] **Step 4: Run to verify pass** — `npx vitest run server/providers/native/skill-render.test.ts`. Expected: PASS (new block; existing `renderNativeSkillBody`/`renderNativeSkillToolResult` blocks still green).

- [ ] **Step 5: Commit**

```bash
git add server/providers/native/skill-render.ts server/providers/native/skill-render.test.ts
git commit -m "feat(native): positional skill argument substitution

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: Wire substitution into both invocation paths

**Files:**
- Modify: `server/providers/native/skill-render.ts` (`renderNativeSkillBody`, remove `renderNativeSkillToolResult`)
- Modify: `server/providers/native/skills.ts:222-240` (`bodyOfFor`/`expandFor`/`canonicalBodyOf`), `:43-59` (view interfaces)
- Modify: `server/providers/native/native-session.ts:204-223` (`skillInvocationForTurn`), `:613-617` (`skillToolFor`)
- Modify: `server/providers/native/tools/skill.ts:27-35`
- Test: `server/providers/native/skill-render.test.ts`, `server/providers/native/e2e-skill-invocation.test.ts`, `server/providers/native/tools/skill.test.ts`, `server/providers/native/e2e-skills.test.ts`, `server/providers/native/native-session.test.ts`
- Modify: `.agents/notes/implemented/architecture/2026-11-12-native-skill-invocation-recovery.md` (owning note → new contract; CLAUDE.md same-change rule)

> Scope ruling (execution): the contract change breaks pins beyond the original line deltas — `tools/skill.test.ts` (`## User Request` + whitespace-only args now append, CLI-faithful), `e2e-skills.test.ts` (slash-body pins), `native-session.test.ts` (~10 body pins; the two asserting the OLD "args stay only in raw" contract are REWORKED to the new contract, not deleted), and extra `e2e-skill-invocation.test.ts` body pins. All update in the same commit; no replay/fork/compact path changes.

**Interfaces:**
- Consumes: `substituteSkillArguments` (Task 1).
- Produces:
  - `renderNativeSkillBody(input: { directory: string; document: string; args?: string }): string` — `args` defaults `''`; builds the canonical prefix+body then substitutes.
  - `NativeSkillView.bodyOf(name: string, args?: string): { text: string; isError?: boolean }` and `expand(name: string, args?: string): { name: string; body: string } | null` (args defaults `''`).
  - `renderNativeSkillToolResult` is DELETED.

- [ ] **Step 1: Update the unit pins (failing)** — in `skill-render.test.ts`:
  - Repurpose the "Keep $ARGUMENTS verbatim" test: pass `args: 'do X'` and expect the body line `Keep do X verbatim.` (substitution applied). Rename it to "substitutes $ARGUMENTS into the body".
  - Delete the `describe('renderNativeSkillToolResult')` block (function removed).
  - Add: `renderNativeSkillBody({ directory, document, args: 'a b' })` on a body `X $0` yields `X a` plus the `\n\nARGUMENTS: a b` append (no `$ARGUMENTS` present).

- [ ] **Step 2: Run to verify failure** — `npx vitest run server/providers/native/skill-render.test.ts`. Expected: FAIL (args ignored / removed function still referenced).

- [ ] **Step 3: Implement the threading:**
  - `skill-render.ts`: `renderNativeSkillBody` accepts `args` (default `''`), returns `substituteSkillArguments(prefix + body, args)`. Delete `renderNativeSkillToolResult`.
  - `skills.ts`: `canonicalBodyOf(entry, args)` passes args to `renderNativeSkillBody`; `expandFor(name, policy, args)` and `bodyOfFor(name, policy, args)` forward args; `view`/`snapshot` signatures `expand(name, args?)`, `bodyOf(name, args?)` default `''`.
  - `native-session.ts`: `skillInvocationForTurn` returns `skills.expand(match[1], match[2] ?? '')`; `skillToolFor` wraps `bodyOf: (name, args) => view.bodyOf(name, args)`.
  - `tools/skill.ts`: `run` reads `args`, calls `catalog.bodyOf(input.skill, args)`, returns `{ text: result.text }` on success (no suffix helper).

- [ ] **Step 4: Run unit pass** — `npx vitest run server/providers/native/skill-render.test.ts server/providers/native/skills.test.ts`. Expected: PASS.

- [ ] **Step 5: Update the e2e pins to the new contract** — in `e2e-skill-invocation.test.ts` (demo skill body `DEMO-V1\n` has no placeholder, so args ride the `ARGUMENTS:` append):
  - Line 342: `const body = canonicalBody(cwd, 'demo', demoV1) + '\n\nARGUMENTS: do X'`.
  - Line 351: change `.toHaveLength(1)` → `.toHaveLength(2)` (args now in raw turn AND the appended body).
  - Lines 367-369 comment + line 376 tool expectation: `text: canonicalBody(cwd, 'demo', demoV1) + '\n\nARGUMENTS: TOOL ARGS'` (the `## User Request` suffix is gone).
  - The fork/resume pins reuse `body` (now the substituted form) — unchanged structurally; the recovery consistency (identical body across live/fork/resume) still holds.

- [ ] **Step 6: Run e2e to verify pass** — `npx vitest run server/providers/native/e2e-skill-invocation.test.ts server/providers/native/e2e-skills.test.ts`. Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/providers/native/skill-render.ts server/providers/native/skills.ts server/providers/native/native-session.ts server/providers/native/tools/skill.ts server/providers/native/skill-render.test.ts server/providers/native/e2e-skill-invocation.test.ts server/providers/native/tools/skill.test.ts server/providers/native/e2e-skills.test.ts server/providers/native/native-session.test.ts .agents/notes/implemented/architecture/2026-11-12-native-skill-invocation-recovery.md
git commit -m "feat(native): substitute skill args in slash and tool paths

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: Canonical `plugin:skill` name grammar

**Files:**
- Modify: `shared/skills.ts:14` (add canonical export beside `VALID_SKILL_NAME`)
- Modify: `server/providers/native/native-session.ts:198` (`SKILL_COMMAND_RE`)
- Test: `shared/skills.test.ts`, `server/providers/native/skills.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `CANONICAL_SKILL_NAME_SOURCE = '[A-Za-z0-9][A-Za-z0-9._-]{0,79}(?::[A-Za-z0-9][A-Za-z0-9._-]{0,79})?'` (string, no anchors).
  - `CANONICAL_SKILL_NAME = new RegExp('^' + CANONICAL_SKILL_NAME_SOURCE + '$')`.
  - `SKILL_COMMAND_RE = new RegExp('^/(' + CANONICAL_SKILL_NAME_SOURCE + ')(?:\\s+([\\s\\S]*))?$')`.

- [ ] **Step 1: Write the failing grammar test** — add to `shared/skills.test.ts` (import `CANONICAL_SKILL_NAME`):

```ts
describe('CANONICAL_SKILL_NAME', () => {
  it.each(['demo', 'my.skill', 'a-b_c', 'plugin:skill', 'superpowers:brainstorming'])('accepts %s', (n) => {
    expect(CANONICAL_SKILL_NAME.test(n)).toBe(true)
  })
  it.each(['plugin:', ':skill', 'a::b', 'a:b:c', '-bad', ''])('rejects %s', (n) => {
    expect(CANONICAL_SKILL_NAME.test(n)).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run shared/skills.test.ts`. Expected: FAIL (export missing).

- [ ] **Step 3: Implement** — add the two exports to `shared/skills.ts` (browser-safe, no Node imports). In `native-session.ts` import `CANONICAL_SKILL_NAME_SOURCE` and rebuild `SKILL_COMMAND_RE` from it (keep the existing args capture group). `VALID_SKILL_NAME` is unchanged.

- [ ] **Step 4: Write the catalog forward-compat test (failing)** — add to `skills.test.ts` a `describe('canonical plugin names')`: stub the skill port so `listSkills` resolves one valid record `{ name: 'plugin:skill', scope: 'project', description: 'd', path: join(project, '.claude', 'skills', 'plugin:skill'), valid: true, ... }` (a `:` name discovery cannot yet produce on Windows); `catalog.reload()`; assert `catalog.commands().map(c => c.name)` contains `'plugin:skill'` and `catalog.expand('plugin:skill', 'a b')!.body` ends with `\n\nARGUMENTS: a b`.

- [ ] **Step 5: Run to verify pass** — `npx vitest run shared/skills.test.ts server/providers/native/skills.test.ts`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add shared/skills.ts shared/skills.test.ts server/providers/native/native-session.ts server/providers/native/skills.test.ts
git commit -m "feat(native): accept plugin:skill canonical name grammar

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: Budgeted model listing

**Files:**
- Modify: `server/providers/native/skills.ts` (budget field + setter + shared budgeted renderer; `sectionFor`/`listingFor`/`snapshot`)
- Modify: `server/providers/native/native-session.ts:1942-1978` (`getContextUsage` sets budget)
- Test: `server/providers/native/skills.test.ts`, `server/providers/native/native-session.test.ts`

**Interfaces:**
- Consumes: `estimateText` from `./estimate.js` (neutral sibling).
- Produces:
  - `LISTING_BUDGET_FRACTION = 0.01` (exported from `skills.ts`).
  - `NativeSkillCatalog.setListingBudget(tokens: number): void`; private `listingBudget` defaults to `DEFAULT_LISTING_BUDGET_TOKENS = 2000` (= floor(200000 × 0.01); a local fallback, NOT imported from `model-context.ts`).
  - `snapshot()` copies `listingBudget`.
  - One private `budgetedLines(policy): Array<{ name; source; line }>` consumed by BOTH `sectionFor` and `listingFor`.

- [ ] **Step 1: Write the failing budget tests** — add a `describe('NativeSkillCatalog — listing budget')` to `skills.test.ts` using the existing `writeSkill`/`load` helpers:

```ts
it('truncates descriptions to fit the budget, keeping every name', async () => {
  await writeSkill('alpha', { description: 'A'.repeat(400) })
  await writeSkill('beta', { description: 'B'.repeat(400) })
  const catalog = await load('all')
  catalog.setListingBudget(40) // far below two full descriptions
  const section = catalog.section()
  expect(section).toContain('- alpha')
  expect(section).toContain('- beta')
  expect(estimateText(section)).toBeLessThanOrEqual(40)
})
it('keeps section and listing consistent under budget', async () => {
  await writeSkill('alpha', { description: 'A'.repeat(400) })
  const catalog = await load('all')
  catalog.setListingBudget(20)
  const view = catalog.view('all')
  const { listed } = view.listing()
  expect(view.section()).toBe(`<available_skills>\n${listed.map(s => s.line).join('\n')}\n</available_skills>`)
})
it('never drops a name when the name-only floor exceeds the budget', async () => {
  await writeSkill('alpha', { description: 'A'.repeat(400) })
  await writeSkill('beta', { description: 'B'.repeat(400) })
  const catalog = await load('all')
  catalog.setListingBudget(1)
  expect(catalog.section()).toContain('- alpha')
  expect(catalog.section()).toContain('- beta')
})
it('is a no-op for name-only (default) listings', async () => {
  await writeSkill('alpha')
  const catalog = await load(undefined)
  catalog.setListingBudget(1)
  expect(catalog.section()).toBe('<available_skills>\n- alpha\n</available_skills>')
})
```

(import `estimateText` from `./estimate.js` in the test file.)

- [ ] **Step 2: Run to verify failure** — `npx vitest run server/providers/native/skills.test.ts`. Expected: FAIL (`setListingBudget is not a function`).

- [ ] **Step 3: Implement the budget** in `skills.ts`:
  - Add `LISTING_BUDGET_FRACTION`, `DEFAULT_LISTING_BUDGET_TOKENS`, private `listingBudget = DEFAULT_LISTING_BUDGET_TOKENS`, and `setListingBudget(tokens)`.
  - Add `budgetedLines(policy)`: build the full listed rows via `lineFor`; while `estimateText(sectionOf(rows)) > listingBudget` and any row still carries a description, convert the LAST such row (reverse alphabetical) to its name-only line `- name`; stop at the name-only floor (best-effort, names never dropped). Return rows.
  - `sectionFor` joins `budgetedLines` into `<available_skills>`; `listingFor` maps the SAME rows to `{ name, source, line }`. `snapshot()` copies `listingBudget`.

- [ ] **Step 4: Run unit pass** — `npx vitest run server/providers/native/skills.test.ts`. Expected: PASS (incl. the pre-existing `view.listing` consistency test at :412).

- [ ] **Step 5: Wire the refresh trigger** — in `native-session.ts` `getContextUsage`, after `contextWindow` resolves (inside the generation loop, before `return`), call `this.skills.setListingBudget(Math.floor(contextWindow * LISTING_BUDGET_FRACTION))` (import the fraction). Default budget applies until the first resolve; the post-turn probe refreshes it, so a model down-switch shrinks the cap on the next turn.

- [ ] **Step 6: Add the integration pin** — in `native-session.test.ts`, extend the skills-payload test region (~:932) with a case: a project skill with a long description, `skills: 'all'`, a small resolved `contextWindow` (via the existing `resolverOf` helper); after a turn, `usage.skills.skillFrontmatter` tokens equal `estimateText` of the truncated lines and `usage.skills.tokenCount` matches the Skills category row (section/listing agree under budget).

- [ ] **Step 7: Run to verify pass** — `npx vitest run server/providers/native/skills.test.ts server/providers/native/native-session.test.ts`. Expected: PASS.

- [ ] **Step 8: Full gate + commit** — `npm run typecheck` (both tsconfigs) and `npx vitest run server/providers/native` green, then:

```bash
git add server/providers/native/skills.ts server/providers/native/native-session.ts server/providers/native/skills.test.ts server/providers/native/native-session.test.ts
git commit -m "feat(native): budget the available_skills model listing

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Final verification

- [ ] `npm run typecheck` (browser + node tsconfigs) clean.
- [ ] `npx vitest run server/providers/native shared/skills.test.ts` green.
- [ ] `npm run lint` clean on touched files.
- [ ] Whole-branch code review (per CLAUDE.md: never commit unreviewed code) before merge.