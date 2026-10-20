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

beforeEach(() => {
  vi.mocked(api.get).mockResolvedValue({ ...STATUS_OK })
  vi.mocked(api.post).mockResolvedValue({ ...STATUS_OK, configEnabled: true, osRegistered: true })
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
    vi.mocked(api.get).mockResolvedValue({ ...STATUS_OK, osRegistered: true, configEnabled: true })
    render(<DaemonSection />)
    const toggle = await screen.findByRole('switch', { name: /run automatically at login/i })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle)
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/daemon/disable', {}))
  })

  it('shows the raw error and reverts the toggle when enable fails', async () => {
    vi.mocked(api.post).mockRejectedValue(new Error('schtasks /create failed (1): access denied'))
    render(<DaemonSection />)
    const toggle = await screen.findByRole('switch', { name: /run automatically at login/i })
    fireEvent.click(toggle)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/schtasks \/create failed/i))
    expect(toggle.getAttribute('aria-checked')).toBe('false')
  })

  it('offers Re-register when drift is detected', async () => {
    vi.mocked(api.get).mockResolvedValue({ ...STATUS_OK, configEnabled: true, drift: true })
    render(<DaemonSection />)
    expect(await screen.findByText(/registration drift/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /re-register/i }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/daemon/enable', {}))
  })

  it('Stop now posts /daemon/stop while the daemon is running', async () => {
    vi.mocked(api.get).mockResolvedValue({ ...STATUS_OK, daemonAlive: true, child: { state: 'running', uptimeSec: 10, restartCount: 0, lastError: null, lastExitReason: null } })
    render(<DaemonSection />)
    fireEvent.click(await screen.findByRole('button', { name: /stop now/i }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/daemon/stop', {}))
  })

  it('offers Start now when registered but not running', async () => {
    vi.mocked(api.get).mockResolvedValue({ ...STATUS_OK, osRegistered: true, configEnabled: true })
    render(<DaemonSection />)
    fireEvent.click(await screen.findByRole('button', { name: /start now/i }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/daemon/start', {}))
  })

  it('renders nothing on the desktop host', () => {
    vi.mocked(isDesktopHost).mockReturnValue(true)
    const { container } = render(<DaemonSection />)
    expect(container.innerHTML).toBe('')
  })
})
