// Unified "Appearance" popover — one entry point for skin, light/dark
// mode, and accent colour. Replaces the old standalone ThemeToggle (cycle
// button) + AccentPicker (swatch trigger) in the toolbar.
//
// Reuses the project's established popover conventions:
//   - AccentPicker: uncontrolled trigger button → getBoundingClientRect()
//     anchor → portal-to-body panel (here we portal the panel too).
//   - ModelPicker / ContextMenu: fixed positioning, viewport clamp,
//     mousedown-outside + capture-phase Escape dismissal.
//
// The accent section embeds the already-exported <AccentSwatchGrid> so the
// swatch/custom/recents behaviour stays identical to the old picker.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import type { Skin, Theme } from '../utils/theme'
import { ACCENT_COLORS } from '../theme'
import { AccentSwatchGrid } from './AccentPicker'
import { IconSparkles, IconSun, IconMoon, IconMonitor, IconCheck } from './icons/ToolIcons'

interface Props {
  skin: Skin
  mode: Theme
  accentColor: string
  onSkin: (skin: Skin) => void
  onMode: (mode: Theme) => void
  onAccent: (color: string) => void
  className?: string
}

const SKIN_OPTIONS: { value: Skin; label: string; desc: string }[] = [
  { value: 'default', label: 'Default', desc: 'Flat, high-contrast' },
  { value: 'glow', label: 'Glow', desc: 'Soft depth & glow' },
  { value: 'anthropic', label: 'Anthropic', desc: 'Warm paper & terracotta' },
]

/** Anthropic's locked brand accent (terracotta). Mirrors the value in
 *  styles.css's [data-skin="anthropic"] block — shown as a non-interactive
 *  swatch so users see the colour is fixed, not pickable. */
const ANTHROPIC_ACCENT = '#d97757'

const MODE_OPTIONS: { value: Theme; label: string; icon: ReactNode }[] = [
  { value: 'light', label: 'Light', icon: <IconSun size={15} /> },
  { value: 'dark', label: 'Dark', icon: <IconMoon size={15} /> },
  { value: 'system', label: 'System', icon: <IconMonitor size={15} /> },
]

function AppearancePopover({
  skin,
  mode,
  accentColor,
  onSkin,
  onMode,
  onAccent,
  anchor,
  onClose,
}: {
  skin: Skin
  mode: Theme
  accentColor: string
  onSkin: (skin: Skin) => void
  onMode: (mode: Theme) => void
  onAccent: (color: string) => void
  anchor: { x: number; y: number }
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number }>(anchor)

  // Measure then nudge inward to stay in the viewport (mirrors ModelPicker).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const margin = 12
    const nx = Math.min(anchor.x, vw - rect.width - margin)
    const ny = Math.min(anchor.y, vh - rect.height - margin)
    setPos({ x: Math.max(margin, nx), y: Math.max(margin, ny) })
  }, [anchor.x, anchor.y])

  // Outside-click + capture-phase Escape.
  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('mousedown', onDocMouseDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDocMouseDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])

  return createPortal(
    <div
      ref={ref}
      className="appearance-panel"
      style={{ left: pos.x, top: pos.y }}
      role="dialog"
      aria-label="Appearance"
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Skin */}
      <div className="appearance-section">
        <div className="appearance-heading">Theme</div>
        <div className="appearance-skin-row">
          {SKIN_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              className={`appearance-skin-card${skin === o.value ? ' active' : ''}`}
              onClick={() => onSkin(o.value)}
              aria-pressed={skin === o.value}
            >
              <span className="appearance-skin-label">{o.label}</span>
              <span className="appearance-skin-desc">{o.desc}</span>
              {skin === o.value && (
                <span className="appearance-skin-check" aria-hidden>
                  <IconCheck size={13} />
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Mode */}
      <div className="appearance-section">
        <div className="appearance-heading">Mode</div>
        <div className="appearance-mode-row" role="radiogroup" aria-label="Colour mode">
          {MODE_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              className={`appearance-mode-btn${mode === o.value ? ' active' : ''}`}
              onClick={() => onMode(o.value)}
              role="radio"
              aria-checked={mode === o.value}
              title={o.label}
            >
              {o.icon}
              <span>{o.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Accent */}
      <div className="appearance-section">
        <div className="appearance-heading">Accent</div>
        {skin === 'anthropic' ? (
          <div className="appearance-accent-locked">
            <span
              className="appearance-accent-locked-swatch"
              style={{ background: ANTHROPIC_ACCENT }}
              aria-hidden
            />
            <span className="appearance-accent-locked-label">
              Locked to Anthropic terracotta
            </span>
          </div>
        ) : (
          <AccentSwatchGrid
            value={accentColor}
            onChange={(v) => onAccent(v ?? ACCENT_COLORS[0].accent)}
            ariaLabel="Accent colour"
          />
        )}
      </div>
    </div>,
    document.body,
  )
}

export function AppearancePanel({
  skin,
  mode,
  accentColor,
  onSkin,
  onMode,
  onAccent,
  className,
}: Props) {
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

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={className}
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Appearance"
        title="Appearance — theme, mode & accent"
      >
        <IconSparkles size={16} />
      </button>
      {anchor && (
        <AppearancePopover
          skin={skin}
          mode={mode}
          accentColor={accentColor}
          onSkin={onSkin}
          onMode={onMode}
          onAccent={onAccent}
          anchor={anchor}
          onClose={() => {
            setAnchor(null)
            triggerRef.current?.focus()
          }}
        />
      )}
    </>
  )
}
