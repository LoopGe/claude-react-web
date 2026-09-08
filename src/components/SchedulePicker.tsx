// Time picker for scheduled sends. Rendered as a fixed-position popover
// anchored near the Composer's clock button (anchorRect = its bounding box).
// Backdrop click / Escape close. Confirm passes an epoch-ms fireAt upward.

import { useEffect, useMemo, useState } from 'react'
import { IconClock, IconX } from './icons/ToolIcons'

const PRESET_REL = [
  { label: 'In 10 minutes', ms: 10 * 60_000 },
  { label: 'In 30 minutes', ms: 30 * 60_000 },
  { label: 'In 1 hour', ms: 60 * 60_000 },
] as const

/** Next occurrence of `hour:minute` local — today if still ahead, else
 *  tomorrow. Presets must never resolve to a past instant. */
function nextAt(hour: number, minute: number, nowMs: number): { fireAt: number; today: boolean } {
  const d = new Date()
  d.setHours(hour, minute, 0, 0)
  const today = d.getTime()
  if (today > nowMs) return { fireAt: today, today: true }
  d.setDate(d.getDate() + 1)
  return { fireAt: d.getTime(), today: false }
}

/** Clamp to a time strictly in the future with a few seconds of slack so a
 *  preset landing inside MIN_DELAY_MS (server-enforced, 5s) still creates. */
function futureFloor(ms: number, nowMs: number): number {
  return Math.max(ms, nowMs + 5_000)
}

interface Props {
  anchorRect: DOMRect
  onPick: (fireAtMs: number) => void
  onClose: () => void
}

export function SchedulePicker({ anchorRect, onPick, onClose }: Props) {
  const [nowMs] = useState(() => Date.now())
  const [custom, setCustom] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const presets = useMemo(() => {
    const tonight = nextAt(18, 0, nowMs)
    const morning = nextAt(9, 0, nowMs)
    return [
      ...PRESET_REL.map((p) => ({ label: p.label, fireAt: futureFloor(nowMs + p.ms, nowMs) })),
      { label: tonight.today ? 'Tonight 18:00' : 'Tomorrow 18:00', fireAt: futureFloor(tonight.fireAt, nowMs) },
      { label: morning.today ? 'Today 9:00' : 'Tomorrow 9:00', fireAt: futureFloor(morning.fireAt, nowMs) },
    ]
  }, [nowMs])

  const customMs = custom ? new Date(custom).getTime() : Number.NaN
  const validCustom = Number.isFinite(customMs) && customMs > nowMs
  const confirmDisabled = !validCustom

  const style = {
    left: Math.max(8, anchorRect.left + anchorRect.width / 2 - 150),
    top: Math.max(8, anchorRect.top - 300),
  }

  return (
    <>
      <div className="schedule-backdrop" data-testid="schedule-backdrop" onClick={onClose} />
      <div className="schedule-picker" style={style} role="dialog" aria-label="Schedule send">
        <div className="schedule-picker-head">
          <IconClock size={14} aria-hidden />
          <span>Schedule send</span>
          <button type="button" className="schedule-picker-close" aria-label="Close" onClick={onClose}>
            <IconX size={14} />
          </button>
        </div>
        <div className="schedule-picker-presets">
          {presets.map((p) => (
            <button
              key={p.label}
              type="button"
              className="schedule-preset"
              onClick={() => onPick(p.fireAt)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <label className="schedule-custom">
          <span>Custom time</span>
          <input
            type="datetime-local"
            aria-label="Custom time"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
          />
        </label>
        <div className="schedule-picker-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={confirmDisabled}
            onClick={() => validCustom && onPick(customMs)}
          >
            Schedule send
          </button>
        </div>
      </div>
    </>
  )
}
