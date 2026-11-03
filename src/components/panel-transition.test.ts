// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { keyboardTargetsScroller, middleClickTargetsScroller, nextPanelShowEpoch, touchTargetsScroller, wheelChainsToScroller } from './panel-transition'

describe('panel transition epoch', () => {
  it('starts fresh panels at 1 and increments once per show', () => {
    expect(nextPanelShowEpoch(undefined)).toBe(1)
    expect(nextPanelShowEpoch(1)).toBe(2)
    expect(nextPanelShowEpoch(2)).toBe(3)
  })
})

describe('middle-click autoscroll ownership', () => {
  function scrollable(): HTMLElement {
    const el = document.createElement('div')
    el.style.overflowY = 'auto'
    Object.defineProperties(el, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 600 },
    })
    return el
  }

  it('accepts transcript content but rejects nested scrollers and links', () => {
    const scroller = scrollable()
    const content = document.createElement('div')
    scroller.appendChild(content)
    expect(middleClickTargetsScroller(scroller, content)).toBe(true)

    const nested = scrollable()
    scroller.appendChild(nested)
    expect(middleClickTargetsScroller(scroller, nested)).toBe(false)

    const link = document.createElement('a')
    scroller.appendChild(link)
    expect(middleClickTargetsScroller(scroller, link)).toBe(false)

    const horizontal = document.createElement('div')
    horizontal.style.overflowX = 'auto'
    Object.defineProperties(horizontal, {
      scrollWidth: { configurable: true, value: 1000 },
      clientWidth: { configurable: true, value: 600 },
    })
    scroller.appendChild(horizontal)
    expect(middleClickTargetsScroller(scroller, horizontal)).toBe(false)

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    content.appendChild(svg)
    expect(middleClickTargetsScroller(scroller, svg)).toBe(true)
    expect(wheelChainsToScroller(scroller, svg, -100)).toBe(true)
  })
})

describe('wheel chaining ownership', () => {
  it('rejects a target outside the scroller', () => {
    const scroller = document.createElement('div')
    const sibling = document.createElement('div')
    expect(wheelChainsToScroller(scroller, sibling, -100)).toBe(false)
    expect(wheelChainsToScroller(scroller, scroller, -100)).toBe(true)
  })

  it('keeps touch ownership at the initial nested scroller even at its boundary', () => {
    const scroller = document.createElement('div')
    scroller.style.overflowY = 'auto'
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 600 },
    })
    const nested = document.createElement('div')
    nested.style.overflowY = 'auto'
    Object.defineProperties(nested, {
      scrollHeight: { configurable: true, value: 400 },
      clientHeight: { configurable: true, value: 100 },
      scrollTop: { configurable: true, value: 300 },
    })
    scroller.appendChild(nested)
    expect(touchTargetsScroller(scroller, nested)).toBe(false)
    expect(touchTargetsScroller(scroller, scroller)).toBe(true)

    const link = document.createElement('a')
    scroller.appendChild(link)
    expect(keyboardTargetsScroller(scroller, link, 'PageDown')).toBe(true)
    const button = document.createElement('button')
    scroller.appendChild(button)
    expect(keyboardTargetsScroller(scroller, button, 'PageUp')).toBe(true)
    expect(keyboardTargetsScroller(scroller, button, ' ')).toBe(false)
  })
})
