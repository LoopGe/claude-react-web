// Per-session resource-pane state (docs/resource-tabs-research.md §12).
//
// Deliberately a plain store class, not a React hook tree: the pane state must
// survive a Chat panel's LRU eviction (the provider owns it at the App root),
// and every rule below is pure logic worth testing without a DOM. Persistence
// is injected (localStorage in the app), one validated key per session —
// params and live contents are never persisted, only what the strip needs to
// restore.

import { parseResourceAddress } from '../../shared/resource-address'

/** Everything a tab needs to exist. The display title is derived from the
 *  address (see `resourceTitle`) so it cannot drift. */
export interface ResourceTab {
  id: string
  /** Viewer kind — the address protocol unless a caller overrides it. */
  kind: string
  /** The verbatim `crw-resource://` address; tab identity is `(kind, address)`. */
  address: string
}

export interface ResourcePaneState {
  tabs: ResourceTab[]
  activeTabId: string | null
  expanded: boolean
}

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export type OpenResult =
  | { status: 'opened' | 'focused'; tabId: string }
  | { status: 'none'; reason: 'invalid-address' | 'unknown-kind' }

/** Navigation params (line targets, selected snapshot file) never change a
 *  tab's identity and are never persisted. */
export type ResourceParams = Record<string, string | number | undefined>
export interface ResourceNavigation {
  params?: ResourceParams
  /** Monotone per tab: bumps on every open (even with identical params) so a
   *  body can re-scroll to the target. */
  revision: number
}

export interface OpenOptions {
  /** Navigation params for the opened tab. Replaces (never merges) the previous
   *  params — a plain reopen clears a stale line target. */
  params?: ResourceParams
  /** false = open a second tab even when one already shows this address. */
  revealIfOpened?: boolean
}

export const RESOURCE_PANE_KEY_PREFIX = 'crw.resource-pane.v1.'

interface Options {
  storage?: StorageLike | null
  /** Whether a registered viewer exists for a kind. The provider supplies this
   *  from the registry so an address nothing can open never creates a tab. */
  canOpen?: (kind: string) => boolean
}

let tabCounter = 0
function nextTabId(): string {
  tabCounter += 1
  return `rt-${tabCounter}-${Math.random().toString(36).slice(2, 8)}`
}

function initialState(): ResourcePaneState {
  return { tabs: [], activeTabId: null, expanded: false }
}

/** Narrow an unknown persisted value. Addresses that no longer parse are
 *  dropped (a kind may have been removed between versions); the rest of the
 *  session's layout is salvaged. */
function coerceState(value: unknown): ResourcePaneState | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  if (!Array.isArray(raw.tabs)) return null
  const tabs: ResourceTab[] = []
  for (const entry of raw.tabs) {
    if (typeof entry !== 'object' || entry === null) continue
    const tab = entry as Record<string, unknown>
    if (typeof tab.id !== 'string' || typeof tab.kind !== 'string' || typeof tab.address !== 'string') {
      continue
    }
    if (!parseResourceAddress(tab.address)) continue
    tabs.push({ id: tab.id, kind: tab.kind, address: tab.address })
  }
  const activeTabId =
    typeof raw.activeTabId === 'string' && tabs.some((tab) => tab.id === raw.activeTabId)
      ? raw.activeTabId
      : (tabs[0]?.id ?? null)
  // A persisted resource surface must NOT auto-open on load — the host is a
  // modal, and popping one open on reload is intrusive. Tabs are restored and
  // the reopen control lets the user bring the surface back.
  return { tabs, activeTabId, expanded: false }
}

export class ResourcePaneStore {
  private readonly storage: StorageLike | null
  private readonly canOpen: (kind: string) => boolean
  private readonly states = new Map<string, ResourcePaneState>()
  private readonly navigation = new Map<string, ResourceNavigation>()
  private readonly listeners = new Set<() => void>()

  constructor(options: Options = {}) {
    this.storage = options.storage === undefined ? defaultStorage() : options.storage
    this.canOpen = options.canOpen ?? (() => true)
    // The app supports multiple tabs; adopt their writes so two tabs don't
    // silently overwrite each other's layout (the writing tab gets no event).
    if (this.storage && typeof window !== 'undefined') {
      try {
        if (this.storage === window.localStorage) {
          window.addEventListener('storage', this.onStorageEvent)
        }
      } catch {
        /* storage getter blocked — no cross-tab sync */
      }
    }
  }

  private onStorageEvent = (event: StorageEvent): void => {
    if (!event.key || !event.key.startsWith(RESOURCE_PANE_KEY_PREFIX)) return
    this.adoptExternalWrite(
      event.key.slice(RESOURCE_PANE_KEY_PREFIX.length),
      event.newValue,
    )
  }

  /** Adopt another tab's write. Visibility is host state, so keep the local
   *  `expanded`; the tab layout comes from the incoming value. */
  adoptExternalWrite(sessionId: string, raw: string | null): void {
    const current = this.states.get(sessionId)
    const next = this.stateFromRaw(raw)
    this.states.set(sessionId, { ...next, expanded: current?.expanded ?? false })
    this.emit()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Stable object between mutations (required by useSyncExternalStore). */
  getState = (sessionId: string): ResourcePaneState => {
    const cached = this.states.get(sessionId)
    if (cached) return cached
    const hydrated = this.hydrate(sessionId)
    this.states.set(sessionId, hydrated)
    return hydrated
  }

  getNavigation(tabId: string): ResourceNavigation | undefined {
    return this.navigation.get(tabId)
  }

  open(sessionId: string, address: string, options: OpenOptions = {}): OpenResult {
    const parsed = parseResourceAddress(address)
    if (!parsed) return { status: 'none', reason: 'invalid-address' }
    // The kind IS the address protocol. A caller-supplied override could name a
    // viewer whose provider resolves a different protocol, leaving a tab that
    // can never load.
    const kind = parsed.protocol
    if (!this.canOpen(kind)) return { status: 'none', reason: 'unknown-kind' }

    const state = this.getState(sessionId)
    const existing = state.tabs.find((tab) => tab.kind === kind && tab.address === address)
    const reveal = options.revealIfOpened !== false

    if (existing && reveal) {
      this.setNavigation(existing.id, options.params)
      this.write(sessionId, { ...state, activeTabId: existing.id, expanded: true })
      return { status: 'focused', tabId: existing.id }
    }

    const tab: ResourceTab = { id: nextTabId(), kind, address }
    this.setNavigation(tab.id, options.params)
    this.write(sessionId, {
      ...state,
      tabs: [...state.tabs, tab],
      activeTabId: tab.id,
      expanded: true,
    })
    return { status: 'opened', tabId: tab.id }
  }

  close(sessionId: string, tabId: string): void {
    const state = this.getState(sessionId)
    const index = state.tabs.findIndex((tab) => tab.id === tabId)
    if (index === -1) return
    const tabs = state.tabs.filter((tab) => tab.id !== tabId)
    this.navigation.delete(tabId)
    const activeTabId =
      state.activeTabId === tabId
        ? (tabs[index - 1]?.id ?? tabs[index]?.id ?? null)
        : state.activeTabId
    this.write(sessionId, {
      ...state,
      tabs,
      activeTabId,
      // Closing the last tab collapses; an already-collapsed pane stays so.
      expanded: tabs.length === 0 ? false : state.expanded,
    })
  }

  focus(sessionId: string, tabId: string): void {
    const state = this.getState(sessionId)
    if (!state.tabs.some((tab) => tab.id === tabId)) return
    if (state.activeTabId === tabId) return
    this.write(sessionId, { ...state, activeTabId: tabId })
  }

  setExpanded(sessionId: string, expanded: boolean): void {
    const state = this.getState(sessionId)
    if (state.expanded === expanded) return
    this.write(sessionId, { ...state, expanded })
  }

  /** Drop a session's layout entirely (server-side session removal). */
  removeSession(sessionId: string): void {
    const state = this.states.get(sessionId)
    if (state) {
      for (const tab of state.tabs) this.navigation.delete(tab.id)
      this.states.delete(sessionId)
    }
    try {
      this.storage?.removeItem(this.keyFor(sessionId))
    } catch {
      /* disabled storage */
    }
    this.emit()
  }

  // ── internals ──────────────────────────────────────────────────────

  private keyFor(sessionId: string): string {
    return `${RESOURCE_PANE_KEY_PREFIX}${sessionId}`
  }

  private hydrate(sessionId: string): ResourcePaneState {
    const key = this.keyFor(sessionId)
    let raw: string | null = null
    try {
      raw = this.storage?.getItem(key) ?? null
    } catch {
      return initialState()
    }
    if (raw == null) return initialState()
    const state = this.stateFromRaw(raw)
    // A corrupt key is dropped; other sessions' keys are untouched.
    if (state.tabs.length === 0) {
      try {
        this.storage?.removeItem(key)
      } catch {
        /* disabled storage */
      }
    }
    return state
  }

  /** Parse one persisted value. A malformed payload collapses to empty; a
   *  partially valid one keeps its parseable tabs and starts closed. */
  private stateFromRaw(raw: string | null): ResourcePaneState {
    if (raw == null) return initialState()
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return initialState()
    }
    return coerceState(parsed) ?? initialState()
  }

  private setNavigation(tabId: string, params: ResourceParams | undefined): void {
    const previous = this.navigation.get(tabId)
    this.navigation.set(tabId, {
      params,
      revision: (previous?.revision ?? 0) + 1,
    })
  }

  private write(sessionId: string, next: ResourcePaneState): void {
    const previous = this.states.get(sessionId)
    this.states.set(sessionId, next)
    // Visibility is host-only state and is not persisted, so a pure
    // expand/collapse must not rewrite storage.
    const layoutChanged =
      !previous || previous.tabs !== next.tabs || previous.activeTabId !== next.activeTabId
    if (layoutChanged) {
      try {
        this.storage?.setItem(
          this.keyFor(sessionId),
          JSON.stringify({
            tabs: next.tabs,
            activeTabId: next.activeTabId,
          }),
        )
      } catch {
        /* disabled storage / quota — in-memory state still updates */
      }
    }
    this.emit()
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

function defaultStorage(): StorageLike | null {
  if (typeof window === 'undefined') return null
  try {
    // The property getter itself can throw (sandboxed iframe / storage
    // disabled); the pane is optional, so boot must survive it.
    return window.localStorage
  } catch {
    return null
  }
}