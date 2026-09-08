// Shared assertion for the app's floating surfaces. Test helper, not app code.
//
// Portalling to <body> is a correctness requirement for these, not a layout
// preference: they are `position: fixed` and derive left/top from
// getBoundingClientRect() — i.e. VIEWPORT coordinates — and any ancestor
// carrying filter / transform / backdrop-filter silently takes over as the
// containing block those numbers are read against. The canonical statement of
// the hazard is the CONTAINING-BLOCK HAZARD note in src/styles/layout.css.
//
// jsdom can't measure a containing block, so what this pins is the structural
// precondition that makes the coordinates mean what they say. The other half of
// the pair — that the surfaces really are `position: fixed`, and that they keep
// the wallpaper/accent compensations portalling costs them — is pinned in
// src/styles/floating-surface-anchor.test.ts.

import { expect } from 'vitest'
import { PORTAL_MARKER } from '../theme'

/** Assert that the element matched by `selector` was rendered as a direct child
 *  of <body> rather than left inside `renderContainer` (the RTL render root), and
 *  that it carries [data-portaled] — the marker every compensation for leaving
 *  the themed container hangs off (fill remap, accent thumb, click-attribution),
 *  so portalling without it is only half a fix. */
export function expectPortaledToBody(renderContainer: HTMLElement, selector: string): HTMLElement {
  const el = document.querySelector(selector)
  expect(el, `${selector} should be rendered`).not.toBeNull()
  expect(el!.parentElement, `${selector} must be a direct child of <body>`).toBe(document.body)
  expect(
    renderContainer.contains(el!),
    `${selector} must not stay inside the container it was rendered from`,
  ).toBe(false)
  expect(
    el!.hasAttribute(PORTAL_MARKER),
    `${selector} must be marked [${PORTAL_MARKER}] so the container-loss compensations apply`,
  ).toBe(true)
  return el as HTMLElement
}
