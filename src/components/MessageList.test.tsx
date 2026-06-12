import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'
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
    firstItemIndex = 0,
    components,
  }: {
    data: unknown[]
    itemContent: (index: number, item: unknown) => React.ReactNode
    firstItemIndex?: number
    components?: { Footer?: React.ComponentType }
  }) => (
    <div data-testid="virtuoso-mock">
      <div data-testid="virtuoso-item-list">
        {data.map((item, i) => (
          <div key={i}>{itemContent(i + firstItemIndex, item)}</div>
        ))}
      </div>
      {components?.Footer && <components.Footer />}
    </div>
  ),
}))

// Import AFTER mock.
import { MessageList } from './MessageList'
import { SubagentProvider } from '../hooks/useSubagentContext'
import type { ActiveSubagent } from '../session-store/types'

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
    vi.useRealTimers()
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

  it('adds transcript reveal only after keyed messages are ready', async () => {
    const msgs = [
      makeMsg('assistant', {
        message: { content: [{ type: 'text', text: 'Ready now' }] },
      }),
    ]
    const items = toItems(msgs as SdkMessage[])

    const { container, rerender } = render(
      <MessageList items={items} replayReady={false} transcriptRevealKey="session-a" />,
    )
    expect(container.querySelector('.chat-messages')?.classList.contains('chat-messages-reveal')).toBe(false)

    rerender(<MessageList items={items} replayReady transcriptRevealKey="session-a" />)
    await waitFor(() => {
      expect(container.querySelector('.chat-messages')?.classList.contains('chat-messages-reveal')).toBe(true)
      expect(container.querySelector('.virtuoso-item-wrapper')?.classList.contains('transcript-item-reveal')).toBe(true)
    })

    rerender(<MessageList items={[]} replayReady transcriptRevealKey="session-b" />)
    rerender(<MessageList items={items} replayReady transcriptRevealKey="session-b" />)
    expect(container.querySelector('.chat-messages')?.classList.contains('chat-messages-reveal')).toBe(false)
    expect(container.querySelector('.virtuoso-item-wrapper')?.classList.contains('transcript-item-reveal')).toBe(false)
  })

  it('does not hide keyless filtered subagent transcripts behind reveal pending state', () => {
    const msgs = [
      makeMsg('assistant', {
        parent_tool_use_id: 'agent-1',
        message: { content: [{ type: 'text', text: 'Subagent detail' }] },
      }),
    ]

    const { container } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} parentToolUseIdFilter="agent-1" replayReady />,
    )

    const messages = container.querySelector('.chat-messages')
    expect(container.textContent).toContain('Subagent detail')
    expect(messages?.classList.contains('chat-messages-reveal-pending')).toBe(false)
  })

  it('reveals filtered subagent transcripts when keyed', async () => {
    const msgs = [
      makeMsg('assistant', {
        parent_tool_use_id: 'agent-1',
        message: { content: [{ type: 'text', text: 'Subagent detail' }] },
      }),
    ]

    const { container } = render(
      <MessageList
        items={toItems(msgs as SdkMessage[])}
        parentToolUseIdFilter="agent-1"
        replayReady
        transcriptRevealKey="subagent:agent-1"
      />,
    )

    await waitFor(() => {
      expect(container.querySelector('.chat-messages')?.classList.contains('chat-messages-reveal')).toBe(true)
      expect(container.querySelector('.virtuoso-item-wrapper')?.classList.contains('transcript-item-reveal')).toBe(true)
    })
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

  it('marks renderable first and last rows for symmetric outer spacing', () => {
    const msgs = [
      makeMsg('system', { subtype: 'status' }),
      makeMsg('user', { message: { content: [{ type: 'text', text: 'first' }] } }),
      makeMsg('assistant', { message: { content: [{ type: 'text', text: 'middle' }] } }),
      makeMsg('assistant', { message: { content: [{ type: 'text', text: 'last' }] } }),
      makeMsg('system', { subtype: 'status' }),
    ]

    const { container } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} replayReady />,
    )

    const rows = Array.from(container.querySelectorAll('.virtuoso-item-wrapper'))
    expect(rows).toHaveLength(3)
    expect(rows[0].classList.contains('transcript-first-item')).toBe(true)
    expect(rows[0].classList.contains('transcript-last-item')).toBe(false)
    expect(rows[1].classList.contains('transcript-first-item')).toBe(false)
    expect(rows[1].classList.contains('transcript-last-item')).toBe(false)
    expect(rows[2].classList.contains('transcript-first-item')).toBe(false)
    expect(rows[2].classList.contains('transcript-last-item')).toBe(true)
  })

  it('uses renderable positions for next item checks under offset firstItemIndex', () => {
    const msgs = [
      makeMsg('system', { subtype: 'status' }),
      makeMsg('user', { message: { content: [{ type: 'text', text: 'question' }] } }),
      makeMsg('assistant', { message: { content: [{ type: 'text', text: 'answer' }] } }),
    ]
    const items = toItems(msgs as SdkMessage[])
    items[1].deliveryStatus = 'consumed'

    const { container } = render(
      <MessageList items={items} replayReady working />,
    )

    expect(container.querySelector('.msg-processing-indicator')).toBeNull()
  })

  it('renders streaming content outside the virtualized transcript', () => {
    const msgs = [
      makeMsg('assistant', {
        message: { content: [{ type: 'text', text: 'Settled message' }] },
      }),
    ]

    const { container } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} replayReady streamingContent="Live tokens" />,
    )

    const streaming = container.querySelector('.streaming-footer-wrapper')
    expect(streaming).not.toBeNull()
    expect(streaming?.textContent).toContain('Live tokens')
    expect(streaming?.closest('[data-testid="virtuoso-mock"]')).toBeNull()
    expect(container.querySelector('.chat-streaming-region')?.contains(streaming)).toBe(true)
  })

  it('animates streaming content out before unmounting it', () => {
    vi.useFakeTimers()
    const msgs = [
      makeMsg('assistant', {
        message: { content: [{ type: 'text', text: 'Settled message' }] },
      }),
    ]

    const { container, rerender } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} replayReady streamingContent="Live tokens" />,
    )

    rerender(<MessageList items={toItems(msgs as SdkMessage[])} replayReady streamingContent={null} />)

    expect(container.querySelector('.chat-streaming-region')?.classList.contains('exiting')).toBe(true)
    expect(container.textContent).toContain('Live tokens')

    act(() => {
      vi.advanceTimersByTime(180)
    })

    expect(container.querySelector('.chat-streaming-region')).toBeNull()
  })

  it('renders result stats with clean separators', () => {
    const msgs = [
      makeMsg('result', {
        num_turns: 3,
        duration_ms: 129100,
        total_cost_usd: 18.891,
        usage: {
          input_tokens: 337000,
          output_tokens: 3100,
        },
      }),
    ]

    const { container } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} replayReady />,
    )

    expect(container.querySelector('.result-meta')?.textContent).toBe('3 turns \u00b7 129.1s \u00b7 337k in \u00b7 3.1k out \u00b7 $18.8910')
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

    it('drops an ExitPlanMode tool_result frame (consumed by PlanCard via planStatus)', () => {
      // ExitPlanMode never seeds toolResults (excluded from the merge map),
      // but its result is rendered by PlanCard. Membership in planStatus must
      // suppress the duplicate standalone bubble.
      const msgs = [
        makeMsg('user', {
          message: { content: [{ type: 'tool_result', tool_use_id: 'plan-1', content: 'the plan body' }] },
        }),
      ]
      const { container } = render(
        <MessageList
          items={toItems(msgs as SdkMessage[])}
          replayReady
          planStatus={new Map([['plan-1', 'approved' as const]])}
        />,
      )
      // No orphan "tool result" bubble, and the raw plan body is not duplicated.
      expect(container.textContent).not.toContain('tool result')
      expect(container.textContent).not.toContain('the plan body')
    })

    it('drops an AskUserQuestion tool_result frame (consumed by QuestionCard via questionAnswers)', () => {
      // AskUserQuestion is excluded from toolResults too; its answers are
      // rendered by QuestionCard. Membership in questionAnswers suppresses
      // the duplicate answers-JSON bubble.
      const msgs = [
        makeMsg('user', {
          message: { content: [{ type: 'tool_result', tool_use_id: 'q-1', content: 'answers json' }] },
        }),
      ]
      const { container } = render(
        <MessageList
          items={toItems(msgs as SdkMessage[])}
          replayReady
          questionAnswers={new Map([['q-1', [{ question: 'Q', answer: 'A' }]]])}
        />,
      )
      expect(container.textContent).not.toContain('tool result')
      expect(container.textContent).not.toContain('answers json')
    })

    it('drops an EnterPlanMode tool_result frame (stateless marker, no lifecycle map)', () => {
      // EnterPlanMode renders as a marker and nothing consumes its result, so
      // its id is in NONE of the lifecycle maps. The predicate must still
      // suppress the stray result by scanning items for the marker's id.
      const msgs = [
        makeMsg('assistant', {
          message: { content: [{ type: 'tool_use', id: 'enter-1', name: 'EnterPlanMode', input: {} }] },
        }),
        makeMsg('user', {
          message: { content: [{ type: 'tool_result', tool_use_id: 'enter-1', content: 'entered' }] },
        }),
      ]
      const { container } = render(
        <MessageList items={toItems(msgs as SdkMessage[])} replayReady />,
      )
      // The marker renders, but no standalone "tool result" orphan bubble.
      expect(container.textContent).not.toContain('tool result')
    })

    it('keeps a subagent tool_result bubble when there is no SubagentProvider (fallback)', () => {
      // Without a SubagentProvider the predicate has no subagent index to
      // consult, so it cannot know the result was merged into a card — the
      // safe fallback is to keep surfacing the standalone bubble rather than
      // silently drop the worker's only output.
      const msgs = [
        makeMsg('user', {
          message: { content: [{ type: 'tool_result', tool_use_id: 'sub-1', content: 'subagent out' }] },
        }),
      ]
      const { container } = render(
        <MessageList items={toItems(msgs as SdkMessage[])} replayReady />,
      )
      expect(container.textContent).toContain('tool result')
    })

    it('drops a subagent tool_result bubble once its result is merged into SubagentCard', () => {
      // The subagent's result is captured on the ActiveSubagent record
      // (record.result set), so the SubagentCard renders it inline and the
      // standalone orphan bubble must be suppressed — same merge treatment as
      // a generic tool card.
      const msgs = [
        makeMsg('user', {
          message: { content: [{ type: 'tool_result', tool_use_id: 'sub-1', content: 'subagent out' }] },
        }),
      ]
      const index = new Map<string, ActiveSubagent>([
        ['sub-1', {
          toolUseId: 'sub-1',
          label: 'scout',
          status: 'done',
          toolCount: 0,
          result: { content: 'subagent out', isError: false },
        }],
      ])
      const { container } = render(
        <SubagentProvider value={{ index, messages: [], open: () => {} }}>
          <MessageList items={toItems(msgs as SdkMessage[])} replayReady />
        </SubagentProvider>,
      )
      expect(container.textContent).not.toContain('tool result')
    })

    it('keeps the bubble while the subagent is still running (no result captured yet)', () => {
      // A running subagent has no result on its record yet, so there is
      // nothing merged into the card — the bubble (if any result arrives
      // mid-stream) must not be suppressed prematurely.
      const msgs = [
        makeMsg('user', {
          message: { content: [{ type: 'tool_result', tool_use_id: 'sub-1', content: 'subagent out' }] },
        }),
      ]
      const index = new Map<string, ActiveSubagent>([
        ['sub-1', { toolUseId: 'sub-1', label: 'scout', status: 'running', toolCount: 0 }],
      ])
      const { container } = render(
        <SubagentProvider value={{ index, messages: [], open: () => {} }}>
          <MessageList items={toItems(msgs as SdkMessage[])} replayReady />
        </SubagentProvider>,
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
