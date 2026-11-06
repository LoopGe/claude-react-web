# Whole-pixel reveal tracks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the two CSS reveal animations (`.grid-clip-reveal`, `tool-result-enter`) from stepping their grid track at fractional pixel heights every frame, which re-phases the glyph raster of everything below them (the "展开 ToolGroupCard / subagent 卡片里的工具结果时抖动" report).

**Architecture:** A small rAF helper (`tweenGridTrack`) drives the collapsing grid track in **whole px** per frame — the same treatment `aa7ea76e` gave `AnimatedCollapse`'s own height tween — and the two CSS keyframes drop their `grid-template-rows` half (keeping the opacity/transform beats, which are compositor-only). The reveal class lifecycle (`useRevealClass`), the `overflow: hidden` clip, and the reduced-motion path are untouched.

**Tech Stack:** React 19, TypeScript, vitest (happy-dom for `src/**`), the existing `easeStandard` solver (`src/utils/cubic-bezier.ts`) and `revealDurationMs()` (`src/hooks/useRevealClass.ts`).

**Spec:** this plan's own "Problem & evidence (measured)" section — the diagnosis came from live instrumentation of the running app plus an in-page A/B, not from a prior spec doc.

## Problem & evidence (measured)

Expanding a tool result inside a subagent card (a child row's `Show result`) made the card's content visibly shake throughout the reveal. Measured on the running app, per painted frame, for the user's own click (row `Grep server/mcp-config.ts`, +22px of growth):

| metric | observed |
|---|---|
| clip slack (card content bottom ↔ clipped body edge) | **−0.48 … +0.27px** — stable |
| `.subagent-children` pin | monotone 473 → 484 → 488 → 491 → 493 → 494 → 495px |
| transcript `dist` | 0 → 4px, then healed by the trailing micro-pin |
| **enclosing content height** | **462 → 483.9 → 487.9 → 491.5 → 492.9 → 494.7 → 495** — fractional every frame |

So every *rect* is stable to half a pixel while the *layout* steps fractionally — the signature `aa7ea76e` documents as its third root cause: *"Chrome rasterizes text at the device-pixel grid of LAYOUT positions, so the cards below re-rasterize at a new sub-pixel phase every frame — visible shimmer even with the visual offset held constant (DOM rects steady, user still saw it)."* That commit fixed it inside `AnimatedCollapse` (rAF tween, per-frame heights rounded to whole CSS px) and left the reveal family on CSS.

**Confirmation (in-page A/B, user-reported):** injecting a `<style>` that re-declared both keyframes **without** `grid-template-rows` (opacity / `translateY` beats unchanged) made the shake disappear — "不抖动了". The two 12–13px `dist` excursions measured on *other* rows are the separate, documented band/trailing-pin trade-off (≤4px residue, healed ~250ms later), not this bug.

**Why my earlier rect-based probes came back clean** (recorded so the next investigator doesn't repeat it): this class is invisible to rect sampling by construction. Two hypotheses were falsified on the way and are *not* the cause: (1) a nested `AnimatedCollapse` fold relayed through a pinned ancestor (`aa7ea76e`'s mechanism — this path has no `AnimatedCollapse` in it at all); (2) the pin being snap-followed inside its ResizeObserver callback (measured: the pin tracks its content within ±0.5px).

**Out of scope, with the reason:** `streaming-region-in` (`chat.css`) animates `max-height` fractionally too, but it is the LAST element in the transcript (nothing below it to re-phase, and the bottom stack is positioned by the panel, not by the scroller's content), and `session-slot-in/-out` (`session-list.css`) is outside the transcript. Both are the same family; neither has this effect.

## Global Constraints

- No `scrollTop` writer is added or changed; the transcript's three write paths stay three (`useTranscriptScroll.ts` is untouched by this plan).
- The reveal **class lifecycle is unchanged**: `useRevealClass` still latches `-entering`/`-enter` on a genuine arrival, strips it on `animationend`, and falls back on the `revealDurationMs()` timer. Only the *height* moves from CSS to rAF.
- The `overflow: hidden` clip on the `-inner` elements stays exactly as it is — it is what clips the content to the growing track.
- Motion values keep their single sources of truth: the curve is `easeStandard` (tokens.css' `--motion-ease-enter` is an alias of `--motion-ease-standard`) and the duration is `revealDurationMs()` (which reads `--motion-duration-moderate`).
- Reduced motion must write **no** inline track at all (the CSS base track is `1fr` and reduced motion suppresses the reveal, so the row is simply full).
- Tests: `npx vitest run <file>`; `src/**` runs under happy-dom; restore fake timers / `matchMedia` stubs per file, as the neighbouring test files already do.
- CSS: no new color values; every change here is removing a property from two keyframes.
- Before this lands: `npm run test`, `npm run typecheck`, `npm run lint`, a `code-review` over the diff, and the live check in Task 4 (which needs the browser window in the foreground).

## Review Focus

1. **The row unmounts mid-reveal** (the card collapses, Virtuoso recycles the row): the tween's cancel must run and must not leave an inline `grid-template-rows` behind on a recycled element. Test in Task 1 ("cancel clears the track and stops writing") and Task 2/3's unmount coverage.
2. **Reduced motion** must write nothing and still reveal fully (the CSS `animation: none` suppression plus a parallel `prefersReducedMotion()` guard) — a tween that ran anyway would defeat the preference. Test in Task 1.
3. **Content that grows during the reveal** (an image decodes, a line wraps): the tween's end state must be the natural `1fr`, never a stale px value that clips or pads. Test in Task 1 ("clears the inline track when it finishes").
4. **The class must still be stripped** so the clip is removed (a stuck `-entering` would keep `overflow: hidden` and eat a contained button's focus ring) — the CSS keeps an animation for the opacity beat precisely so `animationend` still fires. Existing tests in `GridClipEnter.test.tsx` cover the latch and the fallback; keep them passing.
5. **The curve assumption** (`--motion-ease-enter` aliasing the standard curve) must be pinned, or a future token edit silently desyncs the JS tween from every other `-enter` animation. Guard test in Task 1.

---

### Task 1: `tweenGridTrack` — rAF, whole pixels

**Files:**
- Create: `src/utils/grid-track-tween.ts`
- Test: `src/utils/grid-track-tween.test.ts`

**Interfaces:**
- Consumes: `easeStandard` from `src/utils/cubic-bezier.ts`; `prefersReducedMotion` from `src/utils/reduced-motion.ts`; `revealDurationMs` from `src/utils/reveal-duration.ts` (moved out of `src/hooks/useRevealClass.ts` in Step 3 below, so this `src/utils` module never imports from `src/hooks`).
- Produces: `tweenGridTrack(el: HTMLElement, inner: HTMLElement): () => void` — animates `el.style.gridTemplateRows` from the current value to `inner.scrollHeight` in whole px, clears it back to the CSS base when done, and returns a cancel function (idempotent, safe after completion).

- [ ] **Step 1: Write the failing test**

Create `src/utils/grid-track-tween.test.ts`. (`src/utils/**` runs under node by `environmentMatchGlobs`… which has **no** `document` — so this file must opt into a DOM with a docblock, like `src/session-store/store.test.ts` does for jsdom. happy-dom is the repo's default DOM; use it.)

```ts
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tweenGridTrack } from './grid-track-tween'

/** A reveal-shaped pair: grid wrapper + clipped inner, as GridClipEnter and
 *  ToolResultSection render them. */
function mount(trackHeight: number) {
  const el = document.createElement('div')
  const inner = document.createElement('div')
  el.appendChild(inner)
  document.body.appendChild(el)
  Object.defineProperty(inner, 'scrollHeight', { configurable: true, get: () => trackHeight })
  return { el, inner }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('tweenGridTrack', () => {
  it('writes whole-pixel track values on every frame', () => {
    const { el, inner } = mount(400)
    tweenGridTrack(el, inner)

    const seen: string[] = []
    for (let frame = 0; frame < 6; frame++) {
      vi.advanceTimersByTime(16)
      if (el.style.gridTemplateRows) seen.push(el.style.gridTemplateRows)
    }
    expect(seen.length).toBeGreaterThan(2)
    for (const v of seen) expect(v).toMatch(/^\d+px$/) // never a fraction — this is the whole point
  })

  it('clears the inline track when it finishes (so later growth is unconstrained)', () => {
    const { el, inner } = mount(400)
    tweenGridTrack(el, inner)
    vi.advanceTimersByTime(400)
    expect(el.style.gridTemplateRows).toBe('')
  })

  it('reaches the measured height before clearing', () => {
    const { el, inner } = mount(240)
    tweenGridTrack(el, inner)
    vi.advanceTimersByTime(248)
    // the last written frame is the target (or already cleared on the very next tick)
    expect(el.style.gridTemplateRows === '' || el.style.gridTemplateRows === '240px').toBe(true)
  })

  it('cancel clears the track and stops writing', () => {
    const { el, inner } = mount(400)
    const cancel = tweenGridTrack(el, inner)
    vi.advanceTimersByTime(16)
    cancel()
    expect(el.style.gridTemplateRows).toBe('')
    vi.advanceTimersByTime(400)
    expect(el.style.gridTemplateRows).toBe('')
  })

  it('writes nothing under reduced motion', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
    const { el, inner } = mount(400)
    tweenGridTrack(el, inner)
    vi.advanceTimersByTime(400)
    expect(el.style.gridTemplateRows).toBe('')
  })

  it('does nothing for a zero-height target', () => {
    const { el, inner } = mount(0)
    tweenGridTrack(el, inner)
    vi.advanceTimersByTime(400)
    expect(el.style.gridTemplateRows).toBe('')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/utils/grid-track-tween.test.ts`
Expected: FAIL — `tweenGridTrack is not a function` (module absent).

- [ ] **Step 3: Move the duration helper out of the hooks module**

`revealDurationMs` currently lives in `src/hooks/useRevealClass.ts` and is used by exactly one site — that file's own fallback timer (verified: no other importer). The tween is a `src/utils` module and must not import from `src/hooks` for a pure CSS-var read, so move it first.

Create `src/utils/reveal-duration.ts` with the function moved verbatim (plus its doc):

```ts
/** Read `--motion-duration-moderate` (the one-shot reveal duration) from the
 *  theme, so both the reveal class's fallback cleanup and the rAF track tween
 *  track CSS edits instead of hardcoding 240ms. */
export const revealDurationMs = () => {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--motion-duration-moderate')
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : 240
}
```

In `src/hooks/useRevealClass.ts`: delete that definition (and its doc comment) and add `import { revealDurationMs } from '../utils/reveal-duration'` to the imports. Nothing else in the file changes.

Run: `npx vitest run src/components/GridClipEnter.test.tsx src/components/message-list/ToolGroupCard.test.tsx`
Expected: PASS (unchanged behaviour — the fallback timer still reads the same value).

- [ ] **Step 4: Write the implementation**

Create `src/utils/grid-track-tween.ts`:

```ts
import { easeStandard } from './cubic-bezier'
import { prefersReducedMotion } from './reduced-motion'
import { revealDurationMs } from './reveal-duration'

/** Drive a collapsing/expanding grid track from rAF, writing WHOLE-PIXEL
 *  heights every frame.
 *
 *  A CSS `grid-template-rows: 0fr→1fr` animation (what `.grid-clip-reveal` and
 *  `tool-result-enter` used) resolves to a FRACTIONAL height every frame, so
 *  every glyph below the growing row is re-rasterized at a new sub-pixel phase
 *  — visible shimmer even though the layout positions themselves measure stable
 *  (a SubagentCard child row: clip slack ±0.5px, pin monotone, while the
 *  enclosing content height stepped 483.9 / 487.9 / 491.5 / 492.9 px). That is
 *  the mechanism aa7ea76e fixed inside AnimatedCollapse by rounding each frame
 *  of its height tween to whole CSS px; this is the same treatment for the
 *  reveal family, which is still CSS-driven.
 *
 *  Curve and duration are the ones the CSS declared: `--motion-ease-enter` is an
 *  alias of `--motion-ease-standard` (tokens.css), and `revealDurationMs()` is
 *  the same value the reveal class's fallback timer uses, so a token edit can't
 *  desynchronize the two. The row's natural height is the target, and the inline
 *  track is CLEARED at the end so the CSS base `1fr` governs again — content that
 *  grows during or after the reveal must not be constrained by a stale px value.
 *
 *  Returns a cancel function, idempotent and safe after completion; callers must
 *  run it on unmount or a row recycled mid-reveal keeps an inline track. */
export function tweenGridTrack(el: HTMLElement, inner: HTMLElement): () => void {
  // The preference is served by leaving the CSS base track (`1fr`) in place.
  if (prefersReducedMotion()) return () => {}
  const target = inner.scrollHeight
  if (target <= 0) return () => {}

  const durationMs = revealDurationMs()
  const startedAt = performance.now()
  let raf = 0
  let done = false

  const finish = () => {
    if (done) return
    done = true
    window.cancelAnimationFrame(raf)
    window.clearTimeout(timer)
    el.style.gridTemplateRows = ''
  }

  const step = () => {
    if (done) return
    const t = Math.min(1, (performance.now() - startedAt) / durationMs)
    el.style.gridTemplateRows = `${Math.max(0, Math.round(target * easeStandard(t)))}px`
    if (t < 1) raf = window.requestAnimationFrame(step)
    else finish()
  }
  raf = window.requestAnimationFrame(step)

  // Safety net for a stalled rAF clock — also what fake-timer tests ride on.
  const timer = window.setTimeout(finish, durationMs + 120)

  return () => {
    if (done) return
    done = true
    window.cancelAnimationFrame(raf)
    window.clearTimeout(timer)
    el.style.gridTemplateRows = ''
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/utils/grid-track-tween.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Pin the curve assumption (JS↔CSS sync guard)**

`tweenGridTrack` drives the reveal with `easeStandard`, whose control points are tokens.css' `--motion-ease-standard`; the CSS `-enter` animations declare `--motion-ease-enter`, which is an **alias** of it today. Re-point that alias and the same reveal would play two different curves, silently. The repo already guards exactly this shape of coupling in `src/styles/settle-keyframe-sync.test.ts` (a JS↔CSS string match, node environment, no docblock needed under `src/styles/**`), so mirror it in a new file:

Create `src/styles/reveal-curve-sync.test.ts`:

```ts
// Guards the JS↔CSS coupling of the reveal family's easing: grid-track-tween
// drives the reveal with easeStandard, whose control points are
// --motion-ease-standard. --motion-ease-enter is an ALIAS of it today, so the
// JS tween matches what the CSS `-enter` animations declare. Re-point the
// alias (or retune the standard curve) and the tween in
// src/utils/grid-track-tween.ts must be updated in the same commit — otherwise
// one reveal plays two different curves.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const tokens = readFileSync(fileURLToPath(new URL('./tokens.css', import.meta.url)), 'utf8')

describe('reveal easing coupling', () => {
  it('keeps --motion-ease-enter an alias of --motion-ease-standard', () => {
    expect(tokens).toMatch(/--motion-ease-enter:\s*var\(--motion-ease-standard\)/)
  })

  it('keeps --motion-ease-standard the curve easeStandard solves', () => {
    expect(tokens).toMatch(/--motion-ease-standard:\s*cubic-bezier\(0\.22,\s*1,\s*0\.36,\s*1\)/)
  })
})
```

Run: `npx vitest run src/styles/reveal-curve-sync.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add src/utils/grid-track-tween.ts src/utils/grid-track-tween.test.ts src/utils/reveal-duration.ts src/hooks/useRevealClass.ts src/styles/reveal-curve-sync.test.ts
git commit -m "feat(motion): whole-pixel grid-track tween for the reveal family

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: `GridClipEnter` drives its track in JS (the subagent child row)

**Files:**
- Modify: `src/components/GridClipEnter.tsx`
- Modify: `src/styles/utilities.css:255-264` (`@keyframes grid-clip-reveal`)
- Test: `src/components/GridClipEnter.test.tsx`

**Interfaces:**
- Consumes: `tweenGridTrack(el, inner)` from Task 1.
- Produces: no API change — `GridClipEnter`'s props, class names and clip semantics stay identical; only the track's per-frame values come from rAF now.

- [ ] **Step 1: Write the failing test**

Append to `src/components/GridClipEnter.test.tsx` (keep every existing case — the class lifecycle must not change):

```tsx
it('drives the track in whole pixels while revealing, then clears it', () => {
  vi.useFakeTimers()
  const { container } = render(<GridClipEnter entering={true}><div className="child" /></GridClipEnter>)
  const el = container.querySelector('.grid-clip-enter') as HTMLElement
  const inner = container.querySelector('.grid-clip-enter-inner') as HTMLElement
  Object.defineProperty(inner, 'scrollHeight', { configurable: true, get: () => 320 })

  act(() => { vi.advanceTimersByTime(16) })
  act(() => { vi.advanceTimersByTime(16) })
  expect(el.style.gridTemplateRows).toMatch(/^\d+px$/)

  act(() => { vi.advanceTimersByTime(400) })
  // cleared, so the CSS base 1fr governs and later growth is unconstrained
  expect(el.style.gridTemplateRows).toBe('')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/GridClipEnter.test.tsx -t "whole pixels"`
Expected: FAIL — no inline track is written (the animation is CSS-only today, so `el.style.gridTemplateRows` stays empty).

- [ ] **Step 3: Implement the component**

Replace `src/components/GridClipEnter.tsx`'s body (keep the module doc, extended):

```tsx
import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { useRevealClass } from '../hooks/useRevealClass'
import { tweenGridTrack } from '../utils/grid-track-tween'

/**
 * One-shot grid-clip entrance wrapper (see `.grid-clip-enter` in
 * utilities.css): renders children inside a 1-row grid clip so the row's
 * real box height glides open instead of snapping the surrounding card
 * taller.
 *
 * The clip's height comes from `tweenGridTrack` (rAF, whole CSS px per frame)
 * rather than the CSS `grid-template-rows` keyframe: a fractional track
 * re-phases every glyph below the row every frame — the shimmer reported for a
 * subagent card's child rows. The `-entering` class still supplies the opacity
 * beat, so `useRevealClass`'s `animationend`/fallback lifecycle (and the
 * clip-only `overflow: hidden`) is unchanged.
 *
 * `entering` must come from a `useEnterOnArrival` gate in the PERSISTENT
 * parent (never from this conditionally-mounted wrapper): it must observe
 * the row's null → non-null transition while the parent is already mounted,
 * so the clip plays only on a GENUINE arrival — never on a Virtuoso
 * scroll-back remount, where the row is already present at mount and would
 * otherwise replay the 0fr→1fr fade every time the transcript scrolls
 * through the card (mirrors ToolResultSection's `entering` prop pattern).
 * The class lifecycle (latch, animationend strip, fallback) lives in
 * useRevealClass.
 */
export function GridClipEnter({ entering, children }: { entering: boolean; children: ReactNode }) {
  const { revealing, handleAnimationEnd } = useRevealClass(entering, 'grid-clip-reveal')
  const outerRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!revealing) return
    const el = outerRef.current
    const inner = innerRef.current
    if (!el || !inner) return
    // Cancel on unmount: a row recycled mid-reveal must not keep an inline track.
    return tweenGridTrack(el, inner)
  }, [revealing])

  return (
    <div
      ref={outerRef}
      className={`grid-clip-enter${revealing ? ' grid-clip-entering' : ''}`}
      onAnimationEnd={handleAnimationEnd}
    >
      <div ref={innerRef} className="grid-clip-enter-inner">{children}</div>
    </div>
  )
}
```

- [ ] **Step 4: Drop the track from the keyframe**

In `src/styles/utilities.css`, replace `@keyframes grid-clip-reveal` (lines ~255-264) with — note the comment change, the base `.grid-clip-enter { grid-template-rows: 1fr }` rule **stays**:

```css
/* Only the opacity beat lives in CSS now: the row's height is driven from rAF
   in whole CSS px (`src/utils/grid-track-tween.ts`), because a fractional
   `grid-template-rows` tween re-phases every glyph below the row on every
   frame. The base track stays `1fr` — the tween writes an inline px value and
   clears it again, so nothing constrains later content growth. */
@keyframes grid-clip-reveal {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
```

Run: `npx vitest run src/components/GridClipEnter.test.tsx`
Expected: PASS — the new case plus every pre-existing latch/fallback case.

- [ ] **Step 5: Commit**

```bash
git add src/components/GridClipEnter.tsx src/components/GridClipEnter.test.tsx src/styles/utilities.css
git commit -m "fix(motion): drive GridClipEnter's track in whole pixels

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: `ToolResultSection` drives its track in JS (the tool-result reveal)

**Files:**
- Modify: `src/components/ToolCard.tsx` (`ToolResultSection`, ~line 483-496)
- Modify: `src/styles/utilities.css:196-211` (`@keyframes tool-result-enter` and the `.tool-card-result-enter` rule)
- Test: `src/components/ToolCard.test.tsx`

**Interfaces:**
- Consumes: `tweenGridTrack(el, inner)` from Task 1.
- Produces: no API change — `ToolResultSection`'s props, classes and the error tint stay identical.

- [ ] **Step 1: Write the failing test**

The reveal is armed by `useEnterOnArrival` on the result landing, so drive it through the component's own props. Append to `src/components/ToolCard.test.tsx` (it already imports `act`/`vi`/`render`; add `ToolResultSection` to its imports from `./ToolCard`):

```tsx
describe('ToolResultSection — result reveal', () => {
  it('drives the grid track in whole pixels, then clears it', () => {
    vi.useFakeTimers()
    const { container } = render(
      <ToolResultSection result={{ content: 'line', isError: false }} entering />,
    )
    const el = container.querySelector('.tool-card-result') as HTMLElement
    const inner = container.querySelector('.tool-card-result-inner') as HTMLElement
    Object.defineProperty(inner, 'scrollHeight', { configurable: true, get: () => 260 })

    act(() => { vi.advanceTimersByTime(16) })
    act(() => { vi.advanceTimersByTime(16) })
    expect(el.style.gridTemplateRows).toMatch(/^\d+px$/)

    act(() => { vi.advanceTimersByTime(400) })
    expect(el.style.gridTemplateRows).toBe('')
    vi.useRealTimers()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/ToolCard.test.tsx -t "result reveal"`
Expected: FAIL — no inline track written today.

- [ ] **Step 3: Implement the section**

In `src/components/ToolCard.tsx`, `ToolResultSection` becomes (imports: add `useLayoutEffect`, `useRef` to the existing React import, and `tweenGridTrack`):

```tsx
export const ToolResultSection = memo(function ToolResultSection({ result, entering = false, searchQuery, activeMatchIdx }: { result: ToolResultEntry; entering?: boolean; searchQuery?: string; activeMatchIdx?: number }) {
  const { revealing, handleAnimationEnd } = useRevealClass(entering, 'tool-result-enter')
  const wrapperRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)

  // The reveal's height is driven from rAF in whole CSS px: a fractional
  // `grid-template-rows` tween re-phases every glyph below the section each
  // frame (the reported shimmer when expanding a tool result inside a card).
  // `entering` still supplies the class's opacity/rise beat.
  useLayoutEffect(() => {
    if (!revealing) return
    const el = wrapperRef.current
    const inner = innerRef.current
    if (!el || !inner) return
    return tweenGridTrack(el, inner)
  }, [revealing])

  return (
    <div
      ref={wrapperRef}
      className={`tool-card-result${result.isError ? ' tool-card-result-error' : ''}${revealing ? ' tool-card-result-enter' : ''}`}
      onAnimationEnd={handleAnimationEnd}
    >
      <div className="tool-card-result-inner" ref={innerRef}>
        <ToolResultDetails content={result.content} searchQuery={searchQuery} activeMatchIdx={activeMatchIdx} />
      </div>
    </div>
  )
})
```

- [ ] **Step 4: Drop the track from the keyframe**

In `src/styles/utilities.css`, replace `@keyframes tool-result-enter` (~lines 200-211) with (the base `.tool-card-result { display: grid; grid-template-rows: 1fr }` rule **stays**):

```css
/* Opacity + rise only: the section's height is driven from rAF in whole CSS px
   (`src/utils/grid-track-tween.ts`) so a fractional grid track can't re-phase
   the glyphs below it every frame. */
@keyframes tool-result-enter {
  from {
    opacity: 0;
    transform: translateY(var(--motion-distance-sm));
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
```

Run: `npx vitest run src/components/ToolCard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Check the consumers of the reveal still pass**

The same reveal is used by every merged tool card, so run the suites around it:

Run: `npx vitest run src/components/ToolCard.test.tsx src/components/message-list/MessageList.test.tsx src/components/message-list/ToolGroupCard.test.tsx src/components/SubagentCard.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/ToolCard.tsx src/components/ToolCard.test.tsx src/styles/utilities.css
git commit -m "fix(motion): drive the tool-result reveal in whole pixels

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: Verify in the running app, then review

**Files:**
- No source changes expected. Review fixes go back into the files above.

**Interfaces:**
- Consumes: the appdebug bridge (`dom_eval`) to drive the connected browser tab.
- Produces: the acceptance evidence.

- [ ] **Step 1: Suite, types, lint**

```bash
npm run test
npm run typecheck
npm run lint
```

Expected: the three touched files green, and the suite no worse than its pre-existing baseline — this repo's suite currently has environment-dependent `server/` failures (Windows path separators, `EPERM` temp dirs, daemon tests needing a built bundle, occasional 5s timeouts) that vary run to run and are unrelated to a client-only diff. Report whatever the run actually shows; do not paraphrase it as "green". For `lint`, run it on the changed files (`npx eslint src/utils/grid-track-tween.ts src/components/GridClipEnter.tsx src/components/ToolCard.tsx …`): the repo-wide `eslint .` currently fails on untracked scratch directories.

- [ ] **Step 2: Remove the A/B style, then measure the track in the app**

If the diagnostic `<style id="crw-ab-no-frac-reveal">` is still injected in the user's tab, remove it first (it is the *temporary* fix, and leaving it would make the new code look inert):

```js
document.getElementById('crw-ab-no-frac-reveal')?.remove(); return { removed: true };
```

Then, with the browser window in the FOREGROUND (rAF is suspended on a hidden tab), sample the track per frame while a result row is expanded:

```js
const el = document.querySelector('.tool-card-result-enter') || document.querySelector('.grid-clip-entering');
if (!el) return { armed: false, why: 'expand a tool result that has not been expanded yet, then re-run' };
const seen = [];
const obs = new MutationObserver(() => { if (el.style.gridTemplateRows) seen.push(el.style.gridTemplateRows) });
obs.observe(el, { attributes: true, attributeFilter: ['style'] });
window.__revealProbe = { seen, el, obs };
return { armed: true };
```

read back after the reveal:

```js
const p = window.__revealProbe; p.obs.disconnect();
return { samples: p.seen, allIntegers: p.seen.every(v => /^\d+px$/.test(v)), finalTrack: p.el.style.gridTemplateRows };
```

Expected: `samples` non-empty, `allIntegers: true`, `finalTrack: ''` (cleared back to the base `1fr`). Before this change the same click left `grid-template-rows` empty (CSS-owned) while the *measured content height* stepped fractionally — the numbers that led here.

- [ ] **Step 3: The acceptance needs the user's eyes**

The bug is a raster artifact, which no DOM measurement can see (that is why every rect probe came back clean). Ask the user to expand a fresh tool result inside the subagent card — **with the A/B style removed** — and confirm the shake is gone. Record their answer verbatim in the ledger; do not claim it from the geometry.

- [ ] **Step 4: Review the whole diff, then re-check the Review Focus list**

Run the `code-review` skill over the branch's commits, verify each finding against the code, and fix confirmed Critical/Important findings with a test that failed first. Then walk the five items at the top of this plan against the final diff and confirm each has a covering test.

- [ ] **Step 5: Commit review fixes (only if there are any)**

```bash
git add src/utils/grid-track-tween.ts src/components/GridClipEnter.tsx src/components/ToolCard.tsx src/styles/utilities.css src/components/GridClipEnter.test.tsx src/components/ToolCard.test.tsx
git commit -m "fix(motion): address review findings on the reveal track tween

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

Stage explicit paths, never `git add -A`: this working tree carries unrelated, actively-edited WIP (an `index.html` / `package.json` / `public/icon-192.png` / `vitest.config.ts` icon feature this work did not author).

---

## Deliberately not done

- **`streaming-region-in` and `session-slot-in/-out` stay on CSS.** Same family, but the streaming region is the transcript's LAST element (nothing below it re-phases; the bottom stack is positioned by the panel) and the sidebar slots are outside the transcript. Converting them would be risk without an observed effect; they are recorded here so the next report can be matched to them in one step.
- **No change to `AnimatedCollapse`.** Its height tween already rounds per frame (`aa7ea76e`); this plan only brings the CSS-driven reveal family to the same contract.
- **No `will-change`/compositing workaround.** Promoting the content to its own layer would mask the symptom without fixing the layout steps, and the repo already chose and measured the integer-step route.