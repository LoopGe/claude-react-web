# Dual-Mode Streaming Render Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `inline` streaming render mode (live turn text as an in-flow tail row at the end of the Virtuoso list) alongside the existing bottom-overlay `StreamingFooter`, sharing one renderer component, selected by a code-level seam that defaults to today's overlay behavior.

**Architecture:** `MessageList` gains a `streamingMode` prop (default from `DEFAULT_STREAMING_RENDER_MODE = 'overlay'`). In inline mode a `StreamingRowItem` is appended to Virtuoso's `data` as a tail element of the union `VirtuosoItem = TranscriptRow | StreamingRowItem`; `itemContent` renders it via `<StreamingFooter variant="inline">`. Overlay mode returns `renderableItems` itself so `data` identity stays per-items stable. No store / reducer / WS changes.

**Tech Stack:** React 19, react-virtuoso, vitest + @testing-library/react (jsdom), plain CSS with theme variables.

**Spec:** `docs/superpowers/specs/2026-09-29-dual-mode-streaming-render-design.md`

**Deviations from the spec (all simplify; the spec's goals/semantics are unchanged):**
- §1's `VirtuosoItem` is `TranscriptRow | { kind: 'streaming'; content: string }` (not a `{ kind: 'row', row }` wrapper): the streaming item carries its content, so `itemContent`'s ~140-line body needs only a top early-return plus a TS narrowing — no `item.row.` re-plumb, no per-flush dep churn. The spec's `'kind' in item` narrowing rule is kept (`TranscriptRow` has no `kind` field).
- §1's two-memo sketch collapses to one ternary that returns `renderableItems` **itself** in overlay mode (same identity guarantee — overlay never rebuilds `data`; inline rebuilds per flush, which §Risks already accepts).
- §8's key-sentinel test is folded into the finalize test: react keys are not DOM-observable through the Virtuoso mock, and `STREAMING_ROW_KEY` is a module constant distinct from every message uuid by construction.
- §1's "defensive guard" in `handleRangeChanged` is downgraded to a comment: verified that the handler only reads `range.startIndex` (a number) and DOM geometry — it never dereferences a data item, and a tail append cannot become `startIndex` while rows exist (a user row always precedes streamed text).
- NEW (implementation constraint): `useMergedRef` captures its refs on first render, so `<StreamingFooter>` call sites pass `key={variant}` to force a clean remount if the variant ever flips live (matters when a future UI toggle lands).

## Global Constraints

- Default mode `'overlay'`: production behavior byte-identical to today. The existing test suite is the regression fence — every currently-green test stays green.
- ZERO changes to: `src/session-store/**`, `shared/**`, `server/**`, WS protocol. The `streamingContent` pipeline (80 ms flush, finalize pruning, sidechain tagging) is renderer-agnostic and untouched.
- No new npm dependencies.
- CSS: theme variables only — never hardcode hex colors (`CLAUDE.md`). No new colors are introduced by this plan.
- `npm run typecheck` runs BOTH tsconfigs (browser + node); run it after each task that touches `.tsx`.
- Tests live in existing files that are already jsdom via `vitest.config.ts` `environmentMatchGlobs`. Do NOT add per-file `afterEach(cleanup)` (project rule — `src/test-setup.ts` owns it).
- Commit messages end with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.
- `git status` shows unrelated dirty files (`Chat.tsx`, `ContextOrb.tsx`, `chat.css` is dirty, various screenshots) — stage ONLY files this plan touches, never `git add -A`.

## Review Focus

Failure modes the spec implies but jsdom tests cannot exercise — each is covered by the Task 3 browser pass:

1. **followOutput on last-item growth in real Chromium** — the mock only fires `followOutput` on data-length increase; real Virtuoso also fires on last-item size change. Expected: while following, the growing inline row keeps the viewport pinned to the newest text without a visible one-frame yank.
2. **Interrupted turn in inline mode** — hit Stop mid-stream. Expected: the row vanishes at the result frame with no stuck partial row and no console errors (overlay already behaves this way; inline must too).
3. **Reverse infinite scroll while streaming in inline mode** — scroll up mid-turn so older pages prepend. Expected: prepends land above, the streaming row stays the tail, no key/prepend glitches (tail-append design keeps every index mapping valid).
4. **Session switch away and back mid-turn in inline mode** — expected: on return, the row reappears with the in-flight text still accumulated (benign reconnect preserves `liveTurn`).
5. **Live variant flip** — flip `DEFAULT_STREAMING_RENDER_MODE` while a turn streams (HMR or reload). Expected: no detached scrollbar/glass artifacts after remount (`key={variant}` guarantees the clean remount; automated test not practical in jsdom).

---

### Task 1: `StreamingFooter` gains a `variant` prop

**Files:**
- Modify: `src/components/message-list/transcript-chrome.tsx` (the `StreamingFooter` memo, lines 66–206; everything above it — `OlderHistoryHeader`, the disabled `StreamCodeSegment` block, the imports — stays untouched)
- Test: `src/components/message-list/transcript-chrome.test.tsx`

**Interfaces:**
- Consumes: nothing new (existing hooks `useOverlayScrollbar`, `useMergedRef`, `useLiquidGlass`).
- Produces: `export type StreamingFooterVariant = 'overlay' | 'inline'`; prop `variant?: StreamingFooterVariant` (default `'overlay'`). DOM contract for Task 2 and the CSS: when `inline`, the wrapper carries `.streaming-footer-wrapper--inline`, the bubble carries `.streaming-msg--inline`, and `.liquid-glass-defs` / `.streaming-refraction` / `liquid-glass` are absent; the body keeps `.streaming-plain`, the newline fold, and the cursor, and has NO overlay-scrollbar attachment (`data-os-native-hidden` absent, no `.os-track`).

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe('StreamingFooter', ...)` in `src/components/message-list/transcript-chrome.test.tsx`:

```tsx
  it('inline variant: plain text + cursor, no glass, no scrollbar chrome, no cap class', () => {
    const { container } = render(
      <StreamingFooter content={'para one\n\n\npara two'} variant="inline" />,
    )
    const wrapper = container.querySelector('.streaming-footer-wrapper')
    expect(wrapper?.classList.contains('streaming-footer-wrapper--inline')).toBe(true)
    const bubble = container.querySelector('.streaming-msg')
    expect(bubble?.classList.contains('streaming-msg--inline')).toBe(true)
    // In-flow row has nothing behind it to refract — glass chrome must be off.
    expect(bubble?.classList.contains('liquid-glass')).toBe(false)
    expect(container.querySelector('.liquid-glass-defs')).toBeNull()
    expect(container.querySelector('.streaming-refraction')).toBeNull()
    // Shared body semantics survive: newline fold + cursor.
    const body = container.querySelector('.streaming-plain')
    expect(body?.textContent).toContain('para one\npara two')
    expect(body?.querySelector('.streaming-cursor')).toBeTruthy()
    // The uncapped body is NOT a scroll container: no overlay-scrollbar
    // attachment (that chrome exists for the capped overlay bubble only).
    expect(body?.hasAttribute('data-os-native-hidden')).toBe(false)
    expect(bubble?.querySelector('.os-track')).toBeNull()
  })

  it('overlay variant (explicit): keeps glass-capable bubble and scrollbar chrome', () => {
    // Pins the default: passing variant="overlay" explicitly must behave
    // exactly like the no-prop renders the earlier tests assert.
    const longContent = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n')
    const { container } = render(<StreamingFooter content={longContent} variant="overlay" />)
    const scroller = container.querySelector('.streaming-plain') as HTMLElement
    expect(scroller.hasAttribute('data-os-native-hidden')).toBe(true)
    expect(container.querySelector('.streaming-msg')?.classList.contains('streaming-msg--inline')).toBe(false)
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/message-list/transcript-chrome.test.tsx`
Expected: FAIL — TS error on the unknown `variant` prop / the new class assertions never match (both new tests red; the two existing tests stay green).

- [ ] **Step 3: Implement the variant**

In `src/components/message-list/transcript-chrome.tsx`, replace the whole `StreamingFooter` memo (lines 66–206) with the version below. Preserve every explanatory comment that still applies (the replacement carries the load-bearing ones; comments above the component — the disabled `StreamCodeSegment` block and the file-top note — are untouched):

```tsx
/** Where the live-turn bubble renders. 'overlay': the capped bubble pinned
 *  below the Virtuoso scroller (`.chat-bottom-stack`). 'inline': an in-flow
 *  tail row at the end of the Virtuoso list — uncapped, scrolls with the
 *  transcript, no glass (nothing behind it to refract), no internal
 *  scrollbar (the body never scrolls). */
export type StreamingFooterVariant = 'overlay' | 'inline'

export const StreamingFooter = memo(function StreamingFooter({
  content,
  variant = 'overlay',
}: {
  content: string
  variant?: StreamingFooterVariant
}) {
  const inline = variant === 'inline'
  // Render the in-progress turn as PLAIN TEXT, not Markdown. The live turn
  // flushes a growing string many times per second; running Markdown and
  // syntax highlighting over the accumulated text on every flush is costly.
  const bodyRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  // Overlay-only: the capped bubble is a scroll container and gets the
  // project's overlay scrollbar. The inline body is uncapped and never
  // scrolls, so there is nothing to attach; the hook stays called (rules of
  // hooks) but its ref is not merged in. `key={variant}` at the call sites
  // remounts the component on a variant flip, which keeps useMergedRef's
  // first-render ref capture correct.
  const setOsScroller = useOverlayScrollbar({ autoHide: 'leave' })
  const setBodyRef = useMergedRef(bodyRef, inline ? null : setOsScroller)

  useEffect(() => {
    if (inline) return
    const el = bodyRef.current
    if (!el) return
    const onScroll = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      followRef.current = distanceFromBottom <= 24
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [inline])

  useEffect(() => {
    if (inline) return
    const el = bodyRef.current
    if (!el) return
    if (followRef.current) el.scrollTop = el.scrollHeight
  }, [content, inline])

  // The streaming bubble sizes to its content directly — no JS height
  // animation. (See Anim C1 in the audit for why the old max-height
  // transition was removed.)
  const msgRef = useRef<HTMLDivElement>(null)

  // Liquid-glass refraction — overlay-only. The filter samples the transcript
  // BEHIND the bubble; an in-flow row has nothing behind it, so glass is
  // meaningless there and `enabled` keeps the hook dormant. supported is
  // false off-Chromium and in jsdom either way.
  const GLASS_STRENGTH = 22
  const { supported, filterId, feImageRef, feDispRef } = useLiquidGlass(msgRef, {
    radius: 8,
    bezel: 16,
    strength: GLASS_STRENGTH,
    enabled: !inline,
  })
  const glassActive = supported && !inline
  const glassFilter = `blur(2px) url(#${filterId})`

  // Fold markdown's STRUCTURAL whitespace (\n\n between paragraphs, list
  // items, code-fence delimiters) to a single break so the plain-text preview
  // doesn't flash blank lines the settled markdown render would never show.
  const displayContent = useMemo(() => content.replace(/\n{2,}/g, '\n'), [content])

  return (
    <div
      className={`streaming-footer-wrapper${inline ? ' streaming-footer-wrapper--inline' : ''}`}
    >
      {glassActive && (
        <svg className="liquid-glass-defs" width="0" height="0" aria-hidden="true" focusable="false">
          <defs>
            <filter
              id={filterId}
              x="-30%"
              y="-30%"
              width="160%"
              height="160%"
              colorInterpolationFilters="sRGB"
            >
              {/* x/y=0 pin the map to the element origin. Without them the SVG
                  default subregion (0%,0% of the filter region) starts at the
                  filter region's -30% offset, so the element's right/bottom
                  ~30% sample outside the map and get a hard -scale/2 smear. */}
              <feImage ref={feImageRef} result="map" preserveAspectRatio="none" x="0" y="0" />
              <feDisplacementMap
                ref={feDispRef}
                in="SourceGraphic"
                in2="map"
                scale={GLASS_STRENGTH}
                xChannelSelector="R"
                yChannelSelector="G"
              />
            </filter>
          </defs>
        </svg>
      )}
      <div
        ref={msgRef}
        className={`msg streaming-msg${glassActive ? ' liquid-glass' : ''}${inline ? ' streaming-msg--inline' : ''}`}
      >
        {glassActive && (
          <span
            className="streaming-refraction"
            aria-hidden="true"
            style={{ backdropFilter: glassFilter, WebkitBackdropFilter: glassFilter }}
          />
        )}
        <div ref={setBodyRef} className="msg-body assistant-body streaming-plain" aria-live="polite" aria-atomic="false">
          {displayContent}
          <span className="streaming-cursor" />
          {/* StreamCodeSegment / splitStreamSegments disabled — see above. */}
        </div>
      </div>
    </div>
  )
})
```

Notes:
- `useLiquidGlass` already accepts `enabled?: boolean` (`src/hooks/useLiquidGlass.ts:33`) — no hook change needed.
- `useMergedRef` accepts `null` entries (`src/utils/mergedRef.ts:33`).
- The old `streamingRegionClassName`-adjacent code, the `aria-live` attributes, and the fold (`displayContent`) are preserved exactly.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/components/message-list/transcript-chrome.test.tsx`
Expected: PASS — all 4 active tests (2 existing + 2 new). The disabled code-block tests stay commented out.

- [ ] **Step 5: Commit**

```bash
git add src/components/message-list/transcript-chrome.tsx src/components/message-list/transcript-chrome.test.tsx
git commit -m "feat(streaming): StreamingFooter variant prop (overlay | inline)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: MessageList inline mode (seam + tail row + CSS)

**Files:**
- Modify: `src/components/MessageList.tsx` (sites listed below, current line numbers)
- Modify: `src/styles/chat.css` (append after the `.streaming-plain` block, ~line 2148)
- Test: `src/components/MessageList.test.tsx`

**Interfaces:**
- Consumes: `<StreamingFooter content variant="inline">` (Task 1) with the Task 1 DOM contract.
- Produces: `export type StreamingRenderMode = 'overlay' | 'inline'`; `export const DEFAULT_STREAMING_RENDER_MODE: StreamingRenderMode = 'overlay'`; optional prop `streamingMode?: StreamingRenderMode` (default = the constant; the future UI toggle threads through here). Internal: `STREAMING_ROW_KEY`, `StreamingRowItem`, `VirtuosoItem`, `virtuosoData`.

- [ ] **Step 1: Write the failing tests**

In `src/components/MessageList.test.tsx`, add these tests inside the main `describe('MessageList', ...)` (they use the existing `makeMsg` / `toItems` helpers, `fireResize`, and `virtuosoMockState` — all already defined in the file):

```tsx
  it('inline mode: renders the live turn as an in-flow tail row inside the scroller', () => {
    const msgs = [makeMsg('user', { message: { content: [{ type: 'text', text: 'q' }] } })]
    const { container } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} streamingMode="inline" streamingContent="streaming answer" />,
    )
    // In-list, as the LAST data row.
    const list = container.querySelector('[data-testid="virtuoso-item-list"]') as HTMLElement
    expect(list).not.toBeNull()
    const rows = list.querySelectorAll('[data-item-index]')
    const last = rows[rows.length - 1]
    expect(last?.querySelector('.streaming-footer-wrapper--inline')).not.toBeNull()
    expect(last?.querySelector('.streaming-plain')?.textContent).toContain('streaming answer')
    // The overlay path must NOT double-render: the overlay region is
    // overlay-mode-only.
    expect(container.querySelector('.chat-streaming-clip')).toBeNull()
    // Overlay default is untouched by this test's prop choice — the bare
    // render in the regression fence below covers it.
  })

  it('inline mode: no streaming row before text arrives or after it clears', () => {
    const msgs = [makeMsg('user', { message: { content: [{ type: 'text', text: 'q' }] } })]
    const props = { items: toItems(msgs as SdkMessage[]), streamingMode: 'inline' as const }
    const { container, rerender } = render(<MessageList {...props} streamingContent="" />)
    // '' = pre-text phase (or all-sidechain turn): no row, no overlay region.
    expect(container.querySelector('.streaming-footer-wrapper')).toBeNull()
    rerender(<MessageList {...props} streamingContent="tail text" />)
    expect(container.querySelector('.streaming-msg--inline')?.textContent).toContain('tail text')
    rerender(<MessageList {...props} streamingContent={null} />)
    expect(container.querySelector('.streaming-footer-wrapper')).toBeNull()
  })

  it('inline mode: finalize swaps the streaming row for the settled message (no double bubble)', () => {
    const user = makeMsg('user', { uuid: 'q-1', message: { content: [{ type: 'text', text: 'q' }] } })
    const assistant = makeMsg('assistant', {
      uuid: 'a-1',
      message: { content: [{ type: 'text', text: 'partial answer' }] },
    })
    const { container, rerender } = render(
      <MessageList
        items={toItems([user] as SdkMessage[])}
        streamingMode="inline"
        streamingContent="partial answer"
      />,
    )
    expect(container.querySelectorAll('.streaming-footer-wrapper')).toHaveLength(1)
    // Finalize: the settled assistant lands while the store prunes the live
    // text to null — same commit, the row unmounts above the settled row.
    rerender(
      <MessageList
        items={toItems([user, assistant] as SdkMessage[])}
        streamingMode="inline"
        streamingContent={null}
      />,
    )
    expect(container.querySelector('.streaming-footer-wrapper')).toBeNull()
    expect(container.querySelector('[data-message-id="a-1"]')).not.toBeNull()
    // Exactly one copy of the text on screen: the settled message. (The key
    // sentinel STREAMING_ROW_KEY is what lets React drop the old row without
    // colliding with the new one — observable here as "no duplicate".)
    const occurrences = (container.textContent ?? '').split('partial answer').length - 1
    expect(occurrences).toBe(1)
  })

  it('overlay mode (default): the streaming region stays in the bottom stack, nothing in-list', () => {
    // Regression fence for the seam: without streamingMode, NOTHING in-list.
    const msgs = [makeMsg('user', { message: { content: [{ type: 'text', text: 'q' }] } })]
    const { container } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} streamingContent="streaming answer" />,
    )
    expect(container.querySelector('.chat-streaming-clip .streaming-footer-wrapper')).not.toBeNull()
    const list = container.querySelector('[data-testid="virtuoso-item-list"]') as HTMLElement
    expect(list.querySelector('.streaming-footer-wrapper')).toBeNull()
  })

  it('inline mode: streaming-row growth re-pins the viewport to the bottom', () => {
    // Mirrors the geometry-stub pattern of the overlay re-pin regression
    // tests: local scrollHeight/clientHeight/scrollTop over the scroller,
    // fired through the item-list ResizeObserver the way a real browser does.
    vi.useFakeTimers()
    virtuosoMockState.atBottomReport = true
    virtuosoMockState.reportBeforeRef = true
    virtuosoMockState.streamingSpacerHeight = 0

    let contentHeight = 200
    let rawScrollTop = 200

    const msgs = [makeMsg('user', { message: { content: [{ type: 'text', text: 'q' }] } })]
    const { container } = render(
      <MessageList
        items={toItems(msgs as SdkMessage[])}
        streamingMode="inline"
        streamingContent="growing tail"
      />,
    )

    const scroller = container.querySelector('.chat-virtuoso-scroller') as HTMLElement
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => contentHeight })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 100 })
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => {
        const max = Math.max(0, contentHeight - 100)
        if (rawScrollTop > max) rawScrollTop = max // browser clamp-on-shrink
        return rawScrollTop
      },
      set: (v: number) => { rawScrollTop = v },
    })

    // The inline row grows by 120px; the item-list observer fires.
    contentHeight = 320
    const itemList = scroller.querySelector('[data-testid="virtuoso-item-list"]') as HTMLElement
    act(() => { fireResize(itemList) })

    // The viewport MUST follow to the new bottom (320 - 100).
    expect(scroller.scrollTop).toBe(220)
    vi.useRealTimers()
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/MessageList.test.tsx`
Expected: FAIL — TS error on the unknown `streamingMode` prop (the new tests are red; every existing test stays green).

- [ ] **Step 3: Implement the seam and the tail row in MessageList.tsx**

All edits in `src/components/MessageList.tsx`, current line numbers:

**(a) Module scope — after `EMPTY_VIRT_IDX` (line ~63), add:**

```ts
/** Where the live turn's text renders. 'overlay' (default): the capped
 *  bottom-overlay bubble in `.chat-bottom-stack` (current behavior).
 *  'inline': an in-flow tail row at the end of the Virtuoso list — grows
 *  with the turn, scrolls with the transcript, scrollable back through
 *  (the card-era feel). Selected by the module constant; a future UI
 *  setting threads through the `streamingMode` prop. See
 *  docs/superpowers/specs/2026-09-29-dual-mode-streaming-render-design.md. */
export type StreamingRenderMode = 'overlay' | 'inline'
export const DEFAULT_STREAMING_RENDER_MODE: StreamingRenderMode = 'overlay'

/** Virtualization key of the inline streaming tail row. A module constant
 *  distinct from every message uuid, so the finalized row that replaces it
 *  can never collide in React's key space. */
const STREAMING_ROW_KEY = 'live-turn-streaming'

/** The inline-mode live turn as a Virtuoso data element. NOT a TranscriptRow:
 *  it has no message, no itemIndex, no plainText — consumers that iterate
 *  rows (`renderableItems`) never see it. Narrow with `'kind' in item`
 *  (TranscriptRow carries no `kind` field, so the negative branch of the
 *  narrow is TranscriptRow). */
interface StreamingRowItem {
  kind: 'streaming'
  content: string
}
type VirtuosoItem = TranscriptRow | StreamingRowItem
```

Ensure `TranscriptRow` is in the type-import list from `'./message-list/transcript-rows'` (the import block at lines ~30–42 already pulls from that module; add `TranscriptRow` if absent).

**(b) Props — after `streamingContent` (line ~135), add:**

```ts
  /** Which streaming render mode this transcript uses. Defaults to the
   *  module constant (currently 'overlay'). Exists as a prop so tests can
   *  force either mode and a future UI setting can thread through without
   *  touching internals. */
  streamingMode?: StreamingRenderMode
```

**(c) Component body — destructure the prop in the function signature and resolve once, before the presence block (line ~383):**

```ts
const resolvedMode = streamingMode ?? DEFAULT_STREAMING_RENDER_MODE
```

**(d) Presence gate — the presence/exit-fade machinery is overlay-only. At line ~394, after `liveStreamingContent` is computed, add and use `presenceSource` in the presence computation (replace EVERY `liveStreamingContent` read inside lines 395–406 with `presenceSource` — six reads: the two in the `useState` initializer, the ternary condition, the `!= null` check, and the two in the true-branch object; leave the `liveStreamingContent` const itself and its `'' → null` gate untouched):**

```ts
// The exit-fade presence machinery is overlay-only: the inline row unmounts
// abruptly at finalize (spec §6 — no fade), so in inline mode presence must
// never see a non-null source (which would churn the 180ms exit timer for a
// region that never renders).
const presenceSource = resolvedMode === 'overlay' ? liveStreamingContent : null
```

**(e) Data wiring — immediately before the `virtuosoComponents` memo (line ~1151), add:**

```ts
// Inline mode appends the live turn as a TAIL data row. Overlay mode returns
// `renderableItems` ITSELF, so Virtuoso's `data` identity stays per-items
// stable there — the per-flush rebuild is inline-only (spec §Risks). The tail
// append never shifts an existing row's index, so `itemToVirtIdx` /
// `nextItemTypeMap` / entrance-gating (all built from `renderableItems`)
// stay valid; `handleRangeChanged` reads only `range.startIndex` (a number —
// a tail append can never become startIndex while rows exist), so it needs
// no guard.
const virtuosoData: VirtuosoItem[] =
  resolvedMode === 'inline' && liveStreamingContent != null
    ? [...renderableItems, { kind: 'streaming', content: liveStreamingContent }]
    : renderableItems
```

**(f) `itemContent` — change the signature to accept the union and add the top branch (line ~953):**

```ts
  const itemContent = useCallback((_index: number, item: VirtuosoItem) => {
    if ('kind' in item && item.kind === 'streaming') {
      // Inline-mode live turn row (spec §1). No data-message-id, no
      // enter-animation hooks, no reveal snapshot: it is not a message and
      // unmounts at finalize. Fresh content arrives via the item (the data
      // array is rebuilt per flush in inline mode).
      return (
        <div className={TRANSCRIPT_ROW_CLASS}>
          <StreamingFooter content={item.content} variant="inline" />
        </div>
      )
    }
    // ... existing body unchanged — `item` is narrowed to TranscriptRow here.
```

The rest of the body and the deps array stay EXACTLY as they are (the branch introduces no new reactive values).

**(g) `computeItemKey` (line ~1123):**

```ts
  const computeItemKey = useCallback(
    (_index: number, item: VirtuosoItem) => ('kind' in item ? STREAMING_ROW_KEY : item.id),
    [],
  )
```

**(h) Virtuoso JSX (lines ~1220–1222):** `data={virtuosoData}` and
`initialTopMostItemIndex={virtuosoData.length > 0 ? virtuosoData.length - 1 : 0}`.

**(i) Overlay region gate (line ~1263):** change
`{visibleStreamingContent != null && (` to
`{resolvedMode === 'overlay' && visibleStreamingContent != null && (`.
The `visibleStreamingContent` / `streamingRegionClassName` consts stay — they only feed this region.

- [ ] **Step 4: Add the inline CSS variant**

Append to `src/styles/chat.css` directly after the `.streaming-plain` rule (after line ~2148):

```css
/* ---- Inline streaming row (streamingMode='inline') ----
   The live turn renders as an in-flow tail row at the end of the Virtuoso
   list: uncapped (the transcript scrolls — the row is part of it), no
   internal scrollbar, no glass. Shares the bubble chrome (.streaming-msg)
   and plain-text body (.streaming-plain) with the overlay variant; only the
   cap/scroll/mask chrome differs. */
.streaming-footer-wrapper--inline {
  /* The overlay wrapper sets pointer-events:none so it never blocks
     scrolling; an in-flow row is real content and must be selectable. */
  pointer-events: auto;
}
.streaming-msg--inline .streaming-plain {
  max-height: none;
  overflow-y: visible;
  scroll-padding-bottom: 0;
  -webkit-mask-image: none;
  mask-image: none;
}
```

(The base `.streaming-plain` keeps its cap/mask/overflow rules for the overlay variant; specificity of the `--inline` descendant selector overrides them. The breathing-glow animation on `.streaming-msg` is inherited and kept — it is the live-turn signal in both variants.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/components/MessageList.test.tsx src/components/message-list/transcript-chrome.test.tsx`
Expected: PASS — the 5 new tests green, ALL existing tests green (the overlay regression fence).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS (both tsconfig projects — the `VirtuosoItem` union narrows cleanly; `TranscriptRow` must be imported as a type).

- [ ] **Step 7: Commit**

```bash
git add src/components/MessageList.tsx src/styles/chat.css src/components/MessageList.test.tsx
git commit -m "feat(streaming): inline in-list streaming mode behind streamingMode seam (default overlay)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: Whole-branch verification + browser pass

**Files:**
- Modify: none (verification only; `DEFAULT_STREAMING_RENDER_MODE` is flipped and REVERTED locally, never committed as `inline`)

**Interfaces:**
- Consumes: Tasks 1–2 complete. Produces: verification evidence for the Review Focus list.

- [ ] **Step 1: Full automated gate**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: all three PASS. `npm run test` includes the server unit tests — they must be untouched/green (constraint: zero server changes).

- [ ] **Step 2: Overlay regression pass (default)**

Run: `npm run dev`, open `http://localhost:5174`, start a turn in any session.
Expected: the streaming preview behaves exactly as before — capped 3-line bubble below the transcript, liquid glass, 180 ms exit fade, task checklist stacking below it. Compare against `git stash`-free main behavior; any difference is a defect in Task 2's gating.

- [ ] **Step 3: Inline experience pass**

In `src/components/MessageList.tsx`, temporarily change
`DEFAULT_STREAMING_RENDER_MODE: StreamingRenderMode = 'overlay'` to `'inline'` (do NOT commit this). Reload, start a long text-heavy turn.
Expected (from the spec + Review Focus):
1. The live text grows as an in-flow row at the transcript tail, scrollable back through, no 3-line cap.
2. Viewport stays pinned to the newest text while following (Review Focus #1); scrolling up mid-turn prepends older pages and the row stays the tail (#3).
3. At finalize the row swaps for the settled message — no double bubble, no blank gap.
4. Interrupt the turn mid-stream (#2): row vanishes cleanly at the result frame.
5. Switch sessions away and back mid-turn (#4): the row reappears with the in-flight text.
6. While the dev server is up, HMR-flip the constant mid-turn (#5): no scrollbar/glass artifacts after remount.

Revert the constant to `'overlay'`. Verify `git diff` shows no leftover change to it.

- [ ] **Step 4: Final review before merge**

Per the project rule (CLAUDE.md): run the `code-review` skill on the full branch diff (`git diff main...HEAD` or the commit range), verify findings, fix, re-review non-trivial fixes. Only then is the branch done.

- [ ] **Step 5: Final commit (if review produced fixes)**

```bash
git add -u
git commit -m "fix(streaming): review fixes for dual-mode streaming render

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```
