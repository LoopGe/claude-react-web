// Guards the drag lift / drop-settle motion contract. These pieces are split
// across stylesheets and dnd-kit's side effects, so a change in one without the
// other silently reintroduces the "appearance snaps" defect: the source card
// scale-back, the hole's lift rounding, the ghost's lift-in entrance, and the
// landing settle (scale + border-radius) all have to line up.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const sessionList = read('./session-list.css')
const dnd = read('./dnd.css')
const motion = read('../dnd/motion.ts')
const dragGhost = read('../dnd/DragGhost.tsx')

/** The declaration block of the first rule with this exact selector. Comments
 *  are stripped — several of them describe declarations they are NOT part of
 *  (the base rule's comment explains why border-radius is absent). The match
 *  is line-start anchored: a bare substring search would also bind inside a
 *  longer selector that merely ENDS with the target (e.g.
 *  `.session-item-shell.list-first > .session-item.dragging {`), silently
 *  reading the wrong block once file order shifts. All top-level rules in
 *  these sheets start at column 0. */
function ruleBlock(css: string, selector: string): string {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const start = `\n${clean}`.indexOf(`\n${selector} {`)
  expect(start, `missing rule: ${selector}`).toBeGreaterThan(-1)
  const end = clean.indexOf('}', start)
  return clean.slice(start, end)
}

function transitionOf(block: string): string {
  const start = block.indexOf('transition:')
  expect(start, 'missing transition declaration').toBeGreaterThan(-1)
  return block.slice(start, block.indexOf(';', start))
}

describe('source card lift / release', () => {
  it('declares the release-side transform on the base rule', () => {
    // Drop removes `.dragging`, so the 0.97 → 1 scale-back only animates if
    // the base rule (the after-change style on release) owns `transform`.
    expect(transitionOf(ruleBlock(sessionList, '.session-item'))).toContain(
      'transform var(--motion-duration-fast)',
    )
  })

  it('derives the landing radius from the named run-radius property', () => {
    // motion.ts reads `--run-radius` at drop; it must exist for every run
    // position, and custom properties don't transition, so the read is exact.
    expect(sessionList).toContain('--run-radius: var(--radius-md) var(--radius-md) 0 0')
    expect(sessionList).toContain('--run-radius: 0 0 var(--radius-md) var(--radius-md)')
    expect(motion).toContain("getPropertyValue('--run-radius')")
  })

  it('rounds the lifted hole to the floating card radius and animates it', () => {
    const dragging = ruleBlock(sessionList, '.session-item.dragging')
    expect(dragging).toContain('border-radius: var(--radius-md);')
    expect(transitionOf(dragging)).toContain('border-radius')
  })

  it('overrides the run-end partial radii while dragging', () => {
    expect(sessionList).toContain('.session-item-shell.list-first > .session-item.dragging')
    expect(sessionList).toContain('.session-item-shell.list-last > .session-item.dragging')
  })
})

describe('floating ghost lift-in', () => {
  it('animates the lift entrance, excluding rigid surfaces', () => {
    expect(dnd).toContain('@keyframes dnd-ghost-lift-in')
    expect(dnd).toContain(
      '.dnd-ghost-lift-in:not(.dnd-ghost-panel):not(.dnd-ghost-section)',
    )
  })

  it('gates the entrance on the live drag so the drop clone never replays it', () => {
    // dnd-kit re-mounts the overlay subtree for its drop animation; the public
    // context (active === null there) is what keeps the class off the clone.
    // Mechanism pins, deliberately not the exact JSX expression — an
    // equivalent reformatting must not redden the suite.
    expect(dragGhost).toContain('useDndContext')
    expect(dragGhost).toContain('active != null')
    expect(dragGhost).toContain('dnd-ghost-lift-in')
  })
})

describe('drop landing settle', () => {
  it('shares the landing class name between motion.ts and dnd.css', () => {
    const landingClass = motion.match(/DND_GHOST_LANDING_CLASS = '([^']+)'/)?.[1]
    expect(landingClass, 'DND_GHOST_LANDING_CLASS').toBeTruthy()
    expect(dnd).toContain(`.${landingClass}`)
    expect(motion).toContain('classList.add(DND_GHOST_LANDING_CLASS)')
  })

  it('seeds the landing radius from the source card', () => {
    expect(motion).toContain("setProperty('--dnd-landing-radius'")
    expect(dnd).toContain('var(--dnd-landing-radius, var(--radius-md))')
  })

  it('cancels the lift scale with a matched counter-translation', () => {
    // dnd-kit aligns the 1.05-scaled ghost box; shrinking about its centre
    // alone leaves the card ~2.5% of its width off, then it snaps at handoff.
    expect(motion).toContain('landingCounterTranslate(')
    expect(motion).toContain("'--dnd-landing-dx'")
    expect(dnd).toContain('translate: var(--dnd-landing-dx, 0px) var(--dnd-landing-dy, 0px)')
    expect(dnd).toMatch(/transition: scale var\(--dnd-drop-duration[^;]*translate var\(--dnd-drop-duration/)
  })

  it('fades the lift shadow out with the settle', () => {
    // The resting card has no drop-shadow; keeping it on the ghost until
    // removal would pop the shadow in one frame at the handoff.
    expect(ruleBlock(dnd, '.dnd-ghost-landing .dnd-ghost')).toContain('filter: none')
    expect(dnd).toMatch(/transition: scale var\(--dnd-drop-duration[^;]*filter var\(--dnd-drop-duration/)
  })

  it('re-shows the hidden source instantly at the handoff', () => {
    // dnd-kit hides the source through the glide; restoring the inline
    // opacity under the shell's base transition fades it in AFTER the ghost
    // is gone — the whole-card flash. The load-bearing mechanism is the
    // transition freeze around the restore (flush + hand-back are
    // implementation detail, deliberately not pinned by statement text).
    expect(motion).toContain("style.transition = 'none'")
  })

  it('matches the ghost lifetime (DROP_DURATION_MS, one owner)', () => {
    const duration = motion.match(/DROP_DURATION_MS = (\d+)/)?.[1]
    expect(duration, 'DROP_DURATION_MS').toBeTruthy()
    // The dnd-kit config consumes the constant, the side effects publish it
    // as a custom property, and the CSS settle reads THAT — the fallback
    // mirrors the constant for the impossible unset case.
    expect(motion).toContain('duration: DROP_DURATION_MS')
    expect(motion).toContain("setProperty('--dnd-drop-duration'")
    expect(dnd).toContain(`var(--dnd-drop-duration, ${duration}ms)`)
  })
})

describe('reduced motion', () => {
  it('cancels the lift-in and the landing settle at equal specificity', () => {
    const reduced = dnd.slice(dnd.indexOf('@media (prefers-reduced-motion: reduce)'))
    // The animated rule is (0,3,0); a bare `.dnd-ghost-lift-in` here would
    // lose the cascade and leave the entrance running under reduce.
    expect(reduced).toContain('.dnd-ghost-lift-in:not(.dnd-ghost-panel):not(.dnd-ghost-section)')
    expect(reduced).toContain('.dnd-ghost-landing .dnd-ghost')
    expect(reduced).toContain('animation: none')
    expect(reduced).toContain('transition: none')
  })
})
