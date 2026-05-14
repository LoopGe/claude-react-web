import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import type { SdkMessage } from '../types'
import type { TranscriptItem } from '../session-store/types'

// Stub ResizeObserver — not available in jsdom.
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
)

// Stub scrollIntoView — used by some sub-components.
Element.prototype.scrollIntoView = vi.fn()

// Mock Virtuoso to render all items directly — Virtuoso needs real
// DOM dimensions to compute which items are visible, which jsdom
// doesn't provide. This mock renders the full list so we can test
// message filtering and rendering logic.
vi.mock('react-virtuoso', () => ({
  Virtuoso: ({
    data,
    itemContent,
    components,
  }: {
    data: unknown[]
    itemContent: (index: number, item: unknown) => React.ReactNode
    components?: { Footer?: React.ComponentType }
  }) => (
    <div data-testid="virtuoso-mock">
      {data.map((item, i) => (
        <div key={i}>{itemContent(i, item)}</div>
      ))}
      {components?.Footer && <components.Footer />}
    </div>
  ),
}))

// Import AFTER mock.
import { MessageList } from './MessageList'

function makeMsg(type: string, overrides: Record<string, unknown> = {}): SdkMessage {
  return { type, message: { content: [] }, ...overrides } as SdkMessage
}

function toItems(msgs: SdkMessage[]): TranscriptItem[] {
  return msgs
    .filter((msg) => msg.type !== 'stream_event')
    .map((msg, i) => ({
      id: `item-${i}`,
      msg,
      searchableText: null,
      isCompactSummary: false,
      hiddenByDefault: msg.type === 'system' && msg.subtype !== 'error' && msg.subtype !== 'compact_boundary' && msg.subtype !== 'api_retry',
    }))
}

describe('MessageList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows empty state when messages are empty', () => {
    const { container } = render(
      <MessageList items={[]} replayReady />,
    )
    expect(container.textContent).toContain('Type a message below')
  })

  it('shows loading state when replayReady is false', () => {
    const { container } = render(
      <MessageList items={[]} replayReady={false} />,
    )
    expect(container.textContent).toContain('Loading messages')
  })

  it('filters out stream_event messages', () => {
    const msgs = [
      makeMsg('user', { message: { content: [{ type: 'text', text: 'hi' }] } }),
      makeMsg('stream_event'),
      makeMsg('assistant', { message: { content: [{ type: 'text', text: 'hello' }] } }),
    ]
    const { container } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} replayReady />,
    )
    // stream_event should not be rendered
    expect(container.textContent).not.toContain('stream_event')
  })

  it('renders assistant messages', () => {
    const msgs = [
      makeMsg('assistant', {
        message: { content: [{ type: 'text', text: 'Hello world' }] },
      }),
    ]
    const { container } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} replayReady />,
    )
    expect(container.textContent).toContain('Hello world')
  })

  it('renders system messages when showSystemEvents is true', () => {
    // System init messages render as "system · init" header (no body content).
    const msgs = [
      makeMsg('system', { subtype: 'init' }),
    ]
    const { container } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} replayReady showSystemEvents />,
    )
    expect(container.textContent).toContain('init')
  })

  it('hides system messages when showSystemEvents is false', () => {
    // init messages are hidden unless showSystemEvents is true.
    const msgs = [
      makeMsg('system', { subtype: 'init' }),
    ]
    const { container } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} replayReady showSystemEvents={false} />,
    )
    expect(container.textContent).not.toContain('system · init')
  })

  it('always shows system error messages regardless of showSystemEvents', () => {
    // Error system messages render msg.error field, not message.content.
    const msgs = [
      makeMsg('system', { subtype: 'error', error: 'something broke' }),
    ]
    const { container } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} replayReady showSystemEvents={false} />,
    )
    expect(container.textContent).toContain('something broke')
  })
})
