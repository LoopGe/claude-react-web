// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { measureResourceModalBodyHeight } from './resource-modal-measure'

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * Geometry fixture mirroring the resource preview modal
 * (resource-modal.css): the CARD carries the cap
 * (`max-height: min(86vh, 760px)`, resolved to px by getComputedStyle) and a
 * 1px border; the header is fixed chrome above the body; the body
 * (`.resource-modal-body`) pads its content wrapper. The body's natural
 * border-box height is `content.scrollHeight + bodyVerticalPadding`; the
 * ceiling the layout can actually give it is `cap − cardBorders − header`.
 *
 * The tween target must be min(natural, ceiling): an uncapped target pins the
 * body past the card's remaining space, and `clearInlineHeight` snaps it back
 * when the tween ends — the same jump class settings-panel-measure documents.
 */
function buildFixture(contentScrollHeight: number) {
  const card = document.createElement('div')
  card.className = 'modal resource-modal'
  card.style.maxHeight = '760px'
  card.style.border = '1px solid transparent'
  const header = document.createElement('div')
  header.className = 'modal-header resource-modal-header'
  const body = document.createElement('div')
  body.className = 'modal-section file-viewer-body resource-modal-body'
  body.style.padding = '8px'
  const content = document.createElement('div')
  content.className = 'resource-modal-content'
  card.appendChild(header)
  card.appendChild(body)
  body.appendChild(content)
  document.body.appendChild(card)

  vi.spyOn(header, 'offsetHeight', 'get').mockReturnValue(49)
  vi.spyOn(content, 'scrollHeight', 'get').mockReturnValue(contentScrollHeight)
  return { card, header, body, content }
}

it('caps at the body height the card can actually give (709), not the full content', () => {
  const { body, content, header } = buildFixture(1850)
  // cap 760 − borders 2 − header 49 = 709; content 1850 + padding 16 = 1866.
  expect(measureResourceModalBodyHeight(body, content, header)).toBe(709)
})

it('targets the content height while the content fits under the cap', () => {
  const { body, content, header } = buildFixture(500)
  // 500 + padding 16 = 516 < 709.
  expect(measureResourceModalBodyHeight(body, content, header)).toBe(516)
})

it('targets the (zero) remainder when the chrome leaves no body space', () => {
  const { body, content, header } = buildFixture(1850)
  vi.spyOn(header, 'offsetHeight', 'get').mockReturnValue(800)
  expect(measureResourceModalBodyHeight(body, content, header)).toBe(0)
})

it('throws when the body is not inside the resource modal layout', () => {
  const body = document.createElement('div')
  const content = document.createElement('div')
  const header = document.createElement('div')
  body.appendChild(content)
  expect(() => measureResourceModalBodyHeight(body, content, header)).toThrow(/resource-modal/)
})

it('reads the natural height content-sized, then restores the wrapper flex', () => {
  // The wrapper is flex-fill in production, so its scrollHeight tracks the
  // body's pinned height unless it is flipped content-sized for the read. The
  // getter captures the flex AT read time to prove the flip happened, and the
  // assertion after proves it was restored (a leaked flip would break the inner
  // scrollers' fill chain).
  const { body, content, header } = buildFixture(0)
  content.style.flex = '1 1 auto'
  let flexAtRead = ''
  vi.spyOn(content, 'scrollHeight', 'get').mockImplementation(() => {
    flexAtRead = content.style.flex
    return 1850
  })
  expect(measureResourceModalBodyHeight(body, content, header)).toBe(709)
  expect(flexAtRead).toBe('0 0 auto')
  expect(content.style.flex).toBe('1 1 auto')
})