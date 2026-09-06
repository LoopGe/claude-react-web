# Custom Agents Round 2 — Verification, In-Session Delegation, Per-Agent MCP — Design

Date: 2026-09-06
Status: Proposed
Supersedes/follows: `2026-09-06-custom-agent-definitions-design.md` (shipped)

## Problem

The custom-agent-definitions feature (Round 1) is merged: all 17 `AgentDefinition`
fields are editable and injected via `Options.agents`; start-as is available at
session create; `/sessions/:id/agents` unions custom defs in. Three gaps remain,
from the Round-1 review and follow-ups:

1. **Runtime behavior is unverified.** The Round-1 Task-0 spike was skipped; it
   is unknown whether injected `Options.agents` are genuinely usable as
   subagents at runtime, whether start-as honors `initialPrompt`/`model`, and
   whether per-agent `mcpServers` string names resolve.
2. **No in-session way to actually use a custom agent.** Custom agents are
   passively available to the model (via the Agent tool); there is no user
   affordance to delegate a task to a specific custom agent from a running
   session.
3. **Per-agent MCP is only speculative.** `mcpServers` is a `string[]` in the
   UI, but nothing confirms the SDK resolves those names (vs. needing
   `{ name: config }`).

This design adds three staged workstreams: **A** a verification harness,
**B** in-session imperative delegation, **C** per-agent MCP by-name resolution.

## Scope decisions (confirmed)

- **Item 1 → Workstream A**: a repeatable, developer-facing verification probe
  (spike), not a shipped feature. Its findings fix the app where needed and gate
  the details of B and C.
- **Item 2 → Workstream B**: **imperative-message delegation** — the UI enqueues
  a crafted user message directing the model to invoke the agent, via the
  existing `send`/`POST /sessions/:id/messages` path. Chosen over "continue-as-
  agent" (respawn) because it is instant and reuses existing plumbing; the model-
  driven outcome is documented as a limitation.
- **Item 3 → Workstream C**: **by-name global MCP reference** — `mcpServers`
  stays `string[]`; the server resolves names against the global `McpConfigStore`
  at spawn injection, emitting `{ name: config }` only if Workstream A proves bare
  strings don't resolve. No inline per-agent MCP config editor.

## Constraints

- The SDK exposes **no direct "spawn agent X" method**; subagents are model-driven
  via the Agent tool. `Options.agents` is spawn-time-only (no `reloadAgents()`).
  Therefore B's delegation is a prompt-routing convenience, not a deterministic
  invocation; A must confirm whether the model honors it.
- Workstream A **execution is user-with-app** (running `claude-react-web` +
  live Anthropic credentials). Headless build environments cannot run the paid
  API. A is a gate, so a human runs it; B and C are spec'd to the confirmed
  behavior or A's documented fallback (below) so the branch is never blocked.
- Do NOT re-invent: `McpConfigStore.getSdkServerConfig(name)` already resolves a
  global server to `McpServerConfig`; `injectAgentDefinitions(opts, store)` from
  Round 1 is the injection seam; `sendContent()` is the existing multimodal send
  path; `/sessions/:id/agents` already unions custom names.

---

## Workstream A — Verification harness (spike + fixes)

**Deliverable:** a repeatable probe script + a confirmed-behavior report; any
app-side fix it surfaces.

**Probe checks (against a real `query()`):**
1. **Subagent usability** — pass `Options.agents`; confirm the injected name
   appears in `supportedAgents()` and that an `Agent` tool invocation of it runs,
   returns, and streams a subagent transcript `parent_agent_id` is set.
2. **Start-as semantics** — start a session `agent: 'probe'` with a def that has
   `initialPrompt` and `model: 'haiku'`; confirm the first assistant turn
   auto-runs (initialPrompt fired) and resolves the def's model, and how it
   merges with top-level `Options.model`.
3. **Per-agent MCP resolution** — with a configured server, does an agent def's
   `mcpServers: ['<server>']` (bare string) connect, or must the app substitute
   `{ '<server>': config }` from `McpConfigStore`?

Run: standalone `node` script under `/tmp` (never committed), like Round 1's
probe. Requires API auth; run by a human with a valid config. Result recorded in
the ledger / spec follow-up note.

**Fallback assumptions if A cannot run in a given environment (B and C stay
buildable):**
- (1) assume injected `Options.agents` ARE usable (Round-1 fallback already
  unions them into the list); if wrong, the union is redundant-but-harmless.
- (2) assume start-as auto-runs `initialPrompt` and the def's `model`; Round-1's
  client prefill of model/permission/effort remains the belt-and-suspenders.
- (3) assume a bare string does NOT resolve → C adds explicit `{ name: config }`
  substitution (safe either way; if A later proves strings DO resolve, C's
  substitution becomes a harmless no-op normalize).

---

## Workstream B — In-session imperative delegation (client)

**Goal:** let a user delegate a task to a specific enabled custom agent from a
running session.

**Affordance:** a composer-adjacent **"Run as agent"** menu/control on a session
(the default; placement is my call unless the user overrides): open → pick an
enabled custom agent from `GET /sessions/:id/agents` (the union already includes
custom defs) → enter a task → enqueue. A header chip/menu is an acceptable
alternative if it reads better; the design defaults to composer-adjacent.

**Mechanics:** on confirm, the client enqueues a crafted user message via the
existing send path:

```
Use the Agent tool with name "<name>" to complete the following task:
<task>
```

No server change (the `POST /sessions/:id/messages` path is unchanged). The
agent's name + description populate the picker from the existing agents union.

**Explicit limitation (documented in UI copy and spec):** routing is
model-driven — the model decides whether/how it invokes the agent. This is a
convenience delegate, not a guaranteed spawn. If Workstream A shows the model
rarely honors such prompts, this affordance stays as a convenience (no SDK
alternative exists).

**Files:** new client control + composition with the existing composer send;
picker data from the union route. Tests: assert the crafted message shape is
enqueued via the existing send hook; picker lists enabled custom agents; no
enable-agent selection allowed.

**Error handling:** no task → disabled confirm; unknown/disabled agent (stale
union) → inline error, not a silent drop.

---

## Workstream C — Per-agent MCP by-name resolution (server)

**Goal:** ensure each enabled agent's `mcpServers` string entries resolve to real
servers at spawn.

**Client:** unchanged — `mcpServers` remains `string[]` (tag input).

**Server:** extend `injectAgentDefinitions` so it can resolve names against the
global MCP store. Per Workstream A's finding:
- If A proves bare strings resolve → leave defs as-is (C is a no-op/normalize).
- If A proves bare strings DON'T resolve (fallback → assume this) → for each
  enabled def's `mcpServers`, map each string `s` to `{ [s]: mcpStore.getSdkServerConfig(s) }`
  (dropping any name the store doesn't have), and emit `{ name: config }` form.

**Structural change (the only one):** thread `McpConfigStore` into the provider
(the same path as `agentStore`/`mpStore` — `cli → app → SessionManager →
createDefaultProviders → ClaudeProviderOptions`), and change the injection
helper signature to `injectAgentDefinitions(opts, agentStore, mcpStore?)`.
Reuse `McpConfigStore.getSdkServerConfig`; do not branch on connectivity at
injection time.

**Tests:** the resolver maps a name the store has → `{ name: config }`; drops an
unknown name; leaves an already-`{ name: config }` entry alone; no-op when
A's verdict is "strings resolve" (guard the behavior switch behind one constant
seeded by A).

---

## UI copy / error handling (B)

- "Run as agent" labels the control; copy notes delegation is model-guided.
- Empty or disabled-agent selection is blocked at the control; enqueue failures
  surface via the existing send-path error channel.

## Testing & verification

- **A:** probe output (human-gated); app fixes TDD'd like Round 1.
- **B:** client tests (picker filters enabled agents; crafted message enqueued;
  no-task disabled; stale-agent inline error).
- **C:** server tests (MCP name → `{name:config}` mapping; unknown dropped;
  already-inline untouched; behavior switch constant). Full `npm run typecheck`
  (both tsconfigs) + `npm test` green at the end.

## Explicitly out of scope

- `{ name: config }` inline per-agent MCP editor UI (user chose by-name).
- "Continue-as-agent" respawn delegation (user chose imperative-message).
- Live `Options.agents` re-injection / restart-to-apply broadcast (still deferred).
- Per-agent `skills`/`memory`/`background` runtime validation beyond A's probe.