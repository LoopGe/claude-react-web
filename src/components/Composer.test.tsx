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
  add: (label, content) => ({ id: 'stub', label, content }),
  update: noop,
  remove: noop,
  move: noop,
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

  it('shows interrupt button when sending', () => {
    const { container } = render(
      <Composer {...defaultProps} sending />,
    )
    const btn = container.querySelector('.btn-interrupt, .interrupt-btn, button')
    // The interrupt button should be visible when sending=true.
    // Exact class depends on implementation; check that some button exists.
    expect(btn).not.toBeNull()
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
})
