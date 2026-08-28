// Shared AbortSignal helpers for the Windows sensor probes.
//
// The PDH GPU-utilization probe spawns a PowerShell child per query.
// `collectSnapshot` bounds it with PROBE_MAX_MS; when that budget expires it
// aborts the signal and the child must be killed rather than left running to
// its own 10s execFile timeout.
//
// An aborted probe must reject (not degrade to "no data"): a timeout-induced
// empty result is not evidence the machine lacks the sensor.

export function abortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError')
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}
