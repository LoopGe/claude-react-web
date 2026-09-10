// @vitest-environment node
// The CSS half of the floating-surface invariant. The JSX half (each surface is
// portalled to <body> and stamped [data-portaled]) is pinned by
// portal-test-utils.ts in the component tests and by Overlay.test.tsx.
//
// Both halves have to hold together:
//   * `position: fixed` + viewport-derived left/top is only correct at body
//     level — the hazard documented in src/styles/layout.css.
//   * and portalling out of `.chat-panel` / `.sidebar` forfeits the custom
//     properties those containers declare, so the wallpaper fill remap and the
//     accent-tinted overlay scrollbar have to be re-declared for
//     [data-portaled]. Each absence was measured, not theorised.
//
// A test that only asserted "parentElement === document.body" would also pass if
// someone flipped these surfaces to `position: absolute`, which silently changes
// what the coordinates mean — hence reading the stylesheets here. Pure file
// reading, so the node environment (vitest.config.ts reserves jsdom for tests
// that mount React or touch the DOM).

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), 'utf8')
const style = (file: string) => read('src/styles', file)
// Every stylesheet, read ONCE. Listing src/styles rather than hardcoding files
// means a backdrop declared in a new stylesheet is covered automatically instead
// of silently skipped.
const ALL_CSS = readdirSync(join(process.cwd(), 'src/styles'))
  .filter((f) => f.endsWith('.css'))
  .map(style)
  .join('\n')

/** Declarations of a rule whose head is EXACTLY `selector` on its own line.
 *  Matching the head rather than a substring means a grouped rule
 *  (`.foo,\n.cmd-picker { … }`) can never stand in for the standalone rule the
 *  invariant is about — the whole point is that the rule itself says fixed. */
function standaloneRule(css: string, selector: string): string {
  const head = new RegExp(`\\n\\${selector} \\{([^}]*)\\}`)
  const m = head.exec(css)
  expect(m, `standalone "${selector} { … }" rule`).not.toBeNull()
  return m![1]
}

// Selector + the stylesheet that declares it: these surfaces don't all live in
// session-list.css, and asserting against the wrong file would pass vacuously
// (standaloneRule fails loudly instead, which is the point of carrying the file).
const PICKERS = [
  { selector: '.cmd-picker', file: 'session-list.css' },
  { selector: '.ctx-menu', file: 'session-list.css' },
  { selector: '.model-picker', file: 'session-list.css' },
  { selector: '.subagent-swarm-pop', file: 'chat.css' },
] as const

describe('fixed floating surfaces', () => {
  it.each(PICKERS)('$selector is position: fixed (the coordinate contract its portal exists for)', ({ selector, file }) => {
    expect(standaloneRule(style(file), selector)).toContain('position: fixed')
  })

  it('re-declares the wallpaper fill remap for [data-portaled] surfaces', () => {
    // One marker selector, not a roster of class names: a surface gets the
    // compensation by portalling, not by being added to a list here.
    expect(style('layout.css')).toContain('body.has-bg [data-portaled] {')
  })

  it('keeps the overlay scrollbar thumb tinted inside [data-portaled] surfaces', () => {
    expect(style('overlay-scrollbar.css')).toContain('[data-portaled] .os-thumb {')
  })
})

// The Content slider works in two halves that are useless apart: tokens.css
// freezes each fill token into an opaque `--<name>-solid` alias (the raw token
// is no good — a rule on the container that reads it back would be a
// self-reference, and a token COMPOSED from another fill token at :root has
// already baked the opaque value in), and layout.css re-declares the token as a
// mix of that alias with --app-surface-alpha on the chrome containers. An alias
// with no remap leaves the surface opaque; a remap whose alias doesn't exist
// mixes a token against itself, which is invalid and silently drops the
// declaration. Both halves are one list, so they are checked as one.
describe('wallpaper fill remap covers every frozen token', () => {
  const aliases = [...style('tokens.css').matchAll(/--([\w-]+)-solid:\s*var\(--([\w-]+)\)/g)]
    .map(([, name, source]) => ({ name, source }))
  // Capture the SOURCE as well as the property name: matching only the name
  // would let a mis-paired remap (`--bg: color-mix(… var(--code-bg-solid) …)`)
  // satisfy every cross-check below while painting the wrong fill.
  const remapped = new Map(
    [...style('layout.css').matchAll(
      /--([\w-]+):\s*color-mix\(in srgb, var\(--([\w-]+)\) var\(--app-surface-alpha\), transparent\)/g,
    )].map(([, name, source]) => [name, source]),
  )

  it('reads both halves out of the source (guard against a silent regex miss)', () => {
    expect(aliases.length).toBeGreaterThanOrEqual(14)
    expect(remapped.size).toBeGreaterThanOrEqual(14)
  })

  it('names every alias after the token it freezes', () => {
    expect(aliases.filter((a) => a.name !== a.source)).toEqual([])
  })

  it('pairs every remap with its own alias', () => {
    expect([...remapped].filter(([name, source]) => source !== `${name}-solid`)).toEqual([])
  })

  it('re-declares every aliased token, and nothing without an alias', () => {
    const names = new Set(aliases.map((a) => a.name))
    expect([...names].filter((n) => !remapped.has(n)), 'aliased but never remapped').toEqual([])
    expect([...remapped.keys()].filter((n) => !names.has(n)), 'remapped without an alias').toEqual([])
  })

  // The specific trap this guard exists for: --msg-user-* are frozen opaque at
  // :root exactly like the rest, so they look like candidates — but .chat-panel
  // re-declares them against its own per-session --accent, and the remap's
  // higher specificity (0,2,1 vs 0,1,0) would win and pin user bubbles to the
  // GLOBAL accent. They keep following the slider through --bg instead.
  it('never shadows a token the chrome container re-declares for itself', () => {
    const redeclared = [...(/\n\.chat-panel \{([^}]*)\}/.exec(style('layout.css'))?.[1] ?? '')
      .matchAll(/--([\w-]+):/g)].map(([, name]) => name)
    expect(redeclared.length, 'guard against a silent regex miss').toBeGreaterThanOrEqual(5)
    expect(redeclared.filter((n) => remapped.has(n))).toEqual([])
  })
})

describe('Overlay portal defaults track the backdrops actual position', () => {
  const overlay = read('src/components', 'Overlay.tsx')
  const variantRows = [...overlay.matchAll(/^ {2}(\w+): \{ backdrop: '([\w-]+)'/gm)]
  const listed = new Set(
    [...(overlay.match(/FIXED_BACKDROP_VARIANTS[^=]*= \[([\s\S]*?)\]/)?.[1] ?? '').matchAll(/'([\w]+)'/g)]
      .map((m) => m[1]),
  )

  it('reads both sides of the claim out of the source (guard against a silent regex miss)', () => {
    expect(variantRows.length).toBeGreaterThanOrEqual(10)
    expect(listed.size).toBeGreaterThanOrEqual(4)
  })

  it.each(variantRows.map(([, variant, backdrop]) => ({ variant, backdrop })))(
    '$variant portals iff its .$backdrop is position: fixed',
    ({ variant, backdrop }) => {
      const isFixed = standaloneRule(ALL_CSS, `.${backdrop}`).includes('position: fixed')
      expect(listed.has(variant), `${variant} in FIXED_BACKDROP_VARIANTS`).toBe(isFixed)
    },
  )
})
