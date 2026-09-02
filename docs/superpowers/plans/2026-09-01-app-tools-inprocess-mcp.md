# First-party git tool server (in-process SDK MCP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose first-party git tools to the agent via `createSdkMcpServer` (in-process MCP), injected per-session, with a global default + per-session override.

**Architecture:** A new `server/sdk-tools/app-tools.ts` builds an in-process `apptools` MCP server whose handlers call `server/git.ts`'s existing high-level helpers (never raw `runGit`, which is not exported). The server is injected into each session's `mcpServers` at a single code path; effective on/off is `session.appToolsGit ?? config.appToolsGit` (both default `true`).

**Tech Stack:** `@anthropic-ai/claude-agent-sdk` (`createSdkMcpServer`, `tool`), `zod` (add as direct dependency), `server/git.ts`, Hono, vitest.

**Spec:** `docs/superpowers/specs/2026-09-01-app-tools-inprocess-mcp-design.md`

## Global Constraints

- **zod**: add as a direct dependency (present transitively via the SDK, currently undeclared). Match the installed version (`node_modules/zod/package.json`).
- **Never call raw `runGit`** (not exported). Handlers use exported helpers: `getStatus`, `getLog`, `listBranches`, `listStashes`, `stageFiles`, `unstageFiles`, `discardTracked`, `discardUntracked`, `commitChanges`, `abortMerge`, `abortRebase`, `stashCreate`, `stashPop`, `stashDrop`, `createBranch`, `checkoutBranch`; path safety via `validateRepoRelativePath`; branch names via `validateBranchName` (both throw on invalid).
- **Server name**: `apptools` (tool FQN `mcp__apptools__{name}`). Constant `APP_TOOLS_SERVER_NAME = 'apptools'`.
- **Security posture**: git writes go through the existing `server/git.ts` path validation; no new shell path. `mcp__apptools__*` tools are NOT pre-approved — they obey the session's permission flow.
- **no in-process server in JSON `McpConfigStore`** (not serializable).
- **YAGNI**: do NOT implement plugin→agent bridge, BGFM rebinding, or per-tool permission UI.
- **All logging via `server/log.ts`**; no bare `console.*` for diagnostics.

---

### Task 1: `appToolsGit` global config + per-session data plumbing

**Files:**
- Modify: `server/config.ts` (ConfigFile + ServerConfig + DEFAULTS + merge)
- Modify: `server/session-types.ts` (Session.appToolsGit?)
- Modify: `server/persistence.ts` (SessionMeta.appToolsGit + coerceMeta)
- Modify: `shared/session-info.ts` (SessionInfoBase.appToolsGit?)
- Modify: `server/session-manager.ts` (snapshotMeta capture, writeStore, session init, info() surface)
- Test: `server/persistence.test.ts` (round-trip), plus a small config test

**Interfaces:**
- Consumes: existing `session-manager.ts` `snapshotMeta` / `writeStore` / `info()` / session-object init sites (the `memory`/`autoCompactWindow` analogues).
- Produces:
  - `config.appToolsGit: boolean` (ServerConfig readonly, default `true`; `ConfigFile.appToolsGit?: boolean`; merged in `mergeConfig`).
  - `Session.appToolsGit?: boolean`, `SessionMeta.appToolsGit?: boolean`, `SessionInfoBase.appToolsGit?: boolean`.
  - `SessionManager.snapshotMeta` returns `{ …, appToolsGit?: boolean }`; `session-manager.session` init maps `appToolsGit: existingMeta?.appToolsGit ?? metaSnapshot.appToolsGit`.

- [ ] **Step 1: Write the failing config + persistence tests**

In `server/persistence.test.ts`, add (mirroring the existing `sandbox` round-trip test added for the previous feature):
```ts
it('round-trips appToolsGit across upsert + reload', async () => {
  const store = new SessionStore({ stateDir: dir })
  await store.load()
  store.upsert(makeMeta('a', { appToolsGit: false }))
  await store.flush()
  const store2 = new SessionStore({ stateDir: dir })
  await store2.load()
  expect(store2.get('a')?.appToolsGit).toBe(false)
})
```
In `server/config.test.ts` (create if absent), use the exported live-config helpers:
```ts
import { config, __setConfigForTest } from '../config.js'
it('defaults appToolsGit to true', () => {
  __setConfigForTest({})
  expect(config.appToolsGit).toBe(true)
})
it('honors a false appToolsGit override', () => {
  __setConfigForTest({ appToolsGit: false })
  expect(config.appToolsGit).toBe(false)
})
```
`__setConfigForTest` mutates the live exported `config: ServerConfig` (see `server/config.ts:247`). Also add `appToolsGit: boolean` to the merge block in `mergeConfig` exactly alongside `autoRecap` (`server/config.ts:444`), reading `file_.appToolsGit` when it is a boolean and defaulting to `DEFAULTS.appToolsGit` (= `true`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/persistence.test.ts server/config.test.ts`
Expected: FAIL — `appToolsGit` is not a known field (type errors / `undefined`).

- [ ] **Step 3: Implement the data plumbing**

Add `appToolsGit` to the four type surfaces and thread it through `snapshotMeta` / `writeStore` / session init / `info()` exactly where `memory` is threaded (five call sites for `s.memory` you can copy). In `persistence.ts.coerceMeta` add:
```ts
appToolsGit: typeof r.appToolsGit === 'boolean' ? r.appToolsGit : undefined,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/persistence.test.ts server/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add server/config.ts server/session-types.ts server/persistence.ts shared/session-info.ts server/session-manager.ts server/persistence.test.ts server/config.test.ts
git commit -m "feat(app-tools): add appToolsGit global config + per-session field"
```

---

### Task 2: `server/sdk-tools/app-tools.ts` — build the in-process tool server

**Files:**
- Create: `server/sdk-tools/app-tools.ts`
- Modify: `package.json` (add `zod` dependency)
- Test: `server/sdk-tools/app-tools.test.ts`

**Interfaces:**
- Produces:
  - `export const APP_TOOLS_SERVER_NAME = 'apptools'`
  - `export function buildAppToolsServer(cwd: string): ReturnType<typeof createSdkMcpServer>`
  - The returned server has `name: 'apptools'` and a `tools` array. Handlers bind `cwd`; each returns the `CallToolResult` shape `{ content: [{ type: 'text', text }] }` or `{ …, isError: true }`.

- [ ] **Step 1: Write the failing tests**

```ts
// server/sdk-tools/app-tools.test.ts
import { describe, expect, it, vi } from 'vitest'
// Mock the git helpers so handlers run without a real repo.
const git = vi.hoisted(() => ({
  getStatus: vi.fn(async () => ({ isRepo: true, dirty: true })),
  getLog: vi.fn(async (cwd: string, n: number) => [{ hash: 'abc', message: 'm', date: 'd', author: 'a' }]),
  listBranches: vi.fn(async () => [{ name: 'main', current: true }]),
  listStashes: vi.fn(async () => []),
  stageFiles: vi.fn(async () => {}),
  unstageFiles: vi.fn(async () => {}),
  discardTracked: vi.fn(async () => {}),
  commitChanges: vi.fn(async () => {}),
  abortMerge: vi.fn(async () => {}),
  abortRebase: vi.fn(async () => {}),
  stashCreate: vi.fn(async () => {}),
  stashPop: vi.fn(async () => {}),
  stashDrop: vi.fn(async () => {}),
  createBranch: vi.fn(async () => ({ stashed: false })),
  checkoutBranch: vi.fn(async () => ({ stashed: false })),
  validateRepoRelativePath: vi.fn((p: string) => p),
  validateBranchName: vi.fn(async () => {}),
}))
vi.mock('../git.js', () => git)
// in-process server needs zod + the SDK helpers
import { z } from 'zod'
import { buildAppToolsServer, APP_TOOLS_SERVER_NAME } from './app-tools.js'

const server = buildAppToolsServer('/repo')
const toolList = (server.tools ?? []) as { name: string; _meta?: { description?: string } }[]

it('names the server apptools', () => {
  expect(server.name).toBe(APP_TOOLS_SERVER_NAME)
})

it('exposes the expected git tool set', () => {
  const names = toolList.map((t) => t.name)
  for (const want of ['git_status','git_log','git_branches','git_stashes','git_stage','git_unstage','git_commit','git_stash_create','git_stash_pop','git_stash_drop','git_abort_merge','git_abort_rebase','git_branch_create','git_checkout']) {
    expect(names).toContain(want)
  }
})
```
> **Note:** You will need the actual `tool()` return shape to name fields. Read `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` for `SdkMcpToolDefinition` (`name`, `_meta`/`annotations`) before finalizing assertions — adjust the field access to the real shape. Same for `server.tools` (may be `tools` under a different key) — verify from `McpSdkServerConfigWithInstance`/`CreateSdkMcpServerOptions`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/sdk-tools/app-tools.test.ts`
Expected: FAIL — `buildAppToolsServer` not defined / module missing.

- [ ] **Step 3: Implement `app-tools.ts`**

```ts
import { z } from 'zod'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import {
  getStatus, getLog, listBranches, listStashes,
  stageFiles, unstageFiles, discardTracked, commitChanges,
  abortMerge, abortRebase, stashCreate, stashPop, stashDrop,
  createBranch, checkoutBranch, validateRepoRelativePath, validateBranchName,
} from '../git.js'

export const APP_TOOLS_SERVER_NAME = 'apptools'

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}
function err(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true }
}

export function buildAppToolsServer(cwd: string) {
  return createSdkMcpServer({
    name: APP_TOOLS_SERVER_NAME,
    version: '1.0.0',
    tools: [
      tool('git_status', 'Show git working-tree status', { cwd: z.string().optional() }, async (a) => ok(JSON.stringify(await getStatus(cwd), null, 2))),
      tool('git_log', 'Show recent git commits', { limit: z.number().int().min(1).max(100).default(20).optional() }, async (a) => ok(JSON.stringify(await getLog(cwd, a.limit ?? 20), null, 2))),
      tool('git_branches', 'List git branches', {}, async () => ok(JSON.stringify(await listBranches(cwd), null, 2))),
      tool('git_stashes', 'List git stashes', {}, async () => ok(JSON.stringify(await listStashes(cwd), null, 2))),
      tool('git_stage', 'Stage files', { paths: z.array(z.string()).describe('repo-relative paths') }, async (a) => { stageFiles(cwd, a.paths.map(validateRepoRelativePath)); ok('staged') }),
      tool('git_unstage', 'Unstage files', { paths: z.array(z.string()) }, async (a) => { unstageFiles(cwd, a.paths.map(validateRepoRelativePath)); ok('unstaged') }),
      tool('git_discard', 'Discard tracked-file working-tree changes', { paths: z.array(z.string()) }, async (a) => { discardTracked(cwd, a.paths.map(validateRepoRelativePath)); ok('discarded') }),
      tool('git_commit', 'Commit staged changes', { message: z.string() }, async (a) => { commitChanges(cwd, a.message, false); ok('committed') }),
      tool('git_stash_create', 'Create a git stash', { message: z.string().optional() }, async (a) => { stashCreate(cwd, a.message); ok('stashed') }),
      tool('git_stash_pop', 'Pop the git stash', {}, async () => { stashPop(cwd, 0); ok('popped') }),
      tool('git_stash_drop', 'Drop a git stash by index', { index: z.number().int().min(0).default(0) }, async (a) => { stashDrop(cwd, a.index); ok('dropped') }),
      tool('git_abort_merge', 'Abort an in-progress merge', {}, async () => { abortMerge(cwd); ok('aborted') }),
      tool('git_abort_rebase', 'Abort an in-progress rebase', {}, async () => { abortRebase(cwd); ok('aborted') }),
      tool('git_branch_create', 'Create a new git branch (no checkout)', { name: z.string() }, async (a) => { await validateBranchName(a.name); await createBranch(cwd, a.name, false); ok('created') }),
      tool('git_checkout', 'Checkout a branch (optionally create it)', { branch: z.string(), create: z.boolean().optional() }, async (a) => { if (a.create) await createBranch(cwd, a.branch, true); else await checkoutBranch(cwd, a.branch, false); ok('checked out') }),
    ],
  })
}
```
> **Correctness rule:** Wrap each handler body in `try/catch`, returning `err(String(e instanceof Error ? e.message : e))` on throw. `createBranch`/`checkoutBranch` throw `HttpError` on conflicts; surface `.message`. The code above sketches handlers; the real implementation MUST add the try/catch and match real `runGit`-helper signatures (see `server/git.ts` line numbers cited in the spec) — do not ship handlers that can reject the MCP call.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/sdk-tools/app-tools.test.ts`
Expected: PASS (tool set present; handler-error paths covered by the catch).

- [ ] **Step 5: Add zod to package.json + typecheck + commit**

```bash
npm install zod@$(node -p "require('zod/package.json').version")
npm run typecheck
git add package.json package-lock.json server/sdk-tools/app-tools.ts server/sdk-tools/app-tools.test.ts
git commit -m "feat(app-tools): build in-process apptools git server"
```

---

### Task 3: Inject apptools into session mcpServers (spawn + live, one path)

**Files:**
- Modify: `server/session-manager.ts`
- Test: `server/session-manager.test.ts` or `server/routes/sessions-mcp.test.ts` (existing pattern)

**Interfaces:**
- Consumes: `buildAppToolsServer(cwd)`, `APP_TOOLS_SERVER_NAME` (Task 2); `config.appToolsGit`, `Session.appToolsGit` (Task 1).
- Produces:
  - `private appToolsEnabled(s: Session): boolean` → `s.appToolsGit ?? defaultConfig.appToolsGit` (both default true).
  - `private injectAppTools(servers: Record<string, unknown> | undefined, s: Session): Record<string, unknown> | undefined` — copies the map, sets `[APP_TOOLS_SERVER_NAME] = buildAppToolsServer(s.cwd!)` when `appToolsEnabled(s)` AND `s.cwd` is set; otherwise returns input unchanged.
  - Call #1 (spawn): in `spawn()`, right before `provider.createSession`, wrap the final `sdkOptions.mcpServers`: `sdkOptions.mcpServers = this.injectAppTools(sdkOptions.mcpServers as Record<string, unknown> | undefined, session)`.
  - Call #2 (live): in `SessionManager.setMcpServers(id, servers)` (`server/session-manager.ts:3572`), wrap the incoming `servers` with `injectAppTools(servers, s)` (where the live session `s = this.requireLive(id)`) before it reaches `handle.setMcpServers(...)`.

- [ ] **Step 1: Write the failing test**

In the session-manager or mcp-route test (mock the SDK `@anthropic-ai/claude-agent-sdk` so `createSdkMcpServer` returns a stubbed server; assert the spawned `mcpServers` includes `apptools` only when `appToolsEnabled` and `cwd` is set; and that a disabled session / no-cwd session omits it). Keep it to one focused assertion per test.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/session-manager.test.ts`
Expected: FAIL — `sdkOptions.mcpServers.apptools` absent.

- [ ] **Step 3: Implement the injection (both call sites above; add the two private helpers).**

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/session-manager.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add server/session-manager.ts server/session-manager.test.ts
git commit -m "feat(app-tools): inject apptools server into session mcpServers"
```

---

### Task 4: Per-session override route + client SettingsPanel toggle

**Files:**
- Modify: `server/routes/sessions.ts` (new `POST /sessions/:id/app-tools`)
- Modify: `server/session-manager.ts` (new `setAppTools(id, enabled: boolean | null): Promise<SessionInfo>` — mirror `setPrefs`/`setMemorySettings`)
- Modify: `src/components/SettingsPanel.tsx` (MCP-section toggle)
- Test: `server/routes/sessions-app-tools.test.ts` (mirror `server/routes/sessions-sandbox.test.ts` harness)
- (Client `SessionInfo` already carries `appToolsGit` via the shared `session-info.ts` from Task 1 — no separate mirror needed.)

**Interfaces:**
- Consumes: `SessionSession.appToolsGit`, `info()`, existing route harness.
- Produces:
  - `SessionManager.setAppTools(id: string, enabled: boolean | null): Promise<SessionInfo>` — sets `s.appToolsGit = enabled ?? undefined`, persists, returns `this.info(s)` (a null clears to global/default; no SDK call needed — injection is read at next spawn; document this in code).
  - Route `POST /sessions/:id/app-tools` body `{ enabled: boolean | null }` → `sm.setAppTools`.

- [ ] **Step 1: Failing route + manager tests**

In `server/routes/sessions-app-tools.test.ts`, use the mock-SessionManager harness from `sessions-sandbox.test.ts` and assert the route forwards `enabled:false` and a `null` body to `sm.setAppTools(id, …)`, and 400s on a non-boolean/non-null body.

- [ ] **Step 2: Run to verify fail**

`npx vitest run server/routes/sessions-app-tools.test.ts`

- [ ] **Step 3: Implement `setAppTools` + the route.**

- [ ] **Step 4: Implement the SettingsPanel toggle** (MCP section; a checkbox reading `session.appToolsGit`, showing "Inheriting global (ON/OFF)" when `undefined`, with a "Reset" link posting `null` — copy the `showPinnedUserMessage` UX block verbatim.)

- [ ] **Step 5: Run tests + typecheck**

```bash
npx vitest run server/routes/sessions-app-tools.test.ts
npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add server/routes/sessions.ts server/session-manager.ts server/routes/sessions-app-tools.test.ts src/components/SettingsPanel.tsx
git commit -m "feat(app-tools): per-session override route + SettingsPanel toggle"
```

---

### Task 5: Settings reference docs + full verification + spec-sync commit

**Files:**
- Modify: `docs/` settings reference (find the existing settings doc for `config.json`, e.g. `CONFIG.md` mentioned in CLAUDE.md; add `appTools.git`-style note describing `appToolsGit`)
- Modify: `docs/superpowers/specs/2026-09-01-app-tools-inprocess-mcp-design.md` (fold in the uncommitted spec-clarification edits from brainstorming — the `git_branch`/non-repo wording — so spec and implementation match)

- [ ] **Step 1: Update docs with the new `appToolsGit` config key + the clarification edits.**

- [ ] **Step 2: Full verification**

```bash
npm run typecheck
npm run lint
npx vitest run
```
Expected: all pass except any pre-existing flaky `server/ws.test.ts` timing test (unrelated; re-run in isolation to confirm).

- [ ] **Step 3: Commit**

```bash
git add docs/ CONFIG.md
git commit -m "docs(app-tools): document appToolsGit + sync spec"
```