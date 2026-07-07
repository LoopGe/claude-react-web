// Shared clipboard-write hook with a 2s "copied" feedback flag.
//
// Extracted from CopyButton so non-button affordances — a click-to-copy
// file-path title (FilePathTitle), a copy-on-click chip (CopyablePathChip) —
// can reuse the exact same navigator.clipboard + legacy execCommand fallback
// + 2s feedback semantics without duplicating the logic at each call site.

import { useCallback, useEffect, useRef, useState } from 'react'

/** Writes `text` to the clipboard, falling back to a hidden textarea +
 *  execCommand when navigator.clipboard is unavailable (Safari without HTTPS,
 *  or browsers blocking clipboard inside an iframe). Calls `onSuccess` once
 *  the write is confirmed. Silently fails (no throw) as a last resort. */
function legacyCopy(text: string, onSuccess: () => void) {
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.cssText = 'position:fixed;opacity:0;left:-9999px'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
    onSuccess()
  } catch {
    // Last resort — silent failure.
  }
}

/** Copy-to-clipboard hook. `copy(getValue)` reads the value lazily (so large
 *  bodies aren't serialised until click), writes it, and flips `copied` to
 *  true for 2s so the caller can show a transient "Copied!" affordance.
 *
 *  Returns `{ copied, copy }`. `copied` is a boolean; `copy` takes a getter
 *  (matching CopyButton's `getValue` contract) so the string is only built
 *  on the click that needs it. */
export function useCopy(): {
  copied: boolean
  copy: (getValue: () => string) => void
} {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  // Clear any in-flight "Copied!" timer on unmount so a post-unmount
  // setState (silently swallowed by React in dev mode but still a leak)
  // can't fire.
  useEffect(() => () => {
    if (timerRef.current != null) clearTimeout(timerRef.current)
  }, [])

  const copy = useCallback((getValue: () => string) => {
    const value = getValue()
    if (!value) return
    const onSuccess = () => {
      setCopied(true)
      if (timerRef.current != null) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setCopied(false), 2000)
    }
    // Guard on `writeText` being a function, not just `clipboard` existing —
    // some locked-down webviews define `navigator.clipboard` but omit
    // `writeText`, in which case calling it would throw synchronously and
    // bypass the legacyCopy fallback entirely.
    const writeText = navigator.clipboard?.writeText
    if (typeof writeText === 'function') {
      writeText
        .call(navigator.clipboard, value)
        .then(onSuccess, () => {
          // Fallback: hidden textarea + execCommand (Safari without HTTPS,
          // or browsers blocking clipboard inside an iframe).
          legacyCopy(value, onSuccess)
        })
    } else {
      legacyCopy(value, onSuccess)
    }
  }, [])

  return { copied, copy }
}
