import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SessionContextMenu, type SessionContextMenuProps } from './SessionContextMenu'
import type { SessionInfo } from '../../types'

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
