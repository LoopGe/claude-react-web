// Resource preview modal behaviour: open-by-identity dedupe, focus-on-reopen,
// body states, restore (never auto-opens), and close-collapses
// (docs/resource-tabs-research.md §12).

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ResourcePaneProvider } from './ResourcePaneProvider'
import { ResourceModal } from './ResourceModal'
import { ResourcePreviewButton } from './ResourcePreviewButton'
import { useOpenResource } from './context'
import type { ResourceProvider } from './registry'
import { fileResource, diffResource, snapshotDiffResource, taskResource } from '../../shared/resource-address'

const { apiPostMock, capabilityMock, toastErrorMock } = vi.hoisted(() => ({
  apiPostMock: vi.fn(),
  capabilityMock: vi.fn(),
  toastErrorMock: vi.fn(),
}))

vi.mock('../hooks/useApi', () => ({ api: { post: apiPostMock } }))
vi.mock('../hooks/useOpenPathCapability', () => ({ useOpenPathCapability: capabilityMock }))
vi.mock('../hooks/useToast', () => ({
  useToast: () => ({ error: toastErrorMock }),
  apiErrorToastOpts: () => undefined,
}))

const HTML = fileResource('s1', '/repo/page.html')

const A = fileResource('s1', '/repo/a.ts')
const B = fileResource('s1', '/repo/b.ts')
const KEY = 'crw.resource-pane.v1.s1'

function fileProvider(contents = 'hello world'): ResourceProvider {
  return {
    protocol: 'file',
    async *open() {
      yield { ok: true, value: { available: true, contents } }
    },
  }
}

function Harness({ address }: { address: string }) {
  const open = useOpenResource()
  return (
    <>
      <button type="button" onClick={() => open('s1', address)}>
        open-file
      </button>
      <ResourceModal sessionId="s1" visible />
    </>
  )
}

function MultiHarness({ addresses }: { addresses: string[] }) {
  const open = useOpenResource()
  return (
    <>
      {addresses.map((address, index) => (
        <button key={address} type="button" onClick={() => open('s1', address)}>
          open-{index}
        </button>
      ))}
      <ResourceModal sessionId="s1" visible />
    </>
  )
}

function VisibilityHarness({ visible }: { visible: boolean }) {
  const open = useOpenResource()
  return (
    <>
      <button type="button" onClick={() => open('s1', A)}>
        open-file
      </button>
      <ResourceModal sessionId="s1" visible={visible} />
    </>
  )
}

/* For restore cases: opens the modal via the app-header toggle (which bypasses
   openResource's provider check), like the real UI does. */
function ShowRestoredHarness() {
  return (
    <>
      <ResourcePreviewButton sessionId="s1" />
      <ResourceModal sessionId="s1" visible />
    </>
  )
}

function renderHarness(providers: ResourceProvider[], address = A) {
  return render(
    <ResourcePaneProvider providers={providers}>
      <Harness address={address} />
    </ResourcePaneProvider>,
  )
}

function seedStoredTabs(tabs: unknown[]) {
  window.localStorage.setItem(
    KEY,
    JSON.stringify({ tabs, activeTabId: (tabs[0] as { id: string }).id, widthPx: 420 }),
  )
}

beforeEach(() => {
  apiPostMock.mockReset()
  apiPostMock.mockResolvedValue({ ok: true })
  capabilityMock.mockReset()
  capabilityMock.mockReturnValue(true)
  toastErrorMock.mockReset()
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }))
  window.localStorage.clear()
})

describe('ResourceModal', () => {
  it('opens a chip and renders the resource body', async () => {
    renderHarness([fileProvider()])
    fireEvent.click(screen.getByText('open-file'))
    expect(await screen.findByRole('tab', { name: 'a.ts' })).toBeTruthy()
    expect(await screen.findByText(/hello world/)).toBeTruthy()
  })

  it('a second open of the same address keeps one chip and focuses it', async () => {
    renderHarness([fileProvider()])
    fireEvent.click(screen.getByText('open-file'))
    await screen.findByRole('tab', { name: 'a.ts' })
    fireEvent.click(screen.getByText('open-file'))
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(1))
    expect(screen.getByRole('tab', { name: 'a.ts' }).getAttribute('aria-selected')).toBe('true')
  })

  it('shows a provider failure instead of a blank body', async () => {
    renderHarness([
      {
        protocol: 'file',
        async *open() {
          yield {
            ok: false,
            failure: { code: 'file/read-failed', message: 'Session is not live' },
          }
        },
      },
    ])
    fireEvent.click(screen.getByText('open-file'))
    expect(await screen.findByText('Session is not live')).toBeTruthy()
  })

  it('keeps the last-good content visible beside a refetch failure', async () => {
    renderHarness([
      {
        protocol: 'file',
        async *open() {
          yield { ok: true, value: { available: true, contents: 'hello world' } }
          yield { ok: false, failure: { code: 'file/read-failed', message: 'refetch failed' } }
        },
      },
    ])
    fireEvent.click(screen.getByText('open-file'))
    expect(await screen.findByText('refetch failed')).toBeTruthy()
    expect(screen.getByText(/hello world/)).toBeTruthy()
  })

  it('closes on Escape', async () => {
    renderHarness([fileProvider()])
    fireEvent.click(screen.getByText('open-file'))
    const tab = await screen.findByRole('tab', { name: 'a.ts' })
    tab.focus()
    fireEvent.keyDown(tab, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('tablist')).toBeNull())
  })

  it('restores tabs closed (never auto-opens) and reuses the restored tab', async () => {
    seedStoredTabs([{ id: 't1', kind: 'file', address: A }])
    renderHarness([fileProvider()])
    expect(screen.queryByRole('tablist')).toBeNull()
    // Reopening the same address focuses the restored tab instead of
    // duplicating it.
    fireEvent.click(screen.getByText('open-file'))
    expect((await screen.findByRole('tab', { name: 'a.ts' })).getAttribute('data-resource-tab')).toBe(
      't1',
    )
    expect(screen.getAllByRole('tab')).toHaveLength(1)
  })

  it('a restored closed surface opens no streams', async () => {
    seedStoredTabs([{ id: 't1', kind: 'file', address: A }])
    let opens = 0
    renderHarness([
      {
        protocol: 'file',
        async *open() {
          opens++
          yield { ok: true, value: { available: true, contents: 'hello world' } }
        },
      },
    ])
    await waitFor(() => expect(screen.queryByRole('tablist')).toBeNull())
    // Give hydration/pin effects a tick: a restored surface must not subscribe.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(opens).toBe(0)
  })

  it('closing the last chip drops the surface entirely', async () => {
    renderHarness([fileProvider()])
    fireEvent.click(screen.getByText('open-file'))
    await screen.findByRole('tab', { name: 'a.ts' })
    fireEvent.click(screen.getByRole('button', { name: 'Close a.ts' }))
    expect(screen.queryByRole('tablist')).toBeNull()
  })

  it('renders a clear message for a restored kind nothing can open', async () => {
    seedStoredTabs([
      { id: 't1', kind: 'future', address: 'crw-resource://future/s1/x' },
    ])
    render(
      <ResourcePaneProvider providers={[fileProvider()]}>
        <ShowRestoredHarness />
      </ResourcePaneProvider>,
    )
    // The header toggle opens the restored (unknown-kind) tab without going
    // through openResource's provider check.
    fireEvent.click(await screen.findByRole('button', { name: /show resource preview/i }))
    expect(await screen.findByText('Nothing can open this address.')).toBeTruthy()
  })

  it('ArrowRight selects the next tab', async () => {
    render(
      <ResourcePaneProvider providers={[fileProvider()]}>
        <MultiHarness addresses={[A, B]} />
      </ResourcePaneProvider>,
    )
    fireEvent.click(screen.getByText('open-0'))
    await screen.findByRole('tab', { name: 'a.ts' })
    fireEvent.click(screen.getByText('open-1'))
    const second = await screen.findByRole('tab', { name: 'b.ts' })
    // The second open made B active; arrows move relative to the ACTIVE tab.
    second.focus()
    fireEvent.keyDown(second, { key: 'ArrowRight' })
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'a.ts' }).getAttribute('aria-selected')).toBe('true')
    })
    fireEvent.keyDown(screen.getByRole('tab', { name: 'a.ts' }), { key: 'ArrowRight' })
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'b.ts' }).getAttribute('aria-selected')).toBe('true')
    })
  })

  it('renders a diff resource body', async () => {
    const address = diffResource({
      sessionId: 's1',
      cwd: '/repo',
      path: 'src/a.ts',
      basis: { type: 'worktree' },
    })
    const provider: ResourceProvider = {
      protocol: 'diff',
      async *open() {
        yield {
          ok: true,
          value: {
            path: 'src/a.ts',
            staged: false,
            truncated: false,
            totalLines: 3,
            text: '@@ -1 +1 @@\n-x\n+y\n',
            isBinary: false,
          },
        }
      },
    }
    renderHarness([provider], address)
    fireEvent.click(screen.getByText('open-file'))
    expect(await screen.findByText('worktree')).toBeTruthy()
    expect(await screen.findByText('src/a.ts')).toBeTruthy()
    expect(document.body.querySelectorAll('.git-diff-row').length).toBeGreaterThan(0)
  })

  it('renders the snapshot-diff file list and switches files', async () => {
    const address = snapshotDiffResource('s1', 'm1')
    const provider: ResourceProvider = {
      protocol: 'snapshot-diff',
      async *open() {
        yield {
          ok: true,
          value: {
            diffs: [
              {
                file: 'src/a.ts',
                status: 'modified',
                additions: 1,
                deletions: 1,
                patch: '@@ -1 +1 @@\n-a\n+new-a\n',
              },
              {
                file: 'src/b.ts',
                status: 'added',
                additions: 1,
                deletions: 0,
                patch: '@@ -0,0 +1 @@\n+new-b\n',
              },
            ],
          },
        }
      },
    }
    renderHarness([provider], address)
    fireEvent.click(screen.getByText('open-file'))
    expect(await screen.findByText('src/a.ts')).toBeTruthy()
    expect(await screen.findByText('src/b.ts')).toBeTruthy()
    expect(await screen.findByText('new-a')).toBeTruthy()
    fireEvent.click(screen.getByText('src/b.ts'))
    expect(await screen.findByText('new-b')).toBeTruthy()
  })

  it('refreshes the snapshot diff on demand', async () => {
    let opens = 0
    const address = snapshotDiffResource('s1', 'm2')
    const provider: ResourceProvider = {
      protocol: 'snapshot-diff',
      async *open() {
        opens += 1
        yield { ok: true, value: { diffs: [] } }
      },
    }
    renderHarness([provider], address)
    fireEvent.click(screen.getByText('open-file'))
    await screen.findByText('No file changes at this anchor.')
    expect(opens).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: /refresh snapshot diff/i }))
    await waitFor(() => expect(opens).toBe(2))
  })

  it('opens a markdown file link as a resource with its line target', async () => {
    const readme = fileResource('s1', '/repo/docs/README.md')
    const target = fileResource('s1', '/repo/src/a.ts')
    const provider: ResourceProvider = {
      protocol: 'file',
      async *open(address) {
        if (address === readme) {
          yield {
            ok: true,
            value: {
              available: true,
              contents: '[open code](../src/a.ts#L10)\n\n[external](https://example.com)\n\n[api](/api/settings)',
            },
          }
          return
        }
        if (address === target) {
          const contents = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n')
          yield { ok: true, value: { available: true, contents } }
          return
        }
        yield { ok: true, value: { available: true, contents: '' } }
      },
    }
    renderHarness([provider], readme)
    fireEvent.click(screen.getByText('open-file'))
    const link = await screen.findByRole('link', { name: 'open code' })
    expect(screen.getByRole('link', { name: 'external' }).getAttribute('target')).toBe('_blank')
    // Root-relative hrefs are web URLs, not workspace files.
    expect(screen.getByRole('link', { name: 'api' }).getAttribute('target')).toBe('_blank')

    fireEvent.click(link)
    expect(await screen.findByRole('tab', { name: 'a.ts' })).toBeTruthy()
    await waitFor(() => {
      expect(document.querySelector('[data-line="10"]')?.className).toContain('code-line-target')
    })
  })

  it('opens a task resource without a provider (client-local kind)', async () => {
    const address = taskResource('s1', 'task-123456789')
    renderHarness([fileProvider()], address)
    fireEvent.click(screen.getByText('open-file'))
    expect(await screen.findByRole('tab', { name: 'Task task-123' })).toBeTruthy()
    expect(await screen.findByText(/loading task/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open in system browser' })).toBeNull()
  })

  it('does not create a chip for a kind with no provider', () => {
    renderHarness([fileProvider()], 'crw-resource://diff/s1/worktree/a.ts')
    fireEvent.click(screen.getByText('open-file'))
    expect(screen.queryByRole('tablist')).toBeNull()
  })

  it('hiding the panel collapses the modal and it does not auto-open on return', async () => {
    const { rerender } = render(
      <ResourcePaneProvider providers={[fileProvider()]}>
        <VisibilityHarness visible />
      </ResourcePaneProvider>,
    )
    fireEvent.click(screen.getByText('open-file'))
    await screen.findByRole('tab', { name: 'a.ts' })

    rerender(
      <ResourcePaneProvider providers={[fileProvider()]}>
        <VisibilityHarness visible={false} />
      </ResourcePaneProvider>,
    )
    await waitFor(() => expect(screen.queryByRole('tablist')).toBeNull())

    rerender(
      <ResourcePaneProvider providers={[fileProvider()]}>
        <VisibilityHarness visible />
      </ResourcePaneProvider>,
    )
    // Tabs survive, but the modal must not pop open again (the header button
    // owns reopening now).
    expect(screen.queryByRole('tablist')).toBeNull()
  })

  it('disambiguates chips that share a basename with a parent path', async () => {
    const other = fileResource('s1', '/repo/src/a.ts') // same basename as A
    render(
      <ResourcePaneProvider providers={[fileProvider()]}>
        <MultiHarness addresses={[A, other]} />
      </ResourcePaneProvider>,
    )
    fireEvent.click(screen.getByText('open-0'))
    // One tab: the plain basename is unambiguous.
    await screen.findByRole('tab', { name: 'a.ts' })
    fireEvent.click(screen.getByText('open-1'))
    // Two tabs share the basename, so both switch to parent/base.
    expect(await screen.findByRole('tab', { name: 'src/a.ts' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'repo/a.ts' })).toBeTruthy()
  })

  it('opens the active HTML file in the system browser', async () => {
    renderHarness([fileProvider()], HTML)
    fireEvent.click(screen.getByText('open-file'))

    fireEvent.click(await screen.findByRole('button', { name: 'Open in system browser' }))

    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledWith('/open-path', { path: '/repo/page.html', target: 'browser' })
    })
  })

  it.each(['/repo/page.htm', '/repo/page.HTML', '/repo/page.HTM'])(
    'shows the browser action for %s',
    async (path) => {
      renderHarness([fileProvider()], fileResource('s1', path))
      fireEvent.click(screen.getByText('open-file'))

      expect(await screen.findByRole('button', { name: 'Open in system browser' })).toBeTruthy()
    },
  )

  it('shows the browser action only while the HTML tab is active', async () => {
    render(
      <ResourcePaneProvider providers={[fileProvider()]}>
        <MultiHarness addresses={[HTML, A]} />
      </ResourcePaneProvider>,
    )
    fireEvent.click(screen.getByText('open-0'))
    expect(await screen.findByRole('button', { name: 'Open in system browser' })).toBeTruthy()

    fireEvent.click(screen.getByText('open-1'))

    expect(await screen.findByRole('tab', { name: 'a.ts' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open in system browser' })).toBeNull()
  })

  it('hides the browser action for a remote client', async () => {
    capabilityMock.mockReturnValue(false)
    renderHarness([fileProvider()], HTML)
    fireEvent.click(screen.getByText('open-file'))

    expect(await screen.findByRole('tab', { name: 'page.html' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open in system browser' })).toBeNull()
  })

  it('disables the browser action until the request settles', async () => {
    let resolvePost!: (value: { ok: boolean }) => void
    apiPostMock.mockReturnValue(new Promise<{ ok: boolean }>((resolve) => { resolvePost = resolve }))
    renderHarness([fileProvider()], HTML)
    fireEvent.click(screen.getByText('open-file'))
    const button = await screen.findByRole('button', { name: 'Open in system browser' })

    fireEvent.click(button)
    expect((button as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(button)
    expect(apiPostMock).toHaveBeenCalledTimes(1)

    resolvePost({ ok: true })
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
  })

  it('does not block a different HTML tab while another launch is pending', async () => {
    const otherHtml = fileResource('s1', '/repo/other.html')
    let resolvePost!: (value: { ok: boolean }) => void
    apiPostMock.mockReturnValue(new Promise<{ ok: boolean }>((resolve) => { resolvePost = resolve }))
    render(
      <ResourcePaneProvider providers={[fileProvider()]}>
        <MultiHarness addresses={[HTML, otherHtml]} />
      </ResourcePaneProvider>,
    )
    fireEvent.click(screen.getByText('open-0'))
    fireEvent.click(await screen.findByRole('button', { name: 'Open in system browser' }))

    fireEvent.click(screen.getByText('open-1'))
    const otherButton = await screen.findByRole('button', { name: 'Open in system browser' })
    expect((otherButton as HTMLButtonElement).disabled).toBe(false)

    resolvePost({ ok: true })
    fireEvent.click(screen.getByText('open-0'))
    const originalButton = await screen.findByRole('button', { name: 'Open in system browser' })
    await waitFor(() => expect((originalButton as HTMLButtonElement).disabled).toBe(false))
  })

  it('keeps an HTML launch pending after switching away and back', async () => {
    let resolvePost!: (value: { ok: boolean }) => void
    apiPostMock.mockReturnValue(new Promise<{ ok: boolean }>((resolve) => { resolvePost = resolve }))
    render(
      <ResourcePaneProvider providers={[fileProvider()]}>
        <MultiHarness addresses={[HTML, A]} />
      </ResourcePaneProvider>,
    )
    fireEvent.click(screen.getByText('open-0'))
    fireEvent.click(await screen.findByRole('button', { name: 'Open in system browser' }))

    fireEvent.click(screen.getByText('open-1'))
    await screen.findByRole('tab', { name: 'a.ts' })
    fireEvent.click(screen.getByText('open-0'))
    const button = await screen.findByRole('button', { name: 'Open in system browser' })

    expect((button as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(button)
    expect(apiPostMock).toHaveBeenCalledTimes(1)
    resolvePost({ ok: true })
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
  })

  it('reports a browser-open failure and allows retry', async () => {
    apiPostMock.mockRejectedValue(new Error('file is missing'))
    renderHarness([fileProvider()], HTML)
    fireEvent.click(screen.getByText('open-file'))
    const button = await screen.findByRole('button', { name: 'Open in system browser' })

    fireEvent.click(button)

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith("Couldn't open in system browser: file is missing", undefined)
    })
    expect((button as HTMLButtonElement).disabled).toBe(false)
  })
})
