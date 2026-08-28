// NB: from plugins/system-stats/src/ the shared dir is three levels up:
// src → system-stats → plugins → repo root. `../../../shared/...`
import type { StatGridPayload, StatRow } from '../../../shared/app-plugins/widget.js'

export const THRESHOLDS = { warn: 75, danger: 90 } as const

export interface GpuInfo {
  // `model` is optional: systeminformation can report a controller with an
  // empty/missing model (headless VMs, some platforms), and `buildStatGrid`
  // falls back to a "GPU" label rather than throwing on `.trim()`.
  model?: string
  /** 0–100. Only filled by systeminformation for NVIDIA (nvidia-smi); the
   *  Windows PDH fallback fills it for Intel/AMD. */
  utilizationGpu?: number
  /** Degrees C. Filled by systeminformation for NVIDIA (nvidia-smi) and Apple
   *  Silicon; unavailable for Intel/AMD on Windows. */
  temperatureGpu?: number
}

export interface RawSnapshot {
  /** `brand` is the CPU model name (`si.cpu().brand`). It is static, so the
   *  service resolves it once and threads it in — never re-read per sample. */
  cpu?: { currentLoad: number; brand?: string }
  /** Degrees C. From `si.cpuTemperature().main` — null on Windows when the
   *  process is not elevated (WMI MSAcpi requires admin), so usually absent
   *  there and the widget shows '—'; present on Linux/macOS and elevated
   *  Windows. */
  cpuTemp?: number
  mem?: { total: number; used: number }
  disks?: Array<{ fs: string; size: number; used: number; mount: string }>
  gpus?: GpuInfo[]
}

/** The injected subset of the `systeminformation` API, so tests never import it. */
export interface Si {
  currentLoad(): Promise<{ currentLoad: number }>
  mem(): Promise<{ total: number; used: number }>
  fsSize(): Promise<Array<{ fs: string; size: number; used: number; mount: string }>>
  graphics(): Promise<{ controllers: GpuInfo[] }>
  /** `main` is null on Windows when the process is not elevated (WMI
   *  MSAcpi_ThermalZoneTemperature requires admin) — the widget degrades to a
   *  '—' row in that case. */
  cpuTemperature(): Promise<{ main?: number | null }>
}

/** Optional Windows-only per-LUID GPU utilization probe (PDH/WMI fallback).
 *  Resolves one entry per LUID; entries with no data omit `utilizationGpu`.
 *  The signal is aborted when the PROBE_MAX_MS budget expires — a probe that
 *  honours it kills its child and rejects with an AbortError. */
export type GpuUtilProbe = (signal?: AbortSignal) => Promise<Array<{ utilizationGpu?: number }>>

/** Optional CPU temperature source, typically a TTL-cached
 *  `si.cpuTemperature()`. Resolves °C, or undefined when no temperature is
 *  readable (e.g. non-elevated Windows). */
export type CpuTempProbe = () => Promise<number | undefined>

/** Optional CPU model source, typically a TTL-cached `si.cpu().brand`
 *  (`si.cpu()` costs ~1.8s of WMI on Windows, so it is cached for an hour).
 *  Resolves the model name, or undefined when none is readable. */
export type CpuBrandProbe = () => Promise<string | undefined>

/** Cap on how long a sensor probe may delay a sample. A slow/cold provider
 *  would otherwise stall the whole widget; this bound degrades to '—' (or no
 *  GPU utilization) instead. */
export const PROBE_MAX_MS = 5000

/** Resolve with the probe result, or `fallback` if it takes longer than `ms`.
 *  When the budget expires, `onTimeout` is invoked BEFORE the fallback resolves
 *  so the caller can abort the underlying probe's child process — otherwise a
 *  slow Windows probe would keep its PowerShell process running in the
 *  background until the probe's own (longer) execFile timeout. The timer is
 *  cleared when the probe settles, so a fast probe leaves no dangling handle. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T, onTimeout?: () => void): Promise<T> {
  return new Promise((resolve) => {
    let done = false
    const timer = setTimeout(() => {
      if (!done) {
        done = true
        onTimeout?.()
        resolve(fallback)
      }
    }, ms)
    p.then(
      (value) => {
        if (!done) {
          done = true
          clearTimeout(timer)
          resolve(value)
        }
      },
      () => {
        if (!done) {
          done = true
          clearTimeout(timer)
          resolve(fallback)
        }
      },
    )
  })
}

export async function collectSnapshot(opts: {
  si: Si
  disks: string[]
  /** Windows PDH fallback for GPUs systeminformation reports no utilization
   *  for (Intel/AMD). Runs after `graphics()` and only when a controller lacks
   *  utilization, so NVIDIA machines never pay for the PowerShell spawn. */
  gpuUtil?: GpuUtilProbe
  /** CPU temperature source (defaults to `si.cpuTemperature()`). The service
   *  passes a TTL-cached wrapper so a slow WMI null on non-elevated Windows is
   *  paid once per window instead of on every sample. Authoritative when
   *  provided — the direct `si.cpuTemperature()` path is skipped. */
  cpuTempProbe?: CpuTempProbe
  /** CPU model source (defaults to none). The service passes a TTL-cached
   *  `si.cpu().brand`; the model is static, so it is resolved once and served
   *  from cache thereafter. Runs inside the same `Promise.all` as the other
   *  probes so the ~1.8s first read overlaps them instead of delaying the
   *  sample. */
  cpuBrandProbe?: CpuBrandProbe
}): Promise<RawSnapshot> {
  const { si, disks, gpuUtil, cpuTempProbe, cpuBrandProbe } = opts
  // The GPU probe gets its own controller so a budget expiry can abort just its
  // child process (see the PDH branch below).
  const [cpu, mem, fs, graphics, cpuTemp, cpuBrand] = await Promise.all([
    si.currentLoad().catch(() => undefined),
    si.mem().catch(() => undefined),
    si.fsSize().catch(() => undefined),
    si.graphics().catch(() => undefined),
    cpuTempProbe
      ? withTimeout(cpuTempProbe().catch(() => undefined), PROBE_MAX_MS, undefined)
      : si.cpuTemperature().then((t) => (t && typeof t.main === 'number' && Number.isFinite(t.main) ? t.main : undefined), () => undefined),
    cpuBrandProbe
      ? withTimeout(cpuBrandProbe().catch(() => undefined), PROBE_MAX_MS, undefined)
      : Promise.resolve(undefined),
  ])
  const result: RawSnapshot = {}
  if (cpu) result.cpu = { currentLoad: cpu.currentLoad, brand: cpuBrand }
  if (cpuTemp != null) result.cpuTemp = cpuTemp
  if (mem) result.mem = { total: mem.total, used: mem.used }
  if (fs) result.disks = pickDisks(fs, disks)
  if (graphics) {
    let controllers = graphics.controllers.map((c) => ({
      model: c.model,
      utilizationGpu: c.utilizationGpu,
      temperatureGpu: c.temperatureGpu,
    }))
    const missing = controllers.filter((c) => c.utilizationGpu == null)
    // Sequential, not parallel: running the probe concurrently with
    // `graphics()` (which itself spawns ~8 PowerShell subprocesses on Windows)
    // made both measurably slower and the probe was dropping out under the
    // timeout. On its own the probe is ~1.8s.
    //
    // The probe runs only when exactly one controller lacks utilization. WMI
    // LUID order does not match systeminformation's controller order, so a
    // by-index merge could attribute a load figure to the wrong physical GPU
    // on a multi-GPU machine. With one missing controller the attribution is
    // unambiguous (a single physical GPU can surface as several LUIDs, so the
    // busiest one is the meaningful "GPU busy" figure); with several missing we
    // keep '—' rather than risk misattribution — and skip the probe entirely,
    // since its only possible use (the merge) is off the table.
    if (gpuUtil && missing.length === 1) {
      const empty: Array<{ utilizationGpu?: number }> = []
      const gpuController = new AbortController()
      const pdh = await withTimeout(gpuUtil(gpuController.signal).catch(() => []), PROBE_MAX_MS, empty, () => gpuController.abort())
      const values = pdh.map((g) => g.utilizationGpu).filter((n): n is number => n != null)
      if (values.length > 0) {
        const busiest = clampPct(Math.max(...values))
        controllers = controllers.map((c) => (c.utilizationGpu == null ? { ...c, utilizationGpu: busiest } : c))
      }
    }
    result.gpus = controllers
  }
  return result
}

function clampPct(n: number): number {
  return Math.min(100, Math.max(0, n))
}

export function pickDisks(
  disks: RawSnapshot['disks'] extends infer D ? NonNullable<D> : never,
  wanted: string[],
): RawSnapshot['disks'] {
  if (!disks) return disks
  if (wanted.length > 0) return disks.filter((d) => wanted.includes(d.mount))
  const physical = disks.filter((d) => d.fs.startsWith('/dev/') || /^[A-Za-z]:/.test(d.fs))
  const source = physical.length > 0 ? physical : disks
  return [...source].sort((a, b) => b.size - a.size).slice(0, 3)
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n))
}

function toneFor(progress: number): 'ok' | 'warn' | 'danger' {
  if (progress >= THRESHOLDS.danger / 100) return 'danger'
  if (progress >= THRESHOLDS.warn / 100) return 'warn'
  return 'ok'
}

/** A metric group selectable via the `rows` configuration. */
export type StatGroupId = 'cpu' | 'mem' | 'disk' | 'gpu'

/** Display order when the user has not configured `rows` (or configured an
 *  empty list). Kept in this module so tests pin the default. */
export const DEFAULT_GROUPS: readonly StatGroupId[] = ['cpu', 'mem', 'disk', 'gpu']

/** Resolve the user's `rows` config (comma-separated string array, order
 *  matters) into the groups to emit. Unknown/duplicate entries are dropped;
 *  an empty or all-invalid list falls back to the default so a typo can't
 *  blank the widget. */
function resolveGroupOrder(rows: string[] | undefined): StatGroupId[] {
  if (!rows || rows.length === 0) return [...DEFAULT_GROUPS]
  const seen = new Set<StatGroupId>()
  const out: StatGroupId[] = []
  for (const r of rows) {
    const g = r.trim() as StatGroupId
    if (g !== 'cpu' && g !== 'mem' && g !== 'disk' && g !== 'gpu') continue
    if (seen.has(g)) continue
    seen.add(g)
    out.push(g)
  }
  return out.length > 0 ? out : [...DEFAULT_GROUPS]
}

/** Label a disk row with its mount point so two disks are distinguishable —
 *  `C:` vs `D:` on Windows, `/` vs `/home` on Linux. Falls back to the device
 *  name, then a plain "Disk". */
function diskLabel(mount: string | undefined, fs: string | undefined): string {
  const raw = (mount && mount.trim() ? mount : fs ?? '').trim()
  if (!raw) return 'Disk'
  // Windows mounts read `C:\`; drop the trailing separator so it reads `C:`.
  // Linux root `/` is left intact.
  return raw.replace(/\\+$/, '').slice(0, 14) || 'Disk'
}

function gpuRows(gpus: GpuInfo[]): StatRow[] {
  const rows: StatRow[] = []
  for (const [i, g] of gpus.entries()) {
    const label = (g.model ?? '').trim().slice(0, 14) || 'GPU'
    const hasUtil = g.utilizationGpu != null
    const hasTemp = g.temperatureGpu != null
    if (hasUtil) {
      const p = clamp01(g.utilizationGpu! / 100)
      rows.push({ id: `gpu:${i}`, label, value: g.utilizationGpu!.toFixed(0), unit: '%', progress: p, tone: toneFor(p) })
      // Temperature row always accompanies a utilization row, so Intel/AMD
      // users see a real load % plus an explicit '—' for the missing temp.
      const tempTone = hasTemp ? toneFor(clamp01(g.temperatureGpu! / 100)) : 'ok'
      rows.push({ id: `gpuTemp:${i}`, label, value: hasTemp ? g.temperatureGpu!.toFixed(0) : '—', unit: hasTemp ? '°C' : undefined, tone: tempTone })
    } else if (hasTemp) {
      rows.push({ id: `gpu:${i}`, label, value: '—', tone: 'ok' })
      rows.push({ id: `gpuTemp:${i}`, label, value: g.temperatureGpu!.toFixed(0), unit: '°C', tone: 'ok' })
    } else {
      rows.push({ id: `gpu:${i}`, label, value: '—', tone: 'ok' })
    }
  }
  return rows
}

export function buildStatGrid(s: RawSnapshot, opts?: { rows?: string[] }): StatGridPayload {
  // Build each metric group independently, then emit in the configured order —
  // the `rows` setting controls both visibility and ordering (e.g. `gpu, cpu`).
  const order = resolveGroupOrder(opts?.rows)
  const groups: Record<StatGroupId, StatRow[]> = { cpu: [], mem: [], disk: [], gpu: [] }
  if (s.cpu) {
    // Model name first, so the group reads as an identity line then the live
    // figures. It is plain text — no unit, no progress bar.
    if (s.cpu.brand) groups.cpu.push({ id: 'cpuName', label: 'CPU', value: s.cpu.brand, tone: 'ok' })
    const p = clamp01(s.cpu.currentLoad / 100)
    groups.cpu.push({ id: 'cpu', label: 'CPU', value: s.cpu.currentLoad.toFixed(1), unit: '%', progress: p, tone: toneFor(p) })
    // Temperature row always accompanies the load row, so a machine with no
    // readable thermal zone still shows the '—' rather than looking like the
    // plugin dropped the metric.
    const hasTemp = s.cpuTemp != null
    const tempTone = hasTemp ? toneFor(clamp01(s.cpuTemp! / 100)) : 'ok'
    groups.cpu.push({ id: 'cpuTemp', label: 'CPU', value: hasTemp ? s.cpuTemp!.toFixed(0) : '—', unit: hasTemp ? '°C' : undefined, tone: tempTone })
  }
  if (s.mem && s.mem.total > 0) {
    const p = clamp01(s.mem.used / s.mem.total)
    const gb = (n: number) => (n / 1024 ** 3).toFixed(1)
    groups.mem.push({ id: 'mem', label: 'Mem', value: `${gb(s.mem.used)}/${gb(s.mem.total)}`, unit: 'GB', progress: p, tone: toneFor(p) })
  }
  for (const d of s.disks ?? []) {
    const p = clamp01(d.size > 0 ? d.used / d.size : 0)
    groups.disk.push({ id: `disk:${d.mount}`, label: diskLabel(d.mount, d.fs), value: (p * 100).toFixed(0), unit: '%', progress: p, tone: toneFor(p) })
  }
  groups.gpu = gpuRows(s.gpus ?? [])
  const values: StatRow[] = []
  for (const g of order) values.push(...groups[g])
  return { values }
}
