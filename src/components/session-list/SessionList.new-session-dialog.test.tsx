import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionList } from '../SessionList'
import { ToastProvider } from '../ToastProvider'
import { clearResizeObserverStub, stubResizeObserver } from '../../test/resize-observer-stub'

// Virtuoso needs real DOM dimensions; render its rows directly (same stub as
// SessionList.context-menu.test.tsx) so the real SessionList composition runs.
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

// The real NewSessionDialog fetches MCP/plugin/agent lists on mount; answer
// with empty shapes so it renders without network.
vi.mock('../../hooks/useApi', () => ({
  api: {
    get: vi.fn(async (url: string) => {
      if (url === '/mcp-config') return { servers: [] }
      if (url === '/mp/enabled-plugins') return { plugins: [] }
      if (url === '/agent-definitions') return { agents: [] }
      return {}
    }),
    post: vi.fn(),
  },
}))

vi.mock('../../utils/capped-height-measure', () => ({ measureCappedContentHeight: vi.fn(() => null) }))

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

const groups = [
  { id: 'a', name: 'Alpha', sessionIds: [] },
  { id: 'b', name: 'Beta', sessionIds: [] },
]

function listElement(open: boolean, initialGroupId?: string) {
  return (
    <ToastProvider>
      <SessionList
        sessions={[]}
        sessionsLoaded
        openIds={[]}
        focusedId={null}
        defaults={{}}
        resumingIds={new Set<string>()}
        unread={{}}
        deletingIds={new Set<string>()}
        groups={groups}
        sidebarSections={[]}
        collapsedGroups={{}}
        maxGroupSize={10}
        newSessionDialogOpen={open}
        newSessionInitialGroupId={initialGroupId}
        onNewSessionDialogChange={() => {}}
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
    </ToastProvider>
  )
}

const groupTrigger = () => screen.getByLabelText('Group') as HTMLButtonElement

describe('SessionList new-session dialog per-open remount', () => {
  beforeEach(() => stubResizeObserver())
  afterEach(() => clearResizeObserverStub())

  it('re-seeds the group pre-target on a rapid reopen inside the exit-presence window', async () => {
    const { rerender } = render(listElement(true, 'b'))
    await waitFor(() => expect(groupTrigger().textContent).toContain('Beta'))

    // Close, then reopen with a different pre-target before the 180ms exit
    // timer fires. useExitPresence keeps the old instance mounted; the
    // per-open key must remount the dialog so the new pre-target wins instead
    // of leaking the previous open's pick.
    rerender(listElement(false, 'b'))
    rerender(listElement(true, 'a'))
    await waitFor(() => expect(groupTrigger().textContent).toContain('Alpha'))
  })

  it('clears a pending new-group pick on reopen so it cannot override the pre-target', async () => {
    const { rerender } = render(listElement(true, 'b'))
    await waitFor(() => expect(groupTrigger().textContent).toContain('Beta'))

    // Type a brand-new group name (pending newGroupName), then close and
    // rapidly reopen pre-targeted at Alpha. The stale pending name must not
    // survive to override the explicit pre-target on submit.
    fireEvent.click(groupTrigger())
    fireEvent.change(screen.getByRole('textbox', { name: 'Search groups' }), {
      target: { value: 'Fresh Team' },
    })
    fireEvent.click(
      Array.from(document.querySelectorAll('.field-picker-item')).find((el) =>
        el.textContent?.includes('Create group'),
      )!,
    )
    expect(groupTrigger().textContent).toContain('Fresh Team')

    rerender(listElement(false, 'b'))
    rerender(listElement(true, 'a'))
    await waitFor(() => expect(groupTrigger().textContent).toContain('Alpha'))
    expect(groupTrigger().textContent).not.toContain('Fresh Team')
  })
})
