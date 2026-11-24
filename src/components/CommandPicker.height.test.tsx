// @vitest-environment happy-dom
// Height-animation wiring for the slash-command picker list. The cap math is
// unit-tested in capped-height-measure.test.ts; here the measure is mocked to
// controlled heights so the wiring (observer + key paths, pin release) is what's
// under test. Kept in a sibling file so the behavioral CommandPicker.test.tsx
// runs unmocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { clearResizeObserverStub, fireResize, stubResizeObserver } from '../test/resize-observer-stub'
import { CommandPicker } from './CommandPicker'
import type { SlashCommand } from '../types'

const { measureMock } = vi.hoisted(() => ({ measureMock: vi.fn() }))
vi.mock('../utils/capped-height-measure', () => ({ measureCappedContentHeight: measureMock }))

const commands: SlashCommand[] = [
  { name: 'clear', description: 'Clear chat', argumentHint: '' },
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

function setup(query = '') {
  return render(
    <CommandPicker
      commands={commands}
      query={query}
      selectedIndex={0}
      anchorRef={{ current: null }}
      onSelect={vi.fn()}
      onClose={vi.fn()}
    />,
  )
}

describe('CommandPicker height animation', () => {
  it('tweens the list height on a content-driven resize', () => {
    let height = 100
    measureMock.mockImplementation(() => height)
    setup()
    const list = document.querySelector<HTMLElement>('.cmd-picker-list')!
    const content = document.querySelector<HTMLElement>('.cmd-picker-list-content')!
    height = 300
    fireResize(content)
    expect(list.classList.contains('auto-height-animating')).toBe(true)
    expect(list.style.height).toBe('100px')
  })

  it('tweens via the key path when the query filters rows (no resize fired)', () => {
    let height = 100
    measureMock.mockImplementation(() => height)
    const { rerender } = setup()
    const list = document.querySelector<HTMLElement>('.cmd-picker-list')!
    height = 300
    // Filtering narrows the row set, changing the hook key — the layout-effect
    // path must tween even though no ResizeObserver delivery happens.
    rerender(
      <CommandPicker
        commands={commands}
        query="clear"
        selectedIndex={0}
        anchorRef={{ current: null }}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(list.classList.contains('auto-height-animating')).toBe(true)
    expect(list.style.height).toBe('100px')
  })

  it('releases the pin when the tween finishes', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 0 })
    let height = 100
    measureMock.mockImplementation(() => height)
    setup()
    const list = document.querySelector<HTMLElement>('.cmd-picker-list')!
    const content = document.querySelector<HTMLElement>('.cmd-picker-list-content')!
    height = 300
    fireResize(content)
    expect(list.style.height).toBe('300px')
    act(() => {
      const evt = new Event('transitionend', { bubbles: true })
      Object.defineProperty(evt, 'propertyName', { value: 'height' })
      list.dispatchEvent(evt)
    })
    expect(list.classList.contains('auto-height-animating')).toBe(false)
    expect(list.style.height).toBe('')
  })
})
