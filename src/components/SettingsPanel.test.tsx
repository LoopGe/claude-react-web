import { useState } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, waitFor } from '@testing-library/react'
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

/** The action button (Enable/Disable) of the apptools card, once the section
 *  renders. Mirrors the MCP server card, so the label is state-dependent. */
async function findApptoolsAction(container: HTMLElement) {
  await waitFor(() => expect(container.textContent).toContain('apptools'))
  const card = container.querySelector('.settings-first-party-card')
  expect(card, 'first-party card').toBeDefined()
  const action = [...card!.querySelectorAll('button')].find(
    (b) => b.textContent === 'Enable' || b.textContent === 'Disable',
  )
  expect(action, 'first-party Enable/Disable action').toBeDefined()
  return action!.textContent
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
    await expect(findApptoolsAction(container)).resolves.toBe('Enable')
  })

  it('prefers a session override over the global map', async () => {
    const { container } = renderPanel({
      session: mkSession({ apptools: true }),
      globalPrefs: { firstPartyTools: { apptools: { enabled: false } } },
    })
    await expect(findApptoolsAction(container)).resolves.toBe('Disable')
  })

  it('falls back to the live tool status when the global map lacks the name', async () => {
    const { container } = renderPanel({
      session: mkSession(),
      globalPrefs: { firstPartyTools: {} },
    })
    await expect(findApptoolsAction(container)).resolves.toBe('Disable')
  })

  it('expands the embedded tool listing inline on chevron (read-only badge on git_status)', async () => {
    const { container } = renderPanel({
      session: mkSession(),
      globalPrefs: { firstPartyTools: {} },
    })
    await waitFor(() => expect(container.textContent).toContain('apptools'))
    expect(container.textContent).not.toContain('git_status')

    const card = container.querySelector('.settings-first-party-card')!
    const expand = card.querySelector('button[aria-label="Expand"]') as HTMLButtonElement | null
    expect(expand, 'expand chevron').toBeDefined()
    fireEvent.click(expand!)

    await waitFor(() => expect(container.textContent).toContain('git_status'))
    expect(container.textContent).toContain('git_stage')
    expect(card.querySelector('.settings-tag.readonly')).toBeDefined()
  })

  it('shows a pending spinner while the toggle round-trip is in flight', async () => {
    let release!: (value: unknown) => void
    ;(api.post as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () =>
        new Promise((res) => {
          release = res
        }),
    )
    // Stateful wrapper: applies onSessionUpdate responses so the card really
    // reconciles (renderPanel's no-op updater would hide a regression where
    // the toggle response is never reflected in the card state).
    const Harness = () => {
      const [session, setSession] = useState(mkSession())
      return (
        <ToastProvider>
          <SettingsPanel
            session={session}
            globalPrefs={
              {
                showPinnedUserMessage: true,
                autoRecap: true,
                firstPartyTools: {},
              } as Parameters<typeof SettingsPanel>[0]['globalPrefs']
            }
            onClose={() => {}}
            onSessionUpdate={setSession}
            tabRequest={{ tab: 'mcp', nonce: 1 }}
          />
        </ToastProvider>
      )
    }
    const { container } = render(<Harness />)
    await waitFor(() => expect(container.textContent).toContain('apptools'))
    const card = container.querySelector('.settings-first-party-card')!
    const disable = [...card.querySelectorAll('button')].find((b) => b.textContent === 'Disable')
    expect(disable, 'Disable action').toBeDefined()
    fireEvent.click(disable!)

    await waitFor(() => expect(card.querySelector('.settings-card-pending')).toBeDefined())

    // Release the round-trip inside act so the response is applied: the
    // returned session carries the override, so the card must flip to Enable
    // and expose the Reset (inherit global) link.
    await act(async () => {
      release({ session: mkSession({ apptools: false }) })
    })
    expect(card.querySelector('.settings-card-pending')).toBeNull()
    expect([...card.querySelectorAll('button')].some((b) => b.textContent === 'Enable')).toBe(true)
    expect(card.textContent).toContain('Reset (inherit global)')
  })
})
