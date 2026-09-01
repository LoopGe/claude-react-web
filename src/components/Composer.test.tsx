import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactElement } from 'react'
import { useState } from 'react'
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

  it('Enter confirms the command that is actually highlighted, not the source-array one', () => {
    // CommandPicker regroups plugin commands to the top of the list. Source
    // order [built-in, plugin, built-in] renders as [plugin, built-in,
    // built-in], so keyboard index 1 must resolve to the FIRST built-in —
    // not source index 1 (the plugin command). Regression: Enter/Tab used to
    // insert the source-array item, completing a different command than the
    // one the highlight showed.
    Element.prototype.scrollIntoView = vi.fn()
    const commands: SlashCommand[] = [
      { name: 'clear', description: 'Clear chat', argumentHint: '' },
      { name: 'research', description: '(skills) Deep research', argumentHint: '' },
      { name: 'usage', description: 'Show usage', argumentHint: '' },
    ]
    function Harness() {
      const [input, setInput] = useState('')
      return <Composer {...defaultProps} input={input} setInput={setInput} commands={commands} />
    }
    const { container } = render(<Harness />)
    const ta = container.querySelector('textarea')!

    fireEvent.change(ta, { target: { value: '/', selectionStart: 1, selectionEnd: 1 } })
    expect(container.querySelector('[role="listbox"]')).not.toBeNull()

    // Pick the second rendered item. Rendered order is [research, clear,
    // usage] (plugin group first), so index 1 = "clear".
    fireEvent.keyDown(ta, { key: 'ArrowDown' })
    const active = container.querySelector<HTMLButtonElement>('.cmd-picker-item.active')
    expect(active?.textContent).toContain('clear')

    fireEvent.keyDown(ta, { key: 'Enter' })
    // The inserted command is the highlighted one, not source-array index 1.
    expect(ta.value).toBe('/clear ')
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

    it('does not navigate when the textarea is not focused', () => {
      const setInput = vi.fn()
      const prev = vi.fn(() => 'older prompt')
      const { container } = render(
        <Composer {...defaultProps} setInput={setInput} history={historyStub({ prev })} />,
      )
      const ta = container.querySelector('textarea')!
      // Composer autofocuses its textarea on mount (mirroring focusSignal),
      // so blur first to reproduce the "pointer drifting over the composer
      // while reading the transcript" case. Wheel is a pointer-position
      // event, so without a focus gate an unfocused/empty composer would
      // hijack page scroll and clobber the draft. History navigation must
      // require the composer to be focused.
      ta.blur()
      const e = wheel(ta, -120)
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
      const ta = container.querySelector('textarea')!
      ta.focus()
      const e = wheel(ta, -120)
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
      const ta = container.querySelector('textarea')!
      ta.focus()
      wheel(ta, 120)
      expect(next).toHaveBeenCalled()
      expect(setInput).toHaveBeenCalledWith('newer prompt')
    })

    it('does not navigate on wheel down when not browsing history', () => {
      const setInput = vi.fn()
      const next = vi.fn(() => null)
      const { container } = render(
        <Composer {...defaultProps} setInput={setInput} history={historyStub({ next })} />,
      )
      const ta = container.querySelector('textarea')!
      ta.focus()
      const e = wheel(ta, 120)
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
      const ta = container.querySelector('textarea')!
      ta.focus()
      wheel(ta, -30) // |deltaY| < WHEEL_STEP_PX
      expect(prev).not.toHaveBeenCalled()
      expect(setInput).not.toHaveBeenCalled()
    })

    it('accumulates small deltas across events and steps once at threshold', () => {
      const setInput = vi.fn()
      const prev = vi.fn(() => 'older prompt')
      const { container } = render(
        <Composer {...defaultProps} setInput={setInput} history={historyStub({ prev })} />,
      )
      const ta = container.querySelector('textarea')!
      ta.focus()
      wheel(ta, -30)
      wheel(ta, -30)
      expect(prev).not.toHaveBeenCalled()
      wheel(ta, -30) // total −90 crosses the threshold
      expect(prev).toHaveBeenCalledTimes(1)
      expect(setInput).toHaveBeenCalledWith('older prompt')
    })

    it('clamps fast consecutive steps to one per time window', async () => {
      const setInput = vi.fn()
      const prev = vi.fn(() => 'older prompt')
      const { container } = render(
        <Composer {...defaultProps} setInput={setInput} history={historyStub({ prev })} />,
      )
      const ta = container.querySelector('textarea')!
      ta.focus()
      wheel(ta, -120)
      wheel(ta, -120) // within WHEEL_STEP_MS → blocked
      expect(prev).toHaveBeenCalledTimes(1)
      await new Promise((r) => setTimeout(r, 200))
      wheel(ta, -120) // lock expired → steps again
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
        const ta = container.querySelector('textarea')!
        ta.focus()
        // Step 1: first notch navigates.
        wheel(ta, -120)
        expect(prev).toHaveBeenCalledTimes(1)
        // Step 2: an immediate second notch is blocked by the time gate. Its
        // 120px must be carried — not discarded — so the next wheel that lands
        // after the gate opens steps immediately on a sub-threshold nudge.
        wheel(ta, -120)
        expect(prev).toHaveBeenCalledTimes(1)
        // Advance past WHEEL_STEP_MS. The carried −120 + a fresh −30 (below
        // the 80px threshold alone) must now cross and step.
        vi.advanceTimersByTime(200)
        wheel(ta, -30)
        expect(prev).toHaveBeenCalledTimes(2)
        expect(setInput).toHaveBeenCalledWith('older prompt')
      } finally {
        vi.useRealTimers()
      }
    })

    it('lets a scrollable textarea scroll internally instead of navigating', () => {
      const setInput = vi.fn()
      const prev = vi.fn(() => 'older prompt')
      const { container } = render(
        <Composer {...defaultProps} setInput={setInput} history={historyStub({ prev })} />,
      )
      const ta = container.querySelector('textarea')!
      ta.focus()
      Object.defineProperty(ta, 'scrollHeight', { value: 200, configurable: true })
      Object.defineProperty(ta, 'clientHeight', { value: 100, configurable: true })
      Object.defineProperty(ta, 'scrollTop', { value: 50, configurable: true })
      wheel(ta, -120)
      expect(prev).not.toHaveBeenCalled()
    })

    it('navigates when a scrollable textarea is at the top scroll edge', () => {
      const setInput = vi.fn()
      const prev = vi.fn(() => 'older prompt')
      const { container } = render(
        <Composer {...defaultProps} setInput={setInput} history={historyStub({ prev })} />,
      )
      const ta = container.querySelector('textarea')!
      ta.focus()
      Object.defineProperty(ta, 'scrollHeight', { value: 200, configurable: true })
      Object.defineProperty(ta, 'clientHeight', { value: 100, configurable: true })
      Object.defineProperty(ta, 'scrollTop', { value: 0, configurable: true })
      wheel(ta, -120)
      expect(prev).toHaveBeenCalled()
    })

    it('ignores wheel while an IME composition is active', () => {
      const setInput = vi.fn()
      const prev = vi.fn(() => 'older prompt')
      const { container } = render(
        <Composer {...defaultProps} setInput={setInput} history={historyStub({ prev })} />,
      )
      const ta = container.querySelector('textarea')!
      ta.focus()
      fireEvent.compositionStart(ta)
      wheel(ta, -120)
      expect(prev).not.toHaveBeenCalled()
      fireEvent.compositionEnd(ta)
      wheel(ta, -120)
      expect(prev).toHaveBeenCalledTimes(1)
    })

    it('resets the IME guard on blur so wheel history works again', () => {
      const setInput = vi.fn()
      const prev = vi.fn(() => 'older prompt')
      const { container } = render(
        <Composer {...defaultProps} setInput={setInput} history={historyStub({ prev })} />,
      )
      const ta = container.querySelector('textarea')!
      ta.focus()
      // Some IMEs never fire compositionend on cancel (Escape / click-away),
      // which would leave the guard stuck on and silently disable wheel
      // history. Focus loss must reset it.
      fireEvent.compositionStart(ta)
      wheel(ta, -120)
      expect(prev).not.toHaveBeenCalled()
      ta.blur()
      ta.focus()
      wheel(ta, -120)
      expect(prev).toHaveBeenCalledTimes(1)
    })

    it('does not preventDefault when there is no older history', () => {
      const prev = vi.fn(() => null)
      const { container } = render(
        <Composer {...defaultProps} history={historyStub({ prev })} />,
      )
      const ta = container.querySelector('textarea')!
      ta.focus()
      const e = wheel(ta, -120)
      expect(prev).toHaveBeenCalled()
      expect(e.defaultPrevented).toBe(false)
    })
  })
})
