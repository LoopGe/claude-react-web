// The one owner of "a mousedown outside this surface dismisses it".
//
// Eight components had hand-rolled copies of this listener (ContextMenu,
// CommandPicker, AppearancePanel, AccentPicker, PinnedUserMessage, ModelPicker,
// EffortSlider, SubagentSwarm) in two different button policies, reconciled
// only in prose comments that cross-referenced each other. This is that policy
// in one place, beside `useEscapeStack` — the same consolidation this repo
// already made for Escape.
//
// Not a fit for every document-level mousedown: EasterEggGame pauses on
// "pointer left the panel", with portal-owner bookkeeping and a `blur`
// listener — a different question, and it keeps its own handler.

import { useLayoutEffect } from 'react'
import type { RefObject } from 'react'

export interface OutsideMouseDownOptions {
  /** The surface. A press inside it is never "outside". A null ref (nothing
   *  mounted) simply has nothing to hit-test, so nothing closes. */
  ref: RefObject<Element | null>
  onClose: () => void
  /** The control that opened the surface, when it ALSO toggles it closed.
   *  A primary press here is the toggle, not an outside press: the click that
   *  follows runs the caller's toggle, and closing on the mousedown would
   *  unmount the surface first — the click would then see a null open-state
   *  and re-open it, so the trigger could never dismiss its own surface.
   *  Omit for a trigger that only opens.
   *
   *  A REF, not an element: the trigger usually mounts in the same commit as
   *  the caller that passes it, so a captured `triggerRef.current` read during
   *  render is still null on the first pass and the exemption would silently
   *  never apply. */
  triggerRef?: RefObject<Element | null>
  /** What a press that cannot produce a `click` does — i.e. a non-primary
   *  button (right/middle). 'close' (default) treats it as an ordinary outside
   *  press; 'ignore' leaves the surface open for the caller's own replacement
   *  UI (ContextMenu: the browser fires `contextmenu` next, and closing first
   *  makes the menu flash shut and open).
   *
   *  Deliberately does NOT cover macOS ctrl+click: that gesture is clickless
   *  and secondary THERE, but on Windows/Linux ctrl+click IS an ordinary
   *  click of the primary button. Classifying it here would either strand a
   *  ContextMenu on Windows (no `contextmenu` follows to replace it) or, at a
   *  trigger, close the surface and let the following click re-open it — the
   *  exact flicker the `triggerRef` exemption exists to remove. So a
   *  ctrl+click is treated as a primary press, and at a trigger it stays open
   *  under macOS's native menu until something else dismisses it. */
  nonPrimary?: 'close' | 'ignore'
  /** Listen in the capture phase. Default (bubble) is what a surface with a
   *  toggling trigger needs: the trigger's own click must still run. */
  capture?: boolean
  /** False while this dismissal must not be armed (surface collapsed, effect
   *  not yet opened). Defaults to true. */
  active?: boolean
}

/** Dismiss a floating surface when the user presses outside it.
 *
 *  Registered on `window` — outside means outside the surface and the trigger,
 *  which may live in different subtrees (the trigger is usually not portaled,
 *  the surface usually is). */
export function useOutsideMouseDown({
  ref,
  onClose,
  triggerRef,
  nonPrimary = 'close',
  capture = false,
  active = true,
}: OutsideMouseDownOptions): void {
  // useLayoutEffect, not useEffect: the listener must exist by the end of the
  // commit, not one passive-effect flush later. react-dom 19 schedules passive
  // effects on a macrotask and does NOT flush them in the discrete-event path,
  // so a press delivered in the same task as the mount would find no listener.
  useLayoutEffect(() => {
    if (!active) return
    const onDocMouseDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (ref.current?.contains(target)) return
      if (e.button !== 0) {
        if (nonPrimary === 'close') onClose()
        return
      }
      if (triggerRef?.current?.contains(target)) return
      onClose()
    }
    window.addEventListener('mousedown', onDocMouseDown, capture)
    return () => window.removeEventListener('mousedown', onDocMouseDown, capture)
  }, [ref, onClose, triggerRef, nonPrimary, capture, active])
}