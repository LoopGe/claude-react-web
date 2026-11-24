// @vitest-environment happy-dom
// Height-animation wiring for the question dialog body. The cap math is
// unit-tested in capped-height-measure.test.ts; here the measure is mocked to
// controlled heights so the wiring (observer + key paths, pin release) is what's
// under test. Behavioral coverage lives in QuestionDialog.test.tsx.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { clearResizeObserverStub, fireResize, stubResizeObserver } from '../test/resize-observer-stub'
import { QuestionDialog } from './QuestionDialog'
import type { PermissionRequest } from '../types'

const { measureMock } = vi.hoisted(() => ({ measureMock: vi.fn() }))
vi.mock('../utils/capped-height-measure', () => ({ measureCappedContentHeight: measureMock }))

function questionRequest(): Extract<PermissionRequest, { kind: 'question' }> {
  return {
    kind: 'question',
    id: 'q1',
    toolName: 'AskUserQuestion',
    questions: [{ question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] }],
    toolUseID: 'tu-q1',
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
  render(
    <QuestionDialog
      request={questionRequest()}
      onSubmit={vi.fn()}
      onClarify={vi.fn()}
      onSkipAll={vi.fn()}
      onMinimize={vi.fn()}
    />,
  )
}

describe('QuestionDialog height animation', () => {
  it('tweens the body height on a content-driven resize', () => {
    let height = 100
    measureMock.mockImplementation(() => height)
    setup()
    const body = document.querySelector<HTMLElement>('.question-body')!
    const content = document.querySelector<HTMLElement>('.question-body-content')!
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
    const body = document.querySelector<HTMLElement>('.question-body')!
    const content = document.querySelector<HTMLElement>('.question-body-content')!
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
