# HoverPopover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the project's four ad-hoc hover surfaces (CSS-only `Tooltip`, click-only `AnchoredPopover`, bespoke `ContextOrb`/`SubagentSwarm` positioning, and 158 native `title` hints) with one portal-based `HoverPopover` built on the existing `AnchoredPopover` measurement math and styled with the Git panel's surface language.

**Architecture:** Extract `AnchoredPopover`'s measure/flip/clamp/re-measure loop into `useAnchorPosition`. `HoverPopover` is a trigger-ref-driven portal component with a hover/focus lifecycle (open dwell, close grace, passive vs interactive modes) that never wraps its trigger, so the `tt-wrap` layout hacks disappear. Consumers migrate in five phases: sidebar/header metadata, rich Tooltips, ContextOrb/SubagentSwarm positioning, then selective native titles.

**Tech Stack:** React 19, `motion/react`, existing `useEscapeStack` / `useOutsideMouseDown` / `usePopoverMotion`, Vitest + jsdom.

**Spec:** This plan (design approved 2026-11-06 in conversation). Visual reference: `src/styles/git-panel.css` (surface tokens + row hover). Positioning reference: `src/components/AnchoredPopover.tsx`. Existing hover timing reference: `src/components/ContextOrb.tsx` (`HOVER_OPEN_MS = 160`, `HOVER_CLOSE_MS = 200`).

## Global Constraints

- No new dependencies.
- Never hardcode colors: use theme CSS variables, and define any new color in both `:root` and `[data-theme="light"]` (none are expected).
- Portal to `document.body`; call `markPortaledSurface(el, owner?)` from `src/theme.ts`.
- Dismissal goes through `useEscapeStack` and `useOutsideMouseDown`; never hand-roll document listeners.
- `HoverPopover` must not wrap its trigger. It takes `triggerRef: RefObject<HTMLElement | null>` and renders only the portal, so it cannot change layout.
- Passive mode: `role="tooltip"`, `pointer-events: none`.
- Interactive mode: `role="dialog"`, `pointer-events: auto`, Escape and outside-mousedown dismiss.
- Defaults: viewport gap `6px`, viewport margin `8px`, open dwell `200ms`, close grace `150ms`.
- Visual language (copied from the Git panel): `background: var(--bg-elev)`, `border: 1px solid var(--border)`, `border-radius: var(--radius-md)`, `box-shadow: var(--card-shadow)`, `font-size: var(--fs-sm)`, `font-family: var(--mono)` for paths/identifiers, `--btn-hover-bg` for interactive rows.
- Verification per task: `npm run typecheck`, `npx eslint <changed files>`, and the named vitest file(s). Run the full `npm run test` before the final commit.

## Review Focus

1. **Pointer crosses the trigger→popover gap.** An interactive popover must survive the hop (close grace) and only close after the pointer leaves the popover.
2. **Trigger disappears while open.** Virtualized/keep-alive panels unmount or `display:none` the row; the popover must hide rather than clamp to viewport bottom-left.
3. **Rapid traversal.** Sweeping the pointer across many rows must not flash a popover: leaving cancels the pending open timer.
4. **Keyboard users.** A passive popover is announced through `aria-describedby`; an interactive one is reachable by focus and dismissible with Escape.
5. **Portal over a scrolled transcript.** Scroll/resize must re-measure and clamp; the popover cannot drift off its anchor.
6. **Reduced motion.** Entrance motion must snap via `usePopoverMotion`'s existing `useMotionTransition`.

---

### Task 1: `useAnchorPosition` hook

**Files:**
- Create: `src/hooks/useAnchorPosition.ts`
- Create: `src/hooks/useAnchorPosition.test.tsx`
- Modify: `src/components/AnchoredPopover.tsx`

**Interfaces:**
- Produces:
  ```ts
  export interface AnchorRect {
    top: number
    bottom: number
    left: number
    width: number
    height: number
  }
  export type AnchorSide = 'top' | 'bottom' | 'left' | 'right'
  export type AnchorAlign = 'start' | 'center' | 'end'
  export interface AnchorPositionOptions {
    side: AnchorSide
    align: AnchorAlign
    gap?: number
    margin?: number
    /** Used when the trigger is absent (e.g. AnchoredPopover's anchor-only
     *  callers). The live trigger rect wins when it measures non-zero. */
    fallbackRect?: AnchorRect | null
  }
  export interface AnchorPositionResult {
    ref: RefObject<HTMLDivElement | null>
    x: number | null
    y: number | null
    hidden: boolean
    anchorRect: DOMRect | null
  }
  export function useAnchorPosition(
    triggerRef: RefObject<HTMLElement | null>,
    options: AnchorPositionOptions,
  ): AnchorPositionResult
  ```
- Consumes: nothing new.
- Note: `AnchorRect` moves from `AnchoredPopover.tsx` to the hook module (to avoid a hook↔component type cycle). `AnchoredPopover` re-exports it, so `MonitorBar`'s `import type { AnchorRect } from './AnchoredPopover'` keeps working.

- [ ] **Step 1: Write the failing geometry tests**

Create `src/hooks/useAnchorPosition.test.tsx`. Use the rect stubbing pattern from `src/components/AnchoredPopover.test.tsx` (manual `getBoundingClientRect`, `Object.defineProperty` for `offsetWidth`/`offsetHeight`, a `ResizeObserverMock`, and a resize event to trigger the first measure). Render a probe:

```tsx
function Probe({ triggerRef, side, align }: { triggerRef: React.RefObject<HTMLElement | null>; side: AnchorSide; align: AnchorAlign }) {
  const { ref, x, y, hidden } = useAnchorPosition(triggerRef, { side, align })
  return <div ref={ref} className="probe" style={{ left: x ?? 0, top: y ?? 0, visibility: hidden ? 'hidden' : undefined }} />
}
```

Assertions (viewport 800×600, popover 100×50, gap 6, margin 8):
- top/center with trigger `{ left: 100, top: 200, width: 80, height: 20 }` → `left: 90px`, `top: 144px`.
- top with trigger top 10 → flips below: `top: 36px`.
- top/center with trigger left 0, width 20 → clamps `left: 8px`.
- right with trigger right 780 → flips left: `left: 674px`.
- bottom/end with trigger `{ left: 100, top: 100, width: 80, height: 20 }` → `left: 80px`, `top: 126px`.
- a trigger measuring `0×0` → `hidden === true`.
- after `window.dispatchEvent(new Event('scroll'))` (or the capture listener) with a changed trigger rect, `top` updates.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/hooks/useAnchorPosition.test.tsx`
Expected: FAIL — module `./useAnchorPosition` cannot be resolved.

- [ ] **Step 3: Implement `useAnchorPosition`**

Move the measure loop from `AnchoredPopover.tsx` into the hook:
- `useLayoutEffect` measures the trigger and the popover (`offsetWidth`/`offsetHeight`, not `getBoundingClientRect`).
- Keep the existing device-pixel snapping.
- Primary placement + flip at the opposite side when the preferred side cannot fit.
- Cross-axis alignment (`start`/`center`/`end`) then clamp to `[margin, viewport - size - margin]`.
- Re-measure on `resize`, capture-phase `scroll`, and a `ResizeObserver` on the popover.
- Return `hidden` when the trigger is missing or `0×0`; keep the previous coordinates otherwise. When no live trigger exists, measure against `fallbackRect` (the `AnchoredPopover` anchor-only path).
- Return `anchorRect` for consumers that draw an arrow or need the raw rect.

- [ ] **Step 4: Refactor `AnchoredPopover` to consume the hook**

Replace its private `useState`/`useLayoutEffect` measure block with `useAnchorPosition(triggerRef, { side: placement === 'below' ? 'bottom' : 'top', align: 'start' })` plus its existing `anchor` rect fallback. Preserve the legacy `above`/`below` coordinates pinned by `AnchoredPopover.test.tsx` and `ProjectPopover.test.tsx`.

- [ ] **Step 5: Verify**

Run:
```bash
npx vitest run src/hooks/useAnchorPosition.test.tsx src/components/AnchoredPopover.test.tsx src/components/ProjectPopover.test.tsx src/components/MonitorBar.test.tsx src/components/TodoChecklist.test.tsx
```
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useAnchorPosition.ts src/hooks/useAnchorPosition.test.tsx src/components/AnchoredPopover.tsx
git commit -m "refactor(popover): extract anchor positioning into a shared hook"
```

---

### Task 2: `HoverPopover` component and styles

**Files:**
- Create: `src/components/HoverPopover.tsx`
- Create: `src/components/HoverPopover.test.tsx`
- Create: `src/styles/hover-popover.css`
- Modify: `src/styles/index.css` (add `@import './hover-popover.css';`)

**Interfaces:**
- Consumes: `useAnchorPosition` from Task 1; `useEscapeStack`, `useOutsideMouseDown`, `usePopoverMotion`, `markPortaledSurface`.
- Produces:
  ```ts
  export interface HoverPopoverProps {
    triggerRef: RefObject<HTMLElement | null>
    side?: AnchorSide
    align?: AnchorAlign
    delayMs?: number
    closeDelayMs?: number
    interactive?: boolean
    ariaLabel?: string
    className?: string
    disabled?: boolean
    children: ReactNode
  }
  export function HoverPopover(props: HoverPopoverProps): ReactElement | null
  ```

- [ ] **Step 1: Write the failing lifecycle tests**

Create `src/components/HoverPopover.test.tsx`. Stub `matchMedia`, `ResizeObserver`, `window.innerWidth/innerHeight`, and a trigger rect (same helpers as `AnchoredPopover.test.tsx`). Use `vi.useFakeTimers()`.

Assertions:
- `pointerenter` on the trigger, advance `199ms` → `document.querySelector('.hover-pop')` is null; advance `1ms` → present.
- `pointerenter`, advance `100ms`, `pointerleave`, advance `500ms` → never opens.
- Open, `pointerleave`, advance `149ms` → present; advance `1ms` → null.
- Interactive: open, `pointerleave` trigger, advance `149ms`, `pointerenter` popover, advance `500ms` → still present; `pointerleave` popover, advance `150ms` → null.
- Passive popover: `role="tooltip"` and `classList.contains('hover-pop-interactive') === false`.
- Interactive popover: `role="dialog"` and the interactive class.
- Interactive + Escape → unmounts.
- Interactive + `mousedown` on `document.body` → unmounts.
- `disabled` → nothing renders after any timer.
- The popover element is a child of `document.body` (use `expectPortaledToBody` from `src/components/portal-test-utils.ts`).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/HoverPopover.test.tsx`
Expected: FAIL — module `./HoverPopover` cannot be resolved.

- [ ] **Step 3: Implement `HoverPopover`**

Behavior:
- Own `open` state. Attach listeners to `triggerRef.current` in a `useLayoutEffect` (`pointerenter`, `pointerleave`, `focusin`, `focusout`); clean them up on unmount.
- `pointerenter`/`focusin` clears any close timer and arms the open timer (`delayMs`). `pointerleave`/`focusout` clears the open timer and, if open, arms the close timer (`closeDelayMs`). A `focusout` whose `relatedTarget` is inside the popover must NOT arm the close timer; the same rule applies to `focusin` on the popover (cancel a pending close).
- When `interactive`, the portaled element's `pointerenter` clears the close timer and `pointerleave` re-arms it.
- `useEscapeStack({ active: open && interactive, onEscape: close, getContainer: () => ref.current })`.
- `useOutsideMouseDown({ ref, onClose: close, triggerRef, active: open && interactive })`.
- Set `aria-describedby` on the trigger to the bubble id while passive (use `useId`); preserve and restore any pre-existing value on unmount. Leave it untouched for interactive.
- Render only while open: `createPortal(<motion.div ref className={...} role={...} style={{ left: x, top: y, visibility: hidden ? 'hidden' : undefined }} initial={popover.initial} animate={popover.animate} onAnimationComplete={remeasure}>{children}</motion.div>, document.body)`.
- Call `markPortaledSurface(el, triggerRef.current?.closest('.chat-panel') ?? null)` when the element mounts.
- No exit animation: close unmounts after the grace. Keep the enter motion.

- [ ] **Step 4: Add `.hover-pop` styles**

In `src/styles/hover-popover.css` (Git panel language; no hex):
```
.hover-pop { position: fixed; z-index: var(--z-popover); min-width: 160px; max-width: 320px;
  padding: var(--space-1-5) var(--space-2); background: var(--bg-elev);
  border: 1px solid var(--border); border-radius: var(--radius-md);
  box-shadow: var(--card-shadow); color: var(--fg); font-size: var(--fs-sm);
  line-height: 1.45; pointer-events: none; }
.hover-pop-interactive { pointer-events: auto; }
.hover-pop-stack { display: flex; flex-direction: column; gap: var(--space-0-5); }
.hover-pop-status { color: var(--fg); }
.hover-pop-error { color: var(--danger-text); }
.hover-pop-path { font-family: var(--mono); color: var(--fg-muted); overflow-wrap: anywhere; }
.hover-pop-meta { font-family: var(--mono); color: var(--fg-muted); font-variant-numeric: tabular-nums; }
.hover-pop-value { padding: 0 var(--space-1); border-radius: var(--radius-3xs);
  background: var(--bg-elev-2); color: var(--accent-text); font-family: var(--mono); }
.hover-pop-sep { height: 1px; background: var(--border); margin: var(--space-1) 0; }
.hover-pop-actions { display: flex; gap: var(--space-1); border-top: 1px solid var(--border);
  margin-top: var(--space-1); padding-top: var(--space-1); }
```
Also add `@media (prefers-reduced-motion: reduce) { .hover-pop { transition: none; } }`.

- [ ] **Step 5: Verify**

Run:
```bash
npx vitest run src/components/HoverPopover.test.tsx src/hooks/useAnchorPosition.test.tsx
npm run typecheck
npx eslint src/components/HoverPopover.tsx src/hooks/useAnchorPosition.ts
```
Expected: all PASS, 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/HoverPopover.tsx src/components/HoverPopover.test.tsx src/styles/hover-popover.css src/styles/index.css
git commit -m "feat(popover): add shared portal-based HoverPopover"
```

---

### Task 3: Sidebar and header metadata hover

**Files:**
- Create: `src/components/session-list/SessionHoverContent.tsx`
- Modify: `src/utils/session-status.ts` (replace `sessionHoverDetails(): string[]` with a structured model + text helper)
- Modify: `src/utils/session-status.test.ts`
- Modify: `src/components/session-list/SessionCard.tsx`
- Modify: `src/components/session-list/SessionCard.test.tsx`
- Modify: `src/components/SessionNavStrip.tsx`
- Modify: `src/components/SessionNavStrip.test.tsx`
- Modify: `src/components/DesktopTitlebarTabs.tsx`
- Modify: `src/components/DesktopTitlebarTabs.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export interface SessionHoverModel {
    status: string
    error: string | null
    cwd: string | null
    meta: string
  }
  export function sessionHoverModel(s: SessionInfo, statusText?: string): SessionHoverModel
  ```
  `sessionHoverModel` replaces the current `sessionHoverDetails(): string[]`; no text-joining helper is added because every consumer becomes a `SessionHoverContent` renderer.
- Produces: `SessionHoverContent({ session, statusText? })` rendering `.hover-pop-stack` with `.hover-pop-status` / `.hover-pop-error` / `.hover-pop-path` / `.hover-pop-meta`.
- `tabTitle` is removed after both header surfaces migrate.

- [ ] **Step 1: Write the failing structured-model tests**

In `src/utils/session-status.test.ts`, replace the `sessionHoverDetails` describe with:
- `sessionHoverModel(makeSession({ cwd: '/home/user/project', subscribers: 1 }))` → `{ status: 'Live', error: null, cwd: '/home/user/project', meta: 'test-model · 3 msgs · 1 viewer' }`.
- Waiting + error → `{ status: 'Waiting for a background subagent', error: 'boom', cwd: null, meta: 'test-model · 3 msgs' }`.
- `tabTitle` tests are deleted in the same step (no callers remain after Step 5).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/utils/session-status.test.ts`
Expected: FAIL — `sessionHoverModel` is not exported.

- [ ] **Step 3: Implement the model**

Make `sessionMetaLine` produce the `meta` string; `sessionHoverModel` returns the four fields; `sessionHoverText` derives the lines. Keep `statusLabel` precedence and the error-append rule (only when the status text does not already include the error).

- [ ] **Step 4: Replace the card's native title with `HoverPopover`**

- Add `const rowRef = useRef<HTMLDivElement>(null)` and put `ref={rowRef}` on the card root.
- Remove the `titleHover` string, the title span's `title`, and the dot's native `title` (keep the dot's `aria-label`).
- Render, next to the card root:
  ```tsx
  <HoverPopover
    triggerRef={rowRef}
    side="right"
    align="start"
    disabled={isRenaming || isDragging || isDeleting}
  >
    <SessionHoverContent session={s} statusText={isResuming ? 'Resuming…' : undefined} />
  </HoverPopover>
  ```
- In `SessionCard.test.tsx`, replace the title-hover assertion with: stub the card's `getBoundingClientRect`, render, `pointerenter` the card, advance 200ms, and assert the `.hover-pop` contains `/home/user/project`, `sonnet-4`, `5 msgs`, `1 viewer`, and the status text. Assert the title span has no `title` attribute.

- [ ] **Step 5: Migrate the two header surfaces**

`SessionNavStrip`:
- In `SessionNavTab`, add `const tabRef = useRef<HTMLButtonElement>(null)` and compose the ref with the sortable activator: `ref={(node) => { tabRef.current = node; setActivatorNodeRef(node) }}`.
- Remove `title={tabTitle(label, session)}`.
- Render `<HoverPopover triggerRef={tabRef} side="bottom" align="start"><SessionHoverContent session statusText={resuming ? 'Resuming…' : undefined} /></HoverPopover>` inside the tab component.

`DesktopTitlebarTabs`:
- Extract the mapped tab body into a `TitlebarTab` child component so it can own a `tabRef` (hooks cannot run inside the map).
- Remove `title={tabTitle(label, s)}`; render the same `HoverPopover` side="bottom".
- Keep the close button's own behavior; hovering it also opens the passive card, which is acceptable.

Update both tests: replace title-attribute assertions with a `pointerenter` + 200ms `.hover-pop` assertion for the cwd/model lines.

- [ ] **Step 6: Verify**

Run:
```bash
npx vitest run src/components/session-list/SessionCard.test.tsx src/components/SessionNavStrip.test.tsx src/components/DesktopTitlebarTabs.test.tsx src/utils/session-status.test.ts
npm run typecheck
```
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/session-list/SessionHoverContent.tsx src/components/session-list/SessionCard.tsx src/components/session-list/SessionCard.test.tsx src/components/SessionNavStrip.tsx src/components/SessionNavStrip.test.tsx src/components/DesktopTitlebarTabs.tsx src/components/DesktopTitlebarTabs.test.tsx src/utils/session-status.ts src/utils/session-status.test.ts
git commit -m "feat(sidebar): move session metadata hover onto HoverPopover"
```

---

### Task 4: Rich `Tooltip` callers

**Files:**
- Modify: `src/components/ChatPanel.tsx`
- Create: `src/components/ChatPanel.popover.test.tsx` (no `ChatPanel.test.tsx` exists)
- Modify: `src/components/WorktreeIsolationBadge.tsx`
- Modify: `src/components/WorktreeChanges.tsx`
- Modify: `src/components/UsagePanel.tsx`
- Modify: `src/components/WorktreeIsolationBadge.test.tsx`, `src/components/WorktreeChanges.test.tsx`, `src/components/UsagePanel.test.tsx`

**Interfaces:**
- Consumes: `HoverPopover`, `SessionHoverContent` not needed here.
- Produces: no new exports; these callers now use a `triggerRef` and render their existing rich label inside `.hover-pop-stack`.

- [ ] **Step 1: Write failing caller tests**

For each migrated caller, assert that the rich content appears after `pointerenter` + 200ms and that the trigger no longer carries a native `title`:
- `ChatPanel` git chip: branch, upstream, state lines.
- `ChatPanel` worktree chip: worktree path / branch lines.
- `WorktreeIsolationBadge`: its existing lines.
- `WorktreeChanges`: its `diffTitle` lines.
- `UsagePanel`: the cache breakdown lines (if it is a ReactNode; a plain string stays on `Tooltip`).

- [ ] **Step 2: Run the tests to verify they fail**

Run the named test files.
Expected: FAIL — no `.hover-pop` element.

- [ ] **Step 3: Migrate only rich labels**

For each caller, move the trigger element to a `useRef`, replace `<Tooltip label={richNode}>…</Tooltip>` with the plain trigger plus `<HoverPopover triggerRef={ref} side="bottom" align={...}>` rendering the existing lines inside `<div className="hover-pop-stack">`. Keep `.tt-hl` as the value-pill class inside the new card (it is a generic value style, not tooltip-scoped). Leave short string labels on `Tooltip`; this task does not migrate them.

- [ ] **Step 4: Verify**

Run the named test files plus `npm run typecheck`, `npx eslint <changed files>`.
Expected: all PASS, 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/ChatPanel.tsx src/components/WorktreeIsolationBadge.tsx src/components/WorktreeChanges.tsx src/components/UsagePanel.tsx <their tests>
git commit -m "refactor(popover): move rich tooltips onto HoverPopover"
```

---

### Task 5: ContextOrb and SubagentSwarm positioning

**Files:**
- Modify: `src/components/ContextOrb.tsx`
- Modify: `src/components/message-list/SubagentSwarm.tsx`
- Modify their test files.

**Interfaces:**
- Consumes: `useAnchorPosition` (Task 1). `anchorRect` is used by ContextOrb for its bottom-anchored arrow.

- [ ] **Step 1: Write failing geometry tests**

- `SubagentSwarm`: with a stubbed trigger rect and a viewport that would push the popover off the bottom-right, assert the rendered `left`/`top` are clamped to `4px` margins. Follow the existing `SubagentSwarm.test.tsx` rect-stub pattern.
- `ContextOrb`: assert its popover still grows upward and stays inside the viewport; the hook's `anchorRect` drives the same `bottom`/`right` values.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/components/ContextOrb.test.tsx src/components/message-list/SubagentSwarm.test.tsx`
Expected: FAIL on the new geometry assertions.

- [ ] **Step 3: Refactor both**

- `SubagentSwarm`: replace its private `useLayoutEffect` clamp with `const { ref, x, y, hidden } = useAnchorPosition(triggerRef, { side: 'bottom', align: 'start', gap: 4, margin: 4 })`; render `left: x ?? 0`, `top: y ?? 0`, `visibility: hidden ? 'hidden' : undefined`. Keep its focus/escape/outside-click behavior.
- `ContextOrb`: keep the bottom/right growth and the `::after` arrow. Adopt `useAnchorPosition` for the anchor-rect measurement and the re-measure-on-scroll/resize loop only (`anchorRect`), and keep its existing bottom/right clamp math. Document the exception in a comment: the arrow's geometry is tied to bottom anchoring, so top/left coordinates would move the arrow.

- [ ] **Step 4: Verify**

Run the two test files plus `npm run typecheck`, `npx eslint <changed files>`.
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/ContextOrb.tsx src/components/message-list/SubagentSwarm.tsx <their tests>
git commit -m "refactor(popover): reuse anchor positioning in orb and swarm popovers"
```

---

### Task 6: Selective native-title migration

**Files:**
- Modify: `src/components/GitFileRow.tsx`
- Modify: `src/components/GitCommitRows.tsx`
- Create: `src/components/GitFileRow.test.tsx`
- Modify: `src/components/GitCommitRows.test.tsx`

**Interfaces:**
- Consumes: `HoverPopover`.
- Produces: no new exports.

- [ ] **Step 1: Write failing tests**

- `GitFileRow`: hovering the path shows the full path in `.hover-pop`; the path element no longer has a `title` attribute.
- `GitCommitRows`: hovering the abbreviated hash shows the full hash in `.hover-pop`; the hash element no longer has a `title` attribute.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/components/GitFileRow.test.tsx src/components/GitCommitRows.test.tsx`
Expected: FAIL — no `.hover-pop`.

- [ ] **Step 3: Migrate**

Add refs to the path span and the hash code element; render `<HoverPopover triggerRef={ref} side="bottom" align="start">` with `.hover-pop-stack` content. Keep every other native `title` in the project as-is: this task deliberately migrates only the two long-identifier rows. Leave a one-line comment at each site saying the short, non-truncatable hints stay native.

- [ ] **Step 4: Verify**

Run the two test files, then the full suite:
```bash
npx vitest run src/components/GitFileRow.test.tsx src/components/GitCommitRows.test.tsx
npm run typecheck
npx eslint src/components/GitFileRow.tsx src/components/GitCommitRows.tsx
npm run test
```
Expected: all PASS (the full suite must be green before the final commit).

- [ ] **Step 5: Commit**

```bash
git add src/components/GitFileRow.tsx src/components/GitCommitRows.tsx src/components/GitFileRow.test.tsx src/components/GitCommitRows.test.tsx
git commit -m "feat(git): show full paths and hashes in HoverPopover"
```

---

## Self-Review Notes

- **Spec coverage:** Task 1–2 build the component and hook; Task 3 covers the sidebar/header metadata from the approved order; Task 4 covers rich Tooltips; Task 5 covers ContextOrb/SubagentSwarm; Task 6 covers the selective native-title phase. The deliberate non-goal is a wholesale migration of all 158 native titles.
- **Type consistency:** `AnchorSide`/`AnchorAlign`/`AnchorPositionResult` are defined once in Task 1 and consumed verbatim. `SessionHoverModel` fields (`status`, `error`, `cwd`, `meta`) match `SessionHoverContent`'s rendering and the `sessionHoverText` join order.
- **Review Focus tests:** gap crossing (Task 2 interactive test), vanished trigger (Task 1 `0×0` hidden test), rapid traversal (Task 2 cancel test), keyboard (Task 2 role + Escape + `aria-describedby`), scroll re-measure (Task 1 scroll test), reduced motion (Task 2 uses `usePopoverMotion`; no dedicated assertion because `useMotionTransition` is already unit-covered by `src/utils/transitions.test.ts`).
- **Proportion:** code blocks carry signatures and assertions only; bodies are described, not transcribed.