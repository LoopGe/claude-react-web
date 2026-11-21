// useTerminalChannel — per-session terminal channel over the WS hub.
//
// The hub is mocked at the module seam (same pattern as
// useSubagentTranscriptStore.test.tsx): a real session-listener registry the
// test feeds frames into, plus spies on subscribeTerminal / send. Render
// isolation is asserted with a host render counter, mirroring
// streaming-render-isolation.test.tsx: output churn must never re-render the
// hook's host, while state/snapshot transitions may.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { Mock } from 'vitest'
import type { WsHubListener } from './useWsHub'
import type { WsServerFrame } from '../ws-types'
import type { TerminalSnapshot, TerminalState } from '../../shared/terminal.js'
import { terminalBindingKey } from '../constants/storageKeys'

// ── Mock hub ────────────────────────────────────────────────────────
// The hub object is referentially STABLE, matching the real hub's contract
// (pinned by useWsHub.test.tsx's "keeps the hub api referentially stable"
// test): consumers key their channel effects on [hub], so a per-render
// object would tear the channel down on every state transition.
const sessionListeners = new Map<string, Set<WsHubListener>>()
const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  // Each holder gets its own release spy, so ref-count assertions can tell
  // the disposers apart via mock.results.
  subscribeTerminal: vi.fn((): Mock => vi.fn()),
}))
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
  subscribeTerminal: mocks.subscribeTerminal,
  send: mocks.send,
}
vi.mock('./useWsHub', () => ({
  useWsHub: () => hub,
  useWsHubStatus: () => 'online',
}))

// Import AFTER the mock.
import { useTerminalChannel } from './useTerminalChannel'

// ── Fixtures ────────────────────────────────────────────────────────
const SID = 's-term'
const KEY = terminalBindingKey(SID)

const termState = (over: Partial<TerminalState> = {}): TerminalState => ({
  status: 'running', shell: 'pwsh', cwd: '/tmp/project', cols: 80, rows: 24, ...over,
})
const snapshot = (over: Partial<TerminalSnapshot> = {}): TerminalSnapshot => ({
  terminalId: 'g1', seq: 0, screen: '', state: termState(), restored: false, ...over,
})
const emitFor = (sid: string, frame: Record<string, unknown>) => {
  for (const fn of sessionListeners.get(sid) ?? []) {
    fn({ sessionId: sid, ...frame } as unknown as WsServerFrame)
  }
}
const emit = (frame: Record<string, unknown>) => emitFor(SID, frame)
const sentOf = (kind: string): Array<Record<string, unknown>> =>
  mocks.send.mock.calls.map((c) => c[0] as Record<string, unknown>).filter((f) => f.kind === kind)
const releaseOf = (i: number): Mock => mocks.subscribeTerminal.mock.results[i].value as Mock

beforeEach(() => {
  sessionListeners.clear()
  mocks.send.mockClear()
  mocks.subscribeTerminal.mockClear()
  localStorage.clear()
})

describe('useTerminalChannel: subscription lifecycle', () => {
  it('(a) subscribes on mount and releases on unmount; two holders each hold a ref', () => {
    const h1 = renderHook(() => useTerminalChannel(SID, true))
    expect(mocks.subscribeTerminal).toHaveBeenCalledTimes(1)
    expect(mocks.subscribeTerminal).toHaveBeenCalledWith(SID)
    expect(sessionListeners.get(SID)?.size).toBe(1)

    const h2 = renderHook(() => useTerminalChannel(SID, true))
    expect(mocks.subscribeTerminal).toHaveBeenCalledTimes(2)

    h1.unmount()
    expect(releaseOf(0)).toHaveBeenCalledTimes(1)
    expect(releaseOf(1)).not.toHaveBeenCalled()
    h2.unmount()
    expect(releaseOf(1)).toHaveBeenCalledTimes(1)
    expect(sessionListeners.get(SID)?.size ?? 0).toBe(0)
  })

  it('a sessionId switch resets visible state and ignores late frames from the old session', () => {
    const { result, rerender } = renderHook(({ sid }) => useTerminalChannel(sid, true), {
      initialProps: { sid: 's1' },
    })
    const oldListener = [...(sessionListeners.get('s1') ?? [])][0]
    act(() => { oldListener({ sessionId: 's1', kind: 'terminal-snapshot', snapshot: snapshot() } as unknown as WsServerFrame) })
    expect(result.current.state?.status).toBe('running')

    rerender({ sid: 's2' })
    expect(result.current.state).toBeNull()
    expect(result.current.snapshot).toBeNull()
    expect(mocks.subscribeTerminal).toHaveBeenLastCalledWith('s2')
    expect(releaseOf(0)).toHaveBeenCalledTimes(1)

    // A late s1 frame (dispatched between the prop change and the effect
    // cleanup) must not write into s2's visible data.
    act(() => { oldListener({ sessionId: 's1', kind: 'terminal-state', terminalId: 'g1', state: termState({ status: 'exited', exitCode: 9 }) } as unknown as WsServerFrame) })
    expect(result.current.state).toBeNull()

    // s2's own frames flow normally.
    act(() => { emitFor('s2', { kind: 'terminal-snapshot', snapshot: snapshot({ terminalId: 'g9' }) }) })
    expect(result.current.snapshot?.terminalId).toBe('g9')
  })

  it('an unsupported session never subscribes and reports supported:false', () => {
    const { result } = renderHook(() => useTerminalChannel(SID, false))
    expect(mocks.subscribeTerminal).not.toHaveBeenCalled()
    expect(result.current.supported).toBe(false)
    expect(result.current.state).toBeNull()
    expect(result.current.snapshot).toBeNull()
  })
})

describe('useTerminalChannel: snapshot + output render isolation', () => {
  it('(b) snapshot sets state + snapshot; output reaches listeners with ZERO host re-renders', () => {
    let renders = 0
    const { result } = renderHook(() => { renders++; return useTerminalChannel(SID, true) })
    act(() => { emit({ kind: 'terminal-snapshot', snapshot: snapshot({ seq: 2, screen: 'seed screen' }) }) })
    expect(result.current.state).toEqual(termState())
    expect(result.current.snapshot).toEqual(snapshot({ seq: 2, screen: 'seed screen' }))

    const got: string[] = []
    act(() => { result.current.subscribeOutput((d) => got.push(d)) })
    renders = 0
    act(() => {
      for (let seq = 3; seq <= 12; seq++) {
        emit({ kind: 'terminal-output', terminalId: 'g1', seq, data: `chunk${seq}` })
      }
      // Non-terminal session frames are ignored, not crashed on.
      emit({ kind: 'message', message: { type: 'assistant' } })
    })
    expect(renders).toBe(0)
    expect(got).toEqual(Array.from({ length: 10 }, (_, i) => `chunk${i + 3}`))

    // A state transition IS allowed to re-render the host.
    act(() => { emit({ kind: 'terminal-state', terminalId: 'g1', state: termState({ status: 'exited', exitCode: 0 }) }) })
    expect(renders).toBeGreaterThan(0)
  })

  it('subscribeOutput returns a disposer that stops delivery', () => {
    const { result } = renderHook(() => useTerminalChannel(SID, true))
    act(() => { emit({ kind: 'terminal-snapshot', snapshot: snapshot() }) })
    const got: string[] = []
    let off: () => void = () => {}
    act(() => { off = result.current.subscribeOutput((d) => got.push(d)) })
    act(() => { emit({ kind: 'terminal-output', terminalId: 'g1', seq: 1, data: 'a' }) })
    act(() => { off() })
    act(() => { emit({ kind: 'terminal-output', terminalId: 'g1', seq: 2, data: 'b' }) })
    expect(got).toEqual(['a'])
  })

  it('(carry 1) output at or below the seeded snapshot seq is deduped (divider renders once)', () => {
    const { result } = renderHook(() => useTerminalChannel(SID, true))
    const got: string[] = []
    act(() => { result.current.subscribeOutput((d) => got.push(d)) })
    // The create answer: snapshot at seq 1 whose screen ALREADY contains the
    // divider, then the divider fanned out again as output seq 1.
    act(() => { emit({ kind: 'terminal-snapshot', snapshot: snapshot({ seq: 1, screen: 'history + divider' }) }) })
    act(() => { emit({ kind: 'terminal-output', terminalId: 'g1', seq: 1, data: 'divider' }) })
    expect(got).toEqual([])
    act(() => { emit({ kind: 'terminal-output', terminalId: 'g1', seq: 2, data: 'next' }) })
    expect(got).toEqual(['next'])
    expect(sentOf('terminal-resync')).toHaveLength(0)
  })
})

describe('useTerminalChannel: seq gap recovery', () => {
  it('(c) a seq gap sends terminal-resync exactly once per episode; the answer re-arms', () => {
    const { result } = renderHook(() => useTerminalChannel(SID, true))
    const got: string[] = []
    act(() => { result.current.subscribeOutput((d) => got.push(d)) })
    act(() => { emit({ kind: 'terminal-snapshot', snapshot: snapshot({ seq: 2 }) }) })

    act(() => { emit({ kind: 'terminal-output', terminalId: 'g1', seq: 5, data: 'gap' }) })
    expect(sentOf('terminal-resync')).toEqual([{ kind: 'terminal-resync', sessionId: SID, terminalId: 'g1' }])
    // More gap frames while the resync is unanswered: no second request, no
    // out-of-order delivery.
    act(() => {
      emit({ kind: 'terminal-output', terminalId: 'g1', seq: 6, data: 'x' })
      emit({ kind: 'terminal-output', terminalId: 'g1', seq: 7, data: 'y' })
    })
    expect(sentOf('terminal-resync')).toHaveLength(1)
    expect(got).toEqual([])

    // The resync answer re-anchors screen + seq.
    act(() => { emit({ kind: 'terminal-snapshot', snapshot: snapshot({ seq: 7, screen: 're-anchored' }) }) })
    expect(result.current.snapshot?.screen).toBe('re-anchored')
    act(() => { emit({ kind: 'terminal-output', terminalId: 'g1', seq: 8, data: 'after' }) })
    expect(got).toEqual(['after'])

    // A NEW gap is a new episode: one more resync, not zero.
    act(() => { emit({ kind: 'terminal-output', terminalId: 'g1', seq: 10, data: 'gap2' }) })
    expect(sentOf('terminal-resync')).toHaveLength(2)
  })
})

describe('useTerminalChannel: state transitions', () => {
  it('(d) state frames update state; idle clears the generation and the binding', () => {
    const { result } = renderHook(() => useTerminalChannel(SID, true))
    act(() => { emit({ kind: 'terminal-snapshot', snapshot: snapshot() }) })
    expect(localStorage.getItem(KEY)).toBe('g1')

    act(() => { emit({ kind: 'terminal-state', terminalId: 'g1', state: termState({ status: 'exited', exitCode: 3 }) }) })
    expect(result.current.state).toEqual(termState({ status: 'exited', exitCode: 3 }))
    // Natural exit keeps the association (restart is manual; a later server
    // restart restores exited history with no auto-create anyway).
    expect(localStorage.getItem(KEY)).toBe('g1')

    act(() => { emit({ kind: 'terminal-state', terminalId: '', state: termState({ status: 'idle', cols: 0, rows: 0 }) }) })
    expect(result.current.state?.status).toBe('idle')
    expect(localStorage.getItem(KEY)).toBeNull()

    // After the idle clear, stale output from the dead generation is dropped.
    const got: string[] = []
    act(() => { result.current.subscribeOutput((d) => got.push(d)) })
    act(() => { emit({ kind: 'terminal-output', terminalId: 'g1', seq: 99, data: 'stale' }) })
    expect(got).toEqual([])
  })
})

describe('useTerminalChannel: binding memory + restart auto-create', () => {
  it('the binding key is the literal cross-task contract shape', () => {
    expect(terminalBindingKey('s-term')).toBe('crw.terminal.binding.s-term')
  })

  it('(e) a running snapshot stores the binding; a restored-idle snapshot auto-creates ONCE', () => {
    const { rerender } = renderHook(() => useTerminalChannel(SID, true))
    act(() => { emit({ kind: 'terminal-snapshot', snapshot: snapshot() }) })
    expect(localStorage.getItem(KEY)).toBe('g1')
    expect(sentOf('terminal-create')).toHaveLength(0)

    // Server restart: the remembered tab's re-subscribe is answered with the
    // persisted screen, idle, restored.
    act(() => {
      emit({
        kind: 'terminal-snapshot',
        snapshot: snapshot({ terminalId: '', seq: 0, screen: 'history', restored: true, state: termState({ status: 'idle', cols: 100, rows: 30 }) }),
      })
    })
    expect(sentOf('terminal-create')).toEqual([
      { kind: 'terminal-create', sessionId: SID, cols: 100, rows: 30 },
    ])

    // Re-renders without a new snapshot do not re-fire.
    rerender()
    rerender()
    expect(sentOf('terminal-create')).toHaveLength(1)

    // The create answer (running, fresh generation) rewrites the binding.
    act(() => { emit({ kind: 'terminal-snapshot', snapshot: snapshot({ terminalId: 'g2', seq: 1, screen: 'history + divider', restored: true }) }) })
    expect(localStorage.getItem(KEY)).toBe('g2')
    expect(sentOf('terminal-create')).toHaveLength(1)
  })

  it('(e) without a stored binding a restored-idle snapshot does NOT auto-create', () => {
    renderHook(() => useTerminalChannel(SID, true))
    act(() => {
      emit({
        kind: 'terminal-snapshot',
        snapshot: snapshot({ terminalId: '', seq: 0, screen: 'history', restored: true, state: termState({ status: 'idle' }) }),
      })
    })
    expect(sentOf('terminal-create')).toHaveLength(0)
  })

  it('a running STATE frame also stores the binding (spawn seen without a snapshot)', () => {
    renderHook(() => useTerminalChannel(SID, true))
    act(() => { emit({ kind: 'terminal-state', terminalId: 'g7', state: termState() }) })
    expect(localStorage.getItem(KEY)).toBe('g7')
  })

  it('(f) close sends terminal-close and clears the binding', () => {
    const { result } = renderHook(() => useTerminalChannel(SID, true))
    act(() => { emit({ kind: 'terminal-snapshot', snapshot: snapshot() }) })
    expect(localStorage.getItem(KEY)).toBe('g1')
    act(() => { result.current.close() })
    expect(sentOf('terminal-close')).toEqual([{ kind: 'terminal-close', sessionId: SID }])
    expect(localStorage.getItem(KEY)).toBeNull()
  })
})

describe('useTerminalChannel: generation anchoring', () => {
  it('(carry 2) the first frame may be live output — no snapshot, no deadlock', () => {
    const { result } = renderHook(() => useTerminalChannel(SID, true))
    const got: string[] = []
    act(() => { result.current.subscribeOutput((d) => got.push(d)) })
    // No snapshot ever arrives (manager seed theoretically null): the first
    // output frame anchors the generation and flows.
    act(() => { emit({ kind: 'terminal-output', terminalId: 'g1', seq: 1, data: 'hello' }) })
    act(() => { emit({ kind: 'terminal-output', terminalId: 'g1', seq: 2, data: 'world' }) })
    expect(got).toEqual(['hello', 'world'])
    expect(sentOf('terminal-resync')).toHaveLength(0)

    // Control ops fence on the adopted generation.
    act(() => { result.current.input('ls\r') })
    expect(sentOf('terminal-input')).toEqual([
      { kind: 'terminal-input', sessionId: SID, terminalId: 'g1', data: 'ls\r' },
    ])
  })

  it('another tab\'s spawn re-anchors via ONE resync; the divider is not lost', () => {
    const { result } = renderHook(() => useTerminalChannel(SID, true))
    const got: string[] = []
    act(() => { result.current.subscribeOutput((d) => got.push(d)) })
    // We sit on a restored-idle seed (no binding here — fresh tab).
    act(() => {
      emit({
        kind: 'terminal-snapshot',
        snapshot: snapshot({ terminalId: '', seq: 0, screen: 'history', restored: true, state: termState({ status: 'idle' }) }),
      })
    })
    // Another tab creates: the divider chunk (new generation, seq 1) arrives
    // BEFORE the running state frame. Our idle anchor cannot apply it — the
    // snapshot re-anchor carries it instead.
    act(() => { emit({ kind: 'terminal-output', terminalId: 'g2', seq: 1, data: 'divider chunk' }) })
    expect(sentOf('terminal-resync')).toEqual([{ kind: 'terminal-resync', sessionId: SID, terminalId: 'g2' }])
    act(() => { emit({ kind: 'terminal-state', terminalId: 'g2', state: termState() }) })
    expect(sentOf('terminal-resync')).toHaveLength(1)
    expect(result.current.state?.status).toBe('running')
    expect(localStorage.getItem(KEY)).toBe('g2')

    act(() => { emit({ kind: 'terminal-snapshot', snapshot: snapshot({ terminalId: 'g2', seq: 1, screen: 'history + divider' }) }) })
    expect(result.current.snapshot?.screen).toBe('history + divider')
    act(() => { emit({ kind: 'terminal-output', terminalId: 'g2', seq: 2, data: 'fresh' }) })
    expect(got).toEqual(['fresh'])
  })
})

describe('useTerminalChannel: control frames', () => {
  it('create / input / resize send well-formed frames fenced on the live generation', () => {
    const { result } = renderHook(() => useTerminalChannel(SID, true))
    act(() => { emit({ kind: 'terminal-snapshot', snapshot: snapshot() }) })
    act(() => {
      result.current.create(90, 25)
      result.current.input('echo hi\r')
      result.current.resize(120, 40)
    })
    expect(sentOf('terminal-create')).toEqual([{ kind: 'terminal-create', sessionId: SID, cols: 90, rows: 25 }])
    expect(sentOf('terminal-input')).toEqual([{ kind: 'terminal-input', sessionId: SID, terminalId: 'g1', data: 'echo hi\r' }])
    expect(sentOf('terminal-resize')).toEqual([{ kind: 'terminal-resize', sessionId: SID, terminalId: 'g1', cols: 120, rows: 40 }])
  })
})
