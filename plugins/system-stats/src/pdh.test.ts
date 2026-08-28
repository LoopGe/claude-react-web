import { describe, expect, it, vi } from 'vitest'
import { createPdhGpuUtilProbe, parseUtilizationJson, queryViaPowershell } from './pdh.js'

describe('parseUtilizationJson', () => {
  it('parses the array shape the probe emits', () => {
    const raw = '[{"luid":"0x00000000_0x0000EEE2","utilization":4},{"luid":"0x00000000_0x0000F38F","utilization":0}]'
    expect(parseUtilizationJson(raw)).toEqual([{ utilizationGpu: 4 }, { utilizationGpu: 0 }])
  })

  it('handles a single-object (non-array) JSON payload', () => {
    expect(parseUtilizationJson('{"luid":"x","utilization":12.5}')).toEqual([{ utilizationGpu: 12.5 }])
  })

  it('clamps values into 0–100', () => {
    expect(parseUtilizationJson('[{"luid":"a","utilization":140},{"luid":"b","utilization":-3}]')).toEqual([
      { utilizationGpu: 100 },
      { utilizationGpu: 0 },
    ])
  })

  it('omits entries whose utilization is not a finite number', () => {
    expect(parseUtilizationJson('[{"luid":"a","utilization":null},{"luid":"b"}]')).toEqual([
      { utilizationGpu: undefined },
      { utilizationGpu: undefined },
    ])
  })

  it('degrades to [] on empty or invalid input', () => {
    expect(parseUtilizationJson('')).toEqual([])
    expect(parseUtilizationJson('not json')).toEqual([])
  })
})

describe('createPdhGpuUtilProbe', () => {
  it('queries via the injected runner and returns parsed utilization', async () => {
    const query = vi.fn(async () => '[{"luid":"a","utilization":9.7}]')
    const probe = createPdhGpuUtilProbe(query)
    expect(await probe.probe()).toEqual([{ utilizationGpu: 9.7 }])
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('degrades to [] when the query runner rejects', async () => {
    const query = vi.fn(async () => {
      throw new Error('powershell missing')
    })
    const probe = createPdhGpuUtilProbe(query)
    expect(await probe.probe()).toEqual([])
  })

  it('re-throws an AbortError so a timeout is not mistaken for "no GPU data"', async () => {
    const ac = new AbortController()
    ac.abort()
    const query = vi.fn(async (_script, signal) => {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
      return '[]'
    })
    const probe = createPdhGpuUtilProbe(query)
    await expect(probe.probe(ac.signal)).rejects.toThrow(DOMException)
  })
})

describe('queryViaPowershell', () => {
  it('rejects immediately when the signal is already aborted (no child spawned)', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(queryViaPowershell('Get-Process', ac.signal)).rejects.toThrow(DOMException)
  })
})
