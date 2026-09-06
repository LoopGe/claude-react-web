import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, waitFor, cleanup } from '@testing-library/react'
import ToolsTab from './ToolsTab'

vi.mock('../../hooks/useApi', () => ({
  api: { get: vi.fn(), put: vi.fn() },
  apiRequest: vi.fn(),
}))
vi.mock('../../hooks/useToast', () => ({
  useToast: () => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }),
}))

import { api } from '../../hooks/useApi'

afterEach(() => cleanup())
beforeEach(() => {
  vi.clearAllMocks()
  ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({ toolProfile: undefined })
  ;(api.put as ReturnType<typeof vi.fn>).mockResolvedValue({ session: { id: 's1' } })
})

const TOOLS_PLACEHOLDER = [
  'Bash', 'Read', 'Edit', 'Write', 'NotebookEdit', 'Grep', 'Glob',
  'WebFetch', 'WebSearch', 'AskUserQuestion', 'ExitPlanMode',
  'TodoWrite', 'Agent', 'Task', 'Skill',
].join(', ')

describe('ToolsTab', () => {
  it('loads the current tool profile on mount', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      toolProfile: { tools: ['Bash'], allowedTools: ['Read'], toolAliases: { Bash: 'mcp__x' } },
    })
    const { getByPlaceholderText } = render(<ToolsTab sessionId="s1" />)
    await waitFor(() =>
      expect((getByPlaceholderText(TOOLS_PLACEHOLDER) as HTMLInputElement).value).toBe('Bash'),
    )
    expect(api.get).toHaveBeenCalledWith('/sessions/s1/tool-profile')
  })

  it('saves the tool surface via PUT /tool-profile, omitting blank fields (not []),', async () => {
    const { getByPlaceholderText, getByText } = render(<ToolsTab sessionId="s1" />)
    fireEvent.change(getByPlaceholderText(TOOLS_PLACEHOLDER), { target: { value: 'Bash, Edit' } })
    fireEvent.change(getByPlaceholderText('WebFetch'), { target: { value: 'Grep' } })
    fireEvent.click(getByText('Save tool surface'))
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith('/sessions/s1/tool-profile', {
        toolProfile: { tools: ['Bash', 'Edit'], disallowedTools: ['Grep'] },
      }),
    )
  })

  it('a fully-blank tool surface sends an empty profile (reset to defaults)', async () => {
    const { getByText } = render(<ToolsTab sessionId="s1" />)
    fireEvent.click(getByText('Save tool surface'))
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith('/sessions/s1/tool-profile', { toolProfile: {} }),
    )
  })
})