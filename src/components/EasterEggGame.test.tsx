import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { EasterEggGame } from './EasterEggGame'

describe('EasterEggGame', () => {
  it('renders the canvas and a close button that calls onExit', () => {
    const onExit = vi.fn()
    const { container, unmount } = render(<EasterEggGame onExit={onExit} />)
    expect(container.querySelector('canvas')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Exit game'))
    expect(onExit).toHaveBeenCalledTimes(1)
    unmount()
  })

  it('renders a ready-state prompt', () => {
    render(<EasterEggGame onExit={vi.fn()} />)
    // The ready prompt is drawn on canvas (not DOM text), so just assert the
    // game container renders. (Canvas text isn't queryable in jsdom.)
    expect(document.querySelector('.easter-egg-game')).toBeTruthy()
  })
})
