import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, createEvent } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import { SessionNavStrip, edgeFadeState, stripDndPlan } from './SessionNavStrip'
import type { SessionInfo, SidebarSection } from '../types'

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 'abc12345-xxxx',
    title: 'Test Session',
    cwd: '/home/user/project',
    running: true,
    working: false,
    terminated: false,
    error: null,
    model: 'claude-sonnet-4-20250514',
    permissionMode: 'default',
    messageCount: 5,
    subscribers: 1,
    lastActivityAt: Date.now(),
    phase: 'idle',
    ...overrides,
  } as SessionInfo
}

const groupA = { id: 'g1', name: '前端', sessionIds: ['s1', 's2'] }

function baseSections(): SidebarSection[] {
  return [
    { kind: 'group', group: groupA, sessions: [makeSession({ id: 's1', title: 'Alpha' }), makeSession({ id: 's2', title: 'Beta' })] },
    { kind: 'ungrouped', sessions: [makeSession({ id: 's3', title: 'Gamma' })] },
  ]
}

function renderStrip(sections: SidebarSection[], overrides: Partial<Parameters<typeof SessionNavStrip>[0]> = {}) {
  // Handler overrides are honored (the Partial<Props> type invites passing
  // them); only the unwired ones fall back to local mocks.
  const onSelect = overrides.onSelect ?? vi.fn()
  const onActivateGroup = overrides.onActivateGroup ?? vi.fn()
  const onNew = overrides.onNew ?? vi.fn()
  const utils = render(
    <SessionNavStrip
      sections={sections}
      focusedId={overrides.focusedId ?? null}
      activeGroupId={overrides.activeGroupId ?? null}
      unread={overrides.unread ?? {}}
      onSelect={onSelect}
      onActivateGroup={onActivateGroup}
      onNew={onNew}
      onSessionContextMenu={overrides.onSessionContextMenu}
      onGroupContextMenu={overrides.onGroupContextMenu}
    />,
  )
  return { onSelect, onActivateGroup, onNew, ...utils }
}

describe('edgeFadeState', () => {
  it('fades neither edge when the content fits', () => {
    expect(edgeFadeState({ scrollLeft: 0, scrollWidth: 100, clientWidth: 200 })).toEqual({ start: false, end: false })
  })

  it('fades only the end while at the scroll origin', () => {
    expect(edgeFadeState({ scrollLeft: 0, scrollWidth: 300, clientWidth: 200 })).toEqual({ start: false, end: true })
  })

  it('fades both edges mid-scroll', () => {
    expect(edgeFadeState({ scrollLeft: 60, scrollWidth: 300, clientWidth: 200 })).toEqual({ start: true, end: true })
  })

  it('fades only the start when scrolled to the far end', () => {
    expect(edgeFadeState({ scrollLeft: 100, scrollWidth: 300, clientWidth: 200 })).toEqual({ start: true, end: false })
  })

  it('treats sub-pixel overflow as fitting (1px epsilon)', () => {
    expect(edgeFadeState({ scrollLeft: 0, scrollWidth: 200.5, clientWidth: 200 })).toEqual({ start: false, end: false })
  })
})

/** jsdom exposes scroll* as 0; shadow the instance properties so the fade
 *  wiring's geometry reads can be driven from tests. */
function mockStripGeometry(strip: HTMLElement, scrollLeft: number, scrollWidth: number, clientWidth: number): void {
  Object.defineProperty(strip, 'scrollLeft', { value: scrollLeft, writable: true, configurable: true })
  Object.defineProperty(strip, 'scrollWidth', { value: scrollWidth, writable: true, configurable: true })
  Object.defineProperty(strip, 'clientWidth', { value: clientWidth, writable: true, configurable: true })
}

describe('SessionNavStrip', () => {
  it('renders group chips and session tabs in sidebar order', () => {
    const { container } = renderStrip(baseSections())
    const labels = Array.from(
      container.querySelectorAll<HTMLElement>('.session-nav-chip, .session-nav-tab'),
    ).map((el) => el.textContent)
    expect(labels).toEqual(['前端', 'Alpha', 'Beta', 'Gamma'])
  })

  it('selects a session on tab click', () => {
    const { onSelect } = renderStrip(baseSections())
    fireEvent.click(screen.getByTitle('Alpha'))
    expect(onSelect).toHaveBeenCalledWith('s1')
  })

  it('activates a group on chip click', () => {
    const { onActivateGroup } = renderStrip(baseSections())
    fireEvent.click(screen.getByTitle('前端'))
    expect(onActivateGroup).toHaveBeenCalledWith('g1')
  })

  it('marks the focused tab and active group chip as pressed', () => {
    renderStrip(baseSections(), { focusedId: 's2', activeGroupId: 'g1' })
    expect(screen.getByTitle('Alpha').getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByTitle('Beta').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTitle('前端').getAttribute('aria-pressed')).toBe('true')
  })

  it('renders the working dot only for working sessions', () => {
    const sections: SidebarSection[] = [
      { kind: 'ungrouped', sessions: [makeSession({ id: 's1', working: true }), makeSession({ id: 's2', working: false })] },
    ]
    const { container } = renderStrip(sections)
    expect(container.querySelectorAll('.session-nav-dot')).toHaveLength(1)
  })

  it('renders the unread dot per the unread map', () => {
    const sections: SidebarSection[] = [
      { kind: 'ungrouped', sessions: [makeSession({ id: 's1' }), makeSession({ id: 's2' })] },
    ]
    const { container } = renderStrip(sections, { unread: { s1: true, s2: false } })
    expect(container.querySelectorAll('.session-nav-unread')).toHaveLength(1)
  })

  it('suppresses the unread dot while the session is working', () => {
    const sections: SidebarSection[] = [
      { kind: 'ungrouped', sessions: [makeSession({ id: 's1', working: true })] },
    ]
    const { container } = renderStrip(sections, { unread: { s1: true } })
    expect(container.querySelectorAll('.session-nav-dot')).toHaveLength(1)
    expect(container.querySelectorAll('.session-nav-unread')).toHaveLength(0)
  })

  it('keeps the focused tab scrolled into view when focus changes', () => {
    const sections: SidebarSection[] = [
      { kind: 'ungrouped', sessions: [makeSession({ id: 's1', title: 'One' }), makeSession({ id: 's2', title: 'Two' }), makeSession({ id: 's3', title: 'Three' })] },
    ]
    const scrollIntoView = vi.fn()
    const spy = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(scrollIntoView)
    try {
      const { rerender } = renderStrip(sections)
      // Nothing focused yet → no scrolling.
      expect(scrollIntoView).not.toHaveBeenCalled()
      rerender(
        <SessionNavStrip
          sections={sections}
          focusedId="s3"
          activeGroupId={null}
          unread={{}}
          onSelect={vi.fn()}
          onActivateGroup={vi.fn()}
          onNew={vi.fn()}
        />,
      )
      expect(scrollIntoView).toHaveBeenCalledTimes(1)
      // The scrolled element is the newly-focused tab.
      const calledOn = spy.mock.instances[0] as unknown as HTMLElement
      expect(calledOn.title).toBe('Three')
    } finally {
      spy.mockRestore()
    }
  })

  it('still offers + when there are no sessions', () => {
    // Collapsed sidebar + zero sessions must keep a visible new-session
    // entry point — the strip renders the + alone.
    const { container, onNew } = renderStrip([])
    const plus = screen.getByLabelText('New session')
    expect(plus).toBeTruthy()
    expect(container.querySelectorAll('.session-nav-tab')).toHaveLength(0)
    fireEvent.click(plus)
    expect(onNew).toHaveBeenCalled()
  })

  it('renders + before the tabs, outside the scroll region', () => {
    const { container } = renderStrip(baseSections())
    const strip = container.querySelector<HTMLElement>('.session-nav-strip')!
    expect(strip.firstElementChild!.classList.contains('session-nav-new')).toBe(true)
    // The + must not live inside the masked scroller — the fade would ghost
    // the primary new-session affordance once content overflows.
    const scroller = container.querySelector<HTMLElement>('.session-nav-scroll')!
    expect(scroller).toBeTruthy()
    expect(scroller.querySelector('.session-nav-new')).toBeNull()
  })

  it('fires onNew from the + button', () => {
    const { container, onNew } = renderStrip(baseSections())
    fireEvent.click(container.querySelector<HTMLElement>('.session-nav-new')!)
    expect(onNew).toHaveBeenCalledTimes(1)
  })

  it('renders a divider between + and the scroll region when sessions exist', () => {
    const { container } = renderStrip(baseSections())
    const children = Array.from(
      container.querySelector<HTMLElement>('.session-nav-strip')!.children,
    )
    expect(children[0].classList.contains('session-nav-new')).toBe(true)
    expect(children[1].classList.contains('session-nav-divider')).toBe(true)
    expect(children[2].classList.contains('session-nav-scroll')).toBe(true)
  })

  it('omits the divider when there are no sessions', () => {
    const { container } = renderStrip([])
    expect(container.querySelector('.session-nav-divider')).toBeNull()
  })

  it('falls back to the id prefix for an untitled session', () => {
    const sections: SidebarSection[] = [
      { kind: 'ungrouped', sessions: [makeSession({ id: 'deadbeef-1234', title: undefined })] },
    ]
    renderStrip(sections)
    expect(screen.getByTitle('deadbeef')).toBeTruthy()
  })

  it('updates the fade vars when the strip scrolls', () => {
    const sections: SidebarSection[] = [
      { kind: 'ungrouped', sessions: [makeSession({ id: 's1' }), makeSession({ id: 's2' }), makeSession({ id: 's3' })] },
    ]
    const { container } = renderStrip(sections)
    const scroller = container.querySelector<HTMLElement>('.session-nav-scroll')!
    const strip = container.querySelector<HTMLElement>('.session-nav-strip')!
    mockStripGeometry(scroller, 0, 300, 200)
    fireEvent.scroll(scroller)
    // At the scroll origin: only the far edge hides content.
    expect(strip.style.getPropertyValue('--fade-start-w')).toBe('0px')
    expect(strip.style.getPropertyValue('--fade-end-w')).toBe('var(--fade-width)')
    scroller.scrollLeft = 100
    fireEvent.scroll(scroller)
    // Scrolled to the far end: the ramp flips to the start edge.
    expect(strip.style.getPropertyValue('--fade-start-w')).toBe('var(--fade-width)')
    expect(strip.style.getPropertyValue('--fade-end-w')).toBe('0px')
  })

  it('keeps the fade wiring alive as content appears after an empty strip', () => {
    // Cold start: sessions=[] → the strip renders just the +. When tabs
    // appear (WS snapshot) the scroll wiring must measure and fire.
    const sections: SidebarSection[] = [
      { kind: 'ungrouped', sessions: [makeSession({ id: 's1' }), makeSession({ id: 's2' })] },
    ]
    const { container, rerender } = render(
      <SessionNavStrip sections={[]} focusedId={null} activeGroupId={null} unread={{}} onSelect={vi.fn()} onActivateGroup={vi.fn()} onNew={vi.fn()} />,
    )
    expect(container.querySelector<HTMLElement>('.session-nav-new')).toBeTruthy()
    rerender(
      <SessionNavStrip sections={sections} focusedId={null} activeGroupId={null} unread={{}} onSelect={vi.fn()} onActivateGroup={vi.fn()} onNew={vi.fn()} />,
    )
    const scroller = container.querySelector<HTMLElement>('.session-nav-scroll')!
    const strip = container.querySelector<HTMLElement>('.session-nav-strip')!
    mockStripGeometry(scroller, 0, 300, 200)
    fireEvent.scroll(scroller)
    expect(strip.style.getPropertyValue('--fade-end-w')).toBe('var(--fade-width)')
  })
})

describe('SessionNavStrip drag', () => {
  /** Real DndContext + sensors-free (App supplies sensors): the strip's own
   *  contract is the registration (node id / payload / extras) and click
   *  passthrough; drop routing lives in App's kind-based handlers and is
   *  exercised by the sidebar drags that share those handlers. */
  function renderDndStrip(sections: SidebarSection[], onDragStart: (e: unknown) => void) {
    return render(
      <DndContext onDragStart={onDragStart}>
        <SessionNavStrip
          sections={sections}
          focusedId={null}
          activeGroupId={null}
          unread={{}}
          onSelect={vi.fn()}
          onActivateGroup={vi.fn()}
          onNew={vi.fn()}
        />
      </DndContext>,
    )
  }

  it('starts a tab drag with the namespaced node and the routed payload', async () => {
    const onDragStart = vi.fn()
    renderDndStrip(baseSections(), onDragStart)
    const tab = screen.getByTitle('Alpha')
    fireEvent.pointerDown(tab, { button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: 10, clientY: 10 })
    try {
      fireEvent.pointerMove(document.body, { pointerId: 1, clientX: 60, clientY: 10 })
      expect(onDragStart).toHaveBeenCalledTimes(1)
      const active = (onDragStart.mock.calls[0][0] as { active: { data: { current: Record<string, unknown> } } }).active
      expect(active.data.current.crw).toEqual({ kind: 'sidebar-card', id: 's1' })
      expect(active.data.current.containerGroupId).toBe('g1')
      expect(active.data.current.origin).toBe('strip')
    } finally {
      // Release the sensor and wait out dnd-kit's teardown: while a sensor
      // was active it stopped propagation of document-level clicks (capture),
      // and detach() only removes those listeners via a 50ms timer — without
      // the wait, every subsequent test in this file loses its click events.
      fireEvent.pointerUp(document.body, { pointerId: 1, clientX: 60, clientY: 10 })
      await new Promise((resolve) => setTimeout(resolve, 60))
    }
  })

  it('starts a chip drag with the group payload and x axis', async () => {
    const onDragStart = vi.fn()
    // Two groups: a lone group's chip is drag-disabled (same rule as the
    // sidebar pills).
    const twoGroups: SidebarSection[] = [
      baseSections()[0],
      {
        kind: 'group',
        group: { id: 'g2', name: 'G2', sessionIds: ['s3'] },
        sessions: [makeSession({ id: 's3', title: 'Gamma' })],
      },
    ]
    renderDndStrip(twoGroups, onDragStart)
    const chip = screen.getByTitle('前端')
    fireEvent.pointerDown(chip, { button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: 10, clientY: 10 })
    try {
      fireEvent.pointerMove(document.body, { pointerId: 1, clientX: 90, clientY: 10 })
      expect(onDragStart).toHaveBeenCalledTimes(1)
      const active = (onDragStart.mock.calls[0][0] as { active: { data: { current: Record<string, unknown> } } }).active
      expect(active.data.current.crw).toEqual({ kind: 'group-card', id: 'g1' })
      expect(active.data.current.axis).toBe('x')
    } finally {
      fireEvent.pointerUp(document.body, { pointerId: 1, clientX: 90, clientY: 10 })
      await new Promise((resolve) => setTimeout(resolve, 60))
    }
  })

  it('keeps click working with drag listeners attached (5px activation)', () => {
    const onSelect = vi.fn()
    render(
      <DndContext>
        <SessionNavStrip
          sections={baseSections()}
          focusedId={null}
          activeGroupId={null}
          unread={{}}
          onSelect={onSelect}
          onActivateGroup={vi.fn()}
          onNew={vi.fn()}
        />
      </DndContext>,
    )
    fireEvent.click(screen.getByTitle('Alpha'))
    expect(onSelect).toHaveBeenCalledWith('s1')
  })
})

describe('stripDndPlan', () => {
  const dndSections: SidebarSection[] = [
    {
      kind: 'group',
      group: { id: 'g1', name: 'G1', sessionIds: ['s1', 's2'] },
      sessions: [makeSession({ id: 's1' }), makeSession({ id: 's2' })],
    },
    { kind: 'ungrouped', sessions: [makeSession({ id: 's3' })] },
  ]

  it('namespaces node ids (the collapsed sidebar stays mounted and shares the App DndContext) while payloads keep business ids', () => {
    const plan = stripDndPlan(dndSections)
    const g1 = plan.sections[0]
    expect(g1.chip!.nodeId).toBe('strip-chip-g1')
    expect(g1.tabs.map((t) => t.nodeId)).toEqual(['strip-s1', 'strip-s2'])
    expect(g1.chip!.id).toBe('g1')
    expect(g1.tabs.map((t) => t.id)).toEqual(['s1', 's2'])
  })

  it('partitions contexts: one outer chip list, one member list per section', () => {
    const plan = stripDndPlan(dndSections)
    expect(plan.chipItems).toEqual(['strip-chip-g1'])
    expect(plan.sections[0].tabItems).toEqual(['strip-s1', 'strip-s2'])
    expect(plan.sections[1].tabItems).toEqual(['strip-s3'])
    // Ungrouped sections carry no chip.
    expect(plan.sections[1].chip).toBeUndefined()
  })

  it('tags session payloads as sidebar-card with containerGroupId + strip origin, chips as group-card with x axis', () => {
    const plan = stripDndPlan(dndSections)
    const [t1] = plan.sections[0].tabs
    expect(t1.data.crw).toEqual({ kind: 'sidebar-card', id: 's1' })
    expect(t1.data.containerGroupId).toBe('g1')
    expect(t1.data.origin).toBe('strip')
    // Tabs carry axis:'x' too — App's positionFromOver reads it off the OVER
    // node; a one-row strip's identical tops would otherwise always commit
    // 'after' (leftward drags would silently no-op).
    expect(t1.data.axis).toBe('x')
    const ungrouped = plan.sections[1].tabs[0]
    expect(ungrouped.data.containerGroupId).toBeUndefined()
    expect(ungrouped.data.origin).toBe('strip')
    expect(ungrouped.data.axis).toBe('x')
    const chip = plan.sections[0].chip!
    expect(chip.data.crw).toEqual({ kind: 'group-card', id: 'g1' })
    expect(chip.data.axis).toBe('x')
    expect(chip.data.origin).toBe('strip')
  })

  it('returns an empty plan for an empty strip', () => {
    const plan = stripDndPlan([])
    expect(plan.chipItems).toEqual([])
    expect(plan.sections).toEqual([])
  })
})

describe('SessionNavStrip context menus', () => {
  it('reports a session tab right-click with the event and session id', () => {
    const onSessionContextMenu = vi.fn()
    renderStrip(baseSections(), { onSessionContextMenu })
    const tab = screen.getByTitle('Alpha')
    const ev = createEvent.contextMenu(tab, { clientX: 12, clientY: 34 })
    fireEvent(tab, ev)
    expect(onSessionContextMenu).toHaveBeenCalledTimes(1)
    expect(onSessionContextMenu.mock.calls[0][1]).toBe('s1')
  })

  it('prevents the native menu only when the session callback is wired', () => {
    const sections = baseSections()
    const wired = render(<SessionNavStrip sections={sections} focusedId={null} activeGroupId={null} unread={{}} onSelect={vi.fn()} onActivateGroup={vi.fn()} onNew={vi.fn()} onSessionContextMenu={vi.fn()} />)
    const wiredTab = wired.container.querySelector<HTMLElement>('.session-nav-tab')!
    const wiredEv = createEvent.contextMenu(wiredTab)
    fireEvent(wiredTab, wiredEv)
    expect(wiredEv.defaultPrevented).toBe(true)

    const unwired = renderStrip(sections)
    const unwiredTab = unwired.container.querySelector<HTMLElement>('.session-nav-tab')!
    const unwiredEv = createEvent.contextMenu(unwiredTab)
    fireEvent(unwiredTab, unwiredEv)
    // No handler → the browser's own menu must stay available.
    expect(unwiredEv.defaultPrevented).toBe(false)
  })

  it('right-click does not select the session', () => {
    const onSelect = vi.fn()
    renderStrip(baseSections(), { onSelect, onSessionContextMenu: vi.fn() })
    const ev = createEvent.contextMenu(screen.getByTitle('Alpha'))
    fireEvent(screen.getByTitle('Alpha'), ev)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('reports a group chip right-click with the event and group id', () => {
    const onGroupContextMenu = vi.fn()
    renderStrip(baseSections(), { onGroupContextMenu })
    const chip = screen.getByTitle('前端')
    const ev = createEvent.contextMenu(chip)
    fireEvent(chip, ev)
    expect(onGroupContextMenu).toHaveBeenCalledTimes(1)
    expect(onGroupContextMenu.mock.calls[0][1]).toBe('g1')
  })

  it('right-click does not activate the group', () => {
    const onActivateGroup = vi.fn()
    renderStrip(baseSections(), { onActivateGroup, onGroupContextMenu: vi.fn() })
    const chip = screen.getByTitle('前端')
    fireEvent(chip, createEvent.contextMenu(chip))
    expect(onActivateGroup).not.toHaveBeenCalled()
  })

  it('prevents the native menu only when the group callback is wired', () => {
    const sections = baseSections()
    const wired = render(<SessionNavStrip sections={sections} focusedId={null} activeGroupId={null} unread={{}} onSelect={vi.fn()} onActivateGroup={vi.fn()} onNew={vi.fn()} onGroupContextMenu={vi.fn()} />)
    const wiredChip = wired.container.querySelector<HTMLElement>('.session-nav-chip')!
    const wiredEv = createEvent.contextMenu(wiredChip)
    fireEvent(wiredChip, wiredEv)
    expect(wiredEv.defaultPrevented).toBe(true)

    const unwired = renderStrip(sections)
    const unwiredChip = unwired.container.querySelector<HTMLElement>('.session-nav-chip')!
    const unwiredEv = createEvent.contextMenu(unwiredChip)
    fireEvent(unwiredChip, unwiredEv)
    expect(unwiredEv.defaultPrevented).toBe(false)
  })
})
