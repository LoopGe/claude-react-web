import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'
import { SessionList } from '../SessionList'
import { ToastProvider } from '../ToastProvider'
import { ToastHost } from '../ToastHost'
import type { SessionInfo } from '../../types'

// Renaming a session is reachable from two places and both must behave the
// same: the SettingsPanel title field already toasts on failure, while the
// sidebar's inline rename used to swallow it into console.warn and leave the
// card silently back on its old title. This pins the sidebar path to the same
// contract: surface the error, and don't send (or toast) at all for a no-op
// edit.

vi.mock('../../hooks/useApi', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}))

import { api } from '../../hooks/useApi'
// Virtuoso needs real DOM dimensions to decide which rows are visible, which
// jsdom does not provide. Render the whole list instead -- this test is about
// the rename commit path, not virtualisation. Same approach as
// MessageList.test.tsx.
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

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 'sess-1',
    title: 'Old Title',
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

function renderList(session: SessionInfo) {
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
      />
      <ToastHost />
    </ToastProvider>,
  )
}

/** Drive the context menu → Rename → type → Enter path. */
function renameTo(container: HTMLElement, next: string) {
  const card = container.querySelector('.session-item')
  expect(card, 'session card rendered').not.toBeNull()
  fireEvent.contextMenu(card!)
  // SessionContextMenu portals to document.body (ContextMenu.tsx:145), so the
  // menu items are not inside the render container.
  const item = [...document.body.querySelectorAll('[role="menuitem"], .menu-item, button')]
    .find((el) => /rename/i.test(el.textContent ?? ''))
  expect(item, 'Rename menu item').toBeTruthy()
  fireEvent.click(item!)
  const input = container.querySelector<HTMLInputElement>('.session-item-rename-input')
  expect(input, 'rename input opened').not.toBeNull()
  fireEvent.change(input!, { target: { value: next } })
  fireEvent.keyDown(input!, { key: 'Enter' })
}

describe('SessionList inline rename', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('surfaces the failure instead of swallowing it when the PATCH rejects', async () => {
    ;(api.patch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { container } = renderList(makeSession())

    renameTo(container, 'New Title')

    await waitFor(() => {
      expect(container.querySelector('.toast-error')).not.toBeNull()
    })
    expect(container.querySelector('.toast-error')!.textContent).toMatch(/rename/i)
    warn.mockRestore()
  })

  it('does not send a PATCH for a no-op edit (click in, click away)', async () => {
    const patch = api.patch as ReturnType<typeof vi.fn>
    const { container } = renderList(makeSession({ title: 'Same Name' }))

    // Open rename and commit WITHOUT changing the text.
    const card = container.querySelector('.session-item')
    fireEvent.contextMenu(card!)
    const item = [...document.body.querySelectorAll('[role="menuitem"], .menu-item, button')]
      .find((el) => /rename/i.test(el.textContent ?? ''))
    fireEvent.click(item!)
    const input = container.querySelector<HTMLInputElement>('.session-item-rename-input')
    fireEvent.change(input!, { target: { value: 'Same Name' } })
    fireEvent.keyDown(input!, { key: 'Enter' })

    // Give any queued promise a chance to run.
    await new Promise((r) => setTimeout(r, 0))
    expect(patch).not.toHaveBeenCalled()
    expect(container.querySelector('.toast-error')).toBeNull()
  })

  it('trims the title before sending and skips when only whitespace changed', async () => {
    const patch = api.patch as ReturnType<typeof vi.fn>
    patch.mockResolvedValue({ session: makeSession({ title: 'Padded' }) })
    const { container } = renderList(makeSession({ title: 'Padded' }))

    renameTo(container, '   Padded   ')
    await new Promise((r) => setTimeout(r, 0))

    // Whitespace-only change is a no-op: nothing sent, no toast.
    expect(patch).not.toHaveBeenCalled()
    expect(container.querySelector('.toast-error')).toBeNull()
  })


  it('sends a whitespace-tidying edit to a padded stored title', async () => {
    const patch = api.patch as ReturnType<typeof vi.fn>
    patch.mockResolvedValue({ session: makeSession({ title: 'Foo' }) })
    // Stored title has padding. Deleting it is a real change to the stored
    // value and must reach the server -- comparing trimmed-to-trimmed would
    // silently drop it.
    const { container } = renderList(makeSession({ title: '  Foo  ' }))

    renameTo(container, 'Foo')
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
    expect(patch.mock.calls[0][1]).toEqual({ title: 'Foo' })
  })

  it('re-asserting the opened value is still sent when the title changed underneath', async () => {
    const patch = api.patch as ReturnType<typeof vi.fn>
    patch.mockResolvedValue({ session: makeSession({ title: 'Old Name' }) })
    const { container } = renderList(makeSession({ title: 'New Name' }))

    // The card currently shows "New Name" (another surface renamed it), but
    // the user wants "Old Name". The no-op guard must compare against the LIVE
    // title, not the one captured when the field opened.
    renameTo(container, 'Old Name')
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
    expect(patch.mock.calls[0][1]).toEqual({ title: 'Old Name' })
  })

  it('keeps the typed title editable when the PATCH fails', async () => {
    ;(api.patch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { container } = renderList(makeSession())

    renameTo(container, 'Carefully Typed Title')

    await waitFor(() => {
      expect(container.querySelector('.toast-error')).not.toBeNull()
    })
    // The editor comes back with the text the user typed, not a reset card.
    const input = container.querySelector<HTMLInputElement>('.session-item-rename-input')
    expect(input, 'rename input reopened on failure').not.toBeNull()
    expect(input!.value).toBe('Carefully Typed Title')
    vi.restoreAllMocks()
  })


  it('typing a space in the rename field does not open the session', () => {
    // The card is role="button" with onKeyDown(Enter|Space -> onSelect). The
    // rename input must swallow those keys, or typing a multi-word title
    // fires onSelect on every space and replaces the open panels.
    const onSelect = vi.fn()
    const { container } = render(
      <ToastProvider>
        <SessionList
          sessions={[makeSession()]}
          sessionsLoaded
          openIds={['other-1', 'other-2']}
          focusedId="other-1"
          defaults={{}}
          resumingIds={new Set<string>()}
          unread={{}}
          deletingIds={new Set<string>()}
          groups={[]}
          sidebarSections={[]}
          collapsedGroups={{}}
          maxGroupSize={3}
          onSelect={onSelect}
          onCreate={() => {}}
          onDelete={() => {}}
          onSleep={() => {}}
          onActivateGroup={() => {}}
          onCreateGroup={() => 'g1'}
          onDeleteGroup={() => {}}
          onRenameGroup={() => {}}
          onAddToGroup={() => {}}
          onToggleGroupCollapse={() => {}}
        />
        <ToastHost />
      </ToastProvider>,
    )

    fireEvent.contextMenu(container.querySelector('.session-item')!)
    const item = [...document.body.querySelectorAll('[role="menuitem"], .menu-item, button')]
      .find((el) => /rename/i.test(el.textContent ?? ''))
    fireEvent.click(item!)
    const input = container.querySelector<HTMLInputElement>('.session-item-rename-input')!
    fireEvent.change(input, { target: { value: 'My New Name' } })
    fireEvent.keyDown(input, { key: ' ' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("does not revert another surface's rename when the user types nothing", async () => {
    const patch = api.patch as ReturnType<typeof vi.fn>
    // The field opens showing "New Name" (already renamed elsewhere). The user
    // clicks away without typing — that must NOT send the stale draft.
    const { container } = renderList(makeSession({ title: 'New Name' }))

    const card = container.querySelector('.session-item')
    fireEvent.contextMenu(card!)
    const item = [...document.body.querySelectorAll('[role="menuitem"], .menu-item, button')]
      .find((el) => /rename/i.test(el.textContent ?? ''))
    fireEvent.click(item!)
    const input = container.querySelector<HTMLInputElement>('.session-item-rename-input')!
    expect(input.value).toBe('New Name')
    fireEvent.blur(input)

    await new Promise((r) => setTimeout(r, 0))
    expect(patch).not.toHaveBeenCalled()
    expect(container.querySelector('.toast-error')).toBeNull()
  })

  it('a late failure does not steal the editor from a newer rename', async () => {
    let rejectFirst: (e: Error) => void = () => {}
    const patch = api.patch as ReturnType<typeof vi.fn>
    patch.mockImplementationOnce(() => new Promise((_r, rej) => { rejectFirst = rej }))
    patch.mockResolvedValue({ session: makeSession({ title: 'B Title' }) })
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { container } = renderList(makeSession())
    // Commit a rename whose PATCH will fail later.
    renameTo(container, 'A Title')
    // renameTo already pressed Enter, so A's PATCH is in flight and the
    // editor is closed. The user immediately starts renaming again.
    fireEvent.contextMenu(container.querySelector('.session-item')!)
    const item = [...document.body.querySelectorAll('[role="menuitem"], .menu-item, button')]
      .find((el) => /rename/i.test(el.textContent ?? ''))
    fireEvent.click(item!)
    const input2 = container.querySelector<HTMLInputElement>('.session-item-rename-input')!
    fireEvent.change(input2, { target: { value: 'B Title' } })

    // Now the first PATCH fails. It must not reopen the editor over B.
    rejectFirst(new Error('boom'))
    await new Promise((r) => setTimeout(r, 0))

    const current = container.querySelector<HTMLInputElement>('.session-item-rename-input')
    expect(current, 'the newer rename keeps the editor').not.toBeNull()
    expect(current!.value).toBe('B Title')
    vi.restoreAllMocks()
  })

  it('sends the trimmed title for a real change', async () => {
    const patch = api.patch as ReturnType<typeof vi.fn>
    patch.mockResolvedValue({ session: makeSession({ title: 'Trimmed' }) })
    const { container } = renderList(makeSession())

    renameTo(container, '  Trimmed  ')
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
    expect(patch.mock.calls[0][0]).toBe('/sessions/sess-1')
    expect(patch.mock.calls[0][1]).toEqual({ title: 'Trimmed' })
  })
})
