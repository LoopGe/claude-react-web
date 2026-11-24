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
  useState,
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
import { isHtmlFilePath } from '../../shared/open-path'
import { FilePreviewBody } from '../components/file-preview/FilePreviewBody'
import { IconExternalLink, IconX } from '../components/icons/ToolIcons'
import { Overlay } from '../components/Overlay'
import { api } from '../hooks/useApi'
import { useOpenPathCapability } from '../hooks/useOpenPathCapability'
import { apiErrorToastOpts, useToast } from '../hooks/useToast'
import { formatError } from '../utils/format-error'
import { useAutoHeightTransition } from '../hooks/useAutoHeightTransition'
import { useResourcePaneStore } from './context'
import { type ResourceParams, type ResourceTab, type ResourcePaneState } from './tab-store'
import { useResource } from './useResource'
import { ResourceDiffBody } from './ResourceDiffBody'
import { ResourceSnapshotDiffBody } from './ResourceSnapshotDiffBody'
import { ResourceTaskBody } from './ResourceTaskBody'
import { ResourceSubagentBody } from './ResourceSubagentBody'
import { ResourceLinkProvider } from './ResourceLinkContext'
import { measureResourceModalBodyHeight } from './resource-modal-measure'
import type { ResourcePaneStore } from './tab-store'

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
  const toast = useToast()
  const [browserPendingPaths, setBrowserPendingPaths] = useState<string[]>([])
  const getSnapshot = useCallback(() => store.getState(sessionId), [store, sessionId])
  const state = useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot)

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

  const openInBrowser = (path: string) => {
    if (browserPendingPaths.includes(path)) return
    setBrowserPendingPaths((paths) => [...paths, path])
    api
      .post('/open-path', { path, target: 'browser' })
      .catch((error: unknown) => {
        toast.error(`Couldn't open in system browser: ${formatError(error)}`, apiErrorToastOpts(error))
      })
      .finally(() => setBrowserPendingPaths((paths) => paths.filter((pendingPath) => pendingPath !== path)))
  }

  if (state.tabs.length === 0) return null
  const active = state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0]
  const activeFilePath = active.kind === 'file' ? parseFileResource(active.address)?.path : undefined
  const browserPath = activeFilePath && isHtmlFilePath(activeFilePath) ? activeFilePath : null
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
        <ResourceModalSurface
          store={store}
          sessionId={sessionId}
          state={state}
          active={active}
          params={navigation?.params}
          revision={navigation?.revision ?? 0}
          labelOf={labelOf}
          cwd={cwd}
          browserPath={browserPath}
          browserPending={browserPath != null && browserPendingPaths.includes(browserPath)}
          onOpenInBrowser={openInBrowser}
          onClose={close}
        />
      </Overlay>
  )
}

/** The modal's chrome + body, rendered as Overlay's child so it MOUNTS AND
 *  UNMOUNTS with the open surface. The height-animation hook lives here, not in
 *  the always-mounted ResourceModal host: a hook in the host would never
 *  re-install its ResizeObserver on reopen (the host's refs go null while the
 *  Overlay is closed, but its effects do not re-run), and would carry a stale
 *  height baseline across open/close. Mounting with the surface gives a fresh
 *  baseline on every open (no tween on the open beat itself) and a live
 *  observer for async content growth. */
function ResourceModalSurface({
  store,
  sessionId,
  state,
  active,
  params,
  revision,
  labelOf,
  cwd,
  browserPath,
  browserPending,
  onOpenInBrowser,
  onClose,
}: {
  store: ResourcePaneStore
  sessionId: string
  state: ResourcePaneState
  active: ResourceTab
  params?: ResourceParams
  revision: number
  labelOf: string[]
  cwd?: string
  browserPath: string | null
  browserPending: boolean
  onOpenInBrowser: (path: string) => void
  onClose: () => void
}) {
  const tablistRef = useRef<HTMLDivElement>(null)
  const baseId = useId()
  const panelId = `${baseId}-panel`
  const tabIdOf = (id: string) => `${baseId}-tab-${id}`

  const bodyRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLDivElement>(null)
  const measureBodyHeight = useCallback(() => {
    const body = bodyRef.current
    const content = contentRef.current
    const header = headerRef.current
    if (!body || !content || !header) return null
    return measureResourceModalBodyHeight(body, content, header)
  }, [])
  // The body's height tweens between content changes (tab switch, load landing,
  // source/preview toggle, image decode) instead of jumping. Keyed on the active
  // tab so a switch captures the start and animates; the observer on the content
  // wrapper covers async growth within a tab.
  const { captureHeight } = useAutoHeightTransition(bodyRef, active.id, {
    measureTargetHeight: measureBodyHeight,
    observe: contentRef,
  })

  const focusTab = useCallback((tabId: string) => {
    // A no-op focus (the already-active chip, or arrow wrap on a lone tab) must
    // not capture: store.focus early-returns, the hook key never changes, and a
    // pin nothing releases would strand the body at a fixed height.
    if (tabId === active.id) return
    captureHeight()
    store.focus(sessionId, tabId)
  }, [captureHeight, store, sessionId, active.id])

  const closeTab = (tabId: string) => {
    // Only closing the ACTIVE tab changes the body (and so the height); closing
    // a background chip leaves the active body untouched — capturing there would
    // strand a pin with no key change to release it.
    if (tabId === active.id) captureHeight()
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
    focusTab(next.id)
    requestAnimationFrame(() => {
      tablistRef.current
        ?.querySelector<HTMLElement>(`[data-resource-tab="${CSS.escape(next.id)}"]`)
        ?.focus()
    })
  }

  return (
    <>
      <div className="modal-header resource-modal-header" ref={headerRef}>
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
                  onClick={() => focusTab(tab.id)}
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
        {browserPath && (
          <OpenInSystemBrowserButton
            path={browserPath}
            pending={browserPending}
            onOpen={onOpenInBrowser}
          />
        )}
        <button type="button" className="btn btn-icon-sm" aria-label="Close" onClick={onClose}>
          <IconX />
        </button>
      </div>
      <div
        id={panelId}
        role="tabpanel"
        aria-labelledby={tabIdOf(active.id)}
        className="modal-section file-viewer-body resource-modal-body"
        ref={bodyRef}
      >
        <div className="resource-modal-content" ref={contentRef}>
          <ResourceBody tab={active} params={params} revision={revision} cwd={cwd} />
        </div>
      </div>
    </>
  )
}

function OpenInSystemBrowserButton({
  path,
  pending,
  onOpen,
}: {
  path: string
  pending: boolean
  onOpen: (path: string) => void
}) {
  const local = useOpenPathCapability()
  if (local !== true) return null

  return (
    <button
      type="button"
      className="btn btn-icon-sm"
      aria-label="Open in system browser"
      title="Open in system browser"
      disabled={pending}
      onClick={() => onOpen(path)}
    >
      <IconExternalLink />
    </button>
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