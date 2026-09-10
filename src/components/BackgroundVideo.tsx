// Full-viewport background video for a `custom` pref whose media is 'video'.
//
// A CSS background-image cannot play a video, so this is a real <video>
// element pinned behind the chrome (z-index: -1 — see .app-bg-video in
// tokens.css). useBackground decides *whether* one is active; this component
// only owns playback.

import { useEffect, useRef, useState } from 'react'

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia(REDUCED_MOTION_QUERY).matches
}

function isHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden
}

export function BackgroundVideo({ src }: { src: string }) {
  const ref = useRef<HTMLVideoElement>(null)
  const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion)
  // Seeded from the current state rather than only from the event: this element
  // can mount into a tab that is *already* hidden (another tab applied a
  // wallpaper over the cross-tab storage feed), and that fires no
  // visibilitychange to react to.
  const [hidden, setHidden] = useState(isHidden)

  // Honour the OS setting live — a user who turns on "reduce motion" while the
  // app is open should not have to reload to stop the wallpaper moving.
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(REDUCED_MOTION_QUERY)
    const onChange = () => setReducedMotion(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    const onVisibility = () => setHidden(document.hidden)
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  // No `autoplay` attribute: this effect is the single authority for playback,
  // and a bare element cannot start itself. The attribute would be a second
  // mechanism that agrees on mount and is ignored on every later change.
  const playing = !reducedMotion && !hidden

  // The ONE place that starts or stops playback: every reason to stop (tab
  // hidden, OS motion preference) and to resume funnels through `playing`, so
  // no path can leave the element running against the component's intent.
  // Dropping the autoplay attribute alone does not stop an element that is
  // already playing, which is why this cannot be attribute-driven.
  useEffect(() => {
    const video = ref.current
    if (!video) return
    if (playing) void video.play().catch(() => {})
    else video.pause()
  }, [playing, src])

  // Under reduce-motion the element never plays, and a video that was never
  // played can stay fully transparent. Seeking forces the decoder to produce a
  // frame, which is what turns "paused" into a usable still wallpaper.
  useEffect(() => {
    const video = ref.current
    if (!video || !reducedMotion) return
    const showFirstFrame = () => { video.currentTime = 0.001 }
    // Metadata may already be in by the time the setting flips.
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      showFirstFrame()
      return
    }
    video.addEventListener('loadedmetadata', showFirstFrame, { once: true })
    return () => video.removeEventListener('loadedmetadata', showFirstFrame)
  }, [reducedMotion, src])

  return (
    <video
      ref={ref}
      className="app-bg-video"
      src={src}
      loop
      muted
      playsInline
      preload="auto"
      // A wallpaper that cannot decode leaves the chrome translucent over an
      // empty backdrop (useBackground has already cleared the image slot), so
      // at minimum say why in the console instead of failing invisibly.
      onError={() => console.warn(`[background] video failed to load: ${src}`)}
      aria-hidden="true"
      tabIndex={-1}
    />
  )
}
