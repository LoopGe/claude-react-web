# Agent Note: Compact SubagentCard with detail-owned results

Status: implemented

## Problem

`SubagentCard` rendered every internal tool call while the subagent was live, so its height grew without bound. The card also duplicated result content already available in `SubagentOverlay`, making the inline summary visually inconsistent with the rest of the transcript.

Removing those regions exposed a second requirement: async output arrives through several channels (sidechain text, main-thread tool results, task notifications, and terminal task snapshots). If the card stopped rendering results, every channel still needed a correct detail-view path without duplicate replies or launch metadata.

## Decision

The inline card is a compact summary. It keeps status, task label, async/sync mode, elapsed time, tool count, and the detail entry point. Live cards optionally show progress and one current or most-recently-running child tool. Full tool history and results live only in the existing side detail. Terminal cards retain only the summary header; there is no inline expansion or result section.

Result rendering is provenance-driven through `ActiveSubagent.resultOrigin`:

- `streamed` records output captured from sidechain text. Detail rendering keeps matching text in its original rows, but restores it from the captured result if those rows are trimmed or absent from a bounded preview.
- `notification` creates a terminal synthetic result from a full task notification or terminal snapshot.
- `summary` retains summary-only completion information until a fuller result is available.
- `tool_result` preserves a real main-thread result; only a full notification or snapshot may replace it.
- `async_metadata` marks launch/detach acknowledgements and never creates a final-response row.

Result precedence is explicit: original sidechain output wins when it matches the repackaged completion, while a different full result wins over earlier progress. Main-thread tool_results retain their final-write behavior against summaries, and full completions can recover stale summaries and error states. Older terminal notifications cannot overwrite newer completion state. Stopped output must not mask an existing failure; a valid stopped result may finish as done, while a stop without usable output remains interrupted. Replay preserves result, tool-call, task, and timing metadata, and duplicate child tool_use frames do not inflate counts.

Search preview keeps two views of the same reducer output: the root transcript temporarily unwraps a matched result for highlighting, while sidechain detail reads the untouched canonical record. This avoids a second result-precedence implementation in the preview. Detail rows project the captured result against the visible sidechain: existing text is not duplicated, supplemental image and other blocks are appended, and missing source rows use the captured result as a fallback. The disk-backed resource transcript uses the same result projection.

## Alternatives considered

- **Fixed-height scrolling tool list:** rejected because it still spent transcript space on information already available in the detail drawer and retained a second expansion interaction.
- **Latest-started child regardless of status:** rejected because parallel tools can settle out of order; the card prefers a still-running child before falling back to the latest settled call.
- **Transcript-wide duplicate detection:** rejected because canonical Markdown differs from raw results, repeated prose is not proof of identity, and full main-thread scans add cost and replay races. The detail-only projection instead compares one record with its visible sidechain and supplements missing content; it does not infer global message identity.
- **A resultSourceUuid/dedupeWithItemId protocol:** rejected in favor of origin precedence. It addressed only one duplicate shape while adding trimmed-source, eviction, and replay-order edge cases.
- **Automatically opening detail on an active search match:** reverted because it reopens the drawer after Close/Back, can open multiple Agents from one assistant message, and drops match position and grouped-tool semantics. Search-specific navigation needs a separate design.
- **Removing child result payloads:** deferred. The compact card no longer reads those payloads, but detail rendering still uses them and changing retention is independent of the visual refactor.

## Consequences

The card's height is independent of tool count: one activity line during live work and one summary line after completion. The UI keeps a single full-detail surface instead of duplicating it inline.

The trade-off is a broader result-lifecycle contract in `sidechain-index.ts`. Tests must cover notification/snapshot ordering, replay re-delivery, summary enrichment, detach acknowledgements, late streamed output, stale terminal frames, non-text results, and stopped/failed tasks. The change deliberately does not redesign search navigation or child-payload retention.

## Verification

Focused suites cover `SubagentCard`, `MessageList`, search preview, transcript rows, synthetic rows, disk transcripts, task resources, `sidechain-index`, and the reducer, including parallel tools, terminal states, replay, result recovery, mixed content, and complete long results. Browser verification observed a live background subagent grow from two to five tools while retaining one activity row and a constant activity height; its completed card retained only the summary header. Final verification passed both TypeScript projects, ESLint (26 pre-existing warnings), Agent Notes validation, 702 test files with 9,778 passing tests and 8 skipped, and the production build.
