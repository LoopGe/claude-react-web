// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { syncEditorHeight } from './editor-height'

/**
 * The editor grows by writing an explicit px height. Animating that growth
 * needs the tween to start from a LENGTH — if the last write before the new
 * target is `auto`, the browser resolves `auto` against the post-change
 * content and the two endpoints coincide, so the transition exists but never
 * moves. These tests pin the WRITE SEQUENCE — the DOM test environment has no
 * layout engine, so pixels are not observable and `scrollHeight` is always 0 —
 * because that sequence is what decides whether the browser can tween at all.
 */
describe('syncEditorHeight', () => {
  afterEach(() => vi.restoreAllMocks())

  /** Records every write to `el.style.height`, and fakes the two measurements
   *  the function reads: `scrollHeight` (the content height) and the computed
   *  `height` (the RENDERED height). */
  function probe(el: HTMLElement, scrollHeight: number, renderedHeight: string) {
    const writes: string[] = []
    let current = el.style.height
    const style = {
      get height() {
        return current
      },
      set height(v: string) {
        writes.push(v)
        current = v
      },
    }
    // happy-dom's `el.style` rejects defineProperty, so the whole declaration
    // is shadowed on the instance instead.
    Object.defineProperty(el, 'style', { configurable: true, get: () => style })
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight })
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      height: renderedHeight,
    } as unknown as CSSStyleDeclaration)
    return writes
  }

  it('lands directly on the content height when there is no rendered height yet', () => {
    const el = document.createElement('div')
    const writes = probe(el, 76, 'auto')

    syncEditorHeight(el)

    // Nothing to tween from, so the first measure must not try.
    expect(writes).toEqual(['auto', '76px'])
  })

  it('re-states the rendered height as the tween start before writing the new one', () => {
    const el = document.createElement('div')
    const writes = probe(el, 76, '56px')

    syncEditorHeight(el)

    // `auto` is only the measurement; the transition must run from 56px.
    expect(writes).toEqual(['auto', '56px', '76px'])
  })

  it('starts from the live animated height when a tween is still running', () => {
    // The bug this guards: restarting from the previous TARGET makes fast
    // typing jump. The computed height is where the box actually is.
    const el = document.createElement('div')
    const writes = probe(el, 96, '66px')

    syncEditorHeight(el)

    expect(writes).toEqual(['auto', '66px', '96px'])
  })

  it('starts from the rendered height, not the clamped-out inline target', () => {
    // A long draft leaves `el.style.height` at the content height (e.g. 296px)
    // while `max-height: 180px` renders the box at 180px. Tweening from 296
    // would hold the box still and then snap.
    const el = document.createElement('div')
    el.style.height = '296px'
    const writes = probe(el, 40, '180px')

    syncEditorHeight(el)

    expect(writes).toEqual(['auto', '180px', '40px'])
  })

  it('skips the tween setup entirely when the content height is unchanged', () => {
    // Most keystrokes do not resize the box. Writing the start back and
    // forcing a reflow to line up a transition between two identical lengths
    // is pure cost — and that reflow is ~5x the rest of the sync.
    const el = document.createElement('div')
    const writes = probe(el, 76, '76px')

    syncEditorHeight(el)

    expect(writes).toEqual(['auto', '76px'])
  })
})
