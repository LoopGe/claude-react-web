// Card-root hover timestamp: hovering a user/assistant card reveals its full
// date+time (formatFullTimestamp of msg.receivedAt) in a portalled HoverPopover.
// Cards without a server-stamped time (drafts, pre-ack optimistic bubbles)
// disable the hint so no empty bubble opens.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import type { SdkMessage } from '../../types'
import { formatFullTimestamp } from '../../utils/format'
import { MessageView } from './MessageView'

vi.stubGlobal('matchMedia', () => ({
  matches: false,
  media: '',
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
}))

function makeRect(): DOMRect {
  return {
    left: 20, top: 100, right: 320, bottom: 160,
    width: 300, height: 60, x: 20, y: 100, toJSON: () => ({}),
  } as DOMRect
}

beforeEach(() => {
  vi.useFakeTimers()
  Object.defineProperty(window, 'innerWidth', { value: 800, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true })
  Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true })
})

afterEach(() => {
  vi.useRealTimers()
})

function userMsg(receivedAt?: number): SdkMessage {
  return {
    type: 'user',
    uuid: 'u1',
    parent_tool_use_id: null,
    ...(receivedAt != null ? { receivedAt } : {}),
    message: { role: 'user', content: [{ type: 'text', text: 'hello world' }] },
  } as unknown as SdkMessage
}

function assistantMsg(receivedAt?: number): SdkMessage {
  return {
    type: 'assistant',
    uuid: 'a1',
    parent_tool_use_id: null,
    ...(receivedAt != null ? { receivedAt } : {}),
    message: { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
  } as unknown as SdkMessage
}

function renderCard(msg: SdkMessage) {
  const utils = render(
    <MessageView
      msg={msg}
      foldExpanded={false}
      foldSearchHit={false}
      onToggleFold={() => {}}
      consumedKey={msg.uuid as string}
    />,
  )
  const card = utils.container.querySelector('.msg') as HTMLElement
  card.getBoundingClientRect = () => makeRect()
  return { ...utils, card }
}

function pop(): HTMLElement | null {
  return document.querySelector('.hover-pop')
}

function hover(card: HTMLElement) {
  fireEvent.pointerEnter(card)
  act(() => {
    vi.advanceTimersByTime(200)
  })
}

describe('MessageView card-root hover timestamp', () => {
  it('shows the full timestamp when hovering a user card', () => {
    const ms = Date.UTC(2026, 5, 1, 14, 23, 5)
    const { card } = renderCard(userMsg(ms))
    expect(pop()).toBeNull()
    hover(card)
    expect(pop()?.textContent).toContain(formatFullTimestamp(ms))
  })

  it('shows the full timestamp when hovering an assistant card', () => {
    const ms = Date.UTC(2026, 5, 1, 14, 23, 5)
    const { card } = renderCard(assistantMsg(ms))
    hover(card)
    expect(pop()?.textContent).toContain(formatFullTimestamp(ms))
  })

  it('opens no bubble for a card without a receivedAt (draft / pre-ack)', () => {
    const { card } = renderCard(assistantMsg(undefined))
    hover(card)
    expect(pop()).toBeNull()
  })
})