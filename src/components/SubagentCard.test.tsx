import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SubagentCard } from './SubagentCard'
import { SubagentProvider, type SubagentContextValue } from '../hooks/useSubagentContext'
import type { ActiveSubagent, SubagentChildCall } from '../session-store/types'

// AnimatedDetails wraps AnimatedCollapse, which uses ResizeObserver +
// matchMedia; jsdom lacks both. Provide minimal stubs so the details
// content renders synchronously.
beforeAll(() => {
  if (!('ResizeObserver' in window)) {
    // @ts-expect-error test stub
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }
  if (!window.matchMedia) {
    // @ts-expect-error test stub
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  }
})

afterEach(cleanup)

const child = (over: Partial<SubagentChildCall> & { toolUseId: string; toolName: string }): SubagentChildCall => ({
  argSummary: '',
  status: 'success',
  ...over,
})

function renderCard(record: ActiveSubagent) {
  const ctx: SubagentContextValue = {
    index: new Map([[record.toolUseId, record]]),
    messages: [],
    open: vi.fn(),
  }
  render(
    <SubagentProvider value={ctx}>
      <SubagentCard toolUseId={record.toolUseId} />
    </SubagentProvider>,
  )
  return ctx
}

const base = (over: Partial<ActiveSubagent> = {}): ActiveSubagent => ({
  toolUseId: 'tu_sa',
  label: 'analyze auth',
  status: 'running',
  toolCount: 0,
  ...over,
})

describe('SubagentCard child-call list', () => {
  it('renders a row per child tool call with its name + arg summary', () => {
    renderCard(base({
      status: 'done',
      childToolCalls: [
        child({ toolUseId: 'c1', toolName: 'Bash', argSummary: 'ls server/auth' }),
        child({ toolUseId: 'c2', toolName: 'Read', argSummary: 'middleware.ts' }),
      ],
    }))
    expect(screen.getByText('Bash')).toBeTruthy()
    expect(screen.getByText('ls server/auth')).toBeTruthy()
    expect(screen.getByText('Read')).toBeTruthy()
    // Summary count reflects settled/total.
    expect(screen.getByText('2/2')).toBeTruthy()
  })

  it('renders running and settled calls as one list, in call order', () => {
    renderCard(base({
      status: 'running',
      childToolCalls: [
        child({ toolUseId: 'c1', toolName: 'Bash', argSummary: 'ls', status: 'success' }),
        child({ toolUseId: 'c2', toolName: 'Grep', argSummary: 'skipAuth', status: 'running' }),
      ],
    }))
    // Unified list: both are rows. The running one carries the pulse modifier
    // and an accent name tint (via .subagent-child-row-running); it is NOT
    // hoisted into a separate live-highlight block.
    const rowNames = Array.from(document.querySelectorAll('.subagent-child-name')).map((n) => n.textContent)
    expect(rowNames).toEqual(['Bash', 'Grep'])
    expect(document.querySelector('.subagent-child-row-running .subagent-child-name')?.textContent).toBe('Grep')
    expect(document.querySelector('.subagent-child-row-running .subagent-child-dot-pulse')).toBeTruthy()
    expect(document.querySelector('.subagent-child-row-success .subagent-child-name')?.textContent).toBe('Bash')
    expect(screen.getByText('1/2 · running')).toBeTruthy()
    // Each tool name appears once — no dual rendering of the running call.
    expect(screen.getAllByText('Grep')).toHaveLength(1)
  })

  it('expands a settled row to reveal its result', () => {
    renderCard(base({
      status: 'done',
      childToolCalls: [
        child({ toolUseId: 'c1', toolName: 'Bash', argSummary: 'ls', result: { content: 'RESULT_BODY_XYZ', isError: false } }),
      ],
    }))
    // Result hidden until the row is clicked.
    expect(screen.queryByText('RESULT_BODY_XYZ')).toBeNull()
    fireEvent.click(screen.getByText('Bash'))
    // ToolResultSection may render the body across preview + full nodes.
    expect(screen.getAllByText('RESULT_BODY_XYZ').length).toBeGreaterThan(0)
  })

  it('renders no child list when there are no child tool calls', () => {
    renderCard(base({ status: 'done', childToolCalls: [] }))
    expect(screen.queryByText(/tool calls?$/)).toBeNull()
  })

  it('auto-expands while the subagent is live and auto-collapses once it settles', () => {
    // The open/collapse wiring is the behaviour the user asked for ("运行时展开,
    // 完成后折叠"); asserting on rendered text alone passes either way, so check
    // the <details> state directly.
    const calls = [child({ toolUseId: 'c1', toolName: 'Bash', argSummary: 'ls', status: 'running' })]
    renderCard(base({ status: 'running', childToolCalls: calls }))
    expect(document.querySelector('details.subagent-children')?.getAttribute('data-state')).toBe('open')

    cleanup()
    renderCard(base({ status: 'done', childToolCalls: [child({ toolUseId: 'c1', toolName: 'Bash', argSummary: 'ls' })] }))
    expect(document.querySelector('details.subagent-children')?.getAttribute('data-state')).toBe('closed')
  })

  it('shows EVERY in-flight call as a row (parallel tool calls)', () => {
    // A subagent routinely emits several tool_use blocks in one frame. Each
    // gets its own row — none are collapsed into a single "current tool" line.
    renderCard(base({
      status: 'running',
      childToolCalls: [
        child({ toolUseId: 'c1', toolName: 'Bash', argSummary: 'ls', status: 'running' }),
        child({ toolUseId: 'c2', toolName: 'Read', argSummary: 'a.ts', status: 'running' }),
      ],
    }))
    const runningNames = Array.from(
      document.querySelectorAll('.subagent-child-row-running .subagent-child-name'),
    ).map((n) => n.textContent)
    expect(runningNames).toEqual(['Bash', 'Read'])
    expect(screen.getByText('0/2 · running')).toBeTruthy()
  })

  it('does NOT advertise in-flight work on a settled record with a stranded running row', () => {
    // Three reducer paths can terminate a subagent while leaving a `running`
    // child row (dismiss / pending-timeout / task-notification). The row stays
    // visible (so the tool isn't hidden) but must not pulse or carry an accent
    // "· running" count on a done card.
    renderCard(base({
      status: 'done',
      childToolCalls: [
        child({ toolUseId: 'c1', toolName: 'Bash', argSummary: 'ls' }),
        child({ toolUseId: 'c2', toolName: 'Grep', argSummary: 'x', status: 'running' }),
      ],
    }))
    expect(document.querySelector('.subagent-child-row-running .subagent-child-name')?.textContent).toBe('Grep')
    expect(document.querySelector('.subagent-child-dot-pulse')).toBeNull()
    expect(screen.getByText('1/2')).toBeTruthy()
    expect(screen.queryByText('1/2 · running')).toBeNull()
  })

  it('does not replay the row entrance animation on a fresh mount (scroll-back)', () => {
    // GridClipEnter seeds `revealing` from `entering`, so an unseeded arrival
    // gate re-animated the whole list every time the virtualized transcript
    // scrolled the card back into view.
    renderCard(base({
      status: 'done',
      childToolCalls: [child({ toolUseId: 'c1', toolName: 'Bash', argSummary: 'ls' })],
    }))
    expect(document.querySelector('.grid-clip-entering')).toBeNull()
  })

  it('does not re-play entrance when a row flips running → success in place', () => {
    // The whole point of the unified list: the same toolUseId stays mounted
    // through the status flip. If `seen` were keyed on settle (the old dual-
    // list contract) the flip would look like a new arrival and re-animate.
    const ctx: SubagentContextValue = {
      index: new Map([['tu_sa', base({
        status: 'running',
        childToolCalls: [child({ toolUseId: 'c1', toolName: 'Bash', argSummary: 'ls', status: 'running' })],
      })]]),
      messages: [],
      open: vi.fn(),
    }
    const { rerender } = render(
      <SubagentProvider value={ctx}>
        <SubagentCard toolUseId="tu_sa" />
      </SubagentProvider>,
    )
    expect(document.querySelector('.subagent-child-row-running')).toBeTruthy()

    const next: ActiveSubagent = {
      ...base({ status: 'running' }),
      childToolCalls: [child({
        toolUseId: 'c1',
        toolName: 'Bash',
        argSummary: 'ls',
        status: 'success',
        result: { content: 'ok', isError: false },
      })],
    }
    // New value object — mutating the old one wouldn't notify context consumers.
    rerender(
      <SubagentProvider value={{ ...ctx, index: new Map([['tu_sa', next]]) }}>
        <SubagentCard toolUseId="tu_sa" />
      </SubagentProvider>,
    )

    // Same row flipped in place — no entrance replay, still expandable.
    expect(document.querySelector('.subagent-child-row-running')).toBeNull()
    expect(document.querySelector('.subagent-child-row-success .subagent-child-name')?.textContent).toBe('Bash')
    expect(document.querySelector('.grid-clip-entering')).toBeNull()
    expect(document.querySelectorAll('.subagent-child-row')).toHaveLength(1)
  })
})
