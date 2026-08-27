import { describe, expect, it } from 'vitest'
import { buildStatGrid, collectSnapshot, pickDisks } from './collect.js'
import type { RawSnapshot } from './collect.js'

describe('buildStatGrid', () => {
  it('maps cpu/mem/disk/gpu to rows with tone thresholds', () => {
    const s: RawSnapshot = {
      cpu: { currentLoad: 23.4 },
      mem: { total: 32 * 1024 ** 3, used: 12.8 * 1024 ** 3 },
      disks: [{ fs: '/dev/sda1', size: 500 * 1024 ** 3, used: 400 * 1024 ** 3, mount: '/' }],
      gpus: [{ model: 'RTX 4090', utilizationGpu: 65 }],
    }
    const grid = buildStatGrid(s)
    expect(grid.values.map((v) => v.id)).toEqual(['cpu', 'mem', 'disk:/', 'gpu:0'])
    expect(grid.values[0]).toMatchObject({ label: 'CPU', value: '23.4', unit: '%', tone: 'ok' })
    expect(grid.values[0].progress).toBeCloseTo(0.234, 3)
    expect(grid.values[1]).toMatchObject({ unit: 'GB' })
    expect(grid.values[2]).toMatchObject({ progress: 0.8, tone: 'warn' })
    expect(grid.values[3]).toMatchObject({ value: '65', unit: '%' })
  })

  it('emits a dash row when a GPU has no utilization', () => {
    const s: RawSnapshot = { gpus: [{ model: 'Apple M1' }] }
    const grid = buildStatGrid(s)
    expect(grid.values[0]).toMatchObject({ value: '—' })
  })

  it('falls back to a "GPU" label when a controller has no model name', () => {
    const s: RawSnapshot = { gpus: [{ utilizationGpu: 50 }] }
    const grid = buildStatGrid(s)
    expect(grid.values[0]).toMatchObject({ label: 'GPU', value: '50', unit: '%' })
  })

  it('omits missing metrics entirely', () => {
    const grid = buildStatGrid({})
    expect(grid.values).toEqual([])
  })

  it('marks high usage as danger', () => {
    const s: RawSnapshot = { cpu: { currentLoad: 95 } }
    expect(buildStatGrid(s).values[0].tone).toBe('danger')
  })
})

describe('collectSnapshot', () => {
  const si = {
    currentLoad: async () => ({ currentLoad: 10 }),
    mem: async () => ({ total: 1000, used: 400 }),
    fsSize: async () => [{ fs: '/dev/x', size: 100, used: 50, mount: '/' }],
    graphics: async () => ({ controllers: [{ model: 'G', utilizationGpu: 20 }] }),
  }

  it('collects all metrics', async () => {
    const snap = await collectSnapshot({ si, disks: [] })
    expect(snap.cpu?.currentLoad).toBe(10)
    expect(snap.mem?.total).toBe(1000)
    expect(snap.disks?.length).toBe(1)
    expect(snap.gpus?.length).toBe(1)
  })

  it('degrades when a subsystem fails', async () => {
    const bad = {
      ...si,
      graphics: async () => {
        throw new Error('no gpu')
      },
    }
    const snap = await collectSnapshot({ si: bad, disks: [] })
    expect(snap.cpu).toBeDefined()
    expect(snap.gpus).toBeUndefined()
  })
})

describe('pickDisks', () => {
  const disks = [
    { fs: '/dev/sda1', size: 500, used: 100, mount: '/' },
    { fs: '/dev/sdb1', size: 1000, used: 200, mount: '/data' },
    { fs: 'tmpfs', size: 100, used: 10, mount: '/tmp' },
  ]

  it('filters by wanted mount points when provided', () => {
    const result = pickDisks(disks, ['/data'])
    expect(result).toHaveLength(1)
    expect(result![0].mount).toBe('/data')
  })

  it('returns multiple matches when several mounts are wanted', () => {
    const result = pickDisks(disks, ['/', '/tmp'])
    expect(result).toHaveLength(2)
    expect(result!.map((d) => d.mount).sort()).toEqual(['/', '/tmp'])
  })

  it('returns empty array when no wanted mount matches', () => {
    const result = pickDisks(disks, ['/nonexistent'])
    expect(result).toEqual([])
  })
})
