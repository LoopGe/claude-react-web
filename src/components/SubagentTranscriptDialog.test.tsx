// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { SubagentTranscriptDialog } from './SubagentTranscriptDialog'
import { sessionStoreRegistry } from '../session-store/registry'
import { subagentStoreId } from '../hooks/useSubagentTranscriptStore'
import { api } from '../hooks/useApi'

// 不 mock hook 本体——灌真实 store,验证 MessageList 从草稿 store 渲染。
vi.mock('../hooks/useWsHub', () => ({
  useWsHub: () => ({
    addListener: () => () => {},
    addSessionListener: () => () => {},
    subscribe: () => () => {},
    subscribeSubagentTranscript: () => () => {},
  }),
  useWsHubStatus: () => 'online',
}))
vi.mock('../hooks/useApi', () => ({ api: { get: vi.fn().mockResolvedValue({ messages: [] }) } }))
vi.mock('../hooks/useMcpApps', () => ({
  McpAppsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

// Real Virtuoso needs measured DOM dimensions to pick its visible window —
// jsdom has none (clientHeight 0 → zero rows mounted), so it renders nothing.
// Same approach as MessageList.test.tsx: render every row directly.
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

function seedStore(sessionId: string, agentId: string) {
  const store = sessionStoreRegistry.getOrCreate(subagentStoreId(sessionId, agentId))
  store.dispatch({
    type: 'REPLAY_REPLACE',
    permissions: [],
    messages: [
      { type: 'user', uuid: 'u1', restoredFromDisk: true, parent_tool_use_id: null, session_id: sessionId, message: { role: 'user', content: 'review this diff' } },
      { type: 'assistant', uuid: 'a1', restoredFromDisk: true, parent_tool_use_id: null, session_id: sessionId, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'git diff' } }] } },
      { type: 'user', uuid: 'u2', restoredFromDisk: true, parent_tool_use_id: null, session_id: sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'diff --git a/x b/x' }] } },
    ],
  })
}

describe('SubagentTranscriptDialog', () => {
  it('renders the transcript through MessageList (text + tool card), not the old flat renderer', () => {
    seedStore('s1', 'a1')
    render(<SubagentTranscriptDialog sessionId="s1" agentId="a1" label="code-review agent" onClose={() => {}} />)
    expect(screen.getByText('review this diff')).toBeTruthy()
    // 工具卡:工具名出现(旧渲染器只有 "(non-text turn …)" 占位)
    expect(screen.getByText(/Bash/)).toBeTruthy()
  })

  it('shows the empty state for a transcript-less agent (only after the REST bootstrap lands)', async () => {
    render(<SubagentTranscriptDialog sessionId="s1" agentId="empty" label="idle" onClose={() => {}} />)
    // expectHistory gate: nothing (no empty state, no error) before replayReady.
    expect(screen.queryByText(/No transcript on disk/)).toBeNull()
    await waitFor(() => expect(screen.getByText(/No transcript on disk/)).toBeTruthy())
  })

  it('does not flash the empty state while the REST bootstrap is still pending', () => {
    vi.mocked(api.get).mockImplementationOnce(() => new Promise(() => {}))
    render(<SubagentTranscriptDialog sessionId="s1" agentId="pending" label="loading" onClose={() => {}} />)
    expect(screen.queryByText(/No transcript on disk/)).toBeNull()
    expect(screen.queryByText(/Failed to load transcript/)).toBeNull()
  })

  it('shows content over a stale store error (scratch-store error is sticky, data wins)', () => {
    const store = sessionStoreRegistry.getOrCreate(subagentStoreId('s1', 'err'))
    store.dispatch({ type: 'ERROR', message: 'boom' })
    seedStore('s1', 'err')
    render(<SubagentTranscriptDialog sessionId="s1" agentId="err" label="recovered" onClose={() => {}} />)
    expect(screen.getByText('review this diff')).toBeTruthy()
    expect(screen.queryByText(/Failed to load transcript/)).toBeNull()
  })
})
