# Native Memory + Behavior Guidance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Native sessions load the CLI's core CLAUDE.md source chain (worktree-aware), carry the CLI's behavior/tone guidance and an environment section, and stop prefixing `cd` to Bash commands.

**Architecture:** A host-side memory reader (pure fs, no git subprocess) enters the neutral core through a seventh `NativeHostPorts` port; the core appends memory + environment overlays to the stable per-session base prompt each turn. Behavior sections are static registry entries between identity and tool guidance. The Bash tool description states native's real execution semantics.

**Tech Stack:** TypeScript (Node 20), vitest (node env for server tests), existing `PromptSectionRegistry` / `NativeHostPorts` / `estimateText` infrastructure.

**Spec:** `docs/superpowers/specs/2026-11-27-native-memory-and-behavior-design.md`
**CLI source text reference:** `docs/superpowers/specs/2026-11-27-cli-prompt-extracts.md`

## Global Constraints

- Neutral core (`server/providers/native/**` production files) imports ONLY `shared/*`, Node builtins, sibling vocabulary/native modules. The new host reader lives OUTSIDE `native/`; `ports.ts` stays fully neutral (pinned by `host-free.test.ts` NEUTRAL_MODULES and `vocabulary/neutrality.test.ts`).
- Diagnostics through `createLogger(scope)`; never bare `console.*`.
- Exact values: per-file cap `1_048_576` bytes; project candidates exactly `['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md']`; user file `<claudeConfigDir()>/CLAUDE.md`; load order user first, then ancestors root→cwd.
- The reader uses NO git subprocess — worktree origin resolution parses the `.git` pointer file's `gitdir:` line (pure fs).
- Do not modify: `contextSnapshot` (`session-log/replay.ts`), `FILE_REFERENCE_GUIDANCE` / `withFileReferenceGuidance`, the manager's spawn funnel, `runStructured` (headless runs get no memory overlay).
- Typecheck BOTH tsconfigs (`npm run typecheck`). Server tests run in node env.
- Work on a feature branch (the shared live tree carries other sessions' uncommitted changes — do not touch them). Commit style `feat(native): …` / `test(native): …`, end messages with `Co-Authored-By: Claude Code <noreply@anthropic.com>`. Repo rule: the full diff passes `code-review` before anything lands on `main` (the execution skill's review gate).

## Review Focus

- **Mid-session CLAUDE.md edit** → the next turn's system prompt reflects it without a respawn (mtime cache invalidation). Task 3 test.
- **Worktree branch behind main (divergent CLAUDE.md)** → the worktree's checked-out version wins, injected exactly once; origin's `CLAUDE.local.md` still loads. Task 1 fixtures.
- **Non-git cwd** → no crash, `isGitRepo: false`, user-global file still loads. Task 1 fixture.
- **Over-cap (>1 MiB) CLAUDE.md** → skipped and logged, sibling files still load, session unaffected. Task 1 fixture.
- **Prompt-cache prefix stability** → two consecutive same-day turns with unchanged memory produce byte-identical system strings (day-granularity date, no timestamps). Task 3 test.

---

### Task 1: Host memory reader + memory port + wiring

**Files:**
- Create: `server/providers/native-host-memory.ts`
- Modify: `server/providers/native/ports.ts` (add types + `memory` field on `NativeHostPorts`)
- Modify: `server/providers/native-host-adapters.ts:25-40` (`NativeHostPortsDeps`), `:78-105` (return object)
- Modify: `server/providers/native/host-free.test.ts` (HOST_SERVICE_MODULES ban list)
- Test: `server/providers/native-host-memory.test.ts` (create)

**Interfaces:**
- Consumes: `claudeConfigDir()` from `server/claude-config-dir.js`; `createLogger` from `server/log.js`.
- Produces (later tasks rely on these exact shapes):
  ```ts
  // ports.ts (neutral)
  export interface NativeMemoryFile { path: string; scope: 'user' | 'project' | 'local'; content: string }
  export interface NativeMemoryReadResult { files: NativeMemoryFile[]; isGitRepo: boolean }
  export interface NativeMemoryPort { read(cwd: string): Promise<NativeMemoryReadResult> }
  // NativeHostPorts gains: memory: NativeMemoryPort
  // native-host-memory.ts (host-side)
  export function createMemoryReader(deps?: { configDir?: string }): NativeMemoryPort
  // NativeHostPortsDeps gains: memory?: NativeMemoryPort  (test override; default = createMemoryReader())
  ```

- [ ] **Step 1: Write the failing tests** (`server/providers/native-host-memory.test.ts`, vitest node env, tmpdir fixtures via `mkdtempSync` + `cleanup` in `afterEach`)

Test names and assertions (each builds real fixture dirs; `configDir` injected so the developer's own `~/.claude` is never read):
  - `loads user file first, then ancestors root-to-cwd` — configDir/CLAUDE.md `U`, repoRoot/CLAUDE.md `R` (repoRoot has a `.git` DIRECTORY), repoRoot/sub/CLAUDE.md `S`, cwd=repoRoot/sub → `files.map(f => f.content)` = `['U','R','S']`; scopes `['user','project','project']`; `isGitRepo: true`; paths absolute.
  - `loads .claude/CLAUDE.md and CLAUDE.local.md variants` — repoRoot has all three candidates → order `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`; local file scope `'local'`.
  - `non-git cwd loads only the user file` — no `.git` anywhere → `files` = user only, `isGitRepo: false`.
  - `missing candidates are skipped silently` — empty repo → `files: []` (no user file), no throw.
  - `over-cap file is skipped, siblings load` — CLAUDE.md of 1_048_577 bytes, CLAUDE.local.md small → only local loads.
  - `in-repo worktree: worktree version wins, origin local file loads, no double injection` — origin fixture (`.git` dir + CLAUDE.md `ORIGIN` + CLAUDE.local.md `LOCAL`); worktree dir INSIDE origin at `.claude/worktrees/wt` with a `.git` FILE containing `gitdir: <origin>/.git/worktrees/wt` (create that gitdir path as a real dir) and its own CLAUDE.md `WT`; cwd=worktree → contents `['WT','LOCAL']` (user absent), exactly one CLAUDE.md entry, `isGitRepo: true`.
  - `out-of-repo worktree: full origin chain loads` — same but worktree dir OUTSIDE origin (sibling tmpdir) → same assertion; additionally origin's parent dir has CLAUDE.md `ABOVE` → contents `['WT','LOCAL','ABOVE']` (origin root→fs-root order places ABOVE after LOCAL).
  - `nested subdirectory cwd keeps repo-relative dedup` — worktree cwd = wt/src with wt/src/CLAUDE.md `SUB`, origin has src/CLAUDE.md `OSUB` → `SUB` wins over `OSUB`, wt/CLAUDE.md still loads.
  - `mtime change invalidates the cache` — read once, rewrite file content AND bump mtime (`utimesSync`), read again → new content.
  - `malformed pointer degrades to boundary stop` — `.git` file with garbage content → worktree's own files load, no origin jump, no throw.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/providers/native-host-memory.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the neutral port types**

In `ports.ts`: the three interfaces above + `memory: NativeMemoryPort` on `NativeHostPorts`. Doc comment: host-side CLAUDE.md chain reader; worktree resolution and caching are host concerns; the core receives text only.

- [ ] **Step 4: Implement `createMemoryReader`** (`server/providers/native-host-memory.ts`)

Logger scope `native-memory`. Per-instance cache `Map<string, { mtimeMs: number; size: number; content: string }>`. Algorithm (the part tests don't fully determine):

```
read(cwd):
  out = []
  loadOne(absPath, scope):            // stat → absent(ENOENT/ENOTDIR/not-file): skip
    size > 1_048_576 → log.warn + skip
    cache hit (mtimeMs+size equal) → reuse; else readFile utf8 → cache
    readFile error other than ENOENT/ENOTDIR → log.warn + skip
    push { path, scope, content }
  loadOne(join(configDir, 'CLAUDE.md'), 'user')

  // phase 1: cwd upward
  chain1 = []; current = resolve(cwd); worktreeRoot = null; repoRoot = null
  loop:
    chain1.push(current)
    gitStat = stat(current/.git)
    if gitStat.isFile():              // worktree pointer
      parse /^gitdir:\s*(.+)$/m → gitdir (resolve relative to current)
      worktreeRoot = current
      originRoot = gitdir minus trailing '/worktrees/<name>' minus trailing '/.git'
      break
    if gitStat.isDirectory(): repoRoot = current   // normal repo; keep walking (CLI parity)
    if current == fs root: break
    current = dirname(current)

  // phase 2 (worktree only): originRoot upward to fs root; follow nested
  // pointer files the same way, ≤8 hops, visited-set cycle guard
  chain2 = worktreeRoot ? ancestors(originRoot → fs root) : []

  // collect: phase1 dirs use key = relative(worktreeRoot ?? repoRoot, path)
  // when at/below that root else absolute; phase2 dirs use relative(originRoot, …)
  // at/below originRoot else absolute. First occurrence of a key wins
  // (worktree version beats origin). Candidate order per dir:
  // ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'];
  // scope = 'local' for CLAUDE.local.md else 'project'.
  // Output order: user, then chain1 reversed (root→cwd), then chain2 reversed.
  isGitRepo = worktreeRoot != null || repoRoot != null
```

`stat` (not `lstat`) so a symlinked CLAUDE.md to a regular file loads (DSH precedent). Malformed pointer: log.warn, treat as boundary stop (no phase 2).

- [ ] **Step 5: Wire the port**

`native-host-adapters.ts`: import `createMemoryReader`; `NativeHostPortsDeps` gains `memory?: NativeMemoryPort`; return object gains `memory: deps.memory ?? createMemoryReader()`. No `default-providers.ts` change (it calls `createNativeHostPorts`).

- [ ] **Step 6: Extend the host-free pin**

`host-free.test.ts`: add `'server/providers/native-host-memory'` to HOST_SERVICE_MODULES.

- [ ] **Step 7: Run tests + typecheck**

Run: `npx vitest run server/providers/native-host-memory.test.ts server/providers/native/host-free.test.ts && npm run typecheck`
Expected: PASS. Fix any existing test that constructs a `NativeHostPorts` literal without `memory` (spread `makeNativePorts()` instead of hand-listing ports).

- [ ] **Step 8: Commit**

```bash
git add server/providers/native-host-memory.ts server/providers/native-host-memory.test.ts server/providers/native/ports.ts server/providers/native-host-adapters.ts server/providers/native/host-free.test.ts
git commit -m "feat(native): host memory reader + memory port (CLAUDE.md chain, worktree-aware)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: Behavior sections

**Files:**
- Create: `server/providers/native/prompt/behavior.ts`
- Modify: `server/providers/native/native-provider.ts:100-114` (`renderSystem`)
- Test: `server/providers/native/prompt/behavior.test.ts` (create)

**Interfaces:**
- Consumes: `PromptSection` from `./sections.js`; adapted text from `docs/superpowers/specs/2026-11-27-cli-prompt-extracts.md` (adaptation rules in that file's header).
- Produces: `export const BEHAVIOR_SECTIONS: readonly PromptSection[]` — seven entries, names/orders: `behavior:communicating` 10, `behavior:tone` 20, `behavior:doing-tasks` 30, `behavior:actions` 40, `behavior:delivering` 50, `behavior:corrections` 60, `behavior:pronouns` 70. Each text starts with its `# ` heading (CLI headings minus product references).

- [ ] **Step 1: Write the failing test**

`behavior.test.ts`:
  - `has the seven sections in order` — names and orders exactly as the Interfaces block.
  - `texts carry the CLI headings` — each text starts with `'# Communicating with the user'`, `'# Tone and style'`, `'# Doing tasks'`, `'# Executing actions with care'`, `'# Delivering work'`, `'# Corrections'`, and the pronouns text contains `'they/them'`.
  - `no product references` — no text contains `'Claude Code'` or `'/help'`.
  - `substance pins` — tone contains `'file_path:line_number'` and the no-colon-before-tool-calls rule; doing-tasks contains `'premature abstraction'` and the no-speculative-error-handling rule; actions contains `'blast radius'`; delivering contains `'requested scope is the deliverable'`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/providers/native/prompt/behavior.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `behavior.ts`**

Adapt the seven reference texts per the reference file's rules (strip product references; keep substance; complete the truncated communicating tail naturally). This is exact-copy work: the reference file is the source, the substance pins above are the contract.

- [ ] **Step 4: Register in `renderSystem`**

After `registry.register(IDENTITY_SECTION)`: `for (const section of BEHAVIOR_SECTIONS) registry.register(section)`. Both prompt variants (parent and subagent) get them — the loop is shared.

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run server/providers/native/prompt/ && npm run typecheck`
Expected: PASS (existing `sections.test.ts` unaffected — it builds its own registries).

- [ ] **Step 6: Commit**

```bash
git add server/providers/native/prompt/behavior.ts server/providers/native/prompt/behavior.test.ts server/providers/native/native-provider.ts
git commit -m "feat(native): port CLI behavior/tone guidance as prompt sections

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: Overlay renderers + per-turn memory/environment assembly

**Files:**
- Create: `server/providers/native/prompt/overlay.ts`
- Modify: `server/providers/native/native-session.ts` — field near `:577`, constructor seed near `:925-927`, turn assembly `:2428-2433`, `subagentSystem` `:1958-1963`
- Test: `server/providers/native/prompt/overlay.test.ts` (create); extend `server/providers/native/native-session.test.ts`

**Interfaces:**
- Consumes: `NativeMemoryFile`, `NativeMemoryReadResult`, `NativeHostPorts.memory` (Task 1); `NativeHostPortsDeps.memory` test override (Task 1); `BEHAVIOR_SECTIONS` registration (Task 2); `withSkillsSection` (existing, native-session.ts).
- Produces:
  ```ts
  // prompt/overlay.ts
  export function joinPromptParts(...parts: string[]): string   // filter non-empty, join '\n\n'
  export function renderMemorySection(files: readonly NativeMemoryFile[]): string
  export function renderEnvironment(input: { cwd: string; isGitRepo: boolean; platform: string; date: Date }): string
  ```
  Exact formats:
  - `renderMemorySection`: `''` when empty; else `'# Memory Files\n\n' + files.map(f => \`Contents of ${f.path} (${label}):\n${f.content}\`).join('\n\n')` where label = `'user instructions'` / `'project instructions'` / `'local project instructions'` by scope.
  - `renderEnvironment`: `'# Environment\nWorking directory: ${cwd}\nIs a git repository: ${isGitRepo}\nPlatform: ${platform}\nToday's date: ${yyyy}-${mm}-${dd}'` where `yyyy-mm-dd` is the LOCAL calendar day via `getFullYear()` / `getMonth() + 1` / `getDate()`, zero-padded — NOT `date.toISOString().slice(0, 10)`, which renders the UTC day and misstates the date around local midnight (day granularity — cache stability).

- [ ] **Step 1: Write the failing renderer tests** (`overlay.test.ts`)

  - `joinPromptParts drops empty parts` — `joinPromptParts('A', '', 'B')` = `'A\n\nB'`; all-empty = `''`.
  - `renderMemorySection empty → ''`.
  - `renderMemorySection formats labels and order` — two files (project, local) → exact string with `Contents of <path> (project instructions):` blocks in input order under `# Memory Files`.
  - `renderEnvironment exact format` — fixed LOCAL date `new Date(2026, 10, 27, 15, 0, 0)` → `Today's date: 2026-11-27` (no time component). Local-time constructors keep the fixtures timezone-independent; a further pin renders the LOCAL day for constructs whose UTC day differs (local 00:30 east of UTC, local 23:30 west of UTC).

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run server/providers/native/prompt/overlay.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `overlay.ts`** (formats above; imports only `../ports.js` types — neutral).

- [ ] **Step 4: Run renderer tests to pass**

Run: `npx vitest run server/providers/native/prompt/overlay.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing session-level tests** (extend `native-session.test.ts`, using the existing `streamSupplier` capture seam and `makeNativePorts({ stateDir, memory: stub })`)

Stub port: `read` returns a controllable `NativeMemoryReadResult` (fixture file content `MEM-FIXTURE`, `isGitRepo: true`).
  - `turn system carries behavior + memory + environment in order` — captured `req.system` contains the behavior headings (Task 2), then `MEM-FIXTURE`, then `# Environment` with the session cwd; index order: persona (when set) < memory < environment < skills section.
  - `memory edit lands on the next turn` — stub returns new content for turn 2 → turn 2 `req.system` contains it, turn 1's does not.
  - `byte-stable system across unchanged same-day turns` — two turns, same stub → `req.system` strings strictly equal.
  - `empty memory omits the section, environment stays` — stub `{ files: [], isGitRepo: false }` → no `'# Memory Files'`, `'# Environment'` present with `Is a git repository: false`.
  - `subagent system inherits memory + environment` — drive an Agent dispatch through the existing subagent test seam (see `e2e-subagent.test.ts` for the pattern); the nested run's captured system contains `MEM-FIXTURE` and `# Environment`, and does NOT contain the Agent delegation section.

- [ ] **Step 6: Run to verify fail**

Run: `npx vitest run server/providers/native/native-session.test.ts`
Expected: new tests FAIL (overlay not assembled).

- [ ] **Step 7: Implement the assembly** (`native-session.ts`)

  - Field: `private memorySnapshot: NativeMemoryReadResult | null = null`.
  - Constructor seed beside the MCP `whenReady` refresh (~`:925`): `void this.opts.ports.memory.read(this.opts.cwd).then((r) => { if (!this._closed) this.memorySnapshot = r }).catch((err) => log.warn(\`[${this.opts.id}] memory seed failed:\`, err))` (fire-and-forget, same closed-guard pattern; a per-turn read failure later surfaces loudly — no catch there).
  - Turn assembly (replace `:2428-2433`):
    ```ts
    const memory = await this.opts.ports.memory.read(this.opts.cwd)
    this.memorySnapshot = memory
    const turnSystem = withSkillsSection(
      joinPromptParts(
        turnProfile?.instruction ? `${this.baseSystem}\n\n${turnProfile.instruction}` : this.baseSystem,
        renderMemorySection(memory.files),
        renderEnvironment({ cwd: this.opts.cwd, isGitRepo: memory.isGitRepo, platform: process.platform, date: new Date() }),
      ),
      skillView.section(),
    )
    ```
  - `subagentSystem`: same overlay from `this.memorySnapshot` (null → empty parts), base = `this.opts.subagentSystem ?? this.baseSystem`, then `withSkillsSection`. Nested runs read the parent's snapshot — no independent port call.
  - Plan guidance per-round append (`:2425` region) untouched.

- [ ] **Step 8: Run the native suite + typecheck**

Run: `npx vitest run server/providers/native/ && npm run typecheck`
Expected: PASS. Existing tests asserting exact full system strings: update them to account for the overlay (or inject an empty memory stub via the Task 1 deps override) — do not weaken assertions to containment unless the test's subject is ordering.

- [ ] **Step 9: Commit**

```bash
git add server/providers/native/prompt/overlay.ts server/providers/native/prompt/overlay.test.ts server/providers/native/native-session.ts server/providers/native/native-session.test.ts
git commit -m "feat(native): per-turn memory + environment overlay in system prompt

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: Bash description + guidance rewrite

**Files:**
- Modify: `server/providers/native/tools/bash.ts:28-31` (description + guidance)
- Test: `server/providers/native/tools/bash.test.ts` (extend)

**Interfaces:**
- Consumes: nothing new.
- Produces: `bashTool.description` and `bashTool.guidance` exact copy below (the spec fixes this wording; the guidance rides the existing `tool:Bash` registry section at order 90).

- [ ] **Step 1: Write the failing test**

In `bash.test.ts`:
  - `description states execution semantics` — `bashTool.description` equals `'Run a shell command and return its output. Every call starts in the session working directory; a \`cd\` does not carry over to the next call, and shell state (env vars, functions) does not persist.'`
  - `guidance keeps exit-code rule and adds the absolute-path strategy` — contains `'[exit code: N]'`, `'absolute paths'`, `'Never prepend \`cd <working-directory>\`'`, and does NOT contain `'permission prompt'` (the CLI-only rationale must not be copied).

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run server/providers/native/tools/bash.test.ts`
Expected: new assertions FAIL.

- [ ] **Step 3: Apply the exact copy**

`guidance`: `'Check the [exit code: N] marker on every bash result; investigate failures before moving on. Maintain the working directory by using absolute paths; use \`cd\` only when the user explicitly requests it. Never prepend \`cd <working-directory>\` to a command — it already runs in the session working directory, so the prefix is redundant (this applies to \`git\` commands especially).'`

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run server/providers/native/tools/bash.test.ts && npm run typecheck`
Expected: PASS (existing bash behavior tests unaffected — run/spawn code untouched).

- [ ] **Step 5: Commit**

```bash
git add server/providers/native/tools/bash.ts server/providers/native/tools/bash.test.ts
git commit -m "feat(native): state Bash execution semantics to stop defensive cd prefixes

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: Context composition Memory Files row + note update

**Files:**
- Modify: `server/providers/native/native-session.ts:3169-3226` (`contextComposition`)
- Modify: `.agents/notes/implemented/feature/2026-11-25-native-context-composition.md`
- Test: `server/providers/native/native-session.test.ts` (extend the composition test at `:880-915`)

**Interfaces:**
- Consumes: `memorySnapshot` (Task 3), `renderMemorySection` / `renderEnvironment` / `joinPromptParts` (Task 3), `estimateText` / `ROLE_OVERHEAD` (existing `estimate.ts`).
- Produces: categories gain `{ name: 'Memory Files', tokens, kind: 'used' }` after the Skills row, omitted when 0. The System prompt row prices base + persona + environment (memory priced separately). Used-row sum invariant unchanged.

- [ ] **Step 1: Write the failing test**

Extend the existing composition tests (the category-name-list assertion lives in
`it('categories sum to the real totalTokens with a realistic usage sample')` at `:878`;
add the new `it`s beside it):
  - `Memory Files row present with memory` — stub memory port (Task 1 override) with fixture content, run a turn, pull detailed context usage → category list is `['System prompt', 'System tools', 'Memory Files', 'Messages', 'Autocompact buffer', 'Free space']` (Skills/MCP absent in the bare fixture); `Memory Files` tokens > 0; used rows sum to `totalTokens`.
  - `Memory Files row omitted when empty` — empty stub → name list has no `Memory Files`.

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run server/providers/native/native-session.test.ts -t 'categories'`
Expected: new assertions FAIL.

- [ ] **Step 3: Implement**

In `contextComposition`: build `memorySection` / `envSection` from `this.memorySnapshot` (null → `''`); `system = joinPromptParts(persona ? base+persona : base, envSection)`; `memoryTokens = memorySection ? estimateText(memorySection) + ROLE_OVERHEAD : 0`; add to `estimated`; insert the row after Skills. Pre-turn reads (snapshot null) omit both — same accepted non-atomicity the note already documents; the constructor seed (Task 3) makes the window small.

- [ ] **Step 4: Update the note**

In `2026-11-25-native-context-composition.md`: replace the "native loads no memory files … those categories are absent" premise with the new truth (memory loads via the memory port; Memory Files row priced with the same density rule; environment priced inside System prompt; snapshot cached per turn + constructor seed). Keep the rest of the decision record intact; add a Related link to the new decision record (Task 6).

- [ ] **Step 5: Run tests + typecheck + notes gate**

Run: `npx vitest run server/providers/native/native-session.test.ts && npm run typecheck && npm run verify:agent-notes`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/providers/native/native-session.ts server/providers/native/native-session.test.ts .agents/notes/implemented/feature/2026-11-25-native-context-composition.md
git commit -m "feat(native): Memory Files row in context composition

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: Decision record + full verification

**Files:**
- Create: `.agents/notes/implemented/feature/2026-11-27-native-memory-and-behavior.md`
- Modify: `docs/superpowers/specs/2026-11-27-native-memory-and-behavior-design.md` (status draft → implemented)

**Interfaces:**
- Consumes: the whole feature (Tasks 1-5).
- Produces: the durable decision record per `.agents/notes/README.md` contract.

- [ ] **Step 1: Write the decision record**

Cover: the two proven root causes (no memory load; Bash semantics absent from prompt); the chosen injection mechanism (system section + mtime recheck) vs the CLI's system-reminder alternative; worktree resolution via `.git` pointer parse vs DSH boundary-truncation vs literal walk (the builder-check question and the user's choice A); the 1 MiB cap adoption; what was knowingly left out (@imports, rules dirs, managed policy, AGENTS.md, security-policy section) and why; the Bash three-layer wording rule (real reasons only). Link the design spec, the CLI extracts reference, and the updated context-composition note.

- [ ] **Step 2: Full verification**

Run: `npm run typecheck && npm run test && npm run lint && npm run verify:agent-notes`
Expected: all PASS. Any failure outside the native scope caused by this diff: fix it; pre-existing unrelated failures: report, don't fix.

- [ ] **Step 3: Review gate (repo rule)**

Run the `code-review` skill on the full branch diff (`git diff main...HEAD`). Verify each finding against the code, fix confirmed issues, re-review non-trivial fixes. Only after a clean review may the branch land on `main` (merge mechanics follow the shared-live-tree memory: temp worktree for the main merge).

- [ ] **Step 4: Commit the record**

```bash
git add .agents/notes/implemented/feature/2026-11-27-native-memory-and-behavior.md docs/superpowers/specs/2026-11-27-native-memory-and-behavior-design.md
git commit -m "docs(native): memory + behavior decision record

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```
