import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { clearResizeObserverStub, fireResize, stubResizeObserver } from '../../test/resize-observer-stub'
import { RunAsAgentControl } from './RunAsAgentControl'

const { post } = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock('../../hooks/useApi', () => ({ api: { post } }))

// The height measure is mocked file-wide. With no implementation it returns
// undefined, which useAutoHeightTransition treats as "no measurement" — so the
// behavioural tests below never tween and need no DOM-metric stubs. The height
// describe gives it controlled heights.
const { measureMock } = vi.hoisted(() => ({ measureMock: vi.fn() }))
vi.mock('../../utils/capped-height-measure', () => ({ measureCappedContentHeight: measureMock }))
vi.mock('../../hooks/useAgentDefinitions', () => ({
  useAgentDefinitions: () => ({ agents: [
    { name: 'reviewer', enabled: true, description: 'Reviews', createdAt: 1, updatedAt: 1, prompt: 'p' },
    { name: 'off', enabled: false, description: 'Off', createdAt: 1, updatedAt: 1, prompt: 'p' },
  ] }),
}))

describe('RunAsAgentControl', () => {
  afterEach(() => { cleanup(); post.mockReset() })
  it('lists only enabled custom agents', () => {
    render(<RunAsAgentControl sessionId="s1" onClose={() => {}} />)
    expect(screen.getByText('reviewer')).toBeTruthy()
    expect(screen.queryByText('off')).toBeNull()
  })
  it('disables confirm when the task is empty', () => {
    render(<RunAsAgentControl sessionId="s1" onClose={() => {}} />)
    expect((screen.getByRole('button', { name: /run/i }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('enqueues the crafted delegation message on confirm', () => {
    render(<RunAsAgentControl sessionId="s1" onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText(/task/i), { target: { value: 'find the bug' } })
    fireEvent.click(screen.getByRole('button', { name: /run/i }))
    expect(post).toHaveBeenCalledWith(
      '/sessions/s1/messages',
      expect.objectContaining({ text: expect.stringMatching(/Agent tool[\s\S]*reviewer[\s\S]*find the bug/) }),
    )
  })
})

// The body's height tweens when the stale/error row mounts or the enabled-agent
// list changes via useAutoHeightTransition. The measure math is unit-tested in
// capped-height-measure.test.ts; here it is mocked to controlled heights so the
// WIRING (observer + key paths, pin release) is what's under test. rAF is stubbed
// inert so the tween holds its start pin and the assertion does not race the frame.
describe('RunAsAgentControl height animation', () => {
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
    const body = document.querySelector<HTMLElement>('.modal-section')!
    const content = document.querySelector<HTMLElement>('.modal-section-content')!
    return { body, content }
  }

  it('tweens the body height on a content-driven resize', () => {
    let height = 100
    measureMock.mockImplementation(() => height)
    render(<RunAsAgentControl sessionId="s1" onClose={() => {}} />)
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
    render(<RunAsAgentControl sessionId="s1" onClose={() => {}} />)
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

  it('tweens the body height when the error row mounts after a failed run (key path)', async () => {
    post.mockRejectedValueOnce(new Error('boom'))
    let height = 100
    measureMock.mockImplementation(() => height)
    render(<RunAsAgentControl sessionId="s1" onClose={() => {}} />)
    const { body } = bodyAndContent()
    // The first measurement only establishes the baseline — no tween yet.
    expect(body.classList.contains('auto-height-animating')).toBe(false)
    height = 300
    fireEvent.change(screen.getByLabelText(/task/i), { target: { value: 'find the bug' } })
    fireEvent.click(screen.getByRole('button', { name: /run/i }))
    await waitFor(() => expect(document.querySelector('.modal-error')).toBeTruthy())
    expect(body.classList.contains('auto-height-animating')).toBe(true)
    expect(body.style.height).toBe('100px')
  })
})