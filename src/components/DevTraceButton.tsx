// Dev-only performance trace capture. Rendered in the app header only under
// `import.meta.env.DEV` (see App.tsx); the production bundle has no reference
// to this module.
//
// Two actions, matching the two ways jank gets investigated:
//   - Capture: snapshot the last 10s, keep recording for a 2s tail, download.
//   - Record:  start now, stop (or auto-stop at 60s), download.
//
// The file is Chrome Trace Event Format — Perfetto opens it directly.

import { useCallback, useEffect, useRef, useState } from 'react'
import { exportTrace, formatTraceSummary, TRACE_WINDOW_MS } from '../client-debug/jank-monitor'
import { downloadJson } from '../utils/downloadJson'
import { IconCircleDot, IconGauge } from './icons/ToolIcons'

const CAPTURE_WINDOW_MS = 10_000
const CAPTURE_TAIL_MS = 2_000
const MAX_RECORD_MS = TRACE_WINDOW_MS

function saveTrace(windowMs: number, now: number): void {
  const trace = exportTrace({ windowMs, now })
  downloadJson(`crw-trace-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, trace, { pretty: false })
  // Same summary line as `__crwTrace()`; coverage and any cap-evicted streams
  // make a short export impossible to mistake for a full one.
  console.log('[trace] saved', formatTraceSummary(trace))
}

export function DevTraceButton() {
  const [capturing, setCapturing] = useState(false)
  const [recording, setRecording] = useState(false)
  const recordingRef = useRef(false)
  const recordStartRef = useRef(0)
  const recordTimerRef = useRef<number | null>(null)
  const captureTimerRef = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (recordTimerRef.current != null) window.clearTimeout(recordTimerRef.current)
      if (captureTimerRef.current != null) window.clearTimeout(captureTimerRef.current)
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
      // covers the 2s tail recorded above.
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
    // The rings themselves retain 60s; a longer recording would silently
    // export only its tail.
    saveTrace(Math.min(now - recordStartRef.current, MAX_RECORD_MS), now)
    setRecording(false)
  }, [])

  const toggleRecord = useCallback(() => {
    if (recordingRef.current) {
      stopRecording()
      return
    }
    recordingRef.current = true
    recordStartRef.current = performance.now()
    setRecording(true)
    recordTimerRef.current = window.setTimeout(stopRecording, MAX_RECORD_MS)
  }, [stopRecording])

  return (
    <div className="dev-trace-group" role="group" aria-label="Performance trace">
      <button
        type="button"
        className={`btn btn-icon ${capturing ? 'active' : ''}`}
        onClick={capture}
        disabled={capturing || recording}
        title={
          capturing
            ? 'Capturing…'
            : recording
              ? 'Stop the recording first'
              : `Capture the last ${CAPTURE_WINDOW_MS / 1000}s (+${CAPTURE_TAIL_MS / 1000}s tail) as a Perfetto trace`
        }
        aria-label="Capture performance trace"
      >
        <IconGauge size={16} />
      </button>
      <button
        type="button"
        className={`btn btn-icon ${recording ? 'dev-trace-recording' : ''}`}
        onClick={toggleRecord}
        disabled={capturing}
        title={
          capturing
            ? 'Capturing…'
            : recording
              ? `Stop recording and save (max ${MAX_RECORD_MS / 1000}s)`
              : 'Start recording a performance trace'
        }
        aria-label={recording ? 'Stop recording performance trace' : 'Start recording performance trace'}
      >
        <IconCircleDot size={16} />
      </button>
    </div>
  )
}
