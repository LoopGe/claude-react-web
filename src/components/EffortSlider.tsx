// Discrete effort-level slider, shown as a popover anchored under the
// ChatPanel header's effort chip. Replaces the plain dropdown menu with a
// horizontal slider whose stops are the supported effort levels (low → max).
//
// Mirrors ContextMenu's popover mechanics: fixed positioning at an anchor
// point, viewport clamp, outside-click + capture-phase Escape dismissal.
//
// The slider is a native <input type="range"> over the index into `levels`
// (step 1), so keyboard arrows and click-to-position work for free. Tick
// labels under the track let the user see and click the name stops.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { EffortLevel } from '../types'

interface Props {
  /** Client-coordinate anchor (typically the chip's bottom-left). */
  anchor: { x: number; y: number }
  /** Levels to offer, in order (low → max). At least one. */
  levels: EffortLevel[]
  /** Currently selected level. If not in `levels`, the slider clamps to 0. */
  current: EffortLevel
  disabled?: boolean
  /** Called with the chosen level when the user moves the slider. */
  onSelect: (level: EffortLevel) => void
  onClose: () => void
  isExiting?: boolean
}

export function EffortSlider({ anchor, levels, current, disabled, onSelect, onClose, isExiting = false }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number }>(anchor)

  const maxIndex = Math.max(0, levels.length - 1)
  const index = Math.max(0, levels.indexOf(current))

  // Continuous (无级) drag: while the user is dragging, `dragVal` holds the
  // raw float position so the thumb glides smoothly between stops. We do NOT
  // commit on every move — only on release do we snap to the nearest level
  // and call onSelect. When not dragging, `dragVal` is null and the thumb is
  // controlled by `index` (the committed level, kept in sync optimistically
  // by the caller). A failed POST rolls `current` back, snapping the thumb.
  const [dragVal, setDragVal] = useState<number | null>(null)
  const value = dragVal ?? index
  // Holds the in-flight snap animation frame so a new drag (or unmount) can
  // cancel it. The animation eases `dragVal` from the release position to the
  // target stop, then clears `dragVal` so the thumb is controlled by `index`.
  const snapRaf = useRef<number | null>(null)
  // Nearest stop to the live position — drives the value label + active tick
  // so the UI previews where a release would land.
  const previewIndex = Math.min(maxIndex, Math.max(0, Math.round(value)))
  const previewLevel = levels[previewIndex] ?? current

  // Measure after layout and nudge inward to stay in the viewport.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const nx = Math.min(anchor.x, vw - rect.width - 4)
    const ny = Math.min(anchor.y, vh - rect.height - 4)
    setPos({ x: Math.max(4, nx), y: Math.max(4, ny) })
  }, [anchor.x, anchor.y])

  // Outside-click + capture-phase Escape (matches ContextMenu / ModelPicker).
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

  const selectIndex = (idx: number) => {
    const clamped = Math.min(maxIndex, Math.max(0, idx))
    const level = levels[clamped]
    if (level && level !== current) onSelect(level)
  }

  // Release handler: ease the float position from where the user let go to
  // the nearest stop (a spring-like "snap" animation), then commit the level
  // and drop back to controlled-by-`current` mode. Cancels any prior snap.
  const commitDrag = () => {
    if (snapRaf.current != null) cancelAnimationFrame(snapRaf.current)
    setDragVal((from) => {
      if (from == null) return null
      const target = Math.min(maxIndex, Math.max(0, Math.round(from)))
      if (Math.abs(from - target) < 0.001) {
        selectIndex(target)
        return null
      }
      const DURATION = 160 // ms
      const start = performance.now()
      // easeOutCubic — quick departure, gentle settle onto the stop.
      const ease = (t: number) => 1 - Math.pow(1 - t, 3)
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / DURATION)
        const v = from + (target - from) * ease(t)
        if (t >= 1) {
          snapRaf.current = null
          selectIndex(target)
          setDragVal(null)
        } else {
          setDragVal(v)
          snapRaf.current = requestAnimationFrame(step)
        }
      }
      snapRaf.current = requestAnimationFrame(step)
      return from
    })
  }

  // Cancel any in-flight snap animation on unmount.
  useEffect(() => () => {
    if (snapRaf.current != null) cancelAnimationFrame(snapRaf.current)
  }, [])

  return createPortal(
    <div
      ref={ref}
      className="effort-slider"
      data-state={isExiting ? 'closing' : 'open'}
      style={{ left: pos.x, top: pos.y }}
      role="dialog"
      aria-label="Select effort level"
      aria-hidden={isExiting}
      onMouseDown={(e) => e.stopPropagation()}
      // Rendered in a portal on document.body so the popover lives OUTSIDE
      // the ChatPanel header's `draggable` subtree. Otherwise dragging the
      // slider thumb starts the panel-swap native drag (a descendant of a
      // draggable element inherits the drag), moving the whole panel.
      // Keeping draggable=false here too as a belt-and-suspenders guard.
      draggable={false}
      onDragStart={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <div className="effort-slider-head">
        <span className="effort-slider-title">Effort</span>
        <span className="effort-slider-value">{previewLevel}</span>
      </div>
      <input
        className="effort-slider-range"
        type="range"
        min={0}
        max={maxIndex}
        // Fine step gives 无级 (continuous) glide between name stops; we
        // snap to the nearest integer level only on release (commitDrag).
        step={0.01}
        value={value}
        disabled={disabled}
        aria-label="Effort level"
        aria-valuetext={previewLevel}
        onChange={(e) => {
          // Grabbing the thumb mid-snap cancels the in-flight animation so
          // the user's drag takes over cleanly.
          if (snapRaf.current != null) {
            cancelAnimationFrame(snapRaf.current)
            snapRaf.current = null
          }
          setDragVal(Number(e.target.value))
        }}
        onPointerUp={commitDrag}
        onPointerCancel={commitDrag}
        onBlur={commitDrag}
        // Arrow keys should step by whole levels (not 0.01), so intercept
        // them: move from the current preview stop and commit immediately.
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
            e.preventDefault()
            setDragVal(null)
            selectIndex(previewIndex - 1)
          } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
            e.preventDefault()
            setDragVal(null)
            selectIndex(previewIndex + 1)
          } else if (e.key === 'Home') {
            e.preventDefault()
            setDragVal(null)
            selectIndex(0)
          } else if (e.key === 'End') {
            e.preventDefault()
            setDragVal(null)
            selectIndex(maxIndex)
          }
        }}
      />
      <div className="effort-slider-ticks" aria-hidden>
        {levels.map((l, i) => (
          <button
            key={l}
            type="button"
            className={`effort-slider-tick${i === previewIndex ? ' active' : ''}`}
            disabled={disabled}
            tabIndex={-1}
            onClick={() => {
              setDragVal(null)
              selectIndex(i)
            }}
          >
            {l}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  )
}
