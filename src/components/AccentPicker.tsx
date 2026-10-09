// Accent-colour swatch grid — the pure presentational radiogroup of preset
// swatches plus a custom-colour input, embedded inline by the AppearancePanel
// (the global accent picker in the settings overlay).
//
// The former popover wrappers (the uncontrolled trigger+panel pair and the
// controlled AccentPickerPanel) hosted this grid as a portaled floating
// surface for the per-session accent flows; those flows were removed, and
// with them the wrappers.

import { memo, useEffect, useRef } from 'react'
import type { CSSProperties } from 'react'
import { ACCENT_COLORS, isPresetAccent } from '../theme'
import { useRecentColors } from '../hooks/useRecentColors'

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
}

export const AccentSwatchGrid = memo(function AccentSwatchGrid({
  value,
  onChange,
  allowDefault,
  ariaLabel,
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
          onClick={() => onChange(undefined)}
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
          onClick={() => onChange(c.accent)}
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
