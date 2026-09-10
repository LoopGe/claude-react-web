import { describe, it, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { EffortSlider } from './EffortSlider'
import { expectPortaledToBody } from './portal-test-utils'

describe('EffortSlider portalling', () => {
  afterEach(() => cleanup())

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
