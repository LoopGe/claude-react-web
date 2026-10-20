// SetupPage's save path must not report success for a write the server did not
// accept. `POST /config/setup` returns `configured` (mirroring GET /config, i.e.
// whether the ACTIVE profile has a credential). Treating a falsy value as
// success opened the main UI with sessions that cannot authenticate and bounced
// the user back to this wizard on the next load — the P0 defect, where the token
// was written to profiles[0] while the app read a different profile.
//
// Only the save contract is covered here; the wizard's per-step behaviour is not.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SetupPage } from './SetupPage'
import { api } from '../hooks/useApi'

vi.mock('../hooks/useApi', () => ({ api: { get: vi.fn(), post: vi.fn() } }))

// The wizard touches a browser-notification hook, an update-probe hook and a
// scrollbar hook on mount. Stubbed so the test exercises the save path rather
// than three unrelated browser APIs (Notification / ResizeObserver / matchMedia
// are all thin or missing in the DOM shim).
vi.mock('../hooks/useNotifications', () => ({
  useNotifications: () => ({
    enabled: false,
    permission: 'default',
    toggle: vi.fn(async () => {}),
    notify: vi.fn(() => false),
    notifyWithActions: vi.fn(() => false),
    closeByTag: vi.fn(async () => {}),
  }),
}))
vi.mock('../hooks/useUpdateInfo', () => ({
  useUpdateInfo: () => ({
    info: null, loading: false, refreshing: false, error: null, refresh: vi.fn(),
  }),
}))
vi.mock('../hooks/useOverlayScrollbar', () => ({ useOverlayScrollbar: () => () => {} }))

beforeEach(() => {
  vi.mocked(api.get).mockImplementation((url: string) => {
    if (url.startsWith('/health/claude')) return Promise.resolve({ ok: true, version: '1.0.0' })
    if (url === '/profiles') return Promise.resolve({ profiles: [], activeProfileId: 'default' })
    if (url === '/mcp-config/claude-import') return Promise.resolve({ servers: [] })
    // hasKey:true pre-fills the token, but the tests type one anyway so the path
    // does not depend on that async pre-fill having landed.
    if (url === '/config/claude-defaults') return Promise.resolve({ hasKey: true, settingsPath: '/tmp/settings.json' })
    if (url === '/daemon/status') return Promise.resolve({ supported: true, mechanism: 'schtasks', configEnabled: false, osRegistered: false, drift: false, daemonAlive: false, child: null })
    return Promise.resolve({})
  })
})

afterEach(() => { vi.clearAllMocks() })

/** Walk the wizard to the AUTOSTART step (web host). */
async function driveToAutostartStep() {
  fireEvent.click(await screen.findByText('Continue'))
  fireEvent.change(screen.getByPlaceholderText('sk-ant-...'), { target: { value: 'sk-test' } })
  for (let i = 0; i < 5; i++) fireEvent.click(screen.getByText('Next'))
  return screen.findByRole('switch', { name: /run automatically at login/i })
}

/** Walk the 8-step wizard to the last step and return its primary button. */
async function driveToFinishStep() {
  // Step 0 disables Continue until the CLI probe settles.
  fireEvent.click(await screen.findByText('Continue'))
  // By placeholder, not by label text: the progress dots carry aria-labels like
  // "Step 2 of 8: Auth Token (current step)", so /Auth Token/ is ambiguous.
  fireEvent.change(screen.getByPlaceholderText('sk-ant-...'), { target: { value: 'sk-test' } })
  for (let i = 0; i < 6; i++) fireEvent.click(screen.getByText('Next'))
  return screen.findByText('Create New Session')
}

describe('SetupPage — the save contract', () => {
  it('proceeds when the server reports the config took effect', async () => {
    vi.mocked(api.post).mockResolvedValue({ ok: true, configured: true })
    const onConfigured = vi.fn(async () => {})
    render(<SetupPage onConfigured={onConfigured} />)

    fireEvent.click(await driveToFinishStep())

    await waitFor(() => expect(onConfigured).toHaveBeenCalledWith({ openNewSession: true }))
    // The wizard's own payload must reach the server intact.
    expect(api.post).toHaveBeenCalledWith('/config/setup', expect.objectContaining({
      authToken: 'sk-test',
      modelList: expect.any(Array),
    }))
  })

  it('proceeds when the response carries no `configured` field', async () => {
    // A 200 whose body is not JSON decodes to a string, so the field is absent.
    // Reading that as failure would trap the user on a wrong diagnosis — the
    // rest of the client treats an absent value as configured (App.tsx:
    // `configured !== false`).
    vi.mocked(api.post).mockResolvedValue('ok')
    const onConfigured = vi.fn(async () => {})
    render(<SetupPage onConfigured={onConfigured} />)

    fireEvent.click(await driveToFinishStep())

    await waitFor(() => expect(onConfigured).toHaveBeenCalledWith({ openNewSession: true }))
  })

  it('stays put and reports an error when the server reports no active credential', async () => {
    // The regression: this used to call onConfigured anyway, opening the main UI
    // with no usable credential and bouncing back here on the next load.
    vi.mocked(api.post).mockResolvedValue({ ok: true, configured: false })
    const onConfigured = vi.fn(async () => {})
    render(<SetupPage onConfigured={onConfigured} />)

    fireEvent.click(await driveToFinishStep())

    await waitFor(() => expect(screen.getByRole('alert').textContent)
      .toMatch(/did not reach the active profile/i))
    expect(onConfigured).not.toHaveBeenCalled()
    // Still on the last step, so the retry is right there.
    expect(screen.getByText('Create New Session')).toBeTruthy()
  })

  it('sends Skip through the same contract', async () => {
    vi.mocked(api.post).mockResolvedValue({ ok: true, configured: false })
    const onConfigured = vi.fn(async () => {})
    render(<SetupPage onConfigured={onConfigured} />)

    await driveToFinishStep()
    fireEvent.click(screen.getByText('Skip'))

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(onConfigured).not.toHaveBeenCalled()
  })
})

describe('SetupPage — the autostart step', () => {
  it('posts /daemon/enable after setup when the toggle is on (config/setup first)', async () => {
    vi.mocked(api.post).mockImplementation(async (url: string) => {
      if (url === '/config/setup') return { ok: true, configured: true }
      if (url === '/daemon/enable') return { supported: true, osRegistered: true, configEnabled: true }
      throw new Error(`unexpected POST ${url}`)
    })
    const onConfigured = vi.fn(async () => {})
    render(<SetupPage onConfigured={onConfigured} />)

    const toggle = await driveToAutostartStep()
    fireEvent.click(toggle)
    fireEvent.click(await screen.findByText('Next'))
    fireEvent.click(await screen.findByText('Create New Session'))

    await waitFor(() => expect(onConfigured).toHaveBeenCalled())
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/daemon/enable', {}))
    // enable strictly AFTER the setup write
    const calls = vi.mocked(api.post).mock.calls.map((c) => c[0])
    expect(calls.indexOf('/daemon/enable')).toBeGreaterThan(calls.indexOf('/config/setup'))
  })

  it('completes setup even when enable fails, showing the raw error', async () => {
    vi.mocked(api.post).mockImplementation(async (url: string) => {
      if (url === '/config/setup') return { ok: true, configured: true }
      if (url === '/daemon/enable') throw new Error('schtasks /create failed (1): boom')
      throw new Error(`unexpected POST ${url}`)
    })
    const onConfigured = vi.fn(async () => {})
    render(<SetupPage onConfigured={onConfigured} />)

    const toggle = await driveToAutostartStep()
    fireEvent.click(toggle)
    fireEvent.click(await screen.findByText('Next'))
    fireEvent.click(await screen.findByText('Create New Session'))

    await waitFor(() => expect(onConfigured).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/schtasks \/create failed/i))
  })

  it('defaults the toggle to on when auto-start is already registered', async () => {
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === '/daemon/status') {
        return Promise.resolve({ supported: true, mechanism: 'schtasks', configEnabled: true, osRegistered: true, drift: false, daemonAlive: true, child: { state: 'running', uptimeSec: 1, restartCount: 0, lastError: null } })
      }
      if (url.startsWith('/health/claude')) return Promise.resolve({ ok: true, version: '1.0.0' })
      if (url === '/profiles') return Promise.resolve({ profiles: [], activeProfileId: 'default' })
      if (url === '/mcp-config/claude-import') return Promise.resolve({ servers: [] })
      if (url === '/config/claude-defaults') return Promise.resolve({ hasKey: true, settingsPath: '/tmp/settings.json' })
      return Promise.resolve({})
    })
    render(<SetupPage onConfigured={vi.fn(async () => {})} />)

    const toggle = await driveToAutostartStep()
    expect(toggle.getAttribute('aria-checked')).toBe('true')
  })
})