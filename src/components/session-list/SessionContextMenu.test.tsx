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

  // The open-in group is a submenu: every assertion below must open the
  // flyout (click the parent row) before querying the leaf rows.
  const openFlyout = (): void => {
    const parent = [...document.querySelectorAll('.ctx-menu > .ctx-menu-item')].find(
      (b) => b.querySelector('.ctx-menu-label')?.textContent === 'Open in',
    )
    if (parent) fireEvent.click(parent)
  }

  const enableAll = (): void => {
    vi.mocked(useOpenPathCapability).mockReturnValue(true)
    vi.mocked(useOpenPathApps).mockReturnValue(['vscode', 'cursor', 'zed', 'iterm2', 'windowsterminal'])
  }

  it('renders an Open-in parent plus every available app in its flyout', () => {
    enableAll()
    renderMenu()
    expect(screen.getByRole('menuitem', { name: 'Open in' })).toBeTruthy()
    openFlyout()
    const flyout = document.querySelector('.ctx-submenu')!
    const labels = [...flyout.querySelectorAll('.ctx-menu-label')].map((e) => e.textContent)
    expect(labels).toEqual([
      'Reveal in Finder',
      'Open in Terminal',
      'Open in VS Code',
      'Open in Cursor',
      'Open in Zed',
      'Open in iTerm2',
      'Open in Windows Terminal',
    ])
  })

  it('keeps the parent with just the OS-generic rows when no app is available', () => {
    enableAll()
    vi.mocked(useOpenPathApps).mockReturnValue([])
    renderMenu()
    openFlyout()
    const flyout = document.querySelector('.ctx-submenu')!
    const labels = [...flyout.querySelectorAll('.ctx-menu-label')].map((e) => e.textContent)
    expect(labels).toEqual(['Reveal in Finder', 'Open in Terminal'])
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
    openFlyout()
    expect(screen.getByRole('menuitem', { name: 'Open in VS Code' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: 'Open in Cursor' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Open in iTerm2' })).toBeNull()
  })

  it('launches the session cwd through the shared open helper', async () => {
    enableAll()
    openMock.mockResolvedValue({ ok: true })
    renderMenu()
    openFlyout()
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
    openFlyout()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in Zed' }))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('error', expect.stringContaining('failed to open')))
  })

  it('disables the flyout rows while a launch is pending (parent stays openable)', () => {
    enableAll()
    vi.mocked(useOpenPath).mockReturnValue({ open: openMock, pending: 'vscode' })
    renderMenu()
    openFlyout()
    // ContextMenu renders disabled items with the real `disabled` attribute.
    expect(screen.getByRole('menuitem', { name: 'Open in VS Code' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('menuitem', { name: 'Reveal in Finder' }).hasAttribute('disabled')).toBe(true)
    // Opening the flyout is still possible — only launching is blocked.
    expect(screen.getByRole('menuitem', { name: 'Open in' }).hasAttribute('disabled')).toBe(false)
  })

  it('uses mac wording on a mac client', () => {
    enableAll()
    const first = renderMenu()
    openFlyout()
    expect(screen.getByRole('menuitem', { name: 'Reveal in Finder' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Open in Terminal' })).toBeTruthy()
    first.unmount()
    // Non-mac clients get the generic file-manager wording instead.
    Object.defineProperty(window.navigator, 'platform', { value: 'Win32', configurable: true })
    const second = renderMenu()
    openFlyout()
    expect(screen.getByRole('menuitem', { name: 'Open in file manager' })).toBeTruthy()
    second.unmount()
    Object.defineProperty(window.navigator, 'platform', { value: '', configurable: true })
  })
})

// The group actions: "Remove from group" stays a flat row; "Move to group"
// is a real submenu (children) — the old flat rows with padded labels
// ('  name (n/m)') and a disabled header row are gone.
describe('SessionContextMenu move-to-group submenu', () => {
  const groupProps = {
    groups: [
      { id: 'g-alpha', name: 'Alpha', sessionIds: ['other-1'] },
      { id: 'g-beta', name: 'Beta', sessionIds: ['x', 'y', 'z'] }, // full at maxGroupSize 3
      { id: 'g-gamma', name: 'Gamma', sessionIds: [] },
    ],
  }

  const openMoveToGroup = (): HTMLElement => {
    const parent = [...document.querySelectorAll('.ctx-menu > .ctx-menu-item')].find(
      (b) => b.querySelector('.ctx-menu-label')?.textContent === 'Move to group',
    )!
    fireEvent.click(parent)
    return document.querySelector('.ctx-submenu')!
  }

  it('renders Move to group as a submenu parent with one child per available group', () => {
    render(<SessionContextMenu {...baseProps} {...groupProps} />)
    openMoveToGroup()
    const labels = [...document.querySelector('.ctx-submenu')!.querySelectorAll('.ctx-menu-label')]
      .map((e) => e.textContent)
    // The full group (Beta) is not offered; no padded labels, no header row.
    expect(labels).toEqual(['Alpha (1/3)', 'Gamma (0/3)'])
  })

  it('calls onAddToGroup with the picked group id and closes the menu', () => {
    const onAddToGroup = vi.fn()
    const onClose = vi.fn()
    render(<SessionContextMenu {...baseProps} {...groupProps} onAddToGroup={onAddToGroup} onClose={onClose} />)
    openMoveToGroup()
    const gamma = [...document.querySelector('.ctx-submenu')!.querySelectorAll<HTMLButtonElement>('.ctx-menu-item')]
      .find((b) => b.querySelector('.ctx-menu-label')?.textContent === 'Gamma (0/3)')!
    fireEvent.click(gamma)
    expect(onAddToGroup).toHaveBeenCalledWith('sess-1', 'g-gamma')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('keeps Remove from group a flat row above the submenu parent', () => {
    render(
      <SessionContextMenu
        {...baseProps}
        {...groupProps}
        groups={[{ id: 'g-mine', name: 'Mine', sessionIds: ['sess-1'] }, ...groupProps.groups]}
      />,
    )
    const labels = [...document.querySelectorAll('.ctx-menu > .ctx-menu-item .ctx-menu-label')]
      .map((e) => e.textContent)
    expect(labels).toContain('Remove from group')
    expect(labels).toContain('Move to group')
    // The flyout itself stays closed until opened.
    expect(document.querySelector('.ctx-submenu')).toBeNull()
  })

  it('omits Move to group entirely when every group is full', () => {
    render(
      <SessionContextMenu
        {...baseProps}
        groups={[{ id: 'g-full', name: 'Full', sessionIds: ['a', 'b', 'c'] }]}
      />,
    )
    expect(screen.queryByRole('menuitem', { name: 'Move to group' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Remove from group' })).toBeNull()
  })
})
