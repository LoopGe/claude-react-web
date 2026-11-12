import { act, fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SessionList } from '../SessionList'
import { ToastProvider } from '../ToastProvider'
import type { SessionInfo } from '../../types'

// Virtuoso needs real DOM dimensions to decide which rows are visible. This
// integration test exercises the real SessionList/menu/hover composition, so
// render its single row directly instead of mocking any of those components.
vi.mock('react-virtuoso', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    Virtuoso: ({
      data,
      itemContent,
    }: {
      data: unknown[]
      itemContent: (index: number, item: unknown) => React.ReactNode
    }) => React.createElement(React.Fragment, null, data.map((item, i) => itemContent(i, item))),
  }
})

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
  cwd: '/home/user/project',
  running: true,
  working: false,
  terminated: false,
  error: undefined,
  model: 'claude-sonnet-4-20250514',
  permissionMode: 'default',
  messageCount: 5,
  subscribers: 1,
  createdAt: Date.now(),
  lastActivityAt: Date.now(),
  phase: 'idle',
} as SessionInfo

function renderList() {
  return render(
    <ToastProvider>
      <SessionList
        sessions={[session]}
        sessionsLoaded
        openIds={[]}
        focusedId={null}
        defaults={{}}
        resumingIds={new Set<string>()}
        unread={{}}
        deletingIds={new Set<string>()}
        groups={[]}
        sidebarSections={[]}
        collapsedGroups={{}}
        maxGroupSize={3}
        onSelect={() => {}}
        onCreate={() => {}}
        onDelete={() => {}}
        onSleep={() => {}}
        onActivateGroup={() => {}}
        onCreateGroup={() => 'g1'}
        onDeleteGroup={() => {}}
        onRenameGroup={() => {}}
        onAddToGroup={() => {}}
        onToggleGroupCollapse={() => {}}
        askConfirm={() => {}}
        askPrompt={() => {}}
      />
    </ToastProvider>,
  )
}

describe('SessionList context menu hover', () => {
  it('suppresses hover only while the session context menu is open', () => {
    vi.useFakeTimers()
    try {
      const { container } = renderList()
      const card = container.querySelector<HTMLElement>('.session-item')!

      fireEvent.pointerEnter(card)
      // Chromium focuses the row on right-click before emitting contextmenu.
      card.focus()
      act(() => {
        vi.advanceTimersByTime(200)
      })
      expect(document.querySelector('.hover-pop')).not.toBeNull()

      fireEvent.contextMenu(card)
      expect(document.querySelector('.ctx-menu')).not.toBeNull()
      expect(document.querySelector('.hover-pop')).toBeNull()

      // The portalled menu can move the pointer back across the underlying
      // row. That must not reopen a second surface above the open menu.
      fireEvent.pointerLeave(card)
      fireEvent.pointerEnter(card)
      act(() => {
        vi.advanceTimersByTime(500)
      })
      expect(document.querySelector('.ctx-menu')).not.toBeNull()
      expect(document.querySelector('.hover-pop')).toBeNull()

      fireEvent.keyDown(document.body, { key: 'Escape' })
      expect(document.querySelector('.ctx-menu')).toBeNull()
      fireEvent.pointerLeave(card)
      fireEvent.pointerEnter(card)
      act(() => {
        vi.advanceTimersByTime(200)
      })
      expect(document.querySelector('.hover-pop')).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
