import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ToastProvider } from './ToastProvider'
import { GlobalSettingsModal } from './GlobalSettingsModal'
import { api } from '../hooks/useApi'
import type { UpdateInfo } from '../../shared/update-info'

vi.mock('../hooks/useApi', () => ({ api: { get: vi.fn(), put: vi.fn() } }))

// jsdom doesn't implement matchMedia; the modal's height-transition and
// exit-presence hooks probe it. Same stub as SettingsPanel/NewSessionDialog.
vi.stubGlobal('matchMedia', () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
}))

afterEach(() => { cleanup() })

// api.get is called for /config/full, /mcp-config and /first-party-tools — route by URL.
function mockGet(config: Record<string, unknown>, fpServers: unknown[] = [apptoolsInfo]) {
  vi.mocked(api.get).mockImplementation((url: string) => {
    if (url === '/mcp-config') return Promise.resolve({ servers: [] })
    if (url === '/first-party-tools') return Promise.resolve({ servers: fpServers })
    return Promise.resolve(config)
  })
}

// Static registry listing as GET /first-party-tools serves it.
const apptoolsInfo = {
  name: 'apptools',
  description: 'First-party git tools bound to the session cwd',
  tools: [
    { name: 'git_status', description: 'Show git working-tree status.', readOnly: true },
    { name: 'git_stage', description: 'Stage files into the index.', readOnly: false },
  ],
}

describe('GlobalSettingsModal Profiles tab', () => {
  it('renders a Profiles tab', async () => {
    mockGet({})
    render(
      <GlobalSettingsModal
        open
        onClose={() => {}}
        onSaved={() => {}}
      />,
    )
    await waitFor(() => expect(screen.getByText('Profiles')).toBeTruthy())
  })
})

describe('GlobalSettingsModal first-party tools section', () => {
  beforeEach(() => {
    vi.mocked(api.put).mockResolvedValue({})
  })

  const openMcpTab = async (config: Record<string, unknown>, fpServers?: unknown[]) => {
    mockGet(config, fpServers)
    render(
      <ToastProvider>
        <GlobalSettingsModal open onClose={() => {}} onSaved={() => {}} />
      </ToastProvider>,
    )
    await waitFor(() => expect(screen.getByText('MCP Servers')).toBeTruthy())
    fireEvent.click(screen.getByText('MCP Servers'))
  }

  /** The apptools card + its staged ON/OFF toggle, once the section renders.
   *  Queried through `screen` / document because the modal portals to body
   *  (Overlay's fixed-backdrop variants always portal — see Overlay.tsx). */
  const apptoolsCard = async () => {
    await waitFor(() => expect(screen.getByText('First-party tools')).toBeTruthy())
    const card = document.querySelector('.settings-first-party-card')
    expect(card, 'first-party card').toBeDefined()
    const toggle = card!.querySelector('.settings-first-party-toggle') as HTMLButtonElement
    expect(toggle, 'first-party ON/OFF toggle').toBeDefined()
    return { card: card!, toggle }
  }

  it('renders one card per first-party server from the config map', async () => {
    await openMcpTab({ firstPartyTools: { apptools: { enabled: true } } })
    const { toggle } = await apptoolsCard()
    expect(screen.getByText('apptools')).toBeTruthy()
    expect(toggle.textContent).toBe('ON')
  })

  it('stages toggles locally and saves the structured key on Save', async () => {
    await openMcpTab({ firstPartyTools: { apptools: { enabled: true } } })
    const { toggle } = await apptoolsCard()

    fireEvent.click(toggle)
    // Staged — nothing hits the network until Save.
    expect(api.put).not.toHaveBeenCalled()
    expect(toggle.textContent).toBe('OFF')

    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(api.put).toHaveBeenCalled())
    expect(vi.mocked(api.put)).toHaveBeenCalledWith(
      '/config',
      expect.objectContaining({ firstPartyTools: { apptools: { enabled: false } } }),
    )
  })

  it('expands the static tool listing on "List tools" (read-only badge on git_status)', async () => {
    await openMcpTab({ firstPartyTools: { apptools: { enabled: true } } })
    const { card } = await apptoolsCard()
    expect(screen.queryByText('git_status')).toBeNull()

    const listBtn = [...card.querySelectorAll('button')].find((b) => b.textContent === 'List tools')
    expect(listBtn, 'List tools button').toBeDefined()
    fireEvent.click(listBtn!)

    await waitFor(() => expect(screen.getByText('git_status')).toBeTruthy())
    expect(screen.getByText('git_stage')).toBeTruthy()
    expect(card.querySelector('.settings-tag.readonly')).toBeDefined()
  })

  it('hides the section when the global map is empty', async () => {
    await openMcpTab({ firstPartyTools: {} })
    await waitFor(() => expect(screen.getByText('MCP Servers')).toBeTruthy())
    expect(screen.queryByText('First-party tools')).toBeNull()
  })
})

describe('GlobalSettingsModal Server tab', () => {
  beforeEach(() => {
    vi.mocked(api.put).mockResolvedValue({})
  })

  const openServerTab = async (config: Record<string, unknown>) => {
    mockGet(config)
    render(
      <ToastProvider>
        <GlobalSettingsModal open onClose={() => {}} onSaved={() => {}} />
      </ToastProvider>,
    )
    await waitFor(() => expect(screen.getByRole('button', { name: 'Server' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Server' }))
    // Content is gated on the /config/full fetch — wait for a Server-only control.
    await waitFor(() => expect(screen.getByRole('radiogroup', { name: 'Max group panels' })).toBeTruthy())
  }

  const save = () => fireEvent.click(screen.getByText('Save'))

  it('renders human units, the segmented panel picker, and switch states from config', async () => {
    await openServerTab({
      maxUploadBytes: 30 * 1024 * 1024,
      historyCap: 1000,
      maxGroupPanels: 4,
      workingStuckMs: 3600000,
      // Deliberately the NON-default (true) so this asserts the value came
      // from /config/full rather than the useState(false) initial.
      allowSensitivePathEdits: true,
    })

    // Bytes → MB and ms → minutes, with unit suffixes (not raw 31457280 / 3600000).
    expect((screen.getByLabelText('Max upload size, in megabytes') as HTMLInputElement).value).toBe('30')
    expect(screen.getByText('MB')).toBeTruthy()
    expect((screen.getByLabelText('History cap') as HTMLInputElement).value).toBe('1000')
    expect((screen.getByLabelText('Working-stuck timeout, in minutes') as HTMLInputElement).value).toBe('60')
    expect(screen.getByText('min')).toBeTruthy()

    // Max group panels is a segmented picker; the configured value is active.
    expect(screen.getByRole('radio', { name: '4' }).getAttribute('aria-checked')).toBe('true')

    // The one switch that stays on this tab reflects its loaded value. The
    // display-defaults switches now live on the Appearance tab (covered by
    // the 'Appearance tab' suite below).
    expect(screen.getByRole('switch', { name: 'Allow editing sensitive paths in auto-approve modes' }).getAttribute('aria-checked')).toBe('true')
  })

  it('steps History cap by the field step and persists the raw value on Save', async () => {
    await openServerTab({ historyCap: 500 })

    fireEvent.click(screen.getByRole('button', { name: 'Increase History cap' }))
    expect((screen.getByLabelText('History cap') as HTMLInputElement).value).toBe('600')

    save()
    await waitFor(() => expect(api.put).toHaveBeenCalled())
    expect(vi.mocked(api.put)).toHaveBeenCalledWith('/config', expect.objectContaining({ historyCap: 600 }))
  })

  it('converts typed MB back to bytes on Save', async () => {
    await openServerTab({ maxUploadBytes: 25 * 1024 * 1024 })

    fireEvent.change(screen.getByLabelText('Max upload size, in megabytes'), { target: { value: '50' } })

    save()
    await waitFor(() => expect(api.put).toHaveBeenCalled())
    expect(vi.mocked(api.put)).toHaveBeenCalledWith('/config', expect.objectContaining({ maxUploadBytes: 50 * 1024 * 1024 }))
  })

  it('converts typed minutes to ms on Save and keeps 0 = disabled semantics', async () => {
    await openServerTab({ workingStuckMs: 3600000 })

    fireEvent.change(screen.getByLabelText('Working-stuck timeout, in minutes'), { target: { value: '0' } })

    save()
    await waitFor(() => expect(api.put).toHaveBeenCalled())
    expect(vi.mocked(api.put)).toHaveBeenCalledWith('/config', expect.objectContaining({ workingStuckMs: 0 }))
  })

  it('does not alter a value when the field is focused and blurred without editing', async () => {
    await openServerTab({ historyCap: 500 })

    const input = screen.getByLabelText('History cap') as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.blur(input)
    expect(input.value).toBe('500')

    save()
    await waitFor(() => expect(api.put).toHaveBeenCalled())
    expect(vi.mocked(api.put)).toHaveBeenCalledWith('/config', expect.objectContaining({ historyCap: 500 }))
  })

  it('restores the previous value when a typed value is cleared', async () => {
    await openServerTab({ historyCap: 500 })

    const input = screen.getByLabelText('History cap') as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)
    expect(input.value).toBe('500')
  })

  it('persists a segmented panel choice and a switch flip', async () => {
    await openServerTab({
      maxGroupPanels: 3,
      showPinnedUserMessage: true,
      autoRecap: true,
      allowSensitivePathEdits: false,
    })

    fireEvent.click(screen.getByRole('radio', { name: '5' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Allow editing sensitive paths in auto-approve modes' }))

    save()
    await waitFor(() => expect(api.put).toHaveBeenCalled())
    expect(vi.mocked(api.put)).toHaveBeenCalledWith('/config', expect.objectContaining({
      maxGroupPanels: 5,
      allowSensitivePathEdits: true,
    }))
  })
})

describe('GlobalSettingsModal About tab', () => {
  const INFO: UpdateInfo = {
    current: '0.7.3',
    packageName: 'claude-react-web',
    installMethod: 'global',
    latest: '0.7.3',
    hasUpdate: false,
    source: 'npm',
    checkedAt: 1,
    repoUrl: 'https://github.com/LoopGe/claude-react-web',
  }

  const openAboutTab = async (
    props: Partial<React.ComponentProps<typeof GlobalSettingsModal>> = {},
  ) => {
    mockGet({})
    render(
      <ToastProvider>
        <GlobalSettingsModal open onClose={() => {}} onSaved={() => {}} {...props} />
      </ToastProvider>,
    )
    await waitFor(() => expect(screen.getByRole('button', { name: 'About' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'About' }))
  }

  it("offers the running version's release notes and hands the click to App", async () => {
    const onOpenCurrentReleaseNotes = vi.fn()
    await openAboutTab({ updateInfo: INFO, onOpenCurrentReleaseNotes })

    const entry = await waitFor(() =>
      screen.getByRole('button', { name: "What's new in 0.7.3" }),
    )
    fireEvent.click(entry)
    expect(onOpenCurrentReleaseNotes).toHaveBeenCalledOnce()
  })

  it('hides the entry whenever it could only be a dead end', async () => {
    // Four independent gates, each leaving the entry pointing at a guaranteed
    // failure: a versionless query; a route that refuses while the registry is
    // unconfigured; a build with no parseable GitHub repository (the route's
    // OTHER unconditional refusal, which only the server can see); and a
    // prerelease build, whose notes would be the stable release of the same
    // major.minor.patch because compareSemver ignores the suffix.
    const cases: Array<[string, UpdateInfo | null]> = [
      ['no snapshot yet', null],
      ['update checks disabled', { ...INFO, disabled: true }],
      ['no GitHub repository in this build', { ...INFO, repoUrl: undefined }],
      ['prerelease build', { ...INFO, current: '0.8.0-rc.1' }],
    ]
    for (const [label, info] of cases) {
      cleanup()
      await openAboutTab({ updateInfo: info, onOpenCurrentReleaseNotes: vi.fn() })
      // Prove the tab actually mounted before asserting absence.
      await waitFor(() => expect(screen.getByText('Project')).toBeTruthy())
      expect(screen.queryByText('Release notes'), label).toBeNull()
    }
  })

  it('links the Source row at the server-reported repo, not a build constant', async () => {
    await openAboutTab({ updateInfo: { ...INFO, repoUrl: 'https://github.com/acme/crw' } })
    // The server derives the slug the notes are fetched from; a fork must not
    // be sent to the upstream project's source.
    const link = await waitFor(() => screen.getByText('github.com/acme/crw'))
    expect(link.getAttribute('href')).toBe('https://github.com/acme/crw')
  })
})

describe('GlobalSettingsModal Appearance tab', () => {
  beforeEach(() => {
    vi.mocked(api.put).mockResolvedValue({})
    // mockResolvedValue only sets an implementation — it does NOT clear the
    // call history. Without this, the `waitFor(api.put).toHaveBeenCalled()`
    // gate below is satisfied instantly by an earlier test's PUT.
    vi.mocked(api.put).mockClear()
  })

  /** Every control the move relocates from the Server tab. Used by both the
   *  presence and the absence assertion so the two lists can't drift. */
  const MOVED_SWITCHES = [
    'Show pinned “current question” header',
    'Auto-generate session recap',
    'Use collapsible tool-group cards',
    'Show message card headers',
  ] as const
  const MOVED_GROUPS = ['Transcript spacing', 'Message text density', 'Font size'] as const

  const openAppearanceTab = async (config: Record<string, unknown>) => {
    mockGet(config)
    render(
      <ToastProvider>
        <GlobalSettingsModal open onClose={() => {}} onSaved={() => {}} />
      </ToastProvider>,
    )
    await waitFor(() => expect(screen.getByRole('button', { name: 'Appearance' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Appearance' }))
    // Content is gated on the /config/full fetch — wait for an Appearance-only control.
    await waitFor(() => expect(screen.getByRole('radiogroup', { name: 'Font size' })).toBeTruthy())
  }

  const save = () => fireEvent.click(screen.getByText('Save'))

  /** aria-checked of one option inside a named segmented group. Scoped by the
   *  radiogroup because the two spacing groups reuse the same option labels. */
  const segmentedActive = (group: string, option: string) =>
    within(screen.getByRole('radiogroup', { name: group }))
      .getByRole('radio', { name: option })
      .getAttribute('aria-checked')

  it('renders every moved display default from config', async () => {
    // Every value is deliberately the NON-default so a dropped /config/full
    // mapping can't pass by coinciding with the useState initial value.
    // (useState defaults: all four switches true, spacious/spacious/standard.)
    await openAppearanceTab({
      showPinnedUserMessage: false,
      autoRecap: false,
      toolGroupCards: false,
      showMessageHeaders: false,
      rowGap: 'comfortable',
      textSpacing: 'compact',
      fontSize: 'large',
    })

    for (const name of MOVED_SWITCHES) {
      expect(screen.getByRole('switch', { name }).getAttribute('aria-checked')).toBe('false')
    }

    // Each segmented group reflects its configured preset.
    expect(segmentedActive('Transcript spacing', 'Comfortable')).toBe('true')
    expect(segmentedActive('Message text density', 'Compact')).toBe('true')
    expect(segmentedActive('Font size', 'Large')).toBe('true')
  })

  it('persists a switch flip and a preset change on Save', async () => {
    await openAppearanceTab({
      showPinnedUserMessage: false,
      fontSize: 'standard',
    })

    fireEvent.click(screen.getByRole('switch', { name: 'Show pinned “current question” header' }))
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Font size' }))
      .getByRole('radio', { name: 'X-Large' }))

    save()
    await waitFor(() => expect(api.put).toHaveBeenCalled())
    expect(vi.mocked(api.put)).toHaveBeenCalledWith('/config', expect.objectContaining({
      showPinnedUserMessage: true,
      fontSize: 'xlarge',
    }))
  })

  it('no longer renders any moved display default on the Server tab', async () => {
    mockGet({})
    render(
      <ToastProvider>
        <GlobalSettingsModal open onClose={() => {}} onSaved={() => {}} />
      </ToastProvider>,
    )
    await waitFor(() => expect(screen.getByRole('button', { name: 'Server' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Server' }))
    // Prove the tab actually mounted before asserting absence.
    await waitFor(() => expect(screen.getByRole('radiogroup', { name: 'Max group panels' })).toBeTruthy())

    // Moved, not duplicated — every relocated control, not a sample.
    for (const name of MOVED_SWITCHES) {
      expect(screen.queryByRole('switch', { name })).toBeNull()
    }
    for (const name of MOVED_GROUPS) {
      expect(screen.queryByRole('radiogroup', { name })).toBeNull()
    }
  })
})
