// One-shot structured-output run hook. POSTs to /structured (headless query,
// server-owned timeout) and surfaces the parsed JSON result or a narrowed
// error. Supports cancel via AbortController.

import { useCallback, useRef, useState } from 'react'
import { api } from './useApi'
import type { StructuredRunRequest, StructuredRunResult } from '../../shared/structured'

export function useStructuredRun() {
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<StructuredRunResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const run = useCallback(async (req: StructuredRunRequest) => {
    // Drop any in-flight run before starting a fresh one.
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setRunning(true)
    setResult(null)
    setError(null)
    try {
      // timeoutMs 0: the server owns the deadline (aborts the subprocess and
      // returns 408); a client wall-clock would race it.
      const res = await api.post<StructuredRunResult>('/structured', req, {
        signal: controller.signal,
        timeoutMs: 0,
      })
      if (controller.signal.aborted) return
      setResult(res)
    } catch (err) {
      if (controller.signal.aborted) return // user cancelled — no error flash
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
    } finally {
      if (abortRef.current === controller) setRunning(false)
    }
  }, [])

  const cancel = useCallback(() => abortRef.current?.abort(), [])

  const reset = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setRunning(false)
    setResult(null)
    setError(null)
  }, [])

  return { running, result, error, run, cancel, reset }
}