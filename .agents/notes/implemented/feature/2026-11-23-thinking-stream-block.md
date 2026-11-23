# Agent Note: Thinking stream block — wrapping, capped follow, hand-off fold

Status: implemented

## Problem

The live streaming thinking row (`.agents/notes` sibling feature: thinking
text renders in the transcript while it streams) had three defects:

1. **It never folded with an animation.** The design assumed `content_block_stop`
   folds the row (`done = true`) and the finalized frame arrives later. A WS
   probe against the real claude provider (2026-11-23) measured the opposite:
   the finalized `assistant` thinking frame arrives in the SAME millisecond as
   `content_block_stop`, **before it**. Supersede therefore cleared
   `thinkingDraft` first, so the stop-driven `done` flip never ran while a
   draft existed, and the settled row mounted a fresh closed
   `AnimatedDetails` (via `BlockView`) — an instant collapse, no animation.
2. **No text reveal.** The streaming leaf rendered a bare `<pre>`; the
   left→right reveal mask (`useStreamingReveal`) only ran for the text draft.
3. **The body was unbounded and raw.** `<pre>` defaults to `white-space: pre`,
   so reasoning lines grew a horizontal scroll area the reader could not see,
   a long block grew vertically without limit, and raw reasoning was rendered
   as monospace text instead of the markdown the model actually wrote.

## Decision

One `ThinkingBody` component (`src/components/message-list/thinking-body.tsx`,
renamed from `thinking-draft-body.tsx`) serves three states — live (store
subscription), settled (static text), frozen (static partial) — and is
rendered at the SAME `.msg-body` child slot for the live draft row and the
settled single-thinking-block row (`MessageView` renders it directly, not
through `BlockView`, and **not inside a Fragment**). Tree-slot type continuity
is the whole mechanism: a Fragment or a different component at that slot
remounts the block, and a freshly mounted closed `AnimatedDetails` pins height
0 and snaps instead of animating. Across the finalize hand-off the same
instance receives `done`/`open`, so the same `AnimatedDetails` plays the
existing 240ms fold. `BlockView`'s thinking branch delegates to the same
component, so split / merged frames, history and raw-report contexts render
identically.

The body now renders reasoning through the SAME markdown pipeline as the text
draft (`DraftBlocks`), inside a capped scroll viewport (`.thinking-body`):
`--thinking-stream-max-height` (`min(40vh, 320px)` default) with an inner
vertical scroll that follows the newest line while streaming
(`useStickToBottom`), pauses when the user scrolls up, resumes at the bottom;
`data-scrolled` / `data-at-bottom` drive sticky top/bottom fades
(`--bg-elev`) — the scrollbar is hidden like every other small scroller, so
those fades are the only "more above / more below" affordance. Wrapping and long-token
breaks come from the shared `.md` prose rules, not the old horizontal
scroller. The reveal mask rides `DraftBlocks`' `.md` root; thinking passes
`cursor={false}` (no typing caret). The summary preview is computed only while
the details is CLOSED (the open summary hides it), so the 80ms stream does not
run a whitespace-collapse regex over the whole accumulator per flush.
Settled/frozen blocks do not follow; opening one resets to the top (the fold
keeps the streamed viewport so content does not jump mid-fold).

## Alternatives considered

**Delay the fold's supersede until the animation completes.** Would preserve
the live row, but duplicates text in the store/transcript for up to 240ms and
needs a timer-driven state — conflicts with the pure-reducer model.

**Keep the pixel-parity contract across two renderers (draft leaf vs
`BlockView`).** This is what shipped first and is exactly what remounted the
closed details: different component types at the same tree position. Unifying
the component removes the second renderer instead of papering over the remount.

**Apply the reveal mask to the `<pre>` itself.** Masking the box would clip
its own background/border at the sweep edge on every tail line; the markdown
pipeline's `.md` root is the mask target instead (no box chrome of its own).

**Keep a raw `<pre>` body and only fix the wrapping.** Rejected by product
decision: reasoning should render as the markdown the model wrote (lists,
bold, code blocks), not monospace text.

## Consequences

- The settled expanded thinking body also uses the capped, followed, markdown
  viewport (user decision): long reasoning is read in a capped scroll window,
  not a horizontal scroller.
- Live merged frames (thinking + text in ONE live frame, rare) still render
  through the split path, which sits at a different tree position: no
  instance continuity, no fold animation. Documented accepted edge; disk
  replay has no draft and is unaffected.
- The top fade relies on `useStickToBottom` owning `data-scrolled`; it is
  imperative DOM state (like `aria-hidden` in AnimatedCollapse), not React
  state. `syncScrollState` is its single writer so the follow effect, the
  scroll listener and the open-reset cannot disagree.
- The markdown body compiles LAZILY: a settled/frozen row that has never been
  opened renders no `DraftBlocks` (history load does not pay a markdown parse
  per thinking row); `bodyShown` latches on first visibility so the exit fold
  and later re-expands keep the compiled content instead of blanking mid-animation.
- The `ThinkingBody` props are a discriminated union (live/settled/frozen).
  Frozen takes precedence over `sessionId` when both appear: frozen rows
  persist beside LATER live drafts and must never subscribe to or read them.
- Tests: `thinking-body.test.tsx` (three modes, markdown rendering, hand-off
  same-instance pin, pixel parity), `useStickToBottom.test.tsx`
  (follow/pause/resume, bottom tolerance), the MessageList hand-off test now
  pins the `details` node identity across draft→settled (the remount trap),
  and the extended render-isolation pin. Browser re-verification of a real
  thinking turn (growth → markdown wrap → capped follow → fold) is still
  required after this change.

## Related

- Spec: `docs/superpowers/specs/2026-11-23-streaming-thinking-design.md` §5.4/§5.5.
- [Inline streaming render is the default](2026-11-05-inline-streaming-default.md) —
  the text-draft mechanism this thinking row runs parallel to.
