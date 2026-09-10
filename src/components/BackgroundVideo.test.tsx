import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { BackgroundVideo } from './BackgroundVideo'

const SRC = '/api/background/files/3f2a1b4c-5d6e-7f80-91a2-b3c4d5e6f708.mp4'

/** jsdom has no `prefers-reduced-motion`, and its matchMedia doesn't do change
 *  events. This stub does both so the live-toggle path is actually exercised. */
function stubReducedMotion(initial: boolean) {
  let matches = initial
  const listeners = new Set<(e: { matches: boolean }) => void>()
  vi.stubGlobal('matchMedia', (query: string) => ({
    // A real MediaQueryList reports `matches` live, not as a snapshot from the
    // call — a snapshot would make the change handler read a stale value.
    get matches() { return query.includes('prefers-reduced-motion') ? matches : false },
    media: query,
    addEventListener: (_type: string, cb: (e: { matches: boolean }) => void) => { listeners.add(cb) },
    removeEventListener: (_type: string, cb: (e: { matches: boolean }) => void) => { listeners.delete(cb) },
  }))
  return {
    set(next: boolean) {
      matches = next
      listeners.forEach((cb) => cb({ matches: next }))
    },
  }
}

describe('BackgroundVideo', () => {
  let play: ReturnType<typeof vi.spyOn>
  let pause: ReturnType<typeof vi.spyOn>
  let hidden = false

  beforeEach(() => {
    hidden = false
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
    // jsdom's own play()/pause() are not-implemented stubs that log and return
    // undefined; replace them so the component's calls are observable.
    play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
    pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const fireVisibility = (next: boolean) => {
    hidden = next
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
  }

  const mount = (reduced: boolean) => {
    stubReducedMotion(reduced)
    const { container } = render(<BackgroundVideo src={SRC} />)
    return container.querySelector('video')!
  }

  it('renders a muted, looping, inline video for the given src and starts it', () => {
    // All three are load-bearing: an unmuted or non-inline video is refused by
    // browser autoplay policy, and a non-looping wallpaper stops after one pass.
    const v = mount(false)
    expect(v.getAttribute('src')).toBe(SRC)
    expect(v.muted).toBe(true)
    expect(v.hasAttribute('loop')).toBe(true)
    expect(v.hasAttribute('playsinline')).toBe(true)
    expect(v.getAttribute('aria-hidden')).toBe('true')
    expect(play).toHaveBeenCalled()
  })

  it('pauses when the tab is hidden and resumes when it is visible again', () => {
    mount(false)
    pause.mockClear()
    play.mockClear()

    fireVisibility(true)
    expect(pause).toHaveBeenCalledTimes(1)
    expect(play).not.toHaveBeenCalled()

    fireVisibility(false)
    expect(play).toHaveBeenCalledTimes(1)
  })

  it('never starts under prefers-reduced-motion, not even on refocus', () => {
    mount(true)

    fireVisibility(true)
    fireVisibility(false)
    expect(play).not.toHaveBeenCalled()
  })

  it('pauses a playing video when the OS setting flips to reduce, and resumes when it flips back', () => {
    // Removing an autoplay attribute does not stop an element that is already
    // playing, and nothing else would ever call pause() — the wallpaper would
    // keep animating for exactly the user who asked it not to.
    const media = stubReducedMotion(false)
    render(<BackgroundVideo src={SRC} />)
    pause.mockClear()
    play.mockClear()

    act(() => { media.set(true) })
    expect(pause).toHaveBeenCalledTimes(1)

    act(() => { media.set(false) })
    expect(play).toHaveBeenCalledTimes(1)
  })

  it('does not start playing when it mounts into an already-hidden tab', () => {
    // Another tab can apply a wallpaper while this one is backgrounded, and a
    // tab that was already hidden fires no visibilitychange to react to.
    hidden = true
    render(<BackgroundVideo src={SRC} />)

    expect(play).not.toHaveBeenCalled()
    expect(pause).toHaveBeenCalled()
  })

  it('says so in the console when the video cannot load', () => {
    // Nothing else can report it: useBackground has already cleared the image
    // slot, so a broken video is a translucent chrome over an empty backdrop.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const v = mount(false)

    act(() => { v.dispatchEvent(new Event('error')) })

    expect(warn).toHaveBeenCalledWith(expect.stringContaining(SRC))
  })

  it('nudges currentTime so a reduced-motion still frame actually paints', () => {
    // A video that never played can stay fully transparent; seeking forces the
    // decoder to produce the first frame, which is the whole point of showing
    // a still wallpaper instead of a moving one.
    const v = mount(true)
    Object.defineProperty(v, 'readyState', { configurable: true, value: 1 })
    act(() => { v.dispatchEvent(new Event('loadedmetadata')) })
    expect(v.currentTime).toBeGreaterThan(0)
  })
})
