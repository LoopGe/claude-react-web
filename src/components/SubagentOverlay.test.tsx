import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { __resetForTests, getEscapeStackCount } from '../hooks/useEscapeStack'
import { SubagentOverlay } from './SubagentOverlay'
import type { ActiveSubagent } from '../session-store/types'

// MessageList is a heavy virtualized transcript — irrelevant to the Escape
// wiring under test. Stub it so the overlay's own contract is what's exercised.
// The stub also records the props it was handed so the synthetic-row identity
// tests below can assert referential stability without a real transcript.
const messageListProps = vi.hoisted(() => [] as Array<Record<string, unknown>>)
vi.mock('./MessageList', () => ({
  MessageList: (props: Record<string, unknown>) => {
    messageListProps.push(props)
    return <div data-testid="mock-message-list" />
  },
}))

const subagent = (id: string, over: Partial<ActiveSubagent> = {}): ActiveSubagent => ({
  toolUseId: id,
  label: `subagent ${id}`,
  status: 'running',
  toolCount: 0,
  ...over,
})

afterEach(() => {
  cleanup()
  __resetForTests()
  messageListProps.length = 0
})

function renderSubagent(opts: {
  stack?: string[]
  isExiting?: boolean
  onClose?: ReturnType<typeof vi.fn>
  onPop?: ReturnType<typeof vi.fn>
} = {}) {
  const stack = opts.stack ?? ['a']
  const index = new Map(stack.map((id) => [id, subagent(id)]))
  const onClose = opts.onClose ?? vi.fn()
  const onPop = opts.onPop ?? vi.fn()
  render(
    <SubagentOverlay
      stack={stack}
      items={[]}
      index={index}
      onClose={onClose}
      onPop={onPop}
      isExiting={opts.isExiting ?? false}
    />,
  )
  return { onClose, onPop }
}

describe('SubagentOverlay escape stack', () => {
  it('registers in the escape stack while mounted and unregisters on unmount', () => {
    const { unmount } = render(<SubagentOverlay
      stack={['a']}
      items={[]}
      index={new Map([['a', subagent('a')]])}
      onClose={vi.fn()}
      onPop={vi.fn()}
    />)
    expect(getEscapeStackCount()).toBe(1)
    unmount()
    expect(getEscapeStackCount()).toBe(0)
  })

  it('Esc with focus inside the overlay closes it (containment wins)', () => {
    const { onClose, onPop } = renderSubagent()
    const closeBtn = screen.getByRole('button', { name: 'Close' })
    closeBtn.focus()
    fireEvent.keyDown(closeBtn, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onPop).not.toHaveBeenCalled()
  })

  it('Esc with focus outside still closes the overlay (stack consumes topmost)', () => {
    const { onClose, onPop } = renderSubagent()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onPop).not.toHaveBeenCalled()
  })

  it('Esc pops one level when nested instead of closing', () => {
    const { onClose, onPop } = renderSubagent({ stack: ['a', 'b'] })
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onPop).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('swallows Esc during the exit window (isExiting) without acting', () => {
    const { onClose, onPop } = renderSubagent({ isExiting: true })
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    expect(onPop).not.toHaveBeenCalled()
  })

  it('does not fall through to bubble-phase listeners (App interrupt chain)', () => {
    const onBubble = vi.fn()
    window.addEventListener('keydown', onBubble)
    renderSubagent()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onBubble).not.toHaveBeenCalled()
    window.removeEventListener('keydown', onBubble)
  })
})

describe('SubagentOverlay scrim', () => {
  // The background + backdrop-filter live on a dedicated scrim child so the
  // panel (and the virtualised transcript inside it) isn't in a
  // backdrop-filtered render surface. That moves the click-outside target, so
  // pin both the element's presence and the close behaviour.
  it('renders the scrim as a sibling of the panel, not as an ancestor', () => {
    const { container } = render(
      <SubagentOverlay
        stack={['a']}
        items={[]}
        index={new Map([['a', subagent('a')]])}
        onClose={vi.fn()}
        onPop={vi.fn()}
      />,
    )
    const scrim = container.querySelector('.subagent-overlay-scrim')
    const panel = container.querySelector('.subagent-overlay-panel')
    expect(scrim).not.toBeNull()
    expect(panel).not.toBeNull()
    expect(scrim!.parentElement).toBe(panel!.parentElement)
    expect(scrim!.contains(panel!)).toBe(false)
  })

  it('closes on mousedown on the scrim', () => {
    const onClose = vi.fn()
    const { container } = render(
      <SubagentOverlay
        stack={['a']}
        items={[]}
        index={new Map([['a', subagent('a')]])}
        onClose={onClose}
        onPop={vi.fn()}
      />,
    )
    fireEvent.mouseDown(container.querySelector('.subagent-overlay-scrim')!)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not close on mousedown inside the panel', () => {
    const onClose = vi.fn()
    const { container } = render(
      <SubagentOverlay
        stack={['a']}
        items={[]}
        index={new Map([['a', subagent('a')]])}
        onClose={onClose}
        onPop={vi.fn()}
      />,
    )
    fireEvent.mouseDown(container.querySelector('.subagent-overlay-panel')!)
    expect(onClose).not.toHaveBeenCalled()
  })

  // NOT covered here: `onExited` firing from the scrim's `overlay-backdrop-out`
  // animationend. React resolves animation event names through vendor-prefix
  // detection, and under jsdom that resolves to the webkit-prefixed name — so
  // `onAnimationEnd` never fires for a dispatched `animationend`, with or
  // without a hand-built event carrying `animationName`. (Verified: a native
  // listener on the same node does receive it.) The exit path is real-browser
  // only; the handler's discriminator moved from "target is the container" to
  // "animation name is overlay-backdrop-out" because the animation now runs on
  // the scrim and reaches the container by bubbling.
})

describe('SubagentOverlay → MessageList wiring', () => {
  // The overlay no longer assembles the synthetic prompt/result rows itself —
  // it hands MessageList the record and the row model derives them (see
  // message-list/useSubagentSyntheticRows). All this needs to pin is that the
  // current frame's record and filter actually reach the list; the referential
  // contract those rows depend on is tested at the hook level.
  it('passes the current frame as both the parent filter and the subagent record', () => {
    const index = new Map([
      ['a', subagent('a')],
      ['b', subagent('b', { prompt: 'nested work' })],
    ])
    render(
      <SubagentOverlay
        stack={['a', 'b']}
        items={[]}
        index={index}
        onClose={vi.fn()}
        onPop={vi.fn()}
      />,
    )
    const props = messageListProps.at(-1)
    expect(props?.parentToolUseIdFilter).toBe('b')
    expect(props?.subagent).toBe(index.get('b'))
  })
})
