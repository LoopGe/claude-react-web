import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { AppearancePanel } from './AppearancePanel'
import { expectPortaledToBody } from './portal-test-utils'
import type { BackgroundSetting } from '../theme'

const noBg: BackgroundSetting = { pref: { kind: 'none' }, opacity: 0.85 }

function renderPanel(skin: 'default' | 'glow' | 'anthropic' | 'hc' | 'soft-hc') {
  return render(
    <AppearancePanel
      skin={skin}
      mode="dark"
      accentColor="#7b8cde"
      onSkin={() => {}}
      onMode={() => {}}
      onAccent={() => {}}
      background={noBg}
      onBackgroundChange={() => {}}
    />,
  )
}

async function openPanel() {
  fireEvent.click(screen.getByRole('button', { name: 'Theme' }))
  await screen.findByRole('dialog', { name: 'Theme' })
}

describe('AppearancePanel background section', () => {
  afterEach(() => cleanup())

  it('shows the Background section for default skin', async () => {
    renderPanel('default')
    await openPanel()
    expect(screen.getByText('Background')).toBeTruthy()
  })
  it('shows the Background section for glow skin', async () => {
    renderPanel('glow')
    await openPanel()
    expect(screen.getByText('Background')).toBeTruthy()
  })
  it('hides the Background section for hc / anthropic / soft-hc', async () => {
    for (const skin of ['anthropic', 'hc', 'soft-hc'] as const) {
      const { unmount } = renderPanel(skin)
      await openPanel()
      expect(screen.queryByText('Background')).toBeNull()
      unmount()
    }
  })

  it('portals to <body> and stamps the marker so the wallpaper remap reaches the panel', async () => {
    // The panel's own fill is the fixed --glass-surface-bg frost, but the skin
    // cards, accent rows and inputs inside read --bg-elev*, so without the
    // marker they stay opaque while the rest of the chrome dims.
    const { container } = renderPanel('default')
    await openPanel()
    expectPortaledToBody(container, '.appearance-panel')
  })
})

describe('AppearancePanel trigger toggle', () => {
  it('closes on a second click of the Theme button — full mousedown → mouseup → click', async () => {
    // The Theme button is a toggle, so it must be exempt from the outside-press
    // dismissal: a real click always sends mousedown first, and closing on that
    // would unmount the panel before the click lands — the click would then
    // read the stale open=false and re-anchor, so the panel flickered shut and
    // open and the button could never close it. (`fireEvent.click` alone cannot
    // catch this: it dispatches no mousedown.)
    renderPanel('default')
    const trigger = () => screen.getByRole('button', { name: 'Theme' })
    const fullClick = () => {
      fireEvent.mouseDown(trigger())
      fireEvent.mouseUp(trigger())
      fireEvent.click(trigger())
    }

    await openPanel()
    fullClick()
    expect(screen.queryByRole('dialog', { name: 'Theme' })).toBeNull()
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
  })

  it('still closes on a press elsewhere', async () => {
    renderPanel('default')
    await openPanel()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('dialog', { name: 'Theme' })).toBeNull()
  })
})
