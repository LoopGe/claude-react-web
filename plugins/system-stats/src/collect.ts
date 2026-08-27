// NB: from plugins/system-stats/src/ the shared dir is three levels up:
// src → system-stats → plugins → repo root. `../../../shared/...`
import type { StatGridPayload, StatRow } from '../../../shared/app-plugins/widget.js'

export const THRESHOLDS = { warn: 75, danger: 90 } as const

export interface RawSnapshot {
  cpu?: { currentLoad: number }
  mem?: { total: number; used: number }
  disks?: Array<{ fs: string; size: number; used: number; mount: string }>
  gpus?: Array<{ model: string; utilizationGpu?: number }>
}

/** The injected subset of the `systeminformation` API, so tests never import it. */
export interface Si {
  currentLoad(): Promise<{ currentLoad: number }>
  mem(): Promise<{ total: number; used: number }>
  fsSize(): Promise<Array<{ fs: string; size: number; used: number; mount: string }>>
  graphics(): Promise<{ controllers: Array<{ model: string; utilizationGpu?: number }> }>
}

export async function collectSnapshot(opts: { si: Si; disks: string[] }): Promise<RawSnapshot> {
  const { si, disks } = opts
  const [cpu, mem, fs, graphics] = await Promise.all([
    si.currentLoad().catch(() => undefined),
    si.mem().catch(() => undefined),
    si.fsSize().catch(() => undefined),
    si.graphics().catch(() => undefined),
  ])
  const result: RawSnapshot = {}
  if (cpu) result.cpu = cpu
  if (mem) result.mem = { total: mem.total, used: mem.used }
  if (fs) result.disks = pickDisks(fs, disks)
  if (graphics) {
    result.gpus = graphics.controllers.map((c) => ({ model: c.model, utilizationGpu: c.utilizationGpu }))
  }
  return result
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

export function buildStatGrid(s: RawSnapshot): StatGridPayload {
  const values: StatRow[] = []
  if (s.cpu) {
    const p = clamp01(s.cpu.currentLoad / 100)
    values.push({ id: 'cpu', label: 'CPU', value: s.cpu.currentLoad.toFixed(1), unit: '%', progress: p, tone: toneFor(p) })
  }
  if (s.mem && s.mem.total > 0) {
    const p = clamp01(s.mem.used / s.mem.total)
    const gb = (n: number) => (n / 1024 ** 3).toFixed(1)
    values.push({ id: 'mem', label: 'Mem', value: `${gb(s.mem.used)}/${gb(s.mem.total)}`, unit: 'GB', progress: p, tone: toneFor(p) })
  }
  for (const d of s.disks ?? []) {
    const p = clamp01(d.size > 0 ? d.used / d.size : 0)
    values.push({ id: `disk:${d.mount}`, label: 'Disk', value: (p * 100).toFixed(0), unit: '%', progress: p, tone: toneFor(p) })
  }
  for (const [i, g] of (s.gpus ?? []).entries()) {
    const label = g.model.trim().slice(0, 14) || 'GPU'
    if (g.utilizationGpu != null) {
      const p = clamp01(g.utilizationGpu / 100)
      values.push({ id: `gpu:${i}`, label, value: g.utilizationGpu.toFixed(0), unit: '%', progress: p, tone: toneFor(p) })
    } else {
      values.push({ id: `gpu:${i}`, label, value: '—', tone: 'ok' })
    }
  }
  return { values }
}
