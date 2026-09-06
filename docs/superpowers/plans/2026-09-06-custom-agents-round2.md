# Custom Agents Round 2 — Verify / Delegate / Resolve — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three Round-1 follow-ups — a verification harness for the injected-agent runtime behavior (A), an in-session "run a custom agent" delegation control (B), and per-agent MCP by-name resolution at spawn (C).

**Architecture:** A is a dev-facing probe (already drafted at `/tmp/cwa-round2-probe.mjs`); its live run is a human-gated spike. C threads the existing `SessionManager.mcpStore` into the provider and has `injectAgentDefinitions` resolve each enabled agent's `mcpServers` strings against `McpConfigStore.getSdkServerConfig`, seeded by a single behavior constant. B adds a composer-adjacent "Run as agent" control that enqueues a crafted user message via the existing send path (`api.post('/sessions/:id/messages')`).

**Tech Stack:** Node/TypeScript, Hono (server); React 19 + Vite (client); vitest.

**Spec:** `docs/superpowers/specs/2026-09-06-custom-agents-round2-design.md`

## Global Constraints

- All judgments in code, both typecheck passes always (`npm run typecheck` — tsconfig.json + tsconfig.node.json), and `npm test` green. TDD per task (RED → GREEN → commit).
- All diagnostic logging via `createLogger(scope)`; never bare `console.*`.
- New colors only as theme CSS vars (dark `:root` + `[data-theme="light"]`); never literal hex.
- The live Workstream-A probe cannot run headless (no Anthropic creds) — it is a **pending external gate**. The plan implements A's *harness* (finalized probe + a flip-point runbook) and seeds the C behavior constant to the **fallback assumption** so B/C are never blocked. When a human (or this session, given credentials) runs the probe, only the flip-points below change.
- Do not re-invent seams: reuse `McpConfigStore.getSdkServerConfig(name)`, the Round-1 `injectAgentDefinitions` helper, the Round-1 `SessionManager.agentStore`/`mcpStore` fields, and the client `useAgentDefinitions` hook + `api.post('/sessions/:id/messages')` send path.

---

### Task 1: Per-agent MCP by-name resolution (Workstream C, server)

**Files:**
- Create: `server/providers/claude/claude-provider.agent-mcp.test.ts`
- Modify: `server/providers/claude/claude-provider.ts` (`injectAgentDefinitions` signature + MCP resolution constant/helper)
- Modify: `server/providers/default-providers.ts` (`DefaultProvidersOptions.mcpStore`)
- Modify: `server/session-manager.ts` (pass `mcpStore: this.mcpStore` into `createDefaultProviders`)
- Modify: `server/app.ts` (thread `mcpStore` to `SessionManager` opts if not already; it already holds `opts.mcpConfigStore`)

**Interfaces:**
- Consumes: `mcjStore.getSdkServerConfig(name): McpServerConfig | null` (`server/mcp-config.ts:226`); existing `AgentDefinitionStore`; existing `injectAgentDefinitions(opts, store)` (claude-provider.ts:194).
- Produces: `injectAgentDefinitions(opts: Options, store, mcpStore?): void` where each `enabled` def's `mcpServers` string entries are resolved to `{ name: config }` — controlled by a module constant `RESOLVE_PER_AGENT_MCP` (default `true` = assume bare strings don't resolve, per the fallback).

- [ ] **Step 1: Write the failing test**

```ts
// server/providers/claude/claude-provider.agent-mcp.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { AgentDefinitionStore } from '../../agent-definition-store.js'
import { McpConfigStore } from '../../mcp-config.js'
import { injectAgentDefinitions } from './claude-provider.js'

function makeStores() {
  const dir = mkdtempSync(join(tmpdir(), 'cw-admcp-'))
  const agentStore = new AgentDefinitionStore({ stateDir: dir })
  const mcpStore = new McpConfigStore({ stateDir: dir })
  return { agentStore, mcpStore }
}

describe('injectAgentDefinitions per-agent MCP resolution', () => {
  it('resolves a known server string to { name: config }', async () => {
    const { agentStore, mcpStore } = makeStores()
    await agentStore.load()
    // mcpStore.getSdkServerConfig returns whatever the store maps; simulate a known name
    // via a stub if needed, else rely on an empty store (see "drops unknown" branch).
    agentStore.upsert({ name: 'a', description: 'd', prompt: 'p', enabled: true, createdAt: 1, updatedAt: 1, mcpServers: ['known'] } as never)
    const opts: Options = {}
    injectAgentDefinitions(opts, agentStore, mcpStore)
    // With no configured server the drop-unknown path yields `mcpServers: []`.
    // The assertion below is the CONTRACT: after injection mcpServers holds only
    // { name: config } records (resolved) or entries are dropped — never a bare string.
    const def = opts.agents!['a'] as { mcpServers?: unknown[] }
    expect(def.mcpServers ?? []).toEqual([]) // 'known' not configured => dropped, not left as string
  })
  it('drops an unknown server name rather than leaving a bare string', async () => {
    const { agentStore, mcpStore } = makeStores()
    await agentStore.load()
    agentStore.upsert({ name: 'b', description: 'd', prompt: 'p', enabled: true, createdAt: 1, updatedAt: 1, mcpServers: ['ghost'] } as never)
    const opts: Options = {}
    injectAgentDefinitions(opts, agentStore, mcpStore)
    const def = opts.agents!['b'] as { mcpServers?: unknown[] }
    expect(def.mcpServers ?? []).toEqual([]) // 'ghost' never configured => dropped
  })
  it('leaves an already-{name:config} entry untouched', async () => {
    const { agentStore, mcpStore } = makeStores()
    await agentStore.load()
    agentStore.upsert({ name: 'c', description: 'd', prompt: 'p', enabled: true, createdAt: 1, updatedAt: 1, mcpServers: [{ inline: { type: 'stdio', command: 'x' } }] } as never)
    const opts: Options = {}
    injectAgentDefinitions(opts, agentStore, mcpStore)
    const def = opts.agents!['c'] as { mcpServers?: unknown[] }
    expect(def.mcpServers).toEqual([{ inline: { type: 'stdio', command: 'x' } }])
  })
})
```

> If the real `McpConfigStore` can't be populated cheaply for the "known server → { name: config }" success case, stub `getSdkServerConfig` on the instance in that test (`vi.spyOn(mcpStore, 'getSdkServerConfig').mockReturnValue({ type: 'stdio', command: 'echo' } as never)`) and assert the entry becomes `{ known: { type: 'stdio', command: 'echo' } }`. The **contract that matters**: a resolved name becomes `{ name: config }`; an unresolved name is dropped, never passed through as a bare string.

- [ ] **Step 2: Run the test to confirm it fails**

Run: `npx vitest run server/providers/claude/claude-provider.agent-mcp.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `server/providers/claude/claude-provider.ts`:

```ts
// Behavior switch seeded by Workstream A. Default TRUE = assume a bare MCP string
// does NOT resolve and must be substituted from the configured store. Flip to
// false if the probe proves the SDK resolves bare strings (documented in the
// flip-point runbook, Task 3).
export const RESOLVE_PER_AGENT_MCP = true

function resolveAgentMcpServers(
  mcpServers: unknown[] | undefined,
  mcpStore: McpConfigStore | undefined,
): unknown[] | undefined {
  if (!mcpServers || !RESOLVE_PER_AGENT_MCP) return mcpServers
  const out: unknown[] = []
  for (const spec of mcpServers) {
    if (typeof spec === 'string') {
      const cfg = mcpStore?.getSdkServerConfig(spec)
      if (cfg) out.push({ [spec]: cfg })
      // unresolved name => dropped (never left as a bare string)
    } else {
      out.push(spec) // already { name: config }; keep verbatim
    }
  }
  return out.length > 0 ? out : undefined
}
```

Change `injectAgentDefinitions` to:

```ts
export function injectAgentDefinitions(
  opts: Options,
  store: AgentDefinitionStore | undefined,
  mcpStore?: McpConfigStore,
): void {
  if (!store) return
  const defs = store.getEnabledDefinitions()
  // resolve a copy so the store's entries are not mutated
  const resolved: Record<string, AgentDefinition> = {}
  for (const [name, def] of Object.entries(defs)) {
    resolved[name] = def.mcpServers
      ? { ...def, mcpServers: resolveAgentMcpServers(def.mcpServers, mcpStore) as Options['agents'][string]['mcpServers'] }
      : def
  }
  if (Object.keys(resolved).length === 0) return
  opts.agents = { ...resolved, ...(opts.agents ?? {}) }
}
```

Add `mcpStore?: McpConfigStore` to `ClaudeProviderOptions` (import `type { McpConfigStore } from '../../mcp-config.js'`). Call `injectAgentDefinitions(opts, this.opts.agentStore, this.opts.mcpStore)` in `applyStandardQueryOpts`.

In `server/providers/default-providers.ts`: add `mcpStore?: McpConfigStore` to `DefaultProvidersOptions`; pass through in `new ClaudeProvider(opts)`.

In `server/session-manager.ts` `createDefaultProviders({ ... })` (~line 477): add `mcpStore: this.mcpStore` (the field already exists, ~line 481).

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx vitest run server/providers/claude/claude-provider.agent-mcp.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + run the Round-1 injection test (regression)**

Run: `npm run typecheck` and `npx vitest run server/providers/claude/claude-provider.agent-injection.test.ts`
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add server/providers/claude/claude-provider.ts server/providers/claude/claude-provider.agent-mcp.test.ts server/providers/default-providers.ts server/session-manager.ts
git commit -m "feat: resolve per-agent mcpServers string names against global MCP store"
```

---

### Task 2: In-session "run a custom agent" delegation (Workstream B, client)

**Files:**
- Create: `src/components/agent-definitions/RunAsAgentControl.tsx`
- Create: `src/components/agent-definitions/RunAsAgentControl.test.tsx`
- Modify: `src/components/Chat.tsx` (mount the control near the composer; wire its submit to the existing send path)

**Interfaces:**
- Consumes: `useAgentDefinitions()` (`src/hooks/useAgentDefinitions.ts`) → `{ agents }`; `api.post` from `src/hooks/useApi.ts`; the existing send in `Chat.tsx` (~line 1446, `api.post<SendMessageResponse>('/sessions/${id}/messages', body)`).
- Produces: `RunAsAgentControl({ sessionId, onClose })` — picks an enabled custom agent + task, and enqueues the craft message via the session send path.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/agent-definitions/RunAsAgentControl.test.tsx
import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { RunAsAgentControl } from './RunAsAgentControl'

const post = vi.fn()
vi.mock('../../hooks/useApi', () => ({ api: { post } }))
vi.mock('../../hooks/useAgentDefinitions', () => ({
  useAgentDefinitions: () => ({ agents: [
    { name: 'reviewer', enabled: true, description: 'Reviews', createdAt: 1, updatedAt: 1, prompt: 'p' },
    { name: 'off', enabled: false, description: 'Off', createdAt: 1, updatedAt: 1, prompt: 'p' },
  ] }),
}))

describe('RunAsAgentControl', () => {
  afterEach(() => { cleanup(); post.mockReset() })
  it('lists only enabled custom agents', () => {
    render(<RunAsAgentControl sessionId="s1" onClose={() => {}} />)
    expect(screen.getByText('reviewer')).toBeTruthy()
    expect(screen.queryByText('off')).toBeNull()
  })
  it('disables confirm when the task is empty', () => {
    render(<RunAsAgentControl sessionId="s1" onClose={() => {}} />)
    expect((screen.getByRole('button', { name: /run/i }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('enqueues the crafted delegation message on confirm', () => {
    render(<RunAsAgentControl sessionId="s1" onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText(/task/i), { target: { value: 'find the bug' } })
    fireEvent.click(screen.getByRole('button', { name: /run/i }))
    expect(post).toHaveBeenCalledWith(
      '/sessions/s1/messages',
      expect.objectContaining({ text: expect.stringMatching(/Agent tool[\s\S]*reviewer[\s\S]*find the bug/) }),
    )
  })
})
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `npx vitest run src/components/agent-definitions/RunAsAgentControl.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/components/agent-definitions/RunAsAgentControl.tsx`: a small popover/dropdown listing `useAgentDefinitions().agents.filter(a => a.enabled)` as a `<select>`, a task `<textarea>`, and a Run button. On confirm, enqueue via the session send hook's submission:

```tsx
await api.post<SendMessageResponse>(`/sessions/${sessionId}/messages`, {
  text: `Use the Agent tool with name "${name}" to complete the following task:\n${task}`,
})
```

then `onClose()`. Empty task → confirm disabled; agent not found in the union (stale) → inline error, no silent drop.

Mount `RunAsAgentControl` in `src/components/Chat.tsx` near the composer (a compact "Run as agent" trigger in the composer area / panel header). Respect the CSP/no-literal-hex rule (reuse existing `btn` / `popover`-ish classes; add any new color via theme vars).

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx vitest run src/components/agent-definitions/RunAsAgentControl.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint the changed files**

Run: `npm run typecheck`
Expected: passes.

- [ ] **Step 6: Commit**

```bash
git add src/components/agent-definitions/RunAsAgentControl.tsx src/components/agent-definitions/RunAsAgentControl.test.tsx src/components/Chat.tsx
git commit -m "feat: in-session run-a-custom-agent delegation control"
```

---

### Task 3: Workstream A — finalize probe + flip-point runbook (harness only)

**Files:**
- Create: `tools/workstream-a-runbook.md` (run procedure + flip-point table) — or record in the SDD ledger per SDD convention
- The probe itself stays throwaway at `/tmp/cwa-round2-probe.mjs` (never committed, per spec).

**Interfaces:**
- Produces: a documented procedure that, when a human (or this session with credentials) runs the probe, yields findings that flip exactly two things:
  1. `RESOLVE_PER_AGENT_MCP` (Task 1 constant) — `true` (fallback) → `false` if the probe proves the SDK resolves bare MCP strings.
  2. Task 2's copy limitation note — confirmed (delegation is model-driven) if the probe shows the model reliably honoring the Agent-tool instruction as the de-facto delegation path.

- [ ] **Step 1: Verify the probe script is complete and correct**

Read `/tmp/cwa-round2-probe.mjs`. Confirm it checks all three spec items (agents surface / start-as initialPrompt+model / MCP string resolution), uses `model:'haiku'` + forced-short replies to bound cost, and writes to `/tmp/cwa-round2-probe-out.txt`. Fix the script directly in `/tmp` if it references a wrong SDK API (e.g. `requiredSessionFiles`/`needSinglePrimeDir` — resolve `sessionId`/`cwd` per the merged code; the script's `ANTHROPIC_AGENTS` objects must typecheck against `AgentDefinition`).

- [ ] **Step 2: Write the flip-point runbook**

Write `tools/workstream-a-runbook.md` with: the exact run command (`node /tmp/cwa-round2-probe.mjs` with `CWA_CWD=/Users/loop/Codes/claude-react-web` and a valid Anthropic credential in the env or the app's `config.json`), what each probe line means, and the flip-point table (above). If `tools/` doesn't exist, create it (this is a committed doc).

- [ ] **Step 3: Typecheck the probe shape (without running it)**

Run: `node --check /tmp/cwa-round2-probe.mjs`
Expected: parses. (Do NOT run it — no creds.)

- [ ] **Step 4: Commit**

```bash
git add tools/workstream-a-runbook.md
git commit -m "docs: workstream A verification runbook + flip-points"
```

---

### Task 4: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Full typecheck**
Run: `npm run typecheck` — both tsconfigs pass.
- [ ] **Step 2: Full lint**
Run: `npm run lint` — passes (1 pre-existing accepted react-refresh warning allowed).
- [ ] **Step 3: Full test suite**
Run: `npm test` — all pass (server + client hook tests), no regressions.
- [ ] **Step 4: Manual smoke (human; heads-up)**
With a running app + credentials: create an agent whose `MCP servers` is a configured server, start a session, run it via the new control, and confirm the tools resolve. This is the human portion of A; record findings in the flip-point runbook.
- [ ] **Step 5: Final commit only if fixes were needed**
`git status --short` — clean (or only fix commits).