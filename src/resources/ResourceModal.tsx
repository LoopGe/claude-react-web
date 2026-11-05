// The per-session resource surface — a portal modal host
// (docs/resource-tabs-research.md §12; the host changed from a side pane to a
// modal after Phase 1 review: the only entry points are the Git/Worktree
// overlays, and a portal modal stacks ABOVE them — the Git panel keeps its
// filter/expanded rows/commit draft mounted behind the preview).
//
// The address/store/registry model is host-agnostic; only this shell is modal.
// Tabs are keyed by `(kind, address)` in the store and rendered as a chip strip;
// only the active tab mounts its body (so switching chips re-reads the file —
// bounded memory, since image payloads can be multi-MB). Closing the modal
// keeps the tabs (persisted per session); the app-header toggle
// (`ResourcePreviewButton`, beside "Uploaded files") reopens them, and a
// persisted session restores its tabs but never auto-opens. `visible` is
// Chat's panel visibility: a hidden/keep-alive-cached panel must neither leave
// its portal on screen nor keep `expanded` latched, so hiding the panel
// collapses the store.

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import {
  parseFileResource,
  resourceDescription,
  resourcePathSegments,
  resourceTitle,
} from '../../shared/resource-address'
import type { FileReadResult } from '../../shared/read-file'
import { FilePreviewBody } from '../components/file-preview/FilePreviewBody'
import { IconX } from '../components/icons/ToolIcons'
import { Overlay } from '../components/Overlay'
import { useResourcePaneStore } from './context'
import { type ResourceParams, type ResourceTab } from './tab-store'
import { useResource } from './useResource'
import { ResourceDiffBody } from './ResourceDiffBody'
import { ResourceSnapshotDiffBody } from './ResourceSnapshotDiffBody'
import { ResourceTaskBody } from './ResourceTaskBody'
import { ResourceSubagentBody } from './ResourceSubagentBody'
import { ResourceLinkProvider } from './ResourceLinkContext'

export function ResourceModal({
  sessionId,
  cwd,
  visible,
}: {
  sessionId: string
  /** Session working directory — forwarded to mirror-backed bodies so relative
   *  paths in agent transcripts resolve (tool-row open buttons / links). */
  cwd?: string
  /** False while the hosting Chat panel is hidden (keep-alive cache / switch). */
  visible: boolean
}) {
  const store = useResourcePaneStore()
  const getSnapshot = useCallback(() => store.getState(sessionId), [store, sessionId])
  const state = useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot)

  const tablistRef = useRef<HTMLDivElement>(null)
  const baseId = useId()
  const panelId = `${baseId}-panel`
  const tabIdOf = (id: string) => `${baseId}-tab-${id}`
  const open = visible && state.expanded

  // Hiding the panel must un-latch `expanded`, or returning to it would pop the
  // modal open. Unmount also collapses (panel eviction) — deferred by a
  // microtask so StrictMode's mount→cleanup→mount sequence cancels it.
  const liveRef = useRef(false)
  useEffect(() => {
    liveRef.current = true
    if (!visible) store.setExpanded(sessionId, false)
    return () => {
      liveRef.current = false
      queueMicrotask(() => {
        if (!liveRef.current) store.setExpanded(sessionId, false)
      })
    }
  }, [visible, store, sessionId])

  const close = useCallback(() => store.setExpanded(sessionId, false), [store, sessionId])

  if (state.tabs.length === 0) return null
  const active = state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0]
  const navigation = store.getNavigation(active.id)

  // Duplicate basenames would produce indistinguishable chips; those widen to
  // the shortest path suffix no other tab shares, so every chip is unique.
  const labels = state.tabs.map((tab) => resourceTitle(tab.address))
  const segments = state.tabs.map((tab) => resourcePathSegments(tab.address))
  const labelOf = labels.map((label, index) => {
    if (labels.filter((other) => other === label).length === 1) return label
    const own = segments[index]
    for (let k = 2; k <= own.length; k++) {
      const candidate = own.slice(-k).join('/')
      const shared = segments.some(
        (other, otherIndex) => otherIndex !== index && other.slice(-k).join('/') === candidate,
      )
      if (!shared) return candidate
    }
    return own.join('/') || label
  })

  const closeTab = (tabId: string) => {
    store.close(sessionId, tabId)
    // The clicked close button is about to unmount; move focus into the strip
    // so arrow navigation keeps working (WAI-ARIA tabs pattern).
    requestAnimationFrame(() => {
      const nextId = store.getState(sessionId).activeTabId
      if (!nextId) return
      tablistRef.current
        ?.querySelector<HTMLElement>(`[data-resource-tab="${CSS.escape(nextId)}"]`)
        ?.focus()
    })
  }

  // WAI-ARIA tabs: roving tabindex with manual activation — arrows move
  // selection + focus together, Tab leaves the strip.
  const handleTablistKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const index = state.tabs.findIndex((tab) => tab.id === active.id)
    const nextIndex =
      event.key === 'ArrowRight'
        ? (index + 1) % state.tabs.length
        : (index - 1 + state.tabs.length) % state.tabs.length
    const next = state.tabs[nextIndex]
    store.focus(sessionId, next.id)
    requestAnimationFrame(() => {
      tablistRef.current
        ?.querySelector<HTMLElement>(`[data-resource-tab="${CSS.escape(next.id)}"]`)
        ?.focus()
    })
  }

  return (
    <Overlay
        open={open}
        onClose={close}
        variant="modal"
        ariaLabel="Resource preview"
        cardClassName="resource-modal"
        cardStyle={{ width: 760, maxWidth: '92vw' }}
        // Portal to <body>: the entry point is a per-panel overlay whose
        // backdrop-filter would otherwise become the containing block.
        portal
      >
        <div className="modal-header resource-modal-header">
          <div
            className="resource-tabs"
            role="tablist"
            aria-label="Open resources"
            ref={tablistRef}
            onKeyDown={handleTablistKeyDown}
          >
            {state.tabs.map((tab, index) => {
              const title = labelOf[index]
              const selected = tab.id === active.id
              return (
                <div
                  key={tab.id}
                  role="presentation"
                  className={`resource-tab${selected ? ' resource-tab-active' : ''}`}
                >
                  <button
                    type="button"
                    role="tab"
                    id={tabIdOf(tab.id)}
                    aria-controls={panelId}
                    aria-selected={selected}
                    tabIndex={selected ? 0 : -1}
                    data-resource-tab={tab.id}
                    className="resource-tab-label"
                    title={resourceDescription(tab.address)}
                    onClick={() => store.focus(sessionId, tab.id)}
                  >
                    {title}
                  </button>
                  <button
                    type="button"
                    className="resource-tab-close"
                    aria-label={`Close ${title}`}
                    onClick={() => closeTab(tab.id)}
                  >
                    <IconX size={11} />
                  </button>
                </div>
              )
            })}
          </div>
          <button type="button" className="btn btn-icon-sm" aria-label="Close" onClick={close}>
            <IconX />
          </button>
        </div>
        <div
          id={panelId}
          role="tabpanel"
          aria-labelledby={tabIdOf(active.id)}
          className="modal-section file-viewer-body resource-modal-body"
        >
          <ResourceBody
            tab={active}
            params={navigation?.params}
            revision={navigation?.revision ?? 0}
            cwd={cwd}
          />
        </div>
      </Overlay>
  )
}

function ResourceBody({
  tab,
  params,
  revision,
  cwd,
}: {
  tab: ResourceTab
  params?: ResourceParams
  revision: number
  cwd?: string
}) {
  switch (tab.kind) {
    case 'file':
      return <FileResourceBody address={tab.address} params={params} revision={revision} />
    case 'diff':
      return <ResourceDiffBody address={tab.address} />
    case 'snapshot-diff':
      return <ResourceSnapshotDiffBody address={tab.address} params={params} revision={revision} />
    case 'task':
      return <ResourceTaskBody address={tab.address} cwd={cwd} />
    case 'subagent':
      return <ResourceSubagentBody address={tab.address} cwd={cwd} />
    default:
      return <div className="hint">Nothing can open this address.</div>
  }
}

function FileResourceBody({
  address,
  params,
  revision,
}: {
  address: string
  params?: ResourceParams
  revision: number
}) {
  const snapshot = useResource<FileReadResult>(address)
  const parsed = parseFileResource(address)
  // Relative links inside a previewed Markdown file resolve from that file's
  // directory; a bare `#L10` targets the file itself.
  const dir = parsed ? parsed.path.split('/').slice(0, -1).join('/') || '/' : ''
  return (
    <ResourceLinkProvider sessionId={parsed?.sessionId} baseDir={dir} baseFile={parsed?.path}>
      <FilePreviewBody
      key={address}
      path={parsed?.path ?? null}
      title={resourceTitle(address)}
      data={snapshot.value ?? null}
      error={
        snapshot.status === 'failed'
          ? (snapshot.failure?.message ?? 'Failed to read this file.')
          : null
      }
      loading={snapshot.status === 'loading'}
      line={typeof params?.line === 'number' ? params.line : undefined}
      endLine={typeof params?.endLine === 'number' ? params.endLine : undefined}
      revision={revision}
      />
    </ResourceLinkProvider>
  )
}