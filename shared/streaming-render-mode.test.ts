import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STREAMING_RENDER_MODE,
  STREAMING_RENDER_MODES,
  isStreamingRenderMode,
} from './streaming-render-mode.js'

describe('streaming-render-mode', () => {
  it('ships with the floating bubble as the default', () => {
    // The app's long-standing rendering — flipping this is a product
    // decision that must break this line on purpose.
    expect(DEFAULT_STREAMING_RENDER_MODE).toBe('overlay')
    expect(STREAMING_RENDER_MODES).toEqual(['overlay', 'inline'])
  })

  it('isStreamingRenderMode guards the union', () => {
    expect(isStreamingRenderMode('overlay')).toBe(true)
    expect(isStreamingRenderMode('inline')).toBe(true)

    // Not-yet-existing modes and junk from config.json / a PUT body.
    expect(isStreamingRenderMode('off')).toBe(false)
    expect(isStreamingRenderMode('Overlay')).toBe(false)
    expect(isStreamingRenderMode(8)).toBe(false)
    expect(isStreamingRenderMode(undefined)).toBe(false)
  })
})
