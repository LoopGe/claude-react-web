// @vitest-environment happy-dom
// Height-animation wiring for the structured-output dialog's two scrollers (the
// form body and the result section). The cap math is unit-tested in
// capped-height-measure.test.ts; here the measure is mocked to controlled heights
// so the wiring (observer + key paths, pin release) is what's under test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { clearResizeObserverStub, fireResize, stubResizeObserver } from '../test/resize-observer-stub'
import { StructuredPanel } from './StructuredPanel'
import { fetchConfig, resetModelOptionsStoreForTest } from '../state/modelOptionsStore'
import { api } from '../hooks/useApi'

vi.mock('../hooks/useApi', () => ({
  api: { get: vi.fn(), post: vi.fn() },
}))

const { measureMock, runState, runMock, cancelMock, resetMock } = vi.hoisted(() => ({
  measureMock: vi.fn(),
  runState: { running: false, result: null as unknown, error: null as string | null },
  runMock: vi.fn(),
  cancelMock: vi.fn(),
  resetMock: vi.fn(),
}))
vi.mock('../utils/capped-height-measure', () => ({ measureCappedContentHeight: measureMock }))
vi.mock('../hooks/useStructuredRun', () => ({
  useStructuredRun: () => ({ ...runState, run: runMock, cancel: cancelMock, reset: resetMock }),
}))

beforeEach(async () => {
  measureMock.mockReset()
  runMock.mockReset()
  cancelMock.mockReset()
  resetMock.mockReset()
  runState.running = false
  runState.result = null
  runState.error = null
  resetModelOptionsStoreForTest()
  // Warm the shared /config cache with a claude default so the height/scrollbar
  // tests render with the budget field present and no cold-fetch state update
  // lands mid-test (App fetches /config on mount before any dialog opens).
  ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) =>
    Promise.resolve(url === '/config' ? { defaults: {} } : {}))
  await fetchConfig()
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  stubResizeObserver()
  vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(0)
})

afterEach(() => {
  clearResizeObserverStub()
  resetModelOptionsStoreForTest()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function setup() {
  render(<StructuredPanel open onClose={vi.fn()} />)
}

describe('StructuredPanel height animation', () => {
  it('tweens the form body height on a content-driven resize', () => {
    let height = 100
    measureMock.mockImplementation(() => height)
    setup()
    const body = document.querySelector<HTMLElement>('.structured-body')!
    const content = document.querySelector<HTMLElement>('.structured-body-content')!
    height = 300
    fireResize(content)
    expect(body.classList.contains('auto-height-animating')).toBe(true)
    expect(body.style.height).toBe('100px')
  })

  it('releases the body pin when the tween finishes', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 0 })
    let height = 100
    measureMock.mockImplementation(() => height)
    setup()
    const body = document.querySelector<HTMLElement>('.structured-body')!
    const content = document.querySelector<HTMLElement>('.structured-body-content')!
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

  it('tweens the result section height on a content-driven resize', () => {
    runState.running = true
    let height = 40
    measureMock.mockImplementation(() => height)
    setup()
    const result = document.querySelector<HTMLElement>('.structured-result')!
    const content = document.querySelector<HTMLElement>('.structured-result-content')!
    height = 260
    fireResize(content)
    expect(result.classList.contains('auto-height-animating')).toBe(true)
    expect(result.style.height).toBe('40px')
  })
})

describe('StructuredPanel overlay scrollbar', () => {
  it('attaches the project overlay scrollbar to the form body scroller', () => {
    setup()
    const body = document.querySelector<HTMLElement>('.structured-body')!
    expect(body.hasAttribute('data-os-native-hidden')).toBe(true)
    expect(document.querySelector('.structured-panel .os-track')).toBeTruthy()
  })

  it('attaches the project overlay scrollbar to the result section scroller', () => {
    runState.running = true
    setup()
    const result = document.querySelector<HTMLElement>('.structured-result')!
    expect(result.hasAttribute('data-os-native-hidden')).toBe(true)
  })

  it('attaches both-axis overlay scrollbars to the result JSON pre', () => {
    runState.result = { ok: true, structuredOutput: { answer: 42 } }
    setup()
    const pre = document.querySelector<HTMLElement>('.structured-json')!
    expect(pre.hasAttribute('data-os-native-hidden')).toBe(true)
    // orientation 'both' → a vertical AND a horizontal track beside the pre
    // (its parent is the content wrapper, which holds no other scroller).
    expect(pre.parentElement!.querySelectorAll('.os-track').length).toBe(2)
  })
})

describe('StructuredPanel budget field vs effective default', () => {
  // native has no cost model — runStructured 501s on maxBudgetUsd — so the panel
  // hides the budget field and omits it from the request when the server's
  // effective default (GET /config defaultProvider) is native. claude is
  // unchanged. The provider is read from the shared config store, not a picker
  // (the panel is session-agnostic).

  /** Re-warm the shared /config cache with the given effective default so the
   *  panel seeds its provider synchronously (the production-faithful fixture). */
  async function warmConfig(defaultProvider?: string) {
    resetModelOptionsStoreForTest()
    ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) =>
      Promise.resolve(url === '/config'
        ? { defaults: {}, ...(defaultProvider ? { defaultProvider } : {}) }
        : {}))
    await fetchConfig()
  }

  const advancedToggle = () => screen.getByRole('button', { name: /advanced options/ })
  const promptBox = () => screen.getByPlaceholderText(/List all API endpoints/)
  const runButton = () => screen.getByRole('button', { name: 'Run' })
  const budgetInput = () => screen.queryByLabelText('Budget (USD)')

  it('native effective default: budget field hidden and omitted from request', async () => {
    await warmConfig('native')
    setup()
    fireEvent.click(advancedToggle())
    expect(budgetInput()).toBeNull()
    fireEvent.change(promptBox(), { target: { value: 'list endpoints' } })
    fireEvent.click(runButton())
    await waitFor(() => expect(runMock).toHaveBeenCalled())
    expect(runMock.mock.calls[0][0]).not.toHaveProperty('maxBudgetUsd')
  })

  it('claude effective default: budget field present and sent', async () => {
    await warmConfig('claude')
    setup()
    fireEvent.click(advancedToggle())
    const budget = budgetInput()
    expect(budget).not.toBeNull()
    fireEvent.change(promptBox(), { target: { value: 'list endpoints' } })
    fireEvent.change(budget!, { target: { value: '2.5' } })
    fireEvent.click(runButton())
    await waitFor(() => expect(runMock).toHaveBeenCalled())
    expect(runMock.mock.calls[0][0]).toHaveProperty('maxBudgetUsd', 2.5)
  })

  it('native effective default: a budget typed before the cold config resolves is omitted', async () => {
    // Cold cache: /config pending. The panel seeds the claude placeholder, so the
    // budget field is editable and a value lands in state. When the config
    // resolves native the field hides AND submit must still omit the typed value
    // (the request guard, not just the hiding, is what prevents the 501).
    resetModelOptionsStoreForTest()
    let release!: (body: unknown) => void
    ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/config') return new Promise((resolve) => { release = resolve })
      return Promise.resolve({})
    })
    render(<StructuredPanel open onClose={vi.fn()} />)
    fireEvent.click(advancedToggle())
    fireEvent.change(screen.getByLabelText('Budget (USD)'), { target: { value: '5' } })
    fireEvent.change(promptBox(), { target: { value: 'list endpoints' } })
    await act(async () => { release({ defaults: {}, defaultProvider: 'native' }) })
    await waitFor(() => expect(budgetInput()).toBeNull())
    fireEvent.click(runButton())
    await waitFor(() => expect(runMock).toHaveBeenCalled())
    expect(runMock.mock.calls[0][0]).not.toHaveProperty('maxBudgetUsd')
  })
})