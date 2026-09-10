// Background section body for the Appearance popover (default/glow skins).
// Lets the user pick None, a Custom image, or a Custom video — via a remote
// http(s) URL or a local file uploaded to /api/background — and tune how the
// chrome sits over it (fill opacity + frost strength).
//
// The media is an explicit choice, never inferred from the src: a remote URL
// carries no reliable extension, and the wrong kind renders as nothing at all.

import { useEffect, useRef, useState } from 'react'
import { getMaxUploadBytes } from '../hooks/config-store'
import { formatBytes } from '../utils/format'
import {
  BACKGROUND_OPACITY_MIN,
  BACKGROUND_OPACITY_MAX,
  BACKGROUND_OPACITY_STEP,
  BACKGROUND_BLUR_MIN,
  BACKGROUND_BLUR_MAX,
  BACKGROUND_BLUR_STEP,
  BACKGROUND_DEFAULT_BLUR,
  BACKGROUND_SURFACE_MIN,
  BACKGROUND_SURFACE_MAX,
  BACKGROUND_SURFACE_STEP,
  BACKGROUND_DEFAULT_SURFACE,
  isBackgroundUpload,
  srcMatchesMedia,
  mediaOfPref,
  mediaOfExtension,
  type BackgroundMedia,
  type BackgroundSetting,
} from '../theme'

type PickerMode = 'none' | BackgroundMedia

/** Per-media copy and file-picker limits. One table so a media's URL label,
 *  button text and accepted types cannot drift apart. */
const MEDIA_UI: Record<BackgroundMedia, {
  radio: string
  /** With its article, for sentences: "an image", "a video". */
  noun: string
  urlLabel: string
  placeholder: string
  uploadLabel: string
  accept: string
}> = {
  image: {
    radio: 'Image',
    noun: 'an image',
    urlLabel: 'Image URL',
    placeholder: 'https://…',
    uploadLabel: 'Upload image…',
    accept: 'image/png,image/jpeg,image/webp',
  },
  video: {
    radio: 'Video',
    noun: 'a video',
    urlLabel: 'Video URL',
    placeholder: 'https://….mp4',
    uploadLabel: 'Upload video…',
    accept: 'video/mp4,video/webm',
  },
}

interface Props {
  setting: BackgroundSetting
  onChange: (next: BackgroundSetting) => void
}

export function BackgroundPicker({ setting, onChange }: Props) {
  // Internal mode state so the UI responds immediately to clicks even when
  // the parent hasn't re-rendered with the new setting prop yet.
  const [mode, setMode] = useState<PickerMode>(setting.pref.kind === 'custom' ? mediaOfPref(setting.pref) : 'none')
  const [urlText, setUrlText] = useState(setting.pref.kind === 'custom' ? setting.pref.src : '')
  const [applied, setApplied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Re-sync with any external change (another tab, reset-to-defaults, restore).
  // React's "adjust state during render" pattern instead of an effect, which
  // would trigger cascading renders. Tracking the *src* and not just the kind
  // matters: a same-kind src change would otherwise leave urlText holding the
  // previous image, and committing that stale draft would roll the other
  // writer back — and DELETE the file it had just uploaded. The media is part
  // of the key for the same reason: an external switch must move the radio too.
  const committed = setting.pref.kind === 'custom' ? `${mediaOfPref(setting.pref)} ${setting.pref.src}` : null
  const [prevCommitted, setPrevCommitted] = useState(committed)
  if (prevCommitted !== committed) {
    setPrevCommitted(committed)
    setMode(setting.pref.kind === 'custom' ? mediaOfPref(setting.pref) : 'none')
    setUrlText(setting.pref.kind === 'custom' ? setting.pref.src : '')
    // A refusal is a claim about the state that just changed, so it must go —
    // otherwise a red "that URL can't be used" sits under a wallpaper another
    // tab applied successfully. `applied` is deliberately kept: it notes what
    // this tab last picked, which stays true, and clearing it here would also
    // wipe our own confirmation (a commit of ours changes `committed` too).
    setError(null)
  }

  // Mirrors of the live state. An upload takes seconds, and the commit runs on
  // the response: reading the values of the render that *started* the upload
  // would write a stale snapshot back over whatever the user did meanwhile (a
  // slider drag, a switch to None, a radio change), and would pick the delete
  // target from a pref that is no longer applied.
  const latest = useRef(setting)
  const latestMode = useRef(mode)
  useEffect(() => {
    latest.current = setting
    latestMode.current = mode
  }, [setting, mode])
  const isCustom = mode !== 'none'
  const media: BackgroundMedia = mode === 'video' ? 'video' : 'image'
  const ui = MEDIA_UI[media]
  // The remembered src's own media — absent on a pref saved before video.
  const rememberedMedia: BackgroundMedia = setting.lastMedia ?? 'image'
  /** The wallpaper actually applied right now, if any. A `custom` pref is only
   *  ever committed with a real src, but the empty-src shape is defended here
   *  too so the sliders cannot write against a pref that renders nothing.
   *  Distinct from "this mode has one": the user can be browsing the other
   *  media's row while one still applies. */
  const livePref = setting.pref.kind === 'custom' && setting.pref.src.length > 0 ? setting.pref : null
  const isLive = livePref !== null

  const deleteIfUploaded = (src: string) => {
    if (isBackgroundUpload(src)) {
      fetch(src, { method: 'DELETE' }).catch(() => {})
    }
  }

  /** The single funnel that commits a real src. Returns whether it stuck.
   *  Checks the src FIRST: the delete below is irreversible, so it must never
   *  run for a write the store would go on to drop. `lastSrc` is the copy a
   *  later switch to None keeps, so re-selecting its media restores the
   *  wallpaper; whatever upload this replaces — live or stashed — loses its
   *  last reference, so it goes with it. */
  const selectCustom = (src: string, next: BackgroundMedia): boolean => {
    if (!srcMatchesMedia(src, next)) {
      console.warn('[background] refused a reference it cannot apply')
      return false
    }
    const current = latest.current
    const replaced = current.pref.kind === 'custom' ? current.pref.src : current.lastSrc
    if (replaced && replaced !== src) deleteIfUploaded(replaced)
    onChange({ ...current, pref: { kind: 'custom', src, media: next }, lastSrc: src, lastMedia: next })
    setError(null)
    return true
  }

  /** Switch to a media. Restores the remembered src if it belongs to that
   *  media; with nothing to restore this is UI-only — the pref is written by
   *  the first Use URL / upload, never as `{custom, src: ''}`. Re-clicking
   *  mid-gesture is not inert: a matching src can arrive from another tab in
   *  the meantime. */
  const pickMedia = (next: BackgroundMedia) => {
    const switching = mode !== next
    setMode(next)
    const live = setting.pref.kind === 'custom' && mediaOfPref(setting.pref) === next
      ? setting.pref.src
      : undefined
    // Re-clicking the radio that is already checked is inert in every respect:
    // it must not discard a draft the user has not applied yet, nor withdraw
    // the "Applied" badge or a refusal from the pick that actually landed. It
    // only fills an EMPTY field, from a wallpaper another tab stashed meanwhile.
    if (!switching && (live !== undefined || urlText !== '')) return
    setApplied(false)
    setError(null)
    // A src may only be restored into a media it can actually be applied as:
    // handing an image to the video player (or the reverse) would either paint
    // nothing or build a pref the store's own validator drops — a click that
    // silently does nothing.
    const remembered = live === undefined
      && rememberedMedia === next
      && setting.lastSrc !== undefined
      && srcMatchesMedia(setting.lastSrc, next)
      ? setting.lastSrc
      : undefined
    // Show what is applied when switching back to the live media (a blank field
    // would also make the applied src unreachable), else the memory.
    if (switching) setUrlText(live ?? remembered ?? '')
    if (live !== undefined) return
    if (remembered) {
      onChange({ ...setting, pref: { kind: 'custom', src: remembered, media: next }, lastSrc: remembered, lastMedia: next })
    }
  }

  /** Switch off without forgetting: stash the current src and its media. */
  const pickNone = () => {
    setMode('none')
    setApplied(false)
    setError(null)
    const src = setting.pref.kind === 'custom' ? setting.pref.src : setting.lastSrc
    const srcMedia = setting.pref.kind === 'custom' ? mediaOfPref(setting.pref) : rememberedMedia
    onChange({
      ...setting,
      pref: { kind: 'none' },
      ...(src ? { lastSrc: src, lastMedia: srcMedia } : {}),
    })
  }

  const applyUrl = () => {
    const next = urlText.trim()
    if (!next) {
      setApplied(false)
      setError('Enter a URL first.')
      return
    }
    // selectCustom enforces srcMatchesMedia — the same rule the store
    // validates with. Keeping one gate means the picker can never offer a src
    // the owner would drop (which used to revert the entire setting).
    const applied = selectCustom(next, media)
    setApplied(applied)
    // A refusal that only reaches the console reads as a click that did
    // nothing, exactly like the refused uploads the sibling path reports. Name
    // the contradiction when there is one — it is the case the user cannot
    // guess at — and the accepted forms otherwise.
    if (!applied) {
      const named = mediaOfExtension(next)
      setError(named && named !== media
        ? `That is ${MEDIA_UI[named].noun} file. Pick ${ui.noun} URL, or switch to the ${named} background.`
        : `Only an http(s) URL, or one of your own uploads, can be used as the ${media} background.`)
    }
  }

  const handleUpload = async (file: File) => {
    const forMedia = media
    const max = getMaxUploadBytes()
    if (file.size > max) {
      setApplied(false)
      setError(`File too large (${formatBytes(file.size)}). Max ${formatBytes(max)}.`)
      return
    }
    const form = new FormData()
    form.append('file', file, file.name)
    try {
      const res = await fetch('/api/background/upload', { method: 'POST', body: form })
      const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string }
      if (!res.ok || !body.url) throw new Error(body.error || `upload failed (HTTP ${res.status})`)
      // An upload takes seconds. If the user walked away from this media row
      // meanwhile — switched it off, or moved to the other radio — committing
      // now would turn a wallpaper they just dismissed back on. Nothing would
      // reference the file, so it goes with the intent.
      if (latestMode.current !== forMedia) {
        deleteIfUploaded(body.url)
        return
      }
      // A server path the picker can't apply must not report success — and the
      // user has to hear about it, or the click just looks inert. The bytes are
      // already on disk with nothing to claim them, so the refusal takes them.
      const applied = selectCustom(body.url, forMedia)
      setApplied(applied)
      if (!applied) {
        deleteIfUploaded(body.url)
        setError(`That file cannot be used as the ${media} background.`)
      }
    } catch (e) {
      // Surface transiently; the picker remains usable.
      setApplied(false)
      setError((e as Error).message)
      console.warn('[background] upload failed:', (e as Error).message)
    }
  }

  // The live wallpaper only when its media is the one on screen — otherwise the
  // hint would describe a file the visible controls do not act on.
  const prefSrc = livePref && mediaOfPref(livePref) === media ? livePref.src : undefined
  // A pref saved before the Blur slider existed carries no value; show the
  // default rather than 0 (which would read as "the setting is off").
  const blurValue = setting.blur ?? BACKGROUND_DEFAULT_BLUR
  const surfaceValue = setting.surface ?? BACKGROUND_DEFAULT_SURFACE

  return (
    <div className="appearance-bg">
      <div className="appearance-mode-row" role="radiogroup" aria-label="Background">
        <button
          type="button"
          className={`appearance-mode-btn${!isCustom ? ' active' : ''}`}
          onClick={pickNone}
          role="radio"
          aria-checked={!isCustom}
        >
          <span>None</span>
        </button>
        {(['image', 'video'] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            className={`appearance-mode-btn${mode === kind ? ' active' : ''}`}
            onClick={() => pickMedia(kind)}
            role="radio"
            aria-checked={mode === kind}
          >
            <span>{MEDIA_UI[kind].radio}</span>
          </button>
        ))}
      </div>

      {isCustom && (
        <div className="appearance-bg-body">
          <label className="appearance-bg-label" htmlFor="appearance-bg-url">{ui.urlLabel}</label>
          <div className="appearance-bg-url-row">
            <input
              id="appearance-bg-url"
              className="appearance-bg-url"
              value={urlText}
              placeholder={ui.placeholder}
              onChange={(e) => { setUrlText(e.target.value); setApplied(false); setError(null) }}
              aria-label={ui.urlLabel}
            />
            <button type="button" className="btn" onClick={applyUrl}>Use URL</button>
          </div>
          <div className="appearance-bg-upload-row">
            <label className="btn">
              {ui.uploadLabel}
              <input
                type="file"
                accept={ui.accept}
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) void handleUpload(f)
                  e.target.value = ''
                }}
              />
            </label>
            {applied && <span className="appearance-bg-hint">Applied</span>}
          </div>
          {error && <p className="appearance-bg-error" role="alert">{error}</p>}
          {prefSrc && (
            <div className="appearance-bg-current">
              <span className="appearance-bg-hint">
                {isBackgroundUpload(prefSrc) ? `Uploaded ${media}` : `Remote ${media}`}
              </span>
            </div>
          )}
        </div>
      )}

      {isCustom && (
        <>
          <div className="appearance-bg-opacity">
            <label className="appearance-bg-label" htmlFor="appearance-bg-opacity">
              Opacity <span className="appearance-bg-hint">{Math.round(setting.opacity * 100)}%</span>
            </label>
            <input
              id="appearance-bg-opacity"
              className="appearance-bg-slider"
              type="range"
              min={BACKGROUND_OPACITY_MIN}
              max={BACKGROUND_OPACITY_MAX}
              step={BACKGROUND_OPACITY_STEP}
              value={setting.opacity}
              disabled={!isLive}
              onChange={(e) => onChange({ ...setting, opacity: Number(e.target.value) })}
            />
          </div>
          <div className="appearance-bg-blur">
            <label className="appearance-bg-label" htmlFor="appearance-bg-blur">
              Blur <span className="appearance-bg-hint">{blurValue}px</span>
            </label>
            <input
              id="appearance-bg-blur"
              className="appearance-bg-slider"
              type="range"
              min={BACKGROUND_BLUR_MIN}
              max={BACKGROUND_BLUR_MAX}
              step={BACKGROUND_BLUR_STEP}
              value={blurValue}
              disabled={!isLive}
              onChange={(e) => onChange({ ...setting, blur: Number(e.target.value) })}
            />
          </div>
          <div className="appearance-bg-surface">
            <label className="appearance-bg-label" htmlFor="appearance-bg-surface">
              Content <span className="appearance-bg-hint">{Math.round(surfaceValue * 100)}%</span>
            </label>
            <input
              id="appearance-bg-surface"
              className="appearance-bg-slider"
              type="range"
              min={BACKGROUND_SURFACE_MIN}
              max={BACKGROUND_SURFACE_MAX}
              step={BACKGROUND_SURFACE_STEP}
              value={surfaceValue}
              disabled={!isLive}
              onChange={(e) => onChange({ ...setting, surface: Number(e.target.value) })}
            />
          </div>
        </>
      )}
    </div>
  )
}
