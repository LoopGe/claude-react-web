import { describe, it, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { AccentPicker } from './AccentPicker'
import { expectPortaledToBody } from './portal-test-utils'

describe('AccentPicker portalling', () => {
  afterEach(() => cleanup())

  it('portals the popover to <body> and stamps the marker', () => {
    // The popover's own fill reads --glass-surface-bg (fixed frost), but its
    // interior — swatch rows, the custom-colour field — reads --bg-elev*, so
    // the marker is what keeps those tracking the Content slider.
    const { container } = render(<AccentPicker value="#7b8cde" onChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Accent colour' }))
    expectPortaledToBody(container, '.accent-popover')
  })
})
