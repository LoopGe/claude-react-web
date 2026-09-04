// Background section body for the Appearance popover (default/glow skins).
// Lets the user pick None or a Custom image — via a remote http(s) URL or a
// local file uploaded to /api/background — and adjust the frosted opacity.

import { useState } from 'react'
import {
  BACKGROUND_OPACITY_MIN,
  BACKGROUND_OPACITY_MAX,
  type BackgroundPref,
  type BackgroundSetting,
} from '../theme'

interface Props {
  setting: BackgroundSetting
  onChange: (next: BackgroundSetting) => void
}

function isUploadedUrl(src: string): boolean {
  return src.startsWith('/api/background/files/')
}

export function BackgroundPicker({ setting, onChange }: Props) {
  // Internal mode state so the UI responds immediately to clicks even when
  // the parent hasn't re-rendered with the new setting prop yet.
  const [mode, setMode] = useState<'none' | 'custom'>(setting.pref.kind === 'custom' ? 'custom' : 'none')
  // Sync mode when setting changes externally (reset-to-defaults, preset load,
  // fork/resume) so the toggle never goes stale. React's "adjust state during
  // render" pattern instead of an effect, which would trigger cascading renders.
  const [prevKind, setPrevKind] = useState(setting.pref.kind)
  if (prevKind !== setting.pref.kind) {
    setPrevKind(setting.pref.kind)
    setMode(setting.pref.kind === 'custom' ? 'custom' : 'none')
  }
  const isCustom = mode === 'custom'
  const [urlText, setUrlText] = useState(isCustom && setting.pref.kind === 'custom' ? setting.pref.src : '')
  const [applied, setApplied] = useState(false)

  const selectCustom = (src: string) => onChange({ ...setting, pref: { kind: 'custom', src } })

  const applyUrl = () => {
    const trimmed = urlText.trim()
    if (!/^https?:\/\/.+/i.test(trimmed)) return
    setApplied(true)
    selectCustom(trimmed)
  }

  const deleteIfUploaded = (src: string) => {
    if (isUploadedUrl(src)) {
      fetch(src, { method: 'DELETE' }).catch(() => {})
    }
  }

  const handleUpload = async (file: File) => {
    const form = new FormData()
    form.append('file', file, file.name)
    try {
      const res = await fetch('/api/background/upload', { method: 'POST', body: form })
      const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string }
      if (!res.ok || !body.url) throw new Error(body.error || `upload failed (HTTP ${res.status})`)
      if (setting.pref.kind === 'custom') deleteIfUploaded(setting.pref.src)
      setApplied(true)
      selectCustom(body.url)
    } catch (e) {
      // Surface transiently; the picker remains usable.
      setApplied(false)
      console.warn('[background] upload failed:', (e as Error).message)
    }
  }

  const clear = () => {
    if (setting.pref.kind === 'custom') deleteIfUploaded(setting.pref.src)
    setApplied(false)
    setMode('none')
    onChange({ pref: { kind: 'none' }, opacity: setting.opacity })
  }

  const pref: BackgroundPref = isCustom ? setting.pref : { kind: 'none' as const }
  const prefSrc = pref.kind === 'custom' ? pref.src : undefined

  return (
    <div className="appearance-bg">
      <div className="appearance-mode-row" role="radiogroup" aria-label="Background">
        <button
          type="button"
          className={`appearance-mode-btn${!isCustom ? ' active' : ''}`}
          onClick={() => { setMode('none'); setApplied(false); onChange({ ...setting, pref: { kind: 'none' } }) }}
          role="radio"
          aria-checked={!isCustom}
        >
          <span>None</span>
        </button>
        <button
          type="button"
          className={`appearance-mode-btn${isCustom ? ' active' : ''}`}
          onClick={() => { if (!isCustom) { setMode('custom'); setUrlText(''); onChange({ ...setting, pref: { kind: 'custom', src: '' } }) } }}
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
          {pref.kind === 'custom' && pref.src && (
            <div className="appearance-bg-current">
              <span className="appearance-bg-hint">{isUploadedUrl(pref.src) ? 'Uploaded image' : 'Remote image'}</span>
            </div>
          )}
        </div>
      )}

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
          step={0.05}
          value={setting.opacity}
          disabled={!isCustom || !prefSrc}
          onChange={(e) => onChange({ ...setting, opacity: Number(e.target.value) })}
        />
      </div>

      {isCustom && prefSrc && (
        <button type="button" className="appearance-bg-clear" onClick={clear}>Clear</button>
      )}
    </div>
  )
}
