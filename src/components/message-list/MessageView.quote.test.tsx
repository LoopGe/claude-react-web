import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import type { SdkMessage } from '../../types'
import { fileHandleText } from '../../../shared/upload-handle'
import { formatQuoteText } from '../../utils/quote-text'
import { MessageView } from './MessageView'

// QuotePreview's HoverPopover chain needs matchMedia + ResizeObserver; mirror
// the QuotePreview test harness so the inert chip mounts under happy-dom.
vi.stubGlobal('matchMedia', () => ({
  matches: false,
  media: '',
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
}))
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverMock)

const handle = fileHandleText(
  { id: '8f1c2d34-0000-4000-8000-000000000003', name: 'a.pdf', size: 3, digest: 'a'.repeat(64) },
  '/tmp/a.pdf',
)

function userMessage(content: string): SdkMessage {
  return {
    type: 'user',
    uuid: 'user-quote',
    parent_tool_use_id: null,
    message: { role: 'user', content },
  } as unknown as SdkMessage
}

function renderUser(content: string) {
  return render(
    <MessageView
      msg={userMessage(content)}
      sessionId="s1"
      foldExpanded={false}
      foldSearchHit={false}
      onToggleFold={() => {}}
      consumedKey="user-quote"
    />,
  )
}

describe('MessageView: sent blockquote rendering', () => {
  it('renders a sent blockquote as an inert quote chip inline with prose', () => {
    const { container } = renderUser('before\n\n> quoted\n\nafter')
    const chip = container.querySelector('.quote-chip')!
    expect(chip).not.toBeNull()
    expect(chip.querySelector('.quote-chip-text')!.textContent).toBe('quoted')
    // Inert: no remove control.
    expect(chip.querySelector('button')).toBeNull()
    expect(chip.hasAttribute('data-removable')).toBe(false)
    // The paragraph separators collapse to inline space so the quote flows
    // with the surrounding prose (DSH quote-rule parity).
    expect(container.textContent).toContain('before quoted after')
  })

  it('renders a quote-only message as a chip', () => {
    const { container } = renderUser('> only')
    expect(container.querySelector('.quote-chip-text')!.textContent).toBe('only')
  })

  it('renders a quoted file-handle as literal chip text, not a file attachment', () => {
    const { container } = renderUser(`> ${handle}`)
    // The handle string stays literal inside the quote (decoded of its `> `).
    expect(container.querySelector('.quote-chip-text')!.textContent).toBe(handle)
    expect(container.querySelector('.quote-chip')).not.toBeNull()
  })

  it('renders a hand-typed blockquote identically to a selection-inserted quote', () => {
    const manual = renderUser('> a\n> b')
    const manualText = manual.container.querySelector('.quote-chip-text')!.textContent
    manual.unmount()
    const selection = renderUser(formatQuoteText('a\nb'))
    expect(selection.container.querySelector('.quote-chip-text')!.textContent).toBe(manualText)
    expect(manualText).toBe('a\nb')
  })

  it('leaves an inline > mid-line as ordinary text (no chip)', () => {
    const { container } = renderUser('a > b')
    expect(container.querySelector('.quote-chip')).toBeNull()
    expect(container.textContent).toContain('a > b')
  })
})