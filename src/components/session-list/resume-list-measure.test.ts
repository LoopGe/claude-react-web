// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { measureResumeListHeight } from './resume-list-measure'

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * Geometry fixture for the resume picker list. The ceiling is the card cap
 * minus fixed chrome: borders 2 + header 50 + footer 40 + section padding 16 +
 * input sibling 40 + one flex gap 10 + list margin 10 = 168. With a 760px card
 * cap the ceiling is 592 (above the list's own 400 cap); with a 300px cap it is
 * 132 (below it) — the short-panel case where the flex ceiling must bind. The
 * percentage-cap variant resolves 100% against the parent's content height.
 */
function buildFixture(
  contentScrollHeight: number,
  opts: { cardMaxHeight?: string; parentClientHeight?: number; parentPadding?: string } = {},
) {
  const { cardMaxHeight = '760px', parentClientHeight = 900, parentPadding = '0px' } = opts
  const parent = document.createElement('div')
  parent.style.padding = parentPadding
  const card = document.createElement('div')
  card.className = 'modal modal-resume-session'
  card.style.maxHeight = cardMaxHeight
  card.style.padding = '0px'
  card.style.border = '1px solid transparent'
  const header = document.createElement('div')
  header.className = 'modal-header'
  const section = document.createElement('div')
  section.className = 'modal-section'
  section.style.padding = '8px'
  section.style.rowGap = '10px'
  const input = document.createElement('div')
  const list = document.createElement('div')
  list.className = 'palette-list'
  list.style.maxHeight = '400px'
  list.style.padding = '6px'
  list.style.marginTop = '10px'
  const content = document.createElement('div')
  content.className = 'resume-list-content'
  const footer = document.createElement('div')
  footer.className = 'modal-footer'
  list.appendChild(content)
  section.appendChild(input)
  section.appendChild(list)
  card.appendChild(header)
  card.appendChild(section)
  card.appendChild(footer)
  parent.appendChild(card)
  document.body.appendChild(parent)

  vi.spyOn(parent, 'clientHeight', 'get').mockReturnValue(parentClientHeight)
  vi.spyOn(header, 'offsetHeight', 'get').mockReturnValue(50)
  vi.spyOn(footer, 'offsetHeight', 'get').mockReturnValue(40)
  vi.spyOn(input, 'offsetHeight', 'get').mockReturnValue(40)
  vi.spyOn(content, 'scrollHeight', 'get').mockReturnValue(contentScrollHeight)
  return { parent, card, header, section, input, list, content, footer }
}

it('targets the content height while it fits under both caps', () => {
  const { list, content } = buildFixture(200)
  // 200 + padding 12 = 212 < min(ceiling 592, listCap 400).
  expect(measureResumeListHeight(list, content)).toBe(212)
})

it("caps at the list's own max-height when the flex ceiling is larger", () => {
  const { list, content } = buildFixture(900)
  // min(912, ceiling 592, listCap 400) = 400.
  expect(measureResumeListHeight(list, content)).toBe(400)
})

it('caps at the flex ceiling when a short card squeezes below the list cap', () => {
  // Card cap 300 → ceiling 300 − 168 = 132, below the list's 400 cap. The
  // target must be 132, not 400 (which would overshoot and snap on release).
  const { list, content } = buildFixture(900, { cardMaxHeight: '300px' })
  expect(measureResumeListHeight(list, content)).toBe(132)
})

it('resolves a percentage card cap against the parent content height', () => {
  // The panel variant: max-height:100% of a 400px parent with 16px padding →
  // cap 368 → ceiling 368 − 168 = 200.
  const { list, content } = buildFixture(900, {
    cardMaxHeight: '100%',
    parentClientHeight: 400,
    parentPadding: '16px',
  })
  expect(measureResumeListHeight(list, content)).toBe(200)
})

it('targets the (zero) remainder when the chrome leaves no list space', () => {
  const { list, content } = buildFixture(900, { cardMaxHeight: '100px' })
  expect(measureResumeListHeight(list, content)).toBe(0)
})

it('is independent of the list pinned height (mid-tween retarget)', () => {
  // Below the cap the card is content-sized, so a ceiling read from the current
  // section/card height would collapse to the pin. The cap-based ceiling must
  // return the same target whether the list is auto or pinned mid-tween.
  const { list, content } = buildFixture(900, { cardMaxHeight: '300px' })
  const auto = measureResumeListHeight(list, content)
  list.style.height = '50px'
  list.style.flex = '0 0 auto'
  const pinned = measureResumeListHeight(list, content)
  expect(pinned).toBe(auto)
  expect(auto).toBe(132)
})

it('throws when the list is not inside a modal/panel card section', () => {
  const list = document.createElement('div')
  const content = document.createElement('div')
  list.appendChild(content)
  expect(() => measureResumeListHeight(list, content)).toThrow(/card section/)
})