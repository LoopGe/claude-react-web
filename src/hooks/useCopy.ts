// Shared clipboard layer — the single owner of every clipboard WRITE in the app.
//
// `writeClipboard` is the only function that writes to the clipboard, and
// `useCopy` is the only stateful primitive on top of it. Every copy affordance
// routes through them — tool-card buttons, click-to-copy path titles
// (FilePathTitle / CopyablePathChip), markdown code blocks, dialog buttons,
// context-menu items, the crash screen, and (via `allowFallback: false`) the
// composer's Cut.
//
// What is shared is the MECHANISM: the lazy value read, the legacy fallback,
// the 2s reset, and the failure signal. The DISPLAY stays with each call site —
// an icon swap in a tool card, a tinted chip on a path, a label swap in a code
// block — and so does the failure WORDING, because each surface knows its own
// affordance.
//
// Two entry points, picked by whether the site renders feedback:
//   - `useCopy` — the affordance renders `copied` (icon/label/class flip).
//   - `writeClipboard` — fire-and-forget: a context-menu item, or anything
//     with no element left on screen to flip. Those sites own their wording
//     and call the toast themselves; a `copied` flag nothing reads is pure
//     cost (two renders and a live timer per copy).
//
// Clipboard READS are a separate concern and stay with their callers
// (Composer.handlePaste's `readText`, RichPromptInput's `insertText`).

import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { ToastShowContext } from './toastContext'

/** How long `copied` stays true after a successful write. */
const COPIED_MS = 2000

/** Default failure wording for the surfaces that have no home for a manual
 *  fallback (a collapsed tool card, a code block the user never expanded, a
 *  context menu that has already closed) — so it must not tell the user to
 *  select text that is no longer on screen. Exported for the plain-function
 *  callers that report the failure themselves. */
export const COPY_FAILED_MESSAGE = 'Copy failed — the browser blocked clipboard access.'

/** Hidden-textarea + `execCommand` fallback, for origins where
 *  `navigator.clipboard` is unavailable — Safari without HTTPS, an iframe
 *  without `clipboard-write`, or this app's own LAN-HTTP mode, where it is the
 *  only branch that ever runs. */
function legacyCopy(text: string): boolean {
  // `ta.select()` moves the document selection AND focus into the throwaway
  // textarea, so borrow both and give them back. Without this a plain copy
  // wipes the user's own highlight — which is visible, and which the
  // transcript's plugin menu uses to anchor its popover to the live selection
  // rect at click time. Focus matters most in the Composer, whose rich editor
  // owns a caret that would otherwise be pulled out from under the user on the
  // one origin where this branch always runs.
  const selection = document.getSelection()
  const saved: Range[] = []
  if (selection) {
    for (let i = 0; i < selection.rangeCount; i++) saved.push(selection.getRangeAt(i).cloneRange())
  }
  const focused = document.activeElement

  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.cssText = 'position:fixed;opacity:0;left:-9999px'
  document.body.appendChild(ta)
  try {
    ta.select()
    // `execCommand` reports that the command ran, which is the best signal this
    // path offers. It is NOT verification that the text reached the clipboard,
    // so a caller that would DESTROY data on success must not rely on it — see
    // `allowFallback`.
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    // `finally` so a throwing execCommand can't leak the node into the DOM.
    ta.remove()
    // Restoring is best-effort and must not itself throw: `addRange` raises
    // WrongDocumentError when the saved range's root has been detached since,
    // and a throw out of `finally` would escape this function as a rejection.
    // The two restores are separate so a failing range can't also cost the
    // user their focus.
    if (selection) {
      try {
        selection.removeAllRanges()
        for (const range of saved) selection.addRange(range)
      } catch {
        // Leaving the selection where it landed is acceptable; the copy result
        // is what this function exists to produce.
      }
    }
    try {
      if (focused instanceof HTMLElement && focused.isConnected && document.activeElement !== focused) {
        focused.focus({ preventScroll: true })
      }
    } catch {
      // Same: a focus() that refuses is not worth failing the copy over.
    }
  }
}

export interface WriteClipboardOptions {
  /** Allow the hidden-textarea + `execCommand` fallback when
   *  `navigator.clipboard` is unavailable. Pass `false` when a `true` result
   *  would DESTROY something — Composer's Cut deletes the selection — because
   *  the fallback cannot verify the write, whereas a resolving `writeText`
   *  promise can. Keeping that decision here rather than at the call site is
   *  what stops a future "consistency" fix from routing the destructive path
   *  back through the fallback. */
  allowFallback?: boolean
}

/** Writes `text` to the clipboard and reports whether the write is believed to
 *  have succeeded. The only place in the app that writes to the clipboard.
 *
 *  Resolves `false` rather than rejecting, whatever goes wrong, so callers
 *  branch on the result instead of wrapping every call in try/catch — a
 *  rejection here reaches the app's `unhandledrejection` listener, which
 *  records it as a crash.
 *
 *  TRADE-OFF worth knowing before editing: on the fallback path this "success"
 *  rests on `execCommand`'s boolean, which cannot prove the text landed — the
 *  only real verification is a resolving `writeText` promise. Reporting `false`
 *  there instead would be worse: on the origins where the fallback is the only
 *  branch that runs (this app's LAN-HTTP mode), every copy would announce
 *  failure while usually working. So the fallback's `true` is reported as
 *  success, and the single caller that would DESTROY data on it — Composer's
 *  Cut — opts out with `allowFallback: false`. */
export async function writeClipboard(
  text: string,
  opts?: WriteClipboardOptions,
): Promise<boolean> {
  const allowFallback = opts?.allowFallback ?? true
  try {
    // Hold the object as well as the method: `writeText.call(navigator.clipboard, …)`
    // re-reads the property, and a sandboxed webview whose `clipboard` getter
    // returns a fresh wrapper would then call the method with the wrong
    // receiver. The READ is inside the try because such a getter can also throw.
    const clipboard = navigator.clipboard
    const writeText = clipboard?.writeText
    if (typeof writeText === 'function') {
      await writeText.call(clipboard, text)
      return true
    }
  } catch (err) {
    // Keep the cause: without it a "copy is broken" report has nothing to work
    // from, and the DOMException name (NotAllowedError vs SecurityError vs the
    // API being absent) is the whole diagnosis.
    console.warn('[clipboard] writeText failed:', err)
  }
  if (!allowFallback) return false
  try {
    const ok = legacyCopy(text)
    // The fallback's refusal is worth a line too — otherwise the only failure
    // with no trail at all is the one on the origin where the fallback is the
    // only branch that runs.
    if (!ok) console.warn('[clipboard] legacy execCommand refused the copy')
    return ok
  } catch (err) {
    // `legacyCopy` guards its own cleanup, but DOM access can still surprise.
    // The contract is that this function reports, never throws.
    console.warn('[clipboard] legacy fallback failed:', err)
    return false
  }
}

/** Copy-to-clipboard hook — for the affordances that RENDER the feedback.
 *
 *  `copy(getValue)` reads the value lazily (so large bodies aren't serialised
 *  until click), writes it, and flips `copied` to true for 2s so the caller can
 *  show a transient "Copied!" affordance. Resolves `true`/`false` so a caller
 *  that owns its own feedback can branch on the outcome.
 *
 *  A failed write toasts by default. Swallowing it is how the user ends up
 *  pasting stale clipboard content believing the copy had worked.
 *
 *  Affordances that fire and forget — a context-menu item, anything with no
 *  element left on screen to flip — should call `writeClipboard` directly
 *  instead: state, a 2s timer and a re-entrancy guard for a flag nobody reads
 *  is pure cost, and those surfaces already own their own success wording. */
export function useCopy(): {
  copied: boolean
  copy: (getValue: () => string) => Promise<boolean>
} {
  // Read the push-only context DIRECTLY, not through `useToast`: that module is
  // partially stubbed by several test suites (TasksPanel, ToolsTab,
  // UploadsManagerDialog, useSessionNotifications, UpdateDialog), so importing
  // from it would make every copy affordance in their render trees fail with
  // "No useToastShow export is defined on the mock". Reading the context also
  // keeps this null-tolerant, which `useToast` deliberately is not — there may
  // be no provider at all (RootErrorBoundary renders above ToastProvider), and
  // "nowhere to report" is not an error. The rationale lives on the context
  // itself; see ToastShowContext.
  const showToast = useContext(ToastShowContext)
  // A token rather than a boolean: a plain `setCopied(true)` while it is
  // already true is a React bail-out, so the effect below would never re-run
  // and a second copy inside the first one's window would inherit its
  // deadline. Bumping a token changes the dependency every time, which
  // re-arms the full 2s on each success. 0 = not showing.
  const [copiedToken, setCopiedToken] = useState(0)
  // Copies are re-entrant and resolve in whatever order the clipboard does.
  // Only the newest one on this affordance may touch the flag or raise a toast,
  // so a slow failure can't clobber a newer success.
  const seqRef = useRef(0)

  // The whole 2s window lives in one effect rather than a hand-managed timer:
  // arming, re-arming and clearing become a single mechanism, and React runs
  // the cleanup on unmount for free.
  useEffect(() => {
    if (!copiedToken) return
    const timer = setTimeout(() => setCopiedToken(0), COPIED_MS)
    return () => clearTimeout(timer)
  }, [copiedToken])

  const copy = useCallback(
    async (getValue: () => string) => {
      /** Every failure path lands here, so none of them can forget to drop a
       *  "Copied!" left lit by an earlier success — leaving it up keeps
       *  claiming the clipboard holds this value while it holds the previous
       *  one, which is the stale-success lie this layer exists to prevent. */
      const fail = () => {
        setCopiedToken(0)
        showToast?.('error', COPY_FAILED_MESSAGE)
        return false
      }

      let value: string
      try {
        value = getValue()
      } catch (err) {
        // A throwing getter (a serialisation that blows up on a cyclic value,
        // say) is a real failure, not an empty value. Left uncaught it rejects,
        // and this app's error-capture layer records rejections as crashes —
        // overwriting the very report the user was trying to copy.
        console.warn('[clipboard] value getter threw:', err)
        return fail()
      }
      // Nothing to copy is a caller bug, not a clipboard failure — stay quiet
      // so an empty selection doesn't produce a spurious error toast. Checked
      // BEFORE taking a sequence number: a no-op must not supersede a real copy
      // that is still in flight, or that copy's result would be discarded while
      // its text did reach the clipboard.
      if (!value) return false

      const seq = ++seqRef.current
      const ok = await writeClipboard(value)
      // A newer copy on this affordance owns the flag and the toast now.
      if (seq !== seqRef.current) return ok

      if (!ok) return fail()

      setCopiedToken((token) => token + 1)
      return true
    },
    [showToast],
  )

  return { copied: copiedToken !== 0, copy }
}