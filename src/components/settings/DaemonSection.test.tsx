// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import { DaemonSection } from './DaemonSection'

vi.mock('../../hooks/useApi', () => ({ api: { get: vi.fn(), post: vi.fn() } }))
vi.mock('../../host-capabilities', () => ({ isDesktopHost: vi.fn(() => false) }))

import { api } from '../../hooks/useApi'
import { isDesktopHost } from '../../host-capabilities'

const STATUS_OK = {
  supported: true, mechanism: 'schtasks', configEnabled: false, osRegistered: false,
  osTargetMissing: false, drift: false, daemonAlive: false, isDaemonChild: false, child: null,
}

/** Shared fake server state: `get` reads it, `post` (enable/disable) flips
 *  it — mirroring the real server so tests never encode the WRONG protocol
 *  (POST responses are action acks like {ok, started}, NOT a DaemonStatus;
 *  feeding them into the client's status state was a review finding). */
let serverState: Record<string, unknown>

beforeEach(() => {
  serverState = { ...STATUS_OK }
  vi.mocked(api.get).mockImplementation(async () => ({ ...serverState }))
  vi.mocked(api.post).mockImplementation(async (url: string) => {
    if (url === '/daemon/enable') serverState = { ...serverState, osRegistered: true, configEnabled: true }
    if (url === '/daemon/disable') serverState = { ...serverState, osRegistered: false, configEnabled: false }
    return { ok: true }
  })
  // the desktop-host test overrides this — reset it or the override leaks
  // into every test that runs after it (clearAllMocks keeps implementations)
  vi.mocked(isDesktopHost).mockReturnValue(false)
})
afterEach(() => { vi.clearAllMocks(); cleanup() })

describe('DaemonSection', () => {
  it('renders the toggle and enables via POST /daemon/enable', async () => {
    render(<DaemonSection />)
    const toggle = await screen.findByRole('switch', { name: /run automatically at login/i })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/daemon/enable', {}))
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'))
  })

  it('disables via POST /daemon/disable when already registered', async () => {
    serverState = { ...STATUS_OK, osRegistered: true, configEnabled: true }
    render(<DaemonSection />)
    const toggle = await screen.findByRole('switch', { name: /run automatically at login/i })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle)
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/daemon/disable', {}))
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'))
  })

  it('shows the raw error and keeps the unchecked toggle after a failed enable', async () => {
    // start UNREGISTERED so the click is an ENABLE (onChange(!checked))
    serverState = { ...STATUS_OK }
    vi.mocked(api.post).mockImplementation(async (url: string) => {
      if (url === '/daemon/enable') throw new Error('schtasks /create failed (1): access denied')
      if (url === '/daemon/disable') serverState = { ...serverState, osRegistered: false, configEnabled: false }
      return { ok: true }
    })
    render(<DaemonSection />)
    const toggle = await screen.findByRole('switch', { name: /run automatically at login/i })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/schtasks \/create failed/i))
    // the follow-up refresh reports the REAL (still unregistered) state
    expect(toggle.getAttribute('aria-checked')).toBe('false')
  })

  it('offers Re-register when drift is detected', async () => {
    serverState = { ...STATUS_OK, configEnabled: true, drift: true }
    render(<DaemonSection />)
    expect(await screen.findByText(/registration drift/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /re-register/i }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/daemon/enable', {}))
  })

  it('Stop now posts /daemon/stop while the daemon is running (ack does NOT become status)', async () => {
    serverState = { ...STATUS_OK, daemonAlive: true, child: { state: 'running', uptimeSec: 10, restartCount: 0, lastError: null, lastExitReason: null } }
    render(<DaemonSection />)
    fireEvent.click(await screen.findByRole('button', { name: /stop now/i }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/daemon/stop', {}))
    // the ack {ok, stopping} must NOT collapse the section into "not supported"
    await waitFor(() => expect(screen.queryByText(/not available in this mode/i)).toBeNull())
    expect(screen.getByRole('button', { name: /stop now/i })).toBeTruthy()
  })

  it('offers Start now when registered but not running', async () => {
    serverState = { ...STATUS_OK, osRegistered: true, configEnabled: true }
    render(<DaemonSection />)
    fireEvent.click(await screen.findByRole('button', { name: /start now/i }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/daemon/start', {}))
  })

  it('renders nothing on the desktop host', () => {
    vi.mocked(isDesktopHost).mockReturnValue(true)
    const { container } = render(<DaemonSection />)
    expect(container.innerHTML).toBe('')
  })

  it('stays visible with the raw error + Retry when the first status fetch fails', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('connection refused'))
    render(<DaemonSection />)
    // the section itself must stay VISIBLE with the error — rendering null on
    // a failed first load is how this feature hid from users entirely
    expect(await screen.findByText(/couldn't load the daemon status/i)).toBeTruthy()
    expect(screen.getByText(/connection refused/)).toBeTruthy()
    // a Retry affordance must exist
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2))
  })

  it('shows the support reason instead of controls when unsupported (dev mode)', async () => {
    serverState = { ...STATUS_OK, supported: false, supportReason: 'dev mode (tsx): the daemon drives the production bundle' }
    render(<DaemonSection />)
    await waitFor(() => expect(screen.getByText(/production bundle/)).toBeTruthy())
    expect(screen.queryByRole('switch', { name: /run automatically at login/i })).toBeNull()
  })
})
