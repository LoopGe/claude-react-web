import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('../hooks/useApi', () => ({
  api: { get: vi.fn() },
}))
vi.mock('../hooks/useWsHub', () => ({
  useWsHub: () => ({
    subscribe: () => () => {},
    addSessionListener: () => () => {},
  }),
}))

import { api } from '../hooks/useApi'
import { HooksPanel } from './HooksPanel'
import type { SessionInfo } from '../types'
import type { HookRunRecord } from '../../shared/hooks'

const mockedGet = vi.mocked(api.get)

const fakeSession = { id: 's1' } as unknown as SessionInfo

describe('HooksPanel run log', () => {
  beforeEach(() => {
    mockedGet.mockReset()
  })

  it('renders hookInput when present on an in-process run', async () => {
    const run: HookRunRecord = {
      id: 'r1',
      hookId: 'r1',
      hookName: 'inproc:Stop',
      event: 'Stop',
      status: 'success',
      startedAt: 1,
      updatedAt: 1,
      hookInput: '{"transcript_path":"/tmp/s1/session.jsonl"}',
    }
    mockedGet.mockResolvedValue({ hooks: {}, runs: [run] })
    render(<HooksPanel session={fakeSession} onSessionUpdate={() => {}} />)
    expect(await screen.findByText(/inproc:Stop/)).toBeTruthy()
    expect(screen.getByText(/{"transcript_path":"\/tmp\/s1\/session.jsonl"}/)).toBeTruthy()
  })

  it('omits hookInput block when absent on a run', async () => {
    const run: HookRunRecord = {
      id: 'r2',
      hookId: 'r2',
      hookName: 'Bash',
      event: 'PreToolUse',
      status: 'success',
      startedAt: 1,
      updatedAt: 1,
      stdout: 'echo hi',
    }
    mockedGet.mockResolvedValue({ hooks: {}, runs: [run] })
    const { container } = render(<HooksPanel session={fakeSession} onSessionUpdate={() => {}} />)
    await screen.findByText(/Bash/)
    expect(container.querySelector('.hooks-activity-input')).toBeNull()
  })
})
describe('HooksPanel native source note', () => {
  beforeEach(() => {
    mockedGet.mockReset()
  })

  it('shows the source-coverage note on a native session', async () => {
    mockedGet.mockResolvedValue({ hooks: {}, runs: [] })
    const native = { id: 's1', provider: 'native' } as unknown as SessionInfo
    const { container } = render(<HooksPanel session={native} onSessionUpdate={() => {}} />)
    await screen.findByText('Configured Hooks')
    expect(container.querySelector('.hooks-native-source-note')?.textContent).toContain(
      "this session's config only",
    )
  })

  it('does not show the source-coverage note on a claude session', async () => {
    mockedGet.mockResolvedValue({ hooks: {}, runs: [] })
    const claude = { id: 's1', provider: 'claude' } as unknown as SessionInfo
    const { container } = render(<HooksPanel session={claude} onSessionUpdate={() => {}} />)
    await screen.findByText('Configured Hooks')
    expect(container.querySelector('.hooks-native-source-note')).toBeNull()
  })
})
