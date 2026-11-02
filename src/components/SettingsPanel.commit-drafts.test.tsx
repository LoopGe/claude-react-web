import { useState } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ToastProvider } from './ToastProvider'
import { SettingsPanel } from './SettingsPanel'
import { Overlay } from './Overlay'
import type { SessionInfo } from '../types'

vi.mock('../hooks/useApi', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))

import { api } from '../hooks/useApi'

vi.stubGlobal('matchMedia', () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
}))

const globalPrefs = {
  showPinnedUserMessage: true,
  autoRecap: true,
  toolGroupCards: true,
  autoExpandRunningGroups: true,
  showMessageHeaders: true,
  streamingRenderMode: 'overlay',
} as Parameters<typeof SettingsPanel>[0]['globalPrefs']

function mkSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 's1',
    title: 'Session',
    cwd: '/tmp/project',
    running: true,
    working: false,
    terminated: false,
    permissionMode: 'default',
    model: 'test-model',
    createdAt: 1,
    lastActivityAt: 1,
    memory: { autoMemoryDirectory: '/old/memory' },
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      network: { allowedDomains: ['api.github.com'] },
      filesystem: { allowWrite: ['/tmp/build'] },
    },
    ...overrides,
  } as SessionInfo
}

function panel(session: SessionInfo, onSessionUpdate: (session: SessionInfo) => void = () => {}) {
  return (
    <ToastProvider>
      <div className="settings-overlay">
        <SettingsPanel
          session={session}
          globalPrefs={globalPrefs}
          onClose={() => {}}
          onSessionUpdate={onSessionUpdate}
          tabRequest={{ tab: 'general', nonce: 1 }}
        />
      </div>
    </ToastProvider>
  )
}

function renderPanel(session = mkSession()) {
  return render(panel(session))
}

function inputByLabel(label: string) {
  return screen.getByLabelText(label) as HTMLInputElement
}

function focusInput(input: HTMLInputElement) {
  act(() => {
    input.focus()
  })
  expect(document.activeElement).toBe(input)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.get).mockImplementation((url: string) => {
    if (url.endsWith('/mcp-status')) return Promise.resolve({ mcp: [] })
    if (url.endsWith('/tools')) return Promise.resolve({ tools: [] })
    if (url === '/profiles') return Promise.resolve({ profiles: [] })
    if (url === '/config') return Promise.resolve({ models: [] })
    return Promise.resolve({})
  })
  vi.mocked(api.post).mockImplementation(() => Promise.resolve({ session: mkSession() }))
})

describe('SettingsPanel synced commit drafts', () => {
  it('commits a trimmed Memory directory once on Enter', () => {
    renderPanel()
    const input = inputByLabel('Memory directory')
    focusInput(input)

    fireEvent.change(input, { target: { value: '  /new/memory  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(api.post).toHaveBeenCalledTimes(1)
    expect(api.post).toHaveBeenCalledWith('/sessions/s1/memory', { autoMemoryDirectory: '/new/memory' })
  })

  it('commits an empty Memory directory as null and skips a normalized no-op', async () => {
    renderPanel()
    const input = inputByLabel('Memory directory')
    focusInput(input)

    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.blur(input)
    expect(api.post).toHaveBeenCalledWith('/sessions/s1/memory', { autoMemoryDirectory: null })
    await waitFor(() => expect(input.disabled).toBe(false))

    vi.mocked(api.post).mockClear()
    focusInput(input)
    fireEvent.change(input, { target: { value: '  /old/memory  ' } })
    fireEvent.blur(input)
    expect(api.post).not.toHaveBeenCalled()
    expect(input.value).toBe('/old/memory')
  })

  it('restores the latest source on Escape without committing', () => {
    const { rerender } = renderPanel()
    const input = inputByLabel('Memory directory')

    focusInput(input)
    fireEvent.change(input, { target: { value: '/local/draft' } })
    rerender(panel(mkSession({ memory: { autoMemoryDirectory: '/server/memory' } })))
    expect(input.value).toBe('/local/draft')

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(api.post).not.toHaveBeenCalled()
    expect(input.value).toBe('/server/memory')

    rerender(panel(mkSession({ memory: { autoMemoryDirectory: '/unfocused/memory' } })))
    expect(input.value).toBe('/unfocused/memory')
  })

  it('commits Sandbox domains as CSV while preserving sibling settings', () => {
    renderPanel()
    const input = inputByLabel('Allowed network domains')
    focusInput(input)

    fireEvent.change(input, { target: { value: ' api.example.com, *.npmjs.org, ,' } })
    fireEvent.blur(input)

    expect(api.post).toHaveBeenCalledWith('/sessions/s1/sandbox', {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      network: { allowedDomains: ['api.example.com', '*.npmjs.org'] },
      filesystem: { allowWrite: ['/tmp/build'] },
    })
  })

  it('commits Sandbox writable paths on Enter while preserving sibling settings', () => {
    renderPanel()
    const input = inputByLabel('Extra writable paths')
    focusInput(input)

    fireEvent.change(input, { target: { value: ' /tmp/one, /tmp/two ' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(api.post).toHaveBeenCalledWith('/sessions/s1/sandbox', {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      network: { allowedDomains: ['api.github.com'] },
      filesystem: { allowWrite: ['/tmp/one', '/tmp/two'] },
    })
  })

  it('preserves the real Overlay Escape close-and-blur commit behavior', async () => {
    const onClose = vi.fn()
    function OverlayHarness() {
      const [open, setOpen] = useState(true)
      return (
        <ToastProvider>
          <Overlay
            variant="settings"
            ariaLabel="Session settings"
            open={open}
            onClose={() => {
              onClose()
              setOpen(false)
            }}
            renderCard={false}
          >
            <SettingsPanel
              session={mkSession()}
              globalPrefs={globalPrefs}
              onClose={() => {}}
              onSessionUpdate={() => {}}
              tabRequest={{ tab: 'general', nonce: 1 }}
            />
          </Overlay>
        </ToastProvider>
      )
    }
    render(<OverlayHarness />)
    const input = inputByLabel('Memory directory')
    focusInput(input)
    fireEvent.change(input, { target: { value: '/must/not/commit' } })

    fireEvent.keyDown(input, { key: 'Escape' })

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    // The Overlay's capture-phase Escape handler closes first; the ensuing
    // blur commits the draft. Preserve this pre-existing behavior in the
    // dedup refactor rather than silently bundling an Escape-policy fix.
    expect(api.post).toHaveBeenCalledWith('/sessions/s1/memory', { autoMemoryDirectory: '/must/not/commit' })
  })
})
