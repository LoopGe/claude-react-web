# Agent Note: Native provider context composition

Status: implemented

## Problem

The SettingsPanel Context tab's composition table is empty for `native`
sessions: `NativeSession.getContextUsage()` returned only the lite shape
(`totalTokens` / `maxTokens` / `model` / `autoCompactThreshold`), while the
client renders rows exclusively from the detailed payload's `categories`
(plus the `skills` and `mcpTools` sections). The claude provider forwards
the CLI's rich response, so only native sessions showed a blank area with
no loading or error hint. The same gap emptied the Skills tab token
breakdown and the per-server MCP section. Proven against live sessions:
a native session's detailed payload carried exactly the four lite fields.

## Decision

`getContextUsage()` assembles a CLI-shaped composition on demand, in the
neutral core, from the parts the next request will send:

- A fixed-density estimator (`native/estimate.ts`) prices every part:
  1 token per CJK codepoint, 1/4 token per other character, plus DSH's
  structural overheads (4 per block, 4 per message role, 4 per tool
  schema). Tool schemas are priced on the exact wire shape
  `{ name, description, input_schema }`, so Chinese descriptions ride the
  CJK arm too.
- Categories follow the CLI's display names and order: System prompt
  (base system + current persona instruction), System tools and MCP tools
  (the EFFECTIVE `this.tools` list, split by `mcpToolServers` ownership —
  a restrictive persona prices only the schemas actually injected),
  Skills (the `<available_skills>` section), Messages, Autocompact buffer
  (`maxTokens − autoCompactThreshold`, omitted at threshold 0), Free space.
  Empty MCP/Skills rows are omitted; native loads no memory files and its
  MCP connections surface no instructions, so those categories are absent
  rather than fabricated as zero rows.
- **Messages is a residual**: `max(0, totalTokens − Σ the other used
  estimates)`, anchored to the last real API usage sample. The used rows
  sum to `totalTokens` by construction; only the split is heuristic. With
  no sample yet (fresh session), Messages prices `this.history` directly —
  which includes the spawn-seeded environment reminder.
- The `skills` payload reads a new `listing()` accessor on the skill view
  that shares the section's line renderer, and the `mcpTools` payload
  reuses the same per-FQN prices as the MCP row (bare tool names from
  `NativeMcpToolInfo.name`, never parsed from sanitized/hashed FQNs).

The whole assembly is O(prompt + tools), never O(history): the manager
fires `getContextUsage` as a post-turn reconcile/seed probe, so a history
walk per probe would be a per-turn cost. The four lite fields and the
generation-retry loop are unchanged; the client needed no changes.

The composition is non-atomic by design: `totalTokens` describes the last
completed request while the estimates describe the next one (an MCP
toggle or persona switch between turns pairs a fresh estimate with the
previous sample until the next request reports usage). Nothing makes
decisions from this table — compaction reads the lite fields — so the
approximation is display-only. This mirrors DSH's recorded acceptance of
the same non-atomicity in its token-meter projections.

## Alternatives considered

**DSH-style three heuristic buckets whose sum is explicitly not the
total.** DSH's `contextBreakdown` (system/tools/messages) proportions a
provider-anchored occupancy bar and documents that the buckets never sum
to the real figure. Our table shows per-row token counts beside a used
percentage, so a non-summing split would read as broken arithmetic; the
residual gives an exact total with an approximate split instead. DSH's
estimator constants and anchoring contract are borrowed; its
chars/4-only density is not — it underprices Chinese ~4-6×, and Chinese
is a core usage scenario here.

**A full incremental surface fold (DSH's durable projection).** DSH folds
per-node prices over the durable log with shadow-price events for
compaction, because its UI is projection-driven and must survive
restart/reconnect/pagination. Our detailed payload is a lazy REST pull
fetched when the Context/Skills tab opens; a durable projection would add
log events, state schemas and migration surface for a table nobody reads
continuously. The residual also removes the reason to price messages at
all on the hot path.

**Pricing the raw tool discovery snapshot.** `buildFullTools` before the
persona filter would price schemas a restrictive persona never injects,
making the used-row sum systematically exceed `totalTokens` for persona
sessions. `this.tools` is already the effective list, rebuilt before
every turn and after MCP mutations — pricing it directly needs no second
filter site.

**Exact tokenization (count_tokens API or a tokenizer library).** Proxy
endpoints may not support the endpoint, and a tokenizer dependency for a
display-only table is cost without a decision benefit; the anchor already
makes the total exact.

## Consequences

Native sessions now render the same composition table, Skills breakdown
and MCP per-server section as claude sessions, with zero client changes.
The used-row sum is exact against the last real usage sample; individual
rows are estimates (a very efficient tokenizer can push the four
estimates above the sample, clamping Messages at 0 — the documented
overshoot edge). The table describes the next request's composition
against the last request's total, accepted and documented above.

The estimator is a second pricing path only in the sense that the claude
provider's CLI estimates its own categories; within native there is one
density rule shared by the table, the skills payload and the MCP payload.
`estimate.ts` is neutral-core (vocabulary-only imports) and covered by the
neutrality pins.

The composition reads the session's effective tool snapshot
(`this.tools` / `mcpToolServers`), which `rebuildTools()` refreshes. The
constructor's rebuild runs before the fire-and-forget MCP connect pass
settles, so a pre-turn reader (the Context tab opened right after
create/resume) saw no MCP row until a turn ran `rebuildTools` — an
intermittent "MCP missing after restart, gone after a message" gap, proven
by a fresh-session probe (pre-turn MCP absent, post-turn present). The
constructor now also refreshes the snapshot once `mcp.whenReady()` resolves
(guarded by `_closed`), so the birth invariant `tools = builtins + Agent +
Task + MCP defs` holds after discovery, not only after a turn. A one-shot
refresh suffices: later live MCP mutations already call `rebuildTools`.
The alternative — rebuilding inside `getContextUsage` — was rejected: a
read probe must not mutate the tool snapshot, and awaiting discovery there
would block the manager's post-turn probe on a slow server.

## Related

- Capacity resolution for the same payload's `maxTokens` /
  `autoCompactThreshold`: [native model context resolution](../architecture/2026-11-14-native-model-context-resolution.md).
- Design spec: `docs/superpowers/specs/2026-11-25-native-context-composition-design.md`.
- DSH reference (external repo): `deepseek-harness`
  `.agents/notes/implemented/architecture/2026-07-29-projected-token-usage-and-request-context.md`
  and `packages/llm/token-meter/src/estimate.ts`.