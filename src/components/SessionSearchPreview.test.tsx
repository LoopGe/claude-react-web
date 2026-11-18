import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionSearchPreview } from './SessionSearchPreview'
import { stubResizeObserver } from '../test/resize-observer-stub'
import type { MessagePreviewState, MessagePreviewTarget } from '../hooks/useMessagePreview'
import type { SessionSearchHit } from '../../shared/session-search'

stubResizeObserver()

// Seek observable: every scrollToIndex the scroll writer issues through the
// Virtuoso handle, so the owner-seek pins can assert WHICH row the preview
// asked to reveal (see the three Agent owner-seek tests below).
const seekMocks = vi.hoisted(() => ({ calls: [] as Array<{ index: number }> }))

// Real Virtuoso needs measured DOM dimensions to choose a window; render every
// row directly, like the other MessageList-based tests. The mock also wires the
// scroll machinery so a seek is observable: the scroller attaches with a
// non-zero clientHeight (a zero-height scroller makes the seek writer stand
// down before it resolves anything), and rows carry NO data-item-index stamp,
// so the writer cannot resolve the target's geometry and takes its
// Virtuoso-handle fallback — scrollToIndex({ index }) records the exact
// data-space row index the seek targeted.
vi.mock('react-virtuoso', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  const Virtuoso = React.forwardRef(function Virtuoso(props: {
    data: unknown[]
    itemContent: (index: number, item: unknown) => React.ReactNode
    firstItemIndex?: number
    scrollerRef?: (ref: HTMLElement | null) => void
  }, ref: React.Ref<unknown>) {
    const { data, itemContent, firstItemIndex = 0, scrollerRef } = props
    const scrollRef = React.useRef<HTMLDivElement | null>(null)
    React.useImperativeHandle(ref, () => ({
      scrollToIndex: (arg: { index: number }) => { seekMocks.calls.push({ index: arg.index }) },
    }), [])
    React.useLayoutEffect(() => {
      const el = scrollRef.current
      if (!el) return
      Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 600 })
      scrollerRef?.(el)
      return () => scrollerRef?.(null)
    }, [scrollerRef])
    return (
      <div ref={scrollRef} data-testid="virtuoso-mock">
        {data.map((item, i) => (
          <div key={i}>
            {itemContent(i + firstItemIndex, item)}
          </div>
        ))}
      </div>
    )
  })
  return { Virtuoso }
})

// The seek writer resolves its target on a requestAnimationFrame step; give
// that frame time to land so the fallback scrollToIndex is recorded before the
// assertion. Bounded: when no seek fires at all (the regression these pins
// guard), the wait runs out and the assertion sees the empty call list.
async function flushSeekFrame() {
  await act(async () => {
    for (let i = 0; i < 10 && seekMocks.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  })
}

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
  seekMocks.calls.length = 0
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
    // The assistant-side consumed-result ordinal walk lights the active mark
    // inside the merged card — sidechain children render via MessageView.
    expect(inner!.querySelector('mark.search-hl-active')?.textContent).toBe('child output')
  })

  it('keeps an async launch ack consumed by its subagent card when it is the search target', async () => {
    const agentPage = {
      ...PAGE,
      messages: [
        // A leading user row so the owning Agent card's Virtuoso index is 1,
        // not 0 — the seek pin below must distinguish the owner row from both
        // the list head and the consumed result row.
        {
          seq: 4,
          uuid: 'u4',
          msg: { type: 'user', uuid: 'u4', message: { role: 'user', content: 'find the search hit' } },
        },
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

    // Discriminating owner-seek pin: the scroll seek must target the owning
    // Agent card's Virtuoso row (index 1). If the owner-seek condition
    // regresses to the consumed result row's items index, that index maps to
    // no rendered row, no seek fires, and this assertion fails.
    await flushSeekFrame()
    expect(seekMocks.calls.map((c) => c.index)).toEqual([1])

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

  it('uses the reducer-selected canonical result in the sidechain detail', async () => {
    const agentPage = {
      ...PAGE,
      messages: [
        // Leading user row: the owning Agent card's Virtuoso index is 1.
        {
          seq: 4,
          uuid: 'u4',
          msg: { type: 'user', uuid: 'u4', message: { role: 'user', content: 'find the search hit' } },
        },
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

    // Discriminating owner-seek pin: the seek targets the owning Agent card's
    // Virtuoso row (index 1), never the consumed canonical result row's items
    // index (unmapped — that row no longer renders, so a regression fires no
    // seek at all).
    await flushSeekFrame()
    expect(seekMocks.calls.map((c) => c.index)).toEqual([1])

    fireEvent.click(container.querySelector('.subagent-card-details')!)

    expect(container.textContent).toContain('canonical output')
    expect(container.textContent).not.toContain('old output')
    expect(container.querySelector('mark.search-hl-active')).toBeTruthy()
  })

  it('keeps an errored main-thread result available in the sidechain detail', async () => {
    const agentPage = {
      ...PAGE,
      messages: [
        // Leading user row: the owning Agent card's Virtuoso index is 1.
        {
          seq: 4,
          uuid: 'u4',
          msg: { type: 'user', uuid: 'u4', message: { role: 'user', content: 'find the search hit' } },
        },
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

    // Discriminating owner-seek pin: the seek targets the owning Agent card's
    // Virtuoso row (index 1), never the consumed errored result row's items
    // index (unmapped — that row no longer renders, so a regression fires no
    // seek at all).
    await flushSeekFrame()
    expect(seekMocks.calls.map((c) => c.index)).toEqual([1])

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

// A result hit's server ordinal is message-local to the RESULT message (raw
// runs); the owning card renders in segments-then-results member space. The
// preview converts the ordinal so the active mark lands on the queried
// occurrence inside the merged card — never on the Edit diff, never misrouted.
describe('SessionSearchPreview — merged result-hit addressing', () => {
  const editBlock = {
    type: 'tool_use',
    id: 'e1',
    name: 'Edit',
    input: { old_string: 'alpha needle', new_string: 'beta needle' },
  }
  const editPage = (resultContent: unknown) => ({
    ...PAGE,
    messages: [
      {
        seq: 5,
        uuid: 'a5',
        msg: { type: 'assistant', uuid: 'a5', message: { role: 'assistant', content: [editBlock] } },
      },
      {
        seq: 6,
        uuid: 'u6',
        msg: {
          type: 'user',
          uuid: 'u6',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e1', content: resultContent }] },
        },
      },
    ],
  })
  const editHit = (matchOrdinal: number): MessagePreviewTarget => ({
    kind: 'hit',
    hit: { ...HIT, seq: 6, messageSeq: 6, messageUuid: 'u6', ownerToolUseId: 'e1', matchOrdinal, matchCount: 2 },
    query: 'needle',
  })

  it('activates the queried occurrence inside the merged Edit card, not the diff', () => {
    const { container } = renderPreview(
      { page: editPage('needle result needle again') as MessagePreviewState['page'] },
      { target: editHit(1) },
    )
    // Exactly one active mark, and it lives in the merged result body.
    const actives = container.querySelectorAll('mark.search-hl-active')
    expect(actives.length).toBe(1)
    const inner = container.querySelector('.tool-card-result-inner')
    expect(inner).toBeTruthy()
    expect(inner!.contains(actives[0]!)).toBe(true)
    expect(actives[0]!.textContent).toBe('needle')
    // The queried occurrence is the SECOND needle of the result (ordinal 1);
    // the Edit diff's two matches stay passive.
    const marks = inner!.querySelectorAll('mark.search-hl')
    expect(marks.length).toBe(2)
    expect(marks[1]!.classList.contains('search-hl-active')).toBe(true)
    expect(marks[0]!.classList.contains('search-hl-active')).toBe(false)
  })

  it('rebases a multi-run result hit onto the correct run', () => {
    // An image between two text buffers splits the body into two runs; the hit
    // is the second run's needle (server ordinal 1).
    const content = [
      { type: 'text', text: 'needle first' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
      { type: 'text', text: 'needle second' },
    ]
    const { container } = renderPreview(
      { page: editPage(content) as MessagePreviewState['page'] },
      { target: editHit(1) },
    )
    const actives = container.querySelectorAll('mark.search-hl-active')
    expect(actives.length).toBe(1)
    const inner = container.querySelector('.tool-card-result-inner')
    expect(inner!.contains(actives[0]!)).toBe(true)
    const marks = inner!.querySelectorAll('mark.search-hl')
    expect(marks.length).toBe(2)
    expect(marks[1]!.classList.contains('search-hl-active')).toBe(true)
    expect(actives[0]!.textContent).toBe('needle')
  })

  it('shows the owner row with no active mark for a hit past the 4000-char truncation', () => {
    // Only the first needle survives the rendered run's truncation; ordinal 1
    // points past it. The preview must seek the owner card and light NO mark
    // (not crash, not misroute onto the diff).
    const long = `needle${'x'.repeat(4500)}needle`
    const { container } = renderPreview(
      { page: editPage(long) as MessagePreviewState['page'] },
      { target: editHit(1) },
    )
    expect(container.querySelector('mark.search-hl-active')).toBeNull()
    expect(container.querySelector('[data-message-id="a5"]')).toBeTruthy()
    expect(screen.queryByText('This message is not shown in the transcript')).toBeNull()
    // The renderable first needle still carries a passive mark.
    const inner = container.querySelector('.tool-card-result-inner')
    expect(inner).toBeTruthy()
    expect(inner!.querySelectorAll('mark.search-hl').length).toBe(1)
  })

  const childEditPage = {
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
          message: { role: 'assistant', content: [{ type: 'tool_use', id: 'child-e1', name: 'Edit', input: { old_string: 'alpha needle', new_string: 'beta needle' } }] },
        },
      },
      {
        seq: 7,
        uuid: 'c7',
        msg: {
          type: 'user', uuid: 'c7', parent_tool_use_id: 'tu-agent',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'child-e1', content: 'needle result needle again' }] },
        },
      },
    ],
  }
  const childHit: MessagePreviewTarget = {
    kind: 'hit',
    hit: { ...HIT, seq: 7, messageSeq: 7, messageUuid: 'c7', ownerToolUseId: 'child-e1', matchOrdinal: 1, matchCount: 2 },
    query: 'needle',
  }

  it('lights the correct mark after drilling into a sidechain child Edit hit', () => {
    const { container } = renderPreview(
      { page: childEditPage as MessagePreviewState['page'] },
      { target: childHit, toolGroupCards: false },
    )
    // Main view: the child result is not rendered by the root Agent card, so no
    // active mark lives here before drill-in.
    expect(container.querySelector('[data-message-id="a5"] .subagent-card')).toBeTruthy()
    expect(container.querySelector('mark.search-hl-active')).toBeNull()

    fireEvent.click(container.querySelector('.subagent-card-details')!)

    // Sidechain view: the converted ordinal routes past the Edit diff into the
    // merged result's SECOND needle.
    const actives = container.querySelectorAll('mark.search-hl-active')
    expect(actives.length).toBe(1)
    const inner = container.querySelector('.tool-card-result-inner')
    expect(inner).toBeTruthy()
    expect(inner!.contains(actives[0]!)).toBe(true)
    expect(actives[0]!.textContent).toBe('needle')
    const marks = inner!.querySelectorAll('mark.search-hl')
    expect(marks.length).toBe(2)
    expect(marks[1]!.classList.contains('search-hl-active')).toBe(true)
  })

  it('seeks the root ancestor card for a sidechain-owned hit in the main view', () => {
    // The root assistant carries a Bash sibling plus the Agent, so it folds into
    // a group card. The child Edit hit must resolve its main-view target to that
    // ROOT row (revealing the group), never to the unrendered child row.
    const page = {
      ...PAGE,
      messages: [
        {
          seq: 5,
          uuid: 'a5',
          msg: {
            type: 'assistant', uuid: 'a5',
            message: { role: 'assistant', content: [
              { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'pwd' } },
              { type: 'tool_use', id: 'tu-agent', name: 'Agent', input: { description: 'Review', prompt: 'review' } },
            ] },
          },
        },
        {
          seq: 6,
          uuid: 'u6',
          msg: { type: 'user', uuid: 'u6', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b1', content: 'clean tree' }] } },
        },
        {
          seq: 7,
          uuid: 'c7',
          msg: {
            type: 'assistant', uuid: 'c7', parent_tool_use_id: 'tu-agent',
            message: { role: 'assistant', content: [{ type: 'tool_use', id: 'child-e1', name: 'Edit', input: { old_string: 'alpha needle', new_string: 'beta needle' } }] },
          },
        },
        {
          seq: 8,
          uuid: 'c8',
          msg: {
            type: 'user', uuid: 'c8', parent_tool_use_id: 'tu-agent',
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'child-e1', content: 'needle result' }] },
          },
        },
        {
          seq: 9,
          uuid: 'u9',
          msg: { type: 'user', uuid: 'u9', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-agent', content: 'agent output' }] } },
        },
      ],
    }
    const { container } = renderPreview(
      { page: page as MessagePreviewState['page'] },
      {
        target: {
          kind: 'hit',
          hit: { ...HIT, seq: 8, messageSeq: 8, messageUuid: 'c8', ownerToolUseId: 'child-e1', matchOrdinal: 0 },
          query: 'needle',
        },
      },
    )
    // The root group row is the active/seek target — it reveals (data-crw-reveal)
    // only when searchActiveMsgIdx resolves to a member of THIS group.
    expect(container.querySelector('.tool-group-card[data-crw-reveal="true"]')).toBeTruthy()
    expect(container.querySelector('[data-message-id="a5"]')).toBeTruthy()
    // No active mark in the main view: the child result text is not rendered by
    // the bespoke root card, and the child rows are absent.
    expect(container.querySelector('mark.search-hl-active')).toBeNull()
    expect(container.textContent).not.toContain('needle')
    expect(container.querySelector('[data-message-id="c7"]')).toBeNull()
    expect(container.querySelector('[data-message-id="c8"]')).toBeNull()
    expect(screen.queryByText('This message is not shown in the transcript')).toBeNull()
  })
})