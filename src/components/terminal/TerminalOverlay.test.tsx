// TerminalOverlay — keep-alive overlay chrome + the lazy xterm body (Task 10).
//
// xterm is MOCKED at the module seam (the lazy TerminalBody's import), so these
// tests drive the real TerminalBody logic (onData → input, snapshot screen
// rewrite, fit stand-down, theme read) against a recording Terminal double.
// The body loads through React.lazy, so every assertion that needs it awaits
// the mock instance first.
//
// Covers the brief's cases (b)–(h) plus the Task-6 restored-history carry:
//   (b) open → body mounted; close → body STILL mounted, channel subscribed,
//       xterm never remounts (constructor once, no dispose) across open/close.
//   (c) Esc focused → input('\x1b'), overlay stays, global bubble handler beaten.
//   (d) exited → exitCode banner + Restart → create.
//   (e) supported=false → unavailable panel, xterm never instantiated.
//   (f) permission modal over focused terminal → modal wins Esc (registry).
//   (g) IME onData forwards exactly once; composing Esc is ignored.
//   (h) restored-idle, no binding → history + "New terminal", no auto-create.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { TerminalChannel } from '../../hooks/useTerminalChannel'
import type { TerminalSnapshot, TerminalState } from '../../../shared/terminal.js'
import { __resetFloatingSurfacesForTests, getEscapeStackCount } from '../../hooks/floating-surface-registry'
import { clearResizeObserverStub, fireResize, stubResizeObserver } from '../../test/resize-observer-stub'
import { TerminalOverlay } from './TerminalOverlay'

// ── xterm double ──────────────────────────────────────────────────────
const xterm = vi.hoisted(() => {
  const instances: MockTerminal[] = []
  class MockTerminal {
    static instances = instances
    options: Record<string, unknown>
    cols = 80
    rows = 24
    written: string[] = []
    disposed = false
    focusCount = 0
    resetCount = 0
    openedInto: HTMLElement | null = null
    handlers: { data?: (d: string) => void; resize?: (size: { cols: number; rows: number }) => void } = {}
    constructor(opts: Record<string, unknown> = {}) {
      this.options = { ...opts }
      instances.push(this)
    }
    loadAddon(addon: { activate?: (t: MockTerminal) => void }) {
      addon.activate?.(this)
    }
    open(el: HTMLElement) {
      this.openedInto = el
      // Real xterm opens a focusable textarea inside the container; make the
      // container focusable so focus() can move DOM focus into it (the timing
      // the escape focus-containment gate depends on).
      el.tabIndex = -1
    }
    write(data: string) {
      this.written.push(data)
    }
    reset() {
      this.resetCount += 1
      this.written = []
    }
    clear() {}
    resize(cols: number, rows: number) {
      this.cols = cols
      this.rows = rows
      this.handlers.resize?.({ cols, rows })
    }
    focus() {
      this.focusCount += 1
      // Faithfully move DOM focus inside the container, like xterm focusing its
      // textarea. This fires a real focusin from the child reveal effect — the
      // event the parent's focus-containment listeners must observe.
      this.openedInto?.focus()
    }
    blur() {}
    dispose() {
      this.disposed = true
    }
    onData(cb: (d: string) => void) {
      this.handlers.data = cb
      return { dispose() {} }
    }
    onResize(cb: (s: { cols: number; rows: number }) => void) {
      this.handlers.resize = cb
      return { dispose() {} }
    }
    onSelectionChange() {
      return { dispose() {} }
    }
    scrollToBottom() {}
  }
  class MockFitAddon {
    fitCount = 0
    term: MockTerminal | null = null
    activate(term: MockTerminal) {
      this.term = term
    }
    fit() {
      this.fitCount += 1
      const d = this.proposeDimensions()
      if (d && this.term) this.term.resize(d.cols, d.rows)
    }
    proposeDimensions() {
      return { cols: 100, rows: 30 }
    }
    dispose() {}
  }
  return { instances, MockTerminal, MockFitAddon }
})

vi.mock('@xterm/xterm', () => ({ Terminal: xterm.MockTerminal }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: xterm.MockFitAddon }))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

// ── mock channel ──────────────────────────────────────────────────────
function state(over: Partial<TerminalState> = {}): TerminalState {
  return { status: 'running', shell: 'pwsh', cwd: 'D:\\repo', cols: 80, rows: 24, ...over }
}
function snapshot(over: Partial<TerminalSnapshot> = {}): TerminalSnapshot {
  return { terminalId: 'gen-1', seq: 1, screen: 'hello screen', state: state(), restored: false, ...over }
}

interface MockChannel {
  channel: TerminalChannel
  input: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  subscribeOutput: ReturnType<typeof vi.fn>
  subscribeAnchor: ReturnType<typeof vi.fn>
  unsubscribes: Array<ReturnType<typeof vi.fn>>
  emitOutput: (data: string) => void
  emitAnchor: (snap: TerminalSnapshot) => void
}

function makeChannel(
  opts: { supported?: boolean; state?: TerminalState | null; snapshot?: TerminalSnapshot | null; error?: string | null } = {},
): MockChannel {
  const listeners = new Set<(d: string) => void>()
  const anchorListeners = new Set<(s: TerminalSnapshot) => void>()
  const unsubscribes: Array<ReturnType<typeof vi.fn>> = []
  const subscribeOutput = vi.fn((cb: (d: string) => void) => {
    listeners.add(cb)
    const off = vi.fn(() => {
      listeners.delete(cb)
    })
    unsubscribes.push(off)
    return off
  })
  // Mirrors the real hook: registration seeds the callback synchronously
  // with the latest anchor, later anchors dispatch synchronously.
  const subscribeAnchor = vi.fn((cb: (s: TerminalSnapshot) => void) => {
    anchorListeners.add(cb)
    const seed = opts.snapshot === undefined ? snapshot() : opts.snapshot
    if (seed) cb(seed)
    const off = vi.fn(() => {
      anchorListeners.delete(cb)
    })
    unsubscribes.push(off)
    return off
  })
  const input = vi.fn()
  const create = vi.fn()
  const resize = vi.fn()
  const close = vi.fn()
  const channel: TerminalChannel = {
    supported: opts.supported ?? true,
    state: opts.state ?? state(),
    snapshot: opts.snapshot ?? snapshot(),
    error: opts.error ?? null,
    subscribeOutput,
    subscribeAnchor,
    input,
    create,
    resize,
    close,
  }
  return {
    channel,
    input,
    create,
    resize,
    close,
    subscribeOutput,
    subscribeAnchor,
    unsubscribes,
    emitOutput: (d) => {
      for (const cb of listeners) cb(d)
    },
    emitAnchor: (s) => {
      for (const cb of anchorListeners) cb(s)
    },
  }
}

const lastTerm = () => xterm.instances[xterm.instances.length - 1]

async function renderOverlay(
  opts: {
    open?: boolean
    supported?: boolean
    channel?: MockChannel
    onClose?: () => void
  } = {},
) {
  const mock = opts.channel ?? makeChannel({ supported: opts.supported ?? true })
  const onClose = opts.onClose ?? vi.fn()
  const view = render(
    <TerminalOverlay
      sessionId="s1"
      open={opts.open ?? true}
      onClose={onClose}
      supported={opts.supported ?? true}
      channel={mock.channel}
    />,
  )
  return { mock, onClose, view }
}

/** Wait for the lazy body to instantiate xterm (or resolve immediately when
 *  supported=false and no body is expected). */
async function waitForBody() {
  await waitFor(() => expect(xterm.instances.length).toBeGreaterThan(0))
  await waitFor(() => expect(document.querySelector('.terminal-body')).toBeTruthy())
}

beforeEach(() => {
  xterm.instances.length = 0
  stubResizeObserver()
  // Theme vars the body reads; tests assert the read mechanism against these.
  const root = document.documentElement
  root.style.setProperty('--term-bg', '#101014')
  root.style.setProperty('--term-fg', '#e8e8ea')
  root.style.setProperty('--term-cursor', '#7b8cde')
})

afterEach(() => {
  clearResizeObserverStub()
  __resetFloatingSurfacesForTests()
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.style.cssText = ''
})

describe('TerminalOverlay — keep-alive body (case b)', () => {
  it('mounts the body on open and keeps it mounted + subscribed across close/reopen without remounting xterm', async () => {
    const { mock, view } = await renderOverlay({ open: true })
    await waitForBody()
    expect(xterm.instances).toHaveLength(1)
    const term = lastTerm()
    expect(mock.subscribeOutput).toHaveBeenCalledTimes(1)
    const bodyEl = document.querySelector('.terminal-body')

    // Close: the body stays in the DOM (container hidden), xterm not disposed,
    // the output subscription not torn down.
    view.rerender(
      <TerminalOverlay sessionId="s1" open={false} onClose={vi.fn()} supported channel={mock.channel} />,
    )
    await waitFor(() => expect(document.querySelector('.terminal-overlay')?.className).toContain('hidden'))
    expect(document.querySelector('.terminal-body')).toBe(bodyEl)
    expect(term.disposed).toBe(false)
    expect(mock.unsubscribes.every((u) => !u.mock.calls.length)).toBe(true)

    // Reopen: still the SAME xterm instance and the SAME body element.
    view.rerender(<TerminalOverlay sessionId="s1" open onClose={vi.fn()} supported channel={mock.channel} />)
    await waitFor(() =>
      expect(document.querySelector('.terminal-overlay')?.className).not.toContain('hidden'),
    )
    expect(xterm.instances).toHaveLength(1)
    expect(document.querySelector('.terminal-body')).toBe(bodyEl)
    expect(term.disposed).toBe(false)
  })

  it('live output reaches xterm.write while the overlay is hidden (keep-alive)', async () => {
    const { mock, view } = await renderOverlay({ open: true })
    await waitForBody()
    const term = lastTerm()
    view.rerender(
      <TerminalOverlay sessionId="s1" open={false} onClose={vi.fn()} supported channel={mock.channel} />,
    )
    mock.emitOutput('background chunk')
    expect(term.written).toContain('background chunk')
  })
})

describe('TerminalOverlay — escape region (case c)', () => {
  it('Esc with the terminal focused forwards \\x1b, keeps the overlay open, and beats the global bubble handler', async () => {
    const { mock, onClose } = await renderOverlay({ open: true })
    await waitForBody()
    const globalEscape = vi.fn()
    window.addEventListener('keydown', globalEscape)

    const body = document.querySelector('.terminal-body') as HTMLElement
    body.tabIndex = -1
    body.focus()
    // Focused → the terminal is Esc-capable (present in the stack).
    await waitFor(() => expect(getEscapeStackCount()).toBe(1))
    fireEvent.keyDown(body, { key: 'Escape' })

    expect(mock.input).toHaveBeenCalledWith('\x1b')
    expect(onClose).not.toHaveBeenCalled()
    expect(globalEscape).not.toHaveBeenCalled()
    window.removeEventListener('keydown', globalEscape)
  })

  it('Esc with focus OUTSIDE the terminal falls through to the global handler (no stray ^[)', async () => {
    const { mock, onClose } = await renderOverlay({ open: true })
    await waitForBody()

    // Focus a SIBLING panel's composer. The trap's focusEscapeSelector
    // ('.chat-panel') releases focus there — exactly like clicking panel B's
    // composer while panel A's terminal stays open.
    const siblingPanel = document.createElement('div')
    siblingPanel.className = 'chat-panel'
    const composer = document.createElement('textarea')
    siblingPanel.appendChild(composer)
    document.body.appendChild(siblingPanel)
    composer.focus()

    // Unfocused → the terminal opts out of the Esc-capable set entirely, so the
    // registry's topmost-fallback cannot pick it for an Esc aimed elsewhere.
    await waitFor(() => expect(getEscapeStackCount()).toBe(0))

    const globalEscape = vi.fn()
    window.addEventListener('keydown', globalEscape)
    fireEvent.keyDown(composer, { key: 'Escape' })

    // No stray ^[ into panel A's shell, no close…
    expect(mock.input).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    // …and the key is NOT consumed by the terminal surface: it falls through to
    // the global interrupt handler (bubble-phase listener observes it).
    expect(globalEscape).toHaveBeenCalledTimes(1)
    window.removeEventListener('keydown', globalEscape)
    siblingPanel.remove()
  })

  it('close while unfocused then reopen → focus lands inside xterm and Esc routes to the PTY (stale-focusInside regression)', async () => {
    const { mock, onClose, view } = await renderOverlay({ open: true })
    await waitForBody()

    // Focus OUTSIDE the terminal (sibling composer) so focusInside is false…
    const siblingPanel = document.createElement('div')
    siblingPanel.className = 'chat-panel'
    const composer = document.createElement('textarea')
    siblingPanel.appendChild(composer)
    document.body.appendChild(siblingPanel)
    composer.focus()
    await waitFor(() => expect(getEscapeStackCount()).toBe(0))

    // …then close PROGRAMMATICALLY (no pointer re-guard) and reopen. The body's
    // reveal term.focus() (a child passive effect) moves focus back inside the
    // container before the parent could reinstall any torn-down listener.
    view.rerender(
      <TerminalOverlay sessionId="s1" open={false} onClose={onClose} supported channel={mock.channel} />,
    )
    composer.focus() // focus stays outside while closed
    view.rerender(<TerminalOverlay sessionId="s1" open onClose={onClose} supported channel={mock.channel} />)

    // Reopened with focus inside xterm → Esc-capable again (not stale false).
    await waitFor(() => expect(getEscapeStackCount()).toBe(1))
    const globalEscape = vi.fn()
    window.addEventListener('keydown', globalEscape)
    const body = document.querySelector('.terminal-body') as HTMLElement
    fireEvent.keyDown(body, { key: 'Escape' })

    expect(mock.input).toHaveBeenCalledWith('\x1b')
    expect(globalEscape).not.toHaveBeenCalled()
    window.removeEventListener('keydown', globalEscape)
    siblingPanel.remove()
  })
})

describe('TerminalOverlay — exited state (case d)', () => {
  it('renders the exit code and a Restart button that calls create', async () => {
    const mock = makeChannel({
      state: state({ status: 'exited', exitCode: 7 }),
      snapshot: snapshot({ state: state({ status: 'exited', exitCode: 7 }) }),
    })
    await renderOverlay({ open: true, channel: mock })
    await waitForBody()
    expect(screen.getByText(/7/)).toBeTruthy()
    const restart = screen.getByRole('button', { name: /restart/i })
    fireEvent.click(restart)
    expect(mock.create).toHaveBeenCalledTimes(1)
  })
})

describe('TerminalOverlay — idle create dimensions (E2E catch)', () => {
  it('a never-created slot (cols/rows 0) spawns at the 80x24 default, not 0x0', async () => {
    // The server's idle seed reports cols:0 rows:0 (WS-probe-verified). `??`
    // would ride the 0 into terminal-create and the server's bounds check
    // rejects it, leaving the slot idle forever — the "New terminal" button
    // was dead on a fresh session. `||` falls through to the default.
    const mock = makeChannel({
      state: state({ status: 'idle', cols: 0, rows: 0 }),
      snapshot: snapshot({ terminalId: '', seq: 0, screen: '', state: state({ status: 'idle', cols: 0, rows: 0 }) }),
    })
    await renderOverlay({ open: true, channel: mock })
    await waitForBody()
    fireEvent.click(screen.getByRole('button', { name: /new terminal/i }))
    expect(mock.create).toHaveBeenCalledTimes(1)
    expect(mock.create).toHaveBeenCalledWith(80, 24)
  })
})

describe('TerminalOverlay — unavailable (case e)', () => {
  it('supported=false renders the unavailable panel and never instantiates xterm', async () => {
    const mock = makeChannel({ supported: false, state: null, snapshot: null })
    await renderOverlay({ open: true, supported: false, channel: mock })
    // Give any (wrongly) triggered lazy import a chance to settle.
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.getByText(/unavailable/i)).toBeTruthy()
    expect(document.querySelector('.terminal-body')).toBeNull()
    expect(xterm.instances).toHaveLength(0)
  })
})

describe('TerminalOverlay — permission modal topmost (case f)', () => {
  it('a permission modal opened over the focused terminal wins Esc', async () => {
    const { mock } = await renderOverlay({ open: true })
    await waitForBody()
    const body = document.querySelector('.terminal-body') as HTMLElement
    body.tabIndex = -1
    body.focus()

    // A modal registered AFTER the terminal (topmost), with its own container.
    const modalEscape = vi.fn()
    const modalContainer = document.createElement('div')
    document.body.appendChild(modalContainer)
    const modalInput = document.createElement('input')
    modalContainer.appendChild(modalInput)
    const { registerFloatingSurface } = await import('../../hooks/floating-surface-registry')
    const unregister = registerFloatingSurface({
      id: 'perm-modal',
      kind: 'dialog',
      getContainer: () => modalContainer,
      onDismiss: () => {},
      onEscape: modalEscape,
    })
    modalInput.focus()
    fireEvent.keyDown(modalInput, { key: 'Escape' })

    expect(modalEscape).toHaveBeenCalledTimes(1)
    expect(mock.input).not.toHaveBeenCalledWith('\x1b')
    unregister()
    modalContainer.remove()
  })
})

describe('TerminalOverlay — IME composition (case g)', () => {
  it('forwards composed onData exactly once and ignores a composing Esc', async () => {
    const { mock } = await renderOverlay({ open: true })
    await waitForBody()
    const term = lastTerm()
    // xterm resolves the composition internally and emits onData once.
    term.handlers.data?.('你好')
    expect(mock.input).toHaveBeenCalledTimes(1)
    expect(mock.input).toHaveBeenCalledWith('你好')

    // An Esc pressed mid-composition must not reach the PTY (registry gate).
    const body = document.querySelector('.terminal-body') as HTMLElement
    fireEvent.keyDown(body, { key: 'Escape', isComposing: true })
    expect(mock.input).toHaveBeenCalledTimes(1)
  })
})

describe('TerminalOverlay — restored-idle fresh tab (case h)', () => {
  it('shows history + a New terminal affordance and does NOT auto-create', async () => {
    const mock = makeChannel({
      state: state({ status: 'idle' }),
      snapshot: snapshot({ state: state({ status: 'idle' }), restored: true, screen: 'persisted history' }),
    })
    await renderOverlay({ open: true, channel: mock })
    await waitForBody()
    const term = lastTerm()
    expect(term.written.join('')).toContain('persisted history')
    expect(mock.create).not.toHaveBeenCalled()
    const newTerm = screen.getByRole('button', { name: /new terminal/i })
    fireEvent.click(newTerm)
    expect(mock.create).toHaveBeenCalledTimes(1)
  })
})

describe('TerminalOverlay — restored-history indicator (Task 6 carry)', () => {
  it('shows a persistent header indicator while snapshot.restored, cleared by a fresh non-restored generation', async () => {
    const mock = makeChannel({ snapshot: snapshot({ restored: true }) })
    const { view } = await renderOverlay({ open: true, channel: mock })
    await waitForBody()
    expect(document.querySelector('.terminal-restored-badge')).toBeTruthy()

    // A fresh generation's snapshot (restored=false) clears the indicator.
    const fresh = makeChannel({ snapshot: snapshot({ terminalId: 'gen-2', restored: false }) })
    view.rerender(<TerminalOverlay sessionId="s1" open onClose={vi.fn()} supported channel={fresh.channel} />)
    await waitFor(() => expect(document.querySelector('.terminal-restored-badge')).toBeNull())
  })
})

describe('TerminalOverlay — body mechanics', () => {
  it('writes the snapshot screen on mount and rewrites it on every new anchor (resync)', async () => {
    const mock = makeChannel({ snapshot: snapshot({ screen: 'first screen' }) })
    await renderOverlay({ open: true, channel: mock })
    await waitForBody()
    const term = lastTerm()
    expect(term.written.join('')).toContain('first screen')

    // A resync answer dispatches through the SAME channel's anchor listeners
    // (the real hook's ref-backed set survives channel-object identity changes).
    mock.emitAnchor(snapshot({ terminalId: 'gen-1', seq: 9, screen: 'resynced screen' }))
    expect(term.written.join('')).toContain('resynced screen')
    expect(term.resetCount).toBeGreaterThan(0)
  })

  it('an output frame dispatched right after a new anchor survives (no passive-effect wipe)', async () => {
    const mock = makeChannel({ snapshot: snapshot({ screen: 'seed' }) })
    await renderOverlay({ open: true, channel: mock })
    await waitForBody()
    const term = lastTerm()
    // The I4 interleave: anchor dispatch, then an output frame BEFORE any
    // React commit. The anchor applies synchronously in dispatch order, so
    // the newer chunk is written after the seed and never wiped.
    mock.emitAnchor(snapshot({ seq: 5, screen: 're-anchored' }))
    mock.emitOutput('newer chunk')
    expect(term.written.join('')).toBe('re-anchorednewer chunk')
  })

  it('reads the xterm theme from computed CSS variables', async () => {
    await renderOverlay({ open: true })
    await waitForBody()
    const theme = lastTerm().options.theme as Record<string, string>
    expect(theme.background).toBe('#101014')
    expect(theme.foreground).toBe('#e8e8ea')
    expect(theme.cursor).toBe('#7b8cde')
  })

  it('suppresses fit while hidden (clientWidth 0) and refits on reveal', async () => {
    const { mock } = await renderOverlay({ open: true })
    await waitForBody()
    const body = document.querySelector('.terminal-body') as HTMLElement

    // Hidden: clientWidth 0 → fit stands down (no resize sent to the PTY).
    Object.defineProperty(body, 'clientWidth', { configurable: true, value: 0 })
    fireResize(body)
    expect(mock.resize).not.toHaveBeenCalled()

    // Reveal: a real width → fit runs, resizes xterm, onResize → channel.resize.
    Object.defineProperty(body, 'clientWidth', { configurable: true, value: 800 })
    Object.defineProperty(body, 'clientHeight', { configurable: true, value: 600 })
    fireResize(body)
    expect(mock.resize).toHaveBeenCalledWith(100, 30)
  })

  it('focuses xterm on open', async () => {
    await renderOverlay({ open: true })
    await waitForBody()
    expect(lastTerm().focusCount).toBeGreaterThan(0)
  })
})

describe('TerminalOverlay — kill affordance (C1)', () => {
  it('a running terminal shows the kill button; clicking it calls channel.close', async () => {
    const { mock } = await renderOverlay({ open: true })
    await waitForBody()
    const kill = screen.getByRole('button', { name: 'Kill terminal' })
    fireEvent.click(kill)
    expect(mock.close).toHaveBeenCalledTimes(1)
    // The hide-X is a separate control and was not clicked.
    expect(screen.getByRole('button', { name: 'Close terminal' })).toBeTruthy()
  })

  it('an exited generation keeps the kill button (retained screen to clear)', async () => {
    const mock = makeChannel({
      state: state({ status: 'exited', exitCode: 0 }),
      snapshot: snapshot({ state: state({ status: 'exited', exitCode: 0 }) }),
    })
    await renderOverlay({ open: true, channel: mock })
    await waitForBody()
    fireEvent.click(screen.getByRole('button', { name: 'Kill terminal' }))
    expect(mock.close).toHaveBeenCalledTimes(1)
  })

  it('restored-idle history keeps the kill button (close clears the history)', async () => {
    const mock = makeChannel({
      state: state({ status: 'idle' }),
      snapshot: snapshot({ terminalId: '', seq: 0, screen: 'history', restored: true, state: state({ status: 'idle' }) }),
    })
    await renderOverlay({ open: true, channel: mock })
    await waitForBody()
    expect(screen.getByRole('button', { name: 'Kill terminal' })).toBeTruthy()
  })

  it('a fresh idle slot (no terminal, no history) hides the kill button', async () => {
    const mock = makeChannel({
      state: state({ status: 'idle', cols: 0, rows: 0 }),
      snapshot: snapshot({ terminalId: '', seq: 0, screen: '', restored: false, state: state({ status: 'idle', cols: 0, rows: 0 }) }),
    })
    await renderOverlay({ open: true, channel: mock })
    await waitForBody()
    expect(screen.queryByRole('button', { name: 'Kill terminal' })).toBeNull()
    // The hide-X remains.
    expect(screen.getByRole('button', { name: 'Close terminal' })).toBeTruthy()
  })
})

describe('TerminalOverlay — terminal-local error notice (C2)', () => {
  it('renders channel.error as a transient status notice inside the overlay', async () => {
    const mock = makeChannel({ error: 'terminal-resize: terminal generation is not live' })
    await renderOverlay({ open: true, channel: mock })
    await waitForBody()
    const notice = document.querySelector('.terminal-error-notice')
    expect(notice).toBeTruthy()
    expect(notice!.textContent).toContain('terminal generation is not live')
    expect(notice!.getAttribute('role')).toBe('status')
  })

  it('no notice without an error', async () => {
    await renderOverlay({ open: true })
    await waitForBody()
    expect(document.querySelector('.terminal-error-notice')).toBeNull()
  })
})
