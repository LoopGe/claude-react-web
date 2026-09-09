# Row-level tool group folding

Date: 2026-09-09
Status: approved design (approach 1 — fold in the row model)

## Problem

Historical tool calls flood the transcript. Each tool is a full `ToolCard` that the user rarely expands. We want consecutive intermediate tool calls to collapse into one group card.

### Why the first attempt failed

The first implementation grouped consecutive `tool_use` **blocks inside one assistant message**. That never fires in practice:

- Live session JSONL (`080e899c-…`): 114 messages with `tool_use`, **every one has exactly 1 block**
- Assistant block-type combinations across the whole file: `{tool_use}:131`, `{thinking}:67`, `{text}:17` — **never mixed**

The SDK emits one `tool_use` per assistant message. Grouping must therefore operate **across consecutive assistant rows** in the transcript row model, not across blocks inside one message.

### Actual filtered row shape

After `willRenderEmpty` drops consumed `tool_result`-only user frames, a typical tool cascade looks like:

```
assistant(tool_use: Glob)
assistant(tool_use: Grep)
assistant(tool_use: Glob)
assistant(thinking)          ← boundary
assistant(tool_use: Read)
assistant(tool_use: Read)
assistant(text)              ← boundary
user(...)
```

Measured on the current session (tool_result-only user frames removed):

- 55 tool runs; 37 have length ≥ 2; max length 4
- Thinking always arrives as its own assistant message and naturally breaks runs

Groups of 2–4 tools are common enough to be worth folding. Thinking stays a boundary (already a one-line collapsed card; swallowing it into the group would hide inter-tool reasoning and complicate membership).

## Goals

1. Fold runs of **≥ 2 consecutive tool-only assistant rows** into one collapsible group row.
2. Settled groups default **collapsed**; groups with a running tool or pending interactive (Plan / Question) default **open**.
3. Collapsed header still surfaces running / waiting / failed — a failure or blocked turn is never hidden.
4. A lone tool row keeps today's appearance (no group chrome).
5. Preserve virtualization invariants I1 (stable unique row ids) and I3 (mid-list row removal is already a supported pattern).
6. Search navigation still reaches matches inside every member of a group.

## Non-goals

- Cross-message grouping of thinking + tools (thinking is a boundary).
- Persisting per-group expand state across reloads (local component state only).
- Changing any tool view / ToolCard internals.
- Grouping inside a single assistant message's blocks (unreachable with current SDK shape; the dead first-attempt code is removed).

## Approach

Fold in `buildTranscriptRows` after the existing filter pass. A folded group is one `TranscriptRow` whose id is the **first member's uuid**.

### Why first-member id

When a live cascade grows from 1 tool to 2:

```
before:  [ …, row(uuid1), row(uuid2), … ]
after:   [ …, row(uuid1, members=[1,2]), … ]
```

Virtuoso sees: same key `uuid1` (height grows, remeasure) + `uuid2` disappears from the middle — the exact mid-list removal pattern `willRenderEmpty` already produces (invariant I3). A synthetic `tool-group-…` id would introduce a brand-new key and orphan the previous measurement.

Length-1 runs are **not** rewritten: they stay ordinary rows. The group chrome only appears when length ≥ 2, so the 1→2 transition is "row grows a header + absorbs the next row", not "two rows become a different component type".

### Membership predicate

A row is **group-eligible** iff:

- `msg.type === 'assistant'`
- `parent_tool_use_id` is null/undefined (root transcript; subagent overlay uses the same builder with its own filter and gets the same rule for its children)
- it has ≥ 1 `tool_use` block
- it has **no** visible non-tool content: no non-empty `text`, no non-empty `thinking`
- it is not compact-summary, not hiddenByDefault, not the api_retry synthetic row

Consecutive = adjacent in the **post-filter** row list (so a consumed `tool_result` frame that vanishes does not split the run). A non-eligible row (user, thinking, text, result, system, compact summary, synthetic leading/trailing) breaks the run.

Runs of length ≥ 2 become one group row. Runs of length 1 stay as-is.

### Row shape

```ts
export interface TranscriptRow {
  id: string
  msg: SdkMessage                 // FIRST member (kept for back-compat / entrance gate)
  // … existing fields …
  /** Present only on a folded group row. */
  toolGroup?: {
    /** Member messages in order, including the first (same ref as msg). */
    members: SdkMessage[]
    /** items[] indices of every member — search reverse-map keys. */
    memberItemIndices: number[]
    /** Member row ids (= message uuids), for keys inside the group body. */
    memberIds: string[]
  }
}
```

`itemIndex` on a group row stays the **first** member's `items[]` index (so existing single-entry maps keep working for the common case). `toolGroup.memberItemIndices` carries the full set.

`renderableIndex` is the group's index in `out[]`.

`nextItemTypeMap` keys on group id; next type is whatever follows the group (or the type after the last member in the unfiltered mental model — practically, the next surviving row).

### Search

`itemToVirtIdx` must map **every** member's `itemIndex` to the group's virt index:

```ts
for (let vi = 0; vi < renderableItems.length; vi++) {
  const row = renderableItems[vi]
  if (row.toolGroup) {
    for (const ii of row.toolGroup.memberItemIndices) map.set(ii, vi)
  } else {
    map.set(row.itemIndex, vi)
  }
}
```

`itemContent` active-match routing:

```ts
const isActiveItem =
  searchActiveMsgIdx != null &&
  searchActiveMsgIdx >= 0 &&
  (item.itemIndex === searchActiveMsgIdx ||
    item.toolGroup?.memberItemIndices.includes(searchActiveMsgIdx) === true)
```

The group card receives `activeMemberItemIndex = searchActiveMsgIdx` and only the member whose `itemIndex` matches gets `activeMatchInItem`; others get `undefined`.

Search force-expand of a group: expand when any member's name / serialized input may contain the query (reuse `groupMayMatchSearch`), matching the first attempt's "only expand on likely hit" refinement. Tool *results* still force-expand themselves via `ToolResultDetails` when they contain a hit.

### Collapse state

| Condition | Default |
|---|---|
| Any member tool status `running` (or missing id) | open |
| Any pending Plan (`planStatus` default `pending`) or pending Question | open |
| Search hit on group name/input | open |
| All settled, no search hit | **closed** |
| Length === 1 | open, no header (not a group row at all) |

Manual toggle stored in local component state (`userOpen: boolean | null`). Search hit and `isSingle` win over a manual close.

### Collapsed header

```
▸  4 tools · Read×2 · Grep · Edit          [running|waiting|failed]
```

- `running` — any member running (accent, spinner)
- `waiting` — pending interactive, none running (accent + question icon)
- `failed` — any member error, none running/pending (danger)

Error/pending also get an inset box-shadow on the header (`.tool-group-has-error` / `.tool-group-has-pending`).

### Children

The group body maps each member message's `tool_use` blocks through the existing `BlockView` → `ToolUseBlock` path, identical to today's assistant body. Thinking/text never appear inside a group because membership excludes them. Do **not** re-enter the full `MessageView` for members (avoids a second assistant chrome per tool and keeps the group header the only outer frame).

Status maps (`toolStatus`, `planStatus`, `questionAnswers`, `toolResults`) stay provided at the MessageList level; children read them via context exactly as today.

### Virtualization / height

- Expand/collapse changes one row's height → Virtuoso remeasures that key.
- 1→2 growth: key `uuid1` persists; `uuid2` removed mid-list.
- Collapse uses `hidden` on the body (children stay mounted) so Plan/Question/ToolCard internal state (open details, permission chips) survives a fold — same contract as `AnimatedDetails unmountOnExit={false}`.

### Entrance animation

`useTranscriptAnimations` keys on `row.id`. A group uses the first member's id, so when the second member joins, the group does **not** replay `msg-enter` (id already seen / not a new arrival). A brand-new cascade's first tool still animates.

## Files

| File | Change |
|---|---|
| `src/components/message-list/transcript-rows.ts` | Post-filter fold pass; extend `TranscriptRow` with `toolGroup?` |
| `src/components/message-list/transcript-rows.test.ts` | Fold membership, id stability on 1→2, boundary cases |
| `src/components/MessageList.tsx` | `itemToVirtIdx` multi-map; `itemContent` group branch + active-member routing |
| `src/components/message-list/ToolGroupCard.tsx` | Rewrite to take `members: SdkMessage[]` + active member index |
| `src/components/message-list/tool-grouping.ts` | Keep `summarizeToolGroup` / `groupMayMatchSearch` (input: the group's tool_use blocks, extracted from `members`); delete `groupAssistantBlocks` (block-in-message fold is unreachable) |
| `src/components/message-list/MessageView.tsx` | **Revert** the first-attempt block-level grouping (dead code; also wraps every tool in a `tool-group-single` div) |
| `src/styles/utilities.css` | Keep `.tool-group-*` chrome; drop rules only needed for the reverted single-block wrapper if any |
| Tests | `ToolGroupCard.test.tsx` update to message-shaped props; MessageList search-to-group test |

## Error handling / edge cases

- **Group of special tools** (ExitPlanMode / AskUserQuestion / Agent): allowed inside a group; pending forces open + `waiting` badge. If this proves noisy in practice, a follow-up can split them out — not in v1.
- **Orphan tool_result still visible** (result not yet consumed): the user frame sits between two assistant tool rows, so they are **not** consecutive and do not fold until the result merges. Groups therefore form once tools settle enough for results to merge — acceptable, and avoids folding around orphan bubbles.
- **Compact summary / api_retry / synthetic subagent rows**: never group-eligible; they break runs.
- **Duplicate ids**: existing DEV check stays; group id is a member uuid already in the unique set (the member rows are removed from `out[]`, so no duplicate).
- **Subagent overlay**: same builder; grouping applies automatically to a subagent's own tool cascade.

## Testing

1. `groupAssistantBlocks` unit tests **replaced** by `foldToolGroupRows` (or equivalent) tests:
   - run of 2+ tool-only assistant items → one group row, id = first uuid
   - run of 1 → unchanged row
   - thinking / text / user / result break runs
   - 1→2 growth: id stable, second id absent
   - `memberItemIndices` order and contents
2. `itemToVirtIdx`: every member index maps to the group's virt index
3. `ToolGroupCard`: collapsed when settled; open when running/pending; badges; toggle; search hit vs miss
4. MessageList integration: search seek lands on the group row when the hit is in a non-first member
5. Existing MessageList / transcript-rows suites stay green

## Implementation order (for the plan)

1. Revert MessageView block-level grouping + clean CSS/tests that only served it
2. Row-model fold + unit tests
3. MessageList search/render wiring
4. ToolGroupCard rewrite to message members
5. CSS polish + full client test pass + code-review

## Open questions

None blocking. Special-tool breakout and persist-expand-state are explicit non-goals for v1.
