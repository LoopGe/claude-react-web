import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import { AppearancePanel } from './AppearancePanel'
import { expectPortaledToBody } from './portal-test-utils'
import type { BackgroundSetting } from '../theme'

const noBg: BackgroundSetting = { pref: { kind: 'none' }, opacity: 0.85 }

/** Non-default values (none equals the shipped default) so a control
 *  rendering a hardcoded default can't pass. */
const DISPLAY_PREFS = {
  rowGap: 'airy',
  textSpacing: 'comfortable',
  fontSize: 'large',
  animationSpeed: 'fast',
} as const

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
      displayPrefs={DISPLAY_PREFS}
      onDisplayPrefChange={() => {}}
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

describe('AppearancePanel display presets', () => {
  /** aria-checked of one option inside a named radiogroup. */
  const activeIn = (group: string, option: string) =>
    within(screen.getByRole('radiogroup', { name: group }))
      .getByRole('radio', { name: option })
      .getAttribute('aria-checked')

  it('renders the four preset groups reflecting displayPrefs', async () => {
    renderPanel('default')
    await openPanel()

    expect(activeIn('Transcript spacing', 'Airy')).toBe('true')
    expect(activeIn('Message text density', 'Comfortable')).toBe('true')
    expect(activeIn('Font size', 'Large')).toBe('true')
    expect(activeIn('Animation speed', 'Fast')).toBe('true')
  })

  it('renders only the control titles, not the explanatory hints', async () => {
    renderPanel('default')
    await openPanel()

    expect(screen.getByText('Transcript spacing')).toBeTruthy()
    expect(screen.queryByText(/Vertical rhythm between message rows/)).toBeNull()
  })

  it('emits the field-specific patch for each preset group', async () => {
    const onDisplayPrefChange = vi.fn()
    render(
      <AppearancePanel
        skin="default"
        mode="dark"
        accentColor="#7b8cde"
        onSkin={() => {}}
        onMode={() => {}}
        onAccent={() => {}}
        background={noBg}
        onBackgroundChange={() => {}}
        displayPrefs={DISPLAY_PREFS}
        onDisplayPrefChange={onDisplayPrefChange}
      />,
    )
    await openPanel()

    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Transcript spacing' }))
      .getByRole('radio', { name: 'Compact' }))
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Message text density' }))
      .getByRole('radio', { name: 'Compact' }))
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Font size' }))
      .getByRole('radio', { name: 'X-Large' }))
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Animation speed' }))
      .getByRole('radio', { name: 'Slow' }))

    expect(onDisplayPrefChange).toHaveBeenNthCalledWith(1, { rowGap: 'compact' })
    expect(onDisplayPrefChange).toHaveBeenNthCalledWith(2, { textSpacing: 'compact' })
    expect(onDisplayPrefChange).toHaveBeenNthCalledWith(3, { fontSize: 'xlarge' })
    expect(onDisplayPrefChange).toHaveBeenNthCalledWith(4, { animationSpeed: 'slow' })
  })

  it('offers Off as the fourth animation-speed option and emits it', async () => {
    const onDisplayPrefChange = vi.fn()
    render(
      <AppearancePanel
        skin="default"
        mode="dark"
        accentColor="#7b8cde"
        onSkin={() => {}}
        onMode={() => {}}
        onAccent={() => {}}
        background={noBg}
        onBackgroundChange={() => {}}
        displayPrefs={DISPLAY_PREFS}
        onDisplayPrefChange={onDisplayPrefChange}
      />,
    )
    await openPanel()

    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Animation speed' }))
      .getByRole('radio', { name: 'Off' }))

    expect(onDisplayPrefChange).toHaveBeenCalledWith({ animationSpeed: 'off' })
  })

  it('does not emit a patch when the already-active option is clicked', async () => {
    const onDisplayPrefChange = vi.fn()
    render(
      <AppearancePanel
        skin="default"
        mode="dark"
        accentColor="#7b8cde"
        onSkin={() => {}}
        onMode={() => {}}
        onAccent={() => {}}
        background={noBg}
        onBackgroundChange={() => {}}
        displayPrefs={DISPLAY_PREFS}
        onDisplayPrefChange={onDisplayPrefChange}
      />,
    )
    await openPanel()

    // 'Airy' is already active for DISPLAY_PREFS.rowGap; a re-click must not
    // trigger a no-op config write.
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Transcript spacing' }))
      .getByRole('radio', { name: 'Airy' }))

    expect(onDisplayPrefChange).not.toHaveBeenCalled()
  })
})

describe('AppearancePanel transparency toggle', () => {
  it('shows the Transparency section with the switch on by default', async () => {
    renderPanel('default')
    await openPanel()
    expect(screen.getByText('Transparency')).toBeTruthy()
    expect(screen.getByText('Frosted glass surfaces')).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'Frosted glass surfaces' }).getAttribute('aria-checked')).toBe('true')
  })

  it('shows the toggle on anthropic — its warm glass is still translucent', async () => {
    renderPanel('anthropic')
    await openPanel()
    expect(screen.getByText('Frosted glass surfaces')).toBeTruthy()
  })

  it('hides the toggle on hc / soft-hc — their glass is already opaque', async () => {
    for (const skin of ['hc', 'soft-hc'] as const) {
      const { unmount } = renderPanel(skin)
      await openPanel()
      expect(screen.queryByText('Frosted glass surfaces')).toBeNull()
      unmount()
    }
  })

  it('reports the next state when toggled', async () => {
    const onTransparency = vi.fn()
    render(
      <AppearancePanel
        skin="default"
        mode="dark"
        accentColor="#7b8cde"
        onSkin={() => {}}
        onMode={() => {}}
        onAccent={() => {}}
        background={noBg}
        onBackgroundChange={() => {}}
        displayPrefs={DISPLAY_PREFS}
        onDisplayPrefChange={() => {}}
        transparency
        onTransparency={onTransparency}
      />,
    )
    await openPanel()
    fireEvent.click(screen.getByRole('switch', { name: 'Frosted glass surfaces' }))
    expect(onTransparency).toHaveBeenCalledWith(false)
  })
})
