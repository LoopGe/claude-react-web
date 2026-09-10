// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { WorkingBubble } from './WorkingBubble'
import { SUBAGENT_INLINE_LIMIT } from './SubagentSwarm'
import { expectPortaledToBody } from '../portal-test-utils'
import type { ActiveSubagent } from '../../session-store/types'

// Stub scrollIntoView — jsdom lacks it, and the popover keeps its highlighted
// row in view (same stub as ModelPicker.test.tsx / ToolGroupCard.test.tsx).
Element.prototype.scrollIntoView = vi.fn()

afterEach(() => {
  cleanup()
})

function agent(n: number, over: Partial<ActiveSubagent> = {}): ActiveSubagent {
  return {
    toolUseId: `tu_${n}`,
    label: `agent ${n}`,
    status: 'running',
    toolCount: 0,
    startedAt: 1_000 + n,
    ...over,
  }
}

const agents = (count: number) => Array.from({ length: count }, (_, i) => agent(i))

describe('WorkingBubble subagent display mode', () => {
  it(`renders one chip each up to ${SUBAGENT_INLINE_LIMIT} subagents`, () => {
    const { container } = render(<WorkingBubble activeSubagents={agents(SUBAGENT_INLINE_LIMIT)} />)
    expect(container.querySelectorAll('.subagent-chip').length).toBe(SUBAGENT_INLINE_LIMIT)
    expect(container.querySelector('.subagent-swarm')).toBeNull()
  })

  it('collapses to a single aggregate pill above the inline limit', () => {
    // The whole point of the aggregate: bar height is constant regardless of
    // fan-out width, so nothing can be clipped and the row count can't churn.
    const { container } = render(<WorkingBubble activeSubagents={agents(SUBAGENT_INLINE_LIMIT + 3)} />)
    expect(container.querySelectorAll('.subagent-chip').length).toBe(0)
    const pill = container.querySelector('.subagent-swarm')
    expect(pill).not.toBeNull()
    expect(pill!.querySelector('.subagent-swarm-count')!.textContent).toBe(
      `${SUBAGENT_INLINE_LIMIT + 3} agents`,
    )
  })

  it('aggregates on the FIRST commit of a wide fan-out, never a frame of chips', () => {
    // Pinned because the obvious implementation (flip a flag in an effect)
    // paints one frame of the wrapping chip wall — the exact layout this
    // replaces. The peak is adjusted during render instead.
    const { container } = render(<WorkingBubble activeSubagents={agents(5)} />)
    expect(container.querySelectorAll('.subagent-chip').length).toBe(0)
    expect(container.querySelector('.subagent-swarm')).not.toBeNull()
  })

  it('stays aggregated as agents settle, so the bar height does not oscillate', () => {
    const { container, rerender } = render(<WorkingBubble activeSubagents={agents(4)} />)
    expect(container.querySelector('.subagent-swarm')).not.toBeNull()

    // Down to 1 — still the pill (peak, not current, decides).
    rerender(<WorkingBubble activeSubagents={agents(1)} />)
    expect(container.querySelector('.subagent-swarm')).not.toBeNull()
    expect(container.querySelector('.subagent-swarm-count')!.textContent).toBe('1 agent')
    expect(container.querySelectorAll('.subagent-chip').length).toBe(0)
  })

  it('resets to chips once the fan-out fully drains', () => {
    const { container, rerender } = render(<WorkingBubble activeSubagents={agents(4)} />)
    expect(container.querySelector('.subagent-swarm')).not.toBeNull()

    rerender(<WorkingBubble activeSubagents={[]} />)
    rerender(<WorkingBubble activeSubagents={agents(2)} />)
    expect(container.querySelector('.subagent-swarm')).toBeNull()
    expect(container.querySelectorAll('.subagent-chip').length).toBe(2)
  })

  it('surfaces the pending count when the fan-out is a mix', () => {
    const mixed = [agent(0), agent(1), agent(2, { status: 'pending' })]
    const { container } = render(<WorkingBubble activeSubagents={mixed} />)
    expect(container.querySelector('.subagent-swarm-split')!.textContent).toBe('1 waiting')
    expect(container.querySelector('.subagent-swarm')!.getAttribute('aria-label')).toContain(
      '1 waiting in the background',
    )
  })

  it('calms the pill when every remaining agent is pending', () => {
    const allPending = agents(3).map((a) => ({ ...a, status: 'pending' as const }))
    const { container } = render(<WorkingBubble activeSubagents={allPending} />)
    const pill = container.querySelector('.subagent-swarm')!
    expect(pill.className).toContain('subagent-swarm-waiting')
    // No "N waiting" suffix when there is no running count to contrast with.
    expect(container.querySelector('.subagent-swarm-split')).toBeNull()
  })
})

describe('subagent swarm popover', () => {
  const openPopover = (container: HTMLElement) => {
    fireEvent.click(container.querySelector('.subagent-swarm')!)
  }

  it('opens on click and portals to <body> so its viewport coordinates hold', () => {
    const { container } = render(<WorkingBubble activeSubagents={agents(3)} />)
    expect(document.querySelector('.subagent-swarm-pop')).toBeNull()
    openPopover(container)
    expectPortaledToBody(container, '.subagent-swarm-pop')
  })

  it('lists one row per subagent with its progress summary', () => {
    // progressSummary / lastToolName were previously reachable only through a
    // chip's title tooltip; the popover is where they become readable.
    const list = [
      agent(0, { progressSummary: 'reading the reducer' }),
      agent(1, { lastToolName: 'Grep' }),
      agent(2),
    ]
    const { container } = render(<WorkingBubble activeSubagents={list} />)
    openPopover(container)
    const subs = Array.from(document.querySelectorAll('.subagent-swarm-row-sub')).map(
      (e) => e.textContent,
    )
    expect(subs).toEqual(['reading the reducer', 'Running Grep', 'Starting…'])
    expect(document.querySelectorAll('.subagent-swarm-row').length).toBe(3)
  })

  it('labels a pending row as background work when it has no summary yet', () => {
    const { container } = render(
      <WorkingBubble activeSubagents={[agent(0), agent(1), agent(2, { status: 'pending' })]} />,
    )
    openPopover(container)
    const rows = document.querySelectorAll('.subagent-swarm-row')
    expect(rows[2].className).toContain('subagent-swarm-row-waiting')
    expect(rows[2].querySelector('.subagent-swarm-row-sub')!.textContent).toBe(
      'Waiting — running in the background',
    )
  })

  it('drills into a subagent and closes when a row is clicked', () => {
    const onOpenSubagent = vi.fn()
    const { container } = render(
      <WorkingBubble activeSubagents={agents(3)} onOpenSubagent={onOpenSubagent} />,
    )
    openPopover(container)
    fireEvent.click(document.querySelectorAll('.subagent-swarm-row')[1])
    expect(onOpenSubagent).toHaveBeenCalledWith('tu_1')
    expect(document.querySelector('.subagent-swarm-pop')).toBeNull()
  })

  it('renders non-interactive rows when the host offers no drill-down', () => {
    const { container } = render(<WorkingBubble activeSubagents={agents(3)} />)
    openPopover(container)
    const rows = document.querySelectorAll('.subagent-swarm-row')
    expect(rows.length).toBe(3)
    for (const row of rows) expect(row.tagName).toBe('DIV')
  })

  it('moves the row cursor with the arrow keys and opens on Enter', () => {
    const onOpenSubagent = vi.fn()
    const { container } = render(
      <WorkingBubble activeSubagents={agents(3)} onOpenSubagent={onOpenSubagent} />,
    )
    openPopover(container)
    const pop = document.querySelector('.subagent-swarm-pop')!
    fireEvent.keyDown(pop, { key: 'ArrowDown' })
    fireEvent.keyDown(pop, { key: 'ArrowDown' })
    fireEvent.keyDown(pop, { key: 'ArrowUp' })
    expect(document.querySelectorAll('.subagent-swarm-row')[1].className).toContain('selected')
    fireEvent.keyDown(pop, { key: 'Enter' })
    expect(onOpenSubagent).toHaveBeenCalledWith('tu_1')
  })

  it('toggles shut on a second click of the pill', () => {
    const { container } = render(<WorkingBubble activeSubagents={agents(3)} />)
    openPopover(container)
    expect(document.querySelector('.subagent-swarm-pop')).not.toBeNull()
    openPopover(container)
    expect(document.querySelector('.subagent-swarm-pop')).toBeNull()
  })

  it('dismisses on an outside mousedown but not on one inside itself', () => {
    const { container } = render(<WorkingBubble activeSubagents={agents(3)} />)
    openPopover(container)
    fireEvent.mouseDown(document.querySelector('.subagent-swarm-row')!)
    expect(document.querySelector('.subagent-swarm-pop')).not.toBeNull()
    fireEvent.mouseDown(document.documentElement)
    expect(document.querySelector('.subagent-swarm-pop')).toBeNull()
  })

  it('closes itself when the last agent settles', () => {
    // An empty popover would otherwise hang over a bar that no longer has a
    // pill to anchor it to.
    const { container, rerender } = render(<WorkingBubble activeSubagents={agents(3)} />)
    openPopover(container)
    expect(document.querySelector('.subagent-swarm-pop')).not.toBeNull()
    rerender(<WorkingBubble activeSubagents={[]} />)
    expect(document.querySelector('.subagent-swarm-pop')).toBeNull()
  })
})

describe('working bar height contract', () => {
  it('does not clip its own content', () => {
    // Regression pin for the original bug: `.working-bar` carried
    // `max-height: 120px` next to `overflow: hidden`, so a 5-chip fan-out
    // (~176px in a narrow column) was cut off — and since the "+N more" badge
    // rendered last, the one signal that content was hidden was the first
    // casualty. Height is bounded by the aggregate pill now, not by a clip.
    const css = readFileSync(join(process.cwd(), 'src/styles/chat.css'), 'utf8')
    const rule = /\n\.working-bar \{([^}]*)\}/.exec(css)
    expect(rule, '.working-bar rule').not.toBeNull()
    // Strip comments first: the rule carries a note explaining why there is no
    // max-height, and matching the prose instead of a declaration would make
    // this assertion fail for the wrong reason.
    const declarations = rule![1].replace(/\/\*[\s\S]*?\*\//g, '')
    expect(declarations).not.toMatch(/max-height/)
  })
})
