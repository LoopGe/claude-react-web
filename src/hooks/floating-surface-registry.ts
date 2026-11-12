// Single lifecycle registry for transient floating surfaces. Semantic kind,
// logical ancestry, policy phase, and Escape ownership share one ordered stack.

export type FloatingSurfaceKind = 'tooltip' | 'popover' | 'menu' | 'dialog'
export type FloatingSurfacePhase = 'open' | 'exiting'
export type FloatingDismissReason = 'layer' | 'replacement' | 'layout'

export interface FloatingSurfaceRegistration {
  id: string
  kind: FloatingSurfaceKind
  parentId?: string
  phase?: FloatingSurfacePhase
  /** Only the original ContextMenu family participates in layout-shift close. */
  contextMenu?: boolean
  /** Persistent surfaces may join focus ownership without layered dismissal. */
  dismissOnPolicy?: boolean
  /** Transcript drawers deliberately swallow Escape during their exit window. */
  swallowEscapeOnExit?: boolean
  getContainer: () => HTMLElement | null
  getTrigger?: () => Element | null
  onDismiss: (reason: FloatingDismissReason) => void
  canDismiss?: () => boolean
  onEscape?: (event: KeyboardEvent) => void
  canCloseOnEscape?: () => boolean
}

interface SurfaceEntry {
  id: string
  kind: FloatingSurfaceKind
  parentId?: string
  phase: FloatingSurfacePhase
  contextMenu: boolean
  dismissOnPolicy: boolean
  swallowEscapeOnExit: boolean
  order: number
  getContainer: () => HTMLElement | null
  getTrigger?: () => Element | null
  onDismiss?: (reason: FloatingDismissReason) => void
  canDismiss?: () => boolean
  onEscape?: (event: KeyboardEvent) => void
  canCloseOnEscape?: () => boolean
}

interface PendingHover {
  id: string
  getTrigger: () => Element | null
  cancel: () => void
}

let surfaces: SurfaceEntry[] = []
let pendingHovers: PendingHover[] = []
let nextOrder = 0
let listenerInstalled = false

function isAncestor(ancestor: SurfaceEntry, descendant: SurfaceEntry): boolean {
  const seen = new Set<string>()
  let parentId = descendant.parentId
  while (parentId && !seen.has(parentId)) {
    if (parentId === ancestor.id) return true
    seen.add(parentId)
    parentId = surfaces.find((entry) => entry.id === parentId)?.parentId
  }
  return false
}

function isRelated(a: SurfaceEntry, b: SurfaceEntry): boolean {
  return a.id === b.id || isAncestor(a, b) || isAncestor(b, a)
}

function interactiveOpenSurfaces(): SurfaceEntry[] {
  return surfaces.filter((entry) => entry.dismissOnPolicy && entry.phase === 'open' && entry.kind !== 'tooltip')
}

export function canOpenHover(trigger: Element | null): boolean {
  const interactive = interactiveOpenSurfaces()
  if (interactive.length === 0) return true
  if (!trigger) return false
  return interactive.some((entry) => entry.getContainer()?.contains(trigger))
}

function pendingHoverRelated(pending: PendingHover, incoming: SurfaceEntry): boolean {
  const trigger = pending.getTrigger()
  if (!trigger) return false
  const domains = interactiveOpenSurfaces().filter((entry) => entry.getContainer()?.contains(trigger))
  return domains.some((entry) => isRelated(entry, incoming))
}

function hoverEntryRelated(tooltip: SurfaceEntry, incoming: SurfaceEntry): boolean {
  if (isRelated(tooltip, incoming)) return true
  const trigger = tooltip.getTrigger?.()
  if (!trigger) return false
  return interactiveOpenSurfaces()
    .filter((entry) => entry.getContainer()?.contains(trigger))
    .some((entry) => isRelated(entry, incoming))
}

function cancelPendingHover(pending: PendingHover): void {
  const index = pendingHovers.indexOf(pending)
  if (index >= 0) pendingHovers.splice(index, 1)
  pending.cancel()
}

function cancelPendingInEntries(branch: SurfaceEntry[]): void {
  for (const pending of [...pendingHovers]) {
    const trigger = pending.getTrigger()
    if (trigger && branch.some((entry) => entry.getContainer()?.contains(trigger))) {
      cancelPendingHover(pending)
    }
  }
}

function dismissDescendants(root: SurfaceEntry, reason: FloatingDismissReason): void {
  const descendants = surfaces
    .filter((entry) => entry.dismissOnPolicy && isAncestor(root, entry) && (entry.canDismiss?.() ?? true))
    .sort((a, b) => surfaceDepth(b) - surfaceDepth(a) || b.order - a.order)
  if (descendants.length === 0) return
  const victims = new Set(descendants)
  surfaces = surfaces.filter((entry) => !victims.has(entry))
  for (const entry of descendants) entry.onDismiss?.(reason)
}

function dismissBranch(root: SurfaceEntry, reason: FloatingDismissReason): void {
  if (!root.dismissOnPolicy || !(root.canDismiss?.() ?? true)) return
  const branch = surfaces
    .filter((entry) => entry.dismissOnPolicy && (entry.id === root.id || isAncestor(root, entry)) && (entry.canDismiss?.() ?? true))
    .sort((a, b) => surfaceDepth(b) - surfaceDepth(a) || b.order - a.order)
  if (branch.length === 0) return
  const victims = new Set(branch)
  surfaces = surfaces.filter((entry) => !victims.has(entry))
  cancelPendingInEntries(branch)
  for (const entry of branch) entry.onDismiss?.(reason)
  syncEscapeListener()
}

function shouldDismiss(existing: SurfaceEntry, incoming: SurfaceEntry): boolean {
  if (incoming.kind === 'tooltip') return existing.kind === 'tooltip'
  if (existing.kind === 'tooltip') return true
  if (incoming.kind === 'popover') return false
  if (incoming.kind === 'menu') return existing.kind === 'popover' || existing.kind === 'menu'
  return existing.kind === 'popover' || existing.kind === 'menu'
}

function dismissalReason(existing: SurfaceEntry, incoming: SurfaceEntry): FloatingDismissReason {
  return existing.kind === incoming.kind ? 'replacement' : 'layer'
}

function arbitrate(incoming: SurfaceEntry): void {
  if (!incoming.dismissOnPolicy || incoming.phase !== 'open') return

  if (incoming.kind !== 'tooltip') {
    for (const pending of [...pendingHovers]) {
      if (!pendingHoverRelated(pending, incoming)) cancelPendingHover(pending)
    }
  }

  const victims = surfaces.filter((entry) =>
    entry !== incoming
    && entry.dismissOnPolicy
    && entry.phase === 'open'
    && !(incoming.kind !== 'tooltip' && entry.kind === 'tooltip'
      ? hoverEntryRelated(entry, incoming)
      : isRelated(entry, incoming))
    && shouldDismiss(entry, incoming),
  )
  for (const victim of victims) {
    if (surfaces.includes(victim)) dismissBranch(victim, dismissalReason(victim, incoming))
  }
}

function assertUnusedId(id: string): void {
  if (surfaces.some((entry) => entry.id === id)) {
    throw new Error(`Floating surface "${id}" is already registered`)
  }
}

export function registerFloatingSurface(options: FloatingSurfaceRegistration): () => void {
  assertUnusedId(options.id)
  if (options.kind === 'tooltip' && !canOpenHover(options.getTrigger?.() ?? null)) {
    options.onDismiss('layer')
    return () => {}
  }
  const entry: SurfaceEntry = {
    id: options.id,
    kind: options.kind,
    parentId: options.parentId,
    phase: options.phase ?? 'open',
    contextMenu: options.contextMenu === true,
    dismissOnPolicy: options.dismissOnPolicy !== false,
    swallowEscapeOnExit: options.swallowEscapeOnExit === true,
    order: ++nextOrder,
    getContainer: options.getContainer,
    getTrigger: options.getTrigger,
    onDismiss: options.onDismiss,
    canDismiss: options.canDismiss,
    onEscape: options.onEscape,
    canCloseOnEscape: options.canCloseOnEscape,
  }
  surfaces.push(entry)
  syncEscapeListener()
  arbitrate(entry)
  return () => unregisterFloatingSurface(entry.id)
}

export function unregisterFloatingSurface(id: string): void {
  const index = surfaces.findIndex((entry) => entry.id === id)
  if (index < 0) return
  const root = surfaces[index]
  const branch = surfaces.filter((entry) => entry.id === id || isAncestor(root, entry))
  dismissDescendants(root, 'layer')
  cancelPendingInEntries(branch)
  surfaces = surfaces.filter((entry) => entry.id !== id)
  syncEscapeListener()
}

export function updateFloatingSurfacePhase(id: string, phase: FloatingSurfacePhase): void {
  const entry = surfaces.find((candidate) => candidate.id === id)
  if (!entry || entry.phase === phase) return
  const wasOpen = entry.phase === 'open'
  entry.phase = phase
  if (wasOpen && phase === 'exiting') {
    const branch = surfaces.filter((candidate) => candidate.id === id || isAncestor(entry, candidate))
    dismissDescendants(entry, 'layer')
    cancelPendingInEntries(branch)
  }
  if (!wasOpen && phase === 'open') {
    entry.order = ++nextOrder
    surfaces.splice(surfaces.indexOf(entry), 1)
    surfaces.push(entry)
    if (entry.kind === 'tooltip' && !canOpenHover(entry.getTrigger?.() ?? null)) {
      dismissBranch(entry, 'layer')
      return
    }
    arbitrate(entry)
  }
  syncEscapeListener()
}

export function registerPendingHover(options: PendingHover): () => void {
  if (pendingHovers.some((pending) => pending.id === options.id)) {
    throw new Error(`Pending hover "${options.id}" is already registered`)
  }
  if (!canOpenHover(options.getTrigger())) {
    options.cancel()
    return () => {}
  }
  pendingHovers.push(options)
  return () => {
    const index = pendingHovers.indexOf(options)
    if (index >= 0) pendingHovers.splice(index, 1)
  }
}

export function closeAllContextMenus(): void {
  const roots = surfaces.filter((entry) =>
    entry.dismissOnPolicy && entry.phase === 'open' && entry.kind === 'menu' && entry.contextMenu,
  )
  for (const root of roots) {
    if (surfaces.includes(root)) dismissBranch(root, 'layout')
  }
}

export function isNodeInSurfaceBranch(surfaceId: string, node: Node): boolean {
  const root = surfaces.find((entry) => entry.id === surfaceId)
  if (!root) return false
  return surfaces.some((entry) =>
    (entry.id === root.id || isAncestor(root, entry)) && entry.getContainer()?.contains(node),
  )
}

export function isFocusInsideOtherOverlay(node: Node): boolean {
  for (let i = surfaces.length - 1; i >= 0; i--) {
    const container = surfaces[i].getContainer()
    if (container?.contains(node)) return true
  }
  return false
}

export function isFloatingSurfaceRegistered(id: string): boolean {
  return surfaces.some((entry) => entry.id === id)
}

export function getFloatingSurfaceCount(): number {
  return surfaces.length
}

export function getEscapeStackCount(): number {
  return surfaces.filter((entry) => entry.onEscape !== undefined && (entry.phase === 'open' || entry.swallowEscapeOnExit)).length
}

function surfaceRoot(entry: SurfaceEntry): SurfaceEntry {
  let current = entry
  const seen = new Set<string>()
  while (current.parentId && !seen.has(current.parentId)) {
    seen.add(current.parentId)
    const parent = surfaces.find((candidate) => candidate.id === current.parentId)
    if (!parent) break
    current = parent
  }
  return current
}

function branchLatestOrder(entry: SurfaceEntry): number {
  const root = surfaceRoot(entry)
  return surfaces.reduce(
    (latest, candidate) => surfaceRoot(candidate).id === root.id ? Math.max(latest, candidate.order) : latest,
    0,
  )
}

function surfaceDepth(entry: SurfaceEntry): number {
  let depth = 0
  const seen = new Set<string>()
  let parentId = entry.parentId
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId)
    const parent = surfaces.find((candidate) => candidate.id === parentId)
    if (!parent) break
    depth++
    parentId = parent.parentId
  }
  return depth
}

function handleEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.isComposing) return
  // Newest branch activity wins across roots; depth resolves ownership within
  // that branch, so a nested child cannot outrank a newer unrelated surface.
  const capable = surfaces
    .filter((entry) => entry.onEscape !== undefined && (entry.phase === 'open' || entry.swallowEscapeOnExit))
    .sort((a, b) => branchLatestOrder(b) - branchLatestOrder(a) || surfaceDepth(b) - surfaceDepth(a) || b.order - a.order)
  const target = event.target as Node | null
  let winner: SurfaceEntry | undefined
  if (target) {
    const containing = capable
      .filter((entry) => entry.getContainer()?.contains(target))
      .sort((a, b) => surfaceDepth(b) - surfaceDepth(a) || b.order - a.order)[0]
    if (containing) {
      // Focus in a leaf stays with that leaf. Only when the focused container
      // has open descendants does the deepest child take Escape first.
      const descendants = capable
        .filter((entry) => isAncestor(containing, entry))
        .sort((a, b) => surfaceDepth(b) - surfaceDepth(a) || b.order - a.order)
      winner = descendants[0] ?? containing
    }
  }
  if (!winner && capable.length > 0) winner = capable[0]
  if (!winner) return
  event.preventDefault()
  event.stopPropagation()
  if (winner.canCloseOnEscape?.() ?? true) winner.onEscape!(event)
}

function syncEscapeListener(): void {
  if (typeof window === 'undefined') return
  const needed = surfaces.some((entry) => entry.onEscape !== undefined && (entry.phase === 'open' || entry.swallowEscapeOnExit))
  if (needed && !listenerInstalled) {
    window.addEventListener('keydown', handleEscape, true)
    listenerInstalled = true
  } else if (!needed && listenerInstalled) {
    window.removeEventListener('keydown', handleEscape, true)
    listenerInstalled = false
  }
}

export function __resetFloatingSurfacesForTests(): void {
  if (listenerInstalled) window.removeEventListener('keydown', handleEscape, true)
  listenerInstalled = false
  surfaces = []
  pendingHovers = []
  nextOrder = 0
}
