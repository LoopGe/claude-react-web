import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ReactElement } from 'react'
import { useState } from 'react'
import { render as rtlRender, cleanup, fireEvent } from '@testing-library/react'
import { Composer } from './Composer'
import { ToastProvider } from './ToastProvider'
import type { SlashCommand } from '../types'
import type { ComposerSnippetsApi } from '../hooks/useComposerSnippets'

// ── Rich-editor test helpers ────────────────────────────────────────
// The composer renders a contenteditable <div> (RichPromptInput) rather
// than a <textarea>. These helpers abstract the editor lookup so the same
// test logic works regardless.

/** Find the editor element (textarea or contenteditable div). */
function getEditor(container: HTMLElement): HTMLElement {
  return container.querySelector('textarea')
    ?? container.querySelector('[contenteditable="true"]')!
}

/** Read the current text value of the editor. */
function getEditorValue(el: HTMLElement): string {
  if (el instanceof HTMLTextAreaElement) return el.value
  return el.textContent ?? ''
}

/** Set the editor text and fire the appropriate event. */
function setEditorText(el: HTMLElement, text: string) {
  if (el instanceof HTMLTextAreaElement) {
    fireEvent.change(el, { target: { value: text } })
  } else {
    el.textContent = text
    fireEvent.input(el)
  }
}


// vitest.config.ts sets globals:false, so @testing-library's auto-cleanup never
// registers — every render stays mounted unless we unmount it. That used to be
// invisible (all queries were container-scoped). The slash picker now portals
// to <body> and these tests query it document-wide, so a picker left open by one
// test would answer the next test's assertions from stale DOM — same explicit
// cleanup as CommandPicker/ContextMenu/ModelPicker tests.
afterEach(() => cleanup())

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
  // Allocates the reference id for a collapsed paste and stores its content.
  onAddPastedText: () => 1,
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
    // The editor is a contenteditable div.
    const editor = getEditor(container)
    expect(editor).not.toBeNull()
  })

  it('calls onSend on Enter (no shift)', () => {
    const onSend = vi.fn()
    const { container } = render(
      <Composer {...defaultProps} input="hello" onSend={onSend} />,
    )
    const editor = getEditor(container)
    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: false })
    expect(onSend).toHaveBeenCalledOnce()
  })

  it('does not call onSend on Shift+Enter', () => {
    const onSend = vi.fn()
    const { container } = render(
      <Composer {...defaultProps} input="hello" onSend={onSend} />,
    )
    const editor = getEditor(container)
    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('calls onSend on Enter even when input is empty (parent guards)', () => {
    const onSend = vi.fn()
    const { container } = render(
      <Composer {...defaultProps} input="" onSend={onSend} />,
    )
    const editor = getEditor(container)
    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: false })
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

  it('never shows a Background state on the shared control (Alt+B-only entry)', () => {
    // The control is a strict two-state morph: Send (idle) / Interrupt
    // (working). Backgrounding used to be a third button state keyed on the
    // streaming phase, which flickered the control between Interrupt and
    // Background on every phase transition (thinking ↔ writing ↔ tool_use ↔
    // null). It's now reachable only via Alt+B, advertised in the Interrupt
    // tooltip — this test locks in that the button state never reappears.
    const { container } = render(<Composer {...defaultProps} canInterrupt />)
    expect(container.querySelector('[aria-label="Interrupt the current turn"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Background current tasks"]')).toBeNull()
    const btn = container.querySelector<HTMLButtonElement>(
      '[aria-label="Interrupt the current turn"]',
    )!
    expect(btn.title).toContain('Alt+B')
  })

  it('slash-picker Escape is consumed by the escape stack and never reaches window', () => {
    Element.prototype.scrollIntoView = vi.fn()
    const windowKeydown = vi.fn()
    window.addEventListener('keydown', windowKeydown)
    try {
      const { container } = render(
        <Composer {...defaultProps} commands={[{ name: 'help', description: 'Show help', argumentHint: '' }] as SlashCommand[]} />,
      )
      const editor = getEditor(container)
      // Type '/' — the change handler opens the slash command picker.
      setEditorText(editor, '/he')
      expect(document.querySelector('.cmd-picker')).not.toBeNull()

      // Escape: picker closes…
      fireEvent.keyDown(editor, { key: 'Escape' })
      expect(document.querySelector('.cmd-picker')).toBeNull()
      // …and the keydown never reached window-level bubble listeners.
      expect(windowKeydown).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', windowKeydown)
    }
  })

  it('Enter confirms the command that is actually highlighted, not the source-array one', () => {
    Element.prototype.scrollIntoView = vi.fn()
    const commands: SlashCommand[] = [
      { name: 'clear', description: 'Clear chat', argumentHint: '' },
      { name: 'research', description: '(skills) Deep research', argumentHint: '' },
      { name: 'usage', description: 'Show usage', argumentHint: '' },
    ]
    const setInput = vi.fn()
    function Harness() {
      const [input, setLocalInput] = useState('')
      const wrapped = (v: string) => { setInput(v); setLocalInput(v) }
      return <Composer {...defaultProps} input={input} setInput={wrapped} commands={commands} />
    }
    const { container } = render(<Harness />)
    const editor = getEditor(container)

    setEditorText(editor, '/')
    expect(document.querySelector('.cmd-picker')).not.toBeNull()

    // Pick the second rendered item. Rendered order is [research, clear,
    // usage] (plugin group first), so index 1 = "clear".
    fireEvent.keyDown(editor, { key: 'ArrowDown' })
    const active = document.querySelector<HTMLButtonElement>('.cmd-picker-item.active')
    expect(active?.textContent).toContain('clear')

    fireEvent.keyDown(editor, { key: 'Enter' })
    // The inserted command is the highlighted one, not source-array index 1.
    expect(setInput).toHaveBeenLastCalledWith('/clear ')
  })

  it('wraps ArrowUp from the first candidate to the bottom, and ArrowDown from the bottom to the top', () => {
    Element.prototype.scrollIntoView = vi.fn()
    const commands: SlashCommand[] = [
      { name: 'clear', description: 'Clear chat', argumentHint: '' },
      { name: 'help', description: 'Show help', argumentHint: '' },
      { name: 'usage', description: 'Show usage', argumentHint: '' },
    ]
    function Harness() {
      const [input, setInput] = useState('')
      return <Composer {...defaultProps} input={input} setInput={setInput} commands={commands} />
    }
    const { container } = render(<Harness />)
    const editor = getEditor(container)

    setEditorText(editor, '/')
    expect(document.querySelector('.cmd-picker')).not.toBeNull()

    const active = () => document.querySelector<HTMLButtonElement>('.cmd-picker-item.active')
    // Freshly opened picker starts on the first candidate.
    expect(active()?.textContent).toContain('clear')

    // ArrowUp at the top wraps to the bottom candidate.
    fireEvent.keyDown(editor, { key: 'ArrowUp' })
    expect(active()?.textContent).toContain('usage')

    // ArrowDown at the bottom wraps back to the top candidate.
    fireEvent.keyDown(editor, { key: 'ArrowDown' })
    expect(active()?.textContent).toContain('clear')
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
    const editor = getEditor(container)
    setEditorText(editor, 'new text')
    expect(setInput).toHaveBeenCalledWith('new text')
  })

  describe('prompt suggestion placeholder + Tab', () => {
    it('shows the suggestion as placeholder when input is empty', () => {
      const { container } = render(
        <Composer {...defaultProps} suggestion="Explain this code" />,
      )
      const editor = getEditor(container)
      // Rich editor uses data-placeholder; textarea uses placeholder attr.
      const ph = editor instanceof HTMLTextAreaElement
        ? editor.getAttribute('placeholder')
        : editor.getAttribute('data-placeholder')
      expect(ph).toBe('Explain this code')
    })

    it('shows the default placeholder when there is no suggestion', () => {
      const { container } = render(<Composer {...defaultProps} />)
      const editor = getEditor(container)
      const ph = editor instanceof HTMLTextAreaElement
        ? editor.getAttribute('placeholder')
        : editor.getAttribute('data-placeholder')
      expect(ph).toMatch(/^Send a message/)
    })

    it('shows the default placeholder when input is non-empty even with a suggestion', () => {
      const { container } = render(
        <Composer {...defaultProps} input="partial" suggestion="Explain this code" />,
      )
      const editor = getEditor(container)
      const ph = editor instanceof HTMLTextAreaElement
        ? editor.getAttribute('placeholder')
        : editor.getAttribute('data-placeholder')
      expect(ph).toMatch(/^Send a message/)
    })

    it('fills the suggestion on bare Tab when input is empty', () => {
      const setInput = vi.fn()
      const { container } = render(
        <Composer {...defaultProps} suggestion="Explain this code" setInput={setInput} />,
      )
      const editor = getEditor(container)
      fireEvent.keyDown(editor, { key: 'Tab' })
      expect(setInput).toHaveBeenCalledWith('Explain this code')
    })

    it('does not fill the suggestion on Tab when input is non-empty', () => {
      const setInput = vi.fn()
      const { container } = render(
        <Composer {...defaultProps} input="hello" suggestion="Explain this code" setInput={setInput} />,
      )
      const editor = getEditor(container)
      fireEvent.keyDown(editor, { key: 'Tab' })
      expect(setInput).not.toHaveBeenCalled()
    })

    it('does not fill the suggestion on Shift+Tab even when input is empty', () => {
      const setInput = vi.fn()
      const { container } = render(
        <Composer {...defaultProps} suggestion="Explain this code" setInput={setInput} />,
      )
      const editor = getEditor(container)
      fireEvent.keyDown(editor, { key: 'Tab', shiftKey: true })
      expect(setInput).not.toHaveBeenCalled()
    })

    it('does not fill the suggestion on Tab during IME composition', () => {
      const setInput = vi.fn()
      const { container } = render(
        <Composer {...defaultProps} suggestion="Explain this code" setInput={setInput} />,
      )
      const editor = getEditor(container)
      fireEvent.keyDown(editor, { key: 'Tab', isComposing: true })
      expect(setInput).not.toHaveBeenCalled()
    })
  })

  describe('mouse wheel history navigation', () => {
    // The wheel listener is attached natively (React onWheel is passive and
    // can't preventDefault), so dispatch a real cancellable Event with
    // deltaY set — the handler normalizes deltaMode 0 (pixels).
    function wheel(el: Element, deltaY: number) {
      const e = new Event('wheel', { bubbles: true, cancelable: true })
      Object.defineProperty(e, 'deltaY', { value: deltaY })
      Object.defineProperty(e, 'deltaMode', { value: 0 })
      el.dispatchEvent(e)
      return e
    }

    function historyStub(overrides: Partial<{ prev: () => string | null; next: () => string | null; isBrowsing: () => boolean }>) {
      return {
        add: noop,
        prev: () => '',
        next: () => '',
        isBrowsing: () => false,
        reset: () => {},
        ...overrides,
      }
    }

    it('does not navigate when the editor is not focused', () => {
      const setInput = vi.fn()
      const prev = vi.fn(() => 'older prompt')
      const { container } = render(
        <Composer {...defaultProps} setInput={setInput} history={historyStub({ prev })} />,
      )
      const editor = getEditor(container)
      // Composer autofocuses on mount, so blur first.
      editor.blur()
      const e = wheel(editor, -120)
      expect(prev).not.toHaveBeenCalled()
      expect(setInput).not.toHaveBeenCalled()
      expect(e.defaultPrevented).toBe(false)
    })

    it('recalls an older history entry on wheel up', () => {
      const setInput = vi.fn()
      const prev = vi.fn(() => 'older prompt')
      const { container } = render(
        <Composer {...defaultProps} setInput={setInput} history={historyStub({ prev })} />,
      )
      const editor = getEditor(container)
      editor.focus()
      const e = wheel(editor, -120)
      expect(prev).toHaveBeenCalledWith('')
      expect(setInput).toHaveBeenCalledWith('older prompt')
      expect(e.defaultPrevented).toBe(true)
    })

    it('recalls a newer history entry on wheel down while browsing', () => {
      const setInput = vi.fn()
      const next = vi.fn(() => 'newer prompt')
      const { container } = render(
        <Composer {...defaultProps} setInput={setInput} history={historyStub({ next, isBrowsing: () => true })} />,
      )
      const editor = getEditor(container)
      editor.focus()
      wheel(editor, 120)
      expect(next).toHaveBeenCalled()
      expect(setInput).toHaveBeenCalledWith('newer prompt')
    })

    it('does not navigate on wheel down when not browsing history', () => {
      const setInput = vi.fn()
      const next = vi.fn(() => null)
      const { container } = render(
        <Composer {...defaultProps} setInput={setInput} history={historyStub({ next })} />,
      )
      const editor = getEditor(container)
      editor.focus()
      const e = wheel(editor, 120)
      expect(next).toHaveBeenCalled()
      expect(setInput).not.toHaveBeenCalled()
      expect(e.defaultPrevented).toBe(false)
    })

    it('does not navigate when a wheel stays under the step threshold', () => {
      const setInput = vi.fn()
      const prev = vi.fn(() => 'older prompt')
      const { container } = render(
        <Composer {...defaultProps} setInput={setInput} history={historyStub({ prev })} />,
      )
      const editor = getEditor(container)
      editor.focus()
      wheel(editor, -30) // |deltaY| < WHEEL_STEP_PX
      expect(prev).not.toHaveBeenCalled()
      expect(setInput).not.toHaveBeenCalled()
    })

    it('accumulates small deltas across events and steps once at threshold', () => {
      const setInput = vi.fn()
      const prev = vi.fn(() => 'older prompt')
      const { container } = render(
        <Composer {...defaultProps} setInput={setInput} history={historyStub({ prev })} />,
      )
      const editor = getEditor(container)
      editor.focus()
      wheel(editor, -30)
      wheel(editor, -30)
      expect(prev).not.toHaveBeenCalled()
      wheel(editor, -30) // total −90 crosses the threshold
      expect(prev).toHaveBeenCalledTimes(1)
      expect(setInput).toHaveBeenCalledWith('older prompt')
    })

    it('clamps fast consecutive steps to one per time window', async () => {
      const setInput = vi.fn()
      const prev = vi.fn(() => 'older prompt')
      const { container } = render(
        <Composer {...defaultProps} setInput={setInput} history={historyStub({ prev })} />,
      )
      const editor = getEditor(container)
      editor.focus()
      wheel(editor, -120)
      wheel(editor, -120) // within WHEEL_STEP_MS → blocked
      expect(prev).toHaveBeenCalledTimes(1)
      await new Promise((r) => setTimeout(r, 200))
      wheel(editor, -120) // lock expired → steps again
      expect(prev).toHaveBeenCalledTimes(2)
    })

    it('carries surplus delta across a blocked time-gate so fast flings do not lose a step', () => {
      vi.useFakeTimers()
      try {
        const setInput = vi.fn()
        const prev = vi.fn(() => 'older prompt')
        const { container } = render(
          <Composer {...defaultProps} setInput={setInput} history={historyStub({ prev })} />,
        )
        const editor = getEditor(container)
        editor.focus()
        // Step 1: first notch navigates.
        wheel(editor, -120)
        expect(prev).toHaveBeenCalledTimes(1)
        // Step 2: an immediate second notch is blocked by the time gate. Its
        // 120px must be carried — not discarded — so the next wheel that lands
        // after the gate opens steps immediately on a sub-threshold nudge.
        wheel(editor, -120)
        expect(prev).toHaveBeenCalledTimes(1)
        // Advance past WHEEL_STEP_MS. The carried −120 + a fresh −30 (below
        // the 80px threshold alone) must now cross and step.
        vi.advanceTimersByTime(200)
        wheel(editor, -30)
        expect(prev).toHaveBeenCalledTimes(2)
        expect(setInput).toHaveBeenCalledWith('older prompt')
      } finally {
        vi.useRealTimers()
      }
    })

    it('lets a scrollable editor scroll internally instead of navigating', () => {
      const setInput = vi.fn()
      const prev = vi.fn(() => 'older prompt')
      const { container } = render(
        <Composer {...defaultProps} setInput={setInput} history={historyStub({ prev })} />,
      )
      const editor = getEditor(container)
      editor.focus()
      Object.defineProperty(editor, 'scrollHeight', { value: 200, configurable: true })
      Object.defineProperty(editor, 'clientHeight', { value: 100, configurable: true })
      Object.defineProperty(editor, 'scrollTop', { value: 50, configurable: true })
      wheel(editor, -120)
      expect(prev).not.toHaveBeenCalled()
    })

    it('navigates when a scrollable editor is at the top scroll edge', () => {
      const setInput = vi.fn()
      const prev = vi.fn(() => 'older prompt')
      const { container } = render(
        <Composer {...defaultProps} setInput={setInput} history={historyStub({ prev })} />,
      )
      const editor = getEditor(container)
      editor.focus()
      Object.defineProperty(editor, 'scrollHeight', { value: 200, configurable: true })
      Object.defineProperty(editor, 'clientHeight', { value: 100, configurable: true })
      Object.defineProperty(editor, 'scrollTop', { value: 0, configurable: true })
      wheel(editor, -120)
      expect(prev).toHaveBeenCalled()
    })

    it('ignores wheel while an IME composition is active', () => {
      const setInput = vi.fn()
      const prev = vi.fn(() => 'older prompt')
      const { container } = render(
        <Composer {...defaultProps} setInput={setInput} history={historyStub({ prev })} />,
      )
      const editor = getEditor(container)
      editor.focus()
      fireEvent.compositionStart(editor)
      wheel(editor, -120)
      expect(prev).not.toHaveBeenCalled()
      fireEvent.compositionEnd(editor)
      wheel(editor, -120)
      expect(prev).toHaveBeenCalledTimes(1)
    })

    it('resets the IME guard on blur so wheel history works again', () => {
      const setInput = vi.fn()
      const prev = vi.fn(() => 'older prompt')
      const { container } = render(
        <Composer {...defaultProps} setInput={setInput} history={historyStub({ prev })} />,
      )
      const editor = getEditor(container)
      editor.focus()
      // Some IMEs never fire compositionend on cancel (Escape / click-away),
      // which would leave the guard stuck on and silently disable wheel
      // history. Focus loss must reset it.
      fireEvent.compositionStart(editor)
      wheel(editor, -120)
      expect(prev).not.toHaveBeenCalled()
      editor.blur()
      editor.focus()
      wheel(editor, -120)
      expect(prev).toHaveBeenCalledTimes(1)
    })

    it('does not preventDefault when there is no older history', () => {
      const prev = vi.fn(() => null)
      const { container } = render(
        <Composer {...defaultProps} history={historyStub({ prev })} />,
      )
      const editor = getEditor(container)
      editor.focus()
      const e = wheel(editor, -120)
      expect(prev).toHaveBeenCalled()
      expect(e.defaultPrevented).toBe(false)
    })
  })

  describe('scheduled send (UI hidden — SCHEDULE_SEND_ENABLED is false pending a UI redesign)', () => {
    const stubScheduled = {
      schedules: [
        { id: 'sch1', sessionId: 's1', fireAt: Date.now() + 60_000, body: { text: 'later' }, status: 'pending' as const, createdAt: Date.now() },
      ],
      now: Date.now(),
      cancel: noopAsync,
      dismiss: noopAsync,
    }

    it('does not render the schedule button, even with content and props wired', () => {
      const { container } = render(<Composer {...defaultProps} input="hello" scheduled={stubScheduled} onSendScheduled={noop} />)
      expect(container.querySelector('[aria-label="Schedule send"]')).toBeNull()
    })

    it('does not render pending or failed chips when schedules are provided', () => {
      const { container } = render(
        <Composer
          {...defaultProps}
          scheduled={{
            ...stubScheduled,
            schedules: [
              ...stubScheduled.schedules,
              { id: 'sch2', sessionId: 's1', fireAt: 0, body: { text: 'x' }, status: 'failed' as const, createdAt: 0, error: 'session s1 is terminated' },
            ],
          }}
        />,
      )
      expect(container.querySelector('.scheduled-chip')).toBeNull()
      expect(container.querySelector('.scheduled-chip-failed')).toBeNull()
    })
  })
})

describe('Composer pasted-text references', () => {
  // 30 lines → 29 newlines, comfortably past the collapse threshold.
  const LONG_PASTE = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')
  const REF = '[Pasted text #1 +29 lines]'

  /** Controlled harness: most assertions are about the resulting input value. */
  function Harness({
    initial,
    onAddPastedText,
    setInput: externalSetInput,
  }: {
    initial: string
    onAddPastedText: (content: string) => number
    setInput?: (v: string) => void
  }) {
    const [value, setValue] = useState(initial)
    const wrapped = (v: string) => { setValue(v); externalSetInput?.(v) }
    return (
      <Composer {...defaultProps} input={value} setInput={wrapped} onAddPastedText={onAddPastedText} />
    )
  }

  function setup(initial: string, onAddPastedText: (content: string) => number = () => 1) {
    const setInput = vi.fn()
    const utils = render(<Harness initial={initial} onAddPastedText={onAddPastedText} setInput={setInput} />)
    const editor = getEditor(utils.container)
    return { ...utils, editor, setInput }
  }

  it('collapses a long paste into a reference and hands over the content', () => {
    const onAddPastedText = vi.fn(() => 1)
    const { editor, setInput } = setup('', onAddPastedText)

    fireEvent.paste(editor, { clipboardData: { getData: () => LONG_PASTE } })

    expect(onAddPastedText).toHaveBeenCalledWith(LONG_PASTE)
    // setInput should have been called with the reference string.
    expect(setInput).toHaveBeenCalledWith(REF)
  })

  it('inserts a short paste inline without collapsing', () => {
    const onAddPastedText = vi.fn(() => 1)
    const { editor, setInput } = setup('', onAddPastedText)

    fireEvent.paste(editor, { clipboardData: { getData: () => 'one\ntwo' } })

    // Short pastes go through onPasteText → placePastedText → insert verbatim.
    expect(onAddPastedText).not.toHaveBeenCalled()
    expect(setInput).toHaveBeenCalledWith('one\ntwo')
  })

  // The remaining 8 tests (Backspace/Delete/ArrowLeft/ArrowRight/double-click
  // on reference chips) tested textarea-specific offset bookkeeping that
  // usePastedTextEditing.handleRefKeyDown / widenToRef performed. With the
  // rich editor, chips are real DOM elements — the browser's native caret and
  // Backspace treat them as one unit.  These behaviours cannot be tested in
  // jsdom because it does not implement contenteditable editing operations.
  // They are UNVERIFIED until the Step 7 manual browser pass runs — the pass
  // is outstanding, not done. Do not treat them as already covered.
})

describe('Composer context-menu Cut/Copy/Paste/Select-all', () => {
  // jsdom has no navigator.clipboard — mock it for the context-menu tests.
  let origClipboard: typeof navigator.clipboard
  beforeEach(() => {
    origClipboard = navigator.clipboard
    Object.defineProperty(navigator, 'clipboard', {
      value: { readText: async () => '', writeText: async () => {} },
      configurable: true,
      writable: true,
    })
  })
  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: origClipboard, configurable: true, writable: true })
  })

  function Harness({ initial }: { initial: string }) {
    const [value, setValue] = useState(initial)
    return (
      <Composer
        {...defaultProps}
        input={value}
        setInput={setValue}
        onAddPastedText={() => 1}
      />
    )
  }

  /** Right-click the editor at the given position to open the context
   *  menu and snapshot the selection.  Returns the editor element. */
  function rightClick(
    container: HTMLElement,
    selectionStart: number,
    selectionEnd: number,
  ): HTMLElement {
    const editor = getEditor(container)
    editor.focus()
    if (editor instanceof HTMLTextAreaElement) {
      editor.setSelectionRange(selectionStart, selectionEnd)
    } else {
      // Contenteditable: set selection via the Selection API.
      const doc = editor.ownerDocument
      const sel = doc.getSelection()
      if (sel) {
        const range = doc.createRange()
        let startNode: Node | null = null
        let startOff = 0
        let endNode: Node | null = null
        let endOff = 0
        let current = 0
        for (const node of Array.from(editor.childNodes)) {
          const len = (node.textContent ?? '').length
          if (!startNode && current + len >= selectionStart) {
            startNode = node
            startOff = selectionStart - current
          }
          if (!endNode && current + len >= selectionEnd) {
            endNode = node
            endOff = selectionEnd - current
            break
          }
          current += len
        }
        if (startNode && endNode) {
          range.setStart(startNode, startOff)
          range.setEnd(endNode, endOff)
          sel.removeAllRanges()
          sel.addRange(range)
        }
      }
    }
    fireEvent.contextMenu(editor, { clientX: 100, clientY: 100 })
    return editor
  }

  /** Click a context-menu item by its label text. */
  function clickMenuItem(label: string) {
    const buttons = document.querySelectorAll('.ctx-menu-item')
    for (const btn of Array.from(buttons)) {
      if (btn.textContent?.includes(label)) {
        fireEvent.click(btn)
        return
      }
    }
    throw new Error(`Menu item "${label}" not found`)
  }

  it('Paste inserts text at a collapsed caret (non-zero position)', async () => {
    navigator.clipboard.readText = async () => 'XYZ'
    const { container } = render(<Harness initial="hello" />)
    rightClick(container, 3, 3)
    await new Promise((r) => requestAnimationFrame(r))
    clickMenuItem('Paste')
    await new Promise((r) => requestAnimationFrame(r))
    const editor = getEditor(container)
    expect(getEditorValue(editor)).toBe('helXYZlo')
  })

  it('Paste replaces a selection and does not double-apply', async () => {
    navigator.clipboard.readText = async () => 'XX'
    const { container } = render(<Harness initial="hello" />)
    rightClick(container, 1, 4)
    await new Promise((r) => requestAnimationFrame(r))
    clickMenuItem('Paste')
    await new Promise((r) => requestAnimationFrame(r))
    const editor = getEditor(container)
    expect(getEditorValue(editor)).toBe('hXXo')
  })

  it('Cut removes the selected text and copies it', async () => {
    const written: string[] = []
    navigator.clipboard.writeText = async (t: string) => { written.push(t) }
    const { container } = render(<Harness initial="hello" />)
    rightClick(container, 1, 4)
    await new Promise((r) => requestAnimationFrame(r))
    clickMenuItem('Cut')
    await new Promise((r) => requestAnimationFrame(r))
    const editor = getEditor(container)
    expect(getEditorValue(editor)).toBe('ho')
    expect(written).toEqual(['ell'])
  })

  it('Copy does not change the editor value', async () => {
    const written: string[] = []
    navigator.clipboard.writeText = async (t: string) => { written.push(t) }
    const { container } = render(<Harness initial="hello" />)
    rightClick(container, 1, 4)
    await new Promise((r) => requestAnimationFrame(r))
    clickMenuItem('Copy')
    const editor = getEditor(container)
    expect(getEditorValue(editor)).toBe('hello')
    expect(written).toEqual(['ell'])
  })
})
