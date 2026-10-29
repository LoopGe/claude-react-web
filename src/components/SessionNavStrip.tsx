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
// create entry point the header offers while the sidebar is hidden
// (same reasoning as the titlebar tabs' empty state). The + opens a small
// create menu (New session… / New group…) rather than immediately creating
// a session — see CreateMenuButton.
//
// Structure: [+][scroller]. The + lives OUTSIDE the scroll region so the
// edge-fade mask can never ghost the primary create affordance.
//
// role="group" not "tablist": same call as .main-toolbar / titlebar tabs —
// the ARIA tab pattern promises arrow-key roving we don't implement.

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { SortableContext, horizontalListSortingStrategy } from '@dnd-kit/sortable'
import type { SessionInfo, SidebarSection } from '../types'
import { sessionTitleOrFallback } from '../utils/session-title'
import { tabDotStatus, tabTitle } from '../utils/session-status'
import type { TabDotStatus } from '../utils/session-status'
import { dndData } from '../dnd/payload'
import { SortableNode } from '../dnd/SortableNode'
import { CreateMenuButton } from './CreateMenuButton'
import type { PromptRequest } from '../hooks/useDialogHosts'
import { useExitRetention } from '../hooks/useExitRetention'
import { NAV_ITEM_ID_ATTR } from '../utils/flip'
import { prefersReducedMotion } from '../utils/reduced-motion'

interface Props {
  sections: SidebarSection[]
  focusedId: string | null
  activeGroupId: string | null
  unread: Record<string, boolean>
  onSelect: (id: string) => void
  onActivateGroup: (groupId: string) => void
  /** Create-menu actions (the leading + opens the menu first). */
  onNewSession: () => void
  onCreateGroup: (name: string) => void
  askPrompt: (config: PromptRequest) => void
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
  /** The strip shell is playing its exit (sidebar expanding) — the parent
   *  holds the unmount for one exit window via useExitRetention and drops
   *  this class when the window closes. */
  exiting?: boolean
  /** First-sight ids for the mount pop. The default is per-instance (fresh
   *  set each strip mount); App passes one session-lifetime set so a sidebar
   *  re-collapse doesn't re-pop every already-open tab. */
  poppedIdsRef?: { current: Set<string> }
}

/** Which horizontal edges of a scroller currently hide content. Pure so the
 *  scroll/resize wiring in the component stays trivial and the geometry rules
 *  are unit-testable. 1px epsilon mirrors overlay-scrollbar's sub-pixel guard:
 *  fractional overflow below a pixel is invisible and must not fade the edge. */
export function edgeFadeState(m: { scrollLeft: number; scrollWidth: number; clientWidth: number }): {
  start: boolean
  end: boolean
} {
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
        data: dndData({ kind: 'group-card', id: sec.group.id }, { axis: 'x', origin: STRIP_DND_ORIGIN }),
      }
      chipItems.push(chip.nodeId)
    }
    out.push({ chip, tabs, tabItems: tabs.map((t) => t.nodeId) })
  }
  return { chipItems, sections: out }
}

/** Shared tab status dots — the live tab and its drag ghost render the
 *  identical block so the two can't drift apart. Precedence: working pulse >
 *  unread badge > exceptional status dot (dormant/ended/waiting/err, the
 *  sidebar's `.session-status-dot.status-*` palette); a plain live session
 *  carries no dot at all. The single source of truth across surfaces is the
 *  pure tabDotStatus() fold — each surface computes it locally (the strip
 *  folds once per tab and feeds both this block and the tab's className).
 *  A dot that loses its signal is held one exit window (useExitRetention,
 *  `.exiting`) so it can fade out instead of being cut — a status change to
 *  a DIFFERENT dot is a swap: the spans are keyed by kind so the old one
 *  unmounts and the new one's mount pop plays (a reused node would neither
 *  restart session-nav-dot-in nor fade the dropped breath). */
function NavTabDots({ status, unread }: { status: TabDotStatus | null; unread?: boolean }) {
  // Working wins over unread: a running turn is the stronger, live
  // signal, and two adjacent 6px dots would read as one blob.
  const dot =
    status === 'working' ? 'working' : unread ? 'unread' : status ? `status:${status}` : null
  const { shown, exiting } = useExitRetention(dot)
  if (shown === null) return null
  const cls = exiting ? ' exiting' : ''
  if (shown === 'working') return <span key="working" className={`session-nav-dot${cls}`} aria-hidden />
  if (shown === 'unread') return <span key="unread" className={`session-nav-unread${cls}`} aria-hidden />
  return <span key={shown} className={`session-status-dot status-${shown.slice('status:'.length)}${cls}`} aria-hidden />
}

function SessionNavTab({
  session,
  focused,
  unread,
  resuming,
  deleting,
  onSelect,
  onContextMenu,
  dnd,
  dndDisabled,
}: {
  session: SessionInfo
  focused: boolean
  unread: boolean
  /** Resume in flight (App's transient `resuming` set) — folds the tab to
   *  'working' so a session the user just woke up pulses instead of sitting
   *  dormant-dimmed for the spawn's duration. */
  resuming: boolean
  /** Local delete-exit (App's `deletingIds`) — collapses the slot while the
   *  server DELETE is in flight, same contract as the sidebar card's
   *  `.deleting` shell. */
  deleting: boolean
  onSelect: (id: string) => void
  onContextMenu?: (e: React.MouseEvent, sessionId: string) => void
  /** Drag registration from stripDndPlan — one entry per rendered tab (the
   *  plan always emits them), wrapping the tab in a SortableNode. */
  dnd: StripDndItem
  dndDisabled?: boolean
}) {
  const label = sessionTitleOrFallback(session)
  // ONE fold per tab render: the working class, the dormant dim, the dot and
  // the tooltip all read this status. A resume-in-flight folds to 'working' —
  // the session is waking up, so it must pulse and shed the dormant dim
  // instead of reading as dead for the seconds the spawn takes. Crash
  // recovery folds to 'working' through statusClass's documented rule.
  const status = resuming ? 'working' : tabDotStatus(session)
  // The working wash outlives its status by one exit window so it can fade
  // out (`.working.exiting`) instead of being cut mid-breath when the turn
  // ends.
  const wash = useExitRetention(status === 'working' ? 'working' : null)
  const content = (
    <>
      <span className="session-nav-label">{label}</span>
      <NavTabDots status={status} unread={unread} />
    </>
  )
  return (
    <SortableNode
      id={dnd.nodeId}
      data={dnd.data}
      disabled={!!dndDisabled}
      className={`session-nav-slot${deleting ? ' deleting' : ''}`}
      nodeAttrs={{ [NAV_ITEM_ID_ATTR]: session.id }}
    >
      {({ isDragging, setActivatorNodeRef, listeners }) => (
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...listeners}
          className={`session-nav-tab${focused ? ' active' : ''}${isDragging ? ' dragging' : ''}${wash.shown === 'working' ? ' working' : ''}${wash.exiting ? ' exiting' : ''}${status === 'dormant' ? ' dormant' : ''}`}
          // Pointer-events alone leaves the collapsing tab keyboard-
          // activatable — inert (same as the exiting shell) drops it from the
          // tab order while the DELETE is in flight.
          inert={deleting}
          aria-pressed={focused}
          title={tabTitle(label, session)}
          onClick={() => onSelect(session.id)}
          // preventDefault lives here (not in the caller) so the native menu
          // is suppressed synchronously, before any state update can render.
          onContextMenu={
            onContextMenu
              ? (e: React.MouseEvent) => {
                  e.preventDefault()
                  onContextMenu(e, session.id)
                }
              : undefined
          }
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
export function SessionNavTabGhost({ session, unread }: { session: SessionInfo; unread?: boolean }) {
  const label = sessionTitleOrFallback(session)
  const status = tabDotStatus(session)
  return (
    // The dormant dim rides the ghost too — the lifted item IS the tab, and
    // a full-opacity ghost over a dimmed source would read as a different tab.
    <span className={`session-nav-tab session-nav-tab-ghost${status === 'dormant' ? ' dormant' : ''}`}>
      <span className="session-nav-label">{label}</span>
      <NavTabDots status={status} unread={unread} />
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
  onNewSession,
  onCreateGroup,
  askPrompt,
  onSessionContextMenu,
  onGroupContextMenu,
  resumingIds,
  deletingIds,
  exiting,
  poppedIdsRef,
}: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
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

  // Rebuild-driven effects key on the SLOT SET, not sections identity:
  // metadata ticks (working flips, lastTurnAt bumps) give sections a new
  // identity with an identical slot set, and re-observing every slot per
  // tick is pure churn.
  const slotIdsKey = useMemo(
    () =>
      sections
        .map((sec) => (sec.kind === 'group' ? `g:${sec.group.id}:` : 'u:') + sec.sessions.map((s) => s.id).join(','))
        .join('|'),
    [sections],
  )

  // Scroll + viewport-driven re-measure. The scroller is always mounted (the
  // strip renders even with zero sessions). ResizeObserver is absent in
  // jsdom; there the scroll listener + content effect cover what tests need.
  // Slots are observed too: their widths change without a scroller resize —
  // the delete-collapse ramps a slot to 0 over 240ms, and a retained dot
  // unmounting at the end of its exit window shrinks its tab — both would
  // leave the edge-fade mask stale otherwise.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.addEventListener('scroll', syncFade, { passive: true })
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(syncFade) : null
    ro?.observe(el)
    for (const slot of el.querySelectorAll<HTMLElement>(`[${NAV_ITEM_ID_ATTR}]`)) ro?.observe(slot)
    return () => {
      el.removeEventListener('scroll', syncFade)
      ro?.disconnect()
    }
  }, [syncFade, slotIdsKey, deletingIds])

  // The scroller hides its scrollbar, so a programmatically-focused session
  // (deep link, notification click, Alt+9 group activation) whose tab sits
  // off-screen would leave NO visible focus indicator. Pull the active tab
  // back into view on focus change. focusedId is not persisted, so a cold
  // start never has an active tab to scroll to — dep-change paths only.
  useEffect(() => {
    scrollRef.current
      ?.querySelector<HTMLElement>('.session-nav-tab.active')
      ?.scrollIntoView({
        block: 'nearest',
        inline: 'nearest',
        // Smooth only on this programmatic pull — NOT via CSS
        // scroll-behavior, which would make dnd-kit's per-frame edge
        // auto-scroll (scrollBy) restart a glide every frame and lag.
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      })
  }, [focusedId])

  // First-sight mount pop (WAAPI, same idiom as flip.ts): a genuinely-new
  // tab/chip fades+rises in, but a tab that REMOUNTS because it moved across
  // containers (group <-> ungrouped) must NOT pop — the reorder FLIP is
  // already sliding its slot to the new position and a concurrent fade would
  // swallow the slide. The first-sight gate is a ref-held id set (App passes
  // a session-lifetime one so re-collapses don't re-pop the row; tests get
  // the per-instance default); layout effect timing keeps the pop
  // paint-correct for new nodes with no flash of their end state. First
  // sight is RECORDED even under reduced motion (nothing plays there) so
  // flipping the OS setting on later never pops every already-open tab at
  // once.
  const defaultPoppedIdsRef = useRef<Set<string>>(new Set())
  const poppedIds = poppedIdsRef ?? defaultPoppedIdsRef
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const reduced = prefersReducedMotion()
    for (const slot of root.querySelectorAll<HTMLElement>(`[${NAV_ITEM_ID_ATTR}]`)) {
      const id = slot.getAttribute(NAV_ITEM_ID_ATTR)
      if (!id || poppedIds.current.has(id)) continue
      poppedIds.current.add(id)
      if (reduced) continue
      slot.querySelector<HTMLElement>('.session-nav-tab, .session-nav-chip')?.animate(
        [
          // The rise rides the independent `translate` property, NOT
          // `transform`: the delete-collapse owns the button's `transform`,
          // and two owners of one property would fight (WAAPI wins the
          // cascade and would swallow the collapse mid-pop).
          { opacity: 0, translate: '0 2px' }, // 2px = --motion-distance-xs
          { opacity: 1, translate: '0 0' },
        ],
        // 120ms / cubic-bezier(0.22, 1, 0.36, 1) = --motion-duration-fast /
        // --motion-ease-enter, hardcoded like flip.ts's settle curve.
        { duration: 120, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
      )
    }
  }, [slotIdsKey, poppedIds])

  // Quick-toggle revive needs no JS: dropping `.exiting` switches the
  // computed animation-name from session-nav-strip-out back to
  // session-nav-strip-in, and a newly-named CSS animation restarts — the
  // entrance replays by itself (verified in-browser: the name leaving and
  // re-entering the list is what replays, the same mechanism as the
  // toggle-a-class replay idiom).

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
    <div ref={rootRef} className={`session-nav-strip${exiting ? ' exiting' : ''}`} inert={exiting} role="group" aria-label="All sessions" style={fadeStyle}>
      <CreateMenuButton
        className="session-nav-new btn btn-icon"
        aria-label="Create"
        title="New session or group"
        onNewSession={onNewSession}
        onCreateGroup={onCreateGroup}
        askPrompt={askPrompt}
      >
        +
      </CreateMenuButton>
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
                  nodeAttrs={{ [NAV_ITEM_ID_ATTR]: sec.group.id }}
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
                      onContextMenu={
                        onGroupContextMenu
                          ? (e) => {
                              e.preventDefault()
                              onGroupContextMenu(e, sec.group.id)
                            }
                          : undefined
                      }
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
                      resuming={!!resumingIds?.has(s.id)}
                      deleting={!!deletingIds?.has(s.id)}
                      onSelect={onSelect}
                      onContextMenu={onSessionContextMenu}
                      dnd={sp.tabs[j]}
                      dndDisabled={tabDndDisabled(s)}
                    />
                  ))}
                </SortableContext>
              </div>
            ) : (
              // Single ungrouped section by construction (App's sidebarSections
              // builder appends exactly one), so the key is a constant — an
              // index-scoped key would remount every ungrouped tab on each
              // group-count change, cutting in-flight exit fades and delete
              // collapses. If a producer ever emits TWO ungrouped sections,
              // React's duplicate-key warning fires loudly here.
              <SortableContext key="u" items={sp.tabItems} strategy={horizontalListSortingStrategy}>
                {sec.sessions.map((s, j) => (
                  <SessionNavTab
                    key={s.id}
                    session={s}
                    focused={s.id === focusedId}
                    unread={!!unread[s.id]}
                    resuming={!!resumingIds?.has(s.id)}
                    deleting={!!deletingIds?.has(s.id)}
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
