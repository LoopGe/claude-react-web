// @vitest-environment happy-dom
// Height-animation wiring for the permission dialog body. The cap math is
// unit-tested in capped-height-measure.test.ts; here the measure is mocked to
// controlled heights so the wiring (observer + key paths, pin release) is what's
// under test. Behavioral coverage of the approval flow lives in
// PermissionDialog.test.tsx.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { clearResizeObserverStub, fireResize, stubResizeObserver } from '../test/resize-observer-stub'
import { PermissionDialog } from './PermissionDialog'
import type { PermissionRequest } from '../types'

const { measureMock } = vi.hoisted(() => ({ measureMock: vi.fn() }))
vi.mock('../utils/capped-height-measure', () => ({ measureCappedContentHeight: measureMock }))

function toolRequest(): Extract<PermissionRequest, { kind: 'permission' }> {
  return {
    kind: 'permission',
    id: 'p1',
    toolName: 'Bash',
    input: { command: 'ls' },
    toolUseID: 'tu1',
    createdAt: 0,
  }
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
  render(<PermissionDialog request={toolRequest()} onDecide={vi.fn()} />)
}

describe('PermissionDialog height animation', () => {
  it('tweens the section height on a content-driven resize', () => {
    let height = 100
    measureMock.mockImplementation(() => height)
    setup()
    const section = document.querySelector<HTMLElement>('.modal-section')!
    const content = document.querySelector<HTMLElement>('.modal-section-content')!
    height = 300
    fireResize(content)
    expect(section.classList.contains('auto-height-animating')).toBe(true)
    expect(section.style.height).toBe('100px')
  })

  it('releases the pin when the tween finishes', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 0 })
    let height = 100
    measureMock.mockImplementation(() => height)
    setup()
    const section = document.querySelector<HTMLElement>('.modal-section')!
    const content = document.querySelector<HTMLElement>('.modal-section-content')!
    height = 300
    fireResize(content)
    expect(section.style.height).toBe('300px')
    act(() => {
      const evt = new Event('transitionend', { bubbles: true })
      Object.defineProperty(evt, 'propertyName', { value: 'height' })
      section.dispatchEvent(evt)
    })
    expect(section.classList.contains('auto-height-animating')).toBe(false)
    expect(section.style.height).toBe('')
  })
})
