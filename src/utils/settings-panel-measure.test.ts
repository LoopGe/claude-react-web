// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { measureSettingsPanelBodyHeight } from './settings-panel-measure'

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * Geometry fixture live-measured on the session settings panel (skills tab,
 * 2026-10 bug trace — "expanding Loaded skills makes the scrollbar suddenly
 * shorter when the expansion completes"):
 *
 *   overlay.clientHeight 1204, padding 16px/16px
 *   panel   offsetTop 16 (from the overlay's padding edge), clientTop 1,
 *           border-bottom 1px — position: relative, promoted by the overlay
 *           scrollbar, so it is the body's offsetParent
 *   body    offsetTop 117 (panel-relative: header 49 + nav 68)
 *   body's natural height in the capped regime: 1053 (panel at max-height)
 *
 * The old measure returned min(scrollHeight, 1204 − 117) = 1087 — 34px past
 * the natural height (the backdrop's bottom padding + the card's borders,
 * plus the coordinate-system mix of an overlay-relative clientHeight with a
 * panel-relative offsetTop). The tween pinned the body at 1087 and
 * `clearInlineHeight` snapped it back to 1053 — the visible jump.
 */
/**
 * `panelIsOffsetParent` models WHICH element the body's offsetTop is relative
 * to — the overlay scrollbar promotes `.settings-panel` to `position: relative`
 * in a passive effect, so the body's offsetParent is the panel AFTER the
 * promotion and the overlay BEFORE it (the hook's first measure can land in
 * that window). Both regimes must produce the same ceiling:
 *
 *   promoted:   body.offsetTop 117 (panel-relative) + panel.offsetTop 16 +
 *               panel.clientTop 1 = 134 within the overlay
 *   unpromoted: body.offsetTop 134 (already overlay-relative)
 */
function buildFixture(contentScrollHeight: number, opts: { panelIsOffsetParent?: boolean } = {}) {
  const { panelIsOffsetParent = true } = opts
  const overlay = document.createElement('div')
  overlay.className = 'settings-overlay'
  overlay.style.padding = '16px'
  const panel = document.createElement('aside')
  panel.className = 'settings-panel'
  panel.style.padding = '0px'
  panel.style.borderBottom = '1px solid transparent'
  const body = document.createElement('div')
  body.className = 'settings-panel-body'
  const content = document.createElement('div')
  content.className = 'settings-panel-content'
  panel.appendChild(body)
  body.appendChild(content)
  overlay.appendChild(panel)
  document.body.appendChild(overlay)

  vi.spyOn(overlay, 'clientHeight', 'get').mockReturnValue(1204)
  vi.spyOn(panel, 'offsetTop', 'get').mockReturnValue(16)
  vi.spyOn(panel, 'clientTop', 'get').mockReturnValue(1)
  vi.spyOn(body, 'offsetTop', 'get').mockReturnValue(panelIsOffsetParent ? 117 : 134)
  vi.spyOn(body, 'offsetParent', 'get').mockReturnValue(panelIsOffsetParent ? panel : overlay)
  vi.spyOn(panel, 'offsetParent', 'get').mockReturnValue(overlay)
  vi.spyOn(content, 'scrollHeight', 'get').mockReturnValue(contentScrollHeight)
  return { overlay, panel, body, content }
}

it('caps at the body height the layout can actually give (1053), not the padded-overlay arithmetic (1087)', () => {
  const { body, content } = buildFixture(1850)
  expect(measureSettingsPanelBodyHeight(body, content)).toBe(1053)
})

it('caps at the same height before the scrollbar promotes the panel (body.offsetTop overlay-relative)', () => {
  // The promotion is an effect-time inline style; the hook's first measure can
  // run before it. Naming the panel as the offsetParent would double-count its
  // offsetTop + clientTop here and under-shoot the ceiling by 17px, seeding a
  // spurious catch-up tween on panel open.
  const { body, content } = buildFixture(1850, { panelIsOffsetParent: false })
  expect(measureSettingsPanelBodyHeight(body, content)).toBe(1053)
})

it('targets the content height while the content fits under the cap', () => {
  const { body, content } = buildFixture(500)
  expect(measureSettingsPanelBodyHeight(body, content)).toBe(500)
})

it('targets the (zero) remainder when the chrome leaves no body space, not the full content', () => {
  // A squeezed geometry (header + nav + chrome consume the whole overlay) is
  // a real 0 ceiling — the old `availableBodyHeight || content.scrollHeight`
  // falsy-zero fallback failed open to the full content height, pinning the
  // body past the card's remaining space.
  const { body, content } = buildFixture(1850)
  vi.spyOn(body, 'offsetTop', 'get').mockReturnValue(5000)
  expect(measureSettingsPanelBodyHeight(body, content)).toBe(0)
})

it('throws when the body is not inside the settings overlay layout', () => {
  // The DOM contract (Chat renders Overlay > SettingsPanel) cannot be broken
  // by any caller — a silent fallback here would mask a real contract break
  // as an uncapped tween target (the bug class this module exists to fix).
  const body = document.createElement('div')
  const content = document.createElement('div')
  body.appendChild(content)
  expect(() => measureSettingsPanelBodyHeight(body, content)).toThrow(/settings-overlay/)
})
