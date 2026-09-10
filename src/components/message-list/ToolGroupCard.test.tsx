import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { useState } from 'react'
import { render, cleanup, fireEvent, act } from '@testing-library/react'
import { ToolGroupCard } from './ToolGroupCard'
import { ToolStatusProvider, ToolResultProvider, PlanStatusProvider } from '../../hooks/usePlanStatus'
import { BackgroundToolProvider } from '../../hooks/useBackgroundTool'
import type { ActiveSubagent, ToolStatus } from '../../session-store/types'
import type { SdkMessage } from '../../types'

// Stub scrollIntoView — jsdom lacks it, and the failed badge scrolls the
// member it points at (same stub as ModelPicker.test.tsx / MessageList.test.tsx).
Element.prototype.scrollIntoView = vi.fn()

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  // Some tests stub window.getSelection; matchMedia is re-stubbed above.
  vi.unstubAllGlobals()
})

function toolMsg(id: string, name = 'Read', input: Record<string, unknown> = {}): SdkMessage {
  return {
    type: 'assistant',
    uuid: id,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: `${id}-tu`, name, input }],
    },
  } as unknown as SdkMessage
}

function renderGroup({
  members,
  toolStatus,
  planStatus = new Map(),
  searchQuery,
  activeMemberItemIndex,
  activeMatchInItem,
  working,
  closed,
  subagentStatuses,
}: {
  members: SdkMessage[]
  toolStatus: Map<string, ToolStatus>
  planStatus?: Map<string, 'approved' | 'rejected' | 'pending'>
  searchQuery?: string
  activeMemberItemIndex?: number
  activeMatchInItem?: number
  working?: boolean
  closed?: boolean
  subagentStatuses?: ReadonlyMap<string, ActiveSubagent>
}) {
  return render(
    <ToolStatusProvider value={toolStatus}>
      <ToolResultProvider value={new Map()}>
        <PlanStatusProvider value={planStatus}>
          <BackgroundToolProvider value={undefined}>
            <ToolGroupCard
              members={members}
              memberItemIndices={members.map((_, i) => i)}
              searchQuery={searchQuery}
              activeMemberItemIndex={activeMemberItemIndex}
              activeMatchInItem={activeMatchInItem}
              working={working}
              closed={closed}
              subagentStatuses={subagentStatuses}
            />
          </BackgroundToolProvider>
        </PlanStatusProvider>
      </ToolResultProvider>
    </ToolStatusProvider>,
  )
}

function isOpen(container: HTMLElement): boolean {
  return container.querySelector('.tool-group-card')!.getAttribute('data-state') === 'open'
}

describe('ToolGroupCard', () => {
  it('defaults collapsed when every tool settled successfully', () => {
    const { container } = renderGroup({
      members: [toolMsg('t1'), toolMsg('t2')],
      toolStatus: new Map<string, ToolStatus>([
        ['t1-tu', 'success'],
        ['t2-tu', 'success'],
      ]),
    })
    expect(isOpen(container)).toBe(false)
    expect(container.textContent).toContain('Read')
  })

  it('defaults expanded while any tool is still running', () => {
    const { container } = renderGroup({
      members: [toolMsg('t1'), toolMsg('t2')],
      toolStatus: new Map<string, ToolStatus>([
        ['t1-tu', 'success'],
        ['t2-tu', 'running'],
      ]),
    })
    expect(isOpen(container)).toBe(true)
    expect(container.querySelector('.tool-status-running')).not.toBeNull()
  })

  it('keeps a running group open even after a manual close', () => {
    const { container } = renderGroup({
      members: [toolMsg('t1'), toolMsg('t2')],
      toolStatus: new Map<string, ToolStatus>([
        ['t1-tu', 'success'],
        ['t2-tu', 'running'],
      ]),
    })
    expect(isOpen(container)).toBe(true)
    fireEvent.click(container.querySelector('.tool-group-toggle')!)
    // forceOpen (running) wins over userOpen=false
    expect(isOpen(container)).toBe(true)
  })

  it('stays open mid-turn when tools settle between calls, then folds after the turn ends', () => {
    vi.useFakeTimers()
    function Harness() {
      const [status, setStatus] = useState<Map<string, ToolStatus>>(
        new Map([
          ['t1-tu', 'success' as const],
          ['t2-tu', 'running' as const],
        ]),
      )
      const [working, setWorking] = useState(true)
      const members = [toolMsg('t1'), toolMsg('t2')]
      return (
        <>
          <button
            type="button"
            data-testid="settle"
            onClick={() =>
              setStatus(
                new Map([
                  ['t1-tu', 'success' as const],
                  ['t2-tu', 'success' as const],
                ]),
              )
            }
          />
          <button type="button" data-testid="turn-end" onClick={() => setWorking(false)} />
          <ToolStatusProvider value={status}>
            <ToolResultProvider value={new Map()}>
              <PlanStatusProvider value={new Map()}>
                <BackgroundToolProvider value={undefined}>
                  <ToolGroupCard
                    members={members}
                    memberItemIndices={members.map((_, i) => i)}
                    working={working}
                  />
                </BackgroundToolProvider>
              </PlanStatusProvider>
            </ToolResultProvider>
          </ToolStatusProvider>
        </>
      )
    }
    const { container, getByTestId } = render(<Harness />)
    expect(isOpen(container)).toBe(true)

    // Tools settle mid-turn (gap before the next tool_use) — must stay open
    fireEvent.click(getByTestId('settle'))
    expect(isOpen(container)).toBe(true)

    // Turn ends → settle hold, then auto-collapse
    fireEvent.click(getByTestId('turn-end'))
    expect(isOpen(container)).toBe(true)
    act(() => {
      vi.advanceTimersByTime(2300)
    })
    expect(isOpen(container)).toBe(false)
  })

  it('folds a group holding a finished subagent instead of spinning forever', () => {
    // Regression: Agent/Task/Explore are absent from toolStatus by design, and
    // the generic "no entry = in flight" default made such a group show a
    // permanent `running` badge AND never fold (live keeps it pinned open).
    const { container } = renderGroup({
      members: [toolMsg('t1', 'Read', { file_path: 'a.ts' }), toolMsg('t2', 'Agent', { description: 'audit' })],
      toolStatus: new Map<string, ToolStatus>([['t1-tu', 'success']]),
      subagentStatuses: new Map([['t2-tu', { status: 'done' } as unknown as ActiveSubagent]]),
    })
    expect(container.querySelector('.tool-status-running')).toBeNull()
    expect(isOpen(container)).toBe(false)
  })

  it('keeps a group open while its subagent is genuinely running', () => {
    const { container } = renderGroup({
      members: [toolMsg('t1', 'Agent', { description: 'audit' })],
      toolStatus: new Map<string, ToolStatus>(),
      subagentStatuses: new Map([['t1-tu', { status: 'running' } as unknown as ActiveSubagent]]),
    })
    expect(container.querySelector('.tool-status-running')).not.toBeNull()
    expect(isOpen(container)).toBe(true)
  })

  it('shows failed badge when collapsed and a tool errored, without alarming the whole card', () => {
    const { container } = renderGroup({
      members: [toolMsg('t1'), toolMsg('t2')],
      toolStatus: new Map<string, ToolStatus>([
        ['t1-tu', 'success'],
        ['t2-tu', 'error'],
      ]),
    })
    expect(isOpen(container)).toBe(false)
    expect(container.querySelector('.tool-status-error')).not.toBeNull()
    // One failed call out of several does not make the whole group red — the
    // badge (and the failing card itself) carry that, not a card-wide stripe.
    expect(container.querySelector('.tool-group-has-error')).toBeNull()
  })

  describe('failed badge jumps to the call that failed', () => {
    const twoOfWhichOneFailed = () => ({
      members: [
        toolMsg('t1', 'Read', { file_path: 'a.ts' }),
        toolMsg('t2', 'Bash', { command: 'npm test' }),
      ],
      toolStatus: new Map<string, ToolStatus>([
        ['t1-tu', 'success'],
        ['t2-tu', 'error'],
      ]),
    })

    it('is a button, so it is reachable without a pointer', () => {
      const { container } = renderGroup(twoOfWhichOneFailed())
      const badge = container.querySelector('.tool-group-failed-jump')!
      expect(badge.tagName).toBe('BUTTON')
      expect(badge.getAttribute('aria-label')).toBeTruthy()
    })

    it('expands the group and tints the failing member', () => {
      vi.useFakeTimers()
      const { container } = renderGroup(twoOfWhichOneFailed())
      expect(isOpen(container)).toBe(false)
      fireEvent.click(container.querySelector('.tool-group-failed-jump')!)
      expect(isOpen(container)).toBe(true)
      const flashed = container.querySelector('.tool-group-member-flash')!
      expect(flashed.getAttribute('data-member-tool-use-id')).toBe('t2-tu')
      // Transient: the card's own error badge is the standing signal.
      act(() => {
        vi.advanceTimersByTime(1500)
      })
      expect(container.querySelector('.tool-group-member-flash')).toBeNull()
    })

    it('scrolls the failing member into view once the fold has settled', () => {
      vi.useFakeTimers()
      const { container } = renderGroup(twoOfWhichOneFailed())
      const scrolls: Element[] = []
      for (const el of container.querySelectorAll('[data-member-tool-use-id]')) {
        ;(el as HTMLElement).scrollIntoView = () => scrolls.push(el)
      }
      fireEvent.click(container.querySelector('.tool-group-failed-jump')!)
      // Not while the height is still animating — that lands short.
      expect(scrolls).toHaveLength(0)
      act(() => {
        vi.advanceTimersByTime(300)
      })
      expect(scrolls.map((el) => el.getAttribute('data-member-tool-use-id'))).toEqual(['t2-tu'])
    })

    it('does not turn the badge into a control when no id is resolvable', () => {
      // Status is keyed by tool_use id; without one there is nothing to point
      // at, and the group counts as in-flight anyway (so: no failed badge).
      const { container } = renderGroup({
        members: [{
          type: 'assistant',
          uuid: 'x',
          message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: {} }] },
        } as unknown as SdkMessage],
        toolStatus: new Map<string, ToolStatus>(),
      })
      expect(container.querySelector('.tool-group-failed-jump')).toBeNull()
    })
  })

  it('keeps a pending-plan group open (and shows waiting) even after a manual close', () => {
    const { container } = renderGroup({
      members: [toolMsg('t1'), toolMsg('p1', 'ExitPlanMode')],
      toolStatus: new Map<string, ToolStatus>([['t1-tu', 'success']]),
      planStatus: new Map([['p1-tu', 'pending' as const]]),
    })
    expect(isOpen(container)).toBe(true)
    fireEvent.click(container.querySelector('.tool-group-toggle')!)
    // pending interactive also force-opens — a folded plan would stall the turn
    expect(isOpen(container)).toBe(true)
    expect(container.textContent).toContain('waiting')
    expect(container.querySelector('.tool-group-has-pending')).not.toBeNull()
    // The waiting badge must NOT borrow .tool-status-running: that rule spins
    // the badge glyph, and this one (IconMessageQuestion) isn't rotationally
    // symmetric, so it visibly wobbled. It also isn't semantically "running" —
    // nothing is in flight, the turn is parked on the user.
    expect(container.querySelector('.tool-status-waiting')).not.toBeNull()
    expect(container.querySelector('.tool-status-running')).toBeNull()
    // Belt-and-braces: no loader glyph in the waiting badge at all, so even a
    // future unscoped spin rule can't animate it.
    expect(container.querySelector('.tool-status-waiting .icon-loader')).toBeNull()
  })

  it('toggles on header click', () => {
    const { container } = renderGroup({
      members: [toolMsg('t1'), toolMsg('t2')],
      toolStatus: new Map<string, ToolStatus>([
        ['t1-tu', 'success'],
        ['t2-tu', 'success'],
      ]),
    })
    fireEvent.click(container.querySelector('.tool-group-toggle')!)
    expect(isOpen(container)).toBe(true)
    fireEvent.click(container.querySelector('.tool-group-toggle')!)
    expect(isOpen(container)).toBe(false)
  })

  it('force-expands only when the group may match the search query', () => {
    const settled = new Map<string, ToolStatus>([
      ['t1-tu', 'success'],
      ['t2-tu', 'success'],
    ])
    const miss = renderGroup({
      members: [toolMsg('t1'), toolMsg('t2', 'Grep')],
      toolStatus: settled,
      searchQuery: 'needle',
    })
    expect(isOpen(miss.container)).toBe(false)

    const hit = renderGroup({
      members: [toolMsg('t1', 'Read', { file_path: 'needle.ts' }), toolMsg('t2')],
      toolStatus: settled,
      searchQuery: 'needle',
    })
    expect(isOpen(hit.container)).toBe(true)
  })

  it('treats a missing tool id as running so an in-flight card never folds', () => {
    const { container } = renderGroup({
      members: [toolMsg('t1'), toolMsg('t2')],
      toolStatus: new Map<string, ToolStatus>([['t2-tu', 'success']]), // t1-tu absent
    })
    expect(isOpen(container)).toBe(true)
  })

  it('exposes count + tool summary to assistive tech (aria-label + aria-controls)', () => {
    const { container } = renderGroup({
      members: [toolMsg('t1', 'Read'), toolMsg('t2', 'Read'), toolMsg('t3', 'Grep')],
      toolStatus: new Map<string, ToolStatus>([
        ['t1-tu', 'success'],
        ['t2-tu', 'success'],
        ['t3-tu', 'success'],
      ]),
    })
    const header = container.querySelector('.tool-group-toggle')!
    // A real button: Enter/Space, focus and role come from the platform
    // instead of hand-rolled key handling.
    expect(header.tagName).toBe('BUTTON')
    // Count and the deduced name summary must reach the accessible name (the
    // count pill itself is aria-hidden, so the number lives only here).
    const label = header.getAttribute('aria-label')!
    expect(label).toContain('3')
    expect(label).toContain('Read')
    expect(label).toContain('Grep')
    // aria-controls must point at the mounted collapsible body (children stay
    // mounted when folded, so the target is always present). Compare by
    // attribute rather than a `#` CSS selector — React's useId emits a `:`-ful
    // id that is a valid IDREF but an awkward CSS selector in some parsers.
    const controls = header.getAttribute('aria-controls')!
    expect(controls).toBeTruthy()
    const body = container.querySelector('.tool-group-body')!
    expect(body.getAttribute('id')).toBe(controls)
  })

  it('streamlines the collapsed header — no redundant noun label next to the count', () => {
    const { container } = renderGroup({
      members: [toolMsg('t1'), toolMsg('t2')],
      toolStatus: new Map<string, ToolStatus>([
        ['t1-tu', 'success'],
        ['t2-tu', 'success'],
      ]),
    })
    // Design A: the accent count pill is the single count signal; the separate
    // "tool call(s)" noun label was removed (it duplicated the pill).
    expect(container.textContent).not.toContain('tool call')
    // The tool-name summary is still the scannable lead inside the header.
    expect(container.textContent).toContain('Read')
  })

  it('shows what each tool acted on, not just its name', () => {
    const { container } = renderGroup({
      members: [
        toolMsg('t1', 'Read', { file_path: 'src/components/MessageList.tsx' }),
        toolMsg('t2', 'Grep', { pattern: 'useWsHub' }),
      ],
      toolStatus: new Map<string, ToolStatus>([
        ['t1-tu', 'success'],
        ['t2-tu', 'success'],
      ]),
    })
    expect(isOpen(container)).toBe(false)
    expect(container.querySelector('.tool-group-names')?.textContent).toBe(
      'Read MessageList.tsx \u00b7 Grep \u201cuseWsHub\u201d',
    )
    // The identifying half is its own span so it can take the foreground.
    expect(
      Array.from(container.querySelectorAll('.tool-group-entry-target')).map((e) => e.textContent),
    ).toEqual(['MessageList.tsx', '\u201cuseWsHub\u201d'])
    // Hover and AT see the same list as the eye. `title` sits on the ellipsis
    // line (that's what it explains), the accessible name on the button.
    expect(container.querySelector('.tool-group-names')?.getAttribute('title'))
      .toContain('MessageList.tsx')
    expect(container.querySelector('.tool-group-toggle')?.getAttribute('aria-label'))
      .toContain('\u201cuseWsHub\u201d')
  })

  it('folds repeat calls of one tool behind the first target', () => {
    const { container } = renderGroup({
      members: [
        toolMsg('t1', 'Read', { file_path: 'src/App.tsx' }),
        toolMsg('t2', 'Read', { file_path: 'src/main.tsx' }),
        toolMsg('t3', 'Read', { file_path: 'src/types.ts' }),
      ],
      toolStatus: new Map<string, ToolStatus>([
        ['t1-tu', 'success'],
        ['t2-tu', 'success'],
        ['t3-tu', 'success'],
      ]),
    })
    expect(container.querySelector('.tool-group-names')?.textContent).toBe('Read App.tsx +2')
    expect(container.querySelector('.tool-group-count')?.textContent).toBe('3')
  })

  it('folds a lone settled tool too — vertical space beats the doubled header', () => {
    // A single tool is the most common transcript row, and its payload can be
    // arbitrarily tall (an Edit diff, a Bash result). Keeping the chrome means
    // one 36px line either way, so count===1 gets no special case.
    const { container } = renderGroup({
      members: [toolMsg('t1', 'Read', { file_path: 'src/App.tsx' })],
      toolStatus: new Map<string, ToolStatus>([['t1-tu', 'success']]),
    })
    expect(container.querySelector('.tool-group-toggle')).not.toBeNull()
    expect(isOpen(container)).toBe(false)
    // On a single call the tally would only ever read "1"; the width goes to
    // the target instead.
    expect(container.querySelector('.tool-group-count')).toBeNull()
    expect(container.querySelector('.tool-group-names')?.textContent).toBe('Read App.tsx')
  })

  describe('boundary closure (`closed`) — fold mid-turn once a non-foldable row follows', () => {
    // The group must have been LIVE this mount for the `wasLive && turnActive`
    // hold to matter, so drive status + closure through a harness: starts with
    // a running tool (→ live), settles it, then flips `closed` as if a
    // non-foldable row (text/thinking/user) landed after the group.
    function ClosureHarness() {
      const [status, setStatus] = useState<Map<string, ToolStatus>>(
        new Map([
          ['t1-tu', 'success' as const],
          ['t2-tu', 'running' as const],
        ]),
      )
      const [closed, setClosed] = useState(false)
      const settle = () =>
        setStatus(new Map([['t1-tu', 'success' as const], ['t2-tu', 'success' as const]]))
      const members = [toolMsg('t1'), toolMsg('t2')]
      return (
        <ToolStatusProvider value={status}>
          <ToolResultProvider value={new Map()}>
            <PlanStatusProvider value={new Map()}>
              <BackgroundToolProvider value={undefined}>
                <ToolGroupCard members={members} memberItemIndices={[0, 1]} working closed={closed} />
                <button type="button" data-testid="settle" onClick={settle} />
                <button type="button" data-testid="close" onClick={() => setClosed(true)} />
              </BackgroundToolProvider>
            </PlanStatusProvider>
          </ToolResultProvider>
        </ToolStatusProvider>
      )
    }

    it('folds a settled live group mid-turn the moment a boundary row closes it', () => {
      const { container, getByTestId } = render(<ClosureHarness />)
      expect(isOpen(container)).toBe(true) // running → live → open
      fireEvent.click(getByTestId('settle'))
      // settled but not closed yet → still may grow → stays open mid-turn
      expect(isOpen(container)).toBe(true)
      fireEvent.click(getByTestId('close')) // a boundary row lands
      expect(isOpen(container)).toBe(false) // group is final → folds mid-turn
    })

    it('keeps a settled live group open all turn while it can still grow (not closed)', () => {
      const { container, getByTestId } = render(<ClosureHarness />)
      fireEvent.click(getByTestId('settle'))
      expect(isOpen(container)).toBe(true) // not closed = live tail, may grow
    })

    it('lets the user collapse a settled tail group mid-turn', () => {
      const { container, getByTestId } = render(<ClosureHarness />)
      fireEvent.click(getByTestId('settle'))
      expect(isOpen(container)).toBe(true) // held open because it may grow
      // Once every tool has settled the header carries no badge explaining the
      // hold, so an explicit fold MUST win over it — otherwise the click looks
      // broken. (A running / pending member still force-opens: that state does
      // announce itself, and hiding it would bury a turn needing action.)
      fireEvent.click(container.querySelector('.tool-group-toggle')!)
      expect(isOpen(container)).toBe(false)
    })

    it('does not fold a closed group while a member is still running', () => {
      const { container } = renderGroup({
        members: [toolMsg('t1'), toolMsg('t2')],
        toolStatus: new Map<string, ToolStatus>([
          ['t1-tu', 'success'],
          ['t2-tu', 'running'],
        ]),
        working: true,
        closed: true,
      })
      expect(isOpen(container)).toBe(true) // live wins over closed
    })

    it('search force-expands a settled closed group', () => {
      const { container } = renderGroup({
        members: [toolMsg('t1', 'Read', { file_path: 'needle.ts' }), toolMsg('t2', 'Grep')],
        toolStatus: new Map<string, ToolStatus>([
          ['t1-tu', 'success'],
          ['t2-tu', 'success'],
        ]),
        working: true,
        closed: true,
        searchQuery: 'needle',
      })
      expect(isOpen(container)).toBe(true)
    })

    it('respects a manual open of a settled closed group', () => {
      const { container } = renderGroup({
        members: [toolMsg('t1'), toolMsg('t2')],
        toolStatus: new Map<string, ToolStatus>([
          ['t1-tu', 'success'],
          ['t2-tu', 'success'],
        ]),
        working: true,
        closed: true,
      })
      expect(isOpen(container)).toBe(false)
      fireEvent.click(container.querySelector('.tool-group-toggle')!)
      expect(isOpen(container)).toBe(true)
    })

    it('does not reopen a boundary-closed group via the turn-end settle hold', () => {
      vi.useFakeTimers()
      function H() {
        const [status, setStatus] = useState<Map<string, ToolStatus>>(
          new Map([
            ['t1-tu', 'success' as const],
            ['t2-tu', 'running' as const],
          ]),
        )
        const [closed] = useState(true)
        const [working, setWorking] = useState(true)
        const settle = () =>
          setStatus(new Map([['t1-tu', 'success' as const], ['t2-tu', 'success' as const]]))
        return (
          <ToolStatusProvider value={status}>
            <ToolResultProvider value={new Map()}>
              <PlanStatusProvider value={new Map()}>
                <BackgroundToolProvider value={undefined}>
                  <ToolGroupCard
                    members={[toolMsg('t1'), toolMsg('t2')]}
                    memberItemIndices={[0, 1]}
                    working={working}
                    closed={closed}
                  />
                  <button type="button" data-testid="settle" onClick={settle} />
                  <button type="button" data-testid="end" onClick={() => setWorking(false)} />
                </BackgroundToolProvider>
              </PlanStatusProvider>
            </ToolResultProvider>
          </ToolStatusProvider>
        )
      }
      const { container, getByTestId } = render(<H />)
      fireEvent.click(getByTestId('settle'))
      expect(isOpen(container)).toBe(false) // folds mid-turn once settled+closed
      fireEvent.click(getByTestId('end')) // turn ends — settleHold would reopen it
      expect(isOpen(container)).toBe(false) // closed group ignores settleHold
      act(() => {
        vi.advanceTimersByTime(2300)
      })
      expect(isOpen(container)).toBe(false) // stays folded after the hold elapses
    })
  })

  describe('turn boundary & settle-hold edge cases', () => {
    function TurnHarness() {
      const [status, setStatus] = useState<Map<string, ToolStatus>>(
        new Map([
          ['t1-tu', 'success' as const],
          ['t2-tu', 'running' as const],
        ]),
      )
      const [working, setWorking] = useState(true)
      const settle = () =>
        setStatus(new Map([['t1-tu', 'success' as const], ['t2-tu', 'success' as const]]))
      const members = [toolMsg('t1'), toolMsg('t2')]
      return (
        <ToolStatusProvider value={status}>
          <ToolResultProvider value={new Map()}>
            <PlanStatusProvider value={new Map()}>
              <BackgroundToolProvider value={undefined}>
                <ToolGroupCard members={members} memberItemIndices={[0, 1]} working={working} />
                <button type="button" data-testid="settle" onClick={settle} />
                <button type="button" data-testid="end" onClick={() => setWorking(false)} />
                <button type="button" data-testid="start" onClick={() => setWorking(true)} />
              </BackgroundToolProvider>
            </PlanStatusProvider>
          </ToolResultProvider>
        </ToolStatusProvider>
      )
    }

    it('does not reopen the previous turn tail group at the start of a new turn', () => {
      vi.useFakeTimers()
      const { container, getByTestId } = render(<TurnHarness />)
      expect(isOpen(container)).toBe(true) // running → live
      fireEvent.click(getByTestId('settle'))
      expect(isOpen(container)).toBe(true) // settled tail, may still grow
      fireEvent.click(getByTestId('end'))
      act(() => {
        vi.advanceTimersByTime(2300)
      })
      expect(isOpen(container)).toBe(false) // folded after the settle hold
      // A fresh turn starts. `wasLive` must reset so the previous turn's group
      // doesn't flash open again just because the session is working.
      fireEvent.click(getByTestId('start'))
      expect(isOpen(container)).toBe(false)
    })

    it('will not fold out from under the pointer, and folds once it leaves', () => {
      vi.useFakeTimers()
      const { container, getByTestId } = render(<TurnHarness />)
      fireEvent.click(getByTestId('settle'))
      fireEvent.click(getByTestId('end')) // grace window opens
      expect(isOpen(container)).toBe(true)
      const card = container.querySelector('.tool-group-card')! as HTMLElement
      // jsdom has no real hover state, and the component asks the DOM for it
      // (`:hover` also catches a stationary cursor the card grew underneath).
      const hover = vi.spyOn(card, 'matches').mockImplementation((sel) => sel === ':hover')
      act(() => {
        vi.advanceTimersByTime(5000)
      })
      expect(isOpen(container)).toBe(true) // someone is reading it
      hover.mockReturnValue(false)
      act(() => {
        vi.advanceTimersByTime(400) // next re-check after they leave
      })
      expect(isOpen(container)).toBe(false)
    })

    it('will not fold while a text selection runs through the card', () => {
      vi.useFakeTimers()
      const { container, getByTestId } = render(<TurnHarness />)
      fireEvent.click(getByTestId('settle'))
      fireEvent.click(getByTestId('end'))
      const card = container.querySelector('.tool-group-card')!
      vi.stubGlobal('getSelection', () => ({
        isCollapsed: false,
        rangeCount: 1,
        getRangeAt: () => ({ commonAncestorContainer: card }),
      }))
      act(() => {
        vi.advanceTimersByTime(5000)
      })
      expect(isOpen(container)).toBe(true) // copying something out of it

      vi.stubGlobal('getSelection', () => ({ isCollapsed: true, rangeCount: 0 }))
      act(() => {
        vi.advanceTimersByTime(400)
      })
      expect(isOpen(container)).toBe(false)
    })

    it('lets a user collapse a tail group during the settle hold', () => {
      vi.useFakeTimers()
      const { container, getByTestId } = render(<TurnHarness />)
      fireEvent.click(getByTestId('settle'))
      fireEvent.click(getByTestId('end')) // settle hold opens the tail group
      expect(isOpen(container)).toBe(true)
      // Explicit user fold inside the grace window must win over the hold.
      fireEvent.click(container.querySelector('.tool-group-toggle')!)
      expect(isOpen(container)).toBe(false)
      act(() => {
        vi.advanceTimersByTime(2300)
      })
      expect(isOpen(container)).toBe(false)
    })
  })
})
