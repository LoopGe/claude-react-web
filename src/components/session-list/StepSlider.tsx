import { useRef } from 'react'
import type React from 'react'

export interface StepDef {
  value: number
  label: string
  beta?: string
}

export function StepSlider({
  steps,
  value,
  onChange,
}: {
  steps: readonly StepDef[]
  value: number
  onChange: (idx: number) => void
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const dragIdxRef = useRef<number | null>(null)

  /** Given a pointer X relative to the viewport, find the nearest step. */
  const nearestStep = (clientX: number): number => {
    const el = trackRef.current
    if (!el) return value
    const rect = el.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    return Math.round(ratio * (steps.length - 1))
  }

  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault()
    const idx = nearestStep(e.clientX)
    dragIdxRef.current = idx
    onChange(idx)
    // Capture so we keep receiving events even if the pointer leaves the track.
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }

  const handlePointerMove = (e: React.PointerEvent) => {
    if (dragIdxRef.current === null) return
    const idx = nearestStep(e.clientX)
    if (idx !== dragIdxRef.current) {
      dragIdxRef.current = idx
      onChange(idx)
    }
  }

  const handlePointerUp = () => {
    dragIdxRef.current = null
  }

  const pct = steps.length > 1 ? (value / (steps.length - 1)) * 100 : 0

  return (
    <div className="step-slider">
      {/* Value readout */}
      <div className="step-slider-readout">
        {steps.map((s, i) => (
          <span key={s.label} className={`step-slider-label${i === value ? ' active' : ''}`}>
            {s.label}
          </span>
        ))}
      </div>
      {/* Track */}
      <div
        ref={trackRef}
        className="step-slider-track"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <div className="step-slider-fill" style={{ width: `${pct}%` }} />
        {steps.map((s, i) => {
          const leftPct = (i / (steps.length - 1)) * 100
          return (
            <div
              key={s.label}
              className={`step-slider-dot${i === value ? ' active' : ''}`}
              style={{ left: `${leftPct}%` }}
            />
          )
        })}
        <div
          className="step-slider-thumb"
          style={{ left: `${pct}%` }}
        />
      </div>
    </div>
  )
}
