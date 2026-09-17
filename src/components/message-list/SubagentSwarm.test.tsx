// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { WorkingBubble } from './WorkingBubble'
import { SubagentSwarmPill } from './SubagentSwarm'
import { expectPortaledToBody } from '../portal-test-utils'
import type { ActiveSubagent } from '../../session-store/types'

// Stub scrollIntoView — jsdom lacks it, and the popover keeps its highlighted
// row in view (same stub as ModelPicker.test.tsx / ToolGroupCard.test.tsx).
Element.prototype.scrollIntoView = vi.fn()

// No per-file `afterEach(cleanup)`: src/test-setup.ts registers it globally.
// CLAUDE.md's rule is "don't re-add per-file cleanup" — the race it documents
// came from having NO cleanup anywhere (a render left mounted past its test
// fires an unmount-cancelled timer inside vitest's jsdom teardown), not from
// a second copy being dangerous.

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
  // The bar ALWAYS aggregates: one pill for any fan-out width, a lone subagent
  // included — the case that matters most, since one Agent/Explore dispatch is
  // the commonest fan-out. The per-agent chips — and the peak-width state
  // machine that chose between chips and pill — are gone, so the pill's
  // popover is the only place per-agent detail (label / progressSummary /
  // elapsed) is read.
  //
  // "Never a chip beside the pill" is deliberately NOT asserted: neither
  // `querySelectorAll('.subagent-chip') === 0` nor a class-scoped surface
  // count can prove it — both pass whatever else renders, as long as its class
  // differs. What IS pinned below is that the pill renders, labels itself
  // correctly at every width, and appears on the first commit; the pixels that
  // the removed chip row would have added are not observable from jsdom.
  it('renders the same single pill at every fan-out width', () => {
    // First commit included: the bar must never paint a frame without the pill
    // (the deleted peak-width machine existed to stop chips appearing first,
    // and an effect-deferred pill would reintroduce exactly that frame).
    const { container, rerender } = render(<WorkingBubble activeSubagents={agents(8)} />)
    const count = () => container.querySelector('.subagent-swarm-count')!.textContent
    expect(count()).toBe('8 agents')

    for (const n of [3, 2, 1]) {
      rerender(<WorkingBubble activeSubagents={agents(n)} />)
      expect(count(), `count=${n}`).toBe(`${n} agent${n === 1 ? '' : 's'}`)
    }
  })

  it('stays a pill as agents settle — the row count never churns mid-turn', () => {
    const { container, rerender } = render(<WorkingBubble activeSubagents={agents(4)} />)
    expect(container.querySelector('.subagent-swarm-count')!.textContent).toBe('4 agents')

    rerender(<WorkingBubble activeSubagents={agents(1)} />)
    expect(container.querySelector('.subagent-swarm-count')!.textContent).toBe('1 agent')
  })

  it('drops the pill and its separator when the fan-out drains, then restores them', () => {
    // The populated → empty TRANSITION (not just an empty mount: stale chrome
    // in a drained bar is the regression this pins) and the empty → populated
    // one after it — a latch or memo that survives a full drain would render
    // the session's SECOND fan-out with no pill at all.
    const { container, rerender } = render(<WorkingBubble activeSubagents={agents(3)} />)
    expect(container.querySelector('.subagent-swarm')).not.toBeNull()
    expect(container.querySelector('.working-bar-sep')).not.toBeNull()

    rerender(<WorkingBubble activeSubagents={[]} />)
    expect(container.querySelector('.subagent-swarm')).toBeNull()
    // The separator before the subagent group goes with it — an empty fan-out
    // must not leave a dangling divider in the bar.
    expect(container.querySelector('.working-bar-sep')).toBeNull()

    rerender(<WorkingBubble activeSubagents={agents(2)} />)
    expect(container.querySelector('.subagent-swarm-count')!.textContent).toBe('2 agents')
    expect(container.querySelector('.working-bar-sep')).not.toBeNull()
  })

  it('surfaces the pending count when the fan-out is a mix', () => {
    const mixed = [agent(0), agent(1), agent(2, { status: 'pending' })]
    const { container } = render(<WorkingBubble activeSubagents={mixed} />)
    expect(container.querySelector('.subagent-swarm-split')!.textContent).toBe('1 waiting')
    expect(container.querySelector('.subagent-swarm')!.getAttribute('aria-label')).toContain(
      '1 waiting in the background',
    )
  })

  it('reads singular for a lone subagent, in the count, the tooltip and the label', () => {
    // The pill is no longer reserved for wide fan-outs, so the one-agent case
    // is now the common one for all three strings. Both attributes are
    // asserted as REQUIREMENTS — today they happen to share one expression,
    // but the test must not be what stops them from diverging later.
    const { container } = render(<WorkingBubble activeSubagents={agents(1)} />)
    const pill = container.querySelector('.subagent-swarm')!
    expect(container.querySelector('.subagent-swarm-count')!.textContent).toBe('1 agent')
    expect(pill.getAttribute('title')).toBe('1 subagent in flight — open the list')
    expect(pill.getAttribute('aria-label')).toBe('1 subagent in flight — open the list')
  })

  it('reads singular in the a11y label when the lone subagent is pending too', () => {
    // The waiting branch is a separate string from the running one, and a lone
    // pending subagent is the case the Waiting bubble exists for.
    const { container } = render(
      <WorkingBubble activeSubagents={[agent(0, { status: 'pending' })]} />,
    )
    expect(container.querySelector('.subagent-swarm')!.getAttribute('aria-label')).toBe(
      '1 subagent in flight, 1 waiting in the background — open the list',
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

  it('names the popover for the count it actually lists', () => {
    // The dialog must not announce the plural right after the pill announced
    // the singular for the same one-agent set.
    const { container, rerender } = render(<WorkingBubble activeSubagents={agents(3)} />)
    openPopover(container)
    const pop = () => document.querySelector('.subagent-swarm-pop')!
    expect(pop().getAttribute('aria-label')).toBe('Subagents in flight')

    // DERIVED, not stored: agents settling while the user reads the list must
    // re-label the dialog, or it announces the plural over a single row.
    rerender(<WorkingBubble activeSubagents={agents(1)} />)
    expect(pop().getAttribute('aria-label')).toBe('Subagent in flight')
    expect(pop().querySelector('.subagent-swarm-pop-title')!.textContent).toBe('Subagent in flight')
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

  it('toggles shut on the FULL mousedown → mouseup → click sequence', () => {
    // The plain-click case above cannot catch a close-then-reopen on the
    // trigger: `fireEvent.click` dispatches no mousedown, but a real browser
    // always sends one first. That mousedown lands outside the popover's ref,
    // so the outside-click listener used to swallow it and the following click
    // re-anchored instead of toggling shut.
    //
    // Aimed at a CHILD span, not the button: the count text is where the
    // pointer actually lands, so an identity check (`target === trigger`)
    // instead of the containment check would slip past a button-only target
    // while re-breaking every real click.
    const { container } = render(<WorkingBubble activeSubagents={agents(3)} />)
    // Sampled ONCE: nothing pins that a re-query returns the same node, and the
    // containment-vs-identity question this test exists for is exactly about
    // which node the events land on.
    const hitArea = container.querySelector('.subagent-swarm-count')!
    const fullClick = () => {
      fireEvent.mouseDown(hitArea)
      fireEvent.mouseUp(hitArea)
      fireEvent.click(hitArea)
    }

    fullClick()
    expect(document.querySelector('.subagent-swarm-pop')).not.toBeNull()

    fullClick()
    expect(document.querySelector('.subagent-swarm-pop')).toBeNull()
    // Entailed by the line above (both read `anchor`); asserted because
    // aria-expanded is the trigger's public contract.
    expect(container.querySelector('.subagent-swarm')!.getAttribute('aria-expanded')).toBe('false')
  })

  it('dismisses on a secondary press of the pill instead of exempting it', () => {
    // A right/middle press produces no `click`, so exempting the trigger for it
    // would strand the popover open under the native context menu.
    const { container } = render(<WorkingBubble activeSubagents={agents(3)} />)
    const hitArea = container.querySelector('.subagent-swarm-count')!
    const openPopover = () => fireEvent.click(container.querySelector('.subagent-swarm')!)

    openPopover()
    fireEvent.mouseDown(hitArea, { button: 2 })
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
    //
    // Mounted DIRECTLY rather than through WorkingBubble: the bubble renders
    // `{hasSubagents && <SubagentSwarmPill …/>}`, so draining the fan-out
    // unmounts the pill (and the portal with it) in the same commit — the
    // pill's own empty-list effect would never get to run, and the assertion
    // would pass even with that effect deleted.
    const { container, rerender } = render(<SubagentSwarmPill subagents={agents(3)} />)
    fireEvent.click(container.querySelector('.subagent-swarm')!)
    expect(document.querySelector('.subagent-swarm-pop')).not.toBeNull()
    rerender(<SubagentSwarmPill subagents={[]} />)
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
