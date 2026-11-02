import { describe, it, expect, vi } from 'vitest'
import { act, render, fireEvent, screen } from '@testing-library/react'
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

  it('restores trigger focus when Escape closes the menu', () => {
    setup()
    fireEvent.click(trigger())
    const input = searchBox() as HTMLInputElement
    expect(document.activeElement).toBe(input)

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(trigger())
  })

  it('keeps the menu open on Safari blur but closes when focus leaves', () => {
    setup()
    fireEvent.click(trigger())
    const input = searchBox()
    fireEvent.focusOut(input, { relatedTarget: null })
    expect(menu()).toBeTruthy()

    const outside = document.createElement('button')
    document.body.appendChild(outside)
    fireEvent.focusOut(input, { relatedTarget: outside })
    expect(menu()).toBeNull()
    outside.remove()
  })

  it('ignores arrow navigation while composing with an IME', () => {
    setup()
    fireEvent.click(trigger())
    const input = searchBox()
    const before = input.getAttribute('aria-activedescendant')
    fireEvent.keyDown(
      input,
      new KeyboardEvent('keydown', { key: 'ArrowDown', isComposing: true, bubbles: true }),
    )
    expect(input.getAttribute('aria-activedescendant')).toBe(before)

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input.getAttribute('aria-activedescendant')).not.toBe(before)
  })

  it('chooses the active row for Enter on a menu button', () => {
    const { onSelectB } = setup()
    fireEvent.click(trigger())
    fireEvent.change(searchBox(), { target: { value: 'opus' } })
    const clear = screen.getByRole('button', { name: 'Clear search' })
    act(() => {
      clear.focus()
    })

    fireEvent.keyDown(clear, { key: 'Enter' })
    expect(onSelectB).toHaveBeenCalled()
  })

  it('focuses the list instead of a search box when searchable is false', () => {
    setup({ searchable: false })
    fireEvent.click(trigger())
    expect(document.activeElement).toBe(document.querySelector('.field-picker-list'))
  })

  it('positions the portaled menu above and caps its list when space below is tight', () => {
    const previousHeight = window.innerHeight
    Object.defineProperty(window, 'innerHeight', { value: 180, configurable: true })
    try {
      setup()
      const element = trigger()
      element.getBoundingClientRect = () =>
        ({
          left: 0,
          top: 100,
          right: 100,
          bottom: 116,
          width: 100,
          height: 16,
          x: 0,
          y: 100,
          toJSON: () => ({}),
        }) as DOMRect
      fireEvent.click(element)
      const menuElement = menu() as HTMLElement
      const list = document.querySelector('.field-picker-list') as HTMLElement
      Object.defineProperty(menuElement, 'offsetHeight', { value: 100, configurable: true })
      Object.defineProperty(list, 'offsetHeight', { value: 60, configurable: true })
      Object.defineProperty(list, 'scrollHeight', { value: 200, configurable: true })

      act(() => {
        window.dispatchEvent(new Event('resize'))
      })

      expect(menuElement.style.width).toBe('264px')
      expect(menuElement.style.left).toBe('8px')
      expect(menuElement.style.top).toBe('8px')
      expect(menuElement.style.getPropertyValue('--field-picker-list-max')).toBe('96px')
    } finally {
      Object.defineProperty(window, 'innerHeight', { value: previousHeight, configurable: true })
    }
  })

  it('keeps the field-picker id namespace when no id is provided', () => {
    setup({ id: undefined })
    fireEvent.click(trigger())
    expect(menu()?.id).toBe('field-picker-menu')
  })
})
