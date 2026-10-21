# Nested-fold bottom pinning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a collapse nested inside a pinned `AnimatedCollapse` body (the reported case: expanding a tool result inside a `ToolGroupCard`) from painting the transcript content below it one frame low.

**Architecture:** Two coupled changes in the collapse layer, no change to the transcript scroll machinery. (1) `releaseAncestorCollapsePins` — a fold's start drops the pinned height of every collapse body above it, so the growth reaches the transcript's boxes in the *same layout pass* as the fold's per-frame height write instead of one ResizeObserver broadcast later. (2) `AnimatedCollapse`'s observer refuses to re-pin a body while a nested collapse is animating inside it, and the existing in-flight-fold guard is hoisted above that check so it cannot un-pin a body mid-fold.

**Tech Stack:** React 19, TypeScript, vitest (happy-dom for `src/**`), the shared controllable ResizeObserver stub in `src/test/resize-observer-stub.ts`.

**Spec:** this plan's own "Problem & evidence (measured)" section — there is no prior spec doc; the diagnosis was done by instrumenting the running app (see that section for the probe and the numbers).

## Problem & evidence (measured)

Expanding a result row **inside** a ToolGroupCard makes the assistant cards **below** the group visibly shake. The group's own fold does not (it was fixed by `aa7ea76e`); this is a different cause, upstream of the scroll machinery.

Instrumented live (session `8fa321ba`, panel not scrollable: `scrollHeight === clientHeight === 1204`, item-list bottom-anchored by a flex `margin-top: auto`). Per painted frame, `dist` = `scrollHeight − clientHeight − scrollTop` **after** the app's compensation ran (a ResizeObserver created after the app's, so it runs later in the same delivery):

| phase | action | painted `dist` | row 9 top (rest position 970.16) |
|---|---|---|---|
| A | the group's result row, as shipped | **115px, 132px** (tail 10/7/4/4/1) | 1085.16 → 1102.16 → 970.16 |
| B | same row, group body's pin cleared each frame | **0** (tail 1px) | **constant 970.55** |
| C | a free-standing thinking card (no group) | 0 | constant 368.42 |

The dip equals that frame's inner-body growth, exactly: `86 = 331 − 245`, `60 = 446 − 386`, `115 = 228 − 113`. In phase B every painted frame grew the item-list and the scrollTop by the same amount (`+144`, `+106`) — i.e. the box grew in the same layout pass and the compensation landed in that same frame.

**Mechanism.** The member's result body is an `AnimatedCollapse` nested inside the group's `AnimatedCollapse` (which pins the group body's height with `animateResize`). The inner fold writes its body height in the rAF phase, but its box is clipped by the group's pinned body, so the growth does not reach the transcript's box in that frame's layout. It arrives when the **group's own observer** relays it — during the RO broadcast, after that frame's item-list observation was already gathered (and Chrome, measured, delivers no second observation in the same frame). The transcript's fold-lockstep compensation therefore always compensates the *previous* frame's geometry: the content below the fold is painted one growth-step low, then snaps back. Magnitude scales with the frame time (hence 15px on fast frames, 132px on slow ones).

Reproduce/accept with the browser probe in Task 4 (it needs the app running and the tab in the foreground — `requestAnimationFrame` is suspended while the tab is hidden, so nothing animates and nothing can be measured).

## Global Constraints

- No change to `src/components/message-list/useTranscriptScroll.ts` or any other scroll writer. Three write paths to `scrollTop` stay three.
- CSS: no new colors, no stylesheet edits (this change adds none).
- Tests: `npx vitest run <file>`; `src/**` runs under happy-dom; fake timers are restored in `afterEach` (`vi.useRealTimers()`).
- Shared test scaffolding is not copied: use `stubResizeObserver` / `fireResize` / `clearResizeObserverStub` from `src/test/resize-observer-stub.ts`.
- Diagnostics go through `createLogger(scope)` — this change adds no logging.
- Before committing: `npm run typecheck` (both tsconfigs), `npm run lint`, `npm run test`, and a `code-review` pass over the full diff. Commit messages end with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

## Review Focus

1. **A nested fold inside a folded (0px-pinned) ancestor** — e.g. search force-expands a tool result inside a folded group: the group must stay folded, its `0px` pin must NOT be released. Test in Task 3 ("keeps a folded group's 0px pin").
2. **A nested fold whose ancestor is itself animating** (group opening while the user expands a result row): the release must not fight the ancestor's own tween, and the pin must not come back while the nested fold still runs. Tests in Task 1 ("leaves an animating ancestor alone") and Task 2 ("does not re-pin the ancestor while a nested fold animates").
3. **Reduced motion (and any <2px delta)**: the fold settles synchronously, so `animateHeight` never registers — the release must still happen at the layout-effect site, or the ancestor relays the whole growth one broadcast late (a full-height flash). Test in Task 2 ("drops the pin even when the fold settles instantly").
4. **A nested fold inside a body that is not being rendered** (keep-alive panel; the cross-tab collapse flag can open a card while hidden): `standDown` must win — no release, and the ancestor's pin must survive so a shown-again card is not header-only. Test in Task 2 ("leaves a stand-down body alone").
5. **A flex-clamped body** (`remeasureWhileClamped`, the TaskList card under `.chat-bottom-stack`'s cap): the nested check must not steal the clamped branch's pin adoption. Test in Task 2 ("still adopts a clamped reading while a nested fold animates").

---

### Task 1: Release ancestor pins when a fold starts

**Files:**
- Modify: `src/components/collapse-animation.ts`
- Test: `src/components/collapse-animation.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `releaseAncestorCollapsePins(el: HTMLElement): void` — exported; clears the inline `height` of every `.animated-collapse` ancestor of `el` that is neither animating nor folded. `setCollapseAnimating(el, animating)` now calls it on `true`. `anyCollapseAnimatingInside(root)` is unchanged.

- [ ] **Step 1: Write the failing test**

Create `src/components/collapse-animation.test.ts`. It is pure DOM (no React), so it takes the automatic happy-dom environment from `src/**`.

```ts
import { afterEach, describe, expect, it } from 'vitest'
import {
  anyCollapseAnimatingInside,
  releaseAncestorCollapsePins,
  setCollapseAnimating,
} from './collapse-animation'

/** Build `depth` nested collapse bodies, the shape AnimatedCollapse renders:
 *  body(.animated-collapse) > .animated-collapse-content > body(…) …
 *  Outermost first, so the LAST entry is the body that animates and every
 *  earlier one is an ancestor of it. */
function nest(depth: number): HTMLElement[] {
  const bodies: HTMLElement[] = []
  let parent = document.createElement('div')
  for (let i = 0; i < depth; i++) {
    const body = document.createElement('div')
    body.className = 'animated-collapse'
    const content = document.createElement('div')
    content.className = 'animated-collapse-content'
    body.appendChild(content)
    parent.appendChild(body)
    parent = content
    bodies.push(body)
  }
  created.push(...bodies)
  return bodies
}

/** The registry is module state holding live elements — every body a test
 *  created must be unregistered, and the trees here are detached (so they can
 *  never be found by a document query). */
const created: HTMLElement[] = []

afterEach(() => {
  for (const body of created) setCollapseAnimating(body, false)
  created.length = 0
})

describe('releaseAncestorCollapsePins', () => {
  it('clears the pin of a settled open ancestor', () => {
    const [outer, animating] = nest(2)
    outer.style.height = '722px'

    releaseAncestorCollapsePins(animating)

    expect(outer.style.height).toBe('')
  })

  it('leaves a folded (0px-pinned) ancestor alone', () => {
    // A search-forced result row can open inside a folded group: releasing the
    // group's 0px pin there would spill the folded card open.
    const [outer, animating] = nest(2)
    outer.style.height = '0px'

    releaseAncestorCollapsePins(animating)

    expect(outer.style.height).toBe('0px')
  })

  it('leaves an ancestor that is animating alone', () => {
    // Its own tween owns that pin (it rewrites the height every frame).
    const [outer, animating] = nest(2)
    outer.style.height = '300px'
    setCollapseAnimating(outer, true)

    releaseAncestorCollapsePins(animating)

    expect(outer.style.height).toBe('300px')
  })

  it('is wired into the animation start: an animating body releases its ancestors', () => {
    const [outer, animating] = nest(2)
    outer.style.height = '400px'

    setCollapseAnimating(animating, true)

    expect(outer.style.height).toBe('')
    expect(anyCollapseAnimatingInside(outer)).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/collapse-animation.test.ts`
Expected: FAIL — `releaseAncestorCollapsePins is not a function` (the export does not exist yet), and the "wired into the animation start" case leaves `400px` in place.

- [ ] **Step 3: Implement**

In `src/components/collapse-animation.ts`, extend the module doc and `setCollapseAnimating`, and add the new export.

Replace the module-level doc comment's last paragraph and `setCollapseAnimating`:

```ts
 * The Set is maintained at the exact statements that add and remove the class
 * inside AnimatedCollapse, so the two cannot drift apart. Animations are
 * bounded (~240ms, one body per fold), so the registry holds at most a
 * handful of elements.
 *
 * Starting an animation ALSO releases the pinned heights of the bodies above it
 * (releaseAncestorCollapsePins) — a pinned ancestor is what turns a nested fold
 * into a one-frame dip of the content below it.
 */

const animatingBodies = new Set<HTMLElement>()

/** Record a body's animation state. Called by AnimatedCollapse immediately
 *  before/after the matching `classList.add/remove('animating')`. */
export function setCollapseAnimating(el: HTMLElement, animating: boolean): void {
  if (animating) {
    animatingBodies.add(el)
    releaseAncestorCollapsePins(el)
  } else animatingBodies.delete(el)
}
```

Then append below `anyCollapseAnimatingInside`:

```ts
/** Drop the pinned height of every collapse body ABOVE `el`.
 *
 *  A pinned ancestor body is a COPY of its content's height, written by that
 *  ancestor's own ResizeObserver — i.e. one RO broadcast AFTER this fold wrote
 *  its per-frame height. Anything that compensates from box observations reads
 *  those boxes in the same broadcast, so it can only ever compensate the
 *  PREVIOUS frame's geometry: every frame of a fold nested inside a pinned body
 *  paints the content below it one growth-step low, then snaps back on the next
 *  frame. Measured live on a ToolGroupCard's result row (a nested collapse
 *  inside the group's pinned body): the assistant card below the group was
 *  painted 115-132px lower on the fold's steep frames and 15/7/4/2px on its
 *  tail. Released, the ancestor's box tracks its content in the SAME layout pass
 *  as the fold's height write — the phase the compensation needs.
 *
 *  Two ancestors are deliberately left alone:
 *  - one that is itself animating: its tween owns that pin and rewrites it
 *    every frame anyway;
 *  - one that is folded (`0px`): that pin is the fold, not a copy of its
 *    content, and a search-forced result row can open inside a folded group —
 *    releasing it there would spill the folded card open. Nothing needs
 *    relaying while it is shut.
 *
 *  The released body stays unpinned: the same resting state `standDown` leaves
 *  (an unpinned body's own box already equals its content, so the observer has
 *  nothing to detect), and the next fold cycle pins it again. */
export function releaseAncestorCollapsePins(el: HTMLElement): void {
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (!node.classList.contains('animated-collapse')) continue
    if (animatingBodies.has(node)) continue
    if (node.style.height === '' || node.style.height === '0px') continue
    node.style.height = ''
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/collapse-animation.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/collapse-animation.ts src/components/collapse-animation.test.ts
git commit -m "fix(collapse): release ancestor body pins when a fold starts

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: `AnimatedCollapse` — release at the fold's start, and never re-pin while a nested fold animates

**Files:**
- Modify: `src/components/AnimatedCollapse.tsx` (import; the layout effect's two open paths; the ResizeObserver callback)
- Test: `src/components/AnimatedCollapse.test.tsx` (append a describe block)

**Interfaces:**
- Consumes: `releaseAncestorCollapsePins`, `anyCollapseAnimatingInside`, `setCollapseAnimating` from `./collapse-animation` (Task 1); the existing test helpers `mockLayoutHeight` / `renderInPanel` / `fireResize` in `AnimatedCollapse.test.tsx`.
- Produces: no new API — the component's contract widens to "a body never carries a pinned height while a nested collapse animates inside it".

- [ ] **Step 1: Write the failing tests**

Append to `src/components/AnimatedCollapse.test.tsx` (the file already imports `setCollapseAnimating`? **it does not** — add it to the existing import list from `./collapse-animation`, and note `mockLayoutHeight` / `renderInPanel` are already defined in the file):

```tsx
import { setCollapseAnimating } from './collapse-animation'
```

```tsx
describe('AnimatedCollapse — a nested fold is never relayed through an ancestor pin', () => {
  /** An open outer collapse with a pin, wrapping an inner collapse. */
  function Nested({ innerOpen, outerAnimateResize = true }: { innerOpen: boolean; outerAnimateResize?: boolean }) {
    return (
      <AnimatedCollapse open unmountOnExit={false} animateResize={outerAnimateResize}>
        <AnimatedCollapse open={innerOpen} unmountOnExit={false}>
          <ul>
            <li>A</li>
          </ul>
        </AnimatedCollapse>
      </AnimatedCollapse>
    )
  }

  function parts(container: HTMLElement) {
    const bodies = container.querySelectorAll<HTMLElement>('.animated-collapse')
    const contents = container.querySelectorAll<HTMLElement>('.animated-collapse-content')
    return { outer: bodies[0], inner: bodies[1], outerContent: contents[0], innerContent: contents[1] }
  }

  it('drops the ancestor pin when a nested fold starts animating', () => {
    vi.useFakeTimers()
    const { container, rerender } = render(<Nested innerOpen={false} />)
    const { outer, inner, innerContent } = parts(container)
    outer.style.height = '100px' // a settled open body, as in the browser
    mockLayoutHeight(innerContent, 400)

    rerender(<Nested innerOpen />)

    // The nested fold owns the height now: the ancestor must not clip it, or
    // its own observer would relay the growth one broadcast late.
    expect(outer.style.height).toBe('')
    expect(inner.classList.contains('animating')).toBe(true)
  })

  it('drops the ancestor pin even when the fold settles instantly (reduced motion)', () => {
    // Reduced motion (and any <2px delta) settles synchronously, so
    // animateHeight never registers — the layout-effect release is the only
    // path. Without it the ancestor relays the whole growth one broadcast late:
    // the content below flashes a full body-height lower for one frame.
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    }))
    const { container, rerender } = render(<Nested innerOpen={false} />)
    const { outer, innerContent } = parts(container)
    outer.style.height = '100px'
    mockLayoutHeight(innerContent, 400)

    rerender(<Nested innerOpen />)

    expect(outer.style.height).toBe('')
  })

  it('does not re-pin the ancestor while a nested collapse animates', () => {
    // `outerAnimateResize={false}` so the contrast below is a plain snap rather
    // than a tween whose first frame is the OLD height (the tween's own
    // start-value write would make the assertion read the wrong number).
    const { container } = render(<Nested innerOpen={false} outerAnimateResize={false} />)
    const { outer, inner, outerContent } = parts(container)
    outer.style.height = '100px'
    mockLayoutHeight(outer, 100)
    mockLayoutHeight(outerContent, 400)
    // The registry is the signal — the observer consults it, not the DOM class.
    setCollapseAnimating(inner, true)

    act(() => fireResize(outerContent))

    expect(outer.style.height).toBe('')

    // …and the very same observation pins it once the nested fold is over
    // (this is the contrast that keeps the guard from silently disabling the
    // body's normal resize handling).
    setCollapseAnimating(inner, false)
    act(() => fireResize(outerContent))
    expect(outer.style.height).toBe('400px')
  })

  it('still adopts a clamped reading while a nested collapse animates', () => {
    // The nested guard sits BELOW the clamped branch on purpose: a flex-clamped
    // body (the TaskList card under .chat-bottom-stack's cap) must keep healing
    // its pin from the content, nested fold or not.
    const { container } = render(<Nested innerOpen={false} />)
    const { outer, inner, outerContent } = parts(container)
    outer.style.height = '100px'
    mockLayoutHeight(outer, 40) // clamped: the used height is shorter than the pin
    mockLayoutHeight(outerContent, 400)
    setCollapseAnimating(inner, true)

    act(() => fireResize(outerContent))

    expect(outer.style.height).toBe('400px')
  })

  it('leaves a stand-down body alone', () => {
    // The inner card's open lands while its subtree is not rendered (a
    // keep-alive panel; the cross-tab collapse flag can open a card while it is
    // hidden). The component stands down instead of animating, so nothing
    // releases the ancestor pin that keeps a shown-again card from coming back
    // header-only.
    const { container, rerender } = renderInPanel(<Nested innerOpen={false} />)
    const { outer, inner } = parts(container)
    outer.style.height = '300px' // a settled open body with a pin

    rerender(<Nested innerOpen />, true) // the open lands while the panel is hidden

    expect(inner.classList.contains('animating')).toBe(false)
    expect(outer.style.height).toBe('300px')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/AnimatedCollapse.test.tsx -t "nested fold is never relayed"`
Expected: FAIL — the first case keeps `outer.style.height === '100px'`, and "does not re-pin" gets `400px` instead of `''`.

- [ ] **Step 3: Implement — import**

In `src/components/AnimatedCollapse.tsx` line 4:

```ts
import { anyCollapseAnimatingInside, releaseAncestorCollapsePins, setCollapseAnimating } from './collapse-animation'
```

- [ ] **Step 4: Implement — release at the fold's start**

In the same file, in the main `useLayoutEffect`, the initial-open path — replace:

```ts
      if (shouldAnimateInitialOpen) animateHeight(0, nextHeight, true, true)
      return
```

with:

```ts
      if (shouldAnimateInitialOpen) {
        releaseAncestorCollapsePins(body)
        animateHeight(0, nextHeight, true, true)
      }
      return
```

and the open-transition path — replace:

```ts
      const target = content.offsetHeight || content.scrollHeight
      animateHeight(0, target, true, true)
      return
```

with:

```ts
      const target = content.offsetHeight || content.scrollHeight
      // Release any pinned ancestor BEFORE the fold's first frame. A pinned
      // ancestor would hold this fold's growth back until its own observer
      // relays it (see releaseAncestorCollapsePins), and under reduced motion —
      // where animateHeight settles synchronously and never registers — that
      // relay is the only path, so the whole growth would land one broadcast
      // late: a full-body-height flash of the content below.
      releaseAncestorCollapsePins(body)
      animateHeight(0, target, true, true)
      return
```

- [ ] **Step 5: Implement — the observer**

In the same file, in the `useEffect` that creates the `ResizeObserver`, replace the callback's head:

```ts
    const observer = new ResizeObserver(() => {
      if (!previousOpenRef.current) return
      // Measure the content's USED height, not scrollHeight. Under
```

with:

```ts
    const observer = new ResizeObserver(() => {
      if (!previousOpenRef.current) return
      // HOISTED (it used to sit below the measurement): an open/close fold in
      // flight owns this body's height. An observation must never tear it down
      // — that made every open instant — and it must not reach the
      // nested-collapse check below either, which would un-pin a body mid-fold
      // and flash its content open for a frame. finishOpen re-measures at
      // animation end, so growth during the fold is still reconciled. (With the
      // fold case handled here, `animatingRef` below means a RESIZE tween.)
      if (animatingRef.current && animKindRef.current === 'fold') return
      // Measure the content's USED height, not scrollHeight. Under
```

then, immediately after the `measured.clamped` block's closing brace and before `const currentHeight = body.offsetHeight`, insert:

```ts
      // A collapse animating inside this body IS this box's height motion:
      // track the content natively (auto) instead of pinning a copy of it. A
      // pinned copy is written by THIS observer, one broadcast after that
      // nested fold's own per-frame write, so anything reading the boxes in
      // this broadcast — the transcript's fold-lockstep — is a frame behind for
      // the whole fold: the content below a ToolGroupCard painted one
      // growth-step low on every frame. The pin is dropped when the fold starts
      // (releaseAncestorCollapsePins); this keeps it off if something re-pinned
      // in between — e.g. this body's own fold finishing after the nested fold
      // began. Deliberately BELOW the clamped branch: a flex-clamped body must
      // keep healing its pin from the content.
      if (anyCollapseAnimatingInside(content)) {
        if (body.style.height !== '') body.style.height = ''
        return
      }
```

and replace the now-unreachable fold half of the in-flight guard — from:

```ts
      if (animatingRef.current) {
        if (animKindRef.current === 'fold') {
          // An open/close fold is in flight — let it play to its target
          // rather than tearing it down (which made every open instant /
          // animation-less). finishOpen re-measures at animation end so any
          // growth during the fold is still reconciled.
          return
        }
        // A resize tween is in flight — tear it down and let the branch
        // below replace it. Cancel-and-replace is the animateResize
        // contract; a blanket guard here used to swallow every observation
        // after the first, freezing the body at the first frame's (stale)
        // target until finishOpen snapped to the truth at the end.
        cleanupAnimation()
      }
```

to:

```ts
      if (animatingRef.current) {
        // A resize tween is in flight (the fold case returned above) — tear it
        // down and let the branch below replace it. Cancel-and-replace is the
        // animateResize contract; a blanket guard here used to swallow every
        // observation after the first, freezing the body at the first frame's
        // (stale) target until finishOpen snapped to the truth at the end.
        cleanupAnimation()
      }
```

`animKindRef` is still read by the hoisted guard, so the ref stays.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/components/AnimatedCollapse.test.tsx`
Expected: PASS — the whole file, including the pre-existing resize/fold/clamp/stand-down suites (the hoist is behaviour-preserving there: every path that used to return on `kind === 'fold'` returned for the same observations).

- [ ] **Step 7: Commit**

```bash
git add src/components/AnimatedCollapse.tsx src/components/AnimatedCollapse.test.tsx
git commit -m "fix(collapse): a nested fold tracks its content instead of a pinned ancestor

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: ToolGroupCard regression test (the reported bug)

**Files:**
- Modify: `src/components/message-list/ToolGroupCard.test.tsx` (extend `renderGroup` with `toolResults`; add a describe block)

**Interfaces:**
- Consumes: `ToolResultEntry` from `src/session-store/types.ts` (`{ content: unknown; isError: boolean }`), keyed by tool_use id in `ToolResultProvider`; the release + observer behaviour from Tasks 1–2.
- Produces: nothing new.

- [ ] **Step 1: Extend `renderGroup` so a member can carry a result**

In `src/components/message-list/ToolGroupCard.test.tsx`, add `toolResults` to the props type and pass it through:

```tsx
  toolResults,
}: {
  members: SdkMessage[]
  toolStatus: Map<string, ToolStatus>
  toolResults?: Map<string, ToolResultEntry>
  searchQuery?: string
```

and inside the render tree, replace `<ToolResultProvider value={new Map()}>` with:

```tsx
        <ToolResultProvider value={toolResults ?? new Map()}>
```

plus the import:

```tsx
import type { ActiveSubagent, ToolResultEntry, ToolStatus } from '../../session-store/types'
```

- [ ] **Step 2: Write the failing tests**

Add to the same file (the file already has `fireEvent`, `act`, `vi`, and the RO stub helpers):

```tsx
/** happy-dom has no layout: the pin and every comparison read the USED height
 *  (`offsetHeight`), so a test models a box by faking that metric — the same
 *  approach (and the same reason) as AnimatedCollapse.test.tsx. */
function mockLayoutHeight(el: HTMLElement, height: number) {
  vi.spyOn(el, 'offsetHeight', 'get').mockReturnValue(height)
}

describe('ToolGroupCard — a member fold inside the group body', () => {
  const membersWithResult = (): { members: SdkMessage[]; toolStatus: Map<string, ToolStatus>; toolResults: Map<string, ToolResultEntry> } => ({
    members: [toolMsg('t1', 'Bash', { command: 'find . -maxdepth 1 -type f' })],
    toolStatus: new Map<string, ToolStatus>([['t1-tu', 'success']]),
    toolResults: new Map<string, ToolResultEntry>([['t1-tu', { content: 'x\ny\nz', isError: false }]]),
  })

  it('releases the group body pin when a member result row expands', () => {
    // The reported bug: the group body's pin relays the member fold's growth to
    // the transcript one ResizeObserver broadcast late, which paints the cards
    // below the group one growth-step low, every frame.
    vi.useFakeTimers()
    const { container } = renderGroup(membersWithResult())
    // Both boxes exist before the first open (unmountOnExit=false renders the
    // body and its content even while folded), and the heights must be faked
    // BEFORE the click: the open fold reads the content's used height in the
    // same commit, and happy-dom reports 0 for every box.
    const groupBody = container.querySelector('.tool-group-collapse') as HTMLElement
    const groupContent = container.querySelector('.tool-group-body') as HTMLElement
    mockLayoutHeight(groupBody, 300)
    mockLayoutHeight(groupContent, 300)
    fireEvent.click(container.querySelector('.tool-group-toggle')!) // members mount on first open
    act(() => { vi.advanceTimersByTime(400) })
    expect(groupBody.style.height).toBe('300px') // settled open, pinned

    const summary = container.querySelector('.tool-result-summary') as HTMLElement
    const nestedBody = summary.parentElement!.querySelector('.animated-collapse') as HTMLElement
    const nestedContent = summary.parentElement!.querySelector('.animated-collapse-content') as HTMLElement
    mockLayoutHeight(nestedBody, 0)
    mockLayoutHeight(nestedContent, 400)
    fireEvent.click(summary)

    // The member fold owns the height now: the group must not clip it.
    expect(nestedBody.classList.contains('animating')).toBe(true)
    expect(groupBody.style.height).toBe('')

    act(() => { vi.advanceTimersByTime(400) })
    // Settled: the member content is still rendered inside the group.
    expect(container.querySelector('.tool-result-details')).not.toBeNull()
  })

  it("keeps a folded group's 0px pin (a search-forced result row inside it)", () => {
    // ToolResultDetails force-expands itself on a search hit, which can open a
    // member's result inside a group that is itself folded. Releasing the folded
    // body's 0px pin there would spill the whole group open.
    vi.useFakeTimers()
    const { container } = renderGroup(membersWithResult())
    const groupBody = container.querySelector('.tool-group-collapse') as HTMLElement
    const groupContent = container.querySelector('.tool-group-body') as HTMLElement
    mockLayoutHeight(groupBody, 300)
    mockLayoutHeight(groupContent, 300)
    const toggle = container.querySelector('.tool-group-toggle') as HTMLElement
    fireEvent.click(toggle) // open once: members mount and the body pins to a real height
    act(() => { vi.advanceTimersByTime(400) })
    expect(groupBody.style.height).toBe('300px')

    fireEvent.click(toggle) // fold it back
    act(() => { vi.advanceTimersByTime(400) })
    expect(groupBody.style.height).toBe('0px')

    fireEvent.click(container.querySelector('.tool-result-summary')!)

    expect(groupBody.style.height).toBe('0px')
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/components/message-list/ToolGroupCard.test.tsx -t "member fold inside the group body"`
Expected: FAIL — the first case reports `groupBody.style.height === '300px'` where `''` is expected; the second passes already (it is the guard's regression test — keep it either way).

- [ ] **Step 4: Run the tests to verify they pass**

No production code is expected in this task: Tasks 1–2 make both cases pass. If the first still fails, the release is not firing on this path — check that the member's result details is an `AnimatedDetails` inside the group's body (`.tool-group-collapse > .tool-group-body > … > .tool-result-details`).

Run: `npx vitest run src/components/message-list/ToolGroupCard.test.tsx`
Expected: PASS — including every pre-existing group test (fold policy, entry latch, search force-expand).

- [ ] **Step 5: Commit**

```bash
git add src/components/message-list/ToolGroupCard.test.tsx
git commit -m "test(tool-group): pin the member-fold-inside-group-body invariant

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: Verify in the running app, then review

**Files:**
- No source changes expected. Fixes from review go back into the files above.

**Interfaces:**
- Consumes: `mcp__tools__appdebug_dom_eval` (drives the connected browser tab), `crw:debug:scroll` / `__scrollLogV2` if the app-level log is wanted.
- Produces: the acceptance evidence.

- [ ] **Step 1: Full suite, types, lint**

```bash
npm run test
npm run typecheck
npm run lint
```

Expected: all green. `npm run typecheck` runs both tsconfigs; the new test file is in `src/` (browser tsconfig).

- [ ] **Step 2: Measure the fix in the app (acceptance)**

`npm run dev` (if not already running), open a session that has a ToolGroupCard whose member has an expandable result row, put the browser window in the FOREGROUND (rAF is suspended on a hidden tab, so nothing animates and nothing can be measured), and run this probe through the appdebug bridge:

```js
// Find the group's result summary, then per painted frame record how far the
// viewport is from the true bottom (dist) and where the row below sits.
// RO created here runs AFTER the app's observers in the same delivery, so the
// values are what gets PAINTED (post-compensation).
const sum = [...document.querySelectorAll('.tool-group-card .tool-result-summary')][0];
const scroller = sum.closest('.chat-virtuoso-scroller');
const itemList = scroller.querySelector('[data-testid="virtuoso-item-list"]');
const row = sum.closest('[data-index]');
const rows = [...itemList.querySelectorAll(':scope > [data-index]')];
const below = rows[rows.findIndex(r => r === row) + 1] ?? rows[rows.length - 1];
const snap = () => ({
  t: +performance.now().toFixed(0),
  sTop: +scroller.scrollTop.toFixed(2),
  dist: +(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop).toFixed(2),
  below: +below.getBoundingClientRect().top.toFixed(2),
});
const out = [];
const ro = new ResizeObserver(() => out.push(snap()));
ro.observe(itemList);
window.__verify = { out, ro, sum, done: false };
setTimeout(() => { sum.click() }, 150);                 // open the result row
setTimeout(() => { sum.click(); ro.disconnect(); window.__verify.done = true }, 1600);
return { armed: true, visible: !document.hidden };
```

then, after the run, read it back:

```js
const v = window.__verify;
return { done: v.done, frames: v.out };
```

Expected, on every painted frame of the fold: `dist <= 1` and `below` constant within ±1px of its pre-fold value. Before this change the same probe reported `dist` 86–132px on the steep frames (and 15/7/4/2px on the tail) with `below` displaced by the same amount.

- [ ] **Step 3: Review the whole diff**

Run the `code-review` skill on `git diff HEAD~3` (Tasks 1–3) — per CLAUDE.md every change must pass a review before it lands. Verify each finding against the code before acting; re-run the review if a fix is non-trivial.

- [ ] **Step 4: Re-check the reviewer's cases against the Review Focus list**

Walk the five items at the top of this plan against the final diff and confirm each has a test that exercises it. `useTranscriptScroll.ts` must be untouched by the whole diff (`git diff HEAD~3 --stat` shows no message-list scroll file).

- [ ] **Step 5: Final commit (only if review produced changes)**

```bash
git add -A
git commit -m "fix(collapse): address review findings on nested-fold pinning

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Deliberately not done

- **No change to `useTranscriptScroll.ts`.** Its fold-lockstep compensation is correct — the boxes it reads simply did not contain that frame's growth yet. The three `scrollTop` write paths stay three.
- **No re-pin when the nested fold ends.** SUPERSEDED by the review pass that closed
  this plan: the first review found that a permanently unpinned body silently
  disables its `animateResize` glide for every later content growth (an auto box
  reports no difference to its own observer), so the observer now re-pins an
  auto-height body from its content — invisibly, since an auto box already equals
  it — which keeps the glide. The accepted trade-off below is therefore no longer
  in the shipped code.
  *(Historical note, kept for the record: the ancestor stays unpinned, which is the state `standDown` already leaves bodies in and which the next fold cycle pins again. Consequence, accepted at plan time: a member appended to a group after a nested fold in that group snaps instead of gliding — masked by the member's own entrance reveal (`tool-group-member-enter`), which plays regardless.)*
- **No CLAUDE.md edit.** The document does not describe `AnimatedCollapse`'s pinning or the `collapse-animation` registry at all, so the invariant belongs in the module comments (where the release and the observer check both carry it).