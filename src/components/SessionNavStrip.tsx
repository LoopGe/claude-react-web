// Full-session navigation strip for the top header, shown while the desktop
// sidebar is collapsed (hosts without a custom titlebar — browser and Linux
// desktop; win/darwin Electron titlebars keep their own always-visible
// open-panel tabs instead).
//
// A compact stand-in for the sidebar's navigation: every session in sidebar
// order as a horizontally-scrollable tab row. Groups render as a clickable
// name chip (activates the group's panel view) followed by their member
// tabs; ungrouped sessions render as plain tabs. Clicking a tab routes
// through the same handler as a sidebar card click (open/switch + group
// activation + auto-resume + unread clear) — App owns that handler, this
// component is purely presentational.
//
// The strip renders even with zero sessions: the leading + is the only
// new-session entry point the header offers while the sidebar is hidden
// (same reasoning as the titlebar tabs' empty state).
//
// Structure: [+][scroller]. The + lives OUTSIDE the scroll region so the
// edge-fade mask can never ghost the primary new-session affordance.
//
// role="group" not "tablist": same call as .main-toolbar / titlebar tabs —
// the ARIA tab pattern promises arrow-key roving we don't implement.

import { memo, useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { SessionInfo, SidebarSection } from '../types'
import { sessionTitleOrFallback } from '../utils/session-title'

interface Props {
  sections: SidebarSection[]
  focusedId: string | null
  activeGroupId: string | null
  unread: Record<string, boolean>
  onSelect: (id: string) => void
  onActivateGroup: (groupId: string) => void
  onNew: () => void
}

/** Which horizontal edges of a scroller currently hide content. Pure so the
 *  scroll/resize wiring in the component stays trivial and the geometry rules
 *  are unit-testable. 1px epsilon mirrors overlay-scrollbar's sub-pixel guard:
 *  fractional overflow below a pixel is invisible and must not fade the edge. */
export function edgeFadeState(m: {
  scrollLeft: number
  scrollWidth: number
  clientWidth: number
}): { start: boolean; end: boolean } {
  const hiddenTotal = m.scrollWidth - m.clientWidth
  return {
    start: m.scrollLeft >= 1,
    end: hiddenTotal - m.scrollLeft >= 1,
  }
}

function SessionNavTab({
  session,
  focused,
  unread,
  onSelect,
}: {
  session: SessionInfo
  focused: boolean
  unread: boolean
  onSelect: (id: string) => void
}) {
  const label = sessionTitleOrFallback(session)
  return (
    <button
      type="button"
      className={`session-nav-tab${focused ? ' active' : ''}`}
      aria-pressed={focused}
      title={label}
      onClick={() => onSelect(session.id)}
    >
      <span className="session-nav-label">{label}</span>
      {/* Working wins over unread: a running turn is the stronger, live
          signal, and two adjacent 6px dots would read as one blob. */}
      {session.working ? (
        <span className="session-nav-dot" aria-hidden />
      ) : (
        unread && <span className="session-nav-unread" aria-hidden />
      )}
    </button>
  )
}

export const SessionNavStrip = memo(function SessionNavStrip({
  sections,
  focusedId,
  activeGroupId,
  unread,
  onSelect,
  onActivateGroup,
  onNew,
}: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [fade, setFade] = useState({ start: false, end: false })

  const syncFade = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const next = edgeFadeState({
      scrollLeft: el.scrollLeft,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    })
    setFade((prev) => (prev.start === next.start && prev.end === next.end ? prev : next))
  }, [])

  // Content-driven re-measure: sections churn (session created/renamed/deleted)
  // AND unread flips (a dot is ~10px of content width) change the scroll
  // region's content width without any scroll or viewport event.
  useEffect(() => {
    syncFade()
  }, [syncFade, sections, unread])

  // Scroll + viewport-driven re-measure. The scroller is always mounted (the
  // strip renders even with zero sessions), so one attach covers the
  // component's lifetime. ResizeObserver is absent in jsdom; there the scroll
  // listener + content effect cover what tests need.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.addEventListener('scroll', syncFade, { passive: true })
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(syncFade) : null
    ro?.observe(el)
    return () => {
      el.removeEventListener('scroll', syncFade)
      ro?.disconnect()
    }
  }, [syncFade])

  // The scroller hides its scrollbar, so a programmatically-focused session
  // (deep link, notification click, Alt+9 group activation) whose tab sits
  // off-screen would leave NO visible focus indicator. Pull the active tab
  // back into view on focus change. focusedId is not persisted, so a cold
  // start never has an active tab to scroll to — dep-change paths only.
  useEffect(() => {
    scrollRef.current
      ?.querySelector<HTMLElement>('.session-nav-tab.active')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [focusedId])

  // The CSS mask (on the scroller) reads these two vars; 0px degrades the
  // gradient to a hard stop, i.e. no fade on that edge.
  const fadeStyle = {
    '--fade-start-w': fade.start ? 'var(--fade-width)' : '0px',
    '--fade-end-w': fade.end ? 'var(--fade-width)' : '0px',
  } as CSSProperties

  const hasContent = sections.some((sec) => sec.sessions.length > 0)

  return (
    <div
      className="session-nav-strip"
      role="group"
      aria-label="All sessions"
      style={fadeStyle}
    >
      <button
        type="button"
        className="session-nav-new btn btn-icon"
        aria-label="New session"
        title="New session"
        onClick={onNew}
      >
        +
      </button>
      {/* Hairline between the + and the tab region — same border language as
          the inter-group separators. Lives OUTSIDE the scroller so the fade
          mask can never ghost it; omitted in the empty state (a lone line
          next to a lone + reads as a glitch). */}
      {hasContent && <div className="session-nav-divider" aria-hidden />}
      <div ref={scrollRef} className="session-nav-scroll">
        {sections.map((sec) =>
          sec.kind === 'group' ? (
            <div key={`g-${sec.group.id}`} className="session-nav-section">
              <button
                type="button"
                className={`session-nav-chip${activeGroupId === sec.group.id ? ' active' : ''}`}
                aria-pressed={activeGroupId === sec.group.id}
                title={sec.group.name}
                onClick={() => onActivateGroup(sec.group.id)}
              >
                {/* Ellipsis must live on a block-ish child, not the flex
                    container — text-overflow is inert on the button itself. */}
                <span className="session-nav-label">{sec.group.name}</span>
              </button>
              {sec.sessions.map((s) => (
                <SessionNavTab
                  key={s.id}
                  session={s}
                  focused={s.id === focusedId}
                  unread={!!unread[s.id]}
                  onSelect={onSelect}
                />
              ))}
            </div>
          ) : (
            sec.sessions.map((s) => (
              <SessionNavTab
                key={s.id}
                session={s}
                focused={s.id === focusedId}
                unread={!!unread[s.id]}
                onSelect={onSelect}
              />
            ))
          ),
        )}
      </div>
    </div>
  )
})
