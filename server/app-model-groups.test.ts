import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from './app.js'
import { __setConfigForTest } from './config.js'

describe('GET /api/config modelGroups', () => {
  afterEach(() => {
    __setConfigForTest({ modelGroups: [] })
  })

  it('includes modelGroups in the /config response', async () => {
    __setConfigForTest({ modelGroups: [{ id: 'g1', name: 'G1', opus: 'op' }] })
    const { app } = buildApp()
    const res = await app.request('/api/config')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { modelGroups: unknown }
    expect(body.modelGroups).toEqual([{ id: 'g1', name: 'G1', opus: 'op' }])
  })
})
