// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { UpdateDialog } from './UpdateDialog'
import type { UpdateInfo } from '../../shared/update-info'

const { getNotes, getError, notesArgs } = vi.hoisted(() => ({
  getNotes: vi.fn(),
  getError: vi.fn().mockReturnValue(null),
  notesArgs: vi.fn(),
}))
const mockToast = { success: vi.fn(), error: vi.fn(), info: vi.fn() }

vi.mock('../hooks/useReleaseNotes', () => ({
  useReleaseNotes: (enabled: boolean, from?: string, to?: string, includeFrom?: boolean) => {
    notesArgs({ enabled, from, to, includeFrom })
    return enabled
      ? { releases: getNotes(), loading: false, error: getError() }
      : { releases: null, loading: false, error: null }
  },
}))
vi.mock('../hooks/useToast', () => ({
  useToast: () => mockToast,
}))

afterEach(() => {
  cleanup()
  localStorage.clear()
})

function baseInfo(over: Partial<UpdateInfo> = {}): UpdateInfo {
  return {
    current: '0.7.2',
    installed: '0.7.2',
    packageName: 'claude-react-web',
    installMethod: 'global',
    registry: undefined,
    latest: '0.8.0',
    hasUpdate: true,
    updateAppliedToDisk: false,
    source: 'npm',
    checkedAt: 1,
    repoUrl: 'https://github.com/LoopGe/claude-react-web',
    ...over,
  }
}

function baseProps(over: Partial<React.ComponentProps<typeof UpdateDialog>> = {}) {
  return {
    open: true,
    mode: 'update' as const,
    info: baseInfo(),
    updating: false,
    onUpdate: vi.fn(async () => ({
      performed: true,
      installMethod: 'global' as const,
      restartRequired: true,
      updateApplied: true,
      installedVersion: '0.8.0',
      versionChanged: true,
    })),
    onClose: vi.fn(),
    ...over,
  }
}

const NOTE = {
  version: '0.8.0',
  name: '0.8.0',
  body: '## Added\n- shiny thing',
  publishedAt: '2026-09-10T00:00:00Z',
  url: 'https://github.com/LoopGe/claude-react-web/releases/tag/v0.8.0',
}

describe('UpdateDialog', () => {
  beforeEach(() => {
    getNotes.mockReset()
    getNotes.mockReturnValue([NOTE])
    getError.mockReset()
    getError.mockReturnValue(null)
    notesArgs.mockReset()
  })

  it('renders header, release sections, and footer buttons', () => {
    const { getByRole, getByText } = render(<UpdateDialog {...baseProps()} />)
    expect(getByRole('dialog')).toBeTruthy()
    expect(getByText(/What's new in 0\.8\.0/)).toBeTruthy()
    expect(getByText('0.8.0')).toBeTruthy()
    expect(getByText('2026-09-10')).toBeTruthy()
    expect(getByText('Update now')).toBeTruthy()
    expect(getByText('Copy command')).toBeTruthy()
    expect(getByText('Later')).toBeTruthy()
  })

  it('hides Update now for npx installs', () => {
    const { queryByText } = render(
      <UpdateDialog {...baseProps({ info: baseInfo({ installMethod: 'npx' }) })} />,
    )
    expect(queryByText('Update now')).toBeNull()
    expect(getByTextSafe(queryByText, 'Copy command')).toBeTruthy()
  })
  function getByTextSafe(query: (t: string) => HTMLElement | null, t: string) {
    return query(t)
  }

  it('runs the update on Update now, then closes on success', async () => {
    const onUpdate = vi.fn(async () => ({
      performed: true,
      installMethod: 'global' as const,
      restartRequired: true,
      updateApplied: true,
      installedVersion: '0.8.0',
      versionChanged: true,
    }))
    const onClose = vi.fn()
    const { getByText } = render(<UpdateDialog {...baseProps({ onUpdate, onClose })} />)
    fireEvent.click(getByText('Update now'))
    await waitFor(() => expect(onUpdate).toHaveBeenCalledOnce())
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
  })

  it('keeps the dialog open when the update throws', async () => {
    const onUpdate = vi.fn(async () => {
      throw new Error('npm exploded')
    })
    const onClose = vi.fn()
    const { getByText } = render(<UpdateDialog {...baseProps({ onUpdate, onClose })} />)
    fireEvent.click(getByText('Update now'))
    await waitFor(() => expect(getByText(/npm exploded/)).toBeTruthy())
    expect(onClose).not.toHaveBeenCalled()
  })

  it('Later calls onClose', () => {
    const onClose = vi.fn()
    const { getByText } = render(<UpdateDialog {...baseProps({ onClose })} />)
    fireEvent.click(getByText('Later'))
    expect(onClose).toHaveBeenCalledOnce()
  })

  // Corrected deprecation case: latest=undefined means upgradeable=false,
  // so no "Update now" button. Copy command is present.
  it('renders deprecation mode copy (no latest — only Copy command)', () => {
    const { getByText, queryByText } = render(
      <UpdateDialog
        {...baseProps({
          mode: 'deprecation',
          info: baseInfo({ deprecated: 'Use 0.9 instead.', latest: undefined, hasUpdate: false }),
        })}
      />,
    )
    expect(getByText(/Version 0\.7\.2 is deprecated/)).toBeTruthy()
    expect(getByText('Use 0.9 instead.')).toBeTruthy()
    expect(queryByText('Update now')).toBeNull()
    expect(getByText('Copy command')).toBeTruthy()
  })

  // Deprecation with a known newer version: shows Update now.
  it('renders deprecation mode copy (latest available — shows Update now)', () => {
    const { getByText } = render(
      <UpdateDialog
        {...baseProps({
          mode: 'deprecation',
          info: baseInfo({ deprecated: 'Use 0.9 instead.', latest: '0.9.0', hasUpdate: true }),
        })}
      />,
    )
    expect(getByText(/Version 0\.7\.2 is deprecated/)).toBeTruthy()
    expect(getByText('Use 0.9 instead.')).toBeTruthy()
    expect(getByText('Update now')).toBeTruthy()
    expect(getByText('Copy command')).toBeTruthy()
  })

  it('shows the notes-unavailable note when there are no releases', () => {
    getNotes.mockReturnValue([])
    const { getByText } = render(<UpdateDialog {...baseProps()} />)
    expect(getByText(/Release notes are unavailable/)).toBeTruthy()
  })

  it('shows notes-unavailable with error text on transport failure', () => {
    getNotes.mockReturnValue(null)
    getError.mockReturnValue('network down')
    const { getByText } = render(<UpdateDialog {...baseProps()} />)
    expect(
      getByText('Release notes are unavailable right now (network down).'),
    ).toBeTruthy()
  })

  it('copies the upgrade command and flips to Copied', async () => {
    const writeText = vi.fn(async () => {})
    Object.assign(navigator, { clipboard: { writeText } })
    const { getByText } = render(
      <UpdateDialog {...baseProps({ info: baseInfo({ installMethod: 'npx' }) })} />,
    )
    fireEvent.click(getByText('Copy command'))
    expect(writeText).toHaveBeenCalledWith('npx claude-react-web@latest')
    await waitFor(() => expect(getByText('Copied')).toBeTruthy())
  })

  // ── mode: 'current' — the About tab's "what did the version I run bring" ──

  const NOTE_CURRENT = {
    ...NOTE,
    version: '0.7.2',
    name: '0.7.2',
    url: 'https://github.com/LoopGe/claude-react-web/releases/tag/v0.7.2',
  }

  it("renders the running version's own notes, asked for as an inclusive range", () => {
    getNotes.mockReturnValue([NOTE_CURRENT])
    const { getByRole, getByText } = render(<UpdateDialog {...baseProps({ mode: 'current' })} />)
    expect(getByRole('dialog')).toBeTruthy()
    expect(getByText(/What's new in 0\.7\.2/)).toBeTruthy()
    expect(getByText('0.7.2')).toBeTruthy()
    // from === to with the lower bound made inclusive — that pair is what makes
    // the running version's own entry survive the range filter.
    expect(notesArgs).toHaveBeenCalledWith({
      enabled: true,
      from: '0.7.2',
      to: '0.7.2',
      includeFrom: true,
    })
  })

  it('current mode carries no upgrade footer — only Close', () => {
    const onClose = vi.fn()
    const { getByText, queryByText } = render(
      <UpdateDialog {...baseProps({ mode: 'current', onClose })} />,
    )
    expect(queryByText('Update now')).toBeNull()
    expect(queryByText('Copy command')).toBeNull()
    expect(queryByText('Later')).toBeNull()
    fireEvent.click(getByText('Close'))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('current mode with no Release for this version → distinct copy + a releases link', () => {
    getNotes.mockReturnValue([])
    const { getByText, queryByText } = render(<UpdateDialog {...baseProps({ mode: 'current' })} />)
    expect(getByText('This version has no release notes.')).toBeTruthy()
    expect(queryByText(/Release notes are unavailable/)).toBeNull()
    const link = getByText('Browse all releases on GitHub')
    expect(link.getAttribute('href')).toBe('https://github.com/LoopGe/claude-react-web/releases')
  })

  it('current mode with a transport failure → keeps the unavailable copy, no releases link', () => {
    getNotes.mockReturnValue(null)
    getError.mockReturnValue('network down')
    const { getByText, queryByText } = render(<UpdateDialog {...baseProps({ mode: 'current' })} />)
    expect(getByText('Release notes are unavailable right now (network down).')).toBeTruthy()
    // A GitHub hiccup must not be dressed up as "this version has no notes".
    expect(queryByText('Browse all releases on GitHub')).toBeNull()
  })

  // ── Layering ──
  it('mounts every mode on the portalled modal layer', () => {
    // Not cosmetic, and not the same for both entry points: the About entry
    // opens this dialog from INSIDE GlobalSettingsModal, whose portalled
    // .modal-backdrop sits on the z-modal layer (2000), while the panel-scoped
    // .perm-overlay (absolute, z-index 7) cannot paint above it — on that layer
    // the dialog rendered underneath the modal that launched it: invisible,
    // while its focus trap still took focus. The nag toast can likewise be
    // clicked while that modal is open, so neither mode may use `perm`.
    for (const mode of ['update', 'deprecation', 'current'] as const) {
      cleanup()
      render(<UpdateDialog {...baseProps({ mode })} />)
      expect(document.querySelector('.modal-backdrop'), mode).toBeTruthy()
      expect(document.querySelector('.perm-overlay'), mode).toBeNull()
    }
  })
})
