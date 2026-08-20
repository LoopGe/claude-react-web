import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Overlay } from './Overlay'
import { __resetForTests, getEscapeStackCount, useEscapeStack } from '../hooks/useEscapeStack'

// Conventions follow PanelOverlay.test.tsx: backdrop clicks are exercised via a
// native MouseEvent dispatch (fireEvent.mouseDown on the backdrop trips the
// focus-trap focusin→refocus chain into a jsdom stack overflow), and Escape via
// fireEvent.keyDown. matchMedia is stubbed for the exit-presence close path
// (prefersReducedMotion) and for motion mode (useReducedMotion at mount).

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  __resetForTests()
})

describe('Overlay', () => {
  it('renders backdrop > card as direct children with the variant class pair, no wrapper', () => {
    render(
      <Overlay variant="modal" open onClose={() => {}} ariaLabel="Test modal">
        <button>inside</button>
      </Overlay>,
    )
    const card = screen.getByRole('dialog', { name: 'Test modal' })
    expect(card.classList.contains('modal')).toBe(true)
    expect(card.getAttribute('aria-modal')).toBe('true')

    const backdrop = card.parentElement
    expect(backdrop?.classList.contains('modal-backdrop')).toBe(true)
    // The CSS contract: backdrop[data-state] > card, no wrapper in between.
    expect(backdrop?.firstElementChild).toBe(card)
    expect(backdrop?.children.length).toBe(1)
  })

  it('returns null when closed from the start (no keepMounted)', () => {
    render(
      <Overlay variant="modal" open={false} onClose={() => {}} ariaLabel="Test">
        <button>inside</button>
      </Overlay>,
    )
    expect(screen.queryByText('inside')).toBeNull()
  })

  it('transitions data-state open → closing on close (exit-presence close path)', () => {
    const { rerender } = render(
      <Overlay variant="modal" open onClose={() => {}} ariaLabel="Test">
        <button>inside</button>
      </Overlay>,
    )
    const card = screen.getByRole('dialog', { name: 'Test' })
    expect(card.parentElement?.getAttribute('data-state')).toBe('open')

    rerender(
      <Overlay variant="modal" open={false} onClose={() => {}} ariaLabel="Test">
        <button>inside</button>
      </Overlay>,
    )
    // Still mounted through the 180ms exit; data-state flips to closing.
    expect(screen.getByText('inside')).toBeDefined()
    expect(card.parentElement?.getAttribute('data-state')).toBe('closing')
  })

  it('calls onClose on a direct backdrop mousedown', () => {
    const onClose = vi.fn()
    render(
      <Overlay variant="modal" open onClose={onClose} ariaLabel="Test">
        <button>inside</button>
      </Overlay>,
    )
    const backdrop = screen.getByRole('dialog', { name: 'Test' }).parentElement!
    backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does NOT close when mousedown bubbles from inside the card', () => {
    const onClose = vi.fn()
    render(
      <Overlay variant="modal" open onClose={onClose} ariaLabel="Test">
        <button>inside</button>
      </Overlay>,
    )
    screen.getByText('inside').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does NOT close on backdrop mousedown when backdropDismiss=false', () => {
    const onClose = vi.fn()
    render(
      <Overlay variant="modal" open onClose={onClose} ariaLabel="Test" backdropDismiss={false}>
        <button>inside</button>
      </Overlay>,
    )
    const backdrop = screen.getByRole('dialog', { name: 'Test' }).parentElement!
    backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes on Escape via the escape stack', () => {
    const onClose = vi.fn()
    render(
      <Overlay variant="modal" open onClose={onClose} ariaLabel="Test">
        <button>inside</button>
      </Overlay>,
    )
    expect(getEscapeStackCount()).toBe(1)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('swallows Escape while busy (canCloseOnEscape false)', () => {
    const onClose = vi.fn()
    render(
      <Overlay variant="modal" open onClose={onClose} ariaLabel="Test" canCloseOnEscape={() => false}>
        <button>inside</button>
      </Overlay>,
    )
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('routes Escape to onEscape instead of onClose when escapeBehavior=custom', () => {
    const onClose = vi.fn()
    const onEscape = vi.fn()
    render(
      <Overlay variant="modal" open onClose={onClose} onEscape={onEscape} escapeBehavior="custom" ariaLabel="Test">
        <button>inside</button>
      </Overlay>,
    )
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onEscape).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('nests: one Esc closes only the topmost overlay, focus resolution intact', () => {
    const closeA = vi.fn()
    const closeB = vi.fn()
    render(
      <>
        <Overlay variant="modal" open onClose={closeA} ariaLabel="A">
          <button>a</button>
        </Overlay>
        <Overlay variant="modal" open onClose={closeB} ariaLabel="B">
          <button>b</button>
        </Overlay>
      </>,
    )
    // B's trap pulls focus into B's card — and A's trap must not steal it back
    // (the stack-aware focus exemption).
    const cardB = screen.getByRole('dialog', { name: 'B' })
    expect(document.activeElement).toBe(cardB)

    fireEvent.keyDown(cardB, { key: 'Escape' })
    expect(closeB).toHaveBeenCalledTimes(1)
    expect(closeA).not.toHaveBeenCalled()
  })

  it('does not let a parent trap steal focus from a portaled popover that focuses itself (register-before-focus)', () => {
    // Regression: the AccentPicker-over-NewSessionDialog bug. A popover that
    // moves focus into itself (its first swatch / search box) must be
    // registered in the escape stack BEFORE that focus lands — otherwise the
    // parent modal's trap observes the resulting focusin, sees
    // isFocusInsideOtherOverlay() false, steals focus back, and the Escape
    // dispatch then resolves by containment to the MODAL, closing the wrong
    // layer.
    const closeParent = vi.fn()
    const closeChild = vi.fn()

    function Popover() {
      const ref = useRef<HTMLDivElement>(null)
      // Registered first (useEscapeStack uses useLayoutEffect)…
      useEscapeStack({ active: true, onEscape: closeChild, getContainer: () => ref.current })
      // …then focus moves into the popover in a passive effect.
      useEffect(() => {
        ref.current?.querySelector<HTMLButtonElement>('button')?.focus()
      }, [])
      return createPortal(
        <div ref={ref} className="test-popover">
          <button>swatch</button>
        </div>,
        document.body,
      )
    }

    render(
      <>
        <Overlay variant="modal" open onClose={closeParent} ariaLabel="Parent">
          <button>inside</button>
        </Overlay>
        <Popover />
      </>,
    )

    // The popover's own focus effect must win — the parent trap must NOT yank
    // focus back into the modal.
    const swatch = screen.getByText('swatch')
    expect(document.activeElement).toBe(swatch)

    // Esc closes the popover (the layer holding focus), never the modal.
    fireEvent.keyDown(swatch, { key: 'Escape' })
    expect(closeChild).toHaveBeenCalledTimes(1)
    expect(closeParent).not.toHaveBeenCalled()
  })

  it('traps focus in the card by default, and releases it when trapFocus=false', () => {
    const first = render(
      <Overlay variant="modal" open onClose={() => {}} ariaLabel="Trapped">
        <button>inside</button>
      </Overlay>,
    )
    const card = screen.getByRole('dialog', { name: 'Trapped' })
    expect(document.activeElement).toBe(card)
    first.unmount()

    render(
      <Overlay variant="modal" open onClose={() => {}} ariaLabel="Untrapped" trapFocus={false}>
        <button>inside</button>
      </Overlay>,
    )
    expect(document.activeElement).not.toBe(screen.getByRole('dialog', { name: 'Untrapped' }))
  })

  it('keepMounted renders hidden + data-state=closed while closed, then un-hides on open', () => {
    // Queried by class: while closed the backdrop is aria-hidden="true", which
    // makes getByRole treat it as inaccessible — which is exactly the point.
    const { container, rerender } = render(
      <Overlay variant="settings" renderCard={false} open={false} keepMounted onClose={() => {}} ariaLabel="Settings">
        <div className="settings-panel">panel</div>
      </Overlay>,
    )
    const backdrop = container.querySelector('.settings-overlay')!
    expect(backdrop.classList.contains('hidden')).toBe(true)
    expect(backdrop.getAttribute('data-state')).toBe('closed')
    expect(backdrop.getAttribute('aria-hidden')).toBe('true')

    rerender(
      <Overlay variant="settings" renderCard={false} open keepMounted onClose={() => {}} ariaLabel="Settings">
        <div className="settings-panel">panel</div>
      </Overlay>,
    )
    expect(backdrop.classList.contains('hidden')).toBe(false)
    expect(backdrop.getAttribute('data-state')).toBe('open')
    expect(backdrop.getAttribute('aria-hidden')).toBe('false')
  })

  it('renderCard=false renders the child as the direct child card (no wrapper)', () => {
    render(
      <Overlay variant="git" renderCard={false} open onClose={() => {}} ariaLabel="Git">
        <div className="git-panel">panel</div>
      </Overlay>,
    )
    const backdrop = screen.getByRole('dialog', { name: 'Git' })
    expect(backdrop.classList.contains('git-overlay')).toBe(true)
    const panel = backdrop.firstElementChild as HTMLElement | null
    expect(panel?.classList.contains('git-panel')).toBe(true)
    expect(backdrop.children.length).toBe(1)
  })

  it('motion mode renders motion backdrops/cards without data-state', () => {
    render(
      <Overlay variant="modal" motion="motion" open onClose={() => {}} ariaLabel="Motion">
        <button>inside</button>
      </Overlay>,
    )
    const card = screen.getByRole('dialog', { name: 'Motion' })
    expect(card.classList.contains('modal')).toBe(true)
    const backdrop = card.parentElement
    expect(backdrop?.classList.contains('modal-backdrop')).toBe(true)
    expect(backdrop?.firstElementChild).toBe(card)
    expect(backdrop?.hasAttribute('data-state')).toBe(false)
  })

  it('portal renders into document.body, outside the render container', () => {
    const { container } = render(
      <Overlay variant="modal" portal open onClose={() => {}} ariaLabel="Portaled">
        <button>inside</button>
      </Overlay>,
    )
    expect(container.querySelector('.modal-backdrop')).toBeNull()
    expect(document.body.querySelector('.modal-backdrop')).not.toBeNull()
  })
})
