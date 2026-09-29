# Dual-mode streaming render: bottom overlay (default) + inline in-list row

Date: 2026-09-29

## Problem

The live turn's text renders exclusively through `StreamingFooter` as a
bottom overlay (`MessageList.tsx:1262-1272`): a 3-line-capped plain-text
bubble (`chat.css` `.streaming-plain` `max-height: calc(3lh + 20px)`)
pinned **below** the Virtuoso scroller, with a Footer-slot spacer
reserving its height so settled messages scroll "under" it. The live
text is not part of the transcript flow — it cannot be scrolled back
through, and the newest content shows only in a ticker-style capped
window. The card-era render (0.2.5, commit `7a36884f`) — streaming text
as an in-flow element at the end of the list, growing with the turn and
scrollable like any message — was replaced by this overlay for
performance and scroll-stability reasons that remain valid; but the
overlay's *shape* (capped ticker) is a separate property from its
*architecture* (out-of-scroller overlay), and only the architecture
needed to survive.

We want both render modes to coexist, sharing one renderer component,
with a code-level seam to switch between them — no UI toggle yet.

## Goal / non-goals

- **Goal:** add an `inline` streaming render mode: the live turn's text
  renders as an in-flow tail row at the end of the Virtuoso list — grows
  with the turn, scrolls with the transcript, scrollable back through,
  natively measured (no custom RO/spacer for it).
- **Goal:** `StreamingFooter` is retained and remains the single
  renderer for BOTH modes, selected by a `variant` prop. The overlay
  mode's behavior is unchanged byte-for-byte when the mode is `overlay`.
- **Goal:** mode seam = a module constant `DEFAULT_STREAMING_RENDER_MODE`
  (value `'overlay'`) plus an optional `streamingMode` prop on
  `MessageList` that overrides it. Production never passes the prop; a
  future UI switch threads a setting through it; tests force either mode
  via it.
- **Non-goal:** a UI switch (deferred — the prop is its insertion point).
- **Non-goal:** live Markdown / code-block rendering during streaming
  (`StreamCodeSegment` / `splitStreamSegments` stay disabled — see
  `transcript-chrome.tsx:31-64`).
- **Non-goal:** an exit-fade in inline mode (see turn-end semantics).
- **Non-goal:** any store / reducer / WS-protocol change. The data
  pipeline (`liveTurn.flushedText` → `streamingContent`, 80 ms flush,
  finalize-time pruning, sidechain tagging) is renderer-agnostic and
  untouched.

## Design

### 1. Carrier: tail data item — NOT the Virtuoso Footer slot, NOT a TranscriptRow field

Two carriers were rejected during design, with reasons that must survive
into the implementation:

- **`TranscriptRow` + synthetic row inside `renderableItems`:** rejected.
  `TranscriptRow.msg` is a required `SdkMessage`; making it nullable
  ripples into every row consumer — the search index loop
  (`MessageList.tsx:635`), the `userMsgIndices` scan (`:754`),
  `nextItemTypeMap`, the entrance-animation gate — each gaining a null
  branch for a row only one mode ever renders.
- **Virtuoso `Footer` slot (the 0.2.5 carrier):** rejected for two
  reasons. First, the slot is occupied: `virtuosoComponents.Footer`
  renders `BottomOverlaySpacer` (`MessageList.tsx:1163-1166`), and the
  bottom-stack task cards still need that reservation in BOTH modes.
  Second, react-virtuoso **remounts** a `components.*` component when its
  identity changes; a Footer that receives fresh content per flush either
  remounts every flush (the 0.2.8-era jank: a new component identity per
  `streamingContent` change) or must be identity-stable and fed through
  an external-store bridge (`useSyncExternalStore` + notify-on-flush) —
  new machinery whose only purpose is avoiding a data-model change.

The chosen carrier keeps `TranscriptRow` untouched and isolates the
streaming row behind a wrapper union:

```ts
// MessageList.tsx
type VirtuosoItem =
  | { kind: 'row'; row: TranscriptRow }
  | { kind: 'streaming' }            // content read at render time

const STREAMING_ROW_KEY = 'live-turn-streaming'
```

`data` becomes `VirtuosoItem[]`, built in **two memos** so the overlay
mode's `data` identity stays per-items stable (a single memo depending on
`liveStreamingContent` would produce a fresh array every flush in both
modes):

```ts
const rowsPart = useMemo(
  () => renderableItems.map((row) => ({ kind: 'row' as const, row })),
  [renderableItems],
)
const virtuosoData = useMemo(() => {
  if (resolvedMode !== 'inline' || liveStreamingContent == null) return rowsPart
  return [...rowsPart, { kind: 'streaming' as const }]
}, [rowsPart, resolvedMode, liveStreamingContent])
```

Overlay mode returns `rowsPart` itself — same identity Virtuoso saw
before (per-items). Inline mode concatenates per flush; the cost is
accepted and bounded (see Risks).

Because the streaming item is an **append-only tail**, every existing
index mapping stays valid: `itemToVirtIdx` / `nextItemTypeMap` /
entrance gating all iterate `renderableItems` (rows) and never see the
wrapper; a tail append never shifts a row's Virtuoso index. The guard
sites are exactly four:

| Site | Change |
| --- | --- |
| `data={virtuosoData}` | type widens to `VirtuosoItem[]` |
| `itemContent` | branch: `kind === 'streaming'` → `<StreamingFooter variant="inline" content={liveStreamingContent!} />`; otherwise delegate to the existing body with `item.row` |
| `computeItemKey` | `kind === 'streaming'` → `STREAMING_ROW_KEY`; else `item.row.id` |
| `initialTopMostItemIndex` | `virtuosoData.length - 1` instead of `renderableItems.length - 1` |

Plus one defensive guard: `handleRangeChanged` /
visible-top mapping iterate items that may now include the streaming
item — it has no `itemIndex`/plainText, so range-derived loops skip
`kind !== 'row'`.

### 2. Mode seam

```ts
// MessageList.tsx (module scope)
export type StreamingRenderMode = 'overlay' | 'inline'
export const DEFAULT_STREAMING_RENDER_MODE: StreamingRenderMode = 'overlay'
```

`MessageList` gains `streamingMode?: StreamingRenderMode` (default
`DEFAULT_STREAMING_RENDER_MODE`), resolved once at the top of the
component body:

```ts
const resolvedMode = streamingMode ?? DEFAULT_STREAMING_RENDER_MODE
```

All mode-dependent branches read `resolvedMode`. Default production
behavior is byte-identical to today; switching the app to inline is a
one-line constant change; a future settings toggle passes the setting
down as the prop.

### 3. Presence / exit-fade is overlay-only

The `streamingPresence` state machine + `STREAMING_EXIT_MS` (180 ms)
fade (`MessageList.tsx:383-428`) runs only when
`resolvedMode === 'overlay'` (early-return guard). Inline reads
`liveStreamingContent` directly (line 394's `'' → null` gate applies in
both modes — no pre-text empty bubble either way).

### 4. StreamingFooter gains `variant`

```tsx
<StreamingFooter content={...} variant="overlay" | "inline" />   // default 'overlay'
```

- **Shared:** plain-text body (`.streaming-plain`), the `\n{2,} → \n`
  fold (`transcript-chrome.tsx:138`), the `streaming-cursor`, the
  `.msg .streaming-msg` bubble chrome.
- **overlay-only:** the liquid-glass filter + refraction span (needs the
  transcript behind the bubble to sample — an in-flow row has nothing
  behind it), the internal scroll-follow effects (meaningless when the
  body is uncapped), the capped height + gradient masks (CSS).
- **inline-only:** the `streaming-msg--inline` class selecting the
  uncapped CSS variant.

### 5. Follow & measurement (inline)

No new observers. The tail row's growth is handled by the mechanisms
already in place:

- `followOutput` — react-virtuoso re-fires it when the **last item's
  size changes**, not only on item addition; the streaming row IS the
  last item while mounted.
- `alignToBottom` + the existing item-list ResizeObserver backstop in
  `useTranscriptScroll` cover the estimate-correction cases the card era
  hit (the `increaseViewportBy: 600` pre-render also still applies).

### 6. Turn-end semantics (inline)

No exit fade. The sequence at finalize: `pruneFinalizedLiveTurnText`
(`reducer.ts:2672`) drops the main-thread segments → `streamingContent`
projects to `''` → the `'' → null` gate unmounts the streaming row in
the same commit in which the finalized assistant message's row mounts
above it (assistant lands ~10–16 ms before `result`). No double bubble
(the class of bug `ecb74556` fixed), no blank gap, and unrendered-tail
text is never lost (the pruning invariant: the finalized message
contains everything streamed). Sidechain-only turns project to `''` and
take the same path.

### 7. CSS

- `.streaming-footer-wrapper--inline` + `.streaming-msg--inline`: no
  `max-height`, no internal overflow, no gradient fade masks; horizontal
  reading width and `--chat-row-gap` rhythm inherited from the existing
  `.streaming-msg` / wrapper rules so the row reads like a message.
- The `streaming-region-in` entrance keyframes (animating
  `max-height: calc(3lh + 72px)`) stay overlay-only; the inline row gets
  no entrance animation.
- No theme-variable additions needed (reuses existing tokens; no new
  colors).

### 8. Tests

- `transcript-chrome.test.tsx` — `variant="inline"`: renders plain text
  + cursor; does NOT render the glass defs / refraction span; does NOT
  apply the capped/scroll classes; the newline fold still applies.
  Existing overlay-variant tests unchanged.
- `MessageList.test.tsx` (pass `streamingMode="inline"`):
  - the streaming row renders inside the scroller at the list tail with
    the live content;
  - absent when content is `''`/null (pre-text phase, post-finalize);
  - finalize → result produces the settled row and no duplicate bubble;
  - growth keeps the viewport pinned to bottom (mirror of the existing
    re-pin regression tests, exercising followOutput on last-item growth);
  - `computeItemKey` returns the sentinel for the streaming row (no key
    collision with the settled row that replaces it).
- All existing overlay-mode tests pass unchanged (default mode is
  byte-identical behavior — this is the regression fence).

## Files touched

| File | Change |
| --- | --- |
| `src/components/MessageList.tsx` | mode constant + prop; `VirtuosoItem` union + `virtuosoData` memo; 4 guard sites; presence gated to overlay; overlay region gated to overlay |
| `src/components/message-list/transcript-chrome.tsx` | `variant` prop; gate glass + internal scroll-follow |
| `src/styles/chat.css` | `--inline` variant classes (uncapped) |
| `src/components/MessageList.test.tsx` | inline-mode cases |
| `src/components/message-list/transcript-chrome.test.tsx` | inline-variant cases |

Estimated diff: ~150–250 lines including tests.

## Risks

- **Per-flush `virtuosoData` identity** (inline mode only, by the
  two-memo design in §1): react-virtuoso re-invokes `itemContent` for the
  visible range on data change; rows are memoized so unchanged rows bail
  in reconciliation. The card era paid this cost with full Markdown per
  flush; plain text is strictly cheaper. Overlay mode is unaffected — it
  returns `rowsPart` unchanged.
- **followOutput-on-last-item-growth** relies on react-virtuoso behavior;
  if a flush path misses it, the existing item-list RO re-pin backstop
  catches the growth (same machinery `b35b7cac` hardened).
- **Range-derived loops** must skip the streaming item (no
  `itemIndex`/`plainText`); enumerated above as the fourth guard site.
