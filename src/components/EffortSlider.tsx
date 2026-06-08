// Discrete effort-level slider, shown as a popover anchored under the
// ChatPanel header's effort chip. Replaces the plain dropdown menu with a
// horizontal slider whose stops are the supported effort levels (low → max).
//
// Mirrors ContextMenu's popover mechanics: fixed positioning at an anchor
// point, viewport clamp, outside-click + capture-phase Escape dismissal.
//
// The slider is a native <input type="range"> over the index into `levels`
// (step 1), so keyboard arrows and click-to-position work for free. Tick
// labels under the track let the user see and click the named stops.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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
}

export function EffortSlider({ anchor, levels, current, disabled, onSelect, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number }>(anchor)

  const maxIndex = Math.max(0, levels.length - 1)
  // Controlled by `current`. The caller updates the session optimistically
  // (see ChatPanel.commitEffortLevel) so this prop changes synchronously as
  // the user drags — the thumb follows without local state, and a failed
  // POST rolls the prop back, snapping the thumb to the prior level.
  const index = Math.max(0, levels.indexOf(current))

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

  return (
    <div
      ref={ref}
      className="effort-slider"
      style={{ left: pos.x, top: pos.y }}
      role="dialog"
      aria-label="Select effort level"
      onMouseDown={(e) => e.stopPropagation()}
      // The popover renders inside the ChatPanel header, which is
      // `draggable` (panel-swap handle). Dragging the slider thumb would
      // otherwise start that native drag and move the whole panel. Cancel
      // the drag here and stop it bubbling to the header. (dragstart is a
      // separate event from mousedown, so the stopPropagation above can't
      // cover it.)
      draggable={false}
      onDragStart={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <div className="effort-slider-head">
        <span className="effort-slider-title">Effort</span>
        <span className="effort-slider-value">{current}</span>
      </div>
      <input
        className="effort-slider-range"
        type="range"
        min={0}
        max={maxIndex}
        step={1}
        value={index}
        disabled={disabled}
        aria-label="Effort level"
        aria-valuetext={current}
        onChange={(e) => selectIndex(Number(e.target.value))}
      />
      <div className="effort-slider-ticks" aria-hidden>
        {levels.map((l, i) => (
          <button
            key={l}
            type="button"
            className={`effort-slider-tick${i === index ? ' active' : ''}`}
            disabled={disabled}
            tabIndex={-1}
            onClick={() => selectIndex(i)}
          >
            {l}
          </button>
        ))}
      </div>
    </div>
  )
}
