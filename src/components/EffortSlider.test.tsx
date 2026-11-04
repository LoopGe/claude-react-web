import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { EffortSlider } from './EffortSlider'
import { expectPortaledToBody } from './portal-test-utils'

describe('EffortSlider portalling', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('places an above-placed slider using its measured height', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 240,
      height: 120,
      top: 0,
      left: 0,
      right: 240,
      bottom: 120,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect)
    render(
      <EffortSlider
        anchor={{ x: 20, y: 400 }}
        placement="above"
        levels={['low', 'high']}
        current="low"
        onSelect={() => {}}
        onClose={() => {}}
      />,
    )
    const slider = document.querySelector<HTMLElement>('.effort-slider')!
    expect(slider.style.left).toBe('20px')
    expect(slider.style.top).toBe('280px')
  })

  it('portals to <body> and stamps the marker so the wallpaper remap reaches the slider', () => {
    // The slider is NOT a glass surface: it paints its own fill from
    // --bg-elev, so the [data-portaled] remap is what makes the whole control
    // (panel, track, thumb outline) follow the Content slider instead of
    // staying an opaque block over an active wallpaper.
    const { container } = render(
      <EffortSlider
        anchor={{ x: 20, y: 20 }}
        levels={['low', 'high']}
        current="low"
        onSelect={() => {}}
        onClose={() => {}}
      />,
    )
    expectPortaledToBody(container, '.effort-slider')
  })
})
