// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, waitFor, act } from '@testing-library/react'
import { clearResizeObserverStub, fireResize, stubResizeObserver } from '../test/resize-observer-stub'
import { McpImportDialog } from './McpImportDialog'

vi.mock('../hooks/useApi', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}))
import { api } from '../hooks/useApi'

// The height measure is mocked file-wide. With no implementation it returns
// undefined, which useAutoHeightTransition treats as "no measurement" — so the
// behavioural tests below never tween and need no DOM-metric stubs. The height
// describe gives it controlled heights.
const { measureMock } = vi.hoisted(() => ({ measureMock: vi.fn() }))
vi.mock('../utils/capped-height-measure', () => ({ measureCappedContentHeight: measureMock }))

afterEach(() => { cleanup(); vi.clearAllMocks() })

function makeFile(content: string): File {
  return new File([content], 'servers.json', { type: 'application/json' })
}

describe('McpImportDialog', () => {
  it('previews new/conflict/invalid sections and imports the checked selection', async () => {
    const preview = {
      servers: [
        { name: 'fresh', type: 'stdio', command: 'npx', errors: [], exists: false, envKeys: ['API_KEY'] },
        { name: 'exists', type: 'stdio', command: 'node', errors: [], exists: true },
        { name: 'bad', type: 'stdio', errors: ['command is required for stdio type'], exists: false },
      ],
    }
    const importResult = { imported: ['fresh'], updated: [], skipped: ['exists'], failed: [] }
    vi.mocked(api.post)
      .mockResolvedValueOnce(preview)
      .mockResolvedValueOnce(importResult)

    const onImported = vi.fn()
    render(<McpImportDialog open file={makeFile(JSON.stringify({ servers: preview.servers }))} onClose={vi.fn()} onImported={onImported} />)

    // preview renders all three names
    await waitFor(() => expect(document.body.textContent).toContain('fresh'))
    expect(document.body.textContent).toContain('exists')
    expect(document.body.textContent).toContain('bad')

    // secret-keys hint rendered for the 'fresh' row (envKeys: ['API_KEY'])
    expect(document.body.textContent).toContain('needs: API_KEY')

    // fresh (new) + exists (conflict) + "overwrite all existing" — the
    // invalid row renders with no checkbox
    const checkboxes = Array.from(document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
    expect(checkboxes).toHaveLength(3)
    expect(checkboxes[0].checked).toBe(true) // fresh (new) default checked
    expect(checkboxes[1].checked).toBe(false) // exists (conflict) default unchecked
    expect(checkboxes[2].checked).toBe(false) // "overwrite all existing" toggle

    // check the conflict row to overwrite it, then import
    fireEvent.click(checkboxes[1])
    fireEvent.click(document.body.querySelector('.btn-primary')!)

    await waitFor(() =>
      expect(api.post).toHaveBeenLastCalledWith('/mcp-config/import', {
        file: expect.stringContaining('fresh'),
        names: ['fresh', 'exists'],
        overwrite: true,
      }),
    )
    // summary shown
    await waitFor(() => expect(document.body.textContent).toContain('Imported: 1'))
    expect(onImported).toHaveBeenCalled()
  })

  it('shows inline error when preview request fails and stays open', async () => {
    vi.mocked(api.post).mockRejectedValueOnce(new Error('Invalid JSON'))

    const onImported = vi.fn()
    const onClose = vi.fn()
    render(<McpImportDialog open file={makeFile('not json')} onClose={onClose} onImported={onImported} />)

    // error message rendered inline
    await waitFor(() => expect(document.body.textContent).toContain('Invalid JSON'))

    // dialog stays open — no summary, no onImported call
    expect(document.body.textContent).not.toContain('Imported:')
    expect(onImported).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })
})

// The body's height tweens between phases (loading → preview → importing →
// summary) via useAutoHeightTransition. The measure math is unit-tested in
// capped-height-measure.test.ts; here it is mocked to controlled heights so the
// WIRING (observer + key paths, pin release) is what's under test. rAF is stubbed
// inert so the tween holds its start pin and the assertion does not race the frame.
describe('McpImportDialog height animation', () => {
  beforeEach(() => {
    measureMock.mockReset()
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
    stubResizeObserver()
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(0)
  })

  afterEach(() => {
    clearResizeObserverStub()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function bodyAndContent() {
    const content = document.body.querySelector<HTMLElement>('.mcp-import-content')!
    return { content, body: content.parentElement as HTMLElement }
  }

  it('tweens the body height on a content-driven resize', () => {
    let height = 100
    measureMock.mockImplementation(() => height)
    render(<McpImportDialog open file={null} onClose={vi.fn()} onImported={vi.fn()} />)
    const { body, content } = bodyAndContent()
    height = 300
    fireResize(content)
    expect(body.classList.contains('auto-height-animating')).toBe(true)
    expect(body.style.height).toBe('100px')
  })

  it('releases the pin when the tween finishes', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 0 })
    let height = 100
    measureMock.mockImplementation(() => height)
    render(<McpImportDialog open file={null} onClose={vi.fn()} onImported={vi.fn()} />)
    const { body, content } = bodyAndContent()
    height = 300
    fireResize(content)
    expect(body.style.height).toBe('300px')
    act(() => {
      const evt = new Event('transitionend', { bubbles: true })
      Object.defineProperty(evt, 'propertyName', { value: 'height' })
      body.dispatchEvent(evt)
    })
    expect(body.classList.contains('auto-height-animating')).toBe(false)
    expect(body.style.height).toBe('')
  })

  it('tweens the body height on the loading → preview phase change (key path)', async () => {
    vi.mocked(api.post).mockResolvedValueOnce({
      servers: [{ name: 'fresh', type: 'stdio', command: 'npx', errors: [], exists: false }],
    })
    let height = 40
    measureMock.mockImplementation(() => height)
    render(<McpImportDialog open file={makeFile('{"servers":[]}')} onClose={vi.fn()} onImported={vi.fn()} />)
    const { body } = bodyAndContent()
    // The loading measurement only establishes the baseline — no tween yet.
    expect(body.classList.contains('auto-height-animating')).toBe(false)
    height = 300
    await waitFor(() => expect(document.body.textContent).toContain('fresh'))
    expect(body.classList.contains('auto-height-animating')).toBe(true)
    expect(body.style.height).toBe('40px')
  })
})
