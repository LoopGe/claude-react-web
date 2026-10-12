// @vitest-environment node
// Pins the collapsed-dock decision shared by the TWO bottom-overlay cards —
// the TaskList (TodoChecklist) and the MonitorBar. The cards dock identically
// (the prototype's variant B, prototype/tasklist-dock.html, tuned after
// real-app feedback); this file is the LOCKSTEP CONTRACT — a geometry change
// to one card must land on the other in the same commit:
//   margin-bottom: calc(var(--chat-row-gap) - 30px) — closes the 12px row gap
//     AND pulls the composer 18px up over the card's lower edge,
//   padding-bottom: calc(var(--space-2-5) + 18px)  — the overlap zone is EMPTY
//     padding, so the header text never sits under the composer's glass line;
//     ~10px of quiet glass remains visible between text and glass line,
//   square bottom corners                          — the tucked look.
// Geometry history: the first cut (variant B of prototype/tasklist-dock.html)
// used -18px / +22px, which left a ~26px empty band exposed under the header —
// real-app feedback said too much; the overlap deepened and the padding
// trimmed together. Retuning again is a deliberate re-decision that updates
// this pin. Also pins structural invariants of the shared feature: the dock
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
    expect(body).toContain('margin-bottom: calc(var(--chat-row-gap) - 30px)')
    expect(body).toContain('padding-bottom: calc(var(--space-2-5) + 18px)')
    expect(body).toContain('border-bottom-left-radius: 0')
    expect(body).toContain('border-bottom-right-radius: 0')
  })

  it('the dock geometry transitions on the base card, so the expand animates too', () => {
    const body = declarations('.todo-panel')
    // The transition must list the longhands (the expand tween's properties)…
    expect(body).toContain('transition:')
    expect(body).toContain('margin-bottom var(--motion-duration-moderate)')
    expect(body).toContain('padding-bottom var(--motion-duration-moderate)')
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

describe('MonitorBar collapsed dock (same recipe as the TaskList card)', () => {
  it('collapsed bar docks behind the composer with the shared geometry', () => {
    const body = declarations('.monitor-bar.monitor-bar-collapsed')
    expect(body).toContain('margin-bottom: calc(var(--chat-row-gap) - 30px)')
    expect(body).toContain('padding-bottom: calc(var(--space-2-5) + 18px)')
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
    expect(body).toContain('margin: 0 var(--chat-reading-inset) var(--chat-row-gap)')
    expect(body).toContain('padding: var(--space-2-5) var(--space-3-5)')
  })
})
