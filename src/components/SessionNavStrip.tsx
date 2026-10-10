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

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { SortableContext, horizontalListSortingStrategy } from '@dnd-kit/sortable'
import type { SessionInfo, SidebarSection } from '../types'
import { sessionTitleOrFallback } from '../utils/session-title'
import { dndData } from '../dnd/payload'
import { SortableNode } from '../dnd/SortableNode'

interface Props {
  sections: SidebarSection[]
  focusedId: string | null
  activeGroupId: string | null
  unread: Record<string, boolean>
  onSelect: (id: string) => void
  onActivateGroup: (groupId: string) => void
  onNew: () => void
  /** Right-click management hooks, mirroring the sidebar cards / group
   *  pills. The strip stays presentational: it only forwards the event —
   *  the caller owns menu state and the management handlers. Unwired =
   *  native browser menu (no preventDefault). */
  onSessionContextMenu?: (e: React.MouseEvent, sessionId: string) => void
  onGroupContextMenu?: (e: React.MouseEvent, groupId: string) => void
  /** Sessions whose tab must not start a drag (resuming / deleting) — the
   *  same guards the sidebar cards apply before enabling their sortables. */
  resumingIds?: ReadonlySet<string>
  deletingIds?: ReadonlySet<string>
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

// ── Drag-and-drop plan ────────────────────────────────────────────
// The strip reuses the App DndContext's payload pipeline (sidebar-card /
// group-card kinds — handleDndOver/End route on kind, so strip drags ride the
// exact same reorder / move-into-group / drop-onto-panel handlers as the
// sidebar). Two constraints shape the registration:
//
//  1. NODE-ID NAMESPACING — the collapsed sidebar stays MOUNTED (inert), so
//     its sortable nodes are still registered with the same DndContext. Strip
//     node ids are prefixed (`strip-…`) to keep the registry unique; payload
//     ids stay the business ids the App handlers route on.
//  2. CONTEXT PARTITIONING — one outer SortableContext holds ONLY the group
//     chips (horizontal displacement sweeps chip order), and each section's
//     member tabs nest in their own context, so a tab drag displaces just its
//     own container's members — same semantics as the sidebar, transposed to
//     one row.
//
// Pure so the structure is unit-testable; the component maps it 1:1.

/** `origin: 'strip'` extra on every strip payload — renderDndGhost branches
 *  on it to lift a compact nav ghost instead of the sidebar's wide card. */
export const STRIP_DND_ORIGIN = 'strip'

export interface StripDndItem {
  /** dnd-kit node id — namespaced, unique within the App DndContext. */
  nodeId: string
  /** Business id inside the payload (real session / group id). */
  id: string
  kind: 'sidebar-card' | 'group-card'
  /** Full `data` prop: payload under `crw` + extras. */
  data: Record<string, unknown>
}

export interface StripDndSectionPlan {
  chip?: StripDndItem
  tabs: StripDndItem[]
  /** This section's member-tab node ids, strip order (the inner context). */
  tabItems: string[]
}

export interface StripDndPlan {
  /** Outer context items — chip node ids only, strip order. */
  chipItems: string[]
  sections: StripDndSectionPlan[]
}

export function stripDndPlan(sections: SidebarSection[]): StripDndPlan {
  const chipItems: string[] = []
  const out: StripDndSectionPlan[] = []
  for (const sec of sections) {
    const tabs: StripDndItem[] = sec.sessions.map((s) => ({
      nodeId: `strip-${s.id}`,
      id: s.id,
      kind: 'sidebar-card' as const,
      data: dndData(
        { kind: 'sidebar-card', id: s.id },
        {
          // axis:'x' is what App's positionFromOver reads to commit
          // before/after from the HORIZONTAL midpoint — without it a
          // one-row strip's identical tops always commit 'after'.
          axis: 'x',
          ...(sec.kind === 'group' ? { containerGroupId: sec.group.id } : {}),
          origin: STRIP_DND_ORIGIN,
        },
      ),
    }))
    let chip: StripDndItem | undefined
    if (sec.kind === 'group') {
      chip = {
        nodeId: `strip-chip-${sec.group.id}`,
        id: sec.group.id,
        kind: 'group-card' as const,
        data: dndData(
          { kind: 'group-card', id: sec.group.id },
          { axis: 'x', origin: STRIP_DND_ORIGIN },
        ),
      }
      chipItems.push(chip.nodeId)
    }
    out.push({ chip, tabs, tabItems: tabs.map((t) => t.nodeId) })
  }
  return { chipItems, sections: out }
}

/** Shared tab status dots (working pulse / unread bright) — the live tab and
 *  its drag ghost render the identical block so the two can't drift apart. */
function NavTabDots({ working, unread }: { working: boolean; unread?: boolean }) {
  // Working wins over unread: a running turn is the stronger, live
  // signal, and two adjacent 6px dots would read as one blob.
  if (working) return <span className="session-nav-dot" aria-hidden />
  if (unread) return <span className="session-nav-unread" aria-hidden />
  return null
}

function SessionNavTab({
  session,
  focused,
  unread,
  onSelect,
  onContextMenu,
  dnd,
  dndDisabled,
}: {
  session: SessionInfo
  focused: boolean
  unread: boolean
  onSelect: (id: string) => void
  onContextMenu?: (e: React.MouseEvent, sessionId: string) => void
  /** Drag registration from stripDndPlan — one entry per rendered tab (the
   *  plan always emits them), wrapping the tab in a SortableNode. */
  dnd: StripDndItem
  dndDisabled?: boolean
}) {
  const label = sessionTitleOrFallback(session)
  const content = (
    <>
      <span className="session-nav-label">{label}</span>
      <NavTabDots working={session.working} unread={unread} />
    </>
  )
  return (
    <SortableNode id={dnd.nodeId} data={dnd.data} disabled={!!dndDisabled} className="session-nav-slot">
      {({ isDragging, setActivatorNodeRef, listeners }) => (
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...listeners}
          className={`session-nav-tab${focused ? ' active' : ''}${isDragging ? ' dragging' : ''}`}
          aria-pressed={focused}
          title={label}
          onClick={() => onSelect(session.id)}
          // preventDefault lives here (not in the caller) so the native menu
          // is suppressed synchronously, before any state update can render.
          onContextMenu={onContextMenu
            ? (e: React.MouseEvent) => { e.preventDefault(); onContextMenu(e, session.id) }
            : undefined}
        >
          {content}
        </button>
      )}
    </SortableNode>
  )
}

/** Compact drag ghosts for strip-originated drags — the lifted item IS the
 *  tab / chip (the sidebar is hidden while the strip is up, so its wide card
 *  ghost's geometry would be meaningless). Rendered by App's renderDndGhost
 *  inside DragGhost; spans (not buttons) because the ghost is inert. */
export function SessionNavTabGhost({ session, unread }: {
  session: SessionInfo
  unread?: boolean
}) {
  const label = sessionTitleOrFallback(session)
  return (
    <span className="session-nav-tab session-nav-tab-ghost">
      <span className="session-nav-label">{label}</span>
      <NavTabDots working={session.working} unread={unread} />
    </span>
  )
}

export function SessionNavChipGhost({ name }: { name: string }) {
  return (
    <span className="session-nav-chip session-nav-chip-ghost">
      <span className="session-nav-label">{name}</span>
    </span>
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
  onSessionContextMenu,
  onGroupContextMenu,
  resumingIds,
  deletingIds,
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

  // Drag registration. The plan is pure structure (node ids / payloads /
  // context partitioning); the disable rules are render-time state, mirroring
  // the sidebar: a tab that's resuming or deleting can't be picked up, and a
  // lone group's chip can't reorder (same rule as the sidebar pills).
  const plan = useMemo(() => stripDndPlan(sections), [sections])
  const chipDndDisabled = sections.filter((s) => s.kind === 'group').length <= 1
  const tabDndDisabled = useCallback(
    (s: SessionInfo) => !!(resumingIds?.has(s.id) || deletingIds?.has(s.id)),
    [resumingIds, deletingIds],
  )

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
        {/* Outer context = chips only (see stripDndPlan for the partitioning
            rationale); member tabs nest in their own per-section contexts. */}
        <SortableContext items={plan.chipItems} strategy={horizontalListSortingStrategy}>
          {sections.map((sec, i) => {
            const sp = plan.sections[i]
            return sec.kind === 'group' ? (
              <div key={`g-${sec.group.id}`} className="session-nav-section">
                {/* sp.chip is always defined in a group section (the plan
                    emits one per group). The extraDrop keeps the chip a
                    "drop session into group" target while its sortable is
                    disabled (single group can't reorder) — same split as the
                    sidebar's group section header. */}
                <SortableNode
                  id={sp.chip!.nodeId}
                  data={sp.chip!.data}
                  disabled={chipDndDisabled}
                  className="session-nav-slot"
                  extraDrop={{
                    id: `strip-chip-drop-${sec.group.id}`,
                    data: dndData(
                      { kind: 'group-card', id: sec.group.id },
                      { axis: 'x', origin: STRIP_DND_ORIGIN },
                    ),
                    disabled: false,
                  }}
                >
                  {({ isDragging, setActivatorNodeRef, listeners }) => (
                    <button
                      type="button"
                      ref={setActivatorNodeRef}
                      {...listeners}
                      className={`session-nav-chip${activeGroupId === sec.group.id ? ' active' : ''}${isDragging ? ' dragging' : ''}`}
                      aria-pressed={activeGroupId === sec.group.id}
                      title={sec.group.name}
                      onClick={() => onActivateGroup(sec.group.id)}
                      onContextMenu={onGroupContextMenu ? (e) => { e.preventDefault(); onGroupContextMenu(e, sec.group.id) } : undefined}
                    >
                      {/* Ellipsis must live on a block-ish child, not the flex
                          container — text-overflow is inert on the button itself. */}
                      <span className="session-nav-label">{sec.group.name}</span>
                    </button>
                  )}
                </SortableNode>
                <SortableContext items={sp.tabItems} strategy={horizontalListSortingStrategy}>
                  {sec.sessions.map((s, j) => (
                    <SessionNavTab
                      key={s.id}
                      session={s}
                      focused={s.id === focusedId}
                      unread={!!unread[s.id]}
                      onSelect={onSelect}
                      onContextMenu={onSessionContextMenu}
                      dnd={sp.tabs[j]}
                      dndDisabled={tabDndDisabled(s)}
                    />
                  ))}
                </SortableContext>
              </div>
            ) : (
              <SortableContext key={`u-${i}`} items={sp.tabItems} strategy={horizontalListSortingStrategy}>
                {sec.sessions.map((s, j) => (
                  <SessionNavTab
                    key={s.id}
                    session={s}
                    focused={s.id === focusedId}
                    unread={!!unread[s.id]}
                    onSelect={onSelect}
                    onContextMenu={onSessionContextMenu}
                    dnd={sp.tabs[j]}
                    dndDisabled={tabDndDisabled(s)}
                  />
                ))}
              </SortableContext>
            )
          })}
        </SortableContext>
      </div>
    </div>
  )
})
