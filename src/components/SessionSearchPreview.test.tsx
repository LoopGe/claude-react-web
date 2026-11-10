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

  it('keeps the matched tool result visible and highlighted', () => {
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

    expect(container.textContent).toContain('clean tree')
    expect(container.querySelector('mark.search-hl-active')).toBeTruthy()
  })

  it('settles a subagent from the replayed sidechain index', () => {
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
    expect(container.textContent).toContain('agent output')
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

    fireEvent.click(container.querySelector('.subagent-card-header')!)

    expect(screen.getByText('Review')).toBeTruthy()
    expect(container.textContent).toContain('child work')
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