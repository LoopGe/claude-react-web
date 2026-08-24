import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactElement } from 'react'
import { render as rtlRender, fireEvent } from '@testing-library/react'
import { Composer } from './Composer'
import { ToastProvider } from './ToastProvider'
import type { SlashCommand } from '../types'
import type { ComposerSnippetsApi } from '../hooks/useComposerSnippets'

// Composer calls useToast() for clipboard-fail hints, so every test
// render needs a ToastProvider in scope. Wrapping at the test-helper
// layer keeps the individual cases focused on Composer behaviour.
function render(ui: ReactElement) {
  return rtlRender(<ToastProvider>{ui}</ToastProvider>)
}

const noop = vi.fn()
const noopAsync = async () => {}

const stubSnippets: ComposerSnippetsApi = {
  snippets: [],
  loading: false,
  error: null,
  add: (label, content) => ({ id: 'stub', label, content }),
  update: noop,
  remove: noop,
  move: noop,
  refresh: async () => {},
}

const defaultProps = {
  input: '',
  setInput: noop,
  sending: false,
  disabled: false,
  terminated: false,
  canAttach: true,
  attachments: [] as never[],
  uploading: false,
  dragOver: false,
  onUploadFiles: noop,
  onRemoveAttachment: noop,
  onDragOver: noop,
  onDragLeave: noop,
  onDrop: noop,
  history: { add: noop, prev: () => '', next: () => '', isBrowsing: () => false, reset: () => {} },
  commands: [] as SlashCommand[],
  pastedImages: [] as never[],
  onPasteImage: noopAsync,
  onRemovePastedImage: noop,
  onSend: noop,
  onInterrupt: noop,
  canInterrupt: false,
  focusSignal: 0,
  snippets: stubSnippets,
  onOpenSnippetsManager: noop,
  onSaveCurrentAsSnippet: noop,
}

describe('Composer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders a textarea', () => {
    const { container } = render(<Composer {...defaultProps} />)
    const ta = container.querySelector('textarea')
    expect(ta).not.toBeNull()
  })

  it('calls onSend on Enter (no shift)', () => {
    const onSend = vi.fn()
    const { container } = render(
      <Composer {...defaultProps} input="hello" onSend={onSend} />,
    )
    const ta = container.querySelector('textarea')!
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: false })
    expect(onSend).toHaveBeenCalledOnce()
  })

  it('does not call onSend on Shift+Enter', () => {
    const onSend = vi.fn()
    const { container } = render(
      <Composer {...defaultProps} input="hello" onSend={onSend} />,
    )
    const ta = container.querySelector('textarea')!
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('calls onSend on Enter even when input is empty (parent guards)', () => {
    const onSend = vi.fn()
    const { container } = render(
      <Composer {...defaultProps} input="" onSend={onSend} />,
    )
    const ta = container.querySelector('textarea')!
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: false })
    // Composer always fires onSend; the parent (Chat) decides whether to
    // actually send based on input content.
    expect(onSend).toHaveBeenCalledOnce()
  })

  it('shows the Interrupt button (not Send) while a turn is running', () => {
    const { container } = render(
      <Composer {...defaultProps} canInterrupt />,
    )
    // Send and Interrupt share one slot; canInterrupt (= session.working)
    // swaps Send out for Interrupt.
    expect(container.querySelector('[aria-label="Interrupt the current turn"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Send message"]')).toBeNull()
  })

  it('shows the Send button (not Interrupt) when idle', () => {
    const { container } = render(
      <Composer {...defaultProps} canInterrupt={false} />,
    )
    expect(container.querySelector('[aria-label="Send message"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Interrupt the current turn"]')).toBeNull()
  })

  it('morphs the control into Background while a turn runs in tool_use phase', () => {
    const { container } = render(
      <Composer {...defaultProps} canInterrupt canBackground onBackground={noop} />,
    )
    // Background replaces Interrupt on the SAME control (three-state morph)
    // — no extra button slot, so the composer layout never changes.
    expect(container.querySelector('[aria-label="Background current tasks"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Interrupt the current turn"]')).toBeNull()
    expect(container.querySelector('[aria-label="Send message"]')).toBeNull()
  })

  it('slash-picker Escape is consumed by the escape stack and never reaches window', () => {
    // CommandPicker owns Escape via useEscapeStack (window CAPTURE +
    // stopPropagation): while the picker is open, the press closes it and
    // dies there — it must NOT bubble to App's escape chain, whose idle
    // semantics now open the resume picker on a single clean press. This
    // test locks that invariant in.
    // (scrollIntoView stub: jsdom lacks it; CommandPicker scrolls its
    // active item on mount — same stub as MessageList.test.tsx.)
    Element.prototype.scrollIntoView = vi.fn()
    const windowKeydown = vi.fn()
    window.addEventListener('keydown', windowKeydown)
    try {
      const { container } = render(
        <Composer {...defaultProps} commands={[{ name: 'help', description: 'Show help', argumentHint: '' }] as SlashCommand[]} />,
      )
      const ta = container.querySelector('textarea')!
      // Type '/' — the change handler opens the slash command picker.
      fireEvent.change(ta, { target: { value: '/he' } })
      expect(container.querySelector('[role="listbox"]')).not.toBeNull()

      // Escape: picker closes…
      fireEvent.keyDown(ta, { key: 'Escape' })
      expect(container.querySelector('[role="listbox"]')).toBeNull()
      // …and the keydown never reached window-level bubble listeners.
      expect(windowKeydown).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', windowKeydown)
    }
  })

  it('keeps Interrupt (not Background) while a turn runs without a blocking tool', () => {
    const { container } = render(
      <Composer {...defaultProps} canInterrupt canBackground={false} onBackground={noop} />,
    )
    // thinking/writing phases have nothing to detach — the control stays
    // Interrupt; Esc remains the always-on interrupt path.
    expect(container.querySelector('[aria-label="Interrupt the current turn"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Background current tasks"]')).toBeNull()
  })

  it('ignores canBackground without an in-flight turn (parent phase lag)', () => {
    const { container } = render(
      <Composer {...defaultProps} canInterrupt={false} canBackground onBackground={noop} />,
    )
    // The dwell-smoothed phase can outlive the turn by a beat — the control
    // must fall back to Send, never show Background on an idle session.
    expect(container.querySelector('[aria-label="Send message"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Background current tasks"]')).toBeNull()
  })

  it('routes a click in Background mode to onBackground, not onInterrupt', () => {
    const onBackground = vi.fn()
    const onInterrupt = vi.fn()
    const { container } = render(
      <Composer {...defaultProps} canInterrupt canBackground onBackground={onBackground} onInterrupt={onInterrupt} />,
    )
    fireEvent.click(container.querySelector('[aria-label="Background current tasks"]')!)
    expect(onBackground).toHaveBeenCalledOnce()
    expect(onInterrupt).not.toHaveBeenCalled()
  })

  it('shows session ended instead of textarea when terminated', () => {
    const { container } = render(
      <Composer {...defaultProps} terminated />,
    )
    // When terminated, Composer renders a "session ended" div instead of a textarea.
    expect(container.textContent).toContain('session has ended')
    expect(container.querySelector('textarea')).toBeNull()
  })

  it('calls setInput on textarea change', () => {
    const setInput = vi.fn()
    const { container } = render(
      <Composer {...defaultProps} setInput={setInput} />,
    )
    const ta = container.querySelector('textarea')!
    fireEvent.change(ta, { target: { value: 'new text' } })
    expect(setInput).toHaveBeenCalledWith('new text')
  })

  describe('prompt suggestion placeholder + Tab', () => {
    it('shows the suggestion as placeholder when input is empty', () => {
      const { container } = render(
        <Composer {...defaultProps} suggestion="Explain this code" />,
      )
      const ta = container.querySelector('textarea')!
      expect(ta.getAttribute('placeholder')).toBe('Explain this code')
    })

    it('shows the default placeholder when there is no suggestion', () => {
      const { container } = render(<Composer {...defaultProps} />)
      const ta = container.querySelector('textarea')!
      expect(ta.getAttribute('placeholder')).toMatch(/^Send a message/)
    })

    it('shows the default placeholder when input is non-empty even with a suggestion', () => {
      const { container } = render(
        <Composer {...defaultProps} input="partial" suggestion="Explain this code" />,
      )
      const ta = container.querySelector('textarea')!
      expect(ta.getAttribute('placeholder')).toMatch(/^Send a message/)
    })

    it('fills the suggestion on bare Tab when input is empty', () => {
      const setInput = vi.fn()
      const { container } = render(
        <Composer {...defaultProps} suggestion="Explain this code" setInput={setInput} />,
      )
      const ta = container.querySelector('textarea')!
      fireEvent.keyDown(ta, { key: 'Tab' })
      expect(setInput).toHaveBeenCalledWith('Explain this code')
    })

    it('does not fill the suggestion on Tab when input is non-empty', () => {
      const setInput = vi.fn()
      const { container } = render(
        <Composer {...defaultProps} input="hello" suggestion="Explain this code" setInput={setInput} />,
      )
      const ta = container.querySelector('textarea')!
      fireEvent.keyDown(ta, { key: 'Tab' })
      expect(setInput).not.toHaveBeenCalled()
    })

    it('does not fill the suggestion on Shift+Tab even when input is empty', () => {
      const setInput = vi.fn()
      const { container } = render(
        <Composer {...defaultProps} suggestion="Explain this code" setInput={setInput} />,
      )
      const ta = container.querySelector('textarea')!
      fireEvent.keyDown(ta, { key: 'Tab', shiftKey: true })
      expect(setInput).not.toHaveBeenCalled()
    })

    it('does not fill the suggestion on Tab during IME composition', () => {
      const setInput = vi.fn()
      const { container } = render(
        <Composer {...defaultProps} suggestion="Explain this code" setInput={setInput} />,
      )
      const ta = container.querySelector('textarea')!
      fireEvent.keyDown(ta, { key: 'Tab', isComposing: true })
      expect(setInput).not.toHaveBeenCalled()
    })
  })
})
