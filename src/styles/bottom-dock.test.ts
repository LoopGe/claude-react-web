// @vitest-environment node
// Pins the collapsed-dock decision shared by the TWO bottom-overlay cards —
// the TaskList (TodoChecklist) and the MonitorBar. The cards dock identically
// (the prototype's variant B, prototype/tasklist-dock.html, tuned after
// real-app feedback); this file is the LOCKSTEP CONTRACT — a geometry change
// to one card must land on the other in the same commit:
//   margin-bottom: calc(var(--chat-row-gap) - 36px) — closes the 12px row gap
//     AND pulls the composer 24px up over the card's lower edge,
//   padding-bottom: calc(var(--space-2-5) + 20px)  — the overlap zone is EMPTY
//     padding, so the header text never sits under the composer's glass line;
//     ~6px of quiet glass remains visible between text and glass line,
//   padding-top: var(--space-1-5)                  — the docked bar tightens
//     its top padding to a slim 6px strip,
//   square bottom corners                          — the tucked look.
// Geometry history: the first cut (variant B of prototype/tasklist-dock.html)
// used -18px / +22px, which left a ~26px empty band exposed under the header —
// real-app feedback said too much. The overlap then deepened stepwise to its
// current -36px/+20px, shrinking the quiet-glass remainder from ~10px to ~6px
// (note: padding-bottom GROWS with the overlap to keep the zone empty — only
// the remainder shrinks). A later retune tightened the collapsed top padding
// to 6px. Retuning again is a deliberate re-decision that updates this pin.
// Also pins
// structural invariants of the shared feature: the dock
// geometry must TRANSITION on the BASE card rule (a transition declared only
// on the collapsed rule would make the expand snap), and the rotors' header
// text must ellipsize — never wrap or push the count / chevron off the docked
// bar — and the TaskList rotor slide must carry the rows' shimmer recipe
// while working.
// Pure file reading — same pattern as overlay-backdrop-scroll.test.ts.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(join(process.cwd(), 'src/styles', 'messages.css'), 'utf8')
const utilitiesCss = readFileSync(join(process.cwd(), 'src/styles', 'utilities.css'), 'utf8')
const chatCss = readFileSync(join(process.cwd(), 'src/styles', 'chat.css'), 'utf8')
const tokensCss = readFileSync(join(process.cwd(), 'src/styles', 'tokens.css'), 'utf8')

/** Bodies of EVERY standalone rule whose head is exactly `selector` (at any
 *  indent), captured to the next line-start `}`. Same extraction contract as
 *  overlay-backdrop-scroll.test.ts: grouped heads are intentionally not
 *  matched, and every head is asserted to exist. */
function ruleBodies(selector: string): string[] {
  const head = new RegExp(`(?:^|\n)[ \t]*${selector.replace(/[.>]/g, '\\$&')} \\{([\\s\\S]*?)\n\\}`, 'g')
  const bodies = [...css.matchAll(head)].map((m) => m[1])
  expect(bodies.length, `standalone "${selector} { … }" rule in messages.css`).toBeGreaterThan(0)
  return bodies
}

const declarations = (selector: string) =>
  ruleBodies(selector)
    .map((b) => b.replace(/\/\*[\s\S]*?\*\//g, ''))
    .join('\n')

describe('TaskList collapsed dock (prototype variant B)', () => {
  it('collapsed card docks behind the composer with the approved geometry', () => {
    const body = declarations('.todo-panel.todo-panel-collapsed')
    expect(body).toContain('padding-top: var(--space-1-5)')
    expect(body).toContain('margin-bottom: calc(var(--chat-row-gap) - 36px)')
    expect(body).toContain('padding-bottom: calc(var(--space-2-5) + 20px)')
    expect(body).toContain('border-bottom-left-radius: 0')
    expect(body).toContain('border-bottom-right-radius: 0')
  })

  it('the collapsed header drops its bottom margin — the quiet-glass figure depends on it', () => {
    // The ~6px quiet-glass invariant is measured from the HEADER TEXT's bottom
    // edge, which only sits where the arithmetic expects because the collapsed
    // header drops its base `margin-bottom: var(--space-1-5)`. Deleting that
    // rule would widen the band by 6px (or push the text across the glass
    // line) with every other pin still green — so pin both copies (lockstep).
    expect(declarations('.todo-panel.todo-panel-collapsed .todo-panel-header')).toContain('margin-bottom: 0')
    expect(declarations('.monitor-bar.monitor-bar-collapsed .monitor-bar-header')).toContain('margin-bottom: 0')
  })

  it('the quiet-glass arithmetic assumes --chat-row-gap is 12px', () => {
    // The doc comments derive the overlap (36 − gap = 24px) and the quiet
    // glass (padding-bottom − overlap ≈ 6px) from --chat-row-gap; the CSS
    // pins pin only the calc() TEXT, so a token retune would silently diverge
    // the rendered geometry from the documented figures. Pin the resolution.
    const gapRule = chatCss.match(/--chat-row-gap:\s*([^;]+);/)
    expect(gapRule, '--chat-row-gap declared in chat.css').not.toBeNull()
    expect(gapRule![1].trim()).toBe('var(--space-3)')
    expect(tokensCss).toMatch(/--space-3:\s*12px/)
  })

  it('the dock geometry transitions on the base card, so the expand animates too', () => {
    const body = declarations('.todo-panel')
    // The transition must list the longhands (the expand tween's properties)…
    expect(body).toContain('transition:')
    expect(body).toContain('margin-bottom var(--motion-duration-moderate)')
    expect(body).toContain('padding-bottom var(--motion-duration-moderate)')
    expect(body).toContain('padding-top var(--motion-duration-moderate)')
    // …AND the base rule must still own the geometry the collapsed values
    // animate FROM — the shorthands below are that endpoint. Asserting them
    // is what keeps this pin honest: `toContain('margin-bottom')` alone was
    // satisfiable by the transition declaration text itself, so deleting the
    // base geometry (and snapping the expand) stayed green.
    expect(body).toContain('margin: 0 var(--chat-reading-inset) var(--chat-row-gap)')
    expect(body).toContain('padding: var(--space-2-5) var(--space-3-5)')
  })

  it('rotor text ellipsizes instead of wrapping the docked header bar', () => {
    // Ellipsis truncation lives in the shared `.truncate` utility in
    // utilities.css (the element carries `className="dock-rotor-text
    // truncate"`); the rule here owns only the flex context the utility
    // requires.
    const body = declarations('.dock-rotor-text')
    expect(body).toContain('min-width: 0')
    const truncateRule = utilitiesCss.match(/(?:^|\n)\.truncate \{([\s\S]*?)\n\}/)
    expect(truncateRule, 'standalone ".truncate { … }" rule in utilities.css').not.toBeNull()
    expect(truncateRule![1]).toContain('white-space: nowrap')
    expect(truncateRule![1]).toContain('text-overflow: ellipsis')
  })

  it("the rotor slide text joins the in_progress rows' shimmer while working", () => {
    // The shimmer recipe is a GROUPED selector (rows + rotor slide text) —
    // grouped heads sit outside ruleBodies' standalone contract, so extract
    // the rule by its first head and assert the rotor selector joined it with
    // the recipe intact. The class renders unconditionally on the slide; the
    // `.todo-panel-working` gate is what switches the sweep on — the exact
    // mechanism the list rows use.
    const start = css.indexOf('.todo-panel-working .todo-in_progress .todo-text-shimmer')
    expect(start, 'shimmer recipe rule present in messages.css').toBeGreaterThanOrEqual(0)
    const body = css.slice(start, css.indexOf('\n}', start)).replace(/\/\*[\s\S]*?\*\//g, '')
    expect(body).toContain('.todo-panel-working .dock-rotor .todo-text-shimmer')
    expect(body).toContain('-webkit-text-fill-color: transparent')
    expect(body).toContain('animation: todo-text-shimmer 2s linear infinite')
  })

  it("the reduced-motion a11y block silences the docked rotors' sweeps too", () => {
    // The a11y block kills the shimmer with a solid-label fallback. The todo
    // kill is head-keyed on the ROWS' selector, so the docked rotor's grouped
    // extension must be listed there explicitly — the MonitorBar rotor is
    // covered for free by the bare `.monitor-text-shimmer` kill (it uses the
    // rows' class). Found by review; pinned so the asymmetry cannot return.
    // Anchor on the media block's icon-kill head WITH its trailing comma —
    // the base pulse rule's head has no comma, so this finds the block, not
    // the base rule.
    const anchor = css.indexOf('.todo-panel-working .todo-in_progress .todo-icon,')
    expect(anchor, 'reduced-motion a11y block present in messages.css').toBeGreaterThanOrEqual(0)
    const mediaStart = css.lastIndexOf('@media (prefers-reduced-motion: reduce)', anchor)
    const body = css.slice(mediaStart, css.indexOf('\n}', mediaStart)).replace(/\/\*[\s\S]*?\*\//g, '')
    expect(body).toContain('.todo-panel-working .dock-rotor .todo-text-shimmer')
    expect(body).toContain('.monitor-text-shimmer')
    expect(body).toContain('animation: none')
  })
})

describe('collapsed dock vs a visible dock error-bar (un-dock counter-rule)', () => {
  // The dock-fold pull (margin-bottom -36px) lifts the dock's TOP 24px over
  // the card's reserved glass band. The design assumes that band is covered
  // by the composer (later tree order → paints above the frosted glass). But
  // .chat-dock's first child is the always-mounted .error-bar, which becomes
  // a visible card whenever an error is showing (e.g. 'Stream reconnecting…'
  // while the WS hub is reconnecting) — the red strip then lands IN the
  // overlap zone, smeared across the collapsed card's squared glass band.
  // The counter-rule un-docks the card while a visible error-bar exists so
  // the error card sits below it with the normal row gap; both docked cards
  // must carry it (lockstep), reverting EXACTLY to the base geometry (the
  // base rules own the transition, so both directions animate).
  const head = '.chat-bottom-overlay:has(.chat-dock > .error-bar:not(.error-bar-empty))'

  it('un-docks the collapsed TaskList card while a dock error-bar is visible', () => {
    const start = css.indexOf(`${head} .todo-panel.todo-panel-collapsed`)
    expect(start, 'un-dock counter-rule present in messages.css').toBeGreaterThanOrEqual(0)
    const body = css.slice(start, css.indexOf('\n}', start)).replace(/\/\*[\s\S]*?\*\//g, '')
    // Exact revert to the base-rule geometry (the same values the base
    // `margin:` / `padding:` shorthands and glass.css's radius resolve to) —
    // anything else would make the un-docked state a third geometry. The
    // padding-top revert matters because the collapsed rule TIGHTENS it to
    // var(--space-1-5); without the longhand here the un-docked card would
    // keep the docked top padding.
    expect(body).toContain('margin-bottom: var(--chat-row-gap)')
    expect(body).toContain('padding-top: var(--space-2-5)')
    expect(body).toContain('padding-bottom: var(--space-2-5)')
    expect(body).toContain('border-bottom-left-radius: var(--radius-xl)')
    expect(body).toContain('border-bottom-right-radius: var(--radius-xl)')
  })

  it('un-docks the collapsed MonitorBar card in the same grouped rule (lockstep)', () => {
    const start = css.indexOf(`${head} .todo-panel.todo-panel-collapsed`)
    expect(start, 'un-dock counter-rule present in messages.css').toBeGreaterThanOrEqual(0)
    const headEnd = css.indexOf('{', start)
    const groupHead = css.slice(start, headEnd)
    expect(groupHead).toContain(`${head} .monitor-bar.monitor-bar-collapsed`)
  })
})

describe('MonitorBar collapsed dock (same recipe as the TaskList card)', () => {
  it('collapsed bar docks behind the composer with the shared geometry', () => {
    const body = declarations('.monitor-bar.monitor-bar-collapsed')
    expect(body).toContain('padding-top: var(--space-1-5)')
    expect(body).toContain('margin-bottom: calc(var(--chat-row-gap) - 36px)')
    expect(body).toContain('padding-bottom: calc(var(--space-2-5) + 20px)')
    expect(body).toContain('border-bottom-left-radius: 0')
    expect(body).toContain('border-bottom-right-radius: 0')
  })

  it('the dock geometry transitions on the base bar, so the expand animates too', () => {
    const body = declarations('.monitor-bar')
    // Same honest shape as the TaskList pin above: longhands IN the
    // transition, plus the base shorthands that are the animation's FROM end.
    expect(body).toContain('transition:')
    expect(body).toContain('margin-bottom var(--motion-duration-moderate)')
    expect(body).toContain('padding-bottom var(--motion-duration-moderate)')
    expect(body).toContain('padding-top var(--motion-duration-moderate)')
    expect(body).toContain('margin: 0 var(--chat-reading-inset) var(--chat-row-gap)')
    expect(body).toContain('padding: var(--space-2-5) var(--space-3-5)')
  })
})
