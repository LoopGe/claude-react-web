import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROBE_MAX_MS, buildStatGrid, collectSnapshot, pickDisks } from './collect.js'
import type { RawSnapshot } from './collect.js'

describe('buildStatGrid', () => {
  it('maps cpu/mem/disk/gpu to rows with tone thresholds', () => {
    const s: RawSnapshot = {
      cpu: { currentLoad: 23.4 },
      cpuTemp: 51,
      mem: { total: 32 * 1024 ** 3, used: 12.8 * 1024 ** 3 },
      disks: [{ fs: '/dev/sda1', size: 500 * 1024 ** 3, used: 400 * 1024 ** 3, mount: '/' }],
      gpus: [{ model: 'RTX 4090', utilizationGpu: 65 }],
    }
    const grid = buildStatGrid(s)
    expect(grid.values.map((v) => v.id)).toEqual(['cpu', 'cpuTemp', 'mem', 'disk:/', 'gpu:0', 'gpuTemp:0'])
    expect(grid.values[0]).toMatchObject({ label: 'CPU', value: '23.4', unit: '%', tone: 'ok' })
    expect(grid.values[0].progress).toBeCloseTo(0.234, 3)
    // A load row always carries a temperature row — '—' when unknown.
    expect(grid.values[1]).toMatchObject({ id: 'cpuTemp', label: 'CPU', value: '51', unit: '°C', tone: 'ok' })
    expect(grid.values[2]).toMatchObject({ unit: 'GB' })
    expect(grid.values[3]).toMatchObject({ label: '/', progress: 0.8, tone: 'warn' })
    expect(grid.values[4]).toMatchObject({ value: '65', unit: '%' })
    expect(grid.values[5]).toMatchObject({ id: 'gpuTemp:0', value: '—' })
  })

  it('labels each disk row with its mount point so drives are distinguishable', () => {
    const s: RawSnapshot = {
      disks: [
        { fs: 'C:', size: 500 * 1024 ** 3, used: 100 * 1024 ** 3, mount: 'C:\\' },
        { fs: '/dev/sdb1', size: 1000 * 1024 ** 3, used: 200 * 1024 ** 3, mount: '/home' },
      ],
    }
    const grid = buildStatGrid(s)
    expect(grid.values.map((v) => v.id)).toEqual(['disk:C:\\', 'disk:/home'])
    expect(grid.values[0]).toMatchObject({ label: 'C:' })
    expect(grid.values[1]).toMatchObject({ label: '/home' })
  })

  it('falls back to the device name when a disk has no mount', () => {
    const s: RawSnapshot = { disks: [{ fs: '/dev/sda1', size: 100, used: 50, mount: '' }] }
    expect(buildStatGrid(s).values[0]).toMatchObject({ label: '/dev/sda1' })
  })

  it('honors rows config: filters groups and preserves configured order', () => {
    const s: RawSnapshot = {
      cpu: { currentLoad: 10 },
      mem: { total: 1000, used: 400 },
      disks: [{ fs: '/dev/sda1', size: 100, used: 50, mount: '/' }],
      gpus: [{ model: 'RTX 4090', utilizationGpu: 40 }],
    }
    const grid = buildStatGrid(s, { rows: ['gpu', 'cpu'] })
    expect(grid.values.map((v) => v.id)).toEqual(['gpu:0', 'gpuTemp:0', 'cpu', 'cpuTemp'])
  })

  it('rows config omits unlisted groups entirely', () => {
    const s: RawSnapshot = {
      cpu: { currentLoad: 10 },
      mem: { total: 1000, used: 400 },
      gpus: [{ model: 'G', utilizationGpu: 1 }],
    }
    const grid = buildStatGrid(s, { rows: ['cpu', 'mem'] })
    expect(grid.values.map((v) => v.id)).toEqual(['cpu', 'cpuTemp', 'mem'])
  })

  it('empty or all-unknown rows falls back to the default groups', () => {
    const s: RawSnapshot = { cpu: { currentLoad: 10 }, mem: { total: 1000, used: 400 } }
    expect(buildStatGrid(s, { rows: [] }).values.map((v) => v.id)).toEqual(['cpu', 'cpuTemp', 'mem'])
    expect(buildStatGrid(s, { rows: ['foo'] }).values.map((v) => v.id)).toEqual(['cpu', 'cpuTemp', 'mem'])
    expect(buildStatGrid(s).values.map((v) => v.id)).toEqual(['cpu', 'cpuTemp', 'mem'])
  })

  it('renders the CPU model name as the first row of the cpu group when present', () => {
    const s: RawSnapshot = { cpu: { currentLoad: 10, brand: 'Core™ Ultra 5 125H' } }
    const grid = buildStatGrid(s)
    expect(grid.values.map((v) => v.id)).toEqual(['cpuName', 'cpu', 'cpuTemp'])
    // Plain text identity line: no unit, no progress bar.
    expect(grid.values[0]).toMatchObject({ id: 'cpuName', label: 'CPU', value: 'Core™ Ultra 5 125H', tone: 'ok' })
    expect(grid.values[0].unit).toBeUndefined()
    expect(grid.values[0].progress).toBeUndefined()
  })

  it('omits the CPU name row when no brand is available', () => {
    const s: RawSnapshot = { cpu: { currentLoad: 10 } }
    const grid = buildStatGrid(s)
    expect(grid.values.map((v) => v.id)).toEqual(['cpu', 'cpuTemp'])
  })

  it('emits a dash CPU temperature row when no temperature is available', () => {
    const s: RawSnapshot = { cpu: { currentLoad: 10 } }
    const grid = buildStatGrid(s)
    expect(grid.values.map((v) => v.id)).toEqual(['cpu', 'cpuTemp'])
    expect(grid.values[1]).toMatchObject({ id: 'cpuTemp', value: '—', unit: undefined, tone: 'ok' })
  })

  it('tones the CPU temperature row by its value (warn at 75+, danger at 90+)', () => {
    const warm: RawSnapshot = { cpu: { currentLoad: 10 }, cpuTemp: 82 }
    expect(buildStatGrid(warm).values[1]).toMatchObject({ id: 'cpuTemp', value: '82', tone: 'warn' })
    const hot: RawSnapshot = { cpu: { currentLoad: 10 }, cpuTemp: 96 }
    expect(buildStatGrid(hot).values[1]).toMatchObject({ id: 'cpuTemp', value: '96', tone: 'danger' })
  })

  it('renders a real temperature row when the GPU reports one', () => {
    const s: RawSnapshot = { gpus: [{ model: 'RTX 4090', utilizationGpu: 40, temperatureGpu: 71.3 }] }
    const grid = buildStatGrid(s)
    expect(grid.values.map((v) => v.id)).toEqual(['gpu:0', 'gpuTemp:0'])
    expect(grid.values[1]).toMatchObject({ id: 'gpuTemp:0', value: '71', unit: '°C', tone: 'ok' })
  })

  it('tones a real temperature row by its value (warn at 75+, danger at 90+)', () => {
    const s: RawSnapshot = { gpus: [{ model: 'RTX 4090', utilizationGpu: 40, temperatureGpu: 82 }] }
    const grid = buildStatGrid(s)
    expect(grid.values[1]).toMatchObject({ id: 'gpuTemp:0', value: '82', tone: 'warn' })
    const hot: RawSnapshot = { gpus: [{ model: 'RTX 4090', utilizationGpu: 40, temperatureGpu: 96 }] }
    expect(buildStatGrid(hot).values[1]).toMatchObject({ id: 'gpuTemp:0', value: '96', tone: 'danger' })
  })

  it('emits a dash row when a GPU has no utilization', () => {
    const s: RawSnapshot = { gpus: [{ model: 'Apple M1' }] }
    const grid = buildStatGrid(s)
    expect(grid.values[0]).toMatchObject({ value: '—' })
    expect(grid.values.map((v) => v.id)).toEqual(['gpu:0'])
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
  afterEach(() => {
    vi.useRealTimers()
  })

  const si = {
    currentLoad: async () => ({ currentLoad: 10 }),
    mem: async () => ({ total: 1000, used: 400 }),
    fsSize: async () => [{ fs: '/dev/x', size: 100, used: 50, mount: '/' }],
    graphics: async () => ({ controllers: [{ model: 'G', utilizationGpu: 20 }] }),
    cpuTemperature: async () => ({ main: 45 }),
  }

  it('collects all metrics', async () => {
    const snap = await collectSnapshot({ si, disks: [] })
    expect(snap.cpu?.currentLoad).toBe(10)
    expect(snap.mem?.total).toBe(1000)
    expect(snap.disks?.length).toBe(1)
    expect(snap.gpus?.length).toBe(1)
    expect(snap.cpuTemp).toBe(45)
  })

  it('reads CPU temperature from si.cpuTemperature() by default', async () => {
    const snap = await collectSnapshot({ si, disks: [] })
    expect(snap.cpuTemp).toBe(45)
  })

  it('degrades to no CPU temperature when si.cpuTemperature() returns null or rejects', async () => {
    const nullTemp = { ...si, cpuTemperature: async () => ({ main: null }) }
    expect((await collectSnapshot({ si: nullTemp, disks: [] })).cpuTemp).toBeUndefined()

    const throwing = { ...si, cpuTemperature: async () => { throw new Error('wmi denied') } }
    expect((await collectSnapshot({ si: throwing, disks: [] })).cpuTemp).toBeUndefined()
  })

  it('ignores a non-finite CPU temperature from si.cpuTemperature()', async () => {
    const nanTemp = { ...si, cpuTemperature: async () => ({ main: NaN }) }
    expect((await collectSnapshot({ si: nanTemp, disks: [] })).cpuTemp).toBeUndefined()

    const infTemp = { ...si, cpuTemperature: async () => ({ main: Infinity }) }
    expect((await collectSnapshot({ si: infTemp, disks: [] })).cpuTemp).toBeUndefined()
  })

  it('uses the provided cpuTemp probe and skips si.cpuTemperature()', async () => {
    const cpuTemperature = vi.fn(async () => ({ main: 999 }))
    const siWithSpy = { ...si, cpuTemperature }
    const cpuTemp = vi.fn(async () => 27.9)
    const snap = await collectSnapshot({ si: siWithSpy, disks: [], cpuTempProbe: cpuTemp })
    expect(snap.cpuTemp).toBe(27.9)
    expect(cpuTemp).toHaveBeenCalledTimes(1)
    // The probe path must not also pay for the admin-requiring WMI probe.
    expect(cpuTemperature).not.toHaveBeenCalled()
  })

  it('omits cpuTemp when the probe resolves no temperature', async () => {
    const snap = await collectSnapshot({ si, disks: [], cpuTempProbe: async () => undefined })
    expect(snap.cpuTemp).toBeUndefined()
  })

  it('carries the resolved CPU brand into the snapshot', async () => {
    const snap = await collectSnapshot({ si, disks: [], cpuBrandProbe: async () => 'Core™ Ultra 5 125H' })
    expect(snap.cpu?.brand).toBe('Core™ Ultra 5 125H')
    expect(snap.cpu?.currentLoad).toBe(10)
  })

  it('leaves the CPU brand absent when the probe resolves no name', async () => {
    const snap = await collectSnapshot({ si, disks: [], cpuBrandProbe: async () => undefined })
    expect(snap.cpu?.brand).toBeUndefined()
  })

  it('does not stall the sample when the CPU temp probe never resolves', async () => {
    vi.useFakeTimers()
    const cpuTemp = () => new Promise<undefined>(() => {}) // hung probe
    const snapP = collectSnapshot({ si, disks: [], cpuTempProbe: cpuTemp })
    await vi.advanceTimersByTimeAsync(PROBE_MAX_MS)
    const snap = await snapP
    expect(snap.cpuTemp).toBeUndefined()
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

  it('fills missing utilization from the PDH probe, taking the busiest LUID for a single controller', async () => {
    const noUtil = {
      ...si,
      graphics: async () => ({ controllers: [{ model: 'Intel Arc' }] }),
    }
    const gpuUtil = async () => [{ utilizationGpu: 0 }, { utilizationGpu: 0 }, { utilizationGpu: 37 }]
    const snap = await collectSnapshot({ si: noUtil, disks: [], gpuUtil })
    expect(snap.gpus).toEqual([{ model: 'Intel Arc', utilizationGpu: 37, temperatureGpu: undefined }])
  })

  it('leaves utilization blank when multiple controllers are missing it (no misattribution)', async () => {
    const noUtil = {
      ...si,
      graphics: async () => ({ controllers: [{ model: 'A' }, { model: 'B' }] }),
    }
    const gpuUtil = async () => [{ utilizationGpu: 10 }, { utilizationGpu: 20 }]
    const snap = await collectSnapshot({ si: noUtil, disks: [], gpuUtil })
    expect(snap.gpus).toEqual([
      { model: 'A', utilizationGpu: undefined, temperatureGpu: undefined },
      { model: 'B', utilizationGpu: undefined, temperatureGpu: undefined },
    ])
  })

  it('skips the PDH probe when several controllers lack utilization (nothing to merge)', async () => {
    const noUtil = {
      ...si,
      graphics: async () => ({ controllers: [{ model: 'A' }, { model: 'B' }] }),
    }
    const gpuUtil = vi.fn(async () => [{ utilizationGpu: 10 }])
    const snap = await collectSnapshot({ si: noUtil, disks: [], gpuUtil })
    expect(gpuUtil).not.toHaveBeenCalled()
    expect(snap.gpus).toEqual([
      { model: 'A', utilizationGpu: undefined, temperatureGpu: undefined },
      { model: 'B', utilizationGpu: undefined, temperatureGpu: undefined },
    ])
  })

  it('fills the single missing controller from the busiest LUID when others already report utilization', async () => {
    const mixed = {
      ...si,
      graphics: async () => ({ controllers: [{ model: 'RTX', utilizationGpu: 55, temperatureGpu: 60 }, { model: 'Intel Arc' }] }),
    }
    const gpuUtil = async () => [{ utilizationGpu: 0 }, { utilizationGpu: 0 }, { utilizationGpu: 37 }]
    const snap = await collectSnapshot({ si: mixed, disks: [], gpuUtil })
    expect(snap.gpus).toEqual([
      { model: 'RTX', utilizationGpu: 55, temperatureGpu: 60 },
      { model: 'Intel Arc', utilizationGpu: 37, temperatureGpu: undefined },
    ])
  })

  it('clamps the PDH fallback to 0–100', async () => {
    const noUtil = {
      ...si,
      graphics: async () => ({ controllers: [{ model: 'Intel Arc' }] }),
    }
    const gpuUtil = async () => [{ utilizationGpu: 140 }, { utilizationGpu: -5 }]
    const snap = await collectSnapshot({ si: noUtil, disks: [], gpuUtil })
    expect(snap.gpus![0].utilizationGpu).toBe(100)
  })

  it('does not run the PDH probe when systeminformation already reports utilization', async () => {
    const withUtil = {
      ...si,
      graphics: async () => ({ controllers: [{ model: 'RTX', utilizationGpu: 42, temperatureGpu: 60 }] }),
    }
    const gpuUtil = vi.fn(async () => [{ utilizationGpu: 99 }])
    const snap = await collectSnapshot({ si: withUtil, disks: [], gpuUtil })
    expect(snap.gpus).toEqual([{ model: 'RTX', utilizationGpu: 42, temperatureGpu: 60 }])
    expect(gpuUtil).not.toHaveBeenCalled()
  })

  it('degrades when the PDH probe fails', async () => {
    const noUtil = {
      ...si,
      graphics: async () => ({ controllers: [{ model: 'Intel Arc' }] }),
    }
    const gpuUtil = async () => {
      throw new Error('probe failed')
    }
    const snap = await collectSnapshot({ si: noUtil, disks: [], gpuUtil })
    expect(snap.gpus).toEqual([{ model: 'Intel Arc', utilizationGpu: undefined, temperatureGpu: undefined }])
  })

  it('does not stall the sample when the PDH probe never resolves', async () => {
    vi.useFakeTimers()
    const noUtil = {
      ...si,
      graphics: async () => ({ controllers: [{ model: 'Intel Arc' }] }),
    }
    const gpuUtil = () => new Promise<never>(() => {}) // hung probe
    const snapP = collectSnapshot({ si: noUtil, disks: [], gpuUtil })
    await vi.advanceTimersByTimeAsync(PROBE_MAX_MS)
    const snap = await snapP
    expect(snap.gpus).toEqual([{ model: 'Intel Arc', utilizationGpu: undefined, temperatureGpu: undefined }])
  })

  it('aborts the PDH probe signal when it exceeds the budget (kills the child)', async () => {
    vi.useFakeTimers()
    const noUtil = {
      ...si,
      graphics: async () => ({ controllers: [{ model: 'Intel Arc' }] }),
    }
    let seenSignal: AbortSignal | undefined
    const gpuUtil = (signal?: AbortSignal) =>
      new Promise<never>(() => {
        seenSignal = signal
      }) // hung probe that records its signal
    const snapP = collectSnapshot({ si: noUtil, disks: [], gpuUtil })
    await vi.advanceTimersByTimeAsync(PROBE_MAX_MS)
    await snapP
    expect(seenSignal?.aborted).toBe(true)
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
