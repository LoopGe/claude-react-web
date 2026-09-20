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
    expect(caps.customTitlebar).toBe(false)
    expect(caps.desktopPlatform).toBeNull()
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
    // No platform on the fake bridge → no native menu, no custom titlebar.
    expect(caps.nativeMenu).toBe(false)
    expect(caps.customTitlebar).toBe(false)
    expect(caps.desktopPlatform).toBeNull()
  })

  it('enables the custom titlebar and hides the native menu on win32', () => {
    ;(window as { __CRW_DESKTOP__?: unknown }).__CRW_DESKTOP__ = {
      connect: () => {},
      platform: 'win32',
    }
    const caps = getHostCapabilities()
    expect(caps.desktopPlatform).toBe('win32')
    expect(caps.customTitlebar).toBe(true)
    expect(caps.nativeMenu).toBe(false)
  })

  it('keeps the native menu on darwin while still using a custom titlebar', () => {
    ;(window as { __CRW_DESKTOP__?: unknown }).__CRW_DESKTOP__ = {
      connect: () => {},
      platform: 'darwin',
    }
    const caps = getHostCapabilities()
    expect(caps.desktopPlatform).toBe('darwin')
    expect(caps.customTitlebar).toBe(true)
    expect(caps.nativeMenu).toBe(true)
  })

  it('leaves linux on the native frame and keeps the native menu', () => {
    ;(window as { __CRW_DESKTOP__?: unknown }).__CRW_DESKTOP__ = {
      connect: () => {},
      platform: 'linux',
    }
    const caps = getHostCapabilities()
    expect(caps.customTitlebar).toBe(false)
    expect(caps.nativeMenu).toBe(true)
  })
})
