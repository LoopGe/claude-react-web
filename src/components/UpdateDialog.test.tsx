// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { UpdateDialog } from './UpdateDialog'
import type { UpdateInfo } from '../../shared/update-info'

const { getNotes } = vi.hoisted(() => ({ getNotes: vi.fn() }))
const mockToast = { success: vi.fn(), error: vi.fn(), info: vi.fn() }

vi.mock('../hooks/useReleaseNotes', () => ({
  useReleaseNotes: (enabled: boolean) =>
    enabled
      ? { releases: getNotes(), loading: false, error: null }
      : { releases: null, loading: false, error: null },
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
})
