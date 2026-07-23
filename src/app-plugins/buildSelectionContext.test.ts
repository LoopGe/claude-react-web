import { describe, expect, it, beforeEach } from 'vitest'
import { buildSelectionContext } from './buildSelectionContext.js'

// jsdom provides window.getSelection / Range / document. Each test builds two
// message boundary divs, places a text selection, and asserts the builder's
// cross-message / truncation / sensitive-block rules.

describe('buildSelectionContext', () => {
  let msgA: HTMLElement
  let msgB: HTMLElement

  beforeEach(() => {
    document.body.innerHTML = ''
    msgA = document.createElement('div')
    msgB = document.createElement('div')
    msgA.innerHTML = '<p>The quick brown fox jumps over the lazy dog.</p>'
    msgB.innerHTML = '<p>Second message with different text.</p>'
    document.body.append(msgA, msgB)
  })

  function selectRange(startContainer: Node, startOffset: number, endContainer: Node, endOffset: number): Selection {
    const sel = window.getSelection()!
    sel.removeAllRanges()
    const range = document.createRange()
    range.setStart(startContainer, startOffset)
    range.setEnd(endContainer, endOffset)
    sel.addRange(range)
    return sel
  }

  it('returns empty for a collapsed selection', () => {
    const p = msgA.querySelector('p')!.firstChild!
    const sel = selectRange(p, 0, p, 0)
    const r = buildSelectionContext({
      selection: sel, sessionId: 's', messageId: 'm', messageBoundary: msgA,
      role: 'assistant', contentBlockType: 'text',
    })
    expect(r).toEqual({ ok: false, reason: 'empty' })
  })

  it('builds a context for a selection within one message', () => {
    const p = msgA.querySelector('p')!.firstChild!
    const sel = selectRange(p, 4, p, 9) // "quick"
    const r = buildSelectionContext({
      selection: sel, sessionId: 's', messageId: 'm', messageBoundary: msgA,
      role: 'assistant', contentBlockType: 'text',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.context.selection.text).toBe('quick')
    expect(r.context.selection.truncated).toBe(false)
    expect(r.context.message.role).toBe('assistant')
    expect(r.context.sessionId).toBe('s')
  })

  it('rejects a selection spanning two messages (cross-message)', () => {
    const start = msgA.querySelector('p')!.firstChild!
    const end = msgB.querySelector('p')!.firstChild!
    const sel = selectRange(start, 0, end, 5)
    const r = buildSelectionContext({
      selection: sel, sessionId: 's', messageId: 'm', messageBoundary: msgA,
      role: 'assistant', contentBlockType: 'text',
    })
    expect(r).toEqual({ ok: false, reason: 'cross-message' })
  })

  it('rejects sensitive blocks (thinking / tool-result)', () => {
    const p = msgA.querySelector('p')!.firstChild!
    const sel = selectRange(p, 0, p, 5)
    const r = buildSelectionContext({
      selection: sel, sessionId: 's', messageId: 'm', messageBoundary: msgA,
      role: 'tool', contentBlockType: 'tool-result',
    })
    expect(r).toEqual({ ok: false, reason: 'sensitive-block' })
  })

  it('truncates long selections and sets the truncated flag', () => {
    const long = 'x'.repeat(25_000)
    msgA.innerHTML = `<p>${long}</p>`
    const p = msgA.querySelector('p')!.firstChild!
    const sel = selectRange(p, 0, p, long.length)
    const r = buildSelectionContext({
      selection: sel, sessionId: 's', messageId: 'm', messageBoundary: msgA,
      role: 'assistant', contentBlockType: 'text',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // Body hard-capped at selectionMaxChars (20 000)…
    expect(r.context.selection.text.length).toBe(20_000)
    // …but `length` reports the ORIGINAL selection length.
    expect(r.context.selection.length).toBe(25_000)
    expect(r.context.selection.truncated).toBe(true)
  })
})
