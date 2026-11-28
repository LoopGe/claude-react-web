import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import { clearResizeObserverStub, fireResize, stubResizeObserver } from '../test/resize-observer-stub'

const mockGet = vi.fn()
const mockDelete = vi.fn()
const mockToast = { success: vi.fn(), error: vi.fn(), info: vi.fn() }

vi.mock('../hooks/useApi', () => ({
  api: {
    get: (...a: unknown[]) => mockGet(...a),
    delete: (...a: unknown[]) => mockDelete(...a),
  },
}))
vi.mock('../hooks/useToast', () => ({
  useToast: () => mockToast,
}))

// Height-animation wiring: the cap math is unit-tested in capped-height-measure.test.ts;
// here the measure is mocked to controlled heights so the wiring is what's under test.
const { measureMock } = vi.hoisted(() => ({ measureMock: vi.fn() }))
vi.mock('../utils/capped-height-measure', () => ({ measureCappedContentHeight: measureMock }))

// Import AFTER the mocks.
import { UploadsManagerDialog } from './UploadsManagerDialog'
import { ResourcePaneProvider } from '../resources/ResourcePaneProvider'
import { uploadResource } from '../../shared/resource-address'
import type { ResourceProvider } from '../resources/registry'

const ROWS = [
  { id: 'a', path: '/p/claude-web-uploads/1-a.txt', cwd: '/p', name: 'a.txt', size: 1024, uploadedAt: Date.now(), sessionTitle: 'Alpha', exists: true },
  { id: 'b', path: '/p/claude-web-uploads/2-b.txt', cwd: '/p', name: 'b.txt', size: 2048, uploadedAt: Date.now(), sessionTitle: 'Beta', exists: false },
]

// The dialog's eye opens a resource tab, so every render needs the pane
// provider. A stub upload provider satisfies the store's canOpen gate; the
// byte fetch is the provider's own test surface, not the dialog's.
function stubUploadProvider(): ResourceProvider {
  return {
    protocol: 'upload',
    async *open() {
      yield { ok: true, value: { kind: 'other', name: 'stub', size: 0 } }
    },
  }
}

function renderDialog(props: { resourceSessionId?: string | null } = {}) {
  return render(
    <ResourcePaneProvider providers={[stubUploadProvider()]}>
      <UploadsManagerDialog open onClose={() => {}} resourceSessionId="s1" {...props} />
    </ResourcePaneProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGet.mockResolvedValue({ uploads: ROWS })
  mockDelete.mockResolvedValue({ ok: true })
  window.localStorage.clear() // the pane store persists per-session tab layouts
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  })
})
afterEach(cleanup)
// Several suites stub globals (matchMedia for the height tween) — always tear
// them down, assertion failure or not, so a stub can't poison later tests.
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('UploadsManagerDialog', () => {
  it('renders rows, stats, and the missing badge', async () => {
    renderDialog()
    await waitFor(() => expect(screen.getByText('a.txt')).toBeTruthy())
    expect(screen.getByText(/2 files/)).toBeTruthy()
    expect(screen.getByText(/missing/i, { selector: '.uploads-missing-badge' })).toBeTruthy()
  })

  it('filter narrows rows by name / cwd / session title', async () => {
    renderDialog()
    await waitFor(() => expect(screen.getByText('a.txt')).toBeTruthy())
    fireEvent.change(screen.getByPlaceholderText(/filter/i), { target: { value: 'Beta' } })
    expect(screen.queryByText('a.txt')).toBeNull()
    expect(screen.getByText('b.txt')).toBeTruthy()
  })

  it('empty state when there are no uploads', async () => {
    mockGet.mockResolvedValue({ uploads: [] })
    renderDialog()
    await waitFor(() => expect(screen.getByText(/no files uploaded yet/i)).toBeTruthy())
  })

  it('error state with retry', async () => {
    mockGet.mockRejectedValueOnce(new Error('boom'))
    renderDialog()
    await waitFor(() => expect(screen.getByText(/boom/)).toBeTruthy())
    mockGet.mockResolvedValue({ uploads: ROWS })
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    await waitFor(() => expect(screen.getByText('a.txt')).toBeTruthy())
  })

  it('copy path writes the absolute path to the clipboard', async () => {
    renderDialog()
    await waitFor(() => expect(screen.getByText('a.txt')).toBeTruthy())
    fireEvent.click(screen.getAllByRole('button', { name: /copy path/i })[0])
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/p/claude-web-uploads/1-a.txt'),
    )
    expect(mockToast.success).toHaveBeenCalled()
  })

  it('delete flow: row Delete opens ConfirmDialog, confirming deletes + refetches', async () => {
    renderDialog()
    await waitFor(() => expect(screen.getByText('a.txt')).toBeTruthy())

    // Row buttons say "Delete file"; the ConfirmDialog's confirm button is the
    // only accessible name exactly "Delete" once the dialog is open.
    fireEvent.click(screen.getAllByRole('button', { name: /^delete file$/i })[0])
    // ConfirmDialog mounted with the file path in the message.
    expect(screen.getByText('/p/claude-web-uploads/1-a.txt')).toBeTruthy()
    expect(screen.queryByText('b.txt')).toBeTruthy() // list still behind the confirm

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('/uploads/a'))
    expect(mockGet).toHaveBeenCalledTimes(2) // initial + refresh
  })

  it('clean missing entries: button only when missing rows exist; batch deletes each', async () => {
    renderDialog()
    await waitFor(() => expect(screen.getByText(/clean missing entries/i)).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /clean missing entries/i }))
    fireEvent.click(screen.getByRole('button', { name: /clean 1 entry/i }))
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('/uploads/b'))
  })

  it('view opens an upload tab in the focused panel strip; missing rows stay disabled', async () => {
    renderDialog()
    await waitFor(() => expect(screen.getByText('a.txt')).toBeTruthy())

    const viewButtons = screen.getAllByRole('button', { name: /view file/i })
    expect(viewButtons).toHaveLength(2)
    expect((viewButtons[1] as HTMLButtonElement).disabled).toBe(true) // b.txt missing

    fireEvent.click(viewButtons[0])
    // The eye routes through openResource: the tab lands in session s1's
    // persisted layout (kind + exact address), no dialog-scoped preview modal.
    await waitFor(() => {
      const state = JSON.parse(window.localStorage.getItem('crw.resource-pane.v1.s1') ?? 'null')
      expect(state?.tabs).toEqual([
        {
          id: expect.any(String),
          kind: 'upload',
          address: uploadResource({ id: 'a', name: 'a.txt', size: 1024 }),
        },
      ])
    })
    expect(screen.queryByRole('dialog', { name: /file preview/i })).toBeNull()
  })

  it('re-clicking the eye focuses the existing tab instead of opening a second', async () => {
    renderDialog()
    await waitFor(() => expect(screen.getByText('a.txt')).toBeTruthy())
    fireEvent.click(screen.getAllByRole('button', { name: /view file/i })[0])
    await waitFor(() =>
      expect(JSON.parse(window.localStorage.getItem('crw.resource-pane.v1.s1')!).tabs).toHaveLength(1),
    )
    fireEvent.click(screen.getAllByRole('button', { name: /view file/i })[0])
    expect(JSON.parse(window.localStorage.getItem('crw.resource-pane.v1.s1')!).tabs).toHaveLength(1)
  })

  it('eyes are disabled with no open panel to host the resource strip', async () => {
    renderDialog({ resourceSessionId: null })
    await waitFor(() => expect(screen.getByText('a.txt')).toBeTruthy())
    const viewButtons = screen.getAllByRole('button', { name: /view file/i })
    expect(viewButtons.every((b) => (b as HTMLButtonElement).disabled)).toBe(true)
  })
})

describe('UploadsManagerDialog height animation', () => {
  beforeEach(() => {
    measureMock.mockReset()
    mockGet.mockResolvedValue({ uploads: ROWS })
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
    stubResizeObserver()
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(0)
  })
  afterEach(() => {
    clearResizeObserverStub()
    vi.restoreAllMocks()
  })

  const body = () => document.querySelector<HTMLElement>('.uploads-body')!
  const content = () => document.querySelector<HTMLElement>('.uploads-body-content')!

  it('tweens the body height on a content-driven resize', async () => {
    let height = 200
    measureMock.mockImplementation(() => height)
    renderDialog()
    await waitFor(() => expect(screen.getByText('a.txt')).toBeTruthy())
    height = 400
    fireResize(content())
    expect(body().classList.contains('auto-height-animating')).toBe(true)
    expect(body().style.height).toBe('200px')
  })

  it('releases the pin when the tween finishes', async () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 0 })
    let height = 200
    measureMock.mockImplementation(() => height)
    renderDialog()
    await waitFor(() => expect(screen.getByText('a.txt')).toBeTruthy())
    height = 400
    fireResize(content())
    expect(body().style.height).toBe('400px')
    act(() => {
      const evt = new Event('transitionend', { bubbles: true })
      Object.defineProperty(evt, 'propertyName', { value: 'height' })
      body().dispatchEvent(evt)
    })
    expect(body().classList.contains('auto-height-animating')).toBe(false)
    expect(body().style.height).toBe('')
  })

  it('refuses to measure while a nested confirm dialog is open (card-child chrome)', async () => {
    measureMock.mockImplementation(() => 300)
    renderDialog()
    await waitFor(() => expect(screen.getByText('a.txt')).toBeTruthy())
    fireEvent.click(screen.getAllByRole('button', { name: /^delete file$/i })[0])
    // The ConfirmDialog backdrop is a child of the card; measuring now would
    // collapse the ceiling. The gate returns null instead — no tween, no pin.
    measureMock.mockClear()
    fireResize(content())
    expect(measureMock).not.toHaveBeenCalled()
    expect(body().classList.contains('auto-height-animating')).toBe(false)
  })
})

describe('UploadsManagerDialog overlay scrollbar', () => {
  it('attaches the project overlay scrollbar to the uploads-body scroller', () => {
    renderDialog()
    const body = document.querySelector<HTMLElement>('.uploads-body')!
    expect(body.hasAttribute('data-os-native-hidden')).toBe(true)
    expect(document.querySelector('.uploads-manager-card .os-track')).toBeTruthy()
  })
})
