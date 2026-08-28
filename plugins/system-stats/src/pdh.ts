// Windows-only GPU utilization probe via the GPU Engine performance counters.
//
// `systeminformation.graphics()` only reports `utilizationGpu` for NVIDIA GPUs
// (it shells out to nvidia-smi). On Intel/AMD this probe is the fallback: it
// reads `Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine` and sums each
// LUID's engine utilization into a per-LUID "GPU busy" percentage. A physical
// GPU can expose several LUIDs, so `collectSnapshot` trusts the probe only when
// exactly one controller lacks utilization and takes the busiest LUID — WMI LUID
// order does not match its controller order, so a by-index merge could mislabel
// a multi-GPU machine. Never invoked off Windows.

import { execFile } from 'node:child_process'
import { abortError, isAbortError } from './abort.js'

export interface PdhGpuUtilProbe {
  /** `signal` is aborted when the caller's probe budget (PROBE_MAX_MS) expires;
   *  the PowerShell child is killed and the promise rejects with an AbortError
   *  so the caller can tell "timed out" from "no data". */
  probe: (signal?: AbortSignal) => Promise<Array<{ utilizationGpu?: number }>>
}

// Projected WQL so the provider returns only the two fields we need. The engine
// set is large (hundreds of instances); grouping happens in PowerShell so the
// child writes back only a few KB per sample instead of the full engine list.
const POWERSHELL_SCRIPT = `
$e = Get-CimInstance -Query "SELECT Name, UtilizationPercentage FROM Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine" -ErrorAction Stop | Where-Object { $null -ne $_.UtilizationPercentage }
$e | Group-Object { if ($_.Name -match '_luid_([^_]+_[^_]+)_phys_') { $matches[1] } else { 'unknown' } } | ForEach-Object { [pscustomobject]@{ luid = $_.Name; utilization = [math]::Round((($_.Group | Measure-Object UtilizationPercentage -Sum).Sum), 1) } } | ConvertTo-Json -Compress
`

export function queryViaPowershell(script: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (signal?.aborted) {
          reject(abortError())
          return
        }
        // Any failure (counter absent, older Windows, quota) degrades to no
        // probe data — the widget simply keeps the '—' rows.
        resolve(err ? '' : stdout.trim())
      },
    )
    // Abort → kill the child so a probe that blew its budget doesn't keep a
    // PowerShell process running until its own 10s execFile timeout.
    signal?.addEventListener('abort', () => child.kill(), { once: true })
  })
}

/** Parse the probe's `[{ luid, utilization }]` JSON into the shape
 *  `collectSnapshot` expects, clamping each value to 0–100. Invalid/empty
 *  input resolves to `[]` so a probe hiccup never breaks the sample. */
export function parseUtilizationJson(raw: string): Array<{ utilizationGpu?: number }> {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    const items = Array.isArray(parsed) ? parsed : parsed ? [parsed] : []
    return items.map((g) => {
      const u = typeof g === 'object' && g !== null ? (g as { utilization?: unknown }).utilization : undefined
      const n = typeof u === 'number' && Number.isFinite(u) ? u : undefined
      return { utilizationGpu: n != null ? Math.min(100, Math.max(0, n)) : undefined }
    })
  } catch {
    return []
  }
}

export function createPdhGpuUtilProbe(query: (script: string, signal?: AbortSignal) => Promise<string> = queryViaPowershell): PdhGpuUtilProbe {
  return {
    probe: async (signal) => {
      try {
        return parseUtilizationJson(await query(POWERSHELL_SCRIPT, signal))
      } catch (err) {
        // An aborted probe is a timeout, not "no GPU data" — re-throw so the
        // caller doesn't mistake the empty result for a real absence.
        if (isAbortError(err)) throw err
        return []
      }
    },
  }
}
