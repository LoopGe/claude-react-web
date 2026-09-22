import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { FoldableBody } from './FoldableBody'
import { FOLD_MAX_PX, userBodyFoldKey } from './fold-key'
import type { SdkMessage } from '../../types'

// Controllable ResizeObserver stub (same pattern as MessageList.test.tsx):
// captures callbacks by observed element so a test drives a re-measure
// deterministically via fireResize(el). Never auto-fires.
const roObserved = new Map<Element, Array<() => void>>()
function fireResize(el: Element) {
  for (const cb of roObserved.get(el) ?? []) cb()
}
vi.stubGlobal(
  'ResizeObserver',
  class {
    constructor(private cb: () => void) {}
    observe(el: Element) {
      const list = roObserved.get(el) ?? []
      list.push(this.cb)
      roObserved.set(el, list)
    }
    unobserve(el: Element) {
      const list = roObserved.get(el)
      if (!list) return
      const i = list.indexOf(this.cb)
      if (i >= 0) list.splice(i, 1)
      if (list.length === 0) roObserved.delete(el)
    }
    disconnect() {
      for (const [el, list] of Array.from(roObserved)) {
        const i = list.indexOf(this.cb)
        if (i >= 0) list.splice(i, 1)
        if (list.length === 0) roObserved.delete(el)
      }
    }
  },
)

// happy-dom has no layout engine, so scrollHeight is always 0. Mutable
// prototype stub: the element under measurement is created by the component
// itself, before any test code can reach it, so per-element defineProperty
// (the Composer.test approach) is impossible — the measurement must see a
// scripted height from the very first useLayoutEffect. Scoped to this file
// (process-per-file isolation) and restored in afterEach.
let mockScrollHeight = 0
const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')

beforeEach(() => {
  mockScrollHeight = 0
  roObserved.clear()
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get: () => mockScrollHeight,
  })
})

afterEach(() => {
  if (originalScrollHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight)
  else delete (HTMLElement.prototype as { scrollHeight?: unknown }).scrollHeight
})

describe('FoldableBody', () => {
  it('renders children bare when content fits under the threshold', () => {
    mockScrollHeight = FOLD_MAX_PX - 40
    const { container } = render(
      <FoldableBody expanded={false} onToggle={() => {}}>
        <p>short</p>
      </FoldableBody>,
    )
    expect(screen.queryByRole('button')).toBeNull()
    expect(container.querySelector('.fold-clamped')).toBeNull()
    expect(screen.getByText('short')).toBeTruthy()
  })

  it('clamps over-threshold content and offers Show more', () => {
    mockScrollHeight = FOLD_MAX_PX + 100
    const { container } = render(
      <FoldableBody expanded={false} onToggle={() => {}}>
        <p>tall</p>
      </FoldableBody>,
    )
    const content = container.querySelector('.fold-content') as HTMLElement
    expect(content.classList.contains('fold-clamped')).toBe(true)
    // Clamp height comes from the same constant the measurement compared
    // against — inline, so threshold and max-height cannot drift apart.
    expect(content.style.maxHeight).toBe(`${FOLD_MAX_PX}px`)
    const btn = screen.getByRole('button', { name: /show more/i })
    expect(btn.getAttribute('aria-expanded')).toBe('false')
  })

  it('invokes onToggle and reflects the parent-controlled expanded state', () => {
    mockScrollHeight = FOLD_MAX_PX + 100
    const onToggle = vi.fn()
    const { container, rerender } = render(
      <FoldableBody expanded={false} onToggle={onToggle}>
        <p>tall</p>
      </FoldableBody>,
    )
    fireEvent.click(screen.getByRole('button', { name: /show more/i }))
    expect(onToggle).toHaveBeenCalledTimes(1)

    // The lifted state lives in the parent; the prop flip is what re-renders.
    rerender(
      <FoldableBody expanded onToggle={onToggle}>
        <p>tall</p>
      </FoldableBody>,
    )
    const btn = screen.getByRole('button', { name: /show less/i })
    expect(btn.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('.fold-clamped')).toBeNull()
    expect((container.querySelector('.fold-content') as HTMLElement).style.maxHeight).toBe('')
  })

  it('never clamps and hides the toggle while force-opened (search hit)', () => {
    mockScrollHeight = FOLD_MAX_PX + 100
    const { container } = render(
      <FoldableBody expanded={false} forceOpen onToggle={() => {}}>
        <p>tall</p>
      </FoldableBody>,
    )
    expect(container.querySelector('.fold-clamped')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('tall')).toBeTruthy()
  })

  it('re-measures when ResizeObserver reports a content resize', () => {
    mockScrollHeight = FOLD_MAX_PX - 40
    const { container } = render(
      <FoldableBody expanded={false} onToggle={() => {}}>
        <p>grows</p>
      </FoldableBody>,
    )
    expect(screen.queryByRole('button')).toBeNull()

    // e.g. an image finished loading and pushed the body past the threshold.
    // RO observes the INNER measurement element (see FoldableBody — the
    // outer box owns clipping, the inner owns measurement, so an
    // overflow:clip parent can never skew the scrollHeight read).
    mockScrollHeight = FOLD_MAX_PX + 100
    act(() => {
      fireResize(container.querySelector('.fold-measure')!)
    })
    expect(screen.getByRole('button', { name: /show more/i })).toBeTruthy()
    expect(container.querySelector('.fold-clamped')).toBeTruthy()
  })

  it('links the toggle to the clipped region via aria-controls', () => {
    // Mirrors ToolGroupCard's useId + aria-controls pattern: aria-expanded
    // alone tells an AT the state but not WHICH region it mutates.
    mockScrollHeight = FOLD_MAX_PX + 100
    const { container } = render(
      <FoldableBody expanded={false} onToggle={() => {}}>
        <p>tall</p>
      </FoldableBody>,
    )
    const btn = screen.getByRole('button', { name: /show more/i })
    const controls = btn.getAttribute('aria-controls')
    expect(controls).toBeTruthy()
    // useId emits ":r0:"-style ids — invalid in a #selector, so match via
    // the attribute form instead (CSS.escape isn't guaranteed in happy-dom).
    const region = container.querySelector(`[id="${controls}"]`)
    expect(region).toBeTruthy()
    expect(region).toBe(container.querySelector('.fold-clamped'))
  })
})

describe('userBodyFoldKey', () => {
  function userMsg(uuid: string, text: string, images: string[] = []): SdkMessage {
    return {
      type: 'user',
      uuid,
      message: {
        content: [
          { type: 'text', text },
          ...images.map((data) => ({ type: 'image', source: { type: 'base64', data, media_type: 'image/png' } })),
        ],
      },
    } as unknown as SdkMessage
  }

  it('is stable across the ack uuid re-key (pendingId → server uuid)', () => {
    // ackUserMessage rebuilds the row with a new uuid but verbatim content;
    // a uuid-keyed expansion would snap shut mid-send.
    expect(userBodyFoldKey(userMsg('pending-1', 'long paste'))).toBe(
      userBodyFoldKey(userMsg('server-uuid', 'long paste')),
    )
  })

  it('distinguishes different content', () => {
    expect(userBodyFoldKey(userMsg('x', 'aaaa'))).not.toBe(userBodyFoldKey(userMsg('x', 'bbbb')))
  })

  it('lets image payloads participate so image-only messages get distinct keys', () => {
    expect(userBodyFoldKey(userMsg('x', '', ['abc']))).not.toBe(
      userBodyFoldKey(userMsg('x', '', ['abcd'])),
    )
    expect(userBodyFoldKey(userMsg('x', '', ['abc']))).toBe(
      userBodyFoldKey(userMsg('y', '', ['abc'])),
    )
  })
})
