// The composer's terminal entry button: visible ONLY while a terminal is
// running AND the host wired the open handler, immediately right of the
// Tasks button. Same harness contract as Composer.test.tsx (ToastProvider
// wrap, contenteditable editor, global cleanup from src/test-setup.ts).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ReactElement } from 'react'
import { render as rtlRender, cleanup, fireEvent, act, screen } from '@testing-library/react'
import { Composer } from './Composer'
import { ToastProvider } from './ToastProvider'
import type { SlashCommand } from '../types'
import type { ComposerSnippetsApi } from '../hooks/useComposerSnippets'

afterEach(() => cleanup())

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
  dragOver: false,
  onFilesPicked: noop,
  onDragOver: noop,
  onDragLeave: noop,
  onDrop: noop,
  history: { add: noop, prev: () => null, next: () => null, isBrowsing: () => false, reset: () => {} },
  commands: [] as SlashCommand[],
  pastedImages: [] as never[],
  imagesPending: false,
  files: [] as never[],
  onRemoveFile: noop,
  onRetryFile: noop,
  onPasteImages: noopAsync,
  onPasteFiles: noopAsync,
  onRemovePastedImage: noop,
  onAddPastedText: () => 1,
  onSend: noop,
  onInterrupt: noop,
  canInterrupt: false,
  focusSignal: 0,
  snippets: stubSnippets,
  onOpenSnippetsManager: noop,
  onSaveCurrentAsSnippet: noop,
}

const terminalButton = () => screen.queryByRole('button', { name: 'Open terminal' })

describe('Composer terminal button', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('is absent while no terminal is running', () => {
    render(<Composer {...defaultProps} onOpenTerminal={noop} terminalRunning={false} />)
    expect(terminalButton()).toBeNull()
  })

  it('is absent when the host did not wire an open handler', () => {
    render(<Composer {...defaultProps} terminalRunning />)
    expect(terminalButton()).toBeNull()
  })

  it('renders with the shared icon-button classes and aria-label when running', () => {
    const { container } = render(
      <Composer {...defaultProps} onOpenTerminal={noop} terminalRunning />,
    )
    const button = terminalButton()
    expect(button).not.toBeNull()
    expect(button!.className).toBe('btn btn-icon composer-terminal')
    expect(container.querySelector('.composer-bar')!.contains(button!)).toBe(true)
  })

  it('sits immediately right of the Tasks button in the composer bar', () => {
    const { container } = render(
      <Composer {...defaultProps} onOpenTasks={noop} onOpenTerminal={noop} terminalRunning />,
    )
    const bar = container.querySelector('.composer-bar')!
    const buttons = Array.from(bar.querySelectorAll('button'))
    const tasksIdx = buttons.findIndex((b) => b.classList.contains('composer-tasks'))
    const terminalIdx = buttons.findIndex((b) => b.classList.contains('composer-terminal'))
    expect(tasksIdx).toBeGreaterThanOrEqual(0)
    expect(terminalIdx).toBe(tasksIdx + 1)
  })

  it('calls onOpenTerminal on click (and not the Tasks handler)', () => {
    const onOpenTerminal = vi.fn()
    const onOpenTasks = vi.fn()
    render(
      <Composer
        {...defaultProps}
        onOpenTasks={onOpenTasks}
        onOpenTerminal={onOpenTerminal}
        terminalRunning
      />,
    )
    fireEvent.click(terminalButton()!)
    expect(onOpenTerminal).toHaveBeenCalledOnce()
    expect(onOpenTasks).not.toHaveBeenCalled()
  })

  it('disappears when the terminal stops running', () => {
    const { rerender } = render(
      <Composer {...defaultProps} onOpenTerminal={noop} terminalRunning />,
    )
    expect(terminalButton()).not.toBeNull()
    rerender(
      <ToastProvider>
        <Composer {...defaultProps} onOpenTerminal={noop} terminalRunning={false} />
      </ToastProvider>,
    )
    expect(terminalButton()).toBeNull()
  })

  it('carries the running-terminal hover hint', () => {
    render(<Composer {...defaultProps} onOpenTerminal={noop} terminalRunning />)
    // HoverPopover surfaces a string label as aria-description before the
    // visual dwell — the same label the popover renders on hover.
    expect(terminalButton()!.getAttribute('aria-description')).toBe(
      'Terminal running — click to open',
    )
  })

  it('shows the hint popover after the hover dwell', () => {
    vi.useFakeTimers()
    try {
      render(<Composer {...defaultProps} onOpenTerminal={noop} terminalRunning />)
      fireEvent.pointerEnter(terminalButton()!)
      act(() => { vi.advanceTimersByTime(250) })
      expect(screen.getByText('Terminal running — click to open')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })
})
