// @vitest-environment happy-dom
// Height-animation wiring for the What's New dialog body. The cap math is
// unit-tested in capped-height-measure.test.ts; here the measure is mocked to
// controlled heights so the wiring (observer + key paths, pin release) is what's
// under test. The data hooks and Markdown are stubbed so only the body shell renders.
// Behavioral coverage of the update flow lives in UpdateDialog.test.tsx.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { clearResizeObserverStub, fireResize, stubResizeObserver } from '../test/resize-observer-stub'
import { UpdateDialog } from './UpdateDialog'
import type { UpdateInfo } from '../../shared/update-info'

const { measureMock } = vi.hoisted(() => ({ measureMock: vi.fn() }))
vi.mock('../utils/capped-height-measure', () => ({ measureCappedContentHeight: measureMock }))
vi.mock('../hooks/useReleaseNotes', () => ({
  useReleaseNotes: () => ({
    releases: [{ version: '1.0.0', name: 'v1.0.0', body: 'notes', publishedAt: '2026-01-01T00:00:00Z', url: null }],
    loading: false,
    error: null,
  }),
}))
vi.mock('../hooks/useToast', () => ({ useToast: () => ({ error: vi.fn() }) }))
vi.mock('../hooks/useCopy', () => ({ useCopy: () => ({ copied: false, copy: vi.fn() }) }))
vi.mock('./Markdown', () => ({ Markdown: () => null }))

const info: UpdateInfo = {
  current: '1.0.0',
  packageName: 'claude-react-web',
  installMethod: 'global',
  latest: '1.0.0',
  hasUpdate: false,
  source: 'npm',
}

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

function setup() {
  render(
    <UpdateDialog
      open
      mode="current"
      info={info}
      updating={false}
      onUpdate={vi.fn()}
      onClose={vi.fn()}
    />,
  )
}

describe('UpdateDialog height animation', () => {
  it('tweens the body height on a content-driven resize', () => {
    let height = 100
    measureMock.mockImplementation(() => height)
    setup()
    const body = document.querySelector<HTMLElement>('.update-dialog-body')!
    const content = document.querySelector<HTMLElement>('.update-dialog-body-content')!
    height = 300
    fireResize(content)
    expect(body.classList.contains('auto-height-animating')).toBe(true)
    expect(body.style.height).toBe('100px')
  })

  it('releases the pin when the tween finishes', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 0 })
    let height = 100
    measureMock.mockImplementation(() => height)
    setup()
    const body = document.querySelector<HTMLElement>('.update-dialog-body')!
    const content = document.querySelector<HTMLElement>('.update-dialog-body-content')!
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
})