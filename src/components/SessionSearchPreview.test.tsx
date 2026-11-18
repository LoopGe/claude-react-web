import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionSearchPreview } from './SessionSearchPreview'
import { stubResizeObserver } from '../test/resize-observer-stub'
import type { MessagePreviewState, MessagePreviewTarget } from '../hooks/useMessagePreview'
import type { SessionSearchHit } from '../../shared/session-search'

stubResizeObserver()

// Real Virtuoso needs measured DOM dimensions to choose a window; render every
// row directly, like the other MessageList-based tests.
vi.mock('react-virtuoso', async () => ({
  Virtuoso: ({ data, itemContent, firstItemIndex = 0 }: {
    data: unknown[]
    itemContent: (index: number, item: unknown) => React.ReactNode
    firstItemIndex?: number
  }) => (
    <div data-testid="virtuoso-mock">
      {data.map((item, i) => (
        <div key={i} data-item-index={i + firstItemIndex}>
          {itemContent(i + firstItemIndex, item)}
        </div>
      ))}
    </div>
  ),
}))

vi.mock('../hooks/useMcpApps', async () => {
  const React = await import('react')
  return {
    McpAppsContext: React.createContext(null),
    McpAppsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useMcpAppTool: () => undefined,
  }
})

const mocks = vi.hoisted(() => ({ state: null as MessagePreviewState | null }))
vi.mock('../hooks/useMessagePreview', () => ({
  useMessagePreview: () => mocks.state,
}))

const HIT: SessionSearchHit = {
  seq: 6,
  messageSeq: 6,
  messageUuid: 'a6',
  turnSeq: 5,
  turnNo: 2,
  turnPrompt: 'Find the search hit',
  role: 'assistant',
  timestamp: Date.UTC(2026, 10, 10, 9, 0),
  snippet: 'the search hit is here',
  matchCount: 1,
}

const TARGET: MessagePreviewTarget = { kind: 'hit', hit: HIT, query: 'search' }

const PAGE = {
  generation: 0,
  headSeq: 10,
  totalCount: 2,
  startIndex: 5,
  hasMore: false,
  tombstones: [],
  messages: [
    {
      seq: 5,
      uuid: 'u5',
      msg: { type: 'user', uuid: 'u5', message: { role: 'user', content: 'find the search hit' } },
    },
    {
      seq: 6,
      uuid: 'a6',
      msg: {
        type: 'assistant',
        uuid: 'a6',
        message: { role: 'assistant', content: [{ type: 'text', text: 'the search hit is here' }] },
      },
    },
  ],
}

const TOOL_PAGE = {
  ...PAGE,
  messages: [
    {
      seq: 5,
      uuid: 'a5',
      msg: {
        type: 'assistant',
        uuid: 'a5',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu5', name: 'Bash', input: { command: 'git status' } }],
        },
      },
    },
    {
      seq: 6,
      uuid: 'u6',
      msg: {
        type: 'user',
        uuid: 'u6',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu5', content: 'clean tree' }],
        },
      },
    },
  ],
}

function renderPreview(
  state: Partial<MessagePreviewState> = {},
  props: Partial<Parameters<typeof SessionSearchPreview>[0]> = {},
  onBack = vi.fn(),
) {
  mocks.state = {
    page: PAGE as MessagePreviewState['page'],
    loading: false,
    error: null,
    retry: vi.fn(),
    ...state,
  }
  const utils = render(
    <SessionSearchPreview sessionId="s1" target={TARGET} onBack={onBack} {...props} />,
  )
  return { ...utils, onBack }
}

// Orphan bubbles render ToolResultDetails bare; a merged result renders it
// inside the owning card's .tool-card-result-inner. A consumed result must
// never surface as a standalone bubble next to its card.
function expectAllResultsMerged(container: HTMLElement) {
  for (const el of container.querySelectorAll('.tool-result-details')) {
    expect(el.closest('.tool-card-result-inner')).not.toBeNull()
  }
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.scrollTo = vi.fn()
})

describe('SessionSearchPreview', () => {
  it('renders the turn context and marks the query', () => {
    const { container } = renderPreview()

    expect(screen.getByText('Turn 2')).toBeTruthy()
    expect(container.textContent).toContain('find the search hit')
    expect(container.textContent).toContain('the search hit is here')
    expect(container.querySelectorAll('mark.search-hl').length).toBeGreaterThan(0)
  })

  it('activates the match in the target message', () => {
    const { container } = renderPreview()
    expect(container.querySelector('mark.search-hl-active')).toBeTruthy()
  })

  it('renders tool groups through MessageList', () => {
    const { container } = renderPreview({ page: TOOL_PAGE as MessagePreviewState['page'] })
    expect(container.querySelector('.tool-group-card')).toBeTruthy()
    expect(container.textContent).toContain('Bash')
  })

  it('opens and highlights the group whose result matches', () => {
    const { container } = renderPreview(
      { page: TOOL_PAGE as MessagePreviewState['page'] },
      {
        target: {
          kind: 'hit',
          hit: { ...HIT, seq: 5, messageSeq: 5, messageUuid: 'a5' },
          query: 'clean',
        },
      },
    )

    expect(container.querySelector('.tool-group-card [aria-expanded="true"]')).toBeTruthy()
    expect(container.textContent).toContain('clean tree')
    expect(container.querySelector('mark.search-hl-active')).toBeTruthy()
  })

  it('keeps a consumed result merged into its owning card and seeks the owner row', () => {
    const { container } = renderPreview(
      { page: TOOL_PAGE as MessagePreviewState['page'] },
      {
        target: {
          kind: 'hit',
          hit: { ...HIT, seq: 5, messageSeq: 6, messageUuid: 'u6' },
          query: 'clean',
        },
      },
    )

    // The matched result stays merged: its ToolResultDetails renders inside
    // the owning Bash card, never as a standalone orphan bubble.
    expectAllResultsMerged(container)
    const inner = container.querySelector('.tool-card-result-inner')
    expect(inner).toBeTruthy()
    expect(inner!.textContent).toContain('clean tree')
    expect(inner!.querySelector('mark.search-hl-active')?.textContent).toBe('clean')
    // The scroll/active target is the owning card row (the group head), not
    // the consumed result row — that row no longer exists in the transcript.
    expect(container.querySelector('[data-message-id="a5"] mark.search-hl-active')).toBeTruthy()
    expect(container.querySelector('[data-message-id="u6"]')).toBeNull()
  })

  it('settles a subagent summary without inlining its replayed result', () => {
    const agentPage = {
      ...PAGE,
      messages: [
        {
          seq: 5,
          uuid: 'a5',
          msg: {
            type: 'assistant',
            uuid: 'a5',
            message: {
              role: 'assistant',
              content: [
                { type: 'tool_use', id: 'tu-agent', name: 'Agent', input: { description: 'Review', prompt: 'review' } },
              ],
            },
          },
        },
        {
          seq: 6,
          uuid: 'u6',
          msg: {
            type: 'user',
            uuid: 'u6',
            message: {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: 'tu-agent', content: 'agent output' }],
            },
          },
        },
      ],
    }
    const { container } = renderPreview(
      { page: agentPage as MessagePreviewState['page'] },
      {
        target: {
          kind: 'hit',
          hit: { ...HIT, seq: 5, messageSeq: 5, messageUuid: 'a5' },
          query: 'agent',
        },
      },
    )

    expect(container.querySelector('.subagent-card-done')).toBeTruthy()
    expect(container.textContent).not.toContain('agent output')
  })

  it('drills into a sidechain inside the preview instead of the live overlay', () => {
    const agentPage = {
      ...PAGE,
      messages: [
        {
          seq: 5,
          uuid: 'a5',
          msg: {
            type: 'assistant',
            uuid: 'a5',
            message: {
              role: 'assistant',
              content: [
                { type: 'tool_use', id: 'tu-agent', name: 'Agent', input: { description: 'Review', prompt: 'review' } },
              ],
            },
          },
        },
        {
          seq: 6,
          uuid: 'c6',
          msg: {
            type: 'assistant',
            uuid: 'c6',
            parent_tool_use_id: 'tu-agent',
            message: { role: 'assistant', content: [{ type: 'text', text: 'child work' }] },
          },
        },
        {
          seq: 7,
          uuid: 'u7',
          msg: {
            type: 'user',
            uuid: 'u7',
            message: {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: 'tu-agent', content: 'agent output' }],
            },
          },
        },
      ],
    }
    const { container } = renderPreview(
      { page: agentPage as MessagePreviewState['page'] },
      {
        target: {
          kind: 'hit',
          hit: { ...HIT, seq: 5, messageSeq: 5, messageUuid: 'a5' },
          query: 'agent',
        },
      },
    )

    fireEvent.click(container.querySelector('.subagent-card-details')!)

    expect(screen.getByText('Review')).toBeTruthy()
    expect(container.textContent).toContain('child work')
    expect(container.textContent).toContain('agent output')
  })

  it('keeps a child tool result merged into its card after drilling into its sidechain', () => {
    const agentPage = {
      ...PAGE,
      messages: [
        {
          seq: 5,
          uuid: 'a5',
          msg: {
            type: 'assistant', uuid: 'a5',
            message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-agent', name: 'Agent', input: { description: 'Review', prompt: 'review' } }] },
          },
        },
        {
          seq: 6,
          uuid: 'c6',
          msg: {
            type: 'assistant', uuid: 'c6', parent_tool_use_id: 'tu-agent',
            message: { role: 'assistant', content: [{ type: 'tool_use', id: 'child-1', name: 'Bash', input: { command: 'pwd' } }] },
          },
        },
        {
          seq: 7,
          uuid: 'c7',
          msg: {
            type: 'user', uuid: 'c7', parent_tool_use_id: 'tu-agent',
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'child-1', content: 'child output' }] },
          },
        },
      ],
    }
    const { container } = renderPreview(
      { page: agentPage as MessagePreviewState['page'] },
      {
        target: {
          kind: 'hit',
          hit: { ...HIT, seq: 7, messageSeq: 7, messageUuid: 'c7', ownerToolUseId: 'child-1' },
          query: 'child output',
        },
        toolGroupCards: false,
      },
    )

    fireEvent.click(container.querySelector('.subagent-card-details')!)

    // Drill-in navigation still lands in the sidechain conversation.
    expect(screen.getByText('Review')).toBeTruthy()
    // The child result stays merged into its Bash card: no standalone orphan
    // bubble in the sidechain view, and the consumed result row is gone.
    expectAllResultsMerged(container)
    expect(container.querySelector('[data-message-id="c7"]')).toBeNull()
    const inner = container.querySelector('.tool-card-result-inner')
    expect(inner).toBeTruthy()
    expect(inner!.textContent).toContain('child output')
    expect(inner!.querySelector('mark.search-hl')).toBeTruthy()
    // The active-mark assertion is deferred to Task 4 (search merged-result
    // addressing plan): sidechain children render via MessageView, and its
    // assistant-side consumed-result ordinal walk — which lights the active
    // mark inside the merged card — lands there.
  })

  it('keeps an async launch ack consumed by its subagent card when it is the search target', () => {
    const agentPage = {
      ...PAGE,
      messages: [
        {
          seq: 5,
          uuid: 'a5',
          msg: {
            type: 'assistant',
            uuid: 'a5',
            message: {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'tu-agent', name: 'Agent', input: { description: 'Review', prompt: 'review' } }],
            },
          },
        },
        {
          seq: 6,
          uuid: 'u6',
          msg: {
            type: 'user',
            uuid: 'u6',
            message: {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: 'tu-agent', content: 'Async agent launched successfully' }],
            },
          },
        },
      ],
    }
    const { container } = renderPreview(
      { page: agentPage as MessagePreviewState['page'] },
      {
        target: {
          kind: 'hit',
          hit: { ...HIT, seq: 6, messageSeq: 6, messageUuid: 'u6', ownerToolUseId: 'tu-agent' },
          query: 'Async',
        },
        toolGroupCards: false,
      },
    )

    // The ack stays merged into the subagent lifecycle: no standalone result
    // bubble, and the launch metadata is not inlined into the main view.
    expectAllResultsMerged(container)
    expect(container.textContent).not.toContain('Async agent launched successfully')
    // Owner-seek: the active target is the owning Agent card row (the assistant
    // item carrying tu-agent), and the consumed ack result row no longer renders.
    expect(container.querySelector('[data-message-id="a5"] .subagent-card')).toBeTruthy()
    expect(container.querySelector('[data-message-id="u6"]')).toBeNull()

    // The hit stays findable: it seeks the owning Agent card (above) and the
    // sidechain conversation is reachable via drill-in (non-vacuous positive
    // assertion). The ack string itself is async launch metadata — the record
    // stays `running` with resultOrigin 'async_metadata', which the detail view
    // deliberately does not render as output (subagentResultContent returns
    // undefined), exactly like the live transcript. So findability for an ack
    // hit is the owning card + its reachable conversation, not a printed copy of
    // the metadata; a literal "ack text in the sidechain" assertion cannot hold.
    fireEvent.click(container.querySelector('.subagent-card-details')!)
    expect(screen.getByText('Subagent conversation')).toBeTruthy()
    expect(container.textContent).toContain('review')
  })

  it('uses the reducer-selected canonical result in the sidechain detail', () => {
    const agentPage = {
      ...PAGE,
      messages: [
        {
          seq: 5,
          uuid: 'a5',
          msg: {
            type: 'assistant',
            uuid: 'a5',
            message: {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'tu-agent', name: 'Agent', input: { description: 'Review', prompt: 'review' } }],
            },
          },
        },
        {
          seq: 6,
          uuid: 'n6',
          msg: {
            type: 'user',
            uuid: 'n6',
            receivedAt: 6_000,
            message: {
              role: 'user',
              content: '<task-notification><task-id>t-1</task-id><tool-use-id>tu-agent</tool-use-id><status>completed</status><result>old output</result></task-notification>',
            },
          },
        },
        {
          seq: 7,
          uuid: 'u7',
          msg: {
            type: 'user',
            uuid: 'u7',
            receivedAt: 7_000,
            message: {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: 'tu-agent', content: 'canonical output' }],
            },
          },
        },
      ],
    }
    const { container } = renderPreview(
      { page: agentPage as MessagePreviewState['page'] },
      {
        target: {
          kind: 'hit',
          hit: { ...HIT, seq: 7, messageSeq: 7, messageUuid: 'u7', ownerToolUseId: 'tu-agent' },
          query: 'canonical',
        },
        toolGroupCards: false,
      },
    )

    // Main view: the canonical result stays consumed by the settled record —
    // no standalone bubble alongside the card.
    expectAllResultsMerged(container)
    expect(container.querySelector('.subagent-card-done')).toBeTruthy()
    // Owner-seek: the active target is the owning Agent card row, not the
    // consumed canonical result row.
    expect(container.querySelector('[data-message-id="a5"] .subagent-card')).toBeTruthy()
    expect(container.querySelector('[data-message-id="u7"]')).toBeNull()

    fireEvent.click(container.querySelector('.subagent-card-details')!)

    expect(container.textContent).toContain('canonical output')
    expect(container.textContent).not.toContain('old output')
    expect(container.querySelector('mark.search-hl-active')).toBeTruthy()
  })

  it('keeps an errored main-thread result available in the sidechain detail', () => {
    const agentPage = {
      ...PAGE,
      messages: [
        {
          seq: 5,
          uuid: 'a5',
          msg: {
            type: 'assistant',
            uuid: 'a5',
            message: {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'tu-agent', name: 'Agent', input: { description: 'Review', prompt: 'review' } }],
            },
          },
        },
        {
          seq: 6,
          uuid: 'u6',
          msg: {
            type: 'user',
            uuid: 'u6',
            message: {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: 'tu-agent', content: 'agent failed: boom', is_error: true }],
            },
          },
        },
      ],
    }
    const { container } = renderPreview(
      { page: agentPage as MessagePreviewState['page'] },
      {
        target: {
          kind: 'hit',
          hit: { ...HIT, seq: 6, messageSeq: 6, messageUuid: 'u6', ownerToolUseId: 'tu-agent' },
          query: 'boom',
        },
        toolGroupCards: false,
      },
    )

    // Main view: the errored result stays consumed by the interrupted record —
    // no standalone bubble alongside the card.
    expectAllResultsMerged(container)
    expect(container.querySelector('.subagent-card-interrupted')).toBeTruthy()
    // Owner-seek: the active target is the owning Agent card row, not the
    // consumed errored result row.
    expect(container.querySelector('[data-message-id="a5"] .subagent-card')).toBeTruthy()
    expect(container.querySelector('[data-message-id="u6"]')).toBeNull()

    fireEvent.click(container.querySelector('.subagent-card-details')!)

    expect(container.textContent).toContain('agent failed: boom')
  })

  it('previews a message without a uuid', () => {
    const page = {
      ...PAGE,
      messages: [
        {
          seq: 5,
          msg: { type: 'user', message: { role: 'user', content: 'no uuid hit' } },
        },
      ],
    }
    const { container } = renderPreview(
      { page: page as MessagePreviewState['page'] },
      {
        target: {
          kind: 'hit',
          hit: { ...HIT, messageSeq: 5, messageUuid: null },
          query: 'uuid',
        },
      },
    )

    expect(container.textContent).toContain('no uuid hit')
    expect(screen.queryByText('This message is not shown in the transcript')).toBeNull()
  })

  it('reports when the target is not renderable in the transcript', () => {
    renderPreview({}, { target: { kind: 'uuid', uuid: 'missing', query: 'x' } })
    expect(screen.getByText('This message is not shown in the transcript')).toBeTruthy()
  })

  it('honours the showMessageHeaders preference', () => {
    const shown = renderPreview()
    expect(shown.container.querySelector('.msg-header')).toBeTruthy()
    shown.unmount()

    const hidden = renderPreview({}, { showMessageHeaders: false })
    expect(hidden.container.querySelector('.msg-header')).toBeNull()
  })

  it('returns to the results on Back', () => {
    const { onBack } = renderPreview()
    fireEvent.click(screen.getByRole('button', { name: 'Back to results' }))
    expect(onBack).toHaveBeenCalled()
  })

  it('activates an attachment-only per-session hit using its local ordinal', () => {
    const page = {
      ...PAGE,
      messages: [{
        seq: 5,
        uuid: 'u-file',
        msg: {
          type: 'user',
          uuid: 'u-file',
          parent_tool_use_id: null,
          message: { role: 'user', content: [{ type: 'file', attachment: { id: 'upload-1', name: 'report.pdf', size: 42 } }] },
        },
      }],
    }
    const { container } = renderPreview(
      { page: page as MessagePreviewState['page'] },
      { target: { kind: 'hit', hit: { ...HIT, messageSeq: 5, messageUuid: 'u-file', role: 'user', matchOrdinal: 0 }, query: 'report' } },
    )
    expect(container.querySelector('.msg-file-chip mark.search-hl-active')?.textContent).toBe('report')
  })

  it('uses the global jump local ordinal rather than its session-wide ordinal', () => {
    const page = {
      ...PAGE,
      messages: [{
        seq: 5,
        uuid: 'u-file',
        msg: {
          type: 'user',
          uuid: 'u-file',
          parent_tool_use_id: null,
          message: { role: 'user', content: [{ type: 'file', attachment: { id: 'upload-1', name: 'report.pdf', size: 42 } }] },
        },
      }],
    }
    const { container } = renderPreview(
      { page: page as MessagePreviewState['page'] },
      { target: { kind: 'uuid', uuid: 'u-file', query: 'report', matchOrdinal: 7, messageMatchOrdinal: 0 } },
    )
    expect(container.querySelector('.msg-file-chip mark.search-hl-active')?.textContent).toBe('report')
  })

  it('shows loading, not-found and failure states', () => {
    renderPreview({ page: null, loading: true })
    expect(screen.getByText('Loading…')).toBeTruthy()

    renderPreview({ page: null, loading: false, error: 'not-found' })
    expect(screen.getByText('This message is no longer available')).toBeTruthy()

    renderPreview({ page: null, loading: false, error: 'failed' })
    expect(screen.getByText('Could not load this message')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  })
})