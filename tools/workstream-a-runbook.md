# Workstream A — Custom Agents Round 2 verification runbook

Harness companion to the throwaway probe at `/tmp/cwa-round2-probe.mjs`.
This document does **not** require credentials. The probe is the live, human-/session-gated
spike that produces the findings which **flip exactly two code changes**; that flip-point
table is at the bottom.

The probe itself is throwaway by design (matches the Round-1 probe convention): it lives
only at `/tmp/cwa-round2-probe.mjs`, is **never committed**, and the checks it runs are
guarded to bound spend (`model: 'haiku'`, forced one-word / one-line replies, few turns).

---

## 1. Preconditions

- A **live Anthropic credential** reachable from the raw SDK `query()` path. The probe
  drives `@anthropic-ai/claude-agent-sdk` directly (not the app server), so it authenticates
  the same way the app's SDK subprocess does: the `claude` CLI on `PATH` and already logged in
  (`claude login`), or `ANTHROPIC_API_KEY` (and, if proxied, `ANTHROPIC_BASE_URL`) in the env.
  It does **not** read `~/.claude-react-web/config.json` — that file configures the app server
  only, which this probe bypasses. Running inside a terminal where the CLI is live is enough.
- **Node >= 22.12** — the probe resolves the SDK through `require(esm)` (see §2), which
  requires `require()` of ESM (unflagged since 22.12).
- A checkout of the repo so `node_modules` is present. The probe is laid out to run with its
  file in `/tmp` and the repo path passed via `CWA_CWD`.

## 2. Why `CWA_CWD` and `createRequire`

The probe is *required* to live at `/tmp` (throwaway, never committed). ESM bare-specifier
resolution is relative to the **file's** directory, so `node /tmp/cwa-round2-probe.mjs` cannot
find `/tmp/node_modules` for a plain `import '@anthropic-ai/claude-agent-sdk'`. Rather than a
symlink hack, the probe binds a `createRequire(...)` to `CWA_CWD/package.json` and loads the SDK
through `require(esm)` — the same pattern the bundled server uses.

The takeaway for the human: **always set `CWA_CWD` to a copy of the repo that has a real,
installed `node_modules`.** The current (symlinked) worktree works as long as the target
`node_modules` is installed.

## 3. Exact run command

From anywhere (e.g. `/tmp`):

```bash
export CWA_CWD=/Users/loop/Codes/claude-react-web
node /tmp/cwa-round2-probe.mjs
```

- `CWA_CWD` — repo root used both to resolve the SDK (`createRequire`) and as the
  `Options.cwd` handed to each `query()`. Defaults to `process.cwd()` if unset (so you may also
  simply `cd` into the repo and omit it).
- `CWA_OUT` (optional) — override the findings file; defaults to
  `/tmp/cwa-round2-probe-out.txt`. The probe appends each line to this file as it runs, so you
  can paste the whole thing into the findings record verbatim.
- The probe clears `CWA_OUT` at start, then runs three probes **serially** (each is awaited),
  then logs `Done. Full log: <out>`.
- The whole output also appears on stdout, so you can capture with `tee`:
  `node /tmp/cwa-round2-probe.mjs | tee /tmp/cwa-round2-probe-run.log`.

> Do **not** run this without credentials — probes 1 and 3 call `initializationResult()`, which
> spawns the CLI subprocess and will error (or hang) on auth.

## 4. Reading each probe line

### Probe 1 — "do injected `Options.agents` surface as usable subagents?"

Creates a bare session with `agents: { 'probe-verifier': … }` injected and asks
`query.supportedAgents()` whether the injected name appears.

| Output line | Meaning |
|---|---|
| `supportedAgents -> [...]` | The full agent list the SDK exposes for this spawn. |
| `injected "probe-verifier" present? true` | Pass: injected `Options.agents` defs surface as usable subagents (drives the "Run as agent" Agent tool + `supportedAgents` guard in the UI). |
| …`false` | Fail: injection doesn't surface by name — workstream-B discovery path needs a different cue to detect injected agents. |
| `PROBE1 ERR (auth likely): …` | Not a code finding — the credential/CLI isn't reachable. Recheck §1 before judging the probe. |

Probe 1 does **not** force the model to actually *invoke* the agent (that would be a live
delegation turn). Surfacing + an explicit `Agent` tool call is what confirms usability; the
"model-guided delegation" question is covered by Probe 2 and by the Workstream-B copy note
(see flip-point table).

### Probe 2 — "does start-as honor `initialPrompt` + the def's `model`?"

Creates a session with `agent: 'probe-verifier'`, an `initialPrompt: 'Auto-run this turn now.'`
overlay, and a def `prompt` that forces a one-word `READY` reply. It streams until the assistant
emits `READY` (or a cap) and records whether a **proactive** turn happened without user input.

| Output line | Meaning |
|---|---|
| `assistant text -> "…READY…"` | The model actually ran the agent's forced-short prompt. Combined with a non-empty proactive turn, this is the strong signal. |
| `initialPrompt auto-ran (got a proactive turn without user input)? true` | Pass: starting a session as agent n honors the injected `initialPrompt` — the user message is auto-submitted without needing a manual send. |
| …`false` | Fail: `initialPrompt` / start-as doesn't auto-drive a turn; workstream-B's start-as flow may need to inject the prompt itself. |

Probe 2's pass result also corroborates that **delegation is model-guided**: the model honors
the injected agent/`initialPrompt` and produces a turn on its own, which is the behavior the
Workstream-B copy note (`delegation is model-guided`) asserts. See the flip-point table.

### Probe 3 — "does a bare MCP server string in `mcpServers` resolve, or need `{name:config}`?"

Creates an agent whose `mcpServers: ['some-named-server']` is a **bare string** (the shape
`AgentMcpServerSpec = string | Record<string, …>` permits) and observes whether the spawn
succeeds without the server being configured anywhere.

| Output line | Meaning |
|---|---|
| `spawn with string mcpServers entry: OK (init succeeded)` | The SDK **accepted** the bare string at spawn without throwing. |
| `PROBE3 ERR: …` | Init failed — check whether the error concerns the MCP string (e.g. unknown-server rejection). This leans toward "bare strings do NOT resolve." |

> **Heuristic, not proof.** With no configured server named `some-named-server` there's nothing
> to connect to, so "spawn OK" only proves the SDK *parses* a bare string — not that it
> *resolves* it to a working connection. To make the finding conclusive, the human must rerun
> with a **real, configured server name** (an MCP server the CLI already knows/trusts) in the
> agent's `mcpServers`. That single rerun flip decides `RESOLVE_PER_AGENT_MCP` (below).

## 5. Flip-point table

Exactly two code consequences hang off the probe findings. Flip-point **1** is decided by
Probe 3; flip-point **2** is confirmed/refined by Probes 1 + 2.

| # | Flip-point anchor | Current state | Flipped by | Result |
|---|---|---|---|---|
| 1 | `RESOLVE_PER_AGENT_MCP` — `server/providers/claude/claude-provider.ts:196` (declaration, default `true`), gate at `:207` (`if (!mcpServers || !RESOLVE_PER_AGENT_MCP) return mcpServers`) | `true` = fallback assumption: a **bare string does NOT resolve**, so `injectAgentDefinitions` substitutes each string name from `McpConfigStore` into a `{ name: config }` record (unresolved names are dropped, never left bare). | **Probe 3** (conclusive rerun): if the SDK resolves a **real configured bare-string server** into a working connection → the substitution is unnecessary and stale, flip to `false`. | `false` = pass `mcpServers` through verbatim (bare strings and `{name:config}` both handed to the SDK as-is). If Probe 3 only ever shows "spawn OK" / errors and can never confirm real resolution, **keep `true`** (the safe fallback) — the string-substitution behavior is correct and should stay. |
| 2 | Workstream-B copy limitation note — `src/components/agent-definitions/RunAsAgentControl.tsx:113-116` (the `hint` paragraph "Delegation is model-guided…", plus the file-header note at `:1-7`) | Already asserts delegation is model-guided (no hard guarantee the agent is invoked). | **Probes 1 + 2**: if injected agents surface (probe 1) **and** the model reliably honors the injected agent + `initialPrompt` to produce a proactive, on-prompt turn (probe 2) | **Confirmed**: the runbook substantiates the copy's model-guided framing as the de-facto delegation path — the note can stay, optionally sharpened to name the per-agent-model + initialPrompt mechanics the probe verified. If probe 2 **fails**, the copy is understating the limitation and should be escalated (delegation may not reliably occur at all). |

Recording rule: a probe that errors from **auth/spawn setup** (`PROBE1 ERR (auth likely)`, hang) is
**not** a finding — fix the environment (§1) and rerun. Only a clean run contributes to the table.

## 6. Recording-findings checklist

After a clean run:

- [ ] Copy the full `/tmp/cwa-round2-probe-out.txt` into the findings record (the runbook can
      hold it, or paste it into the task-3 report / SDD ledger). Capturing via
      `tee /tmp/cwa-round2-probe-run.log` preserves stdout too.
- [ ] Note the SDK package version actually used (from the repo's `node_modules`):
      `node -p "require('/Users/loop/Codes/claude-react-web/node_modules/@anthropic-ai/claude-agent-sdk/package.json').version"`
      — findings are only valid for that SDK version.
- [ ] **Probe 3 only**: if the bare-string spawn is inconclusive, do the conclusive rerun with a
      real configured server name and record its outcome. This alone decides flip-point 1.
- [ ] Decide each row of §5 and note the disposition per row (flipped / kept / escalated).
- [ ] If flip-point 1 is flipped, flip `RESOLVE_PER_AGENT_MCP` to `false` in
      `server/providers/claude/claude-provider.ts` and run `npm run typecheck` + the provider
      unit tests (`server/providers/claude/claude-provider.test.ts`).
- [ ] If flip-point 2 changes copy, edit `RunAsAgentControl.tsx` and run `npm run typecheck`.
- [ ] Record the findings in the task-3 report / SDD ledger and mark the probe findings captured.
- [ ] The probe stays at `/tmp` — do **not** commit it.

## 7. What this harness does NOT do

- It does not run the live API (no credentials at authoring time) — executing the probe is the
  separate, human-gated spike.
- It does not verify workstream-B/C integration end-to-end (that is the app-level check: create
  an agent whose MCP servers references a configured server, run it via the new control, confirm
  the tools resolve).