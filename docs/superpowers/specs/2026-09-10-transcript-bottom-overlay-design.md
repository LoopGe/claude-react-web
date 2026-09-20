# Transcript bottom overlay: TASKLIST / MONITOR cards scroll messages behind them

Date: 2026-09-10

## Problem

The TASKLIST (`.todo-panel`, `TodoChecklist`) and MONITOR (`.monitor-bar`,
`MonitorBar`) cards are styled as floating cards but they do not float — they
sit **below** the transcript in normal flow, so nothing is ever behind them and
their frosted background has nothing to show through.

Measured in the running app (playwright, real session, 1920×911 chat):

```
.chat-messages-area   top  99  bottom 599   <- transcript (scrolls internally)
.todo-panel           top 599  bottom 857   <- the card, in flow
.working-bar          top 857  bottom 887
.chat-composer        top 919  bottom 1009
```

So the card is an in-flow flex item of `.chat`, sitting between the message
area and the WorkingBubble/composer group. `.chat` is
`display:flex; flex-direction:column; overflow:visible` — it does not scroll —
so the card's `position: sticky; top: 0` is **inert**. That is why the two
doc comments claiming it is "rendered at the top of the chat area" are wrong;
they are corrected as part of this change.

The user-facing request is therefore two things:

1. Messages should scroll **behind** the card (a real bottom overlay).
2. The card should be **transparent**, so the content passing behind it shows
   through.

The card shell (rounded corners, border, frosted background, shadow) already
exists; only the *overlay* half is missing.

## Goal / non-goals

**Goals**

- The TASKLIST and MONITOR cards float at the bottom of the transcript; settled
  messages scroll behind them and are visible through the frosted background.
- The live streaming text stays **above** the cards (the card is the bottom-most
  member of the stack).
- The bottom of the transcript **reserves** the stack's height, so the newest
  message can always be scrolled fully clear of the cards — never permanently
  hidden behind them. The reservation tracks the cards' real height (expand /
  collapse, task count).
- Reuse the existing single-source-of-truth machinery rather than adding a
  second one: the card must not reintroduce the documented "scrollbar sits one
  line short of the bottom" bug (`useTranscriptScroll.ts:524-549`).

**Non-goals**

- No change to the WorkingBubble / ctx-bar / composer group below the
  transcript — those stay in flow where they are.
- No change to `.chat-top-stack` (recap + pinned question) — that is a
  top-anchored overlay and is untouched.
- No change to the streaming region's animation, pruning, or pinning semantics
  beyond the source of its measured height.
- Not building a general-purpose bottom-overlay API. The stack has exactly two
  kinds of member: the streaming region and the task cards.

## Design

### 1. Structure

Chat.tsx stops rendering the cards as siblings of `.chat-messages-area` and
passes them down as a `bottomOverlay` ReactNode prop. Chat keeps ownership of
their props (`messages` / `working` / `skin` / `clearing` / `sessionId`), so no
new state moves into MessageList.

MessageList wraps the existing streaming region in a new bottom stack:

```
.chat-messages
  Virtuoso
  .chat-bottom-stack          <- NEW: position:absolute; left:0; right:0; bottom:0;
                                 z-index:2; display:flex; flex-direction:column;
                                 pointer-events:none
    .chat-streaming-region    <- existing; loses its own absolute positioning and
                                 becomes a normal flex child
    {bottomOverlay}           <- TodoChecklist + MonitorBar, in that order
  .chat-jump-to-bottom
```

Children re-enable `pointer-events: auto`, mirroring `.chat-top-stack`
(`overlays.css:289+`).

Ordering the streaming region first and the cards second is what produces the
chosen layout (streaming above, cards below) — it falls out of flex column
order, with no offsets.

### 2. Measurement and reservation

This generalises the existing single-overlay mechanism; it does not add a
second one.

- `MessageList.tsx:588-605` currently observes `streamingRegionRef` with a
  `ResizeObserver` and stores `streamingOverlayHeight` (`:292`). It will
  observe the `.chat-bottom-stack` root instead and the state is renamed
  `bottomStackHeight`. Because the stack is always mounted (unlike the streaming
  region, which is conditional on `hasVisibleStreamingContent`), the effect no
  longer needs that dependency — any child resize fires the observer.
- The measured height is the **whole stack**: streaming region + cards. With no
  streaming content it is just the cards; with neither it is 0.
- `MessageList.tsx:924-928` keeps feeding the Virtuoso `Footer` spacer from
  that value (`StreamingOverlaySpacer` → `BottomOverlaySpacer`,
  `frame-views.tsx:711-713`); the `> 0` gate is unchanged.
- `useTranscriptScroll.ts:543-549` re-pins keyed on the same value, so a card
  growing (expand, new task) re-pins the viewport in the same frame the spacer
  grows — this is the invariant that keeps the bug fixed.
- `.chat-jump-to-bottom` (`chat.css:442-445`, `bottom: 16px`) gets its `bottom`
  offset by the same height so the floating button clears the cards. With no
  cards the offset is 0 and today's position is unchanged.

### 3. Card styling

`.todo-panel` and `.monitor-bar` lose `position: sticky` and the vertical
margin, keeping the card shell and `margin: 0 var(--chat-reading-inset) 8px`
(left/right reading-column alignment, 8px gap to the next member / to the
WorkingBubble below the stack). The existing
`color-mix(in srgb, var(--bg) 75%, transparent)` + `backdrop-filter:
var(--glass-blur)` now sits over real content, which is what produces the
see-through effect. Skin behaviour is unchanged: `--radius-xl` is 0 under
`[data-skin="hc"]`, so the card squares off exactly like `.recap-window`.

### 4. Edge cases

- **Empty-state overlay** (`.chat-messages-empty`, `MessageList.tsx:1005`)
  covers the scroller; the cards only render when there are tasks, so they do
  not collide.
- **`/clear`** — the card keeps its `todo-panel-clearing` / `monitor-bar-clearing`
  `clear-blur-fade` animation and dissolves with the transcript; it is inside the
  stack, so it fades in place.
- **No streaming content** — stack height is just the cards; **neither** present
  — height 0, spacer removed by the existing `> 0` gate.
- **Reduced motion** — no new animation is introduced; the existing entrance /
  dissolve rules are untouched.

## Testing

- `MessageList.test.tsx:915-1044` (the streaming-spacer cases) is updated for the
  rename and extended with an assertion that a card's height reaches the spacer.
- The re-pin behaviour (`useTranscriptScroll.ts:543-549`) gets a case where the
  stack height changes without streaming content present.
- `TodoChecklist.test.tsx` / `MonitorBar.test.tsx` render the components in
  isolation and assert classes, not layout, so they should pass unmodified; an
  integration assertion that `.chat-bottom-stack` contains the cards is added.

## Files touched

- `src/components/Chat.tsx` — pass the cards as `bottomOverlay`.
- `src/components/MessageList.tsx` — render the stack, observe it, feed the spacer.
- `src/components/message-list/useTranscriptScroll.ts` — rename the height input.
- `src/components/message-list/views/frame-views.tsx` — spacer rename.
- `src/styles/chat.css` — `.chat-bottom-stack`, streaming region de-absolutised,
  jump-to-bottom offset.
- `src/styles/messages.css` — card shells drop sticky/margin.
- `src/components/TodoChecklist.tsx` — correct the stale "top of the chat area"
  doc comment.
