import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AccentPicker } from './AccentPicker'
import { expectPortaledToBody } from './portal-test-utils'

describe('AccentPicker portalling', () => {
  it('portals the popover to <body> and stamps the marker', () => {
    // The popover's own fill reads --glass-surface-bg (fixed frost), but its
    // interior — swatch rows, the custom-colour field — reads --bg-elev*, so
    // the marker is what keeps those tracking the Content slider.
    const { container } = render(<AccentPicker value="#7b8cde" onChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Accent colour' }))
    expectPortaledToBody(container, '.accent-popover')
  })
})

describe('AccentPicker trigger toggle', () => {
  const trigger = () => screen.getByRole('button', { name: 'Accent colour' })

  it('closes on a second click of the trigger — full mousedown → mouseup → click', () => {
    // The trigger is a toggle, so it must be exempt from the outside-press
    // dismissal: a real click always sends mousedown first, and closing on
    // that would unmount the panel before the click lands — the click would
    // then read the stale open=false and re-anchor, so the panel flickered
    // shut and open and the trigger could never dismiss its own popover.
    // (`fireEvent.click` alone cannot catch this: it dispatches no mousedown.)
    render(<AccentPicker value="#7b8cde" onChange={() => {}} />)
    const fullClick = () => {
      fireEvent.mouseDown(trigger())
      fireEvent.mouseUp(trigger())
      fireEvent.click(trigger())
    }

    fullClick()
    expect(document.querySelector('.accent-popover')).not.toBeNull()

    fullClick()
    expect(document.querySelector('.accent-popover')).toBeNull()
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
  })

  it('still closes on a press elsewhere', () => {
    render(<AccentPicker value="#7b8cde" onChange={() => {}} />)
    fireEvent.click(trigger())
    expect(document.querySelector('.accent-popover')).not.toBeNull()
    fireEvent.mouseDown(document.body)
    expect(document.querySelector('.accent-popover')).toBeNull()
  })
})
