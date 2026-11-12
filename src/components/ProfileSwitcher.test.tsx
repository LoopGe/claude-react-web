// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import * as useProfiles from '../hooks/useProfiles'
import { ProfileSwitcher } from './ProfileSwitcher'
import { expectPortaledToBody } from './portal-test-utils'
import { ToastProvider } from './ToastProvider'
import { ToastHost } from './ToastHost'
import { getFloatingSurfaceCount } from '../hooks/floating-surface-registry'
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

  it('does not start overlapping direct activations', async () => {
    let resolveActivate!: () => void
    const activate = vi.fn().mockImplementation(() => new Promise<void>((resolve) => { resolveActivate = resolve }))
    mockedUseProfiles(activate)
    getMock.mockResolvedValue({ sessions: [] })
    render(<ToastProvider><ProfileSwitcher /></ToastProvider>)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByText('B'))
    await waitFor(() => expect(activate).toHaveBeenCalledWith('b'))

    fireEvent.click(screen.getByText('B'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(activate).toHaveBeenCalledTimes(1)
    resolveActivate()
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  })

  it('opens the restart dialog when idle follow-global sessions exist and confirms with selected ids', async () => {
    const activate = vi.fn().mockResolvedValue(undefined)
    mockedUseProfiles(activate)
    // One follow-global (idle) session and one that is pinned or busy — only
    // the former is a candidate for restart.
    getMock.mockResolvedValue({ sessions: [session('s1'), { ...session('s2'), profileId: 'x' }] })
    const { container } = render(<ToastProvider><ProfileSwitcher /></ToastProvider>)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByText('B'))

    // Dialog appears with the candidate session, not the pinned one.
    await waitFor(() => expect(screen.getByText(/Switch profile to “B”/)).toBeTruthy())
    expect(screen.queryByText('Session s2')).toBeNull()
    // …and it must ESCAPE the header to do it. Mounted inside `.profile-switcher`
    // (a ~150x30 positioned box) an absolutely-positioned backdrop is clipped to
    // that sliver while its focus trap keeps stealing focus from the rest of the
    // app — the "clicking the profile switcher freezes everything" bug.
    expectPortaledToBody(container, '.modal-backdrop')
    fireEvent.click(screen.getByText('Restart 1 session'))
    await waitFor(() => expect(activate).toHaveBeenCalledWith('b', ['s1']))
  })

  it('restores trigger focus after a confirmed switch closes the menu and dialog', async () => {
    const activate = vi.fn().mockResolvedValue(undefined)
    mockedUseProfiles(activate)
    getMock.mockResolvedValue({ sessions: [session('s1')] })
    render(<ToastProvider><ProfileSwitcher /></ToastProvider>)
    const trigger = screen.getByRole('button')
    fireEvent.click(trigger)
    fireEvent.click(screen.getByText('B'))
    await waitFor(() => expect(screen.getByText(/Switch profile to “B”/)).toBeTruthy())
    fireEvent.click(screen.getByText('Restart 1 session'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(trigger)
  })

  it('keeps the menu as the confirmation dialog parent when cancelling', async () => {
    const activate = vi.fn().mockResolvedValue(undefined)
    mockedUseProfiles(activate)
    getMock.mockResolvedValue({ sessions: [session('s1')] })
    render(<ToastProvider><ProfileSwitcher /></ToastProvider>)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByText('B'))
    await waitFor(() => expect(screen.getByText(/Switch profile to “B”/)).toBeTruthy())

    expect(screen.getByRole('menu')).toBeTruthy()
    expect(getFloatingSurfaceCount()).toBe(2)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText(/Switch profile to “B”/)).toBeNull()
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(getFloatingSurfaceCount()).toBe(1)

    // The preserved menu remains usable, not just mounted.
    fireEvent.click(screen.getByText('B'))
    await waitFor(() => expect(screen.getByText(/Switch profile to “B”/)).toBeTruthy())
  })

  it('does not open a stale confirmation after the menu is dismissed during session lookup', async () => {
    const activate = vi.fn().mockResolvedValue(undefined)
    mockedUseProfiles(activate)
    let resolveSessions!: (value: { sessions: SessionInfo[] }) => void
    getMock.mockImplementation(() => new Promise((resolve) => { resolveSessions = resolve }))
    render(<ToastProvider><ProfileSwitcher /></ToastProvider>)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByText('B'))
    fireEvent.keyDown(document.querySelector('.profile-switcher__menu')!, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    resolveSessions({ sessions: [session('s1')] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.queryByText(/Switch profile to “B”/)).toBeNull()
    expect(activate).not.toHaveBeenCalled()
  })

  it('does not activate a profile after the menu is dismissed during session lookup', async () => {
    const activate = vi.fn().mockResolvedValue(undefined)
    mockedUseProfiles(activate)
    let resolveSessions!: (value: { sessions: SessionInfo[] }) => void
    getMock.mockImplementation(() => new Promise((resolve) => { resolveSessions = resolve }))
    render(<ToastProvider><ProfileSwitcher /></ToastProvider>)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByText('B'))
    fireEvent.keyDown(document.querySelector('.profile-switcher__menu')!, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    resolveSessions({ sessions: [] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(activate).not.toHaveBeenCalled()
  })

  it('cancels a pending selection when the trigger closes the menu', async () => {
    const activate = vi.fn().mockResolvedValue(undefined)
    mockedUseProfiles(activate)
    let resolveSessions!: (value: { sessions: SessionInfo[] }) => void
    getMock.mockImplementation(() => new Promise((resolve) => { resolveSessions = resolve }))
    render(<ToastProvider><ProfileSwitcher /></ToastProvider>)
    const trigger = screen.getByRole('button')
    fireEvent.click(trigger)
    fireEvent.click(screen.getByText('B'))
    fireEvent.click(trigger)
    expect(screen.queryByRole('menu')).toBeNull()
    resolveSessions({ sessions: [session('s1')] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.queryByText(/Switch profile to “B”/)).toBeNull()
  })

  it('cancels a pending selection when the active profile closes the menu', async () => {
    const activate = vi.fn().mockResolvedValue(undefined)
    mockedUseProfiles(activate)
    let resolveSessions!: (value: { sessions: SessionInfo[] }) => void
    getMock.mockImplementation(() => new Promise((resolve) => { resolveSessions = resolve }))
    render(<ToastProvider><ProfileSwitcher /></ToastProvider>)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByText('B'))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^A/ }))
    expect(screen.queryByRole('menu')).toBeNull()
    resolveSessions({ sessions: [session('s1')] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.queryByText(/Switch profile to “B”/)).toBeNull()
  })

  it('keeps the busy confirmation open when the parent menu is dismissed', async () => {
    let resolveActivate!: () => void
    const activate = vi.fn().mockImplementation(() => new Promise<void>((resolve) => { resolveActivate = resolve }))
    mockedUseProfiles(activate)
    getMock.mockResolvedValue({ sessions: [session('s1')] })
    render(<ToastProvider><ProfileSwitcher /></ToastProvider>)
    const trigger = screen.getByRole('button')
    fireEvent.click(trigger)
    fireEvent.click(screen.getByText('B'))
    await waitFor(() => expect(screen.getByText(/Switch profile to “B”/)).toBeTruthy())
    fireEvent.click(screen.getByText('Restart 1 session'))
    fireEvent.click(trigger)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByText(/Switch profile to “B”/)).toBeTruthy()
    resolveActivate()
    await waitFor(() => expect(screen.queryByText(/Switch profile to “B”/)).toBeNull())
  })

  it('does not steal focus from an outside control when dismissing the menu', () => {
    const activate = vi.fn().mockResolvedValue(undefined)
    mockedUseProfiles(activate)
    render(<ToastProvider><ProfileSwitcher /></ToastProvider>)
    const trigger = screen.getByRole('button')
    fireEvent.click(trigger)
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    outside.focus()
    fireEvent.mouseDown(outside, { button: 0 })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(outside)
    expect(document.activeElement).not.toBe(trigger)
    outside.remove()
  })

  it('does not activate when session lookup fails', async () => {
    const activate = vi.fn().mockResolvedValue(undefined)
    mockedUseProfiles(activate)
    getMock.mockRejectedValue(new Error('lookup failed'))
    render(<ToastProvider><ProfileSwitcher /><ToastHost /></ToastProvider>)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByText('B'))
    await waitFor(() => expect(document.querySelector('.toast-error')).not.toBeNull())
    expect(activate).not.toHaveBeenCalled()
    expect(screen.queryByText(/Switch profile to “B”/)).toBeNull()
  })

  it('surfaces an activation failure even after the menu is dismissed', async () => {
    const activate = vi.fn().mockRejectedValue(new Error('activate failed'))
    mockedUseProfiles(activate)
    getMock.mockResolvedValue({ sessions: [] })
    render(<ToastProvider><ProfileSwitcher /><ToastHost /></ToastProvider>)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByText('B'))
    await waitFor(() => expect(activate).toHaveBeenCalledWith('b'))
    fireEvent.keyDown(document.querySelector('.profile-switcher__menu')!, { key: 'Escape' })
    await waitFor(() => expect(document.querySelector('.toast-error')).not.toBeNull())
    expect(activate).toHaveBeenCalledWith('b')
  })

  it('allows the advertised default-only switch with zero selected sessions', async () => {
    const activate = vi.fn().mockResolvedValue(undefined)
    mockedUseProfiles(activate)
    getMock.mockResolvedValue({ sessions: [session('s1')] })
    render(<ToastProvider><ProfileSwitcher /></ToastProvider>)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByText('B'))
    await waitFor(() => expect(screen.getByText(/Switch profile to “B”/)).toBeTruthy())
    fireEvent.click(screen.getByRole('checkbox'))
    const confirm = screen.getByRole('button', { name: 'Restart 0 sessions' })
    expect((confirm as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(confirm)
    await waitFor(() => expect(activate).toHaveBeenCalledWith('b', []))
  })

  it('restores trigger focus when Escape closes the menu', () => {
    const activate = vi.fn().mockResolvedValue(undefined)
    mockedUseProfiles(activate)
    render(<ToastProvider><ProfileSwitcher /></ToastProvider>)
    const trigger = screen.getByRole('button')
    fireEvent.click(trigger)
    const item = screen.getByRole('menuitemradio', { name: /^B/ })
    item.focus()
    expect(document.activeElement).toBe(item)
    fireEvent.keyDown(item, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)
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