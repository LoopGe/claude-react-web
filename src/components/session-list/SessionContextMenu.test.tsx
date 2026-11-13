import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SessionContextMenu, type SessionContextMenuProps } from './SessionContextMenu'
import type { SessionInfo } from '../../types'

vi.mock('../../hooks/useApi', () => ({
  api: { get: vi.fn(), post: vi.fn() },
}))

// The open-path hooks are mocked wholesale: the menu only consumes their
// values (capability / availability / launch), and each test below pins the
// combination it needs. Defaults keep the open-in group hidden so unrelated
// tests are unaffected.
const { openMock } = vi.hoisted(() => ({ openMock: vi.fn() }))
vi.mock('../../hooks/useOpenPathCapability', () => ({ useOpenPathCapability: vi.fn() }))
vi.mock('../../hooks/useOpenPathApps', () => ({ useOpenPathApps: vi.fn() }))
vi.mock('../../hooks/useOpenPath', () => ({ useOpenPath: vi.fn() }))

import { useOpenPathCapability } from '../../hooks/useOpenPathCapability'
import { useOpenPathApps } from '../../hooks/useOpenPathApps'
import { useOpenPath } from '../../hooks/useOpenPath'
import { ToastShowContext } from '../../hooks/toastContext'

vi.mocked(useOpenPathCapability).mockReturnValue(null) // probe unknown → hide
vi.mocked(useOpenPathApps).mockReturnValue(null)
vi.mocked(useOpenPath).mockReturnValue({ open: openMock, pending: null })

import { api } from '../../hooks/useApi'

vi.stubGlobal('matchMedia', () => ({
  matches: false,
  media: '',
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
}))

const session = {
  id: 'sess-1',
  title: 'Test Session',
  cwd: '/tmp/project',
  running: true,
  working: false,
  terminated: false,
  error: undefined,
  model: 'test-model',
  permissionMode: 'default',
  messageCount: 1,
  subscribers: 0,
  createdAt: 1,
  lastActivityAt: 1,
  phase: 'idle',
} as SessionInfo

const baseProps: SessionContextMenuProps = {
  anchor: { x: 10, y: 10, id: session.id },
  session,
  isOpen: false,
  onClose: vi.fn(),
  onRename: vi.fn(),
  onClosePanel: vi.fn(),
  onDelete: vi.fn(),
  onSleep: vi.fn(),
  onFork: vi.fn(),
  onNewLikeThis: vi.fn(),
  onRestart: vi.fn(),
  groups: [],
  onAddToGroup: vi.fn(),
  maxGroupSize: 3,
}

type ConfirmConfig = NonNullable<SessionContextMenuProps['onAskConfirm']> extends (config: infer C) => void ? C : never

beforeEach(() => {
  vi.clearAllMocks()
})

describe('SessionContextMenu delete warning', () => {
  const wtSession = () => ({
    ...session,
    worktree: { mainRepoPath: '/home/user/main-repo', branch: 'crw/abc12345', baseSha: 'deadbeef' },
  } as SessionInfo)

  const openDelete = async (s: SessionInfo) => {
    const onAskConfirm = vi.fn()
    render(<SessionContextMenu {...baseProps} session={s} onAskConfirm={onAskConfirm} />)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete session' }))
    await waitFor(() => expect(onAskConfirm).toHaveBeenCalled())
    return onAskConfirm.mock.calls[0][0] as ConfirmConfig
  }

  it('appends the dirty-worktree warning to the confirm message', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      available: true,
      dirty: true,
      branch: 'crw/abc12345',
    })

    const config = await openDelete(wtSession())

    expect(api.get).toHaveBeenCalledWith('/sessions/sess-1/worktree-status')
    render(<>{config.message}</>)
    expect(screen.getByText(/uncommitted changes/)).toBeTruthy()
    expect(screen.getByText(/crw\/abc12345/)).toBeTruthy()
  })

  it('omits the warning when the worktree is clean', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      available: true,
      dirty: false,
      branch: 'crw/abc12345',
    })

    const config = await openDelete(wtSession())

    render(<>{config.message}</>)
    expect(screen.queryByText(/uncommitted changes/)).toBeNull()
  })

  it('does not probe worktree status for a non-isolated session', async () => {
    const config = await openDelete(session)

    expect(api.get).not.toHaveBeenCalled()
    render(<>{config.message}</>)
    expect(screen.queryByText(/uncommitted changes/)).toBeNull()
  })
})

describe('SessionContextMenu delete actions', () => {
  it('ordinary delete confirms without the transcript-deletion option', async () => {
    const onDelete = vi.fn()
    const onAskConfirm = vi.fn()
    render(<SessionContextMenu {...baseProps} onDelete={onDelete} onAskConfirm={onAskConfirm} />)

    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete session' }))
    await waitFor(() => expect(onAskConfirm).toHaveBeenCalledTimes(1))
    const config = onAskConfirm.mock.calls[0][0] as ConfirmConfig
    await config.onConfirm()

    expect(onDelete).toHaveBeenCalledWith(session.id)
    expect(onDelete.mock.calls[0]).toHaveLength(1)
  })

  it('permanent delete confirms and opts into transcript deletion', async () => {
    const onDelete = vi.fn()
    const onAskConfirm = vi.fn()
    render(<SessionContextMenu {...baseProps} onDelete={onDelete} onAskConfirm={onAskConfirm} />)

    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete permanently' }))
    await waitFor(() => expect(onAskConfirm).toHaveBeenCalledTimes(1))
    const config = onAskConfirm.mock.calls[0][0] as ConfirmConfig
    expect(config.title).toBe('Permanently delete session?')
    expect(config.confirmLabel).toBe('Delete permanently')
    render(<>{config.message}</>)
    expect(screen.getByText(/subagent transcripts/i)).toBeTruthy()
    await config.onConfirm()

    expect(onDelete).toHaveBeenCalledWith(session.id, { deleteTranscript: true })
  })
})

// The "Open in …" group: server-side directory launching for the session's
// cwd (same open-path routes as the project popover). Three gates must ALL
// pass for the group to render: loopback capability, per-target availability
// on the server machine, and a session cwd to open. The launch goes through
// useOpenPath (in-flight guard + outcome), with failures surfaced as toasts.
describe('SessionContextMenu open-in group', () => {
  // jsdom's navigator.platform is '' (generic wording); these tests use the
  // mac wording throughout, so pin a mac platform for the describe.
  beforeEach(() => {
    Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true })
  })

  const renderMenu = (overrides: Partial<SessionContextMenuProps> = {}) =>
    render(<SessionContextMenu {...baseProps} {...overrides} />)

  const enableAll = (): void => {
    vi.mocked(useOpenPathCapability).mockReturnValue(true)
    vi.mocked(useOpenPathApps).mockReturnValue(['vscode', 'cursor', 'zed', 'iterm2', 'windowsterminal'])
  }

  it('renders Finder/Terminal plus every available brand app', () => {
    enableAll()
    renderMenu()
    for (const label of [
      'Reveal in Finder',
      'Open in Terminal',
      'Open in VS Code',
      'Open in Cursor',
      'Open in Zed',
      'Open in iTerm2',
      'Open in Windows Terminal',
    ]) {
      expect(screen.getByRole('menuitem', { name: label })).toBeTruthy()
    }
  })

  it('hides the whole group when the capability probe is not local', () => {
    enableAll()
    vi.mocked(useOpenPathCapability).mockReturnValue(false)
    renderMenu()
    expect(screen.queryByRole('menuitem', { name: 'Reveal in Finder' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Open in VS Code' })).toBeNull()
  })

  it('hides the whole group while the probes are in flight', () => {
    vi.mocked(useOpenPathCapability).mockReturnValue(null)
    vi.mocked(useOpenPathApps).mockReturnValue(null)
    renderMenu()
    expect(screen.queryByRole('menuitem', { name: 'Open in VS Code' })).toBeNull()
  })

  it('hides the whole group when the session has no cwd', () => {
    enableAll()
    renderMenu({ session: { ...session, cwd: undefined } as SessionInfo })
    expect(screen.queryByRole('menuitem', { name: 'Open in VS Code' })).toBeNull()
  })

  it('offers only the targets the server reports available', () => {
    enableAll()
    vi.mocked(useOpenPathApps).mockReturnValue(['vscode'])
    renderMenu()
    expect(screen.getByRole('menuitem', { name: 'Open in VS Code' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: 'Open in Cursor' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Open in iTerm2' })).toBeNull()
  })

  it('launches the session cwd through the shared open helper', async () => {
    enableAll()
    openMock.mockResolvedValue({ ok: true })
    renderMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in VS Code' }))
    await waitFor(() => expect(openMock).toHaveBeenCalledWith('vscode', '/tmp/project'))
  })

  it('toasts a launch failure', async () => {
    enableAll()
    const showToast = vi.fn()
    openMock.mockResolvedValue({ ok: false, message: 'failed to open' })
    render(
      <ToastShowContext.Provider value={showToast}>
        <SessionContextMenu {...baseProps} />
      </ToastShowContext.Provider>,
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in Zed' }))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('error', expect.stringContaining('failed to open')))
  })

  it('disables the entries while a launch is pending', () => {
    enableAll()
    vi.mocked(useOpenPath).mockReturnValue({ open: openMock, pending: 'vscode' })
    renderMenu()
    // ContextMenu renders disabled items with the real `disabled` attribute.
    expect(screen.getByRole('menuitem', { name: 'Open in VS Code' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('menuitem', { name: 'Reveal in Finder' }).hasAttribute('disabled')).toBe(true)
  })

  it('uses mac wording on a mac client', () => {
    enableAll()
    renderMenu()
    expect(screen.getByRole('menuitem', { name: 'Reveal in Finder' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Open in Terminal' })).toBeTruthy()
    // Non-mac clients get the generic file-manager wording instead.
    Object.defineProperty(window.navigator, 'platform', { value: 'Win32', configurable: true })
    renderMenu()
    expect(screen.getByRole('menuitem', { name: 'Open in file manager' })).toBeTruthy()
    Object.defineProperty(window.navigator, 'platform', { value: '', configurable: true })
  })
})
