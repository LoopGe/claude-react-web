import { describe, it, expect } from 'vitest'
import {
  buildSessionAccentMap, BACKGROUND_BLUR_MAX, BACKGROUND_SRC_MAX, BACKGROUND_SURFACE_STEP,
  BACKGROUND_DEFAULT_SURFACE, BACKGROUND_OPACITY_STEP, BACKGROUND_DEFAULT_OPACITY,
  BACKGROUND_DEFAULT_BLUR, BACKGROUND_BLUR_STEP,
  isBackgroundSrc, isBackgroundVideoSrc, isBackgroundUpload, isBackgroundSetting,
  srcMatchesMedia, mediaOfExtension,
} from './theme'

const VIDEO_UPLOAD = '/api/background/files/3f2a1b4c-5d6e-7f80-91a2-b3c4d5e6f708.mp4'
const WEBM_UPLOAD = '/api/background/files/3f2a1b4c-5d6e-7f80-91a2-b3c4d5e6f708.webm'
const IMAGE_UPLOAD = '/api/background/files/3f2a1b4c-5d6e-7f80-91a2-b3c4d5e6f708.png'

describe('background slider defaults land on their step grid', () => {
  // A default off the grid is silently snapped by real browsers (range value
  // sanitization), so the thumb renders elsewhere and the shipped default
  // becomes unreachable. jsdom does NOT sanitize, so only this check catches it.
  const onGrid = (min: number, step: number, value: number) =>
    Math.abs(Math.round((value - min) / step) - (value - min) / step) < 1e-9

  it('puts Opacity, Blur and Content defaults on their own steps', () => {
    expect(onGrid(0, BACKGROUND_OPACITY_STEP, BACKGROUND_DEFAULT_OPACITY)).toBe(true)
    expect(onGrid(0, BACKGROUND_BLUR_STEP, BACKGROUND_DEFAULT_BLUR)).toBe(true)
    expect(onGrid(0, BACKGROUND_SURFACE_STEP, BACKGROUND_DEFAULT_SURFACE)).toBe(true)
  })
})

describe('isBackgroundSrc', () => {
  it('accepts a remote http(s) URL and a server-assigned upload name', () => {
    expect(isBackgroundSrc('https://example.com/bg.png')).toBe(true)
    expect(isBackgroundSrc('/api/background/files/3f2a1b4c-5d6e-7f80-91a2-b3c4d5e6f708.png')).toBe(true)
  })
  it('rejects an upload path that is not a real server-assigned name', () => {
    // BackgroundPicker's delete-on-replace fetches this path. The browser
    // normalizes dot segments before the request leaves, so a permissive
    // prefix check turns a persisted string into an arbitrary same-origin
    // DELETE (e.g. /api/sessions/<id>) — bypassing the route's own containment.
    expect(isBackgroundSrc('/api/background/files/../../sessions/s1')).toBe(false)
    expect(isBackgroundSrc('/api/background/files/%2e%2e/sessions')).toBe(false)
    expect(isBackgroundSrc('/api/background/files/x.png')).toBe(false)
    expect(isBackgroundSrc('/api/background/files/deadbeef.png.sh')).toBe(false)
    expect(isBackgroundSrc('file:///C:/bg.png')).toBe(false)
    expect(isBackgroundSrc('')).toBe(false)
  })
})

describe('a scheme with no host', () => {
  it('is refused, because nothing can be fetched from it', () => {
    // `url("https://")` is not resolvable, so it commits a checked radio and an
    // "Applied" badge over a wallpaper that paints nothing.
    expect(isBackgroundSrc('https://')).toBe(false)
    expect(isBackgroundVideoSrc('https://')).toBe(false)
    expect(isBackgroundSrc('https://?a=1')).toBe(false)
  })
})

describe('isBackgroundVideoSrc', () => {
  it('accepts a remote http(s) URL and a server-assigned video upload', () => {
    expect(isBackgroundVideoSrc('https://example.com/clip.mp4')).toBe(true)
    expect(isBackgroundVideoSrc('https://example.com/clip.webm?a=1')).toBe(true)
    expect(isBackgroundVideoSrc(VIDEO_UPLOAD)).toBe(true)
    expect(isBackgroundVideoSrc(WEBM_UPLOAD)).toBe(true)
  })
  it('rejects an image upload, a non-http(s) scheme, and an empty src', () => {
    // We control the names of our own uploads, so the extension is the one
    // place we can be certain; a declared-video pref must not point at a .png.
    expect(isBackgroundVideoSrc(IMAGE_UPLOAD)).toBe(false)
    expect(isBackgroundVideoSrc('/api/background/files/x.mp4')).toBe(false)
    expect(isBackgroundVideoSrc('file:///C:/clip.mp4')).toBe(false)
    expect(isBackgroundVideoSrc('')).toBe(false)
  })
})

describe('isBackgroundUpload', () => {
  it('recognizes both image and video uploads of ours, and nothing else', () => {
    // It is the delete-on-replace guard, so it must cover every file the
    // picker can have uploaded — images and videos alike.
    expect(isBackgroundUpload(IMAGE_UPLOAD)).toBe(true)
    expect(isBackgroundUpload(VIDEO_UPLOAD)).toBe(true)
    expect(isBackgroundUpload('https://example.com/clip.mp4')).toBe(false)
    expect(isBackgroundUpload('/api/background/files/x.mov')).toBe(false)
  })
})

describe('isBackgroundSrc (image)', () => {
  it('rejects a video upload — an image pref must not reference one', () => {
    expect(isBackgroundSrc(VIDEO_UPLOAD)).toBe(false)
  })
})

describe('mediaOfExtension', () => {
  it('names the media a src extension belongs to, and null when it names none', () => {
    expect(mediaOfExtension('https://ex.com/a.png')).toBe('image')
    expect(mediaOfExtension('https://ex.com/a.webp')).toBe('image')
    expect(mediaOfExtension('https://ex.com/a.MP4')).toBe('video')
    expect(mediaOfExtension('/api/background/files/3f2a1b4c-5d6e-7f80-91a2-b3c4d5e6f708.webm')).toBe('video')
    // Only the path counts — a query or fragment is not part of the name.
    expect(mediaOfExtension('https://ex.com/a.png?sig=abc')).toBe('image')
    expect(mediaOfExtension('https://ex.com/a.png?next=b.mp4')).toBe('image')
    // No extension, or one we do not serve.
    expect(mediaOfExtension('https://ex.com/stream?v=1')).toBe(null)
    expect(mediaOfExtension('https://ex.com/render.php')).toBe(null)
  })

  it('does not mistake an Object.prototype member for a media', () => {
    // A bare index walks the prototype chain, so `.constructor` would resolve
    // to the Object function — truthy, so `?? null` never fires and the picker
    // interpolates it into a refusal message.
    expect(mediaOfExtension('https://ex.com/art.constructor')).toBe(null)
    expect(mediaOfExtension('https://ex.com/art.toString')).toBe(null)
    expect(mediaOfExtension('https://ex.com/art.valueOf')).toBe(null)
  })
})

describe('srcMatchesMedia vs a URL that names its own kind', () => {
  it('refuses a URL whose extension names the other media', () => {
    // The extension is the one thing a bare URL does say about itself. Trusting
    // the declaration past a contradiction commits a wallpaper nothing can
    // paint, and reports it as applied.
    expect(srcMatchesMedia('https://ex.com/clip.png', 'video')).toBe(false)
    expect(srcMatchesMedia('https://ex.com/clip.mp4', 'image')).toBe(false)
    expect(srcMatchesMedia('https://ex.com/clip.webm', 'image')).toBe(false)
  })
  it('accepts a URL whose extension agrees, and one that names nothing', () => {
    expect(srcMatchesMedia('https://ex.com/clip.mp4', 'video')).toBe(true)
    expect(srcMatchesMedia('https://ex.com/bg.png', 'image')).toBe(true)
    // Extension-less (or unknown-extension) URLs are still the user's word to
    // give: only they know what a bare link serves.
    expect(srcMatchesMedia('https://ex.com/stream?v=1', 'video')).toBe(true)
    expect(srcMatchesMedia('https://ex.com/render.php', 'image')).toBe(true)
  })
  it('reads the extension off the path, ignoring query and fragment', () => {
    expect(srcMatchesMedia('https://ex.com/bg.png?sig=abc', 'image')).toBe(true)
    expect(srcMatchesMedia('https://ex.com/clip.mp4#t=5', 'image')).toBe(false)
    expect(srcMatchesMedia('https://ex.com/a.png?next=b.mp4', 'image')).toBe(true)
  })
})

describe('isBackgroundSetting with media', () => {
  it('accepts a video pref whose src matches its declared media', () => {
    expect(isBackgroundSetting({ pref: { kind: 'custom', src: VIDEO_UPLOAD, media: 'video' }, opacity: 0.85 })).toBe(true)
    expect(isBackgroundSetting({ pref: { kind: 'custom', src: 'https://ex.com/a.mp4', media: 'video' }, opacity: 0.85 })).toBe(true)
  })
  it('treats a missing media as image, so pre-existing prefs keep loading', () => {
    expect(isBackgroundSetting({ pref: { kind: 'custom', src: IMAGE_UPLOAD }, opacity: 0.85 })).toBe(true)
    expect(isBackgroundSetting({ pref: { kind: 'custom', src: VIDEO_UPLOAD }, opacity: 0.85 })).toBe(false)
  })
  it('rejects a pref whose src contradicts its declared media', () => {
    expect(isBackgroundSetting({ pref: { kind: 'custom', src: IMAGE_UPLOAD, media: 'video' }, opacity: 0.85 })).toBe(false)
    expect(isBackgroundSetting({ pref: { kind: 'custom', src: VIDEO_UPLOAD, media: 'image' }, opacity: 0.85 })).toBe(false)
    expect(isBackgroundSetting({ pref: { kind: 'custom', src: 'https://ex.com/a.png', media: 'weird' }, opacity: 0.85 })).toBe(false)
  })
  it('keeps a setting whose remembered src is a video with no media recorded', () => {
    // A pre-video build wrote only `lastSrc`, and it may name a video. Rejecting
    // the whole setting would throw away the applied wallpaper, its opacity and
    // its sliders over a convenience copy that the picker will simply decline to
    // restore (see pickMedia).
    expect(isBackgroundSetting({ pref: { kind: 'none' }, opacity: 0.8, lastSrc: 'https://ex.com/clip.mp4' })).toBe(true)
    expect(isBackgroundSetting({ pref: { kind: 'none' }, opacity: 0.8, lastSrc: VIDEO_UPLOAD })).toBe(true)
  })

  it('validates lastSrc against lastMedia, and rejects a dangling lastMedia', () => {
    expect(isBackgroundSetting({
      pref: { kind: 'none' }, opacity: 0.85, lastSrc: VIDEO_UPLOAD, lastMedia: 'video',
    })).toBe(true)
    expect(isBackgroundSetting({
      pref: { kind: 'none' }, opacity: 0.85, lastSrc: IMAGE_UPLOAD, lastMedia: 'image',
    })).toBe(true)
    // A remembered src that contradicts its remembered media would restore the
    // wrong kind of file into the wrong player.
    expect(isBackgroundSetting({
      pref: { kind: 'none' }, opacity: 0.85, lastSrc: VIDEO_UPLOAD, lastMedia: 'image',
    })).toBe(false)
    expect(isBackgroundSetting({
      pref: { kind: 'none' }, opacity: 0.85, lastSrc: IMAGE_UPLOAD, lastMedia: 'video',
    })).toBe(false)
    // lastMedia with nothing remembered is meaningless half-state.
    expect(isBackgroundSetting({ pref: { kind: 'none' }, opacity: 0.85, lastMedia: 'video' })).toBe(false)
    expect(isBackgroundSetting({ pref: { kind: 'none' }, opacity: 0.85, lastMedia: 'weird' })).toBe(false)
  })
})

describe('buildSessionAccentMap', () => {
  const colors = { s1: '#7b8cde', s2: '#e07080' }

  it('builds a per-session override map for pickable skins', () => {
    const map = buildSessionAccentMap(colors, 'default')
    expect(map.size).toBe(2)
    expect(map.get('s1')).toEqual({
      '--accent': '#7b8cde',
      '--accent-strong': '#5b6fc7',
      '--on-accent': expect.any(String),
    })
    expect(map.get('s2')).toEqual({
      '--accent': '#e07080',
      '--accent-strong': '#c45465',
      '--on-accent': expect.any(String),
    })
  })

  it('returns an empty map when the skin locks the accent (Anthropic)', () => {
    // Per-session inline --accent would override the skin's locked brand
    // accent at the element level, so they must be suppressed.
    const map = buildSessionAccentMap(colors, 'anthropic')
    expect(map.size).toBe(0)
  })

  it('returns an empty map when the skin locks the accent (HC)', () => {
    const map = buildSessionAccentMap(colors, 'hc')
    expect(map.size).toBe(0)
  })

  it('defaults to unlocked when no skin is given', () => {
    const map = buildSessionAccentMap(colors)
    expect(map.size).toBe(2)
  })

  it('returns an empty map for undefined input', () => {
    expect(buildSessionAccentMap(undefined, 'default').size).toBe(0)
  })
})

describe('isBackgroundSetting', () => {
  it('accepts a none setting', () => {
    expect(isBackgroundSetting({ pref: { kind: 'none' }, opacity: 0.85 })).toBe(true)
  })
  it('accepts a custom setting with an http(s) src', () => {
    expect(isBackgroundSetting({ pref: { kind: 'custom', src: 'https://example.com/bg.png' }, opacity: 0.7 })).toBe(true)
  })
  it('rejects a custom pref whose src is empty', () => {
    // `{kind:'custom', src:''}` is the picker's mid-gesture state, never a
    // persisted one — see isBackgroundSetting's docs. Accepting it would let a
    // half-selection become the app's durable background state.
    expect(isBackgroundSetting({ pref: { kind: 'custom', src: '' }, opacity: 0.85 })).toBe(false)
  })
  it('accepts a custom src right up to the length cap and rejects beyond it', () => {
    const root = 'https://example.com/'
    expect(isBackgroundSetting({
      pref: { kind: 'custom', src: root + 't'.repeat(BACKGROUND_SRC_MAX - root.length) }, opacity: 0.85,
    })).toBe(true)
    expect(isBackgroundSetting({
      pref: { kind: 'custom', src: root + 't'.repeat(BACKGROUND_SRC_MAX - root.length + 1) }, opacity: 0.85,
    })).toBe(false)
  })
  it('accepts only an applicable image reference — remote http(s) or an upload', () => {
    expect(isBackgroundSetting({
      pref: { kind: 'custom', src: '/api/background/files/3f2a1b4c-5d6e-7f80-91a2-b3c4d5e6f708.png' }, opacity: 0.85,
    })).toBe(true)
    // A shape the picker would never offer (and which cannot load in a
    // browser-served page) must not survive a load or a lastSrc restore.
    expect(isBackgroundSetting({ pref: { kind: 'custom', src: 'file:///C:/bg.png' }, opacity: 0.85 })).toBe(false)
    expect(isBackgroundSetting({ pref: { kind: 'none' }, opacity: 0.85, lastSrc: 'file:///C:/bg.png' })).toBe(false)
  })
  it('treats a missing surface as the default and rejects an out-of-range one', () => {
    // Same optional-field rule as blur: prefs saved before the Content slider
    // existed must keep loading intact.
    expect(isBackgroundSetting({ pref: { kind: 'none' }, opacity: 0.85 })).toBe(true)
    expect(isBackgroundSetting({ pref: { kind: 'none' }, opacity: 0.85, surface: 0.88 })).toBe(true)
    expect(isBackgroundSetting({ pref: { kind: 'none' }, opacity: 0.85, surface: -0.01 })).toBe(false)
    expect(isBackgroundSetting({ pref: { kind: 'none' }, opacity: 0.85, surface: 1.01 })).toBe(false)
    expect(isBackgroundSetting({ pref: { kind: 'none' }, opacity: 0.85, surface: 'x' })).toBe(false)
  })
  it('treats a missing blur as the default and rejects an out-of-range one', () => {
    // Prefs saved before the blur control existed must keep loading — a
    // required field here would collapse the whole setting and take the
    // user's wallpaper down with it.
    expect(isBackgroundSetting({ pref: { kind: 'none' }, opacity: 0.85 })).toBe(true)
    expect(isBackgroundSetting({ pref: { kind: 'none' }, opacity: 0.85, blur: 12 })).toBe(true)
    expect(isBackgroundSetting({ pref: { kind: 'none' }, opacity: 0.85, blur: -1 })).toBe(false)
    expect(isBackgroundSetting({
      pref: { kind: 'none' }, opacity: 0.85, blur: BACKGROUND_BLUR_MAX + 1,
    })).toBe(false)
  })
  it('accepts the full 0–1 opacity range', () => {
    // Fully transparent chrome is a legitimate choice at the bottom.
    expect(isBackgroundSetting({ pref: { kind: 'none' }, opacity: 0 })).toBe(true)
    expect(isBackgroundSetting({ pref: { kind: 'none' }, opacity: 1 })).toBe(true)
    expect(isBackgroundSetting({ pref: { kind: 'none' }, opacity: -0.01 })).toBe(false)
  })
  it('accepts a remembered lastSrc beside any pref, and rejects a malformed one', () => {
    expect(isBackgroundSetting({
      pref: { kind: 'none' }, opacity: 0.85, lastSrc: 'https://example.com/bg.png',
    })).toBe(true)
    expect(isBackgroundSetting({
      pref: { kind: 'custom', src: 'https://example.com/bg.png' }, opacity: 0.85, lastSrc: 42,
    })).toBe(false)
  })
  it('rejects a corrupt / hand-edited value', () => {
    expect(isBackgroundSetting(null)).toBe(false)
    expect(isBackgroundSetting({ pref: { kind: 'custom' }, opacity: 0.7 })).toBe(false) // missing src
    expect(isBackgroundSetting({ pref: { kind: 'none' }, opacity: 2 })).toBe(false)      // opacity out of range
    expect(isBackgroundSetting({ pref: { kind: 'weird' }, opacity: 0.5 })).toBe(false)
  })
})
