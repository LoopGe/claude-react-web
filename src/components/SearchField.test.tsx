import { createRef } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SearchField } from './SearchField'

function renderField(
  overrides: Partial<Parameters<typeof SearchField>[0]> = {},
) {
  const inputRef = createRef<HTMLInputElement>()
  const onChange = vi.fn()
  const utils = render(
    <SearchField
      value="needle"
      onChange={onChange}
      placeholder="Search things…"
      ariaLabel="Search things"
      wrapperClassName="test-search"
      inputClassName="test-search-input"
      inputRef={inputRef}
      {...overrides}
    />,
  )
  return { ...utils, inputRef, onChange }
}

describe('SearchField', () => {
  it('renders a search icon, input, and clear button', () => {
    const { container } = renderField()

    expect(screen.getByRole('textbox').getAttribute('placeholder')).toBe('Search things…')
    expect(screen.getByRole('button', { name: 'Clear search' })).toBeTruthy()
    expect(container.querySelector('.test-search svg')).toBeTruthy()
  })

  it('hides the clear button when empty or opted out', () => {
    const empty = renderField({ value: '' })
    expect(empty.queryByRole('button', { name: 'Clear search' })).toBeNull()
    empty.unmount()

    renderField({ showClear: false })
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull()
  })

  it('clears through onChange and returns focus to the input', () => {
    const { onChange, inputRef } = renderField()

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))

    expect(onChange).toHaveBeenCalledWith('')
    expect(document.activeElement).toBe(inputRef.current)
  })

  it('forwards aria wiring to the input', () => {
    renderField({
      ariaControls: 'pick-list',
      ariaActiveDescendant: 'pick-list-option-2',
      ariaAutocomplete: 'list',
    })
    const input = screen.getByRole('textbox')

    expect(input.getAttribute('aria-controls')).toBe('pick-list')
    expect(input.getAttribute('aria-activedescendant')).toBe('pick-list-option-2')
    expect(input.getAttribute('aria-autocomplete')).toBe('list')
  })

  it('applies the shared input defaults and the caller class', () => {
    renderField()
    const input = screen.getByRole('textbox')

    expect(input.getAttribute('type')).toBe('text')
    expect(input.getAttribute('spellcheck')).toBe('false')
    expect(input.getAttribute('autocomplete')).toBe('off')
    expect(input.className).toBe('test-search-input')
  })

  it('disables both the input and the clear button', () => {
    renderField({ disabled: true })

    expect((screen.getByRole('textbox') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Clear search' }) as HTMLButtonElement).disabled).toBe(true)
  })
})