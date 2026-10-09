import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, waitFor } from '@testing-library/react'
import { AnimatePresence } from 'motion/react'
import { RecapWindow } from './RecapWindow'
import type { SessionRecap } from '../../shared/session-info'

// Cleanup is registered globally in src/test-setup.ts; the explicit hook here
// is redundant but harmless.
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

  it('indexes markdown blocks for the staggered reveal', () => {
    const { container } = render(
      <RecapWindow
        recap={{ ...readyRecap(), summary: 'First paragraph.\n\nSecond paragraph.' }}
        onClose={() => {}}
      />,
    )
    const blocks = container.querySelectorAll('.recap-reveal .md > *')
    expect(blocks.length).toBe(2)
    // The layout effect must have painted --i onto every block pre-paint —
    // the CSS stagger (animation-delay: calc(var(--i) * 45ms)) reads it.
    expect((blocks[0] as HTMLElement).style.getPropertyValue('--i')).toBe('0')
    expect((blocks[1] as HTMLElement).style.getPropertyValue('--i')).toBe('1')
  })

  it('remounts the body on a fresh generation so the reveal replays', () => {
    const { container, rerender } = render(<RecapWindow recap={readyRecap()} onClose={() => {}} />)
    const firstReveal = container.querySelector('.recap-reveal')
    expect(firstReveal).not.toBeNull()

    rerender(<RecapWindow recap={{ ...readyRecap(), generatedAt: 2 }} onClose={() => {}} />)

    // Same 'ready' status, new generatedAt — the body must have been
    // REMOUNTED (old wrapper disconnected), not patched in place: the
    // per-block reveal and the height tween both key off this remount.
    expect(firstReveal?.isConnected).toBe(false)
    const blocks = container.querySelectorAll('.recap-reveal .md > *')
    expect(blocks.length).toBeGreaterThan(0)
    expect((blocks[0] as HTMLElement).style.getPropertyValue('--i')).toBe('0')
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
