// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { measureCappedContentHeight } from './capped-height-measure'

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * Flat palette card: parent > card > input + list. The cap is resolved from the
 * card's computed max-height (a px length reads straight). Chrome = card borders
 * 2 + input 40 = 42; with cap 468 the ceiling is 426. The list has no own
 * max-height. Percentage/min() caps resolve against the parent's content height.
 */
function flatFixture(
  contentScrollHeight: number,
  opts: { cap?: number; maxHeight?: string; parentClientHeight?: number; parentPadding?: string } = {},
) {
  const { cap = 468, maxHeight, parentClientHeight, parentPadding = '0px' } = opts
  const parent = document.createElement('div')
  parent.style.padding = parentPadding
  const card = document.createElement('div')
  card.className = 'panel-overlay-card input-history-card'
  card.style.maxHeight = maxHeight ?? `${cap}px`
  card.style.border = '1px solid transparent'
  card.style.padding = '0px'
  const input = document.createElement('input')
  const list = document.createElement('div')
  list.className = 'palette-list'
  list.style.padding = '6px'
  const content = document.createElement('div')
  list.appendChild(content)
  card.appendChild(input)
  card.appendChild(list)
  parent.appendChild(card)
  document.body.appendChild(parent)
  if (parentClientHeight != null) {
    vi.spyOn(parent, 'clientHeight', 'get').mockReturnValue(parentClientHeight)
  }
  vi.spyOn(input, 'offsetHeight', 'get').mockReturnValue(40)
  vi.spyOn(content, 'scrollHeight', 'get').mockReturnValue(contentScrollHeight)
  return { parent, card, input, list, content }
}

/**
 * Nested card: card > header + section(input + list) + footer. Chrome = borders
 * 2 + section(padding 16 + gap 10 + input 40) + card siblings(header 50 + footer
 * 40) + list margin 10 = 168; with cap 760 the ceiling is 592, list sub-cap 400.
 */
function nestedFixture(contentScrollHeight: number, cap = 760) {
  const card = document.createElement('div')
  card.className = 'modal'
  card.style.maxHeight = `${cap}px`
  card.style.border = '1px solid transparent'
  card.style.padding = '0px'
  const header = document.createElement('div')
  header.className = 'modal-header'
  const section = document.createElement('div')
  section.className = 'modal-section'
  section.style.padding = '8px'
  section.style.rowGap = '10px'
  const input = document.createElement('div')
  const list = document.createElement('div')
  list.className = 'palette-list'
  list.style.padding = '6px'
  list.style.marginTop = '10px'
  list.style.maxHeight = '400px'
  const content = document.createElement('div')
  const footer = document.createElement('div')
  footer.className = 'modal-footer'
  list.appendChild(content)
  section.appendChild(input)
  section.appendChild(list)
  card.appendChild(header)
  card.appendChild(section)
  card.appendChild(footer)
  document.body.appendChild(card)
  vi.spyOn(header, 'offsetHeight', 'get').mockReturnValue(50)
  vi.spyOn(footer, 'offsetHeight', 'get').mockReturnValue(40)
  vi.spyOn(input, 'offsetHeight', 'get').mockReturnValue(40)
  vi.spyOn(content, 'scrollHeight', 'get').mockReturnValue(contentScrollHeight)
  return { card, header, section, input, list, content, footer }
}

it('flat card: caps at the ceiling for tall content', () => {
  const { list, content, card } = flatFixture(900)
  // min(912, ceiling 426, no sub-cap) = 426.
  expect(measureCappedContentHeight(list, content, card)).toBe(426)
})

it('flat card: targets the content height when it fits', () => {
  const { list, content, card } = flatFixture(200)
  expect(measureCappedContentHeight(list, content, card)).toBe(212)
})

it('nested card: caps at the list sub-cap when the ceiling is larger', () => {
  const { list, content, card } = nestedFixture(900)
  // min(912, ceiling 592, sub-cap 400) = 400.
  expect(measureCappedContentHeight(list, content, card)).toBe(400)
})

it('nested card: caps at the flex ceiling when a short card squeezes below the sub-cap', () => {
  const { list, content, card } = nestedFixture(900, 300)
  // ceiling 300 − 168 = 132 < sub-cap 400.
  expect(measureCappedContentHeight(list, content, card)).toBe(132)
})

it('resolves a percentage card cap against the parent content height', () => {
  // max-height:100% of a 500px parent with 16px padding → cap 468 → ceiling 426.
  const { list, content, card } = flatFixture(900, {
    maxHeight: '100%',
    parentClientHeight: 500,
    parentPadding: '16px',
  })
  expect(measureCappedContentHeight(list, content, card)).toBe(426)
})

it('resolves a min() card cap (px and percentage terms)', () => {
  // min(480px, 100%) with parent content 468 → min(480, 468) = 468 → ceiling 426.
  const { list, content, card } = flatFixture(900, {
    maxHeight: 'min(480px, 100%)',
    parentClientHeight: 500,
    parentPadding: '16px',
  })
  expect(measureCappedContentHeight(list, content, card)).toBe(426)
})

it('does not mutate the box (non-invasive measure)', () => {
  // Regression: an earlier empirical lift forced the box tall and restored it,
  // which let an auto box reflow to full height before the tween pinned its start
  // (killing the loading→content animation) and animated against the hook's
  // height transition mid-tween (oscillation). The measure must touch nothing.
  const { list, content, card } = flatFixture(900)
  list.style.height = '123px'
  list.style.flex = '1 1 auto'
  list.style.maxHeight = '50vh'
  list.style.transition = 'height 240ms ease'
  measureCappedContentHeight(list, content, card)
  expect(list.style.height).toBe('123px')
  expect(list.style.flex).toBe('1 1 auto')
  expect(list.style.maxHeight).toBe('50vh')
  expect(list.style.transition).toBe('height 240ms ease')
})

it('targets zero when the chrome consumes the whole cap', () => {
  const { list, content, card } = flatFixture(900, { cap: 10 })
  expect(measureCappedContentHeight(list, content, card)).toBe(0)
})

it('ignores out-of-flow children (overlay-scrollbar track) in the chrome sum', () => {
  // The overlay scrollbar appends an absolute track to the card whose height
  // equals the scroller's; counting it as chrome collapsed the ceiling to ~0.
  const { list, content, card } = flatFixture(900)
  const track = document.createElement('div')
  track.style.position = 'absolute'
  card.appendChild(track)
  vi.spyOn(track, 'offsetHeight', 'get').mockReturnValue(426)
  // Still 426 — the absolute track is not flex chrome.
  expect(measureCappedContentHeight(list, content, card)).toBe(426)
})

it('floors the target at the box min-height', () => {
  const { list, content, card } = flatFixture(40)
  list.style.minHeight = '120px'
  // natural 40 + padding 12 = 52, but the box renders at its 120px floor.
  expect(measureCappedContentHeight(list, content, card)).toBe(120)
})