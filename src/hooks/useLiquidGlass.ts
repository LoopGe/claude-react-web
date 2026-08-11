import { useEffect, useId, useRef, useState, type RefObject } from 'react'

/* ============================================================
   useLiquidGlass — SVG-displacement-map refraction for an element
   ============================================================

   Renders a real refractive "glass lens" over whatever is behind a
   DOM element, using an edge-weighted displacement map fed into an
   SVG <feDisplacementMap> applied through `backdrop-filter`.

   Refraction concentrates at the rounded-rect bezel and fades to zero
   at the center — the signature Apple "Liquid Glass" look (clear
   center, bent edges) rather than a uniform smear.

   Browser support: SVG filters as `backdrop-filter` are a Chromium-only
   behavior (Chrome / Edge / Brave / Opera). Safari and Firefox ignore
   it, so callers fall back to a plain frosted blur when `supported`
   is false. The hook is fully inert (returns supported:false, never
   touches canvas) outside Chromium and in non-DOM/test environments. */

export interface LiquidGlassOptions {
  /** Width of the refractive bezel band, in CSS px. Larger = more
   *  lens-like (magnifier); smaller = a thin refracting rim. */
  bezel?: number
  /** Corner radius of the glass, in CSS px. Must match the element's
   *  CSS border-radius for the corners to refract correctly. */
  radius?: number
  /** feDisplacementMap scale — overall refraction strength in px. */
  strength?: number
  /** When false, the hook stays inert (used to disable the effect,
   *  e.g. under prefers-reduced-motion). Defaults to true. */
  enabled?: boolean
}

export interface LiquidGlass {
  /** True only when the running browser actually applies SVG filters
   *  as backdrop-filter (Chromium). Callers gate the refraction layer
   *  on this and otherwise render their CSS frosted fallback. */
  supported: boolean
  /** Stable per-instance filter id. Reference as `url(#<filterId>)`. */
  filterId: string
  /** Attach to the <feImage> — the hook sets its href to the freshly
   *  generated displacement map data URL on mount and on resize. */
  feImageRef: RefObject<SVGFEImageElement | null>
  /** Attach to the <feDisplacementMap> — the hook keeps its `scale`
   *  and the feImage width/height in sync with the element size. */
  feDispRef: RefObject<SVGFEDisplacementMapElement | null>
}

/* One-time capability probe. SVG-in-backdrop-filter is Chromium-only;
   Firefox reports CSS.supports('backdrop-filter','url(#x)') === true but
   does not actually render it, so we additionally require a Chromium UA. */
function detectSvgBackdropFilter(): boolean {
  if (typeof window === 'undefined' || typeof CSS === 'undefined' || !CSS.supports) {
    return false
  }
  const hasBackdrop =
    CSS.supports('backdrop-filter', 'blur(1px)') ||
    CSS.supports('-webkit-backdrop-filter', 'blur(1px)')
  if (!hasBackdrop) return false
  const ua = navigator.userAgent || ''
  // Chromium family carries "Chrome" (Edge is "Edg", but also has Chrome
  // unless very old; include "Edg" explicitly). Exclude Firefox; Safari
  // never matches "Chrome".
  const isChromium = /(Chrome|Chromium|Edg)\//.test(ua) && !/Firefox/.test(ua)
  return isChromium
}

let cachedSupport: boolean | null = null
function svgBackdropSupported(): boolean {
  if (cachedSupport === null) cachedSupport = detectSvgBackdropFilter()
  return cachedSupport
}

/* Smootherstep (Ken Perlin) — C2-continuous ramp, used for the bezel
   falloff so the refraction blends seamlessly into the clear center. */
function smootherstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)))
  return t * t * t * (t * (t * 6 - 15) + 10)
}

/* Signed distance to a rounded rectangle centered at the origin.
   Negative inside, zero on the border, positive outside. */
function roundedRectSDF(px: number, py: number, w: number, h: number, r: number): number {
  const qx = Math.abs(px) - (w / 2 - r)
  const qy = Math.abs(py) - (h / 2 - r)
  const ax = Math.max(qx, 0)
  const ay = Math.max(qy, 0)
  const outside = Math.sqrt(ax * ax + ay * ay)
  const inside = Math.min(Math.max(qx, qy), 0)
  return outside + inside - r
}

export function useLiquidGlass(
  targetRef: RefObject<HTMLElement | null>,
  opts: LiquidGlassOptions = {},
): LiquidGlass {
  const { bezel = 18, radius = 8, strength = 26, enabled = true } = opts

  // useId yields a document-unique, SSR-stable id; sanitize the colons
  // React emits (":r0:") so it's a valid SVG/url() fragment identifier.
  const rawId = useId()
  const filterId = `liquid-glass-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`

  const feImageRef = useRef<SVGFEImageElement | null>(null)
  const feDispRef = useRef<SVGFEDisplacementMapElement | null>(null)

  const [supported] = useState(svgBackdropSupported)

  useEffect(() => {
    if (!supported || !enabled) return
    const el = targetRef.current
    if (!el) return
    if (typeof ResizeObserver === 'undefined') return

    let lastW = 0
    let lastH = 0
    let raf = 0

    const build = () => {
      // Clear the pending-frame flag so a later resize can arm a new build.
      // Must happen before the early returns, or a size-unchanged no-op would
      // leave `raf` truthy and starve the next resize.
      raf = 0
      const feImage = feImageRef.current
      const feDisp = feDispRef.current
      if (!feImage || !feDisp) return

      const rect = el.getBoundingClientRect()
      const w = Math.max(2, Math.round(rect.width))
      const h = Math.max(2, Math.round(rect.height))
      if (w === lastW && h === lastH) return
      lastW = w
      lastH = h

      let canvas: HTMLCanvasElement
      try {
        canvas = document.createElement('canvas')
      } catch {
        return
      }
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) return // jsdom / unsupported — stay inert

      const img = ctx.createImageData(w, h)
      const data = img.data

      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const cx = x - w / 2
          const cy = y - h / 2

          // Distance inward from the border (>= 0 inside the shape).
          const sd = roundedRectSDF(cx, cy, w, h, radius)
          const depthFromEdge = -sd

          // Refraction lives only in the bezel band; the center is clear.
          let s = 0
          if (depthFromEdge >= 0 && depthFromEdge < bezel) {
            s = 1 - smootherstep(0, bezel, depthFromEdge)
          }

          // Outward normal = normalized gradient of the SDF.
          const e = 1
          const sdx =
            roundedRectSDF(cx + e, cy, w, h, radius) -
            roundedRectSDF(cx - e, cy, w, h, radius)
          const sdy =
            roundedRectSDF(cx, cy + e, w, h, radius) -
            roundedRectSDF(cx, cy - e, w, h, radius)
          const nlen = Math.hypot(sdx, sdy) || 1
          const nx = sdx / nlen
          const ny = sdy / nlen

          // Pull the sampled backdrop inward at the bezel (along -normal),
          // shaped by strength² for a soft, lens-like ramp.
          const mag = s * s
          const dispX = -nx * mag
          const dispY = -ny * mag

          const idx = (y * w + x) * 4
          data[idx] = Math.round(128 + dispX * 127) // R → x shift
          data[idx + 1] = Math.round(128 + dispY * 127) // G → y shift
          data[idx + 2] = 128 // B unused
          data[idx + 3] = 255 // A opaque
        }
      }

      ctx.putImageData(img, 0, 0)

      let url: string
      try {
        url = canvas.toDataURL('image/png')
      } catch {
        return
      }

      feImage.setAttribute('href', url)
      // Legacy xlink for older renderers.
      feImage.setAttribute('width', String(w))
      feImage.setAttribute('height', String(h))
      // Pin the map to the element origin. feImage without x/y defaults its
      // primitive subregion to the filter region's origin (the <filter> here
      // uses x/y=-30% to give the blur/displacement room to sample outside the
      // element), so the map would sit offset down-right and the element's
      // right/bottom ~30% would sample past the map's edge — transparent
      // black, i.e. a hard -scale/2 smear with a visible seam. The map is
      // generated at the element's exact pixel size, so 0,0 is correct.
      feImage.setAttribute('x', '0')
      feImage.setAttribute('y', '0')
      feDisp.setAttribute('scale', String(strength))
    }

    // Throttle to one rebuild per animation frame instead of a trailing
    // debounce. A debounce is starved by the footer's continuous resizes
    // while text streams in — every token flush grows the bubble, so the
    // debounce keeps resetting and never fires, leaving the displacement
    // map stuck at the pre-stream size (stale bottom bezel / seam until
    // streaming pauses). Rebuilding on the next frame keeps the map in
    // lockstep with the live size. build() reads getBoundingClientRect() at
    // frame time and no-ops when the size didn't actually change, so bursts
    // still coalesce into a single rebuild per settled frame.
    const schedule = () => {
      if (raf) return
      raf = requestAnimationFrame(build)
    }

    const ro = new ResizeObserver(schedule)
    ro.observe(el)
    // First build right away (don't wait for a resize) so the glass is
    // correct on the very first paint of the footer.
    raf = requestAnimationFrame(build)

    return () => {
      ro.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [supported, enabled, targetRef, bezel, radius, strength])

  return { supported, filterId, feImageRef, feDispRef }
}
