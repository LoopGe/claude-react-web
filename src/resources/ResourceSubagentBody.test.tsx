// @vitest-environment happy-dom
// Subagent resource body: mirror lookup, conversation for sync agents,
// disk transcript for async agents (taskId), task cross-link, loading state.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ResourceSubagentBody } from './ResourceSubagentBody'
import { subagentResource, taskResource } from '../../shared/resource-address'

const mockOpen = vi.hoisted(() => vi.fn())
const state = vi.hoisted(() => ({
  index: new Map<string, Record<string, unknown>>(),
  replayReady: true,
}))

vi.mock('../session-store/selectors', () => ({
  useSessionField: (_id: string, field: string) => {
    if (field === 'subagentIndex') return state.index
    if (field === 'replayReady') return state.replayReady
    if (field === 'items') return []
    if (
      field === 'toolStatus' ||
      field === 'toolResults' ||
      field === 'planStatus' ||
      field === 'planContent' ||
      field === 'questionAnswers'
    ) {
      return new Map()
    }
    return undefined
  },
}))
vi.mock('./context', () => ({ useOptionalOpenResource: () => mockOpen }))
vi.mock('../components/SubagentTranscriptBody', () => ({
  SubagentTranscriptBody: ({ sessionId, agentId }: { sessionId: string; agentId: string }) => (
    <div data-testid="transcript">
      {sessionId}:{agentId}
    </div>
  ),
}))
vi.mock('../components/SubagentConversationBody', () => ({
  SubagentConversationBody: ({
    currentId,
    current,
  }: {
    currentId: string
    current: { label: string }
  }) => (
    <div data-testid="conversation">
      {currentId}:{current.label}
    </div>
  ),
}))

beforeEach(() => {
  mockOpen.mockClear()
  state.index = new Map()
  state.replayReady = true
})

describe('ResourceSubagentBody', () => {
  it('renders the mirror conversation for a sync agent', () => {
    state.index = new Map([
      [
        'toolu_1',
        { toolUseId: 'toolu_1', label: 'Explore', status: 'running', toolCount: 3 },
      ],
    ])
    render(<ResourceSubagentBody address={subagentResource('s1', 'toolu_1')} />)
    expect(screen.getByTestId('conversation').textContent).toBe('toolu_1:Explore')
    expect(screen.queryByRole('button', { name: /open task/i })).toBeNull()
  })

  it('renders the disk transcript for an ASYNC agent and links to its task', () => {
    state.index = new Map([
      [
        'toolu_2',
        {
          toolUseId: 'toolu_2',
          label: 'Background agent',
          status: 'background',
          toolCount: 1,
          taskId: 'agent-1',
          isAsync: true,
        },
      ],
    ])
    render(<ResourceSubagentBody address={subagentResource('s1', 'toolu_2')} />)
    expect(screen.getByTestId('transcript').textContent).toBe('s1:agent-1')
    fireEvent.click(screen.getByRole('button', { name: /open task/i }))
    expect(mockOpen).toHaveBeenCalledWith('s1', taskResource('s1', 'agent-1'))
  })

  it('keeps a sync agent on the mirror conversation even when it has a taskId', () => {
    state.index = new Map([
      [
        'toolu_3',
        {
          toolUseId: 'toolu_3',
          label: 'Foreground agent',
          status: 'done',
          toolCount: 2,
          taskId: 't-sync',
          isAsync: false,
        },
      ],
    ])
    render(<ResourceSubagentBody address={subagentResource('s1', 'toolu_3')} />)
    expect(screen.getByTestId('conversation').textContent).toBe('toolu_3:Foreground agent')
    expect(screen.queryByTestId('transcript')).toBeNull()
  })

  it('shows loading before the mirror is ready and not-found after', () => {
    state.replayReady = false
    const { rerender } = render(<ResourceSubagentBody address={subagentResource('s1', 'gone')} />)
    expect(screen.getByText(/loading subagent/i)).toBeTruthy()

    state.replayReady = true
    rerender(<ResourceSubagentBody address={subagentResource('s1', 'gone')} />)
    expect(screen.getByText(/subagent not found/i)).toBeTruthy()
  })
})