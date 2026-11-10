import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { NewerHistoryFloat } from './message-list/transcript-chrome'

describe('NewerHistoryFloat', () => {
  it('shows the waiting count and returns to head on click', () => {
    const onReturn = vi.fn()
    render(<NewerHistoryFloat count={3} onReturn={onReturn} />)
    fireEvent.click(screen.getByRole('button', { name: /3 new messages/ }))
    expect(onReturn).toHaveBeenCalledTimes(1)
  })

  it('renders nothing when no newer messages are waiting', () => {
    const { container } = render(<NewerHistoryFloat count={0} onReturn={vi.fn()} />)
    expect(container.firstChild).toBeNull()
  })
})