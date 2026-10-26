import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/react'
import { DesktopTitlebarTabs } from './DesktopTitlebarTabs'
import type { SessionInfo } from '../types'

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 'abc12345-xxxx',
    title: 'Test Session',
    cwd: '/home/user/project',
    running: true,
    working: false,
    terminated: false,
    error: null,
    model: 'claude-sonnet-4-20250514',
    permissionMode: 'default',
    messageCount: 5,
    subscribers: 1,
    lastActivityAt: Date.now(),
    phase: 'idle',
    ...overrides,
  } as SessionInfo
}

function setup(sessions: SessionInfo[] = []) {
  const onNewSession = vi.fn()
  const onCreateGroup = vi.fn()
  const askPrompt = vi.fn() as ReturnType<typeof vi.fn>
  const utils = render(
    <DesktopTitlebarTabs
      sessions={sessions}
      focusedId={null}
      onSelect={vi.fn()}
      onClose={vi.fn()}
      onNewSession={onNewSession}
      onCreateGroup={onCreateGroup}
      askPrompt={askPrompt}
      maxOpen={3}
    />,
  )
  return { onNewSession, onCreateGroup, askPrompt, ...utils }
}

describe('DesktopTitlebarTabs', () => {
  it('empty state: + opens the create menu instead of creating a session', () => {
    const { onNewSession } = setup([])
    const plus = screen.getByRole('button', { name: 'Create' })
    fireEvent.click(plus)
    expect(onNewSession).not.toHaveBeenCalled()
    const labels = Array.from(document.querySelectorAll('.ctx-menu-label')).map((e) => e.textContent)
    expect(labels).toEqual(['New session…', 'New group…'])
  })

  it('with tabs: + opens the same create menu', () => {
    const { onNewSession } = setup([makeSession({ id: 's1', title: 'Alpha' })])
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(onNewSession).not.toHaveBeenCalled()
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('New session… from the menu fires onNewSession', () => {
    const { onNewSession } = setup([])
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    fireEvent.click(document.querySelectorAll('.ctx-menu-item')[0])
    expect(onNewSession).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('New group… from the menu opens the create prompt', () => {
    const { askPrompt, onCreateGroup } = setup([])
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    fireEvent.click(document.querySelectorAll('.ctx-menu-item')[1])
    expect(askPrompt).toHaveBeenCalledOnce()
    expect(askPrompt.mock.calls[0][0].title).toBe('New group')
    void askPrompt.mock.calls[0][0].onConfirm('G1')
    expect(onCreateGroup).toHaveBeenCalledWith('G1')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('at panel capacity the + stays: New session… is disabled, New group… still works', () => {
    // New group consumes no panel slot — hiding the whole + at maxOpen would
    // make group creation unreachable from the titlebar.
    const sessions = [makeSession({ id: 's1' }), makeSession({ id: 's2' }), makeSession({ id: 's3' })]
    const { onNewSession, askPrompt } = setup(sessions)
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    const items = document.querySelectorAll<HTMLButtonElement>('.ctx-menu-item')
    expect(items[0].disabled).toBe(true)
    expect(items[1].disabled).toBe(false)
    fireEvent.click(items[1])
    expect(askPrompt).toHaveBeenCalledOnce()
    expect(onNewSession).not.toHaveBeenCalled()
  })
})
