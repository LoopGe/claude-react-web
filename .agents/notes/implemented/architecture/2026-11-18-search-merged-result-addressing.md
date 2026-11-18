# Agent Note: Search merged-result addressing

Status: implemented

## Problem

Transcript search addresses matches under a "one renderable row = one message = one ordinal space" invariant: the server indexes each message into text segments and emits hits with message-local match ordinals; the client counts matches per row, routes the active ordinal into a renderer, and scrolls to the row. Merged tool rendering breaks that invariant across messages. A `tool_result` arrives as its own user message, but once consumed into the owning assistant's tool card (the `toolResults` map) it no longer renders as a standalone row — so a hit on that result message had no row to seek and no ordinal space to route into.

The search preview worked around this with an "un-merge" hack: a copied lifecycle deleted `toolResults[resultId]`, forcing the result back into an orphan bubble the live transcript never shows. Meanwhile row match counts and the closed-group probe ignored consumed results entirely, so a merged-only hit never delivered the query to its owning row, never force-opened a closed group, and could not light an active mark. And the server indexed `tool_result` content through the markdown-flattened view while the card renders raw ANSI runs, so even a landed mark could disagree with the rendered occurrence (a query for `**hi**` missed content the renderer shows literally).

## Decision

Search addresses merged results in the owning card's match space, and the preview keeps the merged form. Three pieces ship together:

1. **One raw-runs text view** (`shared/tool-result-text.ts`) is the single writer of what a `tool_result` renders; the renderer, the server search segments, and every client count/walk consume it (contract below).
2. **Row match space includes consumed results.** `rowSearchMatchCount` (`src/components/message-list/search-addressing.ts`) sums each rendered member's own cached segments plus the rendered-run matches of every consumed `tool_result`; MessageList's row gate and `searchTick` copy use it, and `groupMayMatchSearch` probes consumed results so a closed group force-opens on a member-only hit.
3. **Per-block ordinal routing and preview conversion.** The active ordinal routes to exactly one card via `memberBlockOrdinals` (group members) / `assistantResultIdxByBlock` (non-folded assistant rows). The preview renders ONE lifecycle (`base`), seeks the owning card row — the plan/question owner-seek generalized to `toolResults`, `activeSubagents`, and `activeWorkflows` — walks `parent_tool_use_id` up to the ROOT ancestor item for sidechain-owned hits, and converts the server's result-message ordinal into member space with `resultHitMemberOrdinal`. A failed conversion lights no mark rather than misrouting a raw ordinal onto a diff or text block.

## The raw-runs contract

`toolResultBodyParts` / `toolResultTextRuns` derive the exact rendered pieces of a `tool_result` body, purely: string content → one text run; array/object content → text buffers (text blocks' `.text`, other non-image non-file blocks `formatJson(block)`) joined `\n\n`, flushed at each image run; text-only bodies collapse to ONE run; an empty body falls back to `formatJson(content)`. Every text buffer is ANSI-aware truncated at 4000 visible chars. The view is RAW runs, not markdown-flattened — markdown text blocks elsewhere keep their markdown view; only `tool_result` content uses this view. `extractMessagePlainText` (the prompt-editing/dedup canonical view) is unchanged.

Internal file blocks (`{type:'file'}`, native AttachmentRead plumbing) are skipped entirely, and when they are the only content the empty-body `formatJson` fallback is suppressed — a file name/digest/path can never leak into searchable text (pinned by `shared/search/segments.test.ts`).

Consumers: `ToolCard` → `ToolResultDetails` → `AnsiText` (render), `extractMessageSearchSegments`'s `tool_result` branch (server index, one segment per run), and all client match counts and ordinal walks. Counted text == searched text == rendered text is the invariant; a second derivation anywhere reintroduces the ordinal desync this decision removes.

## Ordinal space and routing

One ordinal space per row: **own segments first** (text blocks + `tool_use` diffs, in block order), **then consumed results** (in `tool_use` block order). `rowSearchMatchCount`, `blockActiveIdx`, `memberBlockOrdinals`, `assistantResultIdxByBlock`, and `resultHitMemberOrdinal`'s prefix all count in that order. A folded group row renders ALL its members, so the count sums over `members ?? [msg]` (the head is `members[0]`, counted exactly once); user rows carry no `tool_use` blocks, so their own `tool_result` segments are never double-counted through the map.

Routing is per-block, never broadcast. `memberBlockOrdinals` returns one `{diffIdx, resultIdx}` entry per `tool_use` block of a tool-only group member (the fold contract), and ToolGroupCard indexes it by the card's block position within its member; `assistantResultIdxByBlock` does the same for a non-folded assistant row with parallel calls. Only the block owning the active ordinal carries a number, so exactly one card lights `.search-hl-active`. `diffIdx` is diff-local; `resultIdx` is result-global across that id's runs, rebased per run inside `ToolResultDetails`. MessageList computes the assistant array and passes it as a prop ONLY to the active non-group row — MessageView never subscribes to `toolResults`, so a result landing mid-query churns one row, not every row (`result-consumed-identity.test.tsx` pins zero per-row churn).

The server's result-hit ordinal is message-local to the RESULT message (raw-runs space: one segment per rendered run of each `tool_result` block, block order). `resultHitMemberOrdinal` converts it: prefix = the member's own-segment match total (the same `extractPlainText` / `extractToolUseDiffText` views `blockActiveIdx` uses) plus the consumed-result run counts of the `tool_use` blocks BEFORE the owner; local = the ordinal minus the run counts of the `tool_result` blocks preceding the owner's block in the result message. Owner absent, result not landed, or local out of range → `undefined` → no active mark. The conversion applies to BOTH preview renders (main and sidechain). A sidechain-child hit scrolls the main view to the root ancestor card without a mark — the bespoke root card does not render child result text; the mark lives in the sidechain drill-in.

## Alternatives considered

- **Client-only hit filter.** Drop or hide consumed-result hits on the client instead of addressing them. Lost: tool output is most of what transcript search is for; filtering makes Grep/Edit results unfindable and silently shrinks the visible result list relative to the index.
- **Markdown view for results.** Index `tool_result` through the same markdown flattening as text blocks. Lost: the card renders raw runs through AnsiText, so a flattened index desyncs ordinals from rendered occurrences — a query for `**hi**` misses entirely when the renderer shows the asterisks literally. One raw view end-to-end is what makes server hit ordinals and client marks agree.
- **Keeping the un-merge.** The preview's copied lifecycle deleted `toolResults[resultId]` to render an orphan result bubble. Lost: the preview shows a form the transcript never shows, the orphan's ordinal space matches no live row, and the detail/content lifecycle split doubled preview state for a workaround. Deleting it makes preview and transcript one render model.
- **Interleaved ordinal order.** The first routing design interleaved diff and result counts per `tool_use` block. Lost: it desynced from `rowSearchMatchCount` and `blockActiveIdx`, which count own segments first — a multi-tool member's marks landed off by the preceding result counts. Segments-then-results is the single order every counter and walk shares.
- **MessageView subscribing to toolResults.** Reading `useToolResults()` inside MessageView routes ordinals where the map lives, but every result landing re-renders every row through context churn. Lost to the row-identity pin: MessageList computes the per-block array and feeds only the active row.

## Consequences

Bought: merged-result hits are countable, navigable, and highlightable in the exact form the transcript renders; closed groups force-open on member-only hits; preview and transcript share one lifecycle and one text view; the un-merge hack and its lifecycle split are gone.

Knowingly gave up:

- **Async-launch-ack matched text is not rendered in merged form.** A query matching only launch-ack boilerplate previews the owner card without the matched text visible: the ack is `async_metadata` on a running record and `subagentResultContent` never renders it. Rendering it needs capture+projection changes that preserve live suppression — parked as a product limitation (the live transcript has the same visibility).
- **Cross-member batched-result seek is heuristic.** `targetInfo.resultId` picks the first matching `tool_result` block, not `hit.ownerToolUseId`, so a result message batching several members' results can seek the wrong card. Degrades to no active mark, never a misrouted one. Pre-existing, deferred.
- **The 4000-visible-char truncation is a hard search boundary.** Text past it is neither rendered nor indexed; an ordinal past it converts to `undefined` (owner row shown, no mark). This is the price of count view == rendered view.
- **Pre-existing count/route desync on file-handle text.** `rowSearchMatchCount` counts assistant text through the cached segment view (which strips file handles) while the ordinal walks use `extractPlainText` without stripping (renderer authority kept). Rows whose text carries file-handle projections can count and route differently. Awareness only; untouched by this decision.
- **Main-view preview of a sidechain-child hit shows the root card unmarked** (child text is not rendered there); the mark requires drill-in. Before this decision the main view missed the seek entirely.

## Testing

The behavior is pinned end-to-end in vitest: `shared/tool-result-text.test.ts` (runs derivation, truncation, file-block privacy), `shared/search/segments.test.ts` (privacy pin), `server/session-search-index.test.ts` (raw-space hit ordinals), `src/components/message-list/search-addressing.test.ts` (count space, per-block routing, conversion round-trips through the routing walks), `MessageView.split.test.tsx` and `ToolGroupCard.test.tsx` (exactly-one active mark, multi-run rebase, closed-group force-open), `SessionSearchPreview.test.tsx` (merged form, owner/root seek, truncation no-mark, sidechain drill-in), and `result-consumed-identity.test.tsx` (zero per-row churn on result landing).
