# Agent Note: Auto-title shape guard and prompt data-framing

Status: implemented

## Problem

A native session's sidebar title became a 330-character AskUserQuestion tool-call JSON payload. The chain: the session's first user message read 「Native Provider用Ask User Question 似乎不弹窗，你调用我试下」; the client's normal first-turn auto-title call passed that text as the title request's description; the profile set no `recapModel`, so the native `generateTitle` ran on the **session's own agentic model**; and that model answered the instruction inside the description instead of naming it — it emitted a freshly-authored AskUserQuestion JSON as its first text block. `callAnthropicMessages` returned the text block, and both persistence points accepted any non-empty string: the native `session/title` log append and the manager's `SessionMeta` write. The corrupt title was durable — resume/fork and the resumable picker read the log event back.

Two facts ruled out transcript leakage during diagnosis (worth keeping, because "the tool JSON came from the conversation" is the wrong theory): the title event predates the transcript's own AskUserQuestion call by seconds, and the two JSONs differ in wording — the model independently authored the payload. The title call declares no tools; the model wrote JSON as prose. The root cause is instruction-following on the title request, not contamination.

## Decision

Two layers, sharing one predicate in `shared/auto-title.ts`:

- **Prompt data-framing (prevention).** The native `TITLE_PROMPT` now frames the request as data to NAME and explicitly forbids answering/emitting tool calls, and the description travels wrapped in `<request>…</request>` tags so the prompt has a hard boundary to point at. This makes the misfire rare; it cannot make it impossible.
- **Shape contract (containment).** `sanitizeGeneratedTitle(raw)` trims and returns `''` for anything not title-shaped: empty, multi-line, longer than `AUTO_TITLE_MAX_CHARS` (120), or a bracket-delimited response that PARSES as JSON. A `''` result is handled exactly like the pre-existing empty-response path: the session stays untitled (UI falls back to the id prefix), a warn is logged, and the one-shot title slot stays open for a later valid call. Both enforcement points run it — the manager (`autoGenerateTitle`, the single choke for every provider) and the native provider BEFORE its durable `session/title` append — so metadata and log can never disagree about what counts as a title.

### Why 120, not tighter

Ordinary generated titles run ~10–60 characters even in CJK, where each char carries a word. The bound only needs to be far outside "a concise title" to be safe; a tighter cap would start rejecting legitimate long titles while saving nothing.

### Why the bracket rule is JSON-ness, not the first character

A legitimate title may open with a bracket (「[WIP] checkout flow」). `[{"questions": …}]` and friends are caught because they PARSE; prose that merely starts with `{` or `[` stays. The length/multi-line rules backstop unparseable bracket prose and fenced-code replies.

### Why the native side gates the log append, not just the manager

The manager gate alone would leave the bad title in the session log, which is the recovery source for resume/fork and the /resume picker ([native resumable discovery](../../implemented/feature/2026-11-25-native-resumable-discovery.md) reads the latest `session/title` event) — the metadata would look clean while every restart re-adopted the garbage. One predicate at both points keeps them consistent by construction; the native return contract (raw aux value) is unchanged so the manager still gets the same reject decision.

## Alternatives considered

- **Route the title call to a small non-agentic model instead of the session model** (recapModel/smallFastModel-first selection). Rejected as the primary fix: it reduces likelihood but never bounds the failure (any model can answer the request), and model selection for auto-title is a product/tenant decision (the gateway may not route small models). The shape guard is model-agnostic and makes the model question moot for correctness.
- **Sanitize toward acceptance — take the first line, truncate to the cap, strip code fences.** Rejected: each heuristic fabricates a title out of a non-title response, and the user-visible failure mode (a mangled name) is as bad as untitled while being harder to reason about. Rejecting to the existing untitled fallback reuses one already-proven state (same path as empty responses, and `rename('')`'s clear semantics).
- **Client-side rejection (only validate what the LLM returns in the browser).** Rejected: both server persistence points are reachable from other callers (a second tab, a direct API call), and the durable log append happens server-side anyway.

## Consequences

- Costs: a rare misfire now leaves the session untitled instead of mis-titled — visible, recoverable (manual rename), and warn-logged; the bracket rule adds a JSON.parse per auto-title call (once per session, negligible).
- Buys: the sidebar/picker/restart path can no longer display a structured payload as a name, for any provider or any future model, and the native log keeps claude `persist:true` parity without inheriting its failure mode.
- Known gaps (deliberate): a single-line, non-JSON, ≤120-char nonsense reply still titles the session — that is prose, and no shape rule can call it wrong; the claude-SDK path inherits the manager gate unchanged (the CLI's own titling model was never the failing component here).

## Testing

`shared/auto-title.test.ts` pins the predicate (with the real regression payload verbatim), `server/session-manager.test.ts` pins manager rejection → untitled + slot-reuse, `native-session.test.ts` pins the prompt text, the `<request>` wrap, and no-append-for-not-title-shaped responses, and `e2e-tools.test.ts` pins the end-to-end aux request body.

## Related

- [Native host service ports](../../implemented/architecture/2026-11-19-native-host-service-ports.md) — the `auxLlm` port this call rides.
- [Native resumable discovery](../../implemented/feature/2026-11-25-native-resumable-discovery.md) — the picker/recovery path that made the log-side gate necessary.
