// @vitest-environment happy-dom
// Height-animation wiring for the help dialog body. The cap math is unit-tested
// in capped-height-measure.test.ts; here the measure is mocked to controlled
// heights so the wiring (observer + key paths, pin release) is what's under test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { clearResizeObserverStub, fireResize, stubResizeObserver } from '../test/resize-observer-stub'
import { ShortcutHelp } from './ShortcutHelp'
import type { Shortcut } from '../hooks/useKeyboardShortcuts'
import type { SlashCommand } from '../types'

const { measureMock } = vi.hoisted(() => ({ measureMock: vi.fn() }))
vi.mock('../utils/capped-height-measure', () => ({ measureCappedContentHeight: measureMock }))

const shortcuts: Shortcut[] = [
  { combo: 'mod+k', handler: vi.fn(), description: 'Open the command palette' },
  { combo: 'shift+?', handler: vi.fn(), description: 'Show keyboard shortcuts' },
]
const commands: SlashCommand[] = [
  { name: 'help', description: 'Show help', argumentHint: '' },
]

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
  render(<ShortcutHelp open onClose={vi.fn()} shortcuts={shortcuts} commands={commands} />)
}

function bodyAndContent() {
  const body = document.querySelector<HTMLElement>('.modal-section')!
  const content = document.querySelector<HTMLElement>('.modal-section-content')!
  return { body, content }
}

describe('ShortcutHelp height animation', () => {
  it('tweens the body height on a content-driven resize', () => {
    let height = 100
    measureMock.mockImplementation(() => height)
    setup()
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
    setup()
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

  it('tweens the body height on the commands → shortcuts tab swap (key path)', () => {
    let height = 100
    measureMock.mockImplementation(() => height)
    setup()
    const { body } = bodyAndContent()
    // The first measurement only establishes the baseline — no tween yet.
    expect(body.classList.contains('auto-height-animating')).toBe(false)
    height = 300
    fireEvent.click(screen.getByText('Keyboard shortcuts'))
    expect(body.classList.contains('auto-height-animating')).toBe(true)
    expect(body.style.height).toBe('100px')
  })
})