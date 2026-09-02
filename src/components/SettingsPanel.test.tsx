import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, waitFor } from '@testing-library/react'
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
  tools: [
    { name: 'git_status', description: 'Show git working-tree status.', readOnly: true },
    { name: 'git_stage', description: 'Stage files into the index.', readOnly: false },
  ],
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

/** The ON/OFF toggle of the apptools card, once the section renders. */
async function findApptoolsToggle(container: HTMLElement) {
  await waitFor(() => expect(container.textContent).toContain('apptools'))
  const card = container.querySelector('.settings-first-party-card')
  expect(card, 'first-party card').toBeDefined()
  const toggle = card!.querySelector('.settings-first-party-toggle')
  expect(toggle, 'first-party ON/OFF toggle').toBeDefined()
  return toggle!.textContent
}

describe('SettingsPanel first-party card display chain', () => {
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

  it('expands the embedded tool listing on "List tools" (read-only badge on git_status)', async () => {
    const { container } = renderPanel({
      session: mkSession(),
      globalPrefs: { firstPartyTools: {} },
    })
    await waitFor(() => expect(container.textContent).toContain('apptools'))
    expect(container.textContent).not.toContain('git_status')

    const card = container.querySelector('.settings-first-party-card')!
    const listBtn = [...card.querySelectorAll('button')].find((b) => b.textContent === 'List tools')
    expect(listBtn, 'List tools button').toBeDefined()
    fireEvent.click(listBtn!)

    await waitFor(() => expect(container.textContent).toContain('git_status'))
    expect(container.textContent).toContain('git_stage')
    expect(card.querySelector('.settings-tag.readonly')).toBeDefined()
  })
})
