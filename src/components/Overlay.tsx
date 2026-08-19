import { useRef, type HTMLAttributes, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'motion/react'
import { useExitPresence } from '../hooks/useExitPresence'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useEscapeStack } from '../hooks/useEscapeStack'
import { useMergedRef } from '../utils/mergedRef'
import { useOverlayMotion } from '../utils/transitions'

/**
 * Unified overlay primitive.
 *
 * The codebase had a dozen near-identical overlay/dialog implementations, each
 * hand-writing the same chrome with slightly different Escape handling (five
 * distinct patterns), backdrop-click guards, focus traps, exit animations and
 * inert flags — the breeding ground for the P0 nesting bugs. This component is
 * the single owner of those behaviors:
 *
 *   - Escape via the useEscapeStack nesting stack (one Esc closes only the top
 *     overlay — "most recently opened wins")
 *   - backdrop mousedown-to-close with a `e.target === e.currentTarget` guard
 *     (only direct clicks on the backdrop, not bubbled clicks from the card)
 *   - focus trap via useFocusTrap, restoring focus on close
 *   - enter/exit animation via `data-state` + useExitPresence (css mode) or
 *     motion.div + useOverlayMotion (motion mode, exit owned by the caller's
 *     AnimatePresence)
 *   - optional `inert` on the closing overlay (not the background)
 *
 * CSS contract: it renders `backdrop > card` with the card as a DIRECT CHILD
 * and NO wrapper element. ~40 selectors across the stylesheets depend on this
 * direct-child relationship (enter/exit keyframes, glass surfaces, the
 * `:has(> .global-settings-modal)` mobile rule), so inserting a wrapper would
 * silently break them. The variant map uses ONLY existing class names — zero
 * CSS additions. `renderCard={false}` (settings/git/subagent/workflow) renders
 * `backdrop > children`, where the child IS the card (the panel's root element
 * carries the card class), preserving the same contract.
 */

const VARIANT_CLASSES = {
  perm: { backdrop: 'perm-overlay', card: 'perm-card', roleOn: 'card', ariaModal: 'true' },
  modal: { backdrop: 'modal-backdrop', card: 'modal', roleOn: 'card', ariaModal: 'true' },
  panel: { backdrop: 'panel-overlay', card: 'panel-overlay-card', roleOn: 'card', ariaModal: 'true' },
  settings: { backdrop: 'settings-overlay', card: null, roleOn: 'backdrop', ariaModal: 'true' },
  git: { backdrop: 'git-overlay', card: null, roleOn: 'backdrop', ariaModal: 'true' },
  palette: { backdrop: 'palette-backdrop', card: 'palette', roleOn: 'card', ariaModal: 'true' },
  marketplace: { backdrop: 'marketplace-overlay', card: 'marketplace-card', roleOn: 'card', ariaModal: 'true' },
  globalSettings: { backdrop: 'modal-backdrop', card: 'global-settings-modal', roleOn: 'card', ariaModal: 'true' },
  subagent: { backdrop: 'subagent-overlay', card: null, roleOn: 'backdrop', ariaModal: 'false' },
  workflow: { backdrop: 'workflow-overlay', card: null, roleOn: 'backdrop', ariaModal: 'false' },
} as const

export type OverlayVariant = keyof typeof VARIANT_CLASSES

/** Div props used by both the css-mode <div> and motion-mode <motion.div>
 *  branches. React's HTMLAttributes types onDrag as DragEventHandler, which
 *  collides with motion's pan/gesture onDrag signature — the props are Omit-ed
 *  so the object is assignable to motion's Omit<HTMLMotionProps, 'ref'>. */
type OverlayDivProps<TRef> = Omit<
  HTMLAttributes<HTMLDivElement>,
  'ref' | 'onDrag' | 'onDragStart' | 'onDragEnd' | 'onAnimationStart' | 'onAnimationEnd'
> & {
  ref: TRef
}

export interface OverlayProps {
  /** Whether the overlay is open. Default true — motion-mode dialogs (mounted
   *  by the caller's AnimatePresence) are only in the tree while open. */
  open?: boolean
  /** Close the overlay (backdrop click / Escape). */
  onClose: () => void
  children: ReactNode
  /** Accessible name for the dialog. */
  ariaLabel?: string
  /** Which existing CSS class pair to render. */
  variant?: OverlayVariant
  /** Extra class(es) on the card element (e.g. `modal-new-session`). */
  cardClassName?: string
  /** Extra class(es) on the backdrop element. */
  backdropClassName?: string
  /** Render into a portal on document.body (McpInstaller, marketplace). */
  portal?: boolean
  /** When false, children ARE the card (settings/git/subagent/workflow panels
   *  carry their own card class). Default: true unless the variant has no card
   *  class. */
  renderCard?: boolean
  /** Keep mounted after fully closed, hidden via `.hidden` (settings overlay's
   *  lazy-mount pattern). */
  keepMounted?: boolean
  /** 'css' = data-state + useExitPresence (default); 'motion' = motion.div +
   *  useOverlayMotion with the exit owned by the caller's AnimatePresence. */
  motion?: 'css' | 'motion'
  /** Whether a backdrop click closes. Permission/Question dialogs pass false —
   *  a permission request can't be dismissed by clicking away. */
  backdropDismiss?: boolean
  /** Busy guard for the Escape close path (false swallows Esc without closing,
   *  so it can't fall through to the overlay beneath). */
  canCloseOnEscape?: () => boolean
  /** Busy guard for the backdrop-click close path. */
  canCloseOnBackdrop?: () => boolean
  /** 'custom' routes Escape to `onEscape` instead of `onClose` (e.g. Permission
   *  dialogs deny the request). */
  escapeBehavior?: 'close' | 'custom'
  onEscape?: (e: KeyboardEvent) => void
  /** Whether to trap Tab focus inside the card while open. Palettes pass
   *  false — they manage Tab themselves to keep the search input focused. */
  trapFocus?: boolean
  /** Restore focus to the trigger on close. Default true. */
  restoreFocus?: boolean
  /** Escape hatch for focus: when focus lands in an element matching this
   *  selector outside the trap, it is released (per-panel overlays pass
   *  `.chat-panel` so the user can interact with sibling panels). */
  focusEscapeSelector?: string
  /** Where to attach the focus-trap element: the card (default) or the
   *  backdrop (settings/git, which currently trap the backdrop element). */
  trapRefTarget?: 'card' | 'backdrop'
  /** Exit animation duration in ms. Default 180. */
  exitDurationMs?: number
  /** Apply `inert` to the overlay while open=false (only while it is still
   *  mounted through the exit animation). */
  inertOnExit?: boolean
  /** Card-level keydown handler (arrow navigation, Enter to confirm, Tab
   *  containment for palettes). */
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void
  /** Extra ref on the backdrop element (e.g. useOverlayScrollbar). Must be a
   *  stable ref — see useMergedRef's jsdoc. */
  backdropRef?: (node: HTMLElement | null) => void
}

export function Overlay(props: OverlayProps) {
  const {
    open = true,
    onClose,
    children,
    ariaLabel,
    variant = 'modal',
    cardClassName,
    backdropClassName,
    portal = false,
    renderCard,
    keepMounted = false,
    motion: motionMode = 'css',
    backdropDismiss = true,
    canCloseOnEscape,
    canCloseOnBackdrop,
    escapeBehavior = 'close',
    onEscape,
    trapFocus = true,
    restoreFocus = true,
    focusEscapeSelector,
    trapRefTarget,
    exitDurationMs,
    inertOnExit = false,
    onKeyDown,
    backdropRef,
  } = props

  const classes = VARIANT_CLASSES[variant]
  const useCard = renderCard ?? classes.card != null
  const roleOnBackdrop = classes.roleOn === 'backdrop'
  const trapTarget = trapRefTarget ?? (roleOnBackdrop ? 'backdrop' : 'card')
  const cssMode = motionMode === 'css'

  // In motion mode the caller gates mount via AnimatePresence, so presence is a
  // no-op (open stays true for the whole mounted life) and rendering is
  // caller-controlled. In css mode useExitPresence delays unmount through the
  // ~180ms exit animation.
  const presence = useExitPresence(cssMode ? open : true, exitDurationMs)
  const shouldRender = presence.shouldRender
  const isExiting = presence.isExiting
  const mounted = keepMounted ? true : shouldRender

  const backdropElRef = useRef<HTMLDivElement>(null)
  const cardElRef = useRef<HTMLDivElement>(null)
  const mergedBackdropRef = useMergedRef(backdropElRef, backdropRef)

  // `mounted` (not just `open`) gates the trap so it only engages once the
  // overlay is actually in the DOM: useExitPresence flips shouldRender one
  // render *after* open turns true, and without the gate the trap's effect
  // would run on a frame where the ref is still null and never re-run (the
  // exact bug Chat.tsx documents for its git overlay).
  useFocusTrap(trapTarget === 'backdrop' ? backdropElRef : cardElRef, {
    restoreFocus,
    active: mounted && open && trapFocus,
    escapeSelector: focusEscapeSelector,
  })

  // Register in the Escape stack while open. The getContainer is the backdrop
  // (it contains the card + focus), so the stack's containment scan resolves
  // nesting correctly regardless of portal.
  useEscapeStack({
    active: open,
    onEscape: (e) => {
      if (escapeBehavior === 'custom') onEscape?.(e)
      else onClose()
    },
    canClose: canCloseOnEscape,
    getContainer: () => backdropElRef.current,
  })

  if (!keepMounted && !shouldRender) return null

  const dataState = open ? 'open' : isExiting ? 'closing' : 'closed'
  const hidden = keepMounted && !shouldRender
  const modal = open ? classes.ariaModal : 'false'

  const backdropProps: OverlayDivProps<(node: HTMLDivElement | null) => void> = {
    className: `${classes.backdrop}${backdropClassName ? ' ' + backdropClassName : ''}${hidden ? ' hidden' : ''}`,
    ...(cssMode ? { 'data-state': dataState } : {}),
    ref: mergedBackdropRef,
    ...(backdropDismiss
      ? {
          onMouseDown: (e: React.MouseEvent<HTMLDivElement>) => {
            if (open && e.target === e.currentTarget && (!canCloseOnBackdrop || canCloseOnBackdrop())) {
              onClose()
            }
          },
        }
      : {}),
    ...(roleOnBackdrop
      ? { role: 'dialog', 'aria-modal': modal, 'aria-label': ariaLabel, 'aria-hidden': !open }
      : {}),
    ...(inertOnExit && !open ? { inert: true } : {}),
  }

  const cardProps: OverlayDivProps<React.Ref<HTMLDivElement>> = {
    className: `${classes.card}${cardClassName ? ' ' + cardClassName : ''}`,
    ref: cardElRef,
    ...(!roleOnBackdrop ? { role: 'dialog', 'aria-modal': modal, 'aria-label': ariaLabel } : {}),
    onKeyDown,
  }

  const cardContent = useCard ? <div {...cardProps}>{children}</div> : children
  const element = cssMode ? (
    <div {...backdropProps}>{cardContent}</div>
  ) : (
    <MotionShell backdropProps={backdropProps} cardProps={cardProps} useCard={useCard}>
      {children}
    </MotionShell>
  )

  return portal ? createPortal(element, document.body) : element
}

/** motion-mode shell. Split so useOverlayMotion (which reads the reduced-motion
 *  media query) is only subscribed for motion-mode overlays, keeping css-mode
 *  renders free of that jsdom/browser requirement. */
function MotionShell({
  backdropProps,
  cardProps,
  useCard,
  children,
}: {
  backdropProps: OverlayDivProps<(node: HTMLDivElement | null) => void>
  cardProps: OverlayDivProps<React.Ref<HTMLDivElement>>
  useCard: boolean
  children: ReactNode
}) {
  const m = useOverlayMotion()
  return (
    <motion.div {...backdropProps} {...m.backdrop}>
      {useCard ? (
        <motion.div {...cardProps} {...m.card}>
          {children}
        </motion.div>
      ) : (
        children
      )}
    </motion.div>
  )
}
