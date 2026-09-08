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