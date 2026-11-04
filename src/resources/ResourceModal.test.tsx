// Resource preview modal behaviour: open-by-identity dedupe, focus-on-reopen,
// body states, restore (never auto-opens), and close-collapses
// (docs/resource-tabs-research.md §12).

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ResourcePaneProvider } from './ResourcePaneProvider'
import { ResourceModal } from './ResourceModal'
import { useOpenResource } from './context'
import type { ResourceProvider } from './registry'
import { fileResource } from '../../shared/resource-address'

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

  it('restores tabs closed (never auto-opens) and the reopen control opens them', async () => {
    seedStoredTabs([{ id: 't1', kind: 'file', address: A }])
    renderHarness([fileProvider()])
    const reopen = await screen.findByRole('button', { name: 'Show resource preview' })
    expect(screen.queryByRole('tablist')).toBeNull()
    fireEvent.click(reopen)
    expect(await screen.findByRole('tab', { name: 'a.ts' })).toBeTruthy()
    expect(await screen.findByText(/hello world/)).toBeTruthy()
  })

  it('a restored closed surface opens no streams until reopened', async () => {
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
    await screen.findByRole('button', { name: 'Show resource preview' })
    expect(opens).toBe(0)
  })

  it('closing the last chip drops the surface entirely', async () => {
    renderHarness([fileProvider()])
    fireEvent.click(screen.getByText('open-file'))
    await screen.findByRole('tab', { name: 'a.ts' })
    fireEvent.click(screen.getByRole('button', { name: 'Close a.ts' }))
    expect(screen.queryByRole('tablist')).toBeNull()
    // No tabs left → neither the modal nor the reopen control remains.
    expect(screen.queryByRole('button', { name: 'Show resource preview' })).toBeNull()
  })

  it('renders a clear message for a restored kind nothing can open', async () => {
    seedStoredTabs([
      { id: 't1', kind: 'diff', address: 'crw-resource://diff/s1/worktree/a.ts' },
    ])
    renderHarness([fileProvider()])
    fireEvent.click(await screen.findByRole('button', { name: 'Show resource preview' }))
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
    // Tabs survive, but the modal must not pop open again.
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(await screen.findByRole('button', { name: 'Show resource preview' })).toBeTruthy()
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
})