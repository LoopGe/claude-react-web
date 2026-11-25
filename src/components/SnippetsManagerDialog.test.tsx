// @vitest-environment happy-dom
// Height-animation wiring for the snippets list. The cap math is unit-tested in
// capped-height-measure.test.ts; here the measure is mocked to controlled heights
// so the wiring (observer + key paths, pin release) is what's under test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { clearResizeObserverStub, fireResize, stubResizeObserver } from '../test/resize-observer-stub'
import { SnippetsManagerDialog } from './SnippetsManagerDialog'
import type { ComposerSnippetsApi } from '../hooks/useComposerSnippets'

const { measureMock } = vi.hoisted(() => ({ measureMock: vi.fn() }))
vi.mock('../utils/capped-height-measure', () => ({ measureCappedContentHeight: measureMock }))

function fakeApi(snippets: ComposerSnippetsApi['snippets']): ComposerSnippetsApi {
  return {
    snippets,
    loading: false,
    error: null,
    add: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    move: vi.fn(),
    refresh: vi.fn().mockResolvedValue(undefined),
  }
}

const SNIPPETS = [{ id: '1', label: 'Alpha', content: 'aaa' }]

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

const list = () => document.querySelector<HTMLElement>('.snippets-manager-list')!
const content = () => document.querySelector<HTMLElement>('.snippets-manager-list-content')!

describe('SnippetsManagerDialog height animation', () => {
  it('tweens the list height on a content-driven resize', () => {
    let height = 100
    measureMock.mockImplementation(() => height)
    render(<SnippetsManagerDialog api={fakeApi(SNIPPETS)} onClose={vi.fn()} />)
    height = 300
    fireResize(content())
    expect(list().classList.contains('auto-height-animating')).toBe(true)
    expect(list().style.height).toBe('100px')
  })

  it('tweens when a row enters inline edit (key-driven)', () => {
    let height = 100
    measureMock.mockImplementation(() => height)
    render(<SnippetsManagerDialog api={fakeApi(SNIPPETS)} onClose={vi.fn()} />)
    height = 300
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(list().classList.contains('auto-height-animating')).toBe(true)
    expect(list().style.height).toBe('100px')
  })

  it('releases the pin when the tween finishes', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 0 })
    let height = 100
    measureMock.mockImplementation(() => height)
    render(<SnippetsManagerDialog api={fakeApi(SNIPPETS)} onClose={vi.fn()} />)
    height = 300
    fireResize(content())
    expect(list().style.height).toBe('300px')
    act(() => {
      const evt = new Event('transitionend', { bubbles: true })
      Object.defineProperty(evt, 'propertyName', { value: 'height' })
      list().dispatchEvent(evt)
    })
    expect(list().classList.contains('auto-height-animating')).toBe(false)
    expect(list().style.height).toBe('')
  })
})

describe('SnippetsManagerDialog overlay scrollbar', () => {
  it('attaches the project overlay scrollbar to the snippets list scroller', () => {
    render(<SnippetsManagerDialog api={fakeApi(SNIPPETS)} onClose={vi.fn()} />)
    expect(list().hasAttribute('data-os-native-hidden')).toBe(true)
    expect(document.querySelector('.perm-card .os-track')).toBeTruthy()
  })
})