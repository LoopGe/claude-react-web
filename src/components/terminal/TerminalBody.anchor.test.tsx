// I4 repro: the screen anchor must apply SYNCHRONOUSLY in dispatch order.
//
// Drives the REAL useTerminalChannel hook (mock hub) into the REAL
// TerminalBody (mock xterm) — the passive-effect anchor this replaces raced
// React's commit: an output frame dispatched between the snapshot dispatch
// and the effect's commit was written to xterm and then wiped by the
// reset+write, while the channel's lastSeq had already advanced past it
// (silent chunk loss). One act() below batches exactly that interleave.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import type { WsHubListener } from '../../hooks/useWsHub'
import type { WsServerFrame } from '../../ws-types'
import type { TerminalSnapshot, TerminalState } from '../../../shared/terminal.js'
import { clearResizeObserverStub, stubResizeObserver } from '../../test/resize-observer-stub'

// ── xterm double (recording writes; reset wipes, like the real buffer) ──
const xterm = vi.hoisted(() => {
  const instances: MockTerminal[] = []
  class MockTerminal {
    static instances = instances
    options: Record<string, unknown>
    written: string[] = []
    resetCount = 0
    constructor(opts: Record<string, unknown> = {}) {
      this.options = { ...opts }
      instances.push(this)
    }
    loadAddon(_addon: unknown) {}
    open(_el: HTMLElement) {}
    write(data: string) {
      this.written.push(data)
    }
    reset() {
      this.resetCount += 1
      this.written = []
    }
    focus() {}
    dispose() {}
    onData(_cb: (d: string) => void) {
      return { dispose() {} }
    }
    onResize(_cb: (s: { cols: number; rows: number }) => void) {
      return { dispose() {} }
    }
  }
  class MockFitAddon {
    activate(_term: MockTerminal) {}
    fit() {}
    proposeDimensions() {
      return undefined
    }
    dispose() {}
  }
  return { instances, MockTerminal, MockFitAddon }
})

vi.mock('@xterm/xterm', () => ({ Terminal: xterm.MockTerminal }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: xterm.MockFitAddon }))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

// ── mock hub (same seam as useTerminalChannel.test.ts) ────────────────
const sessionListeners = new Map<string, Set<WsHubListener>>()
const hub = {
  addListener: () => () => {},
  addSessionListener: (sid: string, fn: WsHubListener) => {
    let s = sessionListeners.get(sid)
    if (!s) sessionListeners.set(sid, (s = new Set()))
    s.add(fn)
    return () => { s!.delete(fn) }
  },
  subscribe: () => () => {},
  subscribeSubagentTranscript: () => () => {},
  subscribeTerminal: () => () => {},
  send: vi.fn(),
}
vi.mock('../../hooks/useWsHub', () => ({
  useWsHub: () => hub,
  useWsHubStatus: () => 'online',
}))

// Import AFTER the mocks.
import { useTerminalChannel } from '../../hooks/useTerminalChannel'
import { TerminalBody } from './TerminalBody'

const SID = 's-anchor'
const termState = (over: Partial<TerminalState> = {}): TerminalState => ({
  status: 'running', shell: 'pwsh', cwd: '/tmp/project', cols: 80, rows: 24, ...over,
})
const snapshot = (over: Partial<TerminalSnapshot> = {}): TerminalSnapshot => ({
  terminalId: 'g1', seq: 0, screen: '', state: termState(), restored: false, ...over,
})
const emit = (frame: Record<string, unknown>) => {
  for (const fn of sessionListeners.get(SID) ?? []) {
    fn({ sessionId: SID, ...frame } as unknown as WsServerFrame)
  }
}

function Host({ mounted }: { mounted: boolean }) {
  const channel = useTerminalChannel(SID, true)
  return mounted ? <TerminalBody channel={channel} visible /> : null
}

beforeEach(() => {
  sessionListeners.clear()
  xterm.instances.length = 0
  stubResizeObserver()
  localStorage.clear()
})
afterEach(() => {
  clearResizeObserverStub()
})

describe('TerminalBody screen anchor (I4)', () => {
  it('an output frame between snapshot dispatch and commit is NOT wiped', async () => {
    const view = render(<Host mounted />)
    await act(async () => {}) // let the mount effect wire IO
    const term = xterm.instances[0]
    expect(term).toBeTruthy()

    // The interleave: snapshot dispatch, then a newer output frame BEFORE
    // React commits anything. The anchor listener applies the screen in
    // dispatch order, so the chunk lands after the seed and survives.
    act(() => {
      emit({ kind: 'terminal-snapshot', snapshot: snapshot({ seq: 2, screen: 'seed screen' }) })
      emit({ kind: 'terminal-output', terminalId: 'g1', seq: 3, data: 'newer chunk' })
    })
    expect(term.written.join('')).toBe('seed screennewer chunk')

    // A resync answer re-anchors the same way; later output still survives.
    act(() => {
      emit({ kind: 'terminal-snapshot', snapshot: snapshot({ seq: 7, screen: 're-anchored' }) })
      emit({ kind: 'terminal-output', terminalId: 'g1', seq: 8, data: 'after' })
    })
    expect(term.written.join('')).toBe('re-anchoredafter')
    view.unmount()
  })

  it('a body mounting after the snapshot dispatch seeds the current screen', async () => {
    const view = render(<Host mounted={false} />)
    await act(async () => {})
    act(() => {
      emit({ kind: 'terminal-snapshot', snapshot: snapshot({ seq: 4, screen: 'already seeded' }) })
    })
    expect(xterm.instances).toHaveLength(0)

    // Late mount: subscribeAnchor's immediate seed applies the latest anchor
    // synchronously — no stale committed-state read, no passive-effect wait.
    view.rerender(<Host mounted />)
    await act(async () => {})
    const term = xterm.instances[0]
    expect(term.written.join('')).toBe('already seeded')

    act(() => { emit({ kind: 'terminal-output', terminalId: 'g1', seq: 5, data: 'live' }) })
    expect(term.written.join('')).toBe('already seededlive')
    view.unmount()
  })

  it('an idle state frame clears the screen through the anchor (close/dispose)', async () => {
    const view = render(<Host mounted />)
    await act(async () => {})
    const term = xterm.instances[0]
    act(() => {
      emit({ kind: 'terminal-snapshot', snapshot: snapshot({ seq: 2, screen: 'history', restored: true }) })
    })
    expect(term.written.join('')).toBe('history')
    act(() => {
      emit({ kind: 'terminal-state', terminalId: '', state: termState({ status: 'idle', cols: 0, rows: 0 }) })
    })
    expect(term.written.join('')).toBe('')
    expect(term.resetCount).toBeGreaterThan(0)
    view.unmount()
  })
})