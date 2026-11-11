// @vitest-environment happy-dom
// Task resource body: mirror lookup, shell metadata/result, subagent transcript
// + agent cross-link, loading vs not-found.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ResourceTaskBody } from './ResourceTaskBody'
import { subagentResource, taskResource } from '../../shared/resource-address'

const mockOpen = vi.hoisted(() => vi.fn())
const state = vi.hoisted(() => ({ tasks: [] as Array<Record<string, unknown>>, replayReady: true }))

vi.mock('../session-store/selectors', () => ({
  useSessionField: (_id: string, field: string) => {
    if (field === 'tasks') return state.tasks
    if (field === 'replayReady') return state.replayReady
    return undefined
  },
}))
vi.mock('./context', () => ({ useOptionalOpenResource: () => mockOpen }))
vi.mock('../components/SubagentTranscriptBody', () => ({
  SubagentTranscriptBody: ({ sessionId, agentId, suppressResult }: { sessionId: string; agentId: string; suppressResult?: boolean }) => (
    <div data-testid="transcript" data-suppress-result={String(suppressResult)}>
      {sessionId}:{agentId}
    </div>
  ),
}))

beforeEach(() => {
  mockOpen.mockClear()
  state.tasks = []
  state.replayReady = true
})

describe('ResourceTaskBody', () => {
  it('renders metadata and the result for a shell task', () => {
    state.tasks = [
      {
        taskId: 't1',
        description: 'Run tests',
        status: 'completed',
        taskType: 'shell',
        result: 'all green',
        progressSummary: '2/2 done',
        lastToolName: 'Bash',
        updatedAt: 1,
      },
    ]
    render(<ResourceTaskBody address={taskResource('s1', 't1')} />)
    expect(screen.getByText('Run tests')).toBeTruthy()
    expect(screen.getByText('all green')).toBeTruthy()
    expect(screen.getByText(/2\/2 done/)).toBeTruthy()
  })

  it('renders the transcript for a subagent task and links to its agent', () => {
    state.tasks = [
      {
        taskId: 'agent-1',
        description: 'Explore',
        status: 'running',
        taskType: 'subagent',
        toolUseId: 'toolu_1',
        updatedAt: 1,
      },
    ]
    render(<ResourceTaskBody address={taskResource('s1', 'agent-1')} />)
    expect(screen.getByTestId('transcript').textContent).toBe('s1:agent-1')
    fireEvent.click(screen.getByRole('button', { name: /open agent/i }))
    expect(mockOpen).toHaveBeenCalledWith('s1', subagentResource('s1', 'toolu_1'))
  })

  it('keeps a subagent task’s result and agent link alongside the transcript', () => {
    state.tasks = [
      {
        taskId: 'agent-2',
        description: 'Agent run',
        status: 'completed',
        taskType: 'subagent',
        result: 'final answer',
        toolUseId: 'toolu_9',
        updatedAt: 1,
      },
    ]
    render(<ResourceTaskBody address={taskResource('s1', 'agent-2')} />)
    expect(screen.getByTestId('transcript').textContent).toBe('s1:agent-2')
    expect(screen.getByTestId('transcript').dataset.suppressResult).toBe('true')
    expect(screen.getByText('final answer')).toBeTruthy()
    expect(screen.getByRole('button', { name: /open agent/i })).toBeTruthy()
  })

  it('does not turn an unsafe resource URI into a navigation target', () => {
    state.tasks = [
      {
        taskId: 't2',
        description: 'shell',
        status: 'completed',
        taskType: 'shell',
        resourceLinks: [
          { uri: 'javascript:alert(1)', name: 'bad' },
          { uri: 'https://example.test/a', name: 'good' },
        ],
        updatedAt: 1,
      },
    ]
    render(<ResourceTaskBody address={taskResource('s1', 't2')} />)
    expect(document.querySelector('a[href^="javascript"]')).toBeNull()
    expect(screen.getByText('bad').tagName).toBe('SPAN')
    expect(screen.getByText('good').tagName).toBe('A')
  })

  it('shows loading before the mirror is ready and not-found after', () => {
    state.replayReady = false
    const { rerender } = render(<ResourceTaskBody address={taskResource('s1', 'gone')} />)
    expect(screen.getByText(/loading task/i)).toBeTruthy()

    state.replayReady = true
    rerender(<ResourceTaskBody address={taskResource('s1', 'gone')} />)
    expect(screen.getByText(/task not found/i)).toBeTruthy()
  })
})