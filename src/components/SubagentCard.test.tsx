import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SubagentCard } from './SubagentCard'
import { SubagentProvider, type SubagentContextValue } from '../hooks/useSubagentContext'
import type { ActiveSubagent, SubagentChildCall } from '../session-store/types'

// AnimatedCollapse uses ResizeObserver + matchMedia; jsdom lacks both. Provide
// minimal stubs so AnimatedDetails renders its (open) content synchronously.
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

  it('highlights the running child at the top while the subagent is live', () => {
    renderCard(base({
      status: 'running',
      childToolCalls: [
        child({ toolUseId: 'c1', toolName: 'Bash', argSummary: 'ls', status: 'success' }),
        child({ toolUseId: 'c2', toolName: 'Grep', argSummary: 'skipAuth', status: 'running' }),
      ],
    }))
    // The dedicated live-highlight element carries the running tool's name,
    // and the summary shows the settled/total count plus the live marker.
    expect(document.querySelector('.subagent-child-live-name')?.textContent).toBe('Grep')
    expect(screen.getByText('1/2 · running')).toBeTruthy()
    // De-duplication: the running call is surfaced ONLY by the highlight line,
    // never also as a row — rendering it in both places showed the same tool
    // twice. Its name therefore appears exactly once in the whole card.
    expect(screen.getAllByText('Grep')).toHaveLength(1)
    const rowNames = Array.from(document.querySelectorAll('.subagent-child-name')).map((n) => n.textContent)
    expect(rowNames).toEqual(['Bash']) // only the settled call is a row
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

  it('shows EVERY in-flight call, not just the first (parallel tool calls)', () => {
    // A subagent routinely emits several tool_use blocks in one frame. Taking
    // only the first running call left the rest invisible until they settled.
    renderCard(base({
      status: 'running',
      childToolCalls: [
        child({ toolUseId: 'c1', toolName: 'Bash', argSummary: 'ls', status: 'running' }),
        child({ toolUseId: 'c2', toolName: 'Read', argSummary: 'a.ts', status: 'running' }),
      ],
    }))
    const liveNames = Array.from(document.querySelectorAll('.subagent-child-live-name')).map((n) => n.textContent)
    expect(liveNames).toEqual(['Bash', 'Read'])
    expect(screen.getByText('0/2 · running')).toBeTruthy()
  })

  it('does NOT advertise in-flight work on a settled record with a stranded running row', () => {
    // Three reducer paths can terminate a subagent while leaving a `running`
    // child row (dismiss / pending-timeout / task-notification). The card must
    // not render pulsing dots and an accent "· running" count on a done card.
    renderCard(base({
      status: 'done',
      childToolCalls: [
        child({ toolUseId: 'c1', toolName: 'Bash', argSummary: 'ls' }),
        child({ toolUseId: 'c2', toolName: 'Grep', argSummary: 'x', status: 'running' }),
      ],
    }))
    expect(document.querySelector('.subagent-child-live-name')).toBeNull()
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
})
