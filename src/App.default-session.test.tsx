import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfigResponse } from './types/config'
import type { NewSessionForm, SessionInfo } from './types'

const h = vi.hoisted(() => {
  const listeners = new Set<(frame: unknown) => void>()
  const hub = {
    addListener: (fn: (frame: unknown) => void) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    addSessionListener: () => () => undefined,
    subscribe: () => () => undefined,
    subscribeSubagentTranscript: () => () => undefined,
  }
  return {
    listeners,
    hub,
    config: null as ConfigResponse | null,
    refreshedConfig: null as ConfigResponse | null,
    refreshError: null as Error | null,
    fetchConfig: vi.fn(),
    isMobile: false,
    get: vi.fn(),
    post: vi.fn(),
    request: vi.fn(),
    create: vi.fn(),
  }
})

vi.mock('./hooks/useWsHub', () => ({
  useWsHub: () => h.hub,
  useWsHubStatus: () => 'online',
  // useUpdateInfo reads the optional hub for live update-info frames; these
  // tests exercise REST-only session creation, so no hub is mounted.
  useOptionalWsHub: () => null,
}))

vi.mock('./hooks/useIsMobile', () => ({
  useIsMobile: () => h.isMobile,
}))

vi.mock('./state/modelOptionsStore', () => ({
  fetchConfig: h.fetchConfig,
  peekConfig: () => h.config,
  markConfigStale: vi.fn(),
  patchConfigCache: vi.fn(),
  subscribeModelOptions: () => () => undefined,
}))

vi.mock('./hooks/useApi', () => ({
  apiRequest: h.request,
  api: {
    get: h.get,
    post: h.post,
    put: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
  },
}))

vi.mock('./components/SetupPage', () => ({
  SetupPage: ({ onConfigured }: { onConfigured: (value: { openNewSession: boolean }) => Promise<void> }) => (
    <div>
      <button onClick={() => void onConfigured({ openNewSession: true })}>Finish setup</button>
      <button onClick={() => void onConfigured({ openNewSession: false })}>Skip setup</button>
    </div>
  ),
}))

vi.mock('./components/session-list/NewSessionDialog', () => ({
  NewSessionDialog: ({ onSubmit }: { onSubmit: (form: NewSessionForm) => void }) => (
    <div role="dialog" aria-label="New session dialog">
      <button onClick={() => onSubmit({
        provider: 'claude',
        cwd: '/explicit/project',
        model: 'explicit-model',
        permissionMode: 'default',
        groupId: 'g1',
      })}>Submit grouped session</button>
      <button onClick={() => onSubmit({
        provider: 'claude',
        cwd: '/explicit/project',
        model: 'explicit-model',
        permissionMode: 'default',
        newGroupName: 'Team',
      })}>Submit new-group session</button>
    </div>
  ),
}))

vi.mock('./components/ChatPanel', () => ({
  ChatPanel: ({ session, focused, terminalOpen }: { session: SessionInfo; focused: boolean; terminalOpen?: boolean }) => (
    <div
      data-testid="chat-panel"
      data-session-id={session.id}
      data-focused={String(focused)}
      data-terminal-open={String(!!terminalOpen)}
    />
  ),
}))

vi.mock('./components/SessionNavStrip', () => ({
  SessionNavStrip: () => null,
  SessionNavTabGhost: () => null,
  SessionNavChipGhost: () => null,
}))

vi.mock('./components/DesktopTitlebarTabs', () => ({
  DesktopTitlebarTabs: () => null,
}))

import { App } from './App'
import { PluginRegistryProvider } from './app-plugins/PluginRegistryProvider'
import { ToastProvider } from './components/ToastProvider'
import { ToastHost } from './components/ToastHost'
import { ResourcePaneProvider } from './resources/ResourcePaneProvider'

function config(configured: boolean, cwd = '/fresh/default', model = 'fresh-model'): ConfigResponse {
  return {
    configured,
    defaults: { cwd, model },
    models: [model],
    modelGroups: [],
  } as ConfigResponse
}

function session(id: string, form: NewSessionForm): SessionInfo {
  return {
    id,
    provider: form.provider,
    cwd: form.cwd,
    model: form.model,
    permissionMode: form.permissionMode,
    createdAt: 1,
    lastActivityAt: 1,
    subscribers: 0,
    messageCount: 0,
    running: true,
    terminated: false,
    working: false,
    phase: 'idle',
  } as SessionInfo
}

function renderApp() {
  return render(
    <ToastProvider>
      <PluginRegistryProvider>
        <ResourcePaneProvider>
          <App />
          <ToastHost />
        </ResourcePaneProvider>
      </PluginRegistryProvider>
    </ToastProvider>,
  )
}

beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()
    window.history.replaceState(null, '', '/')
    h.listeners.clear()
    h.config = config(false, '/old/default', 'old-model')
    h.refreshedConfig = config(true)
    h.refreshError = null
    h.isMobile = false
    h.fetchConfig.mockImplementation(async (opts?: { force?: boolean }) => {
      if (opts?.force && h.refreshError) throw h.refreshError
      if (opts?.force && h.refreshedConfig) h.config = h.refreshedConfig
      if (!h.config) throw new Error('no test config')
      return h.config
    })
    h.create.mockImplementation(async (form: NewSessionForm) => session('created-default', form))
    h.post.mockImplementation(async (path: string, body?: unknown) => {
      if (path === '/sessions') return { session: await h.create(body as NewSessionForm) }
      return {}
    })
    h.get.mockImplementation(async (path: string) => {
      if (path === '/app-plugins') return { plugins: [] }
      if (path === '/ui-state') return { uiState: { groups: [], sidebarOrder: [], collapsedGroups: {} } }
      if (path === '/snippets') return { snippets: [] }
      if (path === '/mcp-config') {
        return { servers: [{ name: 'enabled-server', enabled: true }, { name: 'disabled-server', enabled: false }] }
      }
      return {}
    })
    h.request.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/ui-state' && (!init?.method || init.method === 'GET')) {
        return { uiState: { groups: [], sidebarOrder: [], collapsedGroups: {} } }
      }
      return {}
    })
})

describe('default session creation after setup', () => {
  it('creates and focuses a session with the refreshed defaults instead of opening the dialog', async () => {
    window.localStorage.setItem('claude-react-web:recent-cwds', JSON.stringify(['/recent/project']))
    renderApp()
    fireEvent.click(await screen.findByRole('button', { name: 'Finish setup' }))

    const panel = await screen.findByTestId('chat-panel')
    expect(panel.dataset.sessionId).toBe('created-default')
    expect(panel.dataset.focused).toBe('true')
    expect(h.create).toHaveBeenCalledOnce()
    expect(h.fetchConfig.mock.calls.filter(([opts]) => (opts as { force?: boolean } | undefined)?.force)).toHaveLength(1)
    expect(h.create).toHaveBeenCalledWith({
      provider: 'claude',
      cwd: '/fresh/default',
      model: 'fresh-model',
      permissionMode: 'default',
      enabledMcpServers: ['enabled-server'],
      groupId: undefined,
    })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('lets the server apply current defaults when the post-setup refresh fails', async () => {
    h.refreshError = new Error('config offline')
    renderApp()
    fireEvent.click(await screen.findByRole('button', { name: 'Finish setup' }))

    await waitFor(() => expect(h.create).toHaveBeenCalledOnce())
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({
      cwd: undefined,
      model: undefined,
    }))
  })

  it('does not create a session when setup is skipped', async () => {
    renderApp()
    fireEvent.click(await screen.findByRole('button', { name: 'Skip setup' }))

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Skip setup' })).toBeNull())
    expect(h.create).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('leaves setup and shows the existing error toast when default creation fails', async () => {
    h.create.mockRejectedValue(new Error('spawn failed'))
    renderApp()
    fireEvent.click(await screen.findByRole('button', { name: 'Finish setup' }))

    await screen.findByText("Couldn't create session: spawn failed")
    expect(screen.queryByRole('button', { name: 'Finish setup' })).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByTestId('chat-panel')).toBeNull()
  })
})

describe('default session creation from the sidebar', () => {
  function emitSnapshot(sessions: SessionInfo[]) {
    act(() => {
      for (const listener of h.listeners) listener({ kind: 'sessions-snapshot', sessions })
    })
  }

  async function clickDefaultCreate() {
    fireEvent.click(await screen.findByRole('button', { name: '+ New' }))
    fireEvent.click(await screen.findByText('New Session (Default)'))
  }

  async function clickSessionCard(id: string) {
    await waitFor(() => {
      expect(document.querySelector(`[data-session-card-id="${id}"] .session-item`)).not.toBeNull()
    })
    fireEvent.click(document.querySelector(`[data-session-card-id="${id}"] .session-item`)!)
  }

  function configureGroups(groups: Array<{ id: string; name: string; sessionIds: string[] }>) {
    const uiState = { groups, sidebarOrder: [], collapsedGroups: {} }
    h.get.mockImplementation(async (path: string) => {
      if (path === '/app-plugins') return { plugins: [] }
      if (path === '/ui-state') return { uiState }
      if (path === '/snippets') return { snippets: [] }
      if (path === '/mcp-config') {
        return { servers: [{ name: 'enabled-server', enabled: true }, { name: 'disabled-server', enabled: false }] }
      }
      return {}
    })
    h.request.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/ui-state' && (!init?.method || init.method === 'GET')) return { uiState }
      return {}
    })
  }

  beforeEach(() => {
    h.config = config(true)
    h.refreshedConfig = h.config
  })

  it('uses defaults rather than recents and opens the created session without a dialog', async () => {
    window.localStorage.setItem('claude-react-web:recent-cwds', JSON.stringify(['/recent/project']))
    renderApp()
    emitSnapshot([])

    await clickDefaultCreate()

    const panel = await screen.findByTestId('chat-panel')
    expect(panel.dataset.sessionId).toBe('created-default')
    expect(h.create).toHaveBeenCalledWith({
      provider: 'claude',
      cwd: '/fresh/default',
      model: 'fresh-model',
      permissionMode: 'default',
      enabledMcpServers: ['enabled-server'],
      groupId: undefined,
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('waits for the in-flight config refresh before using sidebar defaults', async () => {
    renderApp()
    emitSnapshot([])
    await screen.findByRole('button', { name: '+ New' })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    h.fetchConfig.mockImplementation(async () => {
      await gate
      h.config = config(true, '/latest/default', 'latest-model')
      return h.config
    })

    await clickDefaultCreate()
    expect(h.create).not.toHaveBeenCalled()
    release()
    await waitFor(() => expect(h.create).toHaveBeenCalledOnce())
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/latest/default',
      model: 'latest-model',
    }))
    expect(h.fetchConfig).toHaveBeenCalledWith({ force: true })
  })

  it('does not silently disable MCP when its config cannot be read', async () => {
    h.get.mockImplementation(async (path: string) => {
      if (path === '/mcp-config') throw new Error('mcp offline')
      if (path === '/app-plugins') return { plugins: [] }
      if (path === '/ui-state') return { uiState: { groups: [], sidebarOrder: [], collapsedGroups: {} } }
      if (path === '/snippets') return { snippets: [] }
      return {}
    })
    renderApp()
    emitSnapshot([])

    await clickDefaultCreate()
    expect(h.create).not.toHaveBeenCalled()
    await screen.findByText("Couldn't load MCP servers: mcp offline")
  })

  it('creates without a global MCP selection when the optional router is absent', async () => {
    h.get.mockImplementation(async (path: string) => {
      if (path === '/mcp-config') throw Object.assign(new Error('not found'), { status: 404 })
      if (path === '/app-plugins') return { plugins: [] }
      if (path === '/ui-state') return { uiState: { groups: [], sidebarOrder: [], collapsedGroups: {} } }
      if (path === '/snippets') return { snippets: [] }
      return {}
    })
    renderApp()
    emitSnapshot([])

    await clickDefaultCreate()

    await waitFor(() => expect(h.create).toHaveBeenCalledOnce())
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ enabledMcpServers: [] }))
  })

  it('closes the mobile drawer after starting default creation', async () => {
    h.isMobile = true
    renderApp()
    emitSnapshot([])
    fireEvent.click(await screen.findByRole('button', { name: 'Open sessions' }))
    expect(document.querySelector('.app')?.classList.contains('drawer-open')).toBe(true)

    await clickDefaultCreate()

    await screen.findByTestId('chat-panel')
    expect(document.querySelector('.app')?.classList.contains('drawer-open')).toBe(false)
  })

  it('keeps the mobile drawer open when default creation cannot start', async () => {
    h.isMobile = true
    h.get.mockImplementation(async (path: string) => {
      if (path === '/mcp-config') throw new Error('mcp offline')
      if (path === '/app-plugins') return { plugins: [] }
      if (path === '/ui-state') return { uiState: { groups: [], sidebarOrder: [], collapsedGroups: {} } }
      if (path === '/snippets') return { snippets: [] }
      return {}
    })
    renderApp()
    emitSnapshot([])
    fireEvent.click(await screen.findByRole('button', { name: 'Open sessions' }))

    await clickDefaultCreate()

    await screen.findByText("Couldn't load MCP servers: mcp offline")
    expect(h.create).not.toHaveBeenCalled()
    expect(document.querySelector('.app')?.classList.contains('drawer-open')).toBe(true)
  })

  it('closes the drawer when the viewport becomes mobile during creation', async () => {
    let finishCreate!: (value: SessionInfo) => void
    h.create.mockImplementation((form: NewSessionForm) => new Promise<SessionInfo>((resolve) => {
      finishCreate = () => resolve(session('created-default', form))
    }))
    renderApp()
    emitSnapshot([])
    await clickDefaultCreate()
    await waitFor(() => expect(h.create).toHaveBeenCalledOnce())
    h.isMobile = true
    emitSnapshot([])
    fireEvent.click(await screen.findByRole('button', { name: 'Open sessions' }))
    expect(document.querySelector('.app')?.classList.contains('drawer-open')).toBe(true)

    await act(async () => {
      finishCreate(session('created-default', { provider: 'claude' }))
      await Promise.resolve()
    })

    expect(document.querySelector('.app')?.classList.contains('drawer-open')).toBe(false)
  })

  it('suppresses duplicate creates while the first request is in flight', async () => {
    const forms: NewSessionForm[] = []
    let finishFirst!: (value: SessionInfo) => void
    h.create.mockImplementation((form: NewSessionForm) => {
      forms.push(form)
      if (forms.length > 1) return Promise.resolve(session('created-second', form))
      return new Promise<SessionInfo>((resolve) => {
        finishFirst = resolve
      })
    })
    renderApp()
    emitSnapshot([])

    await clickDefaultCreate()
    await waitFor(() => expect(h.create).toHaveBeenCalledOnce())
    await clickDefaultCreate()
    expect(h.create).toHaveBeenCalledOnce()

    finishFirst(session('created-default', forms[0]))
    await screen.findByTestId('chat-panel')
    await clickDefaultCreate()
    await waitFor(() => expect(h.create).toHaveBeenCalledTimes(2))
  })

  it('opens an ordinary group-targeted create when the ungrouped view has not changed', async () => {
    configureGroups([{ id: 'g1', name: 'Team', sessionIds: ['g-existing'] }])
    renderApp()
    emitSnapshot([
      session('ungrouped-existing', { provider: 'claude' }),
      session('g-existing', { provider: 'claude' }),
    ])
    await clickSessionCard('ungrouped-existing')
    await screen.findByTestId('chat-panel')
    fireEvent.click(screen.getByRole('button', { name: '+ New' }))
    fireEvent.click(screen.getByText('New session…', { exact: true }))

    fireEvent.click(await screen.findByRole('button', { name: 'Submit grouped session' }))

    await waitFor(() => expect(h.create).toHaveBeenCalledOnce())
    const visible = Array.from(document.querySelectorAll('.panel-slot:not(.panel-slot-cached) [data-testid="chat-panel"]'))
    expect(visible.map((panel) => (panel as HTMLElement).dataset.sessionId)).toEqual(['created-default'])
  })

  it('opens a session that creates a new group when the ungrouped view has not changed', async () => {
    renderApp()
    emitSnapshot([session('ungrouped-existing', { provider: 'claude' })])
    await clickSessionCard('ungrouped-existing')
    await screen.findByTestId('chat-panel')
    fireEvent.click(screen.getByRole('button', { name: '+ New' }))
    fireEvent.click(screen.getByText('New session…', { exact: true }))

    fireEvent.click(await screen.findByRole('button', { name: 'Submit new-group session' }))

    await waitFor(() => expect(h.create).toHaveBeenCalledOnce())
    const visible = Array.from(document.querySelectorAll('.panel-slot:not(.panel-slot-cached) [data-testid="chat-panel"]'))
    expect(visible.map((panel) => (panel as HTMLElement).dataset.sessionId)).toEqual(['created-default'])
    expect(screen.getByRole('button', { name: 'Activate group Team' })).toBeTruthy()
  })

  it('adds the default session to the active group when it has capacity', async () => {
    configureGroups([{ id: 'g1', name: 'Team', sessionIds: ['existing'] }])
    renderApp()
    emitSnapshot([session('existing', { provider: 'claude' })])
    fireEvent.click(await screen.findByRole('button', { name: 'Activate group Team' }))
    await screen.findByTestId('chat-panel')

    await clickDefaultCreate()

    await waitFor(() => expect(h.create).toHaveBeenCalledOnce())
    const panels = await screen.findAllByTestId('chat-panel')
    expect(panels.map((panel) => panel.dataset.sessionId)).toContain('created-default')
    await waitFor(() => expect(document.querySelector('.group-header-count')?.textContent).toBe('2'))
  })

  it('preserves invocation-time membership when the user switches groups during creation', async () => {
    configureGroups([
      { id: 'a', name: 'Alpha', sessionIds: ['a-existing'] },
      { id: 'b', name: 'Beta', sessionIds: ['b-existing'] },
    ])
    let finishCreate!: (value: SessionInfo) => void
    h.create.mockImplementation((form: NewSessionForm) => new Promise<SessionInfo>((resolve) => {
      finishCreate = () => resolve(session('created-default', form))
    }))
    renderApp()
    emitSnapshot([
      session('a-existing', { provider: 'claude' }),
      session('b-existing', { provider: 'claude' }),
    ])
    fireEvent.click(await screen.findByRole('button', { name: 'Activate group Alpha' }))
    await screen.findByTestId('chat-panel')

    await clickDefaultCreate()
    await waitFor(() => expect(h.create).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: 'Activate group Beta' }))
    await waitFor(() => {
      const visible = Array.from(document.querySelectorAll('.panel-slot:not(.panel-slot-cached) [data-testid="chat-panel"]'))
      expect(visible.map((panel) => (panel as HTMLElement).dataset.sessionId)).toEqual(['b-existing'])
    })
    await act(async () => {
      finishCreate(session('created-default', { provider: 'claude' }))
      await Promise.resolve()
    })

    await waitFor(() => {
      const visible = Array.from(document.querySelectorAll('.panel-slot:not(.panel-slot-cached) [data-testid="chat-panel"]'))
      expect(visible.map((panel) => (panel as HTMLElement).dataset.sessionId)).toEqual(['b-existing'])
    })
    const counts = Array.from(document.querySelectorAll('.group-header-count')).map((el) => el.textContent)
    expect(counts).toEqual(['2', '1'])
  })

  it('keeps the invocation-time group target while config is loading', async () => {
    configureGroups([
      { id: 'a', name: 'Alpha', sessionIds: ['a-existing'] },
      { id: 'b', name: 'Beta', sessionIds: ['b-existing'] },
    ])
    renderApp()
    emitSnapshot([
      session('a-existing', { provider: 'claude' }),
      session('b-existing', { provider: 'claude' }),
    ])
    fireEvent.click(await screen.findByRole('button', { name: 'Activate group Alpha' }))
    await screen.findByTestId('chat-panel')
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    h.fetchConfig.mockImplementation(async () => {
      await gate
      return h.config
    })

    await clickDefaultCreate()
    fireEvent.click(screen.getByRole('button', { name: 'Activate group Beta' }))
    release()
    await waitFor(() => expect(h.create).toHaveBeenCalledOnce())

    const counts = Array.from(document.querySelectorAll('.group-header-count')).map((el) => el.textContent)
    expect(counts).toEqual(['2', '1'])
    await waitFor(() => {
      const visible = Array.from(document.querySelectorAll('.panel-slot:not(.panel-slot-cached) [data-testid="chat-panel"]'))
      expect(visible.map((panel) => (panel as HTMLElement).dataset.sessionId)).toEqual(['b-existing'])
    })
  })

  it('does not replace an ungrouped view with a group-targeted create that was started elsewhere', async () => {
    configureGroups([{ id: 'a', name: 'Alpha', sessionIds: ['a-existing'] }])
    let finishCreate!: (value: SessionInfo) => void
    h.create.mockImplementation((form: NewSessionForm) => new Promise<SessionInfo>((resolve) => {
      finishCreate = () => resolve(session('created-default', form))
    }))
    renderApp()
    emitSnapshot([
      session('a-existing', { provider: 'claude' }),
      session('ungrouped-existing', { provider: 'claude' }),
    ])
    fireEvent.click(await screen.findByRole('button', { name: 'Activate group Alpha' }))
    await screen.findByTestId('chat-panel')

    await clickDefaultCreate()
    await waitFor(() => expect(h.create).toHaveBeenCalledOnce())
    await clickSessionCard('ungrouped-existing')
    await waitFor(() => {
      const visible = Array.from(document.querySelectorAll('.panel-slot:not(.panel-slot-cached) [data-testid="chat-panel"]'))
      expect(visible.map((panel) => (panel as HTMLElement).dataset.sessionId)).toEqual(['ungrouped-existing'])
    })
    await act(async () => {
      finishCreate(session('created-default', { provider: 'claude' }))
      await Promise.resolve()
    })

    const visible = Array.from(document.querySelectorAll('.panel-slot:not(.panel-slot-cached) [data-testid="chat-panel"]'))
    expect(visible.map((panel) => (panel as HTMLElement).dataset.sessionId)).toEqual(['ungrouped-existing'])
  })

  it('opens the created session when the origin session was removed during creation', async () => {
    let finishCreate!: (value: SessionInfo) => void
    h.create.mockImplementation((form: NewSessionForm) => new Promise<SessionInfo>((resolve) => {
      finishCreate = () => resolve(session('created-default', form))
    }))
    renderApp()
    emitSnapshot([session('origin-removed', { provider: 'claude' })])
    await clickSessionCard('origin-removed')
    await screen.findByTestId('chat-panel')

    await clickDefaultCreate()
    await waitFor(() => expect(h.create).toHaveBeenCalledOnce())
    emitSnapshot([])
    await act(async () => {
      finishCreate(session('created-default', { provider: 'claude' }))
      await Promise.resolve()
    })

    const visible = Array.from(document.querySelectorAll('.panel-slot:not(.panel-slot-cached) [data-testid="chat-panel"]'))
    expect(visible.map((panel) => (panel as HTMLElement).dataset.sessionId)).toEqual(['created-default'])
  })

  it('preserves a replacement selection made after the origin session was removed', async () => {
    let finishCreate!: (value: SessionInfo) => void
    h.create.mockImplementation((form: NewSessionForm) => new Promise<SessionInfo>((resolve) => {
      finishCreate = () => resolve(session('created-default', form))
    }))
    renderApp()
    emitSnapshot([
      session('origin-removed', { provider: 'claude' }),
      session('replacement', { provider: 'claude' }),
    ])
    await clickSessionCard('origin-removed')
    await screen.findByTestId('chat-panel')

    await clickDefaultCreate()
    await waitFor(() => expect(h.create).toHaveBeenCalledOnce())
    emitSnapshot([session('replacement', { provider: 'claude' })])
    await clickSessionCard('replacement')
    await act(async () => {
      finishCreate(session('created-default', { provider: 'claude' }))
      await Promise.resolve()
    })

    const visible = Array.from(document.querySelectorAll('.panel-slot:not(.panel-slot-cached) [data-testid="chat-panel"]'))
    expect(visible.map((panel) => (panel as HTMLElement).dataset.sessionId)).toEqual(['replacement'])
  })

  it('preserves a newly selected ungrouped session when default creation completes', async () => {
    let finishCreate!: (value: SessionInfo) => void
    h.create.mockImplementation((form: NewSessionForm) => new Promise<SessionInfo>((resolve) => {
      finishCreate = () => resolve(session('created-default', form))
    }))
    renderApp()
    emitSnapshot([
      session('ungrouped-a', { provider: 'claude' }),
      session('ungrouped-b', { provider: 'claude' }),
    ])
    await clickSessionCard('ungrouped-a')
    await screen.findByTestId('chat-panel')

    await clickDefaultCreate()
    await waitFor(() => expect(h.create).toHaveBeenCalledOnce())
    await clickSessionCard('ungrouped-b')
    await act(async () => {
      finishCreate(session('created-default', { provider: 'claude' }))
      await Promise.resolve()
    })

    const visible = Array.from(document.querySelectorAll('.panel-slot:not(.panel-slot-cached) [data-testid="chat-panel"]'))
    expect(visible.map((panel) => (panel as HTMLElement).dataset.sessionId)).toEqual(['ungrouped-b'])
  })

  it('keeps the mobile drawer open when a full group cannot show the created session', async () => {
    const ids = ['existing-1', 'existing-2', 'existing-3']
    configureGroups([{ id: 'g1', name: 'Team', sessionIds: ids }])
    renderApp()
    const existing = ids.map((id) => session(id, { provider: 'claude' }))
    emitSnapshot(existing)
    fireEvent.click(await screen.findByRole('button', { name: 'Activate group Team' }))
    await screen.findAllByTestId('chat-panel')
    h.isMobile = true
    emitSnapshot(existing.map((item) => ({ ...item })))
    fireEvent.click(await screen.findByRole('button', { name: 'Open sessions' }))
    expect(document.querySelector('.app')?.classList.contains('drawer-open')).toBe(true)

    await clickDefaultCreate()

    await waitFor(() => expect(h.create).toHaveBeenCalledOnce())
    expect(document.querySelector('.app')?.classList.contains('drawer-open')).toBe(true)
  })

  it('does not disturb a full active group view', async () => {
    const ids = ['existing-1', 'existing-2', 'existing-3']
    configureGroups([{ id: 'g1', name: 'Team', sessionIds: ids }])
    renderApp()
    emitSnapshot(ids.map((id) => session(id, { provider: 'claude' })))
    fireEvent.click(await screen.findByRole('button', { name: 'Activate group Team' }))
    await screen.findAllByTestId('chat-panel')

    await clickDefaultCreate()

    await waitFor(() => expect(h.create).toHaveBeenCalledOnce())
    const panels = screen.getAllByTestId('chat-panel')
    expect(panels.map((panel) => panel.dataset.sessionId)).toEqual(ids)
  })
})

describe('terminal shortcut capability gating', () => {
  function emitSnapshot(sessions: SessionInfo[]) {
    act(() => {
      for (const listener of h.listeners) listener({ kind: 'sessions-snapshot', sessions })
    })
  }

  async function focusSession(id: string) {
    await waitFor(() => {
      expect(document.querySelector(`[data-session-card-id="${id}"] .session-item`)).not.toBeNull()
    })
    fireEvent.click(document.querySelector(`[data-session-card-id="${id}"] .session-item`)!)
    await screen.findByTestId('chat-panel')
    await waitFor(() => {
      const focused = document.querySelector('[data-testid="chat-panel"][data-focused="true"]')
      expect(focused?.getAttribute('data-session-id')).toBe(id)
    })
  }

  const paletteRows = () => Array.from(document.querySelectorAll('[data-palette-option]'))
  const terminalRow = () => paletteRows().find((row) => row.textContent?.includes('Toggle terminal'))
  const panelTerminalOpen = (id: string) =>
    document.querySelector(`[data-testid="chat-panel"][data-session-id="${id}"]`)?.getAttribute('data-terminal-open')

  async function openPalette() {
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    await waitFor(() => expect(document.querySelector('.palette-input')).not.toBeNull())
  }

  async function findTerminalRow() {
    return waitFor(() => {
      const row = terminalRow()
      expect(row).toBeTruthy()
      return row!
    })
  }

  beforeEach(() => {
    h.config = config(true)
    h.refreshedConfig = h.config
  })

  it('toasts on an unsupported host and hides the palette action', async () => {
    renderApp()
    emitSnapshot([{ ...session('s-nopty', { provider: 'claude' }), terminalSupported: false }])
    await focusSession('s-nopty')

    fireEvent.keyDown(window, { key: '`', ctrlKey: true })
    expect(await screen.findByText('Terminal is unavailable on this host')).toBeTruthy()

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    await waitFor(() => expect(document.querySelector('.palette-input')).not.toBeNull())
    expect(paletteRows().some((row) => row.textContent?.includes('Toggle terminal'))).toBe(false)
  })

  it('shows the palette action on a supported host', async () => {
    renderApp()
    emitSnapshot([{ ...session('s-pty', { provider: 'claude' }), terminalSupported: true }])
    await focusSession('s-pty')

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    await waitFor(() => {
      expect(paletteRows().some((row) => row.textContent?.includes('Toggle terminal'))).toBe(true)
    })
  })

  // Regression for the Critical: the palette row must ACTUALLY open the
  // terminal on a supported host. The palette being open flips terminalModalOpen
  // true, so the row must use the unguarded paletteAction — not the modal-gated
  // keydown handler (which would no-op). Asserted via the union's terminalOpen
  // prop reaching the focused panel.
  it('opens the terminal overlay when the palette row is clicked (supported host)', async () => {
    renderApp()
    emitSnapshot([{ ...session('s-pty', { provider: 'claude' }), terminalSupported: true }])
    await focusSession('s-pty')
    await openPalette()

    fireEvent.click(await findTerminalRow())

    await waitFor(() => expect(panelTerminalOpen('s-pty')).toBe('true'))
  })

  it('opens the terminal overlay when the palette row is activated with Enter (supported host)', async () => {
    renderApp()
    emitSnapshot([{ ...session('s-pty', { provider: 'claude' }), terminalSupported: true }])
    await focusSession('s-pty')
    await openPalette()

    const row = await findTerminalRow()
    fireEvent.mouseEnter(row) // move the palette selection onto the terminal row
    fireEvent.keyDown(document.querySelector('.palette-input')!, { key: 'Enter' })

    await waitFor(() => expect(panelTerminalOpen('s-pty')).toBe('true'))
  })

  it('still suppresses Ctrl+` keydown while the palette is open (supported host)', async () => {
    renderApp()
    emitSnapshot([{ ...session('s-pty', { provider: 'claude' }), terminalSupported: true }])
    await focusSession('s-pty')
    await openPalette()

    fireEvent.keyDown(window, { key: '`', ctrlKey: true })

    // Spec-required: the keydown context stays modal-gated even though the
    // palette action override is unguarded.
    expect(panelTerminalOpen('s-pty')).toBe('false')
  })
})
