// Verifies ToolResultDetails renders image blocks in a tool_result payload
// as real <img>s (so agent screenshots like mcp__chrome-devtools__take_screenshot
// show up instead of a base64 JSON blob), while still joining + truncating the
// text blocks. Runs in jsdom (src/** .tsx).

import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { ToolResultDetails } from './ToolCard'

afterEach(() => cleanup())

describe('ToolResultDetails images', () => {
  it('renders a text + image result as text and an <img>', () => {
    const content = [
      { type: 'text', text: 'screenshot taken' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
    ]
    const { container } = render(<ToolResultDetails content={content} />)

    const img = container.querySelector('img.msg-image')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('src')).toBe('data:image/jpeg;base64,AAAA')
    // The text part still renders.
    expect(container.textContent).toContain('screenshot taken')
    // Images are wrapped in the result-images row.
    expect(container.querySelector('.tool-result-images')).not.toBeNull()
  })

  it('renders an image-only result as just the <img> (no JSON dump)', () => {
    const content = [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BBBB' } },
    ]
    const { container } = render(<ToolResultDetails content={content} />)

    const img = container.querySelector('img.msg-image')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('src')).toBe('data:image/png;base64,BBBB')
    // The raw base64 must not leak into the rendered text (no formatJson dump).
    expect(container.textContent).not.toContain('BBBB')
  })

  it('handles a single image-block object (not wrapped in an array)', () => {
    const content = { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'CCCC' } }
    const { container } = render(<ToolResultDetails content={content} />)

    const img = container.querySelector('img.msg-image')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('src')).toBe('data:image/webp;base64,CCCC')
  })

  it('preserves block order for interleaved text + image results', () => {
    const content = [
      { type: 'text', text: 'before' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'DDDD' } },
      { type: 'text', text: 'after' },
    ]
    const { container } = render(<ToolResultDetails content={content} />)

    const html = container.innerHTML
    const imgAt = html.indexOf('<img')
    expect(imgAt).toBeGreaterThan(html.indexOf('before'))
    expect(html.indexOf('after')).toBeGreaterThan(imgAt)
  })

  it('keeps invalid image blocks in the text fallback (no <img>)', () => {
    const content = [{ type: 'image', source: { type: 'url', url: 'http://x' } }]
    const { container } = render(<ToolResultDetails content={content} />)

    expect(container.querySelector('img.msg-image')).toBeNull()
    // The invalid block degrades to JSON text (existing behavior).
    expect(container.textContent).toContain('image')
  })

  it('does not crash on a null element in the content array', () => {
    const content = [null, { type: 'text', text: 'survived' }]
    const { container } = render(<ToolResultDetails content={content} />)

    expect(container.textContent).toContain('survived')
  })
})
