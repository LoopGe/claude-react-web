import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor, fireEvent, act } from '@testing-library/react'
import { ChatEmptyStateEnv } from './ChatEmptyStateEnv'

// Cleanup is registered globally in src/test-setup.ts — do not re-add a
// per-file afterEach(cleanup) (CLAUDE.md).

vi.mock('../hooks/useApi', () => ({
  api: { get: vi.fn(), post: vi.fn() },
}))

vi.mock('../hooks/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn() }),
}))

import { api } from '../hooks/useApi'

const getMock = api.get as ReturnType<typeof vi.fn>
const postMock = api.post as ReturnType<typeof vi.fn>

function mockLookups(plugins: Array<{ key: string; name: string; marketplace: string }>, statuses: Array<{ name: string; status: string }>) {
  getMock.mockImplementation((url: string) => {
    if (url === '/mp/enabled-plugins') return Promise.resolve({ plugins })
    if (url.startsWith('/sessions/') && url.endsWith('/mcp-status')) return Promise.resolve({ mcp: statuses })
    return Promise.resolve({})
  })
}

describe('ChatEmptyStateEnv display (static tier)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    postMock.mockResolvedValue({ ok: true })
    mockLookups([], [])
  })

  it('renders MCP server chips when the session was spawned with servers', async () => {
    const { baseElement } = render(<ChatEmptyStateEnv mcpServerNames={['github', 'fs']} />)
    await waitFor(() => expect(baseElement.textContent).toContain('github'))
    expect(baseElement.textContent).toContain('fs')
    expect(baseElement.textContent).toContain('MCP')
    expect(baseElement.querySelector('.chat-empty-env-chip')).toBeTruthy()
  })

  it('hides the MCP row for undefined and empty mcpServerNames', async () => {
    // Explicit subset so the plugins row still shows — proving the absence
    // of the MCP label is the MCP row hiding, not the whole component.
    const a = render(<ChatEmptyStateEnv enabledPlugins={['plugA@mp1']} />)
    expect(a.baseElement.textContent).not.toContain('MCP')
    a.unmount()
    const b = render(<ChatEmptyStateEnv mcpServerNames={[]} />)
    expect(b.baseElement.textContent).not.toContain('MCP')
  })

  it('expands enabledPlugins=undefined to every globally enabled plugin', async () => {
    mockLookups([
      { key: 'plugA@mp1', name: 'PlugA', marketplace: 'mp1' },
      { key: 'plugB@mp1', name: 'PlugB', marketplace: 'mp1' },
    ], [])
    const { baseElement } = render(<ChatEmptyStateEnv />)
    // "undefined = all enabled" can only be resolved from the global list,
    // so the row stays hidden until the lookup lands.
    expect(baseElement.querySelector('.chat-empty-env')).toBeNull()
    await waitFor(() => expect(baseElement.textContent).toContain('PlugA'))
    expect(baseElement.textContent).toContain('PlugB')
    expect(baseElement.textContent).toContain('Plugins')
  })

  it('shows raw keys for an explicit plugin subset, then swaps in friendly names', async () => {
    mockLookups([{ key: 'plugB@mp1', name: 'PlugB', marketplace: 'mp1' }], [])
    const { baseElement } = render(<ChatEmptyStateEnv enabledPlugins={['plugB@mp1', 'ghost@old']} />)
    // Raw keys render immediately — no waiting on the lookup
    expect(baseElement.textContent).toContain('plugB@mp1')
    expect(baseElement.textContent).toContain('ghost@old')
    // Friendly name replaces the key once the global list lands ('PlugB'
    // differs in case from the raw key, so the swap is observable)
    await waitFor(() => expect(baseElement.textContent).toContain('PlugB'))
    expect(baseElement.textContent).not.toContain('plugB@mp1')
    // Key missing from the global list (marketplace removed) keeps the raw key
    expect(baseElement.textContent).toContain('ghost@old')
  })

  it('renders nothing when neither field has anything to show', async () => {
    const a = render(<ChatEmptyStateEnv />)
    await waitFor(() => expect(getMock).toHaveBeenCalled())
    expect(a.baseElement.querySelector('.chat-empty-env')).toBeNull()
    a.unmount()
    // Count from here — the spy is shared, and render `a` already fetched.
    const callsBefore = getMock.mock.calls.length
    const b = render(<ChatEmptyStateEnv mcpServerNames={[]} enabledPlugins={[]} />)
    // Explicit [] skips the lookup entirely — the row is hidden regardless
    expect(getMock.mock.calls.length).toBe(callsBefore)
    expect(b.baseElement.querySelector('.chat-empty-env')).toBeNull()
  })

  it('hides the plugins row when the lookup fails and enabledPlugins is undefined', async () => {
    getMock.mockRejectedValue(new Error('lookup down'))
    const { baseElement } = render(<ChatEmptyStateEnv mcpServerNames={['github']} />)
    expect(baseElement.textContent).toContain('github') // MCP row unaffected
    await waitFor(() => expect(getMock).toHaveBeenCalled())
    expect(baseElement.textContent).not.toContain('Plugins')
  })

  it('keeps raw keys when the lookup fails for an explicit subset', async () => {
    getMock.mockRejectedValue(new Error('lookup down'))
    const { baseElement } = render(<ChatEmptyStateEnv enabledPlugins={['plugA@mp1']} />)
    await waitFor(() => expect(getMock).toHaveBeenCalled())
    expect(baseElement.textContent).toContain('plugA@mp1')
  })

  it('co-renders both rows with MCP first when both fields carry data', async () => {
    mockLookups([{ key: 'plugA@mp1', name: 'PlugA', marketplace: 'mp1' }], [])
    const { baseElement } = render(
      <ChatEmptyStateEnv mcpServerNames={['github']} enabledPlugins={['plugA@mp1']} />,
    )
    await waitFor(() => expect(baseElement.textContent).toContain('PlugA'))
    const rows = baseElement.querySelectorAll('.chat-empty-env-row')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('MCP')
    expect(rows[0].textContent).toContain('github')
    expect(rows[1].textContent).toContain('Plugins')
    expect(rows[1].textContent).toContain('PlugA')
  })
})

describe('ChatEmptyStateEnv quick actions (live tier)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    postMock.mockResolvedValue({ ok: true })
    mockLookups([], [{ name: 'github', status: 'connected' }])
  })

  it('shows a status dot once the mcp-status lookup reports (running only)', async () => {
    const { baseElement } = render(
      <ChatEmptyStateEnv mcpServerNames={['github']} sessionId="s1" running />,
    )
    await waitFor(() =>
      expect(baseElement.querySelector('.chat-empty-env-dot')?.getAttribute('data-status')).toBe('connected'),
    )
  })

  it('shows a pulsing loading placeholder dot while the lookup is in flight', async () => {
    // Deferred lookup: the fetch is in flight for as long as we hold release.
    let release!: (v: { mcp: Array<{ name: string; status: string }> }) => void
    getMock.mockImplementation((url: string) => {
      if (String(url).endsWith('/mcp-status')) {
        return new Promise((res) => { release = res })
      }
      return Promise.resolve({ plugins: [] })
    })
    const { baseElement } = render(
      <ChatEmptyStateEnv mcpServerNames={['github']} sessionId="s1" running />,
    )
    // In flight → pulsing placeholder (not a resolved color)
    await waitFor(() =>
      expect(baseElement.querySelector('.chat-empty-env-dot')?.getAttribute('data-status')).toBe('loading'),
    )
    act(() => { release({ mcp: [{ name: 'github', status: 'connected' }] }) })
    // Landed → the real status takes over
    await waitFor(() =>
      expect(baseElement.querySelector('.chat-empty-env-dot')?.getAttribute('data-status')).toBe('connected'),
    )
  })

  it('never fetches mcp-status for a dormant session', async () => {
    const { baseElement } = render(
      <ChatEmptyStateEnv mcpServerNames={['github']} sessionId="s1" running={false} />,
    )
    await waitFor(() => expect(baseElement.textContent).toContain('github'))
    const statusCalls = getMock.mock.calls.filter((c) => String(c[0]).endsWith('/mcp-status'))
    expect(statusCalls).toHaveLength(0)
    expect(baseElement.querySelector('.chat-empty-env-dot')).toBeNull()
  })

  it('opens the quick menu on chip click and offers Disable + Reconnect', async () => {
    const { baseElement } = render(
      <ChatEmptyStateEnv mcpServerNames={['github']} sessionId="s1" running />,
    )
    await waitFor(() => expect(baseElement.querySelector('.chat-empty-env-dot')).toBeTruthy())
    fireEvent.click(baseElement.querySelector('.chat-empty-env-chip')!)
    await waitFor(() => {
      const labels = Array.from(document.querySelectorAll('.ctx-menu-item')).map((b) => b.textContent)
      expect(labels).toContain('Disable')
      expect(labels).toContain('Reconnect')
    })
  })

  it('offers both Enable and Disable when the status is unknown (silent degrade)', async () => {
    // The mcp-status lookup reports a DIFFERENT server — for 'github' the
    // status is unknown. Guessing 'Disable' would no-op precisely the
    // server the user most likely came to fix, so both actions show.
    mockLookups([], [{ name: 'other', status: 'connected' }])
    const { baseElement } = render(
      <ChatEmptyStateEnv mcpServerNames={['github']} sessionId="s1" running />,
    )
    await waitFor(() => expect(baseElement.textContent).toContain('github'))
    // Deterministic branch: wait until the lookup has LANDED (otherwise the
    // pre-data statuses={} path renders the same two items and the test
    // would pass without exercising the scenario its comment describes).
    await waitFor(() =>
      expect(getMock.mock.calls.some((c) => String(c[0]).endsWith('/mcp-status'))).toBe(true),
    )
    fireEvent.click(baseElement.querySelector('.chat-empty-env-chip')!)
    await waitFor(() => {
      const labels = Array.from(document.querySelectorAll('.ctx-menu-item')).map((b) => b.textContent)
      expect(labels).toContain('Enable')
      expect(labels).toContain('Disable')
      expect(labels).toContain('Reconnect')
    })
  })

  it('Disable posts toggle enabled:false and refreshes the statuses', async () => {
    const { baseElement } = render(
      <ChatEmptyStateEnv mcpServerNames={['github']} sessionId="s1" running />,
    )
    await waitFor(() => expect(baseElement.querySelector('.chat-empty-env-dot')).toBeTruthy())
    const statusCallsBefore = getMock.mock.calls.filter((c) => String(c[0]).endsWith('/mcp-status')).length
    fireEvent.click(baseElement.querySelector('.chat-empty-env-chip')!)
    const disable = Array.from(document.querySelectorAll('.ctx-menu-item'))
      .find((b) => b.textContent === 'Disable')! as HTMLElement
    fireEvent.click(disable)
    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/sessions/s1/mcp/github/toggle', { enabled: false }))
    // Two re-reads land: one when the menu opened (stale-snapshot guard) and
    // one after the toggle posted, so the dot reflects the new state.
    await waitFor(() =>
      expect(getMock.mock.calls.filter((c) => String(c[0]).endsWith('/mcp-status'))).toHaveLength(statusCallsBefore + 2),
    )
  })

  it('Enable posts toggle enabled:true for a disabled server', async () => {
    mockLookups([], [{ name: 'github', status: 'disabled' }])
    const { baseElement } = render(
      <ChatEmptyStateEnv mcpServerNames={['github']} sessionId="s1" running />,
    )
    await waitFor(() =>
      expect(baseElement.querySelector('.chat-empty-env-dot')?.getAttribute('data-status')).toBe('disabled'),
    )
    fireEvent.click(baseElement.querySelector('.chat-empty-env-chip')!)
    const enable = Array.from(document.querySelectorAll('.ctx-menu-item'))
      .find((b) => b.textContent === 'Enable')! as HTMLElement
    fireEvent.click(enable)
    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/sessions/s1/mcp/github/toggle', { enabled: true }))
  })

  it('renders display-only chips (spans) when running is false', () => {
    const { baseElement } = render(<ChatEmptyStateEnv mcpServerNames={['github']} sessionId="s1" running={false} />)
    // Display-only = span, not button
    expect(baseElement.querySelector('button.chat-empty-env-chip')).toBeNull()
    expect(baseElement.querySelector('span.chat-empty-env-chip')).toBeTruthy()
  })
})
