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
      plainText: null,
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

  describe('empty-message filtering (willRenderEmpty)', () => {
    it('drops a tool_result frame whose result was merged into its tool card', () => {
      // The assistant emits a tool_use; the user frame carrying its
      // tool_result is fully merged (toolResults has the id), so it should
      // produce NO Virtuoso item — no empty wrapper, no doubled gap.
      const msgs = [
        makeMsg('assistant', {
          message: { content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: {} }] },
        }),
        makeMsg('user', {
          message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'done' }] },
        }),
      ]
      const { container } = render(
        <MessageList
          items={toItems(msgs as SdkMessage[])}
          replayReady
          toolStatus={new Map([['tu-1', 'success' as const]])}
          toolResults={new Map([['tu-1', { content: 'done', isError: false }]])}
        />,
      )
      // Exactly one rendered item (the assistant tool card).
      const wrapper = container.querySelector('[data-testid="virtuoso-mock"]')
      const rows = wrapper ? Array.from(wrapper.children).filter((c) => c.querySelector('.virtuoso-item-wrapper')) : []
      expect(rows.length).toBe(1)
    })

    it('keeps an orphan tool_result frame (id not in toolResults)', () => {
      // tool_use_id never matched a seeded card → standalone bubble must stay.
      const msgs = [
        makeMsg('user', {
          message: { content: [{ type: 'tool_result', tool_use_id: 'orphan', content: 'orphan out' }] },
        }),
      ]
      const { container } = render(
        <MessageList items={toItems(msgs as SdkMessage[])} replayReady />,
      )
      expect(container.textContent).toContain('tool result')
    })

    it('drops an assistant frame with only an empty (signature-only) thinking block', () => {
      const msgs = [
        makeMsg('assistant', {
          message: { content: [{ type: 'thinking', thinking: '' }] },
        }),
      ]
      const { container } = render(
        <MessageList items={toItems(msgs as SdkMessage[])} replayReady />,
      )
      const wrapper = container.querySelector('[data-testid="virtuoso-mock"]')
      const rows = wrapper ? Array.from(wrapper.children).filter((c) => c.querySelector('.virtuoso-item-wrapper')) : []
      expect(rows.length).toBe(0)
    })

    it('keeps an assistant frame that carries an error even with no visible blocks', () => {
      const msgs = [
        makeMsg('assistant', { message: { content: [] }, error: 'boom' }),
      ]
      const { container } = render(
        <MessageList items={toItems(msgs as SdkMessage[])} replayReady />,
      )
      const wrapper = container.querySelector('[data-testid="virtuoso-mock"]')
      const rows = wrapper ? Array.from(wrapper.children).filter((c) => c.querySelector('.virtuoso-item-wrapper')) : []
      expect(rows.length).toBe(1)
    })

    it('keeps a real user message', () => {
      const msgs = [
        makeMsg('user', { message: { content: [{ type: 'text', text: 'hi there' }] } }),
      ]
      const { container } = render(
        <MessageList items={toItems(msgs as SdkMessage[])} replayReady />,
      )
      expect(container.textContent).toContain('hi there')
    })
  })
})
