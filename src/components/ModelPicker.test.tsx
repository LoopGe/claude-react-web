import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ModelPicker } from './ModelPicker'
import { expectPortaledToBody } from './portal-test-utils'
import type { ModelOptions } from '../hooks/useModelOptions'

// Stub scrollIntoView — jsdom lacks it.
Element.prototype.scrollIntoView = vi.fn()

afterEach(() => cleanup())

function makeProps(overrides: Partial<Parameters<typeof ModelPicker>[0]> = {}) {
  const options: ModelOptions = {
    models: [{ id: 'm1' }, { id: 'm2' }],
    recents: [],
    defaultModel: 'm1',
    modelGroups: [
      { id: 'g1', name: 'Flagship', opus: 'm1', sonnet: 'm2', main: 'opus' },
      { id: 'g2', name: 'Budget', haiku: 'm2', main: 'haiku' },
    ],
  }
  return {
    // `source: null` = no anchor element, i.e. nothing to carry an accent from.
    anchor: { x: 0, y: 0, source: null },
    current: undefined,
    currentGroupId: undefined,
    options,
    onSelect: vi.fn(),
    onSelectGroup: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
}

describe('ModelPicker', () => {
  it('renders a Model Groups group before Models', () => {
    render(<ModelPicker {...makeProps()} />)
    expect(screen.getByText('Model Groups')).toBeTruthy()
    fireEvent.click(screen.getByText('Flagship'))
    expect(screen.getByText('Models')).toBeTruthy()
  })

  it('calls onSelectGroup with the group id', () => {
    const props = makeProps()
    render(<ModelPicker {...props} />)
    fireEvent.click(screen.getByText('Budget'))
    expect(props.onSelectGroup).toHaveBeenCalledWith('g2')
  })

  it('marks the active group row', () => {
    const props = makeProps({ currentGroupId: 'g1' })
    render(<ModelPicker {...props} />)
    const item = screen.getByText('Flagship').closest('button')
    expect(item?.className).toContain('active')
  })

  it('portals to <body> so its viewport anchor is honoured', () => {
    const { container } = render(<ModelPicker {...makeProps()} />)
    expectPortaledToBody(container, '.model-picker')
  })

  it('dismisses on an outside mousedown but not on one inside the portalled list', () => {
    // Same seam the portal moved: the dismissal listener is on `window`, and
    // staying open depends on the root's onMouseDown stopPropagation — now
    // delegated at <body> rather than inside the panel.
    const props = makeProps()
    render(<ModelPicker {...props} />)

    fireEvent.mouseDown(document.querySelector('.model-picker-input')!)
    fireEvent.mouseDown(document.querySelector('.model-picker-item')!)
    expect(props.onClose).not.toHaveBeenCalled()

    fireEvent.mouseDown(document.documentElement)
    expect(props.onClose).toHaveBeenCalledOnce()
  })

  it('carries the session accent onto the portalled root and records its owner', () => {
    // Portalling leaves behind the container that declares `--accent`
    // (buildSessionAccentMap writes it inline on .chat-panel), so without the
    // carry the picker's active row silently reverts to the global accent. The
    // marker's VALUE is the owning panel id, which is what lets a per-panel
    // consumer (EasterEggGame) tell this panel's popover from a sibling's.
    const panel = document.createElement('div')
    panel.className = 'chat-panel'
    panel.setAttribute('data-panel-id', 'sess-1')
    panel.style.setProperty('--accent', 'rgb(255, 102, 204)')
    const chip = document.createElement('button')
    panel.appendChild(chip)
    document.body.appendChild(panel)
    try {
      render(<ModelPicker {...makeProps({ anchor: { x: 0, y: 0, source: chip } })} />)
      const picker = document.querySelector('.model-picker') as HTMLElement
      expect(picker.style.getPropertyValue('--accent')).toBe('rgb(255, 102, 204)')
      expect(picker.getAttribute('data-portaled')).toBe('sess-1')
    } finally {
      panel.remove()
    }
  })

  it('stamps the marker but writes no accent snapshot for an un-tinted panel', () => {
    // All three properties are ALSO declared on :root, so reading them through
    // getComputedStyle would never come back empty and would freeze :root's
    // value onto every un-tinted popover. Inline-only is what keeps those on the
    // live cascade.
    const panel = document.createElement('div')
    panel.className = 'chat-panel'
    const chip = document.createElement('button')
    panel.appendChild(chip)
    document.body.appendChild(panel)
    try {
      render(<ModelPicker {...makeProps({ anchor: { x: 0, y: 0, source: chip } })} />)
      const picker = document.querySelector('.model-picker') as HTMLElement
      expect(picker.style.getPropertyValue('--accent')).toBe('')
      // Marked (so the fill remap applies), with no owning panel id to record.
      expect(picker.getAttribute('data-portaled')).toBe('')
    } finally {
      panel.remove()
    }
  })
})
