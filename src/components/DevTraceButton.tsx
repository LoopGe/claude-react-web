// Dev-only performance trace capture. Rendered in the app header only under
// `import.meta.env.DEV` (see App.tsx); the production bundle has no reference
// to this module.
//
// Two actions, matching the two ways jank gets investigated:
//   - Capture: snapshot the last 10s, keep recording for a 2s tail, download.
//   - Record:  start now, stop (or auto-stop at 60s), download.
// Right-clicking Record configures the optional recording-scoped probes.

import { useCallback, useEffect, useRef, useState } from 'react'
import { exportTrace, formatTraceSummary, markJank, TRACE_WINDOW_MS } from '../client-debug/jank-monitor'
import {
  DEFAULT_TRACE_RECORD_OPTIONS,
  startTraceDiagnostics,
  stopTraceDiagnostics,
  type TraceRecordOptions,
} from '../client-debug/trace-diagnostics'
import { useLocalStorage } from '../hooks/useLocalStorage'
import { useEscapeStack } from '../hooks/useEscapeStack'
import { useOutsideMouseDown } from '../hooks/useOutsideMouseDown'
import { downloadJson } from '../utils/downloadJson'
import { HoverHint } from './HoverHint'
import { HoverPopover } from './HoverPopover'
import { IconCircleDot, IconGauge } from './icons/ToolIcons'

const CAPTURE_WINDOW_MS = 10_000
const CAPTURE_TAIL_MS = 2_000
const MAX_RECORD_MS = TRACE_WINDOW_MS
const RECORD_OPTIONS_KEY = 'crw:dev-trace-record-options:v1'

const OPTION_LABELS: Array<{ key: keyof TraceRecordOptions; label: string }> = [
  { key: 'performance', label: 'Performance' },
  { key: 'reactInput', label: 'React & input' },
  { key: 'foldScroll', label: 'Fold & scroll geometry' },
  { key: 'visual', label: 'Visual movement' },
]

function isTraceRecordOptions(value: unknown): value is TraceRecordOptions {
  if (!value || typeof value !== 'object') return false
  const options = value as Record<string, unknown>
  return OPTION_LABELS.every(({ key }) => typeof options[key] === 'boolean')
}

function saveTrace(windowMs: number, now: number, recordOptions?: TraceRecordOptions): void {
  const trace = exportTrace({ windowMs, now, recordOptions })
  downloadJson(`crw-trace-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, trace, { pretty: false })
  // Same summary line as `__crwTrace()`; coverage and any cap-evicted streams
  // make a short export impossible to mistake for a full one.
  console.log('[trace] saved', formatTraceSummary(trace))
}

export function DevTraceButton() {
  const [capturing, setCapturing] = useState(false)
  const [recording, setRecording] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [recordOptions, setRecordOptions] = useLocalStorage<TraceRecordOptions>(
    RECORD_OPTIONS_KEY,
    DEFAULT_TRACE_RECORD_OPTIONS,
    { validate: isTraceRecordOptions },
  )
  const recordingRef = useRef(false)
  const recordStartRef = useRef(0)
  const recordOptionsRef = useRef<TraceRecordOptions>(DEFAULT_TRACE_RECORD_OPTIONS)
  const recordTimerRef = useRef<number | null>(null)
  const captureTimerRef = useRef<number | null>(null)
  const recordButtonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const closeMenu = useCallback(() => setMenuOpen(false), [])
  useOutsideMouseDown({ ref: menuRef, onClose: closeMenu, triggerRef: recordButtonRef, nonPrimary: 'ignore', active: menuOpen })
  useEscapeStack({ active: menuOpen, onEscape: closeMenu, getContainer: () => menuRef.current })

  useEffect(
    () => () => {
      if (recordTimerRef.current != null) window.clearTimeout(recordTimerRef.current)
      if (captureTimerRef.current != null) window.clearTimeout(captureTimerRef.current)
      if (recordingRef.current) stopTraceDiagnostics()
    },
    [],
  )

  const capture = useCallback(() => {
    if (capturing || recordingRef.current) return
    setCapturing(true)
    const startedAt = performance.now()
    captureTimerRef.current = window.setTimeout(() => {
      captureTimerRef.current = null
      const now = performance.now()
      // The snapshot starts 10s before the click, so the exported window also
      // covers the 2s tail recorded above. Capture never includes manual-Record probes.
      saveTrace(now - (startedAt - CAPTURE_WINDOW_MS), now)
      setCapturing(false)
    }, CAPTURE_TAIL_MS)
  }, [capturing])

  const stopRecording = useCallback(() => {
    if (!recordingRef.current) return
    recordingRef.current = false
    if (recordTimerRef.current != null) {
      window.clearTimeout(recordTimerRef.current)
      recordTimerRef.current = null
    }
    const now = performance.now()
    stopTraceDiagnostics()
    markJank('trace record stop')
    // The rings themselves retain 60s; a longer recording would silently
    // export only its tail. The frozen selection describes this whole file.
    saveTrace(Math.min(now - recordStartRef.current, MAX_RECORD_MS), now, recordOptionsRef.current)
    setRecording(false)
  }, [])

  const toggleRecord = useCallback(() => {
    if (recordingRef.current) {
      stopRecording()
      return
    }
    setMenuOpen(false)
    const selection = { ...recordOptions }
    recordOptionsRef.current = selection
    recordingRef.current = true
    recordStartRef.current = performance.now()
    if (selection.foldScroll || selection.visual) startTraceDiagnostics(selection)
    markJank('trace record start')
    setRecording(true)
    recordTimerRef.current = window.setTimeout(stopRecording, MAX_RECORD_MS)
  }, [recordOptions, stopRecording])

  return (
    <div className="dev-trace-group" role="group" aria-label="Performance trace">
      <HoverHint
        label={
          capturing
            ? 'Capturing…'
            : recording
              ? 'Stop the recording first'
              : `Capture the last ${CAPTURE_WINDOW_MS / 1000}s (+${CAPTURE_TAIL_MS / 1000}s tail) as a Perfetto trace`
        }
        side="bottom"
        align="end"
      >
        <button
          type="button"
          className={`btn btn-icon ${capturing ? 'active' : ''}`}
          onClick={capture}
          disabled={capturing || recording}
          aria-label="Capture performance trace"
        >
          <IconGauge size={16} />
        </button>
      </HoverHint>
      <button
        ref={recordButtonRef}
        type="button"
        className={`btn btn-icon ${recording ? 'dev-trace-recording' : ''}`}
        onClick={toggleRecord}
        onContextMenu={(event) => {
          event.preventDefault()
          if (!recording && !capturing) setMenuOpen((open) => !open)
        }}
        disabled={capturing}
        aria-haspopup="dialog"
        aria-expanded={menuOpen}
        aria-label={recording ? 'Stop recording performance trace' : 'Start recording performance trace'}
      >
        <IconCircleDot size={16} />
      </button>
      {/* recordButtonRef is the menu anchor, so the hint uses HoverPopover
          directly instead of HoverHint (which owns its trigger ref). */}
      <HoverPopover triggerRef={recordButtonRef} side="bottom" align="end">
        {capturing
          ? 'Capturing…'
          : recording
            ? `Stop recording and save (max ${MAX_RECORD_MS / 1000}s)`
            : 'Start recording a performance trace; right-click for recording options'}
      </HoverPopover>
      {menuOpen && !recording && (
        <div ref={menuRef} className="dev-trace-menu" role="dialog" aria-label="Trace recording options">
          <div className="dev-trace-menu-title">Record options</div>
          {OPTION_LABELS.map(({ key, label }) => (
            <label key={key} className="dev-trace-menu-option">
              <input
                type="checkbox"
                checked={recordOptions[key]}
                onChange={() => {
                  setRecordOptions((current) => ({ ...current, [key]: !current[key] }))
                }}
              />
              <span>{label}</span>
            </label>
          ))}
          <div className="dev-trace-menu-note">Geometry and visual probes are recorded only between Record start and stop.</div>
        </div>
      )}
    </div>
  )
}
