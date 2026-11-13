// The OS-glyph renderer for the two system open-path targets (Finder /
// Terminal): the server extracts the REAL OS icon (see
// server/open-path-icons.ts) and this component serves it as an <img> —
// something a static SVG cannot fake, since the smiley IS the identity of
// the OS application. When the extraction does not exist on this
// machine/client pairing (404), the route is gated away (403), or transport
// fails, the caller's generic glyph renders instead — the documented
// protocol fallback, not a degraded state.
//
// The <img> uses the REST base (`/api`) directly rather than the transport:
// images cannot ride the IPC transport the desktop host provides, and every
// surface that renders this component loads the UI from the server origin.

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { OpenPathGlyphTarget } from '../../../shared/open-path'

export function OpenPathIcon({
  target,
  size = 14,
  fallback,
}: {
  target: OpenPathGlyphTarget
  size?: number
  fallback: ReactNode
}) {
  // Latched: one failed load swaps permanently for the component's lifetime
  // (the icon cannot come back mid-session — the answer is per-process).
  const [failed, setFailed] = useState(false)
  if (failed) return <>{fallback}</>
  return (
    <img
      src={`/api/open-path/icons/${target}`}
      width={size}
      height={size}
      alt=""
      aria-hidden
      onError={() => setFailed(true)}
    />
  )
}
