import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { ToastProvider } from './ToastProvider'
import { SettingsPanel } from './SettingsPanel'
import type { SessionInfo } from '../types'

vi.mock('../hooks/useApi', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}))

import { api } from '../hooks/useApi'

// jsdom doesn't implement matchMedia; useExitPresence probes it when the
// nested MCP installer closes (reduced-motion check). Same stub as
// NewSessionDialog.test.
vi.stubGlobal('matchMedia', () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
}))

const mkSession = (firstPartyTools?: Record<string, boolean>) =>
  ({ id: 's1', running: true, terminated: false, firstPartyTools }) as unknown as SessionInfo

// Live server status deliberately says "enabled" in every case below so the
// assertions can distinguish which source the display chain consulted.
const apptoolsStatus = {
  name: 'apptools',
  description: 'First-party git tools bound to the session cwd',
  enabled: true,
  injected: true,
  requiresCwd: true,
  hasCwd: true,
}

function renderPanel(opts: {
  session?: SessionInfo
  globalPrefs?: Record<string, unknown>
}) {
  return render(
    <ToastProvider>
      <SettingsPanel
        session={opts.session ?? mkSession()}
        globalPrefs={
          {
            showPinnedUserMessage: true,
            autoRecap: true,
            ...opts.globalPrefs,
          } as Parameters<typeof SettingsPanel>[0]['globalPrefs']
        }
        onClose={() => {}}
        onSessionUpdate={() => {}}
        tabRequest={{ tab: 'mcp', nonce: 1 }}
      />
    </ToastProvider>,
  )
}

/** The ON/OFF label of the first apptools row, once the section renders. */
async function findApptoolsToggle(container: HTMLElement) {
  await waitFor(() => expect(container.textContent).toContain('apptools'))
  const row = container.querySelector('.settings-first-party-row')
  expect(row, 'first-party row').toBeDefined()
  const label = row!.querySelector('.settings-toggle span')
  expect(label, 'first-party ON/OFF label').toBeDefined()
  return label!.textContent
}

describe('SettingsPanel first-party row display chain', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url.endsWith('/mcp-status')) return Promise.resolve({ mcp: [] })
      if (url.endsWith('/tools')) return Promise.resolve({ tools: [apptoolsStatus] })
      if (url === '/profiles') return Promise.resolve({ profiles: [] })
      if (url === '/config') return Promise.resolve({ models: [] })
      return Promise.resolve({})
    })
  })

  it('inherits from the global firstPartyTools map when no session override exists', async () => {
    // Global default OFF must win over the stale live status (enabled: true).
    const { container } = renderPanel({
      session: mkSession(),
      globalPrefs: { firstPartyTools: { apptools: { enabled: false } } },
    })
    await expect(findApptoolsToggle(container)).resolves.toBe('OFF')
  })

  it('prefers a session override over the global map', async () => {
    const { container } = renderPanel({
      session: mkSession({ apptools: true }),
      globalPrefs: { firstPartyTools: { apptools: { enabled: false } } },
    })
    await expect(findApptoolsToggle(container)).resolves.toBe('ON')
  })

  it('falls back to the live tool status when the global map lacks the name', async () => {
    const { container } = renderPanel({
      session: mkSession(),
      globalPrefs: { firstPartyTools: {} },
    })
    await expect(findApptoolsToggle(container)).resolves.toBe('ON')
  })
})
