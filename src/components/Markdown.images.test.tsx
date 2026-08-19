// Verifies markdown image rendering: embedded base64 data: URLs and http(s)
// URLs become real <img>s, while unsupported references (e.g. the model
// writing `![plan-card-overlay](/api/placeholder)`) render as muted fallback
// text instead of a broken image.
//
// Uses the REAL react-markdown pipeline (no module mock) so it exercises
// urlTransform + the img override end-to-end. Runs in jsdom (src/** .tsx).

import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { Markdown } from './Markdown'

afterEach(() => cleanup())

describe('Markdown image rendering', () => {
  it('renders a base64 data: image as <img>', () => {
    const { container } = render(<Markdown text={'![x](data:image/png;base64,AAAA)'} />)

    const img = container.querySelector('img.msg-image')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('src')).toBe('data:image/png;base64,AAAA')
    // The img override must NOT spread react-markdown's injected `node` prop
    // onto the DOM element (passNode: true leaks the hast node otherwise).
    expect(img?.hasAttribute('node')).toBe(false)
  })

  it('renders data:image/svg+xml as <img> (SVG-in-img is script-disabled)', () => {
    const { container } = render(<Markdown text={'![x](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)'} />)

    const img = container.querySelector('img.msg-image')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('src')).toBe('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')
  })

  it('renders an http(s) image as <img>', () => {
    const { container } = render(<Markdown text={'![x](https://example.com/a.png)'} />)

    const img = container.querySelector('img.msg-image')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('src')).toBe('https://example.com/a.png')
  })

  it('renders an unsupported relative path as fallback text (no broken <img>)', () => {
    const { container } = render(<Markdown text={'![plan-card-overlay](/api/placeholder)'} />)

    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('[image: plan-card-overlay — /api/placeholder]')
    const fallback = container.querySelector('.md-image-fallback')
    expect(fallback).not.toBeNull()
  })

  it('renders an unsupported src without alt without a double colon', () => {
    const { container } = render(<Markdown text={'![](/api/placeholder)'} />)

    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('[image — /api/placeholder]')
  })

  it('keeps link sanitisation intact (javascript: href still neutralised)', () => {
    const { container } = render(<Markdown text={'[click](javascript:alert(1))'} />)

    const a = container.querySelector('a')
    expect(a).not.toBeNull()
    // defaultUrlTransform strips the unsafe scheme to ''.
    expect(a?.getAttribute('href')).toBe('')
  })
})
