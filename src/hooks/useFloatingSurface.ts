import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from 'react'
import {
  registerFloatingSurface,
  unregisterFloatingSurface,
  updateFloatingSurfacePhase,
  isFloatingSurfaceRegistered,
  type FloatingDismissReason,
  type FloatingSurfaceKind,
  type FloatingSurfacePhase,
} from './floating-surface-registry'

const FloatingSurfaceParentContext = createContext<string | null>(null)

export interface FloatingSurfaceOptions {
  kind: FloatingSurfaceKind
  active: boolean
  phase: FloatingSurfacePhase
  parentId?: string
  contextMenu?: boolean
  dismissOnPolicy?: boolean
  swallowEscapeOnExit?: boolean
  getContainer: () => HTMLElement | null
  getTrigger?: () => Element | null
  onDismiss: (reason: FloatingDismissReason) => void
  canDismiss?: () => boolean
  onEscape?: (event: KeyboardEvent) => void
  canCloseOnEscape?: () => boolean
}

/** Register once per mounted surface; phase updates never create a second entry. */
export function useFloatingSurface(options: FloatingSurfaceOptions): { surfaceId: string } {
  const surfaceId = useId()
  const contextParentId = useContext(FloatingSurfaceParentContext)
  const parentId = options.parentId ?? contextParentId ?? undefined
  const optionsRef = useRef(options)
  /* eslint-disable react-hooks/refs -- callbacks are read only after commit by the registry */
  optionsRef.current = options
  /* eslint-enable react-hooks/refs */
  const hasEscape = options.onEscape !== undefined

  const register = useCallback(() => {
    if (isFloatingSurfaceRegistered(surfaceId)) return
    registerFloatingSurface({
      id: surfaceId,
      kind: options.kind,
      parentId,
      phase: optionsRef.current.phase,
      contextMenu: options.contextMenu,
      dismissOnPolicy: options.dismissOnPolicy,
      swallowEscapeOnExit: options.swallowEscapeOnExit,
      getContainer: () => optionsRef.current.getContainer(),
      getTrigger: () => optionsRef.current.getTrigger?.() ?? null,
      onDismiss: (reason) => optionsRef.current.onDismiss(reason),
      canDismiss: () => optionsRef.current.canDismiss?.() ?? true,
      onEscape: hasEscape ? (event) => optionsRef.current.onEscape?.(event) : undefined,
      canCloseOnEscape: () => optionsRef.current.canCloseOnEscape?.() ?? true,
    })
  }, [surfaceId, options.kind, options.contextMenu, options.dismissOnPolicy, options.swallowEscapeOnExit, parentId, hasEscape])

  useLayoutEffect(() => {
    if (!options.active) return
    register()
    return () => unregisterFloatingSurface(surfaceId)
  }, [options.active, register, surfaceId])

  useLayoutEffect(() => {
    if (!options.active) return
    // Policy dismissal removes the entry while AnimatePresence keeps the
    // component mounted. Reopening that same component must register it again.
    if (options.phase === 'open') register()
    updateFloatingSurfacePhase(surfaceId, options.phase)
  }, [options.active, options.phase, register, surfaceId])

  return { surfaceId }
}

/** Logical ancestry survives portals and adds no DOM node around surface chrome. */
export function FloatingSurfaceProvider({ surfaceId, children }: { surfaceId: string; children: ReactNode }) {
  return createElement(FloatingSurfaceParentContext.Provider, { value: surfaceId }, children)
}

/** Test/legacy helper for imperative owners; normal consumers use the hook cleanup. */
export { unregisterFloatingSurface }
