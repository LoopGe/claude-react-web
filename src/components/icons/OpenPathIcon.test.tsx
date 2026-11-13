// Unit tests for OpenPathIcon — the OS-glyph renderer for the two system
// open-path targets. It serves the server's extracted real icon via <img>
// and falls back to the caller's generic SVG when the extraction does not
// exist (404) or the route is unreachable (403/transport) — the fallback is
// the documented contract for "no icon on this machine/client pairing", not
// a degraded state.

import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { useState } from 'react'
import { OpenPathIcon } from './OpenPathIcon'

afterEach(() => {
  cleanup()
})

/** Harness that re-renders after the swap so the fallback outcome is
 *  observable through the DOM (an outer-variable assignment during render
 *  would violate the render-purity rules). */
function Glyph() {
  const [, bump] = useState(0)
  return (
    <div data-testid="wrap" onClick={() => bump((n) => n + 1)}>
      <OpenPathIcon target="finder" fallback={<svg data-testid="fallback" />} />
    </div>
  )
}

describe('OpenPathIcon', () => {
  it('renders an img of the extracted icon route at the requested size', () => {
    const { container } = render(<OpenPathIcon target="terminal" size={14} fallback={<span />} />)
    const img = container.querySelector('img')!
    expect(img.getAttribute('src')).toBe('/api/open-path/icons/terminal')
    expect(img.getAttribute('width')).toBe('14')
    expect(img.getAttribute('height')).toBe('14')
    expect(img.getAttribute('aria-hidden')).toBe('true')
  })

  it('swaps to the fallback when the icon route fails (404/403/transport)', () => {
    const { container } = render(<Glyph />)
    expect(container.querySelector('img')).not.toBeNull()
    fireEvent.error(container.querySelector('img')!)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('[data-testid="fallback"]')).not.toBeNull()
  })

  it('does not re-fire error handling after swapping (state latches)', () => {
    const { container } = render(<Glyph />)
    const img = container.querySelector('img')!
    fireEvent.error(img)
    fireEvent.error(img) // the img is gone; no further handling possible
    expect(container.querySelector('[data-testid="fallback"]')).not.toBeNull()
  })
})
