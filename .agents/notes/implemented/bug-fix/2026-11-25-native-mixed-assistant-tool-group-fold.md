# Agent Note: Native mixed assistant messages fold via a row-layer block-kind split

Status: implemented

## Problem

Under the `native` provider, a tool batch whose assistant message also carries
preamble text or thinking rendered as bare inline tool cards and never collapsed
into a folded `ToolGroupCard`. Only a PURE tool_use assistant message formed a
group. Since native models routinely emit text/thinking alongside tool calls,
most native tool runs stayed permanently expanded — the claude provider folded
the same runs.

Root cause (proven by runtime repro): the native host adapter projects one
neutral assistant message — text/reasoning/tool-call blocks together, the raw
Anthropic API shape — as ONE SDK assistant frame
(`server/providers/native-host-frame-adapter.ts`, `projectAssistant`). The
claude CLI splits text/thinking and tool_use into SEPARATE assistant messages,
and the transcript row model treats that granularity as a premise:
`isToolGroupEligible` (`src/components/message-list/transcript-rows.ts`) returns
false for any message carrying a non-empty text or thinking block. A mixed
native message therefore never entered `foldToolGroupRows`.

The combined message shape is deliberate in the neutral core and stays:
model-history replay sends the original combined assistant message back to the
API, and splitting it there would break tool_use/tool_result pairing and
thinking-signature replay. The adapter reconstruction contract
(`docs/superpowers/specs/2026-11-21-native-frame-vocabulary-design.md`) pins
FIELD-level fidelity only; message granularity was an uncaptured implicit
premise of the client row model. Related seam decision:
[provider seam neutralization](../architecture/2026-11-18-provider-seam-neutralization.md).

## Decision

The display layer splits mixed assistant messages into consecutive block-kind
runs; the data layer (store, v3 log, wire, neutral core) keeps the combined
message verbatim. This is DSH's stance — data combined, display projected by
block kind (DSH's assistant node skips tool-call blocks; tool nodes own them;
a reply separates process groups) — expressed in this repo's row model.

- **`splitMixedAssistantMessage`** (`src/components/message-list/message-split.ts`)
  is the single shape predicate, provider-blind: an assistant message carrying
  both tool_use and non-tool blocks splits into maximal consecutive runs
  (tool_use runs vs non-tool runs, block order preserved, interleaving handled).
  Pure messages (claude's split frames included) return null and keep the
  original single-row path. Special frames (`isDraft` / `error` /
  `isApiErrorMessage` / `context_usage` / `usage_report`) return null — their
  top-level fields would duplicate across runs. Runs are enumerated by KIND,
  not visibility; empty runs are dropped by `willRenderEmpty` in `pushRow`
  without renumbering (the search routing shares the enumeration). Projected
  run messages are WeakMap-cached on the original message object for
  referential stability (the identity contract behind ToolGroupCard's member
  memo, MessageView's blocks memo, and the streaming-render-isolation pin).
- **`pushRow`** emits one row per run: derived id `${itemId}:r${runIndex}`,
  shared `itemIndex`, run-scoped lazy `plainText`. The first non-tool run is
  marked `draftHeir` — the row that adopts the in-place draft's alias key at
  settle. Tool runs are pure → fold-eligible; non-tool runs are boundaries →
  close the preceding group mid-turn (reply-separates-groups parity).
- **`rowDraftAlias`** gates the draft alias to the unsplit row or the heir run,
  shared by `computeItemKey`, `MeasuredItem`'s `data-crw-row-id` stamp, the
  anchor-reveal fallback, and the height-cache lookup (split runs share the
  uuid; an ungated lookup aliases every run to one draft key — duplicate React
  keys and colliding height writes). The height lookup now uses the same
  alias-first key MeasuredItem records under, closing a pre-existing draft-born
  row miss.
- **Search routing**: navigation is message-level (server ordinal always 0;
  `resultHitMemberOrdinal` rebases result hits onto the original member) and
  lives only in the static search preview. `routeSplitItemOrdinal`
  (`search-addressing.ts`) walks the WHOLE-message match space (own segments
  block order, then consumed results in tool_use order — NOT a concatenation of
  run spaces) and returns the owning run plus its run-local ordinal. MessageList
  resolves it once per active target (`resolveSplitRoute`, module-level pure
  function wrapped in `useMemo` — the build runs plain `@vitejs/plugin-react`
  with no React Compiler transform, so the manual memo is load-bearing for the
  seek-map identity; an inline memo body tripped the compiler lint's
  preserve-manual-memoization, extracting the body preserves it), joins run →
  row by message identity, and carries it through `searchRef` so `itemContent`
  stays identity-stable: active gating keys on the routed row id (not itemIndex
  equality, which would light every run), the group activates only when the
  routed run is one of its members, the seek map targets the routed row, and
  the seek dedupe includes the ordinal. The per-row walks (`blockActiveIdx`,
  `assistantResultIdxByBlock`, `memberBlockOrdinals`) are unchanged — they eat
  the projected run message and the run-local ordinal.
- **Entrance**: the arming loop skips a split heir ONLY when it actually adopts
  a draft alias (`draftRowKeys[msg.uuid]` present) — the heir then continues the
  draft's DOM (same React key) and a pop would glitch a continuing body; a
  bystander tab's heir (no draft) is a genuine arrival and animates. A tool-first
  settle ([draft] → [tool run, heir], delta +1) lands the heir at the only
  scanned index; the tool run sits below the window at prevLen-1 and is armed
  explicitly so the new tool card still pops.
- **Discard/rewind anchors**: the row wrapper stamps `data-message-uuid` beside
  `data-message-id`; Chat's context menu reads the uuid attribute (discard
  anchors key on the server uuid, and split runs carry derived row ids).
  `data-message-id` stays the row identity for scroll/anchor/reveal consumers.

## Alternatives considered

**Adapter splits frames (direction A).** Project one neutral assistant event
into several SDK frames at the host adapter, matching CLI granularity. Rejected
by the user in favor of the row-layer split: it would change the disk-replay
shape of existing native logs (the spec's round-trip pin compares against the
legacy combined lines), derive new uuids for existing sessions' search anchors,
and complicate the streaming draft → settled handoff. The row-layer split keeps
wire, log, uuids, and the pin untouched.

**Split the message in the neutral core / v3 log.** Rejected: the combined
assistant message is the API-faithful unit model-history replay must re-send;
splitting at the source breaks API request structure and thinking-signature
replay.

**Relax `isToolGroupEligible` to accept mixed messages without splitting.**
Rejected: `ToolGroupCard` extracts only tool_use blocks per member, so the
text/thinking blocks would vanish from rendering. A split is unavoidable
somewhere; the row layer is the display-only seat.

## Consequences

- Native mixed turns now render text/thinking as boundary rows and tool runs as
  folded groups, parity with claude; pure native messages and all claude
  messages are unchanged (the split is a no-op for them). Sidechain mixed
  frames split too (the predicate has no parent gate); sidechain tool rows
  still never fold (`isToolGroupEligible`'s parent check).
- The split also fixes `[tool_use, empty-text]` folding: an empty text sibling
  no longer breaks eligibility (kind-based runs + `willRenderEmpty` drop).
- **Known v1 divergence**: adjacent boundary tools in one run
  (`[Edit, AskUserQuestion]`) form a single mixed tool run that is ineligible
  as a whole, so the Edit does not fold either (claude's per-block split folds
  it). Boundary-aware run refinement is a follow-up candidate.
- **Follow-up candidate**: `routeSplitItemOrdinal` is the fourth hand-copy of
  the own-segments-then-results ordinal walk (beside `memberBlockOrdinals`,
  `assistantResultIdxByBlock`, `resultHitMemberOrdinal`), kept in lockstep by
  comments. Extracting one shared segment-attribution walker would remove the
  multi-site maintenance risk; deferred to keep this fix's diff bounded.
- **One-time effect**: a pre-feature panel-cache scroll snapshot whose anchor
  is a bare uuid that now splits resolves to `crwAnchorMissing` → pixel
  fallback. Post-feature snapshots use the gated alias/derived ids and resolve.
- The store, neutral core, v3 log, wire adapter, server search index, fold
  state machine, exports (store-message walk), copy (DOM selection), and
  rewind (user-message anchors) are untouched.
- Pinned by: `message-split.test.ts` (split predicate, identity, alias gate),
  `search-addressing.test.ts` (`routeSplitItemOrdinal` two-pass attribution,
  whole-space-not-concatenation, out-of-range), `transcript-rows.test.ts`
  (run rows, derived ids, heir, two-groups-one-itemIndex, orphan guard),
  `MeasuredItem.test.tsx` (heir stamp, non-heir collision guard),
  `MessageList.test.tsx` (split-item search gating, result-hit routing, heir
  entrance exclusion, uuid stamp).
