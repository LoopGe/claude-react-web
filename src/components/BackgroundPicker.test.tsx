import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { BackgroundPicker } from './BackgroundPicker'
import { useBackground } from '../hooks/useBackground'
import {
  BACKGROUND_KEY,
  BACKGROUND_DEFAULT_OPACITY,
  BACKGROUND_DEFAULT_BLUR,
  BACKGROUND_DEFAULT_SURFACE,
  BACKGROUND_SRC_MAX,
  type BackgroundSetting,
} from '../theme'
import { setMaxUploadBytes } from '../hooks/config-store'

const MP4_UPLOAD = '/api/background/files/7c9e6679-7425-40de-944b-e07fc1f90ae7.mp4'
const PNG_UPLOAD = '/api/background/files/7c9e6679-7425-40de-944b-e07fc1f90ae7.png'

function setting(pref: BackgroundSetting['pref'], opacity = 0.85): BackgroundSetting {
  return { pref, opacity }
}

/** The seam the `vi.fn()` onChange tests above cannot see: the picker wired to
 *  its real owner (as App.tsx does) against real localStorage, so a write that
 *  the owner rejects is actually observable as the UI snapping back. */
function WithRealBackgroundOwner() {
  const { setting, setSetting } = useBackground('default')
  return <BackgroundPicker setting={setting} onChange={setSetting} />
}

describe('BackgroundPicker', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    setMaxUploadBytes(25 * 1024 * 1024) // config-store is module-global
  })

  it('renders None/Image/Video and defaults to None active', () => {
    render(<BackgroundPicker setting={setting({ kind: 'none' })} onChange={() => {}} />)
    expect(screen.getByRole('radio', { name: 'None' })).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'Image' })).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'Video' })).toBeTruthy()
  })

  it('applies a valid http(s) image URL on submit', () => {
    const onChange = vi.fn()
    render(<BackgroundPicker setting={setting({ kind: 'none' })} onChange={onChange} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Image' }))
    fireEvent.change(screen.getByLabelText('Image URL'), { target: { value: 'https://ex.com/bg.png' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use URL' }))
    expect(onChange).toHaveBeenCalledWith({
      pref: { kind: 'custom', src: 'https://ex.com/bg.png', media: 'image' },
      opacity: 0.85,
      lastSrc: 'https://ex.com/bg.png',
      lastMedia: 'image',
    })
  })

  it('applies a valid http(s) video URL on submit', () => {
    const onChange = vi.fn()
    render(<BackgroundPicker setting={setting({ kind: 'none' })} onChange={onChange} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Video' }))
    fireEvent.change(screen.getByLabelText('Video URL'), { target: { value: 'https://ex.com/loop.mp4' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use URL' }))
    expect(onChange).toHaveBeenCalledWith({
      pref: { kind: 'custom', src: 'https://ex.com/loop.mp4', media: 'video' },
      opacity: 0.85,
      lastSrc: 'https://ex.com/loop.mp4',
      lastMedia: 'video',
    })
  })

  it('rejects a non-http(s) URL', () => {
    const onChange = vi.fn()
    render(<BackgroundPicker setting={setting({ kind: 'none' })} onChange={onChange} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Image' }))
    onChange.mockClear()
    fireEvent.change(screen.getByLabelText('Image URL'), { target: { value: 'file:///etc/passwd' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use URL' }))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('offers a video-only file picker in video mode', () => {
    render(<BackgroundPicker setting={setting({ kind: 'none' })} onChange={() => {}} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Video' }))
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    expect(input.accept).toBe('video/mp4,video/webm')
    expect(screen.getByText('Upload video…')).toBeTruthy()
  })

  it('uploads a file and applies the returned URL, deleting the old file', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ url: PNG_UPLOAD }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) }) // DELETE old
    vi.stubGlobal('fetch', fetchMock)
    const onChange = vi.fn()
    render(<BackgroundPicker setting={setting({ kind: 'custom', src: '/api/background/files/11111111-2222-4333-8444-555555555555.png', media: 'image' }, 0.7)} onChange={onChange} />)
    fireEvent.click(screen.getByText('Upload image…'))
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    fireEvent.change(input, { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } })
    await screen.findByText('Applied')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(onChange).toHaveBeenCalledWith({
      pref: { kind: 'custom', src: PNG_UPLOAD, media: 'image' },
      opacity: 0.7,
      lastSrc: PNG_UPLOAD,
      lastMedia: 'image',
    })
  })

  it('uploads a video and applies it as a video pref', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ url: MP4_UPLOAD }) })
    vi.stubGlobal('fetch', fetchMock)
    const onChange = vi.fn()
    render(<BackgroundPicker setting={setting({ kind: 'none' })} onChange={onChange} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Video' }))
    fireEvent.click(screen.getByText('Upload video…'))
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    fireEvent.change(input, { target: { files: [new File(['x'], 'a.mp4', { type: 'video/mp4' })] } })
    await screen.findByText('Applied')
    expect(onChange).toHaveBeenCalledWith({
      pref: { kind: 'custom', src: MP4_UPLOAD, media: 'video' },
      opacity: 0.85,
      lastSrc: MP4_UPLOAD,
      lastMedia: 'video',
    })
  })

  it('shows why an upload was refused instead of failing silently', async () => {
    // A 25 MB cap that only console.warns is invisible: the click looks like it
    // worked and nothing changes. Video makes hitting the cap routine.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 413, json: async () => ({ error: 'file exceeds 26214400 bytes' }),
    }))
    render(<BackgroundPicker setting={setting({ kind: 'none' })} onChange={() => {}} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Video' }))
    fireEvent.click(screen.getByText('Upload video…'))
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    fireEvent.change(input, { target: { files: [new File(['x'], 'a.mp4', { type: 'video/mp4' })] } })

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/exceeds 26214400 bytes/)
  })

  it('replaces a video wallpaper with an image, deleting the video file', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ url: PNG_UPLOAD }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) }) // DELETE the video
    vi.stubGlobal('fetch', fetchMock)
    const onChange = vi.fn()
    render(<BackgroundPicker setting={setting({ kind: 'custom', src: MP4_UPLOAD, media: 'video' })} onChange={onChange} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Image' }))
    fireEvent.click(screen.getByText('Upload image…'))
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    fireEvent.change(input, { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } })
    await screen.findByText('Applied')

    expect(fetchMock).toHaveBeenCalledWith(MP4_UPLOAD, { method: 'DELETE' })
    expect(onChange).toHaveBeenCalledWith({
      pref: { kind: 'custom', src: PNG_UPLOAD, media: 'image' },
      opacity: 0.85,
      lastSrc: PNG_UPLOAD,
      lastMedia: 'image',
    })
  })

  it('refuses an over-size file before sending any request', async () => {
    setMaxUploadBytes(10) // 10 bytes
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<BackgroundPicker setting={setting({ kind: 'none' })} onChange={() => {}} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Video' }))
    fireEvent.click(screen.getByText('Upload video…'))
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    fireEvent.change(input, { target: { files: [new File([new Uint8Array(50)], 'big.mp4', { type: 'video/mp4' })] } })

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/too large/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('BackgroundPicker against its real owner', () => {
  // Real hook + real localStorage, no mocks: the `vi.fn()` onChange tests above
  // cannot see a write the owner rejects, because nothing feeds it back.
  beforeEach(() => {
    window.localStorage.clear()
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  const stored = () => JSON.parse(window.localStorage.getItem(BACKGROUND_KEY) ?? 'null') as unknown
  const clickUseUrl = () => { fireEvent.click(screen.getByRole('button', { name: 'Use URL' })) }
  const seedImage = (src = 'https://example.com/a.png', opacity = 0.8) => window.localStorage.setItem(
    BACKGROUND_KEY,
    JSON.stringify({ pref: { kind: 'custom', src, media: 'image' }, opacity }),
  )

  it('keeps showing the live image across an image → video → image round trip', () => {
    // The early return for "the clicked media is already live" used to skip the
    // draft sync, leaving the field blank while that image was still applied —
    // and with nothing to re-sync from, the applied URL became unreachable.
    seedImage()
    render(<WithRealBackgroundOwner />)
    expect((screen.getByLabelText('Image URL') as HTMLInputElement).value).toBe('https://example.com/a.png')

    fireEvent.click(screen.getByRole('radio', { name: 'Video' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Image' }))

    expect((screen.getByLabelText('Image URL') as HTMLInputElement).value).toBe('https://example.com/a.png')
  })

  it('says why a URL was refused instead of looking like a dead click', () => {
    seedImage()
    render(<WithRealBackgroundOwner />)

    fireEvent.change(screen.getByLabelText('Image URL'), { target: { value: 'file:///etc/passwd' } })
    clickUseUrl()

    expect(screen.getByRole('alert').textContent).toMatch(/http\(s\)/)
  })

  it('does not resurrect the wallpaper when an upload lands after the user switched it off', async () => {
    // The response commits whatever `selectCustom` is told to; without checking
    // that the user is still in that media row, a wallpaper they just turned
    // off comes back on by itself.
    let settle: ((v: unknown) => void) | null = null
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { settle = resolve })))
    seedImage()
    render(<WithRealBackgroundOwner />)

    fireEvent.click(screen.getByRole('radio', { name: 'Video' }))
    fireEvent.click(screen.getByText('Upload video…'))
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    fireEvent.change(input, { target: { files: [new File(['x'], 'a.mp4', { type: 'video/mp4' })] } })

    fireEvent.click(screen.getByRole('radio', { name: 'None' }))

    await act(async () => {
      settle!({ ok: true, json: async () => ({ url: MP4_UPLOAD }) })
    })

    expect(stored()).toMatchObject({ pref: { kind: 'none' } })
  })

  it('deletes an upload it refuses instead of leaving it orphaned on disk', async () => {
    // The dialog's `accept` is a filter, not a gate: "All files" gets a .mp4
    // into Image mode, the server stores it, and the picker's own gate then
    // rejects it. Nothing would ever reference that file.
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ url: MP4_UPLOAD }) })
    vi.stubGlobal('fetch', fetchMock)
    render(<WithRealBackgroundOwner />)
    fireEvent.click(screen.getByRole('radio', { name: 'Image' }))
    fireEvent.click(screen.getByText('Upload image…'))
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    fireEvent.change(input, { target: { files: [new File(['x'], 'a.mp4', { type: 'video/mp4' })] } })

    await screen.findByRole('alert')
    expect(fetchMock).toHaveBeenCalledWith(MP4_UPLOAD, { method: 'DELETE' })
    expect(stored()).toEqual({ pref: { kind: 'none' }, opacity: BACKGROUND_DEFAULT_OPACITY })
  })

  it('drops a stale refusal once a wallpaper is applied from elsewhere', () => {
    // The refusal described a state that no longer exists; leaving it would put
    // "that URL can't be used" under a wallpaper that is working fine.
    seedImage()
    render(<WithRealBackgroundOwner />)
    fireEvent.change(screen.getByLabelText('Image URL'), { target: { value: 'file:///etc/passwd' } })
    clickUseUrl()
    expect(screen.getByRole('alert')).toBeTruthy()

    act(() => {
      window.dispatchEvent(new StorageEvent('storage', {
        key: BACKGROUND_KEY,
        newValue: JSON.stringify({ pref: { kind: 'custom', src: 'https://example.com/other.png', media: 'image' }, opacity: 0.8 }),
      }))
    })

    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('leaves the Applied confirmation alone when the checked radio is re-clicked', () => {
    // A re-click is inert, so it must not withdraw the feedback from the pick
    // that actually landed.
    render(<WithRealBackgroundOwner />)
    fireEvent.click(screen.getByRole('radio', { name: 'Image' }))
    fireEvent.change(screen.getByLabelText('Image URL'), { target: { value: 'https://example.com/a.png' } })
    clickUseUrl()
    expect(screen.getByText('Applied')).toBeTruthy()

    fireEvent.click(screen.getByRole('radio', { name: 'Image' }))

    expect(screen.getByText('Applied')).toBeTruthy()
  })

  it('keeps a typed draft when the already-checked radio is re-clicked', () => {
    // A re-click is a plausible "cancel / refresh my selection" gesture, and the
    // field may hold a URL the user has not applied yet. Only a switch between
    // media may touch the draft.
    window.localStorage.setItem(
      BACKGROUND_KEY,
      JSON.stringify({ pref: { kind: 'custom', src: MP4_UPLOAD, media: 'video' }, opacity: 0.8 }),
    )
    render(<WithRealBackgroundOwner />)
    fireEvent.click(screen.getByRole('radio', { name: 'Image' }))
    fireEvent.change(screen.getByLabelText('Image URL'), { target: { value: 'https://example.com/new.png' } })

    fireEvent.click(screen.getByRole('radio', { name: 'Image' }))

    expect((screen.getByLabelText('Image URL') as HTMLInputElement).value).toBe('https://example.com/new.png')
  })

  it('does not offer a remembered video src to the image row', () => {
    // A pre-video build wrote `lastSrc` with no `lastMedia`. Restoring it as an
    // image would build a pref the store's own validator rejects — a click that
    // silently does nothing.
    window.localStorage.setItem(
      BACKGROUND_KEY,
      JSON.stringify({ pref: { kind: 'none' }, opacity: 0.8, lastSrc: 'https://ex.com/clip.mp4' }),
    )
    render(<WithRealBackgroundOwner />)

    fireEvent.click(screen.getByRole('radio', { name: 'Image' }))

    expect((screen.getByLabelText('Image URL') as HTMLInputElement).value).toBe('')
    expect(stored()).toMatchObject({ pref: { kind: 'none' } })
  })

  it('refuses a URL whose file type contradicts the selected background', () => {
    render(<WithRealBackgroundOwner />)
    fireEvent.click(screen.getByRole('radio', { name: 'Video' }))
    fireEvent.change(screen.getByLabelText('Video URL'), { target: { value: 'https://ex.com/photo.png' } })
    clickUseUrl()

    expect(screen.getByRole('alert').textContent).toBe(
      'That is an image file. Pick a video URL, or switch to the image background.',
    )
    expect(stored()).toEqual({ pref: { kind: 'none' }, opacity: BACKGROUND_DEFAULT_OPACITY })
  })

  it('does not roll back a change made while an upload is in flight', async () => {
    // `selectCustom` closes over the setting of the render that started the
    // upload. A video upload takes seconds, so a slider moved meanwhile would
    // be silently reverted — and persisted — by the stale snapshot.
    let settle: ((v: unknown) => void) | null = null
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { settle = resolve })))
    seedImage('https://example.com/a.png', 0.8)
    render(<WithRealBackgroundOwner />)

    fireEvent.click(screen.getByRole('radio', { name: 'Video' }))
    fireEvent.click(screen.getByText('Upload video…'))
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    fireEvent.change(input, { target: { files: [new File(['x'], 'a.mp4', { type: 'video/mp4' })] } })

    fireEvent.change(screen.getByLabelText(/Opacity/), { target: { value: '0.3' } })
    expect(stored()).toMatchObject({ opacity: 0.3 })

    await act(async () => {
      settle!({ ok: true, json: async () => ({ url: MP4_UPLOAD }) })
    })
    await screen.findByText('Applied')

    expect(stored()).toMatchObject({
      opacity: 0.3,
      pref: { kind: 'custom', src: MP4_UPLOAD, media: 'video' },
    })
  })

  it('opens the URL row without persisting a half-finished pref', () => {
    render(<WithRealBackgroundOwner />)

    fireEvent.click(screen.getByRole('radio', { name: 'Image' }))

    expect(screen.getByLabelText('Image URL')).toBeTruthy()
    // The row is UI state. Nothing is on disk until a URL/upload actually lands,
    // so a mid-gesture pref can never become a durable "custom with no image".
    expect(stored()).toEqual({ pref: { kind: 'none' }, opacity: BACKGROUND_DEFAULT_OPACITY })
  })

  it('hides the opacity control while no image mode is selected', () => {
    render(<WithRealBackgroundOwner />)

    expect(screen.queryByText(/Opacity/)).toBeNull()

    fireEvent.click(screen.getByRole('radio', { name: 'Image' }))

    expect(screen.getByText(/Opacity/)).toBeTruthy()
  })

  it('keeps the image when switching to None and restores it on the way back', () => {
    window.localStorage.setItem(
      BACKGROUND_KEY,
      JSON.stringify({ pref: { kind: 'custom', src: 'https://example.com/a.png', media: 'image' }, opacity: 0.8 }),
    )
    render(<WithRealBackgroundOwner />)

    fireEvent.click(screen.getByRole('radio', { name: 'None' }))
    expect(stored()).toEqual({
      pref: { kind: 'none' }, opacity: 0.8, lastSrc: 'https://example.com/a.png', lastMedia: 'image',
    })

    fireEvent.click(screen.getByRole('radio', { name: 'Image' }))
    expect(stored()).toEqual({
      pref: { kind: 'custom', src: 'https://example.com/a.png', media: 'image' },
      opacity: 0.8,
      lastSrc: 'https://example.com/a.png',
      lastMedia: 'image',
    })
    expect((screen.getByLabelText('Image URL') as HTMLInputElement).value).toBe('https://example.com/a.png')
  })

  it('keeps a video when switching to None and restores it in video mode', () => {
    window.localStorage.setItem(
      BACKGROUND_KEY,
      JSON.stringify({ pref: { kind: 'custom', src: MP4_UPLOAD, media: 'video' }, opacity: 0.8 }),
    )
    render(<WithRealBackgroundOwner />)

    fireEvent.click(screen.getByRole('radio', { name: 'None' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Video' }))

    expect(stored()).toEqual({
      pref: { kind: 'custom', src: MP4_UPLOAD, media: 'video' },
      opacity: 0.8,
      lastSrc: MP4_UPLOAD,
      lastMedia: 'video',
    })
  })

  it('does not restore a remembered video into image mode', () => {
    // The two media render through different elements; offering the wrong one
    // would produce a checked radio with nothing behind it.
    window.localStorage.setItem(
      BACKGROUND_KEY,
      JSON.stringify({ pref: { kind: 'none' }, opacity: 0.8, lastSrc: MP4_UPLOAD, lastMedia: 'video' }),
    )
    render(<WithRealBackgroundOwner />)

    fireEvent.click(screen.getByRole('radio', { name: 'Image' }))

    expect((screen.getByLabelText('Image URL') as HTMLInputElement).value).toBe('')
    expect(stored()).toEqual({
      pref: { kind: 'none' }, opacity: 0.8, lastSrc: MP4_UPLOAD, lastMedia: 'video',
    })
  })

  it('loads a legacy pref with no media as an image', () => {
    window.localStorage.setItem(
      BACKGROUND_KEY,
      JSON.stringify({ pref: { kind: 'custom', src: 'https://example.com/a.png' }, opacity: 0.8 }),
    )
    render(<WithRealBackgroundOwner />)

    expect((screen.getByLabelText('Image URL') as HTMLInputElement).value).toBe('https://example.com/a.png')
    expect(screen.getByRole('radio', { name: 'Image' }).getAttribute('aria-checked')).toBe('true')
  })

  it('collapses a legacy {custom, ""} on disk back to None', () => {
    // Builds between the report and this fix wrote the mid-gesture pref; it must
    // not boot the picker into a checked radio with no image behind it.
    window.localStorage.setItem(BACKGROUND_KEY, JSON.stringify({ pref: { kind: 'custom', src: '' }, opacity: 0.85 }))
    render(<WithRealBackgroundOwner />)

    expect(screen.queryByLabelText('Image URL')).toBeNull()
    expect(stored()).toEqual({ pref: { kind: 'none' }, opacity: BACKGROUND_DEFAULT_OPACITY })
  })

  it('refuses an over-long URL instead of wiping the whole setting', () => {
    // The commit gate must be at least as strict as the store's validator. It
    // used to be scheme-only, so an over-cap URL was committed, rejected on the
    // echo, and took the working wallpaper + opacity down with it (see
    // useLocalStorage's write gate). Now the click is refused and nothing moves.
    const existing = { pref: { kind: 'custom', src: 'https://example.com/good.png', media: 'image' }, opacity: 0.3 }
    window.localStorage.setItem(BACKGROUND_KEY, JSON.stringify(existing))
    render(<WithRealBackgroundOwner />)

    const tooLong = `https://example.com/${'t'.repeat(BACKGROUND_SRC_MAX)}`
    fireEvent.change(screen.getByLabelText('Image URL'), { target: { value: tooLong } })
    clickUseUrl()

    expect(stored()).toEqual(existing)
  })

  it('restores the remembered image without rewriting its opacity', () => {
    // Switching off and back on must be faithful. `picking`'s at-max-opacity
    // auto-reset is for a first pick, not a restore.
    window.localStorage.setItem(
      BACKGROUND_KEY,
      JSON.stringify({ pref: { kind: 'custom', src: 'https://example.com/a.png', media: 'image' }, opacity: 1 }),
    )
    render(<WithRealBackgroundOwner />)

    fireEvent.click(screen.getByRole('radio', { name: 'None' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Image' }))

    expect(stored()).toEqual({
      pref: { kind: 'custom', src: 'https://example.com/a.png', media: 'image' },
      opacity: 1,
      lastSrc: 'https://example.com/a.png',
      lastMedia: 'image',
    })
  })

  it('keeps the opacity control when dragged below the old 0.55 floor', () => {
    // Reported symptom: dragging the slider down makes the control itself
    // vanish. Any write that the owner rejects reverts the whole setting to
    // `none`, and None mode hides the control — so this must never revert.
    window.localStorage.setItem(
      BACKGROUND_KEY,
      JSON.stringify({ pref: { kind: 'custom', src: 'https://example.com/a.png', media: 'image' }, opacity: 0.85 }),
    )
    render(<WithRealBackgroundOwner />)

    const slider = screen.getByLabelText(/Opacity/) as HTMLInputElement
    for (const v of ['0.55', '0.5', '0.4', '0.1', '0']) {
      fireEvent.change(slider, { target: { value: v } })
      expect(screen.queryByLabelText(/Opacity/)).toBeTruthy()
      expect(stored()).toMatchObject({
        pref: { kind: 'custom', src: 'https://example.com/a.png', media: 'image' }, opacity: Number(v),
      })
    }
  })

  it('offers a Blur control in custom mode and persists it', () => {
    window.localStorage.setItem(
      BACKGROUND_KEY,
      JSON.stringify({ pref: { kind: 'custom', src: 'https://example.com/a.png', media: 'image' }, opacity: 0.8 }),
    )
    render(<WithRealBackgroundOwner />)

    // A pref saved before blur existed must show the default, not 0.
    const blur = screen.getByLabelText(/Blur/) as HTMLInputElement
    expect(blur.value).toBe(String(BACKGROUND_DEFAULT_BLUR))

    fireEvent.change(blur, { target: { value: '4' } })
    expect(stored()).toMatchObject({ blur: 4 })

    fireEvent.click(screen.getByRole('radio', { name: 'None' }))
    expect(screen.queryByLabelText(/Blur/)).toBeNull()
  })

  it('offers a Content-opacity control that is separate from chrome Opacity', () => {
    // Two different knobs: chrome fill (Opacity) vs the surfaces inside it
    // (Content). Moving one must not disturb the other, or the sliders fight.
    window.localStorage.setItem(
      BACKGROUND_KEY,
      JSON.stringify({ pref: { kind: 'custom', src: 'https://example.com/a.png', media: 'image' }, opacity: 0.7 }),
    )
    render(<WithRealBackgroundOwner />)

    const content = screen.getByLabelText(/Content/) as HTMLInputElement
    expect(content.value).toBe(String(BACKGROUND_DEFAULT_SURFACE))

    fireEvent.change(content, { target: { value: '0.4' } })
    expect(stored()).toMatchObject({ opacity: 0.7, surface: 0.4 })

    fireEvent.click(screen.getByRole('radio', { name: 'None' }))
    expect(screen.queryByLabelText(/Content/)).toBeNull()
  })

  it('deletes an uploaded image when a new one replaces it, even while off', () => {
    // `lastSrc` extends an upload's life past the None switch, so it must not
    // outlive the last reference to it — the server file would be unreclaimable.
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)
    window.localStorage.setItem(
      BACKGROUND_KEY,
      JSON.stringify({ pref: { kind: 'none' }, opacity: 0.85, lastSrc: '/api/background/files/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.png', lastMedia: 'image' }),
    )
    render(<WithRealBackgroundOwner />)

    fireEvent.click(screen.getByRole('radio', { name: 'Image' }))
    fireEvent.change(screen.getByLabelText('Image URL'), { target: { value: 'https://example.com/new.png' } })
    clickUseUrl()

    expect(fetchMock).toHaveBeenCalledWith('/api/background/files/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.png', { method: 'DELETE' })
    expect(stored()).toMatchObject({ pref: { kind: 'custom', src: 'https://example.com/new.png', media: 'image' } })
  })

  it('restores an image that arrived while the URL row was already open', () => {
    // Mid-gesture (mode image, pref none) when another tab stashes an image:
    // re-clicking the checked radio must not be inert.
    render(<WithRealBackgroundOwner />)
    fireEvent.click(screen.getByRole('radio', { name: 'Image' }))

    act(() => {
      window.dispatchEvent(new StorageEvent('storage', {
        key: BACKGROUND_KEY,
        newValue: JSON.stringify({ pref: { kind: 'none' }, opacity: 0.85, lastSrc: 'https://example.com/other-tab.png', lastMedia: 'image' }),
      }))
    })

    fireEvent.click(screen.getByRole('radio', { name: 'Image' }))

    expect(stored()).toMatchObject({ pref: { kind: 'custom', src: 'https://example.com/other-tab.png', media: 'image' } })
  })
})
