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
  })

  it('renders None/Custom and defaults to None active', () => {
    render(<BackgroundPicker setting={setting({ kind: 'none' })} onChange={() => {}} />)
    expect(screen.getByRole('radio', { name: 'None' })).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'Custom image' })).toBeTruthy()
  })

  it('applies a valid http(s) URL on submit', () => {
    const onChange = vi.fn()
    render(<BackgroundPicker setting={setting({ kind: 'none' })} onChange={onChange} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Custom image' }))
    fireEvent.change(screen.getByLabelText('Image URL'), { target: { value: 'https://ex.com/bg.png' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use URL' }))
    expect(onChange).toHaveBeenCalledWith({
      pref: { kind: 'custom', src: 'https://ex.com/bg.png' }, opacity: 0.85, lastSrc: 'https://ex.com/bg.png',
    })
  })

  it('rejects a non-http(s) URL', () => {
    const onChange = vi.fn()
    render(<BackgroundPicker setting={setting({ kind: 'none' })} onChange={onChange} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Custom image' }))
    onChange.mockClear()
    fireEvent.change(screen.getByLabelText('Image URL'), { target: { value: 'file:///etc/passwd' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use URL' }))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('uploads a file and applies the returned URL, deleting the old file', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ url: '/api/background/files/7c9e6679-7425-40de-944b-e07fc1f90ae7.png' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) }) // DELETE old
    vi.stubGlobal('fetch', fetchMock)
    const onChange = vi.fn()
    render(<BackgroundPicker setting={setting({ kind: 'custom', src: '/api/background/files/11111111-2222-4333-8444-555555555555.png' }, 0.7)} onChange={onChange} />)
    fireEvent.click(screen.getByText('Upload image…'))
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    fireEvent.change(input, { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } })
    await screen.findByText('Applied')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(onChange).toHaveBeenCalledWith({
      pref: { kind: 'custom', src: '/api/background/files/7c9e6679-7425-40de-944b-e07fc1f90ae7.png' }, opacity: 0.7, lastSrc: '/api/background/files/7c9e6679-7425-40de-944b-e07fc1f90ae7.png',
    })
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
    window.localStorage.clear()
  })

  const stored = () => JSON.parse(window.localStorage.getItem(BACKGROUND_KEY) ?? 'null') as unknown
  const clickUseUrl = () => { fireEvent.click(screen.getByRole('button', { name: 'Use URL' })) }

  it('opens the URL row without persisting a half-finished pref', () => {
    render(<WithRealBackgroundOwner />)

    fireEvent.click(screen.getByRole('radio', { name: 'Custom image' }))

    expect(screen.getByLabelText('Image URL')).toBeTruthy()
    // The row is UI state. Nothing is on disk until a URL/upload actually lands,
    // so a mid-gesture pref can never become a durable "custom with no image".
    expect(stored()).toEqual({ pref: { kind: 'none' }, opacity: BACKGROUND_DEFAULT_OPACITY })
  })

  it('hides the opacity control while no image mode is selected', () => {
    render(<WithRealBackgroundOwner />)

    expect(screen.queryByText(/Opacity/)).toBeNull()

    fireEvent.click(screen.getByRole('radio', { name: 'Custom image' }))

    expect(screen.getByText(/Opacity/)).toBeTruthy()
  })

  it('keeps the image when switching to None and restores it on the way back', () => {
    window.localStorage.setItem(
      BACKGROUND_KEY,
      JSON.stringify({ pref: { kind: 'custom', src: 'https://example.com/a.png' }, opacity: 0.8 }),
    )
    render(<WithRealBackgroundOwner />)

    fireEvent.click(screen.getByRole('radio', { name: 'None' }))
    expect(stored()).toEqual({
      pref: { kind: 'none' }, opacity: 0.8, lastSrc: 'https://example.com/a.png',
    })

    fireEvent.click(screen.getByRole('radio', { name: 'Custom image' }))
    expect(stored()).toEqual({
      pref: { kind: 'custom', src: 'https://example.com/a.png' }, opacity: 0.8, lastSrc: 'https://example.com/a.png',
    })
    expect((screen.getByLabelText('Image URL') as HTMLInputElement).value).toBe('https://example.com/a.png')
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
    const existing = { pref: { kind: 'custom', src: 'https://example.com/good.png' }, opacity: 0.3 }
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
      JSON.stringify({ pref: { kind: 'custom', src: 'https://example.com/a.png' }, opacity: 1 }),
    )
    render(<WithRealBackgroundOwner />)

    fireEvent.click(screen.getByRole('radio', { name: 'None' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Custom image' }))

    expect(stored()).toEqual({
      pref: { kind: 'custom', src: 'https://example.com/a.png' },
      opacity: 1,
      lastSrc: 'https://example.com/a.png',
    })
  })

  it('keeps the opacity control when dragged below the old 0.55 floor', () => {
    // Reported symptom: dragging the slider down makes the control itself
    // vanish. Any write that the owner rejects reverts the whole setting to
    // `none`, and None mode hides the control — so this must never revert.
    window.localStorage.setItem(
      BACKGROUND_KEY,
      JSON.stringify({ pref: { kind: 'custom', src: 'https://example.com/a.png' }, opacity: 0.85 }),
    )
    render(<WithRealBackgroundOwner />)

    const slider = screen.getByLabelText(/Opacity/) as HTMLInputElement
    for (const v of ['0.55', '0.5', '0.4', '0.1', '0']) {
      fireEvent.change(slider, { target: { value: v } })
      expect(screen.queryByLabelText(/Opacity/)).toBeTruthy()
      expect(stored()).toMatchObject({
        pref: { kind: 'custom', src: 'https://example.com/a.png' }, opacity: Number(v),
      })
    }
  })

  it('offers a Blur control in custom mode and persists it', () => {
    window.localStorage.setItem(
      BACKGROUND_KEY,
      JSON.stringify({ pref: { kind: 'custom', src: 'https://example.com/a.png' }, opacity: 0.8 }),
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
      JSON.stringify({ pref: { kind: 'custom', src: 'https://example.com/a.png' }, opacity: 0.7 }),
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
      JSON.stringify({ pref: { kind: 'none' }, opacity: 0.85, lastSrc: '/api/background/files/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.png' }),
    )
    render(<WithRealBackgroundOwner />)

    fireEvent.click(screen.getByRole('radio', { name: 'Custom image' }))
    fireEvent.change(screen.getByLabelText('Image URL'), { target: { value: 'https://example.com/new.png' } })
    clickUseUrl()

    expect(fetchMock).toHaveBeenCalledWith('/api/background/files/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.png', { method: 'DELETE' })
    expect(stored()).toMatchObject({ pref: { kind: 'custom', src: 'https://example.com/new.png' } })
  })

  it('restores an image that arrived while the URL row was already open', () => {
    // Mid-gesture (mode custom, pref none) when another tab stashes an image:
    // re-clicking the checked radio must not be inert.
    render(<WithRealBackgroundOwner />)
    fireEvent.click(screen.getByRole('radio', { name: 'Custom image' }))

    act(() => {
      window.dispatchEvent(new StorageEvent('storage', {
        key: BACKGROUND_KEY,
        newValue: JSON.stringify({ pref: { kind: 'none' }, opacity: 0.85, lastSrc: 'https://example.com/other-tab.png' }),
      }))
    })

    fireEvent.click(screen.getByRole('radio', { name: 'Custom image' }))

    expect(stored()).toMatchObject({ pref: { kind: 'custom', src: 'https://example.com/other-tab.png' } })
  })
})
