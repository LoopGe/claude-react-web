import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from './app.js'
import { __setConfigForTest } from './config.js'

describe('GET /api/config streamingRenderMode', () => {
  afterEach(() => {
    __setConfigForTest({ streamingRenderMode: 'overlay' })
  })

  it('includes streamingRenderMode in the /config response', async () => {
    // App reads this field into globalPrefs — a dropped mapping line here
    // would silently pin every panel to the default rendering.
    __setConfigForTest({ streamingRenderMode: 'inline' })
    const { app } = buildApp()
    const res = await app.request('/api/config')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { streamingRenderMode?: string }
    expect(body.streamingRenderMode).toBe('inline')
  })
})
