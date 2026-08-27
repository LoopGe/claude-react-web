import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ModelPicker } from './ModelPicker'
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
    anchor: { x: 0, y: 0 },
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
})
