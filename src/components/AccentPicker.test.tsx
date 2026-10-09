import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AccentSwatchGrid } from './AccentPicker'
import { ACCENT_COLORS } from '../theme'

describe('AccentSwatchGrid', () => {
  it('selects a preset and reports it through onChange', () => {
    const onChange = vi.fn()
    render(<AccentSwatchGrid value={undefined} onChange={onChange} />)
    fireEvent.click(screen.getByRole('radio', { name: ACCENT_COLORS[0].name }))
    expect(onChange).toHaveBeenCalledWith(ACCENT_COLORS[0].accent)
  })

  it('with allowDefault, offers the global-default swatch and reports undefined', () => {
    const onChange = vi.fn()
    render(<AccentSwatchGrid value="#7b8cde" onChange={onChange} allowDefault />)
    fireEvent.click(screen.getByRole('radio', { name: 'Use global accent' }))
    expect(onChange).toHaveBeenCalledWith(undefined)
  })

  it('marks the active preset as checked', () => {
    render(<AccentSwatchGrid value={ACCENT_COLORS[1].accent} onChange={() => {}} />)
    expect(screen.getByRole('radio', { name: ACCENT_COLORS[1].name }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('radio', { name: ACCENT_COLORS[0].name }).getAttribute('aria-checked')).toBe('false')
  })
})
