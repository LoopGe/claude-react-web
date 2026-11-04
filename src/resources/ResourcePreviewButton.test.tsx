// @vitest-environment happy-dom
// Header resource-preview button: hidden without tabs, badge count, and a
// toggle over the focused session's store state.

import { describe, it, expect } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ResourcePaneProvider } from './ResourcePaneProvider'
import { ResourcePreviewButton } from './ResourcePreviewButton'
import { useOpenResource } from './context'
import { fileResource } from '../../shared/resource-address'
import type { ResourceProvider } from './registry'

const A = fileResource('s1', '/repo/a.ts')

function fileProvider(): ResourceProvider {
  return {
    protocol: 'file',
    async *open() {
      yield { ok: true, value: { available: true, contents: 'x' } }
    },
  }
}

function Harness({ sessionId }: { sessionId: string | null }) {
  const open = useOpenResource()
  return (
    <>
      <button type="button" onClick={() => open('s1', A)}>
        open-file
      </button>
      <ResourcePreviewButton sessionId={sessionId} />
    </>
  )
}

describe('ResourcePreviewButton', () => {
  it('renders an enabled control with no tabs (click is a no-op)', () => {
    render(
      <ResourcePaneProvider providers={[fileProvider()]}>
        <Harness sessionId="s1" />
      </ResourcePaneProvider>,
    )
    const button = screen.getByRole('button', { name: 'Show resource preview' })
    expect((button as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(button)
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(screen.queryByRole('tablist')).toBeNull()
  })

  it('renders nothing for an unfocused panel (null session)', () => {
    render(
      <ResourcePaneProvider providers={[fileProvider()]}>
        <Harness sessionId={null} />
      </ResourcePaneProvider>,
    )
    fireEvent.click(screen.getByText('open-file'))
    expect(screen.queryByRole('button', { name: /resource preview/i })).toBeNull()
  })

  it('shows the tab count and toggles the preview', async () => {
    render(
      <ResourcePaneProvider providers={[fileProvider()]}>
        <Harness sessionId="s1" />
      </ResourcePaneProvider>,
    )
    fireEvent.click(screen.getByText('open-file'))
    const hide = await screen.findByRole('button', { name: /hide resource preview/i })
    expect(document.querySelector('.resource-preview-count')?.textContent).toBe('1')

    fireEvent.click(hide)
    const show = await screen.findByRole('button', { name: /show resource preview/i })
    expect(show.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(show)
    expect(await screen.findByRole('button', { name: /hide resource preview/i })).toBeTruthy()
  })
})