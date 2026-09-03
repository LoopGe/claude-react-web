import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { AppearancePanel } from './AppearancePanel'
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
  fireEvent.click(screen.getByRole('button', { name: 'Appearance' }))
  await screen.findByRole('dialog', { name: 'Appearance' })
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
})
