// Accent-colour picker — a single swatch button that opens a popover
// hosting a grid of preset swatches plus a custom-colour input.
//
// Replaces the old naked row of tiny coloured dots that lived inline in
// the toolbar / dialogs. Three exports, bottom-up:
//
//   - AccentSwatchGrid  — pure presentational grid (radiogroup of swatches).
//   - AccentPickerPanel — controlled popover body (positioned at x/y by the
//                         caller; owns outside-click / Esc / viewport-nudge).
//                         Used by the session right-click flow, where the
//                         parent owns open state.
//   - AccentPicker      — uncontrolled trigger button + panel. Used by the
//                         toolbar and the new-session dialog.
//
// The popover reuses the same visual language and dismissal logic as
// ContextMenu.tsx (bg-elev / border / radius / shadow, mousedown-outside
// + capture-phase Esc + measured viewport clamp).

import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties } from 'react'
import { ACCENT_COLORS, isPresetAccent } from '../theme'
import { useRecentColors } from '../hooks/useRecentColors'
import { useEscapeStack } from '../hooks/useEscapeStack'

// --- Custom-colour swatch ---------------------------------------------------

interface CustomColorSwatchProps {
  /** Live preview as the user drags inside the OS picker. */
  onChange: (v: string) => void
  /** Fired once when the user commits a colour (native `change`). Used to
   *  record the colour in the recents list — NOT on every drag tick. */
  onCommitColor: (v: string) => void
}

/** The dashed "+" cell wrapping a hidden native colour input. Always an
 *  "add a custom colour" affordance now — the chosen colour shows up (and
 *  is highlighted) in the Recent row below rather than filling this cell,
 *  so a colour never appears twice. */
function CustomColorSwatch({ onChange, onCommitColor }: CustomColorSwatchProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  // React's onChange on <input type="color"> maps to the continuous `input`
  // event (good for live preview). The discrete commit — the OS picker
  // closing — is the native `change` event, which is what we want to push
  // into recents. Attach it directly so we don't spam recents with every
  // intermediate hue the user drags through.
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    const onNativeChange = () => onCommitColor(el.value)
    el.addEventListener('change', onNativeChange)
    return () => el.removeEventListener('change', onNativeChange)
  }, [onCommitColor])

  return (
    <label
      className="accent-swatch accent-swatch-custom"
      style={{ '--swatch': 'transparent', '--swatch-strong': 'var(--fg)' } as CSSProperties}
      aria-label="Add a custom colour"
      title="Add a custom colour"
    >
      <input
        ref={inputRef}
        type="color"
        defaultValue={ACCENT_COLORS[0].accent}
        onChange={(e) => onChange(e.target.value)}
      />
      <span className="accent-swatch-custom-plus" aria-hidden>+</span>
    </label>
  )
}

// --- Pure swatch grid -------------------------------------------------------

interface AccentSwatchGridProps {
  /** Current accent hex, or undefined = "use global default". */
  value: string | undefined
  onChange: (v: string | undefined) => void
  /** Show the dashed "use global accent" swatch as the first cell. */
  allowDefault?: boolean
  ariaLabel?: string
  /** Called after a discrete preset/default/recent selection so a hosting
   *  popover can auto-close. Deliberately NOT called from the native
   *  colour input's onChange (it fires continuously while the OS picker
   *  is open, which would close the popover mid-drag). */
  onCommit?: () => void
}

export const AccentSwatchGrid = memo(function AccentSwatchGrid({
  value,
  onChange,
  allowDefault,
  ariaLabel,
  onCommit,
}: AccentSwatchGridProps) {
  const { recents, addRecent } = useRecentColors()
  const isCustom = value != null && !isPresetAccent(value)
  const activeCustom = isCustom ? (value as string).toLowerCase() : undefined

  // Ensure the active custom colour is always visible/highlighted, even if
  // it isn't (yet) in the stored list — e.g. loaded from a persisted accent
  // after recents were cleared. Merge it to the front for display only.
  const displayRecents =
    activeCustom && !recents.some((c) => c.toLowerCase() === activeCustom)
      ? [activeCustom, ...recents]
      : recents

  return (
    <div className="accent-picker" role="radiogroup" aria-label={ariaLabel}>
      {allowDefault && (
        <button
          type="button"
          className={`accent-swatch accent-swatch-default${value === undefined ? ' active' : ''}`}
          onClick={() => {
            onChange(undefined)
            onCommit?.()
          }}
          role="radio"
          aria-checked={value === undefined}
          aria-label="Use global accent"
          title="Use global accent"
        />
      )}
      {ACCENT_COLORS.map((c) => (
        <button
          key={c.accent}
          type="button"
          className={`accent-swatch${value === c.accent ? ' active' : ''}`}
          style={{ '--swatch': c.accent, '--swatch-strong': c.strong } as CSSProperties}
          onClick={() => {
            onChange(c.accent)
            onCommit?.()
          }}
          role="radio"
          aria-checked={value === c.accent}
          aria-label={c.name}
          title={c.name}
        />
      ))}
      <CustomColorSwatch onChange={onChange} onCommitColor={addRecent} />

      {displayRecents.length > 0 && (
        <>
          <div className="accent-picker-divider" role="presentation">
            <span className="accent-picker-label">Recent</span>
          </div>
          {displayRecents.map((hex) => {
            const active = activeCustom === hex.toLowerCase()
            return (
              <button
                key={hex}
                type="button"
                className={`accent-swatch${active ? ' active' : ''}`}
                style={{ '--swatch': hex, '--swatch-strong': hex } as CSSProperties}
                onClick={() => {
                  onChange(hex)
                  addRecent(hex) // re-selecting bumps it to the front (LRU)
                  onCommit?.()
                }}
                role="radio"
                aria-checked={active}
                aria-label={`Recent colour ${hex}`}
                title={hex}
              />
            )
          })}
        </>
      )}
    </div>
  )
})

// --- Controlled popover panel ----------------------------------------------

interface AccentPickerPanelProps {
  /** Client-coordinate anchor (top-left of the panel before clamping). */
  x: number
  y: number
  value: string | undefined
  onChange: (v: string | undefined) => void
  onClose: () => void
  allowDefault?: boolean
  ariaLabel?: string
}

export function AccentPickerPanel({
  x,
  y,
  value,
  onChange,
  onClose,
  allowDefault,
  ariaLabel = 'Accent colour',
}: AccentPickerPanelProps) {
  const ref = useRef<HTMLDivElement>(null)
  // Measured position after layout — nudged inward if the panel would
  // otherwise overflow the viewport (mirrors ContextMenu.tsx).
  const [pos, setPos] = useState<{ x: number; y: number }>({ x, y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const nx = Math.min(x, vw - rect.width - 4)
    const ny = Math.min(y, vh - rect.height - 4)
    setPos({ x: Math.max(4, nx), y: Math.max(4, ny) })
  }, [x, y])

  // Move focus to the active (or first) swatch on open; restore on close.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const target =
      el.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]') ??
      el.querySelector<HTMLElement>('[role="radio"]')
    target?.focus()
  }, [])

  // Outside-click dismissal (Escape is owned by the shared stack below).
  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('mousedown', onDocMouseDown)
    return () => window.removeEventListener('mousedown', onDocMouseDown)
  }, [onClose])

  // Esc closes via the shared escape stack. The popover's container is this
  // root, so while it is the topmost layer whose container holds focus, one
  // Esc collapses just the popover — never the modal/panel beneath it.
  useEscapeStack({
    active: true,
    onEscape: onClose,
    getContainer: () => ref.current,
  })

  return createPortal(
    <div
      ref={ref}
      className="accent-popover"
      style={{ left: pos.x, top: pos.y }}
      role="dialog"
      aria-label={ariaLabel}
      // Stop mousedown so the window outside-click listener doesn't fire
      // when the user clicks inside the panel itself.
      onMouseDown={(e) => e.stopPropagation()}
    >
      <AccentSwatchGrid
        value={value}
        onChange={onChange}
        allowDefault={allowDefault}
        ariaLabel={ariaLabel}
        onCommit={onClose}
      />
    </div>,
    document.body,
  )
}

// --- Uncontrolled trigger + panel ------------------------------------------

interface AccentPickerProps {
  value: string | undefined
  onChange: (v: string | undefined) => void
  allowDefault?: boolean
  ariaLabel?: string
  /** Applied to the trigger button (e.g. "btn btn-icon" in the toolbar). */
  className?: string
}

export function AccentPicker({
  value,
  onChange,
  allowDefault,
  ariaLabel = 'Accent colour',
  className,
}: AccentPickerProps) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null)
  const open = anchor !== null

  const toggle = () => {
    if (open) {
      setAnchor(null)
      return
    }
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect) setAnchor({ x: rect.left, y: rect.bottom + 4 })
  }

  // Trigger swatch fill: a concrete hex shows that colour; undefined (only
  // when allowDefault) shows the dashed "default" affordance.
  const isCustom = value != null && !isPresetAccent(value)
  const showDefault = value === undefined
  const swatchStyle = {
    '--swatch': showDefault ? 'transparent' : value,
    '--swatch-strong': isCustom ? value : 'var(--fg)',
  } as CSSProperties

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`accent-trigger${className ? ` ${className}` : ''}`}
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={ariaLabel}
      >
        <span
          className={`accent-swatch${showDefault ? ' accent-swatch-default' : ''}`}
          style={swatchStyle}
          aria-hidden
        />
      </button>
      {anchor && (
        <AccentPickerPanel
          x={anchor.x}
          y={anchor.y}
          value={value}
          onChange={onChange}
          onClose={() => {
            setAnchor(null)
            // Restore focus to the trigger on close (ref access is fine
            // here — this runs in an event handler, not during render).
            triggerRef.current?.focus()
          }}
          allowDefault={allowDefault}
          ariaLabel={ariaLabel}
        />
      )}
    </>
  )
}
