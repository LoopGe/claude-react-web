// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, waitFor, act } from '@testing-library/react'
import { clearResizeObserverStub, fireResize, stubResizeObserver } from '../test/resize-observer-stub'
import { McpExportDialog } from './McpExportDialog'
import type { McpServerConfigMeta } from '../types'

const { downloadJson } = vi.hoisted(() => ({ downloadJson: vi.fn() }))

vi.mock('../hooks/useApi', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}))
vi.mock('../utils/downloadJson', () => ({ downloadJson }))

// The height measure is mocked file-wide. With no implementation it returns
// undefined, which useAutoHeightTransition treats as "no measurement" — so the
// behavioural tests below never tween and need no DOM-metric stubs. The height
// describe gives it controlled heights.
const { measureMock } = vi.hoisted(() => ({ measureMock: vi.fn() }))
vi.mock('../utils/capped-height-measure', () => ({ measureCappedContentHeight: measureMock }))

import { api } from '../hooks/useApi'

afterEach(() => { cleanup(); vi.clearAllMocks() })

const servers: McpServerConfigMeta[] = [
  { name: 'git', type: 'stdio', command: 'npx', createdAt: 1, updatedAt: 1 },
  { name: 'fs', type: 'stdio', command: 'node', createdAt: 1, updatedAt: 1 },
]

describe('McpExportDialog', () => {
  it('requests all servers by default and triggers a download', async () => {
    const mockGet = vi.mocked(api.get).mockResolvedValue({ format: 'claude-react-web-mcp', version: 1, exportedAt: 1, secretScope: 'masked', servers: [] })
    render(<McpExportDialog open servers={servers} onClose={vi.fn()} />)

    fireEvent.click(document.body.querySelector('.btn-primary')!)

    expect(mockGet).toHaveBeenCalledWith('/mcp-config/export')
    await waitFor(() =>
      expect(downloadJson).toHaveBeenCalledWith('claude-react-web-mcp-servers.json', expect.objectContaining({ format: 'claude-react-web-mcp' })),
    )
  })

  it('filters by the selected subset and appends includeSecrets when checked', async () => {
    const mockGet = vi.mocked(api.get).mockResolvedValue({ format: 'claude-react-web-mcp', version: 1, exportedAt: 1, secretScope: 'full', servers: [] })
    render(<McpExportDialog open servers={servers} onClose={vi.fn()} />)

    const checkboxes = Array.from(document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
    // first server checkbox, then fs checkbox, then includeSecrets checkbox
    const fsCheckbox = checkboxes[1]
    fireEvent.click(fsCheckbox) // uncheck fs
    const secretsCheckbox = checkboxes[2]
    fireEvent.click(secretsCheckbox) // check include secrets

    fireEvent.click(document.body.querySelector('.btn-primary')!)

    expect(mockGet).toHaveBeenCalledWith('/mcp-config/export?includeSecrets=1&names=git')
  })
})

// The body's height tweens as the secrets note toggles, the error row mounts and
// the server list changes via useAutoHeightTransition. The measure math is
// unit-tested in capped-height-measure.test.ts; here it is mocked to controlled
// heights so the WIRING (observer + key paths, pin release) is what's under test.
// rAF is stubbed inert so the tween holds its start pin and the assertion does not
// race the frame.
describe('McpExportDialog height animation', () => {
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
    const content = document.body.querySelector<HTMLElement>('.mcp-export-content')!
    return { content, body: content.parentElement as HTMLElement }
  }

  it('tweens the body height on a content-driven resize', () => {
    let height = 100
    measureMock.mockImplementation(() => height)
    render(<McpExportDialog open servers={servers} onClose={vi.fn()} />)
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
    render(<McpExportDialog open servers={servers} onClose={vi.fn()} />)
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

  it('tweens the body height when the secrets note toggles (key path)', () => {
    let height = 100
    measureMock.mockImplementation(() => height)
    render(<McpExportDialog open servers={servers} onClose={vi.fn()} />)
    const { body } = bodyAndContent()
    // The first measurement only establishes the baseline — no tween yet.
    expect(body.classList.contains('auto-height-animating')).toBe(false)
    height = 300
    // includeSecrets is the third checkbox (two server rows precede it); checking
    // it unmounts the "secrets will be blanked" note.
    const checkboxes = Array.from(document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
    fireEvent.click(checkboxes[2])
    expect(body.classList.contains('auto-height-animating')).toBe(true)
    expect(body.style.height).toBe('100px')
  })
})
