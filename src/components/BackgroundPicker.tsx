// Background section body for the Appearance popover (default/glow skins).
// Lets the user pick None or a Custom image — via a remote http(s) URL or a
// local file uploaded to /api/background — and tune how the chrome sits over
// it (fill opacity + frost strength).

import { useState } from 'react'
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
  isBackgroundSrc,
  isBackgroundUpload,
  type BackgroundSetting,
} from '../theme'

interface Props {
  setting: BackgroundSetting
  onChange: (next: BackgroundSetting) => void
}

export function BackgroundPicker({ setting, onChange }: Props) {
  // Internal mode state so the UI responds immediately to clicks even when
  // the parent hasn't re-rendered with the new setting prop yet.
  const [mode, setMode] = useState<'none' | 'custom'>(setting.pref.kind === 'custom' ? 'custom' : 'none')
  const [urlText, setUrlText] = useState(setting.pref.kind === 'custom' ? setting.pref.src : '')
  const [applied, setApplied] = useState(false)
  // Re-sync with any external change (another tab, reset-to-defaults, restore).
  // React's "adjust state during render" pattern instead of an effect, which
  // would trigger cascading renders. Tracking the *src* and not just the kind
  // matters: a same-kind src change would otherwise leave urlText holding the
  // previous image, and committing that stale draft would roll the other
  // writer back — and DELETE the file it had just uploaded.
  const committed = setting.pref.kind === 'custom' ? setting.pref.src : null
  const [prevCommitted, setPrevCommitted] = useState(committed)
  if (prevCommitted !== committed) {
    setPrevCommitted(committed)
    setMode(committed !== null ? 'custom' : 'none')
    setUrlText(committed ?? '')
  }
  const isCustom = mode === 'custom'

  const deleteIfUploaded = (src: string) => {
    if (isBackgroundUpload(src)) {
      fetch(src, { method: 'DELETE' }).catch(() => {})
    }
  }

  /** The single funnel that commits a real image. Returns whether it stuck.
   *  Checks the src FIRST: the delete below is irreversible, so it must never
   *  run for a write the store would go on to drop. `lastSrc` is the copy a
   *  later switch to None keeps, so re-selecting "Custom image" restores the
   *  wallpaper; whatever upload this replaces — live or stashed — loses its
   *  last reference, so it goes with it. */
  const selectCustom = (src: string): boolean => {
    if (!isBackgroundSrc(src)) {
      console.warn('[background] refused an image reference it cannot apply')
      return false
    }
    const replaced = setting.pref.kind === 'custom' ? setting.pref.src : setting.lastSrc
    if (replaced && replaced !== src) deleteIfUploaded(replaced)
    onChange({ ...setting, pref: { kind: 'custom', src }, lastSrc: src })
    return true
  }

  /** Switch to Custom. Restores the remembered image if there is one; with
   *  nothing to restore this is UI-only — the pref is written by the first
   *  Use URL / upload, never as `{custom, src: ''}`. Re-clicking mid-gesture is
   *  not inert: an image can arrive from another tab in the meantime. */
  const pickCustom = () => {
    setMode('custom')
    if (setting.pref.kind === 'custom') return
    const remembered = setting.lastSrc
    setUrlText(remembered ?? '')
    if (remembered) onChange({ ...setting, pref: { kind: 'custom', src: remembered } })
  }

  /** Switch off without forgetting: stash the current image in `lastSrc`. */
  const pickNone = () => {
    setMode('none')
    setApplied(false)
    const remembered = setting.pref.kind === 'custom' ? setting.pref.src : setting.lastSrc
    onChange({ ...setting, pref: { kind: 'none' }, lastSrc: remembered })
  }

  const applyUrl = () => {
    const trimmed = urlText.trim()
    // selectCustom enforces isBackgroundSrc — the same predicate the store
    // validates with. Keeping one gate means the picker can never offer a src
    // the owner would drop (which used to revert the entire setting).
    setApplied(selectCustom(trimmed))
  }

  const handleUpload = async (file: File) => {
    const form = new FormData()
    form.append('file', file, file.name)
    try {
      const res = await fetch('/api/background/upload', { method: 'POST', body: form })
      const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string }
      if (!res.ok || !body.url) throw new Error(body.error || `upload failed (HTTP ${res.status})`)
      // A server path the picker can't apply must not report success.
      setApplied(selectCustom(body.url))
    } catch (e) {
      // Surface transiently; the picker remains usable.
      setApplied(false)
      console.warn('[background] upload failed:', (e as Error).message)
    }
  }

  // `custom` always carries an applicable src (isBackgroundSrc gates every write
  // and every load), so a live image is exactly a custom pref.
  const prefSrc = setting.pref.kind === 'custom' ? setting.pref.src : undefined
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
        <button
          type="button"
          className={`appearance-mode-btn${isCustom ? ' active' : ''}`}
          onClick={pickCustom}
          role="radio"
          aria-checked={isCustom}
        >
          <span>Custom image</span>
        </button>
      </div>

      {isCustom && (
        <div className="appearance-bg-body">
          <label className="appearance-bg-label" htmlFor="appearance-bg-url">Image URL</label>
          <div className="appearance-bg-url-row">
            <input
              id="appearance-bg-url"
              className="appearance-bg-url"
              value={urlText}
              placeholder="https://…"
              onChange={(e) => { setUrlText(e.target.value); setApplied(false) }}
              aria-label="Image URL"
            />
            <button type="button" className="btn" onClick={applyUrl}>Use URL</button>
          </div>
          <div className="appearance-bg-upload-row">
            <label className="btn">
              Upload image…
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
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
          {prefSrc && (
            <div className="appearance-bg-current">
              <span className="appearance-bg-hint">{isBackgroundUpload(prefSrc) ? 'Uploaded image' : 'Remote image'}</span>
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
              disabled={!prefSrc}
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
              disabled={!prefSrc}
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
              disabled={!prefSrc}
              onChange={(e) => onChange({ ...setting, surface: Number(e.target.value) })}
            />
          </div>
        </>
      )}
    </div>
  )
}
