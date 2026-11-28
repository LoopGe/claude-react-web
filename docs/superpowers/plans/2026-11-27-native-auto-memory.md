# Native Auto-Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the native provider the full learned-memory loop — store, write discipline, turn-start recall, per-cwd dream consolidation — with write isolation from the claude memory store and read-only compatibility with it.

**Architecture:** A new host port (`NativeAutoMemoryPort`) owns all fs; the neutral core owns recall timing/budget and dream orchestration; the adapter projects a new `memory/recall` operational frame to the SDK `system/memory_recall` shape. Recall content rides the existing `session/supplement` event word (wrapped-guidance track); the user-visible card rides the sidecar app-only layer. Zero new v3 event words.

**Tech Stack:** TypeScript, Node fs/promises, vitest (server tests run in Node), existing native ports/loop/subagent/task-manager machinery.

**Spec:** `docs/superpowers/specs/2026-11-27-native-memory-design.md` (approved). Evidence base: `docs/research/2026-11-27-memory-systems-research.md` (RS).

## Global Constraints

- Native core is host-free: `vocabulary/neutrality.test.ts` and `host-free.test.ts` recursively scan ALL production `.ts` under `server/providers/native/` — new core modules are automatically pinned. No SDK imports (value OR type-only), no host-service value imports; capabilities enter via `NativeHostPorts` only.
- `OperationalFrame` is a CLOSED union with `assertNever` — adding a member forces an adapter projection decision at compile time.
- Capability flip must touch BOTH `native-provider.ts` capabilities AND `shared/provider-capabilities.ts` — `provider-capabilities-pin.test.ts` enforces consistency.
- Write isolation invariant: native writes NEVER land in the claude config dir. Enforced at three layers: directory root separation, override realpath validation, broker write-exemption scope.
- Exact constants (from RS §7.3, CLI-verified): recall session budget `61440` bytes; recall deadline `2000` ms; top-k `5`; memory file read cap `4096` bytes / `200` lines; index cap `200` lines / `25000` bytes; dream defaults `24 h` / `5` sessions.
- No new `SessionEventMap` event words. Recall model-history carriage uses `session/supplement` with a memory-specific wrap; the card uses the live-frame + sidecar track.
- Both tsconfigs typecheck: `npm run typecheck`. Tests: `npx vitest run <file>`. Server diagnostics via `createLogger(scope)`, never bare `console.*`.
- Every commit ends with: `Co-Authored-By: Claude Code <noreply@anthropic.com>`
- Review each task's diff before committing (repo rule: no unreviewed code).

## Review Focus

Input classes the spec implies but no single task's happy path exercises — each is pinned by a test in the owning task:

1. **Override path aliasing the claude store** (symlink or direct path into `claudeConfigDir()`) → rejected 400, no state change. Task 1.
2. **Memory write in plan mode** → still denied (plan gate is fail-closed; the exemption must not bypass it). Task 3.
3. **Aux selector returns malformed JSON or times out** → recall skipped for the turn, turn proceeds, no throw into the user path. Tasks 6–7.
4. **cwd longer than 200 chars** → slug hash suffix matches the CLI's actual directory name. Task 1.
5. **Dream run fails mid-flight** → per-cwd lock released, next trigger window retries, nothing surfaces in the user turn. Task 11.

## File Structure

| File | Responsibility |
|---|---|
| `server/providers/native/ports.ts` (modify) | `MemoryCandidate`, `NativeAutoMemoryPort`, `NativeHostPorts.autoMemory`, dream-state methods, `NativeConfigPort` dream getters |
| `server/providers/native-host-auto-memory.ts` (create) | Host port impl: CLI-exact slug, root resolve + override validation, candidate enumeration with drift tolerance, bounded reads, dream-state file, touched-session scan |
| `server/providers/native-host-adapters.ts` (modify) | Wire `autoMemory` into `makeNativePorts`; config getters |
| `server/providers/native/tools/types.ts` (modify) | `ToolContext.memoryRoots` |
| `server/providers/native/tools/read.ts` (modify) | `resolveAgainstCwd` extra roots |
| `server/providers/native/file-read.ts` (modify) | `resolveNativeReadTarget` extra roots (lexical + realpath) |
| `server/providers/native/tools/write.ts`, `edit.ts` (modify) | Pass ctx roots |
| `server/memory-permission.ts` (create) | `isMemoryRootWrite` / `isMemoryRootRead` (realpath containment) |
| `server/permission-broker.ts` (modify) | Root-scoped exemption after plan gate |
| `server/session-types.ts` (modify) | `Session.memoryRoots` |
| `server/session-manager.ts` (modify) | Set `memoryRoots` at native spawn + on memory settings change |
| `server/providers/native/native-session.ts` (modify) | `memory` option + flag acceptance; per-turn `# Memory` section; recall turn-start hook; dream turn-end hook; tool ctx roots |
| `server/providers/native/native-provider.ts` (modify) | Thread `memory` intent; `supportsMemory: true` |
| `shared/provider-capabilities.ts` (modify) | native `memory: true` |
| `server/providers/native/prompt/overlay.ts` (modify) | `renderAutoMemorySection` |
| `server/providers/native/memory.ts` (create) | Recall state machine: exclusion, budget, aux selection, text build |
| `server/providers/steering-format.ts` (modify) | `formatMemoryRecallInstruction`; supplement entry `kind` |
| `server/providers/native/vocabulary/live-frame.ts` (modify) | `memory/recall` OperationalFrame member |
| `server/providers/native-host-frame-adapter.ts` (modify) | `memory/recall` projection; R6 comment update |
| `server/providers/native/dream.ts` (create) | Trigger predicate, nested run construction, prompt |
| `server/config.ts` (modify) | `nativeDreamAfterMs` / `nativeDreamSessionCount` |
| `server/providers/native/host-free.test.ts` (modify) | Ban list += `native-host-auto-memory` |

---

### Task 1: Host port — slug, resolve, enumeration, bounded reads

**Files:**
- Create: `server/providers/native-host-auto-memory.ts`, `server/providers/native-host-auto-memory.test.ts`
- Modify: `server/providers/native/ports.ts`, `server/providers/native-host-adapters.ts` (`makeNativePorts`), `server/providers/native/host-free.test.ts` (HOST_SERVICE_MODULES)

**Interfaces:**
- Produces (later tasks rely on these exact names):
```ts
// ports.ts
export interface MemoryCandidate {
  dir: string; filename: string; path: string; mtimeMs: number
  description: string | null
  memoryType: 'user' | 'feedback' | 'project' | 'reference' | null
}
export interface NativeAutoMemoryPort {
  resolve(cwd: string, override?: string): Promise<{ ownDir: string; claudeDir: string | null }>
  listCandidates(dirs: readonly string[]): Promise<MemoryCandidate[]>
  readIndex(dir: string): Promise<string | null>
  readMemoryFile(path: string): Promise<{ content: string; truncated: boolean }>
  listSessionsTouchedSince(cwd: string, sinceMs: number): Promise<Array<{ id: string; logPath: string }>>
  readDreamState(): Promise<Record<string, { lastDreamAt: number }>>
  claimDream(cwdKey: string): Promise<boolean>
  releaseDream(cwdKey: string, lastDreamAt: number): Promise<void>
}
// NativeHostPorts gains: autoMemory: NativeAutoMemoryPort
// native-host-auto-memory.ts exports:
export function claudeProjectSlug(cwd: string): string
export function resolveMemoryRoots(cwd: string, stateDir: string, override?: string): { own: string; claude: string | null }
```
- Consumes: `claudeConfigDir()` (server/claude-config or existing host helper — same one `subagent-watcher.ts` uses), `listNativeResumableRows` (native-resumable-listing.ts), writeAtomic helper (existing persistence util).

- [ ] **Step 1: Write failing tests** — `native-host-auto-memory.test.ts`, temp-dir fixtures:
  - `claudeProjectSlug`: `'D:\\codes\\claude-react-web'` → `'D--codes-claude-react-web'`; path with spaces/dots `'C:\\Users\\Ge Zelin\\my.project'` → `'C--Users-Ge-Zelin-my-project'` (ALL non-alphanumerics → `-`, NOT just `[:\/]`); trailing separator stripped before encoding; a 250-char cwd → `base.slice(0,200) + '-' + Math.abs(hash).toString(36)` where hash is `h = (h<<5) - h + charCodeAt(i) | 0` over the ORIGINAL cwd (CLI-verified algorithm, RS §2.2; binary offsets in RS appendix).
  - `resolve`: default `ownDir = join(stateDir, 'native-memory', slug(cwd))`, created with empty `MEMORY.md` if absent; `claudeDir = join(claudeConfigDir(), 'projects', slug(cwd), 'memory')` or null when absent; override replaces ownDir; **override inside claudeConfigDir() throws HttpError(400)**; **symlink pointing into claudeConfigDir() throws 400** (realpath check); override with `..` segments rejected.
  - `listCandidates`: fixture dir with 2 valid frontmatter files + MEMORY.md + a file with unknown frontmatter fields + a corrupt YAML file → returns the 2 valid + unknown-fields file (tolerated), skips corrupt, NEVER includes MEMORY.md, never throws; `filename` POSIX separators; `description` from frontmatter; absent dir → `[]`.
  - `readIndex`: returns MEMORY.md content capped at 200 lines / 25000 bytes with `truncated` semantics via readMemoryFile; absent → null.
  - `readMemoryFile`: 4096-byte / 200-line cap, `truncated: true` when capped.
- [ ] **Step 2: Run** `npx vitest run server/providers/native-host-auto-memory.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** the port contract in `ports.ts`, the host impl, `makeNativePorts` default stub (`autoMemory` wired like `memory`), and add `'server/providers/native-host-auto-memory'` to `HOST_SERVICE_MODULES` in host-free.test.ts. `resolve` does realpath validation + mkdir; `resolveMemoryRoots` is the sync lexical variant (broker uses it). Slug algorithm exactly as the test pins. Enumeration: readdir recursive, `.md` only, frontmatter parse via existing yaml usage pattern; parse failure → skip + `log.debug`.
- [ ] **Step 4: Run** the test file — expect PASS. Run `npx vitest run server/providers/native/host-free.test.ts` — expect PASS (ban list consistent).
- [ ] **Step 5: Commit** `feat(native): auto-memory host port — slug, resolve, enumeration, bounded reads`

### Task 2: Tool path roots — Write/Edit/Read reach the memory dir

**Files:**
- Modify: `server/providers/native/tools/types.ts`, `tools/read.ts` (`resolveAgainstCwd`), `file-read.ts` (`resolveNativeReadTarget`), `tools/write.ts`, `tools/edit.ts`
- Test: `server/providers/native/tools/write.test.ts` (extend), `server/providers/native/file-read.test.ts` (extend)

**Interfaces:**
- Consumes: nothing new (roots arrive via ctx).
- Produces: `ToolContext.memoryRoots?: { write: readonly string[]; read: readonly string[] }`; `resolveAgainstCwd(cwd, p, extraRoots?: readonly string[])`; `resolveNativeReadTarget(cwd, path, extraRoots?: readonly string[])`.

- [ ] **Step 1: Write failing tests**: Write to an absolute path outside cwd THROWS today (`path escapes the session working directory`); with `ctx.memoryRoots.write = [root]` and target inside root → succeeds; target outside both → still throws; symlink inside root pointing outside → rejected by the Edit/Read realpath chain; Read of a file in `memoryRoots.read` (outside cwd) succeeds.
- [ ] **Step 2: Run** the two test files — expect new cases FAIL.
- [ ] **Step 3: Implement**: extend `ToolContext`; `resolveAgainstCwd` passes when inside cwd OR any extraRoot (lexical); `resolveNativeReadTarget` checks lexical + realpath against cwd AND each extra root (realpath of root AND target, mirroring its existing double-check); write.ts passes `ctx.memoryRoots?.write`, edit.ts/read.ts pass `.read` (Edit's write target uses `.write` via assertEditable's resolution — keep read-evidence requirement unchanged).
- [ ] **Step 4: Run** — expect PASS; run `npx vitest run server/providers/native/tools/` for regressions.
- [ ] **Step 5: Commit** `feat(native): memory-root path allowance for Write/Edit/Read`

### Task 3: Broker exemption + session roots wiring

**Files:**
- Create: `server/memory-permission.ts`, `server/memory-permission.test.ts`
- Modify: `server/permission-broker.ts`, `server/session-types.ts`, `server/session-manager.ts`
- Test: `server/permission-broker.test.ts` (extend)

**Interfaces:**
- Consumes: `resolveMemoryRoots` (Task 1), `EDIT_TOOL_PATH_FIELD` (accept-edits-bash.ts).
- Produces: `Session.memoryRoots?: { own: string; claude: string | null }`; `isMemoryRootWrite(toolName, input, roots): Promise<boolean>`; `isMemoryRootRead(toolName, input, roots): Promise<boolean>` (realpath containment; write → own only; read → own + claude; Read/Glob/Grep/LS path fields).

- [ ] **Step 1: Write failing tests**: broker with `session.memoryRoots` set — default mode: Write inside ownDir → `{behavior:'allow'}` without prompt; Write inside claudeDir → prompts (NOT exempt); Write elsewhere outside cwd → prompts; Read inside claudeDir → allow; **plan mode: Write inside ownDir → denied** (plan gate stays fail-closed); dontAsk: Write inside ownDir → denied (restrictive posture unchanged); acceptEdits: ownDir write allowed; no `memoryRoots` (claude session) → behavior unchanged.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement**: helpers in memory-permission.ts; broker insertion AFTER the plan hard gate (~:403) and BEFORE the acceptEdits branch: `if (session.memoryRoots && mode !== 'plan' && mode !== 'dontAsk') { if (await isMemoryRootWrite(...)) return allow; if (await isMemoryRootRead(...)) return allow }`. Manager: at native spawn set `session.memoryRoots = resolveMemoryRoots(cwd, stateDir, session.memory?.autoMemoryDirectory)`; refresh in `setMemorySettings` mutate.
- [ ] **Step 4: Run** — expect PASS; `npx vitest run server/permission-broker.test.ts server/memory-permission.test.ts`.
- [ ] **Step 5: Commit** `feat(native): root-scoped permission exemption for memory writes/reads`

### Task 4: Settings unlock, spawn intent, capability flip

**Files:**
- Modify: `server/providers/native/native-session.ts` (NativeSessionOptions ~:365-449, applyFlagSettings :3633), `native-provider.ts` (:151, :308-350), `shared/provider-capabilities.ts` (:32)
- Test: `server/providers/native/native-session.test.ts` (extend), `server/providers/provider-capabilities-pin.test.ts` (runs green)

**Interfaces:**
- Consumes: `NativeAutoMemoryPort.resolve` (validation), `SessionMemorySettings` (shared/session-info.ts, three keys verbatim: `autoMemoryEnabled` / `autoMemoryDirectory` / `autoDreamEnabled`).
- Produces: `NativeSessionOptions.memory?: SessionMemorySettings`; core field `this.memorySettings` (live); `supportsMemory: true` both places.

- [ ] **Step 1: Write failing tests**: `applyFlagSettings({autoMemoryEnabled:true})` resolves (today throws unknown-key); `{autoMemoryDirectory: <claude-dir path>}` rejects (port.resolve HttpError propagates); `{autoMemoryEnabled:null}` clears; unknown key still throws; spawn with `memory` option seeds the field; capability pin test passes with both flips.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement**: supported set += three keys; validate-before-mutate (existing pattern), directory validated via `await this.opts.ports.autoMemory.resolve(this.opts.cwd, dir)`; null clears; `native-provider.ts` threads `memory: opts.memory` into NativeSession construction; flip capabilities in both files.
- [ ] **Step 4: Run** — expect PASS incl. pin test.
- [ ] **Step 5: Commit** `feat(native): accept memory flag settings and flip supportsMemory`

### Task 5: `# Memory` prompt section (per-turn render)

**Files:**
- Modify: `server/providers/native/prompt/overlay.ts`, `native-session.ts` (:2511-2522 join, :2034-2046 subagentSystem, :3272-3277 contextComposition)
- Test: `server/providers/native/prompt/overlay.test.ts` (extend), `native-session.test.ts` (extend)

**Interfaces:**
- Consumes: `autoMemory.resolve` / `readIndex` (Task 1), `this.memorySettings` (Task 4).
- Produces: `renderAutoMemorySection(input: { ownDir: string; index: string | null }): string` in overlay.ts.

- [ ] **Step 1: Write failing tests**: section text contains the ownDir absolute path, the frontmatter convention, the index content (or "(empty index)"); `autoMemoryEnabled:false` → section absent; settings change between turns → next turn's system contains the NEW directory + freshly loaded index; **index snapshot is session-level**: a memory file written mid-session does NOT change the rendered index next turn (content changes visible next session, spec §6); settings invalidation reloads the snapshot.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement**: session holds `autoMemorySnapshot: { ownDir: string; index: string | null } | null`, loaded at spawn (fire-and-forget seed like the instruction-chain snapshot :984) and reloaded when memory settings change (applyFlagSettings memory branch invalidates); the per-turn render uses the snapshot — NOT a fresh readIndex each turn. `renderAutoMemorySection` with this exact copy (directory/index interpolated):

```
# Memory

You have a persistent file-based memory at `<ownDir>`. This directory already exists — write to it directly with the Write tool.

Each memory is one file with frontmatter: name (short kebab-case slug), description (one-line summary), metadata.type (user | feedback | project | reference). The body is the fact.

Maintain `<ownDir>/MEMORY.md` as an index: one line per memory, `- [Title](file.md) — hook`.

Save when you learn something worth persisting across sessions: user preferences, feedback on how to work, project constraints not derivable from code, external references. Do not save what the repo already records (code structure, git history, CLAUDE.md). Check for an existing memory before creating a duplicate; update rather than duplicate; delete memories that turn out wrong. Save in the same reply where you learn the fact. Write only inside `<ownDir>`.

Current index:
<index or "(empty index)">
```

  Wire into the per-turn `joinPromptParts` at :2513-2522 (render from `autoMemorySnapshot` when enabled), and the two sibling consumption points. Gate on `this.memorySettings.autoMemoryEnabled !== false` (default on, CLI parity).
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(native): # Memory prompt section with per-turn settings re-render`

### Task 6: Recall state machine (core)

**Files:**
- Create: `server/providers/native/memory.ts`, `server/providers/native/memory.test.ts`

**Interfaces:**
- Consumes: `MemoryCandidate`, `NativeAuxLlmPort` (ports.ts).
- Produces:
```ts
export const RECALL_SESSION_BUDGET = 61440
export const RECALL_DEADLINE_MS = 2000
export const RECALL_TOP_K = 5
export interface RecallState { surfacedPaths: Set<string>; surfacedBytes: number }
export function newRecallState(): RecallState
export function excludeCandidates(cs: MemoryCandidate[], s: RecallState, readPaths: ReadonlySet<string>): MemoryCandidate[]
export async function selectMemories(deps: { auxLlm: NativeAuxLlmPort; model: string; credentials: () => { baseUrl: string; authToken: string } }, query: string, candidates: MemoryCandidate[], signal: AbortSignal): Promise<string[]>
export function buildRecallText(items: Array<{ filename: string; content: string; truncated: boolean }>): string
```

- [ ] **Step 1: Write failing tests**: exclusion drops MEMORY.md (already absent from candidates), surfaced paths, read-state paths; budget: `surfacedBytes >= 61440` → `excludeCandidates` returns `[]`; `selectMemories` with aux mock returning `{"selected_memories":["a.md"]}` → `['a.md']`; malformed JSON → `[]`; aux throw → `[]`; unknown filename in selection filtered out; deadline: aux delayed 3s with `AbortSignal.timeout(2000)` → `[]` (caller passes the deadline signal); `buildRecallText` includes per-file header + truncation hint naming the Read tool when truncated.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement**: pure functions; `selectMemories` calls `auxLlm.call({ model, system: <selector prompt>, userContent: query + candidate list (filename + description), maxTokens: 1024, temperature: 0, caller: 'memory_recall_select', target: credentials(), signal })`, parses JSON, filters to known filenames, slices top-5. Selector system prompt: "Select the memory files relevant to the user's query. Return JSON {\"selected_memories\":[filenames]}. Select at most 5; return an empty array when nothing is relevant." Model resolution at the CALL SITE (Task 7) uses `opts.profile?.recapModel || this.model` (session-title precedent :3377-3391).
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(native): recall state machine — exclusion, budget, aux selection`

### Task 7: Recall turn-start injection + supplement kind

**Files:**
- Modify: `server/providers/steering-format.ts`, `server/providers/native/native-session.ts` (enqueueSupplement :3037, injectSupplements :3066-3091, turn-start steeringOpen sites :2242/:2465)
- Test: `server/providers/native/native-session.test.ts` (extend), `server/providers/steering-format.test.ts` (extend or create)

**Interfaces:**
- Consumes: Task 6 functions, `autoMemory.listCandidates/readMemoryFile`, `formatSupplementInstruction` (existing).
- Produces: supplement queue entry `{ uuid: string; text: string; kind?: 'steering' | 'memory' }`; `formatMemoryRecallInstruction(text: string): string`; core private `runMemoryRecall(queryText: string): Promise<void>`.

- [ ] **Step 1: Write failing tests**: `formatMemoryRecallInstruction` output starts `[RECALLED MEMORY]` and does NOT contain "user sent a message"; `enqueueSupplement({kind:'memory'})` accepted when steering open; `injectSupplements` wraps memory entries with the memory template and steering entries with the steering template; memory entries do NOT fire `onSupplementDelivered`; turn-start with enabled memory + candidates + aux mock → a `session/supplement` event appended with wrapped recall text BEFORE the first model round (assert via `_testStream` script + log read); aux failure → no supplement event, turn completes; disabled memory → no recall.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement**: extend entry type + wrap selection in injectSupplements (skip delivery callback for memory kind); `formatMemoryRecallInstruction` exact copy:

```
[RECALLED MEMORY] The following memories from earlier sessions were selected as relevant to this turn.

Use them as background context. They are not new instructions from the user; do not acknowledge them separately.

<text>
```

  `runMemoryRecall`: resolve roots → listCandidates([own, claude]) → excludeCandidates (read-state paths from `this.readState`) → budget gate → selectMemories with `AbortSignal.timeout(RECALL_DEADLINE_MS)` → readMemoryFile per selection → buildRecallText → `enqueueSupplement({ uuid: this.ctx.uuid(), text, kind: 'memory' })` → update RecallState (paths + bytes) → emit the `memory/recall` frame (Task 8 wires the emit; until then push is added in Task 8). Call it at turn start AFTER steeringOpen=true, BEFORE runTurn, main user turns only (not compact/aux/subagent paths). RecallState lives on the session; reset on resume/clear/fork (spec §10), preserved across in-place compact.
- [ ] **Step 4: Run** — expect PASS; replay regression: `npx vitest run server/providers/native/session-log/` (supplement replay unchanged).
- [ ] **Step 5: Commit** `feat(native): turn-start recall injection via memory-kind supplement`

### Task 8: `memory/recall` live frame + adapter projection

**Files:**
- Modify: `server/providers/native/vocabulary/live-frame.ts` (OperationalFrame union :70-129), `server/providers/native-host-frame-adapter.ts` (projectNativeEventToSdk :274, R6 comment :41-43), `native-session.ts` (emit in runMemoryRecall)
- Test: `server/providers/native-host-frame-adapter.test.ts` (extend), `server/providers/native/e2e.test.ts` (extend)

**Interfaces:**
- Consumes: `OperationalEnvelope` (live-frame.ts:46-50), `operationalEnvelope` helper (adapter :163-171).
- Produces: OperationalFrame member `{ type: 'memory/recall'; mode: 'select'; memories: Array<{ path: string; scope: 'personal'; content?: string }> } & OperationalEnvelope`.

- [ ] **Step 1: Write failing tests**: adapter projects the member to `{ type:'system', subtype:'memory_recall', mode:'select', memories:[...], session_id, uuid, parent_tool_use_id:null }`; file-backed entries carry no content; e2e (`_testStream` scripted turn + recall aux mock): sidecar ndjson contains a `"subtype":"memory_recall"` row; **restart survival**: build a second SessionManager on the same stateDir, cold `getTranscriptWindow` contains the recall frame (RS §9.5 method).
- [ ] **Step 2: Run** — expect FAIL (union member missing → compile error in test).
- [ ] **Step 3: Implement**: add the union member; adapter case mirroring `informational` (:288-293) with `mode`/`memories` passthrough; update R6 comment (remove memory_recall from the claude-only list); core pushes the frame in runMemoryRecall after enqueue (uuid shared with the supplement entry).
- [ ] **Step 4: Run** — expect PASS; `npx vitest run server/providers/native/vocabulary/` (neutrality pin green).
- [ ] **Step 5: Commit** `feat(native): memory/recall frame projection and durable card`

### Task 9: Dream host — scan, state file, config keys

**Files:**
- Modify: `server/providers/native-host-auto-memory.ts` (dream methods), `server/config.ts` (four-stage), `server/providers/native/ports.ts` (NativeConfigPort getters), `native-host-adapters.ts` (getters)
- Test: `native-host-auto-memory.test.ts` (extend), `server/config.test.ts` (extend)

**Interfaces:**
- Consumes: `listNativeResumableRows(stateDir, { dir: cwd })` (native-resumable-listing.ts:249).
- Produces: config keys `nativeDreamAfterMs` (default `86400000`) / `nativeDreamSessionCount` (default `5`), readonly on ServerConfig + NativeConfigPort; port dream methods per Task 1 contract.

- [ ] **Step 1: Write failing tests**: `listSessionsTouchedSince` returns only same-cwd rows with `lastModified >= since` (fixture logs with mtimes); `claimDream` first call true, second false (in-process lock); `releaseDream` persists lastDreamAt (readDreamState reflects it) and unlocks; config merge accepts finite positive values, rejects NaN/negative, defaults correct; keys NOT in WRITABLE_CONFIG_KEYS.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement**: scan = `listNativeResumableRows` + filter + map to `{id, logPath: nativeSessionLogPath(stateDir, id)}`; state file `<stateDir>/native-memory/dream-state.json` via writeAtomic; claim = in-process Map guard + state read; config four-stage exactly per `nativeAutoCompactRatio` precedent (config.ts:85-95/246-251/364-365/646-664).
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(native): dream host scan, per-cwd state, config thresholds`

### Task 10: Dream run construction (core)

**Files:**
- Create: `server/providers/native/dream.ts`, `server/providers/native/dream.test.ts`
- Modify: `native-session.ts` (deps wiring for the dream run)

**Interfaces:**
- Consumes: `filterToolsForProfile` (agent-tools.ts:7), `NativeTaskManager.runForeground/background` (task-manager.ts:57/149), `appendDescriptor` (AgentToolDeps), nested LoopDeps construction pattern (subagent.ts:312-390), `runTurn` (loop.ts).
- Produces:
```ts
export function shouldDream(lastDreamAt: number | undefined, now: number, touchedCount: number, cfg: { afterMs: number; sessionCount: number }): boolean
export const DREAM_PROMPT: (input: { ownDir: string; logPaths: string[]; index: string | null }) => string
export function dreamToolFilter(tools: readonly ToolDef[]): ToolDef[]  // Read/Write/Edit only via filterToolsForProfile
```

- [ ] **Step 1: Write failing tests**: `shouldDream` boundary table (24h/5 exact, undefined lastDreamAt → true when count met); `dreamToolFilter` keeps exactly Read/Write/Edit; DREAM_PROMPT contains ownDir, every logPath, the index, and the write-only-ownDir instruction; nested-run deps test (mock stream): dream run executes tools with `ctx.memoryRoots.write=[ownDir]`, `read=[ownDir, native-sessions dir]`; descriptor appended with `toolUseId` prefixed `dream-`, `parentToolUseId: null`, `kind:'agent'`; task registered via runForeground then background.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement**: `shouldDream` pure predicate; DREAM_PROMPT exact copy:

```
You are the memory consolidation agent for this project. Review the recent session logs and the current memory files, then improve the memory store: merge duplicates, update stale facts, remove entries derivable from code or git history, and keep MEMORY.md as a one-line-per-memory index. Write only inside <ownDir>. Do not modify any other directory.

Session logs (read with the Read tool):
<logPaths, one per line>

Memory directory: <ownDir>
Current index:
<index or "(empty index)">
```

  Dream run = fire-and-forget nested `runTurn` mirroring subagent.ts nested construction (streamFor = session stream, requestPermission forwards to session's with the session permissionMode, emit with parentToolUseId = dream toolUseId), tools = dreamToolFilter, ctx roots as pinned; register via `tasks.runForeground({toolUseId, taskType:'subagent', description:'Memory consolidation', subagentType:'dream'}, execute, signal)` then `tasks.background(toolUseId)`; model = `opts.profile?.recapModel || this.model`.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(native): dream run construction — constrained tools, descriptor, task registration`

### Task 11: Dream trigger + failure posture

**Files:**
- Modify: `native-session.ts` (turn-end hook, suggestion precedent :2722), `dream.ts` (trigger orchestration)
- Test: `native-session.test.ts` (extend), `dream.test.ts` (extend)

**Interfaces:**
- Consumes: Tasks 9–10 (port dream methods, shouldDream, run construction), config getters.
- Produces: core private `maybeDream(turnResult): Promise<void>` fired after terminal result + turn/end persistence.

- [ ] **Step 1: Write failing tests**: turn-end with thresholds met + claim success → dream run started (task registered); thresholds unmet → no run; claim false (running) → no second run; **dream run rejects mid-flight → releaseDream called, no frame/error surfaces in the user turn, next turn-end with thresholds met retries**; dream's own session excluded from touched count (pass excludeId); `autoDreamEnabled:false` → never triggers; two sessions same cwd → only one dream (per-cwd claim).
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement**: `maybeDream` fire-and-forget after turn settle (mirror maybeSuggestPrompt placement): gate on autoDreamEnabled !== false → readDreamState → shouldDream(cfg from ports.config getters) → claimDream → listSessionsTouchedSince(cwd, lastDreamAt) excluding own id → count gate → build prompt → run (Task 10) → releaseDream on settle/failure (finally). All errors logged, never rethrown into the turn.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(native): per-cwd dream trigger with single-flight and failure posture`

### Task 12: Full-chain e2e + verification

**Files:**
- Modify/Create: `server/providers/native/e2e-memory.test.ts`
- No production changes expected; fix only what the chain exposes.

**Interfaces:**
- Consumes: everything above; e2e harness pattern (e2e.test.ts:52-76: real fs temp dir + real SessionManager + `_testStream` scripted events + makeNativePorts overrides + nativeCoreOf seam).

- [ ] **Step 1: Write the e2e suite**:
  - **learn → remember → recall**: session A scripted turn writes a memory file + MEMORY.md via real Write tool (aux mock not needed for write); session B (same cwd, fresh) with recall aux mock selecting that file → supplement event with recall wrap + `memory_recall` sidecar row + model history contains the recall text on replay.
  - **claude compat**: fixture claudeDir (temp claudeConfigDir override) with a valid memory → session B recall candidates include it; card path under claudeDir; **no write ever lands there** (assert dir contents unchanged after a full turn + dream).
  - **dream**: thresholds injected low via config; two touched sessions → dream fires, consolidates ownDir, claudeDir untouched; failure injection → lock released.
  - **restart survival**: second SessionManager on same stateDir → cold window contains the recall card (RS §9.5).
  - **override rejection**: setMemorySettings with claude-dir path → 400, session.memory unchanged.
- [ ] **Step 2: Run** `npx vitest run server/providers/native/e2e-memory.test.ts` — iterate until PASS.
- [ ] **Step 3: Full verification**: `npm run typecheck` (both tsconfigs), `npm run lint`, `npm run test` (full suite — neutrality/host-free/capability pins included), `npm run verify:agent-notes`.
- [ ] **Step 4: Live verification (isolated instance, RS §9 method)**: start a throwaway CRW instance on a spare port + temp stateDir; create a native session; drive a learn turn + a recall turn; confirm sidecar row + cold-read survival after killing the node PID directly (NOT the npx wrapper — RS §9.5 trap); clean up all artifacts.
- [ ] **Step 5: Commit** `test(native): auto-memory full-chain e2e and live verification` + write the decision record `.agents/notes/implemented/feature/2026-11-27-native-auto-memory.md` (why: dual-track persistence, write isolation layers, dream per-cwd; alternatives lost: new v3 event word, global dream, MCP outsourcing — link RS).