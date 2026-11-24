import { describe, expect, it, vi } from 'vitest'
import { DesktopUpdateOffer, type UpdateOfferDeps } from './update-offer.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

type Answer = 'download' | 'later' | 'skip'

function makeDeps(over: Partial<UpdateOfferDeps> = {}): UpdateOfferDeps {
  return {
    download: vi.fn(() => Promise.resolve()),
    showDialog: vi.fn(() => Promise.resolve('later' as Answer)),
    quitAndInstall: vi.fn(),
    isSkipped: vi.fn(() => false),
    skip: vi.fn(),
    ...over,
  }
}

describe('DesktopUpdateOffer', () => {
  it('a persisted-skipped version is never offered', async () => {
    const deps = makeDeps({ isSkipped: vi.fn((v: string) => v === '1.2.0') })
    const offer = new DesktopUpdateOffer(deps)
    await offer.offer('1.2.0')
    expect(deps.showDialog).not.toHaveBeenCalled()
  })

  it('first offer shows the available dialog', async () => {
    const deps = makeDeps()
    const offer = new DesktopUpdateOffer(deps)
    await offer.offer('1.2.0')
    expect(deps.showDialog).toHaveBeenCalledWith('available', '1.2.0')
  })

  it('concurrent same-version offers dedup to one dialog', async () => {
    const d = deferred<Answer>()
    const deps = makeDeps({ showDialog: vi.fn(() => d.promise) })
    const offer = new DesktopUpdateOffer(deps)
    const p1 = offer.offer('1.2.0')
    const p2 = offer.offer('1.2.0')
    expect(deps.showDialog).toHaveBeenCalledTimes(1)
    d.resolve('later')
    await Promise.all([p1, p2])
  })

  it('later keeps in-memory dedup and does NOT persist a skip', async () => {
    const deps = makeDeps({ showDialog: vi.fn(() => Promise.resolve('later' as Answer)) })
    const offer = new DesktopUpdateOffer(deps)
    await offer.offer('1.2.0')
    expect(deps.skip).not.toHaveBeenCalled()
    await offer.offer('1.2.0')
    expect(deps.showDialog).toHaveBeenCalledTimes(1)
  })

  it('skip persists once and silences later offers', async () => {
    const deps = makeDeps({ showDialog: vi.fn(() => Promise.resolve('skip' as Answer)) })
    const offer = new DesktopUpdateOffer(deps)
    await offer.offer('1.2.0')
    expect(deps.skip).toHaveBeenCalledWith('1.2.0')
    expect(deps.skip).toHaveBeenCalledTimes(1)
    await offer.offer('1.2.0')
    expect(deps.showDialog).toHaveBeenCalledTimes(1)
  })

  it('download success: busy during the transfer, free after', async () => {
    const d = deferred<void>()
    const deps = makeDeps({
      showDialog: vi.fn(() => Promise.resolve('download' as Answer)),
      download: vi.fn(() => d.promise),
    })
    const offer = new DesktopUpdateOffer(deps)
    const p = offer.offer('1.2.0')
    await vi.waitFor(() => expect(deps.download).toHaveBeenCalled())
    expect(offer.busy).toBe(true)
    d.resolve()
    await p
    expect(offer.busy).toBe(false)
  })

  it('download failure clears dedup so the next offer re-shows', async () => {
    const deps = makeDeps({
      showDialog: vi.fn(() => Promise.resolve('download' as Answer)),
      download: vi.fn(() => Promise.reject(new Error('disk full'))),
    })
    const offer = new DesktopUpdateOffer(deps)
    await offer.offer('1.2.0')
    expect(offer.busy).toBe(false)
    await offer.offer('1.2.0')
    expect(deps.showDialog).toHaveBeenCalledTimes(2)
  })

  it('a failed download does not re-offer a version skipped meanwhile', async () => {
    let skipped = false
    const deps = makeDeps({
      showDialog: vi.fn(() => Promise.resolve('download' as Answer)),
      download: vi.fn(() => Promise.reject(new Error('offline'))),
      isSkipped: vi.fn(() => skipped),
    })
    const offer = new DesktopUpdateOffer(deps)
    await offer.offer('1.2.0')
    skipped = true
    await offer.offer('1.2.0')
    expect(deps.showDialog).toHaveBeenCalledTimes(1)
  })

  it('busy while the available dialog is pending', async () => {
    const d = deferred<Answer>()
    const deps = makeDeps({ showDialog: vi.fn(() => d.promise) })
    const offer = new DesktopUpdateOffer(deps)
    const p = offer.offer('1.2.0')
    expect(offer.busy).toBe(true)
    d.resolve('later')
    await p
    expect(offer.busy).toBe(false)
  })

  it('downloaded accept quits and installs once; later/skip do not', async () => {
    for (const answer of ['download', 'later', 'skip'] as Answer[]) {
      const deps = makeDeps({ showDialog: vi.fn(() => Promise.resolve(answer)) })
      const offer = new DesktopUpdateOffer(deps)
      await offer.downloaded('1.2.0')
      expect(deps.showDialog).toHaveBeenCalledWith('downloaded', '1.2.0')
      if (answer === 'download') expect(deps.quitAndInstall).toHaveBeenCalledTimes(1)
      else expect(deps.quitAndInstall).not.toHaveBeenCalled()
    }
  })
})