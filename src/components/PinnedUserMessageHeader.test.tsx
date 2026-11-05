// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act, screen } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { PinnedMessageStore } from '../utils/pinned-message-store'
import { PinnedUserMessageHeader } from './PinnedUserMessageHeader'

const pinnedSpy = vi.fn()
vi.mock('./PinnedUserMessage', () => ({
  PinnedUserMessage: (props: { activeId: string; text: string }) => {
    pinnedSpy(props)
    return <div data-testid="pinned" />
  },
}))

beforeEach(() => {
  pinnedSpy.mockClear()
})

describe('PinnedUserMessageHeader', () => {
  it('renders from the store and re-renders when the pinned id changes', () => {
    const store = new PinnedMessageStore()
    render(
      <PinnedUserMessageHeader store={store} userMessages={[]} onJumpTo={() => {}} onClick={() => {}} />,
    )
    expect(screen.queryByTestId('pinned')).toBeNull()

    act(() => store.set({ id: 'a', text: 'A' }))
    expect(screen.getByTestId('pinned')).toBeTruthy()
    expect(pinnedSpy).toHaveBeenLastCalledWith(expect.objectContaining({ activeId: 'a', text: 'A' }))

    act(() => store.set({ id: 'b', text: 'B' }))
    expect(pinnedSpy).toHaveBeenLastCalledWith(expect.objectContaining({ activeId: 'b', text: 'B' }))

    // A clear keeps the last content so AnimatePresence can fade it out; the
    // parent (Chat's presence gate) is what unmounts the header.
    act(() => store.set(null))
    expect(pinnedSpy).toHaveBeenLastCalledWith(expect.objectContaining({ activeId: 'b', text: 'B' }))
    expect(screen.getByTestId('pinned')).toBeTruthy()
  })
})

/** Mirrors Chat's subscription: presence only, so a boundary crossing must not
 *  re-render the host. */
let presenceRenders = 0
function PresenceOnly({ store }: { store: PinnedMessageStore }) {
  presenceRenders++
  const present = useSyncExternalStore(store.subscribe, store.getPresence)
  return <span data-testid="presence">{present ? 'yes' : 'no'}</span>
}

describe('presence-only subscription (the Chat pattern)', () => {
  it('does not re-render when only the pinned id changes', () => {
    const store = new PinnedMessageStore()
    render(<PresenceOnly store={store} />)
    act(() => store.set({ id: 'a', text: 'A' }))
    expect(screen.getByTestId('presence').textContent).toBe('yes')

    presenceRenders = 0
    act(() => store.set({ id: 'b', text: 'B' }))
    expect(presenceRenders).toBe(0)

    act(() => store.set(null))
    expect(screen.getByTestId('presence').textContent).toBe('no')
  })
})