import { afterEach, describe, expect, it } from 'vitest'
import { getHostCapabilities, isDesktopHost } from './host-capabilities'

describe('host capabilities', () => {
  afterEach(() => {
    delete (window as { __CRW_DESKTOP__?: unknown }).__CRW_DESKTOP__
  })

  it('reports web defaults when no desktop bridge is present', () => {
    delete (window as { __CRW_DESKTOP__?: unknown }).__CRW_DESKTOP__
    expect(isDesktopHost()).toBe(false)
    const caps = getHostCapabilities()
    expect(caps.lanSharing).toBe(true)
    expect(caps.serviceWorker).toBe(true)
    expect(caps.npxSelfUpdate).toBe(true)
    expect(caps.nativeNotifications).toBe(false)
    expect(caps.nativeMenu).toBe(false)
  })

  it('flips to desktop capabilities when the preload bridge is injected', () => {
    ;(window as { __CRW_DESKTOP__?: unknown }).__CRW_DESKTOP__ = { connect: () => {} }
    expect(isDesktopHost()).toBe(true)
    const caps = getHostCapabilities()
    // No reachable HTTP origin to share, no SW under crw://, no npx updater.
    expect(caps.lanSharing).toBe(false)
    expect(caps.serviceWorker).toBe(false)
    expect(caps.npxSelfUpdate).toBe(false)
    expect(caps.nativeNotifications).toBe(true)
    expect(caps.nativeMenu).toBe(true)
  })
})
