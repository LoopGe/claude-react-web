# Transcript Bottom Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the TASKLIST / MONITOR cards a real bottom overlay of the transcript, so settled messages scroll behind them and show through their frosted background, with the stack's height reserved so no message is permanently hidden.

**Architecture:** Generalise the existing single-overlay machinery rather than adding a second one. Today the live streaming bubble is an absolutely-positioned region inside MessageList whose height is measured by a `ResizeObserver` and reserved through a Virtuoso `Footer` spacer (`virtuoso-streaming-spacer`); `useTranscriptScroll` excludes that spacer from every "distance from bottom" calculation and re-pins the viewport in a layout effect keyed on the committed height. We wrap the streaming region and the two cards in one `.chat-bottom-stack`, measure the stack, and feed the same spacer / re-pin / bottom-geometry paths.

**Tech Stack:** React 19, TypeScript, Vitest + @testing-library/react (jsdom), plain CSS with theme tokens, react-virtuoso (mocked in tests).

**Spec:** `docs/superpowers/specs/2026-09-10-transcript-bottom-overlay-design.md`

## Global Constraints

- Never hardcode colour hex values — use theme CSS variables only, and every new token must exist in both `:root` and `[data-theme="light"]` (existing tokens used here: `--bg`, `--border`, `--glass-blur`, `--drawer-shadow`, `--radius-xl`, `--chat-reading-inset`).
- All diagnostic logging goes through `createLogger(scope)`; never bare `console.*`. (This change adds no logging.)
- The card components are rendered in isolation by their own tests and assert classes, not layout — those suites must pass **unmodified**.
- `--radius-xl` is `0` under `[data-skin="hc"]`; the cards must keep squaring off there automatically (do not hardcode a radius).
- Do not change `.chat-top-stack` (recap + pinned question) — it is a separate top-anchored overlay.
- Do not change the WorkingBubble / ctx-bar / composer group; they stay in flow below the transcript.

---

### Task 1: Rename the streaming-spacer machinery to the bottom-spacer

Pure mechanical rename — no behaviour change. It lands first so later tasks read honestly (the spacer now reserves room for the whole stack, not just the streaming bubble). Every site below was located by `grep -rn "streamingOverlayHeight" src` plus a grep for the DOM class, so the list is complete; missing the `useTranscriptScroll` DOM query would silently break bottom-detection, which is why it is enumerated explicitly.

**Files:**
- Modify: `src/components/message-list/views/frame-views.tsx:711-713`
- Modify: `src/components/MessageList.tsx:33,292,574,926`
- Modify: `src/components/message-list/useTranscriptScroll.ts:50-61,97,153,543-549`
- Test: `src/components/MessageList.test.tsx:132,172,959,1034`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `BottomOverlaySpacer({ height }: { height: number })` rendering `div.virtuoso-bottom-spacer`; `useTranscriptScroll` option `bottomStackHeight: number`; `getBottomSpacerHeight(el: HTMLElement): number`.

- [ ] **Step 1: Rename the spacer component and its DOM class**

In `src/components/message-list/views/frame-views.tsx`:

```tsx
export const BottomOverlaySpacer = memo(function BottomOverlaySpacer({ height }: { height: number }) {
  return <div className="virtuoso-bottom-spacer" style={{ height }} aria-hidden />
})
```

- [ ] **Step 2: Rename the state and the import in MessageList**

In `src/components/MessageList.tsx`: import `BottomOverlaySpacer` (was `StreamingOverlaySpacer`), rename the state pair `streamingOverlayHeight` / `setStreamingOverlayHeight` → `bottomStackHeight` / `setBottomStackHeight` at the `useState(0)` declaration, render `<BottomOverlaySpacer height={bottomStackHeight} />` in the `Footer` slot, and pass `bottomStackHeight` (was `streamingOverlayHeight`) into `useTranscriptScroll`.

- [ ] **Step 3: Rename the helper, the class query, and the option**

In `src/components/message-list/useTranscriptScroll.ts`: rename the option field `streamingOverlayHeight` → `bottomStackHeight` (both the interface member at `:97` and the destructuring at `:153`), and update the re-pin layout effect (`:543-549`) so its dependency array and its comments use the new name. The helper becomes:

```ts
/**
 * Height of the bottom-overlay spacer currently rendered in Virtuoso's Footer
 * slot, or 0 when there is none.
 *
 * Excluded from every "how far from the bottom are we" calculation: the spacer
 * reserves room for the absolutely-positioned live typing bubble AND the task
 * cards stacked beneath it, so counting it would make a viewport that is
 * visually pinned to the last settled message read as ~110px short of the
 * bottom.
 */
const getBottomSpacerHeight = (el: HTMLElement) => {
  const spacer = el.querySelector<HTMLElement>('.virtuoso-bottom-spacer')
  if (!spacer) return 0
  // (rest of the body is unchanged — rect height, then the style-height fallback)
}
```

`getDistanceFromBottom` (`:63-65`) keeps calling the renamed helper.

- [ ] **Step 4: Update the test mock and queries**

In `src/components/MessageList.test.tsx`: the Virtuoso mock's rendered spacer `className="virtuoso-streaming-spacer"` → `"virtuoso-bottom-spacer"`, and the three `querySelector('.virtuoso-streaming-spacer')` calls → `.virtuoso-bottom-spacer`.

- [ ] **Step 5: Run the tests to verify the rename is complete**

Run: `npx vitest run src/components/MessageList.test.tsx`
Expected: PASS (same count as before the rename — this task must not change behaviour).

- [ ] **Step 6: Confirm no stale references remain**

Run: `grep -rn "streamingOverlayHeight\|virtuoso-streaming-spacer\|StreamingOverlaySpacer\|getStreamingSpacerHeight" src`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add src/components/message-list/views/frame-views.tsx src/components/MessageList.tsx src/components/message-list/useTranscriptScroll.ts src/components/MessageList.test.tsx
git commit -m "refactor: rename streaming overlay spacer to bottom overlay spacer"
```

---

### Task 2: Wrap the streaming region and cards in one measured bottom stack

**Files:**
- Modify: `src/components/MessageList.tsx` (props interface `:67`, destructuring `~:277`, refs `:286`, measurement effect `:588-605`, render `:1020-1040`)
- Test: `src/components/MessageList.test.tsx`

**Interfaces:**
- Consumes: `BottomOverlaySpacer` / `bottomStackHeight` from Task 1.
- Produces: `MessageList` prop `bottomOverlay?: React.ReactNode`; DOM `div.chat-bottom-stack` containing the conditional streaming region followed by `bottomOverlay`.

- [ ] **Step 1: Write the failing test**

Append to `src/components/MessageList.test.tsx` inside the existing top-level `describe` (it uses the file's existing `makeMsg` / `toItems` helpers and the `fireResize` / `virtuosoMockState` infrastructure):

```tsx
it('renders a bottom stack containing the streaming region and the bottomOverlay', () => {
  const msgs = [
    makeMsg('assistant', { message: { content: [{ type: 'text', text: 'Settled' }] } }),
  ]
  const { container, rerender } = render(
    <MessageList
      items={toItems(msgs as SdkMessage[])}
      streamingContent="Live tokens"
      bottomOverlay={<div className="probe-card">card</div>}
    />,
  )

  const stack = container.querySelector('.chat-bottom-stack') as HTMLElement
  expect(stack).not.toBeNull()
  expect(stack.querySelector('.chat-streaming-region')).not.toBeNull()
  expect(stack.querySelector('.probe-card')).not.toBeNull()
  // Streaming region first, cards after — the chosen stacking order.
  const kids = Array.from(stack.children)
  expect(kids[0].className).toContain('chat-streaming-region')
  expect(kids[1].className).toContain('probe-card')

  // The stack is always mounted, even with no streaming content and no cards.
  rerender(<MessageList items={toItems(msgs as SdkMessage[])} streamingContent="" />)
  const stack2 = container.querySelector('.chat-bottom-stack') as HTMLElement
  expect(stack2).not.toBeNull()
  expect(stack2.querySelector('.chat-streaming-region')).toBeNull()
})

it('drives the bottom spacer from the STACK height, not the streaming region', () => {
  virtuosoMockState.scrollHeight = 200
  virtuosoMockState.clientHeight = 100

  const msgs = [
    makeMsg('assistant', { message: { content: [{ type: 'text', text: 'Settled' }] } }),
  ]
  const { container } = render(
    <MessageList
      items={toItems(msgs as SdkMessage[])}
      streamingContent=""
      bottomOverlay={<div className="probe-card">card</div>}
    />,
  )

  const stack = container.querySelector('.chat-bottom-stack') as HTMLElement
  expect(stack).not.toBeNull()

  // No streaming content: the stack's height is purely the cards' height.
  let stackHeight = 0
  Object.defineProperty(stack, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ height: stackHeight, width: 400, top: 0, left: 0, right: 400, bottom: stackHeight, x: 0, y: 0 }),
  })

  const scroller = container.querySelector('.chat-virtuoso-scroller') as HTMLElement
  stackHeight = 64
  act(() => { fireResize(stack) })

  const spacer = scroller.querySelector<HTMLElement>('.virtuoso-bottom-spacer')
  expect(spacer).not.toBeNull()
  expect(Number.parseFloat(spacer!.style.height)).toBe(64)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/MessageList.test.tsx -t "bottom stack"`
Expected: FAIL — `.chat-bottom-stack` is null / no `.probe-card` / spacer null.

- [ ] **Step 3: Add the prop**

In `src/components/MessageList.tsx`, add to `interface Props` (after `clearing`):

```tsx
  /** Bottom-anchored overlay content rendered *below* the live streaming
   *  bubble inside `.chat-bottom-stack` (currently the task checklist and the
   *  monitor bar). Lives here rather than in Chat so its measured height can
   *  share the streaming region's spacer + re-pin machinery — one source of
   *  truth for "how much room the bottom of the transcript must reserve". */
  bottomOverlay?: React.ReactNode
```

and add `bottomOverlay` to the component's destructured parameter list.

- [ ] **Step 4: Swap the ref and retarget the measurement effect**

In `src/components/MessageList.tsx`:
- Replace `const streamingRegionRef = useRef<HTMLDivElement | null>(null)` with `const bottomStackRef = useRef<HTMLDivElement | null>(null)`.
- Replace the measurement effect body so it observes the ALWAYS-mounted stack (so the `hasVisibleStreamingContent` dependency goes away entirely):

```tsx
  useEffect(() => {
    const el = bottomStackRef.current
    if (!el) {
      setBottomStackHeight(0)
      return
    }

    const updateHeight = () => {
      const height = Math.ceil(el.getBoundingClientRect().height)
      setBottomStackHeight((prev) => (prev === height ? prev : height))
    }

    updateHeight()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(updateHeight)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
```

- [ ] **Step 5: Render the stack**

Replace the streaming-region block (`MessageList.tsx:1031-1039`) with a stack that wraps it and appends the overlay. The region keeps its own element, class, `aria-hidden` and exit animation — only its anchoring moves to the stack:

```tsx
      <div className="chat-bottom-stack" ref={bottomStackRef}>
        {visibleStreamingContent != null && (
          <div
            className={streamingRegionClassName}
            aria-hidden={nextStreamingPresence.exiting}
          >
            <StreamingFooter content={visibleStreamingContent} />
          </div>
        )}
        {bottomOverlay}
      </div>
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/components/MessageList.test.tsx`
Expected: PASS, including the two new cases and the pre-existing spacer / re-pin cases.

- [ ] **Step 7: Commit**

```bash
git add src/components/MessageList.tsx src/components/MessageList.test.tsx
git commit -m "feat(transcript): measure a bottom overlay stack and reserve its height"
```

---

### Task 3: Lift the jump-to-bottom button clear of the stack

The button (`chat.css:442-445`) is `position:absolute; right:16px; bottom:16px` and only renders when the viewport is away from the bottom — exactly when the cards are still parked at the bottom, so it would sit on top of them.

**Files:**
- Modify: `src/components/MessageList.tsx` (button render, `:1020-1030`)
- Test: `src/components/MessageList.test.tsx`

**Interfaces:**
- Consumes: `bottomStackHeight` from Task 2.
- Produces: no new interface (inline style on the existing button).

- [ ] **Step 1: Write the failing test**

```tsx
it('lifts the jump-to-bottom button above the bottom stack', () => {
  virtuosoMockState.atBottomReport = false
  virtuosoMockState.reportBeforeRef = false
  virtuosoMockState.clientHeight = 100
  virtuosoMockState.scrollHeight = 400
  virtuosoMockState.scrollTop = 0

  const msgs = [
    makeMsg('assistant', { message: { content: [{ type: 'text', text: 'Settled' }] } }),
  ]
  const { container } = render(
    <MessageList
      items={toItems(msgs as SdkMessage[])}
      replayReady
      streamingContent=""
      bottomOverlay={<div className="probe-card">card</div>}
    />,
  )

  const stack = container.querySelector('.chat-bottom-stack') as HTMLElement
  let stackHeight = 0
  Object.defineProperty(stack, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ height: stackHeight, width: 400, top: 0, left: 0, right: 400, bottom: stackHeight, x: 0, y: 0 }),
  })

  stackHeight = 64
  act(() => { fireResize(stack) })

  const button = container.querySelector('.chat-jump-to-bottom') as HTMLElement
  expect(button).not.toBeNull()
  expect(button.style.bottom).toBe('80px') // 16px base + 64px stack
})
```

The button's render gate is `!isTranscriptRevealPending && canJumpToBottom && !atBottom` — the `replayReady` prop above clears the reveal gate, and the mock state above puts the scroller away from the bottom. If `button` comes back null, inspect that gate with the existing tests around `MessageList.test.tsx:1020` before changing the assertion.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/MessageList.test.tsx -t "jump-to-bottom button above"`
Expected: FAIL — `button.style.bottom` is `''`.

- [ ] **Step 3: Apply the offset**

On the existing `.chat-jump-to-bottom` button in `MessageList.tsx`, add:

```tsx
          style={{ bottom: 16 + bottomStackHeight }}
```

with a short comment noting the base 16px matches `chat.css` and the offset keeps the pill off the cards.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/MessageList.test.tsx -t "jump-to-bottom button above"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/MessageList.tsx src/components/MessageList.test.tsx
git commit -m "fix(transcript): lift jump-to-bottom button above the bottom overlay stack"
```

---

### Task 4: Move the cards out of Chat's flow into the stack

**Files:**
- Modify: `src/components/Chat.tsx` (MessageList call site `~:1959`; remove cards from `:2099-2100`)
- Modify: `src/components/TodoChecklist.tsx` (header doc comment)

**Interfaces:**
- Consumes: `MessageList`'s new `bottomOverlay` prop (Task 2).
- Produces: no new interface.

- [ ] **Step 1: Pass the cards as `bottomOverlay`**

Add the prop to the existing `<MessageList … />` element in `src/components/Chat.tsx`, reusing the exact props the components receive today:

```tsx
          bottomOverlay={
            <>
              <TodoChecklist
                messages={stream.messages}
                working={session.working}
                skin={skin}
                clearing={effectiveClearing}
                sessionId={session.id}
              />
              <MonitorBar messages={stream.messages} clearing={effectiveClearing} />
            </>
          }
```

- [ ] **Step 2: Delete the old in-flow render sites**

Remove the standalone `<TodoChecklist … />` and `<MonitorBar … />` lines that currently sit between the providers' closing tags and the error bar. If `TodoChecklist` / `MonitorBar` imports become unused they must be removed too — `npm run typecheck` (Step 4) is the check.

- [ ] **Step 3: Correct the stale doc comment**

`src/components/TodoChecklist.tsx`'s header currently claims the panel is rendered as an in-flow card between the transcript and the composer. Replace that paragraph with:

```
// Floating checklist that surfaces the current task list from the message
// stream. Rendered as the bottom member of the transcript's overlay stack
// (.chat-bottom-stack, alongside the live streaming bubble), so settled
// messages scroll behind it and show through its frosted background;
// MessageList measures the stack and reserves its height, so the newest
// message can always be scrolled clear of the card.
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS (both tsconfig projects). This is the check that the `bottomOverlay` prop is wired and no import was orphaned — there is no `Chat.test.tsx` in this repo, so the wiring is verified here plus the browser pass in Task 6.

- [ ] **Step 5: Commit**

```bash
git add src/components/Chat.tsx src/components/TodoChecklist.tsx
git commit -m "feat(chat): render task checklist and monitor bar in the transcript bottom stack"
```

---

### Task 5: Style the stack and re-shell the cards

**Files:**
- Modify: `src/styles/chat.css:210-222` (`.chat-streaming-region`), and add `.chat-bottom-stack` next to it
- Modify: `src/styles/messages.css` (`.todo-panel`, `.monitor-bar`)

**Interfaces:**
- Consumes: the `div.chat-bottom-stack` DOM from Task 2.
- Produces: no new interface.

- [ ] **Step 1: De-absolutise the streaming region and add the stack**

In `src/styles/chat.css`, replace the `.chat-streaming-region` positioning block with a normal flex child, and declare the stack above it:

```css
/* Bottom overlay stack — the live streaming bubble and the task cards share
   one bottom-anchored layer, so settled messages scroll behind both and are
   visible through the cards' frosted background. MessageList measures this
   element and reserves its height via the Virtuoso Footer spacer
   (.virtuoso-bottom-spacer), so nothing stays permanently hidden behind it.
   pointer-events:none lets clicks fall through the stack's empty area; the
   cards re-enable it for themselves (messages.css). */
.chat-bottom-stack {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  pointer-events: none;
}
/* Anchoring now lives on .chat-bottom-stack; this is a plain flex child. It
   keeps pointer-events:none so the live bubble never blocks clicks on the
   messages behind it. */
.chat-streaming-region {
  overflow: hidden;
  pointer-events: none;
  animation: streaming-region-in var(--motion-duration-base) var(--motion-ease-enter) both;
}
```

Keep the existing `.chat-streaming-region.exiting` rule unchanged.

- [ ] **Step 2: Re-shell the two cards**

In `src/styles/messages.css`, the `.todo-panel` rule becomes:

```css
.todo-panel {
  /* Bottom member of the transcript's overlay stack (see .chat-bottom-stack in
     chat.css). It does NOT position itself any more — the stack owns the
     anchoring — and pointer-events is re-enabled here because the stack turns
     it off so clicks fall through its empty area. */
  pointer-events: auto;
  margin: 0 var(--chat-reading-inset) 8px;
  border-radius: var(--radius-xl);
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg) 75%, transparent);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  box-shadow: var(--drawer-shadow);
  overflow: hidden;
  padding: 10px 14px;
  font-size: 13px;
  animation: todo-panel-in var(--motion-duration-moderate) var(--motion-ease-enter);
}
```

(the entrance-animation comment between `font-size` and `animation` is kept as-is; delete the old comment paragraph explaining that `position: sticky` is inert.)

Apply the identical three changes to `.monitor-bar`, whose rule keeps every other declaration (`border-radius`, `border`, `background`, the two `backdrop-filter` lines, `box-shadow`, `overflow`, `padding`, `font-size`) exactly as it already is — add `pointer-events: auto;` and `margin: 0 var(--chat-reading-inset) 8px;`, and remove `position` / `top` / `z-index`. Adjust the grouped comment above it if it still mentions the old vertical-margin rationale.

- [ ] **Step 3: Check the CSS is syntactically balanced**

Run: `npx vitest run src/styles/floating-surface-anchor.test.ts`
Expected: PASS — it reads every stylesheet in `src/styles` and parses standalone rules; a malformed rule would surface here.

- [ ] **Step 4: Commit**

```bash
git add src/styles/chat.css src/styles/messages.css
git commit -m "style(transcript): bottom overlay stack and card shells over the message flow"
```

---

### Task 6: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Typecheck both projects**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 3: Full test suite**

Run: `npm run test`
Expected: PASS. `TodoChecklist.test.tsx` and `MonitorBar.test.tsx` must be green **unmodified** — if either needed an edit, the change leaked into component behaviour and should be reconsidered, not patched.

- [ ] **Step 4: Browser verification**

> Blocked until the working tree builds: `src/components/message-list/WorkingBubble.tsx` currently fails to load under the dev server (`does not provide an export named 'WorkingBubble'`), so the app does not mount. Resolve that first, then:

Run: `npm run dev`, open a session with active tasks, and confirm:
1. The TASKLIST card floats at the bottom of the transcript and message text is visible through it while scrolling.
2. The live streaming text sits **above** the card.
3. Scrolled to the bottom, the newest message is fully readable (not hidden behind the card) — the reserved space is the stack's height.
4. Expanding / collapsing the card re-pins the viewport to the true bottom (no "one line short" gap).
5. The jump-to-bottom button sits above the card while away from the bottom.
6. Toggle the High-Contrast skin: both cards square off (`--radius-xl: 0`) exactly like the recap card.

- [ ] **Step 5: Code review**

Run the `code-review` skill over the diff for these six tasks (`git diff` against the branch base), verify each finding against the code, and fix confirmed issues before declaring the work done.
