import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, waitFor } from '@testing-library/react'
import { AnimatePresence } from 'motion/react'
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

  it('keeps the window mounted through the exit animation, then unmounts (AnimatePresence)', async () => {
    // Open/close motion is now driven by motion.div + AnimatePresence (the
    // old isExiting/data-state="closing" prop is gone). This is a smoke test
    // that AnimatePresence retains the node while exiting and removes it
    // after. motion's rAF JS-animation loop runs under jsdom (no WAAPI), so
    // we wait on real timers for the 120ms exit to settle.
    function Harness({ open }: { open: boolean }) {
      return (
        <AnimatePresence>
          {open && <RecapWindow key="recap" recap={readyRecap()} onClose={() => {}} />}
        </AnimatePresence>
      )
    }
    const { container, rerender } = render(<Harness open={true} />)
    expect(container.querySelector('.recap-window')).not.toBeNull()

    rerender(<Harness open={false} />)

    // AnimatePresence must RETAIN the node while the exit animation plays —
    // asserting this (not just the eventual unmount) guards against motion
    // short-circuiting the exit in jsdom and unmounting instantly, which
    // would make the waitFor below pass for the wrong reason.
    expect(container.querySelector('.recap-window')).not.toBeNull()

    await waitFor(() => {
      expect(container.querySelector('.recap-window')).toBeNull()
    })
  })
})
