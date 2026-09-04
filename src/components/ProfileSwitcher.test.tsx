// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import * as useProfiles from '../hooks/useProfiles'
import { ProfileSwitcher } from './ProfileSwitcher'
import { ToastProvider } from './ToastProvider'
import type { SessionInfo } from '../types'
import type { ProviderProfile } from '../types/config'

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }))

vi.mock('../hooks/useProfiles', () => ({ useProfiles: vi.fn() }))
vi.mock('../hooks/useApi', async (importActual) => {
  const actual = await importActual<typeof import('../hooks/useApi')>()
  return { ...actual, api: { ...actual.api, get: getMock } }
})

afterEach(() => cleanup())

function profiles(existing: ProviderProfile[] = []): ProviderProfile[] {
  return [
    { id: 'a', name: 'A', isActive: true, baseUrl: '', modelList: [], modelGroups: [], recapModel: '', commitMessageModel: '' },
    { id: 'b', name: 'B', isActive: false, baseUrl: '', modelList: [], modelGroups: [], recapModel: '', commitMessageModel: '' },
    ...existing,
  ]
}

function session(id: string): SessionInfo {
  return {
    id,
    title: `Session ${id}`,
    running: true,
    terminated: false,
    working: false,
    phase: 'idle',
    createdAt: 0, lastActivityAt: 0, subscribers: 0, messageCount: 0,
  }
}

function mockedUseProfiles(activate: (id: string, restartSessions?: string[]) => Promise<void>) {
  vi.mocked(useProfiles.useProfiles).mockReturnValue({
    profiles: profiles(),
    activeProfileId: 'a',
    refresh: vi.fn(),
    create: vi.fn(), update: vi.fn(), remove: vi.fn(),
    activate: activate as never,
  })
}

describe('ProfileSwitcher', () => {
  beforeEach(() => {
    getMock.mockReset()
  })

  it('activates directly when no live follow-global session can restart', async () => {
    const activate = vi.fn().mockResolvedValue(undefined)
    mockedUseProfiles(activate)
    getMock.mockResolvedValue({ sessions: [] }) // no candidates at all
    render(<ToastProvider><ProfileSwitcher /></ToastProvider>)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByText('B'))
    await waitFor(() => expect(activate).toHaveBeenCalledWith('b'))
  })

  it('opens the restart dialog when idle follow-global sessions exist and confirms with selected ids', async () => {
    const activate = vi.fn().mockResolvedValue(undefined)
    mockedUseProfiles(activate)
    // One follow-global (idle) session and one that is pinned or busy — only
    // the former is a candidate for restart.
    getMock.mockResolvedValue({ sessions: [session('s1'), { ...session('s2'), profileId: 'x' }] })
    render(<ToastProvider><ProfileSwitcher /></ToastProvider>)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByText('B'))

    // Dialog appears with the candidate session, not the pinned one.
    await waitFor(() => expect(screen.getByText(/Switch profile to “B”/)).toBeTruthy())
    expect(screen.queryByText('Session s2')).toBeNull()
    fireEvent.click(screen.getByText('Restart 1 session'))
    await waitFor(() => expect(activate).toHaveBeenCalledWith('b', ['s1']))
  })

  it('renders "Manage profiles..." and calls onManageProfiles', () => {
    const activate = vi.fn().mockResolvedValue(undefined)
    mockedUseProfiles(activate)
    const onManageProfiles = vi.fn()
    render(<ToastProvider><ProfileSwitcher onManageProfiles={onManageProfiles} /></ToastProvider>)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByText('Manage profiles…'))
    expect(onManageProfiles).toHaveBeenCalled()
  })
})