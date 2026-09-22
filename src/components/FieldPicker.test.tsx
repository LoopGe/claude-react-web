import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { FieldPicker } from './FieldPicker'

function setup(overrides: Partial<ComponentProps<typeof FieldPicker>> = {}) {
  const onSelectA = vi.fn()
  const onSelectB = vi.fn()
  const onForgetB = vi.fn()
  const props: ComponentProps<typeof FieldPicker> = {
    id: 'field',
    label: 'claude-sonnet',
    placeholder: 'Choose one',
    menuLabel: 'Models',
    searchLabel: 'Search models',
    searchable: true,
    options: [
      { key: 'a', label: 'claude-sonnet', sub: 'sonnet', selected: true, onSelect: onSelectA },
      { key: 'b', label: 'claude-opus', onForget: onForgetB, onSelect: onSelectB },
    ],
    ...overrides,
  }
  render(<FieldPicker {...props} />)
  return { props, onSelectA, onSelectB, onForgetB }
}

const trigger = () => document.querySelector('.field-picker-trigger') as HTMLButtonElement
const menu = () => document.querySelector('.field-picker-menu')
const items = () => Array.from(document.querySelectorAll('.field-picker-item')) as HTMLButtonElement[]
const searchBox = () => screen.getByRole('textbox', { name: 'Search models' })

describe('FieldPicker', () => {
  it('renders the label on the trigger and a placeholder when empty', () => {
    setup({ label: '', placeholder: 'Choose one' })
    expect(trigger().textContent).toContain('Choose one')
  })

  it('renders a sub label on the trigger', () => {
    setup({ label: 'claude-sonnet', sub: 'default' })
    expect(trigger().textContent).toContain('claude-sonnet')
    expect(trigger().textContent).toContain('default')
  })

  it('opens the menu listing every option', () => {
    setup()
    expect(menu()).toBeNull()
    fireEvent.click(trigger())
    expect(menu()).toBeTruthy()
    expect(items().map((el) => el.textContent)).toEqual([
      expect.stringContaining('claude-sonnet'),
      expect.stringContaining('claude-opus'),
    ])
  })

  it('marks the selected option with a check', () => {
    setup()
    fireEvent.click(trigger())
    const checks = document.querySelectorAll('.field-picker-check')
    expect(checks).toHaveLength(1)
    expect(items()[0].querySelector('.field-picker-check')).toBeTruthy()
  })

  it('filters options by search text', () => {
    setup()
    fireEvent.click(trigger())
    fireEvent.change(searchBox(), { target: { value: 'opus' } })
    expect(items()).toHaveLength(1)
    expect(items()[0].textContent).toContain('claude-opus')
  })

  it('hides the search box when searchable is false', () => {
    setup({ searchable: false })
    fireEvent.click(trigger())
    expect(document.querySelector('.field-picker-search')).toBeNull()
    expect(items()).toHaveLength(2)
  })

  it('selects an option and closes', () => {
    const { onSelectB } = setup()
    fireEvent.click(trigger())
    fireEvent.click(items()[1])
    expect(onSelectB).toHaveBeenCalled()
    expect(menu()).toBeNull()
  })

  it('forgets an option without selecting it', () => {
    const { onSelectB, onForgetB } = setup()
    fireEvent.click(trigger())
    const forgetButtons = document.querySelectorAll('.field-picker-forget')
    fireEvent.click(forgetButtons[0])
    expect(onForgetB).toHaveBeenCalled()
    expect(onSelectB).not.toHaveBeenCalled()
  })

  it('closes on Escape', () => {
    setup()
    fireEvent.click(trigger())
    fireEvent.keyDown(searchBox(), { key: 'Escape' })
    expect(menu()).toBeNull()
  })

  it('moves the highlight with arrow keys and selects with Enter', () => {
    const { onSelectB } = setup()
    fireEvent.click(trigger())
    fireEvent.keyDown(searchBox(), { key: 'ArrowDown' })
    fireEvent.keyDown(searchBox(), { key: 'Enter' })
    expect(onSelectB).toHaveBeenCalled()
  })

  it('appends a custom option last for the current query', () => {
    const onSelectCustom = vi.fn()
    setup({
      customOption: (q) =>
        q.trim()
          ? { key: 'custom', label: `Use “${q.trim()}”`, sub: 'custom', onSelect: onSelectCustom }
          : null,
    })
    fireEvent.click(trigger())
    fireEvent.change(searchBox(), { target: { value: 'gpt-5' } })
    // Last, not first — so Enter after a filter hits the real match.
    const last = items()[items().length - 1]
    expect(last.textContent).toContain('Use “gpt-5”')
    fireEvent.click(last)
    expect(onSelectCustom).toHaveBeenCalled()
    expect(menu()).toBeNull()
  })

  it('renders an option icon when provided', () => {
    setup({
      options: [{ key: 'a', label: 'Plan mode', icon: <span data-testid="opt-icon" />, onSelect: vi.fn() }],
    })
    fireEvent.click(trigger())
    expect(screen.getByTestId('opt-icon')).toBeTruthy()
  })

  it('renders a section heading on the first row of a group', () => {
    setup({
      options: [
        { key: 'g1', label: 'Balanced', heading: 'Model Groups', onSelect: vi.fn() },
        { key: 'g2', label: 'Fast', onSelect: vi.fn() },
      ],
    })
    fireEvent.click(trigger())
    const headings = Array.from(document.querySelectorAll('.field-picker-heading'))
    expect(headings).toHaveLength(1)
    expect(headings[0].textContent).toBe('Model Groups')
  })
})
