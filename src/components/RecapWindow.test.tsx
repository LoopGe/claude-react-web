import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { RecapWindow } from './RecapWindow'
import type { SessionRecap } from '../../shared/session-info'

// vitest runs with `globals: false`, so @testing-library/react's auto-cleanup
// never registers. Tear down between tests to avoid leaked DOM/listeners.
afterEach(() => {
  cleanup()
})

function readyRecap(): SessionRecap {
  return {
    status: 'ready',
    summary: 'Worked on the recap clear animation.',
    stats: {
      messageCount: 4,
      userTurns: 2,
      assistantTurns: 2,
      totalCostUsd: 0.01,
      durationMs: 1000,
      toolsUsed: ['Edit'],
    },
    generatedAt: 1,
  }
}

describe('RecapWindow', () => {
  it('does not carry the clearing class by default', () => {
    const { container } = render(<RecapWindow recap={readyRecap()} onClose={() => {}} />)
    const root = container.querySelector('.recap-window')
    expect(root?.className).not.toContain('recap-window-clearing')
  })

  it('applies the clearing class while a /clear is in flight so it reuses the transcript blur-fade', () => {
    const { container } = render(
      <RecapWindow recap={readyRecap()} clearing onClose={() => {}} />,
    )
    const root = container.querySelector('.recap-window')
    expect(root?.className).toContain('recap-window-clearing')
  })

  it('still drives data-state="closing" from isExiting independently of clearing', () => {
    const { container } = render(
      <RecapWindow recap={readyRecap()} clearing isExiting onClose={() => {}} />,
    )
    const root = container.querySelector('.recap-window')
    // clearing drives the blur-fade class; isExiting still marks the closing state.
    expect(root?.className).toContain('recap-window-clearing')
    expect(root?.getAttribute('data-state')).toBe('closing')
  })
})
