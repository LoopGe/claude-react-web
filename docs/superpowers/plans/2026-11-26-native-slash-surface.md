# Native Slash Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the native provider a builtin slash-command surface — `/compact` triggers native compaction, `/init` and `/review` run as builtin prompt commands, and custom `.claude/commands/*.md` are discovered and expanded host-side — surfaced in `supportedCommands` alongside skills.

**Architecture:** Command handling stays host-side in the native session, consistent with skill invocation. A discovery/catalog module finds custom commands (user/project `.claude/commands`) and holds builtin prompt templates (`/init`, `/review`); the native turn loop intercepts a leading `/commandname` before skill matching and expands it to a prompt body via the existing dual-event model (raw user turn + hidden instruction event), reusing `substituteSkillArguments` for `$ARGUMENTS`. `/compact` is special: it signals the manager's in-place compaction flow through a host-bound callback rather than expanding to text.

**Tech Stack:** TypeScript, Node, the native neutral vocabulary + session loop, `server/skills.ts` discovery pattern, vitest (server tests in Node).

**Spec:** `docs/superpowers/specs/2026-11-26-native-capability-fills-design.md` (G3)

## Global Constraints

- **Distinct from the skill-parity A/B/C batches.** Do NOT modify `server/providers/native/skills.ts`, `server/plugin-skills.ts`, or `skill-render.ts` logic. REUSE `substituteSkillArguments` (already implements the CLI `$ARGUMENTS`/`$N` contract) — do not reimplement substitution.
- `$ARGUMENTS` substitution is ALREADY DONE; this plan consumes it.
- CLI-ecosystem commands (`/login`, `/logout`, `/upgrade`, `/doctor`, `/ide`, …) stay ABSENT on native (locked; they appear only with the CLI in a later phase). Do not add them.
- UI-equivalent builtins (`/model`, `/usage`, `/config`, …) are optional local-command deep-links — OUT OF SCOPE here (deferred).
- Native core stays neutral (discovery/catalog module imports only neutral siblings + Node builtins; manager callbacks ride the host adapter / opts seam). `neutrality.test.ts` / `host-free.test.ts` green.
- The claude provider and SDK contract are NOT modified. Skill invocation behavior is UNCHANGED (no regression).
- Command names are lowercase `/name` (the CLI slash grammar), NOT PascalCase tools.
- Implementation isolates in a worktree branched from current `main`.
- Verify: `npm run typecheck`, `npx vitest run <path>`, `npm run lint`.

## Review Focus

- **`/compact` compacts, not chats.** A native `/compact` triggers in-place compaction (the manager's host-driven path), never passes the literal text to the model. A reasonable user expects the context compressed, not a model reply about compacting.
- **`/init` / `/review` expand to prompts.** Typing them injects the builtin template body as an instruction the model acts on (like a skill), not a literal `/init` message.
- **Custom commands discovered + expanded.** A `.claude/commands/foo.md` (project) and user-root command appear in the slash picker and expand with `$ARGUMENTS` substituted; project wins on name collision (mirror skills).
- **Catalog completeness + freshness.** `supportedCommands` returns builtin + custom + skill rows; a discovery change broadcasts `commands-changed`.
- **Skill invocation unchanged.** `/skillname` still expands exactly as before; a custom command and a skill of the same name resolve deterministically (command wins, mirroring DSH/CLI).
- **Unknown commands pass through.** A `/nonexistent` that matches no builtin/custom/skill is NOT swallowed — it reaches the model as ordinary text (current behavior).
- **Path safety.** Custom-command discovery rejects `..`/absolute escapes (mirror `ensureInside` in skills.ts).

---

### Task 1: Command discovery + builtin catalog

**Files:**
- Create: `server/providers/native/commands.ts`
- Test: `server/providers/native/commands.test.ts`

**Interfaces:**
- Consumes: `substituteSkillArguments` from `./skill-render.js` (reuse, do not modify); the `server/skills.ts` discovery pattern (skillRoot/ensureInside/frontmatter) as a reference — but commands live in `.claude/commands`, a separate root.
- Produces:
  - `export interface NativeCommand { name: string; description: string; argumentHint: string; builtin: boolean; body?: string }` (builtin rows carry a template `body`; custom rows carry the file body).
  - `export const BUILTIN_COMMANDS: NativeCommand[]` — `/init` and `/review` with prompt-template bodies (builder writes sensible templates: /init analyzes the repo and writes CLAUDE.md; /review reviews the current diff/changes).
  - `export async function discoverCommands(cwd: string | undefined, userRoot: string): Promise<NativeCommand[]>` — scans project `<cwd>/.claude/commands/*.md` + user `<userRoot>/commands/*.md`, parses frontmatter (name/description/argument-hint), project wins on collision, path-safe.
  - `export function expandCommandBody(cmd: NativeCommand, args: string): string` — returns the body with `substituteSkillArguments(body, args)`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest'
import { BUILTIN_COMMANDS, discoverCommands, expandCommandBody } from './commands.js'

describe('builtin catalog', () => {
  it('includes /init and /review as builtin with non-empty bodies', () => {
    const names = BUILTIN_COMMANDS.map((c) => c.name)
    expect(names).toContain('init')
    expect(names).toContain('review')
    for (const c of BUILTIN_COMMANDS) { expect(c.builtin).toBe(true); expect(c.body!.length).toBeGreaterThan(0) }
  })
})
describe('discoverCommands', () => {
  it('discovers a project command with frontmatter', async () => {
    // tmp cwd with .claude/commands/foo.md (frontmatter description + argument-hint)
    const cmds = await discoverCommands(tmpCwd, tmpUserRoot)
    const foo = cmds.find((c) => c.name === 'foo')
    expect(foo).toBeTruthy(); expect(foo!.builtin).toBe(false); expect(foo!.description).toBeTruthy()
  })
  it('project wins on name collision with user root', async () => { /* both roots define foo; project body wins */ })
  it('rejects path escape', async () => { /* a symlink/.. escape is skipped or throws, never reads outside root */ })
})
describe('expandCommandBody', () => {
  it('substitutes $ARGUMENTS via the shared contract', () => {
    const cmd = { name: 'x', description: '', argumentHint: '', builtin: false, body: 'Run $ARGUMENTS now' }
    expect(expandCommandBody(cmd, 'tests')).toBe('Run tests now')
  })
})
```

Use real tmp dirs (fs) for discovery tests; mirror the skills test fixture pattern.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/providers/native/commands.test.ts`
Expected: FAIL — cannot resolve `./commands.js`.

- [ ] **Step 3: Implement `commands.ts`**

Mirror `server/skills.ts` discovery (readdir `.md` files, frontmatter parse, `ensureInside` path safety, project-wins dedupe) but for `.claude/commands` roots and flat `.md` files (not skill subdirectories). Builtin `/init` `/review` templates are host-authored prompt bodies. `expandCommandBody` delegates to `substituteSkillArguments`. Keep the module neutral (Node builtins + sibling skill-render import only; the userRoot is passed in, not derived from host config inside core).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/providers/native/commands.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/providers/native/commands.ts server/providers/native/commands.test.ts
git commit -m "feat(native): command discovery + builtin /init /review catalog"
```

---

### Task 2: Native command expansion + supportedCommands integration

**Files:**
- Modify: `server/providers/native/native-session.ts` (turn invocation ~1645-1716; `supportedCommands` ~2401; command catalog wiring + reload)
- Test: `server/providers/native/e2e-slash.test.ts` (create)

**Interfaces:**
- Consumes: Task 1 `discoverCommands`/`BUILTIN_COMMANDS`/`expandCommandBody`/`NativeCommand`; the existing skill dual-event expansion seam (`skillInvocationForTurn` + hidden `session/skill` event at ~1710-1716) as the pattern.
- Produces: the native turn loop intercepts a leading `/commandname` (builtin or custom) BEFORE skill matching, expands the body, and persists it via the dual-event model (raw user turn + hidden instruction event — reuse the skill event shape or a sibling `session/command` event, builder's choice consistent with replay). `supportedCommands()` returns builtin + custom + skill rows. A command-catalog reload broadcasts `commands-changed`.

- [ ] **Step 1: Write the failing tests**

```ts
// e2e-slash.test.ts — scripted-provider harness (see e2e-plan-mode.test.ts / e2e-structured.test.ts)
it('supportedCommands includes builtin /init /review + a custom command + skills', async () => {
  const { session } = await startNativeSession({ /* tmp cwd with .claude/commands/foo.md */ })
  const names = (await session.supportedCommands()).map((c) => c.name)
  expect(names).toContain('init'); expect(names).toContain('review'); expect(names).toContain('foo')
})
it('/init expands to the builtin template body (model sees instruction, not literal /init)', async () => {
  const { session, requests } = await startNativeSession()
  await sendTurn(session, '/init')
  const msgs = requests.at(-1).messages
  expect(JSON.stringify(msgs)).toContain(BUILTIN_COMMANDS.find((c) => c.name === 'init')!.body.slice(0, 40))
})
it('/foo args expands the custom body with $ARGUMENTS substituted', async () => { /* custom foo body 'Do $ARGUMENTS'; /foo X → model sees 'Do X' */ })
it('/skillname still expands as before (no regression)', async () => { /* existing skill invocation unchanged */ })
it('/nonexistent passes through to the model as text', async () => {
  const { session, requests } = await startNativeSession()
  await sendTurn(session, '/nonexistent hello')
  expect(JSON.stringify(requests.at(-1).messages)).toContain('/nonexistent hello')
})
it('command wins over a same-name skill', async () => { /* deterministic resolution */ })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/providers/native/e2e-slash.test.ts`
Expected: FAIL — commands not surfaced/expanded.

- [ ] **Step 3: Implement expansion + catalog integration**

Add a command catalog to the session (discovered at construction + reloadable, mirroring the skill catalog's `skillsReady`/reload pattern). In the turn loop, before `skillInvocationForTurn`, match a leading `/name` against builtin+custom commands; on a hit, expand via `expandCommandBody` and persist the dual-event (raw user + hidden instruction). On no command hit, fall through to skill matching, then to plain text (unknown commands pass through). `supportedCommands` concatenates builtin + custom + skill rows (dedupe by name, command wins). Wire a reload that re-discovers and broadcasts `commands-changed` (reuse the existing broadcast path the skill reload uses).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/providers/native/e2e-slash.test.ts server/providers/native/native-session.test.ts server/providers/native/e2e-skills.test.ts`
Expected: PASS (no skill regression).

- [ ] **Step 5: Commit**

```bash
git add server/providers/native/native-session.ts server/providers/native/e2e-slash.test.ts
git commit -m "feat(native): host-side slash command expansion + supportedCommands catalog"
```

---

### Task 3: `/compact` compaction trigger

**Files:**
- Modify: `server/providers/native/native-session.ts` (intercept `/compact`; host callback)
- Modify: `server/providers/types.ts` (`CreateSessionOptions` callback) + `server/providers/native/native-provider.ts` + `server/session-manager.ts` (bind callback to the in-place compaction flow)
- Test: `server/providers/native/e2e-slash.test.ts`

**Interfaces:**
- Consumes: the manager's in-place compaction path (`compactInPlace`, `native-session.ts:2037`; the manager's host-driven auto-compact flow that summarizes + calls `compactInPlace`); the host-callback seam pattern from G1 (`requestPermissionModeChange`).
- Produces: `CreateSessionOptions.requestCompact?: () => Promise<void>` (or similar) bound by the manager to its in-place compaction flow; the native session intercepts `/compact` (before command/skill expansion) and invokes the callback instead of expanding text. `/compact` is a builtin row in `supportedCommands`.

- [ ] **Step 1: Write the failing tests**

```ts
it('/compact invokes the compaction callback, not a model turn', async () => {
  const requestCompact = vi.fn(async () => {})
  const { session, requests } = await startNativeSession({ requestCompact })
  await sendTurn(session, '/compact')
  expect(requestCompact).toHaveBeenCalledOnce()
  // no model request carrying literal '/compact' as a user prompt
})
it('/compact appears in supportedCommands as builtin', async () => {
  const { session } = await startNativeSession()
  expect((await session.supportedCommands()).map((c) => c.name)).toContain('compact')
})
it('manager binding triggers in-place compaction (integration)', async () => {
  // native-default manager; /compact → manager compaction flow runs (compactInPlace path), session stays same id
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/providers/native/e2e-slash.test.ts -t "compact"`
Expected: FAIL — `/compact` not intercepted / callback absent.

- [ ] **Step 3: Implement the trigger**

Add the host callback to `CreateSessionOptions`; the manager binds it to its in-place compaction flow (the same path host-driven auto-compact uses — summarize + `compactInPlace`, manager owns the divider/reset). The native session intercepts a leading `/compact` before command/skill expansion and awaits the callback (no model turn for the literal text). Add `/compact` to the builtin catalog rows. Builder settles the exact compaction wiring (in-place `compactInPlace`, NOT the `/handoff` continuation `manager.compact`); if the session is mid-turn, follow the manager's existing idle/compact gating.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/providers/native/e2e-slash.test.ts server/providers/native/native-session.test.ts`
Expected: PASS.

- [ ] **Step 5: Final verification + commit**

Run: `npm run typecheck && npm run lint && npx vitest run server/providers/native/vocabulary/neutrality.test.ts server/providers/native/host-free.test.ts`
Expected: PASS.

```bash
git add server/providers/native/native-session.ts server/providers/types.ts server/providers/native/native-provider.ts server/session-manager.ts server/providers/native/e2e-slash.test.ts
git commit -m "feat(native): /compact triggers in-place compaction via host callback"
```

---

### Task 4: Owning agent note

**Files:**
- Create: `.agents/notes/implemented/feature/2026-11-26-native-slash-surface.md`

**Interfaces:**
- Consumes: the decisions above; `.agents/notes/README.md` contract.
- Produces: a decision record capturing host-side command handling (consistent with skill invocation), the discovery roots + project-wins dedupe, reuse of `substituteSkillArguments`, the dual-event expansion, `/compact` in-place (vs `/handoff` continuation), the locked CLI-ecosystem commands, and deferred follow-ups (UI-equivalent builtin deep-links; command-vs-skill precedence policy; fs-watcher freshness if not added).

- [ ] **Step 1: Write the note** per the README contract (Problem → Decision → Alternatives considered → Consequences; `Status: implemented`; relative links to the spec + skill-parity spec).

- [ ] **Step 2: Verify structure**

Run: `npm run verify:agent-notes`
Expected: OK.

- [ ] **Step 3: Commit**

```bash
git add .agents/notes/implemented/feature/2026-11-26-native-slash-surface.md
git commit -m "docs(native): owning agent note for native slash surface"
```

---

## Self-Review

**Spec coverage:** G3 `/compact` (Task 3), `/init`/`/review` builtin templates (Tasks 1–2), custom `.claude/commands` discovery + expansion (Tasks 1–2), `supportedCommands` rows + `commands-changed` (Task 2), CLI-ecosystem locked (Global Constraints), `$ARGUMENTS` reuse not reimplement (Task 1), agent note (Task 4). UI-equivalent deep-links explicitly out of scope. All G3 spec bullets map to a task or an explicit exclusion.

**Review Focus coverage:** /compact compacts (Task 3), /init/review expand (Task 2), custom discovered+expanded (Tasks 1–2), catalog completeness/freshness (Task 2), skill unchanged (Task 2 regression test), unknown passthrough (Task 2), path safety (Task 1).

**Type consistency:** `NativeCommand` / `BUILTIN_COMMANDS` / `discoverCommands` / `expandCommandBody` / `requestCompact` consistent across tasks; reuses `substituteSkillArguments`.

**Proportion:** code blocks are test assertions + signatures; bodies (templates, discovery, compaction wiring) left to the implementer with named decisions.