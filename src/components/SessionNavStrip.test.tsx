import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SessionNavStrip, edgeFadeState } from './SessionNavStrip'
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
  const onSelect = vi.fn()
  const onActivateGroup = vi.fn()
  const utils = render(
    <SessionNavStrip
      sections={sections}
      focusedId={overrides.focusedId ?? null}
      activeGroupId={overrides.activeGroupId ?? null}
      unread={overrides.unread ?? {}}
      onSelect={onSelect}
      onActivateGroup={onActivateGroup}
    />,
  )
  return { onSelect, onActivateGroup, ...utils }
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

  it('renders nothing when there are no sessions', () => {
    const { container } = renderStrip([])
    expect(container.firstElementChild).toBeNull()
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
    const strip = container.querySelector<HTMLElement>('.session-nav-strip')!
    mockStripGeometry(strip, 0, 300, 200)
    fireEvent.scroll(strip)
    // At the scroll origin: only the far edge hides content.
    expect(strip.style.getPropertyValue('--fade-start-w')).toBe('0px')
    expect(strip.style.getPropertyValue('--fade-end-w')).toBe('var(--fade-width)')
    strip.scrollLeft = 100
    fireEvent.scroll(strip)
    // Scrolled to the far end: the ramp flips to the start edge.
    expect(strip.style.getPropertyValue('--fade-start-w')).toBe('var(--fade-width)')
    expect(strip.style.getPropertyValue('--fade-end-w')).toBe('0px')
  })

  it('attaches the fade wiring even when the first render was empty', () => {
    // Cold start: sessions=[] → the strip renders null; listeners must still
    // attach once sessions arrive (regression for the dead-wiring bug).
    const sections: SidebarSection[] = [
      { kind: 'ungrouped', sessions: [makeSession({ id: 's1' }), makeSession({ id: 's2' })] },
    ]
    const { container, rerender } = render(
      <SessionNavStrip sections={[]} focusedId={null} activeGroupId={null} unread={{}} onSelect={vi.fn()} onActivateGroup={vi.fn()} />,
    )
    expect(container.firstElementChild).toBeNull()
    rerender(
      <SessionNavStrip sections={sections} focusedId={null} activeGroupId={null} unread={{}} onSelect={vi.fn()} onActivateGroup={vi.fn()} />,
    )
    const strip = container.querySelector<HTMLElement>('.session-nav-strip')!
    mockStripGeometry(strip, 0, 300, 200)
    fireEvent.scroll(strip)
    expect(strip.style.getPropertyValue('--fade-end-w')).toBe('var(--fade-width)')
  })
})
