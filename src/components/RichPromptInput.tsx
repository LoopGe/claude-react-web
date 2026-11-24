import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { joinTokens, tokenize } from '../utils/pastedText'
import { renderTokens, serializeTokens, domRepresentsValue, mentionChipFacts, MENTION_CHIP_ATTR, QUOTE_CHIP_ATTR, QUOTE_REMOVE_ATTR } from '../utils/richPromptDom'
import { syncEditorHeight } from '../utils/editor-height'
import { offsetOf, slashWordBefore, atWordBefore, caretOnFirstLine, placeCaretAtOffset } from './richPromptCaret'
import { isSupportedImageMediaType } from '../../shared/image-media'
import { selectionOffsets, placeCaretIn, selectAll } from './richPromptApi'

/**
 * Methods attached to the editor DOM element by RichPromptInput.
 *
 * Reach them via `editorRef.current` -- the ref points to the editor `<div>`,
 * which also carries these methods.  Callers must treat the ref as a
 * `RichPromptHandle`, not a plain DOM node.
 *
 * Lifecycle note: the methods are monkey-patched in a `useLayoutEffect`
 * (deps: `[value, ref, onChange]`), so they are always attached
 * synchronously after the element enters the DOM and before the browser
 * paints.  When React replaces the element (Suspense boundary, key
 * change) there is a synchronous window between `ref.current` being set
 * and the effect running where the methods are absent.  This window is
 * not reachable by async event listeners (wheel, keydown) because those
 * are dispatched from the event loop, not during React's commit phase.
 * Callers that use optional chaining (`handle?.isComposing?.()`) are
 * safe; the methods will be present before any user event fires.
 */
export interface RichPromptHandle {
  getSlashWordAtCaret(): string | null
  caretOnFirstLine(): boolean
  replaceSlashWord(text: string): void
  /** Splice the forming `@word` before the caret with `text` (a picked mention
   *  or an open-quote drill string), leaving the caret at the replacement's end. */
  replaceAtWord(text: string): void
  /** Offset pair for the current selection, or null when nothing is selected. */
  selectionOffsets(): { start: number; end: number } | null
  /** Focus the element and place a collapsed caret at the given character offset. */
  placeCaretIn(offset: number): void
  /** Select the whole editor. */
  selectAll(): void
  /** True while an IME composition is in flight. */
  isComposing(): boolean
}

interface Props {
  value: string
  onChange: (v: string) => void
  ariaLabel: string
  placeholder?: string
  disabled?: boolean
  className?: string
  /** Forwarded ref to the editor element (later tasks need it for ranges). */
  editorRef?: RefObject<HTMLDivElement | null>
  /** Enter, no modifier, not composing. */
  onSubmit?: () => void
  /** Shift+Enter or Ctrl/Cmd+Enter. */
  onNewline?: () => void
  /** Called with a raw paste; returns WHAT to insert. A string is inserted
   *  (usually the raw clipboard text, or a `[Pasted text #N]` reference for a
   *  collapsed paste); `null` means insert nothing.
   *
   *  The callback answers with the text rather than placing it, because the
   *  editor has to perform the insert: that is what puts it on the browser's
   *  undo stack. A caller that spliced its own state instead would make every
   *  paste un-undoable. */
  onPasteText?: (raw: string) => string | null
  /** Image handler — supported `image/*` clipboard items are collected and
   *  handed over as ONE batch (each entry is the `getAsFile()` result). The
   *  editor never accepts image bytes itself; the parent attaches them as
   *  preview chips. A single paste can carry BOTH images and a text/plain body
   *  (e.g. copying a selection from a rich editor), so images are collected
   *  before the text path runs and neither path bails the other. */
  onPasteImages?: (files: readonly File[]) => void
  /** Non-image file items on the clipboard (PDF, archive, unsupported raster
   *  image…). SVG is ignored: copying ordinary content often carries an
   *  incidental image/svg+xml item. */
  onPasteFiles?: (files: readonly File[]) => void
  /** Right-click context menu handler. */
  onContextMenu?: (e: React.MouseEvent<HTMLElement>) => void
  /** Click on a settled @file/@folder mention chip, with its decoded path and
   *  directory flag. The editor delegates chip clicks from its root (the chip
   *  DOM is rebuilt on reconcile, so per-chip listeners would not survive);
   *  the host resolves the path against the session cwd and opens the preview.
   *  Unwired hosts keep chips inert. */
  onMentionClick?: (mention: { path: string; dir: boolean }) => void
  /** Additional keydown handler for keys the editor does not handle itself
   *  (Enter is already handled; everything else falls through here). */
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void
}

/**
 * Contenteditable prompt field whose canonical value is a plain string.
 *
 * A `<textarea>` cannot style a substring, so `[Pasted text #N]` references
 * read as ordinary typed text. Here they are real elements -- which also makes
 * the caret and Backspace treat a reference as one unit natively, instead of
 * the character-offset bookkeeping `usePastedTextEditing` had to do.
 *
 * The DOM is never the source of truth: every change is serialized back to a
 * string, so `value`/`onChange` match what the textarea took.
 *
 * Paste: `handlePaste` always calls `e.preventDefault()`, which is the
 * load-bearing defence against arbitrary clipboard HTML (an `<img onerror>`,
 * say) entering the editor — without it the browser accepts `text/html` and
 * our serializer would flatten it into text we never intended.
 *
 * The text is then placed with `execCommand('insertText')`, which carries no
 * markup AND lands on the browser's undo stack, so Ctrl+Z still steps back
 * over a paste. Rebuilding the DOM from React state instead would be
 * invisible to that stack, which is why a paste used to be un-undoable.
 */
export function RichPromptInput({
  value,
  onChange,
  ariaLabel,
  placeholder,
  disabled,
  className,
  editorRef,
  onSubmit,
  onNewline,
  onPasteText,
  onPasteImages,
  onPasteFiles,
  onContextMenu,
  onMentionClick,
  onKeyDown: onKeyDownProp,
}: Props) {
  const localRef = useRef<HTMLDivElement>(null)
  const ref = editorRef ?? localRef
  // Set while an IME composition is in flight. Re-rendering the DOM from
  // `value` mid-composition moves the caret and can drop the candidate.
  const composingRef = useRef(false)

  // ------------------------------------------------------------------
  // Caret queries -- bridge the pure helpers to the live DOM selection.
  // ------------------------------------------------------------------

  /** Character offset of the caret within the serialized value. */
  const caretOffset = (): number | null => {
    const el = ref.current
    const selection = el?.ownerDocument.getSelection()
    if (!el || !selection || selection.rangeCount === 0) return null
    const range = selection.getRangeAt(0)
    if (!el.contains(range.startContainer)) return null
    return offsetOf(el, range.startContainer, range.startOffset)
  }

  /** The `/word` immediately before the caret, or null. */
  const getSlashWordAtCaret = (): string | null => {
    const off = caretOffset()
    if (off === null) return null
    return slashWordBefore(value, off)
  }

  /** True when the caret sits on the first line (for history). */
  const isCaretOnFirstLine = (): boolean => {
    const off = caretOffset()
    if (off === null) return true
    return caretOnFirstLine(value, off)
  }

  /** Replace the `/word` before the caret with `text`, restoring caret at
   *  the end of the replacement. */
  const replaceSlashWord = (text: string) => {
    const off = caretOffset()
    if (off === null) return
    const word = slashWordBefore(value, off)
    if (word === null) return
    const start = off - word.length
    const next = value.slice(0, start) + text + value.slice(off)
    onChange(next)
    // Restore caret to end of replacement in the next frame.
    requestAnimationFrame(() => {
      const el = ref.current
      if (!el) return
      placeCaretAtOffset(el, start + text.length)
    })
  }

  /** Replace the forming `@word` before the caret with `text`, leaving the caret
   *  at the end of the replacement.
   *
   *  Unlike {@link replaceSlashWord}, this rebuilds the DOM and places the caret
   *  BEFORE reporting the new value. A mention chip settles only when the caret
   *  is past its end (the caret gate is end-inclusive), so the value-driven
   *  reconcile must measure the RESTORED caret — not the stale pre-splice one.
   *  Reporting first and restoring the caret a frame later (the slash pattern,
   *  harmless there because commands are not chips) would reconcile against the
   *  old caret and demote the picked chip back to editable text. Placing the
   *  caret up front also means the parent's onChange scans the correct caret, so
   *  a folder drill derives its new `@dir/` query without a second pass. */
  const replaceAtWord = (text: string) => {
    const el = ref.current
    const off = caretOffset()
    if (!el || off === null) return
    const at = atWordBefore(value, off)
    if (at === null) return
    const next = value.slice(0, at.start) + text + value.slice(off)
    const target = at.start + text.length
    const doc = el.ownerDocument
    el.replaceChildren(renderTokens(doc, tokenize(next), target))
    placeCaretAtOffset(el, target)
    onChange(next)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Give the parent first crack at every key (picker Enter, Tab, arrows…).
    onKeyDownProp?.(e)
    if (e.defaultPrevented) return
    if (e.key !== 'Enter') return
    // A composition in flight owns Enter — it is confirming a candidate.
    if (e.nativeEvent.isComposing) return
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      e.preventDefault()
      onNewline?.()
      return
    }
    e.preventDefault()
    onSubmit?.()
  }

  const insertPlainTextAtCaret = (text: string) => {
    const el = ref.current
    if (!el) return
    const doc = el.ownerDocument
    // Prefer the native command. It inserts PLAIN TEXT — so the HTML defence
    // that motivates preventDefault is untouched — and, unlike a manual DOM
    // insert, it lands on the browser's undo stack. Rebuilding the DOM from
    // React state (the other way to place text here) is invisible to that
    // stack, which is why every paste used to be un-undoable.
    let inserted = false
    try {
      inserted = doc.execCommand?.('insertText', false, text) ?? false
    } catch {
      // jsdom has no editing implementation; fall through to the manual path.
      inserted = false
    }
    if (!inserted) {
      const selection = doc.getSelection()
      const range =
        selection && selection.rangeCount > 0 && el.contains(selection.anchorNode)
          ? selection.getRangeAt(0)
          : null
      const node = doc.createTextNode(text)
      if (range) {
        range.deleteContents()
        range.insertNode(node)
        range.setStartAfter(node)
        range.collapse(true)
        selection!.removeAllRanges()
        selection!.addRange(range)
      } else {
        el.appendChild(node)
      }
      // Only the manual path reports: it is a direct DOM mutation, so nothing
      // else will. The native path above already fired an `input` event, which
      // `onInput` forwards — reporting again would run the parent's onChange
      // (history reset, slash-command scan) twice per paste.
      onChange(joinTokens(serializeTokens(el)))
    }
  }

  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    // Take the paste over unconditionally. Left to itself a contenteditable
    // accepts text/html, which would put arbitrary markup (an <img onerror>,
    // say) inside the editor — and our serializer would then flatten it into
    // text we never intended to accept.
    //
    // The insert below goes through execCommand('insertText'), which carries
    // no markup AND lands on the browser's undo stack, so Ctrl+Z still steps
    // back over a paste.
    e.preventDefault()
    // Collect image items first — a clipboard can carry BOTH an image and a
    // text/plain body, and bailing here would let the text body through
    // uncollapsed. The editor never holds image bytes; the parent attaches
    // them as preview chips, the same collection the textarea path did.
    const items = e.clipboardData?.items
    if (items) {
      const images: File[] = []
      const files: File[] = []
      for (const item of items) {
        if (item.type === 'image/svg+xml') continue
        if (isSupportedImageMediaType(item.type)) {
          const image = item.getAsFile()
          if (image) images.push(image)
        } else if (item.kind === 'file') {
          const file = item.getAsFile()
          if (file) files.push(file)
        }
      }
      if (images.length > 0) onPasteImages?.(images)
      if (files.length > 0) onPasteFiles?.(files)
    }
    const raw = e.clipboardData?.getData('text/plain') ?? ''
    if (!raw) return
    // The collapse policy gets first refusal so it stays the single owner of
    // the threshold and normalization.
    //
    // The callback returns WHAT to insert rather than placing it itself: the
    // editor has to perform the insert for it to land on the browser's undo
    // stack, and a caller that spliced its own state instead would make every
    // paste invisible to Ctrl+Z.
    if (onPasteText) {
      const toInsert = onPasteText(raw)
      if (toInsert === null) return
      insertPlainTextAtCaret(toInsert)
      return
    }
    insertPlainTextAtCaret(raw)
  }

  // Reconcile the DOM with `value`, but only when the DOM does not already
  // REPRESENT it. On the typing path it does, so this is a no-op and the caret
  // is left alone.
  //
  // The check is structural rather than a string comparison. A
  // `[Pasted text #N]` reference inserted as literal text serializes back to
  // exactly `value`, so comparing strings would report "already in sync" and
  // skip the rebuild — leaving the reference as plain text with no chip, which
  // loses the atomic Backspace and makes a partial delete unexpandable on send.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (composingRef.current) return
    // Measure the caret BEFORE the check: a mention spanning it must stay
    // editable text (the forming `@query`), so both the equality check and the
    // rebuild render with the same caret gate. No caret (unfocused / draft
    // restore) → every mention is settled and chipifies.
    const doc = el.ownerDocument
    const selection = doc.getSelection()
    const hadCaret =
      selection !== null && selection.rangeCount > 0 && el.contains(selection.anchorNode)
    const caret = hadCaret
      ? offsetOf(el, selection!.anchorNode!, selection!.anchorOffset)
      : null
    const tokens = tokenize(value)
    if (domRepresentsValue(el, tokens, caret ?? undefined)) return
    // Rebuilding detaches the node the caret sits in, and a detached selection
    // collapses to the start of the editor — so the next keystroke would be
    // written in front of the whole draft. Put the caret back once the new DOM
    // exists.
    el.replaceChildren(renderTokens(doc, tokens, caret ?? undefined))
    // On an empty rebuild there are no segments for the caret to sit in, so
    // placeCaretAtOffset reports failure without placing anything — collapse
    // explicitly rather than trusting every engine to drop a detached
    // selection at the editor start.
    if (caret !== null && !placeCaretAtOffset(el, caret)) selection!.collapse(el, 0)
  }, [value, ref])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    syncEditorHeight(el)
  }, [value, ref])

  // The height is an explicit px (see syncEditorHeight), so nothing re-measures
  // it when the box re-wraps for a reason other than typing — dragging the
  // panel divider, opening a second panel, a window resize. Without this the
  // box keeps a stale height and `.rich-prompt { overflow: hidden }` clips the
  // extra lines with no scrollbar and no way to reach them. Width only:
  // reacting to height would feed the write above straight back into the
  // observer.
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let lastWidth = el.clientWidth
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === lastWidth) return
      lastWidth = el.clientWidth
      syncEditorHeight(el)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])

  /**
   * Drop caret-host residue the browser keeps behind emptied content — a
   * lone `<br>` at the root, or nested in the block container it materialised
   * for a newline. All such shapes serialize to '', so this keeps the DOM
   * matching the value it just reported.
   *
   * Runs on the event path, not only in the reconcile effect, because when
   * the residue appears while `value` is ALREADY '' the parent's re-render
   * is a no-op and the effect never runs. Skipped mid-composition so an IME
   * candidate is never disturbed.
   */
  const dropEmptyResidue = useCallback((el: HTMLDivElement) => {
    if (composingRef.current) return
    if (serializeTokens(el).length > 0) return
    if (el.childNodes.length === 0) return
    const doc = el.ownerDocument
    const sel = doc.getSelection()
    const hadCaret = sel !== null && sel.rangeCount > 0 && el.contains(sel.anchorNode)
    el.replaceChildren()
    // The caret sat in the removed node; re-anchor it deterministically.
    if (hadCaret) sel.collapse(el, 0)
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onCompositionStart = () => {
      composingRef.current = true
    }
    const onCompositionEnd = () => {
      composingRef.current = false
      dropEmptyResidue(el)
      onChange(joinTokens(serializeTokens(el)))
    }
    // Some IMEs never fire compositionend on cancel (Escape / click-away).
    // Focus loss must reset the guard so wheel history and other features
    // that check isComposing don't get stuck.
    const onBlur = () => { composingRef.current = false }
    el.addEventListener('compositionstart', onCompositionStart)
    el.addEventListener('compositionend', onCompositionEnd)
    el.addEventListener('blur', onBlur)
    return () => {
      el.removeEventListener('compositionstart', onCompositionStart)
      el.removeEventListener('compositionend', onCompositionEnd)
      el.removeEventListener('blur', onBlur)
    }
  }, [onChange, ref, dropEmptyResidue])

  // Attach caret-query methods directly to the DOM element so callers holding
  // editorRef can use them (e.g. `ref.current.getSlashWordAtCaret()`).
  // The closures close over value, ref, and onChange -- all present in deps.
  /* eslint-disable react-hooks/exhaustive-deps */
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const handle = el as unknown as RichPromptHandle
    handle.getSlashWordAtCaret = getSlashWordAtCaret
    handle.caretOnFirstLine = isCaretOnFirstLine
    handle.replaceSlashWord = replaceSlashWord
    handle.replaceAtWord = replaceAtWord
    handle.selectionOffsets = () => selectionOffsets(el)
    handle.placeCaretIn = (offset: number) => placeCaretIn(el, offset)
    handle.selectAll = () => selectAll(el)
    handle.isComposing = () => composingRef.current
  }, [value, ref, onChange])
  /* eslint-enable react-hooks/exhaustive-deps */

  return (
    <div
      ref={ref}
      role="textbox"
      aria-multiline="true"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      contentEditable={!disabled}
      suppressContentEditableWarning
      spellCheck={false}
      data-placeholder={placeholder ?? ''}
      // Marks the editor as mention-click-wired so the chip's pointer/hover
      // affordance only shows where a click actually opens a preview.
      data-mention-click={onMentionClick ? '' : undefined}
      className={className}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      onContextMenu={onContextMenu}
      onClick={(e) => {
        const target = e.target as Element
        // Whole-run removal: the composer quote chip's × button. The chip is
        // atomic, so removal splices the EXACT run out of the value (located by
        // its serialized offset, not by string search — identical runs must not
        // be confused) and restores the caret where the run began.
        const removeBtn = target.closest(`[${QUOTE_REMOVE_ATTR}]`)
        if (removeBtn !== null) {
          const el = e.currentTarget
          const chip = removeBtn.closest(`[${QUOTE_CHIP_ATTR}]`)!
          const run = chip.getAttribute(QUOTE_CHIP_ATTR)!
          const start = offsetOf(el, chip, 0)
          const next = value.slice(0, start) + value.slice(start + run.length)
          const doc = el.ownerDocument
          el.focus()
          el.replaceChildren(renderTokens(doc, tokenize(next), start))
          placeCaretAtOffset(el, start)
          onChange(next)
          return
        }
        if (!onMentionClick) return
        const chip = target.closest(`[${MENTION_CHIP_ATTR}]`)
        // closest matched the mention attr, so the facts read cannot be null.
        if (chip !== null) onMentionClick(mentionChipFacts(chip)!)
      }}
      onCopy={(e) => {
        // A quote chip's rendered text is the DECODED excerpt, so a native copy
        // would put the excerpt (no `>` markers) on the clipboard. When the
        // selection touches a quote chip, write the SERIALIZED slice instead —
        // the exact Markdown blockquote — expanding to whole runs so a partial
        // chip selection still copies the complete quote. Non-quote selections
        // keep the native copy (mentions/refs already serialize as textContent).
        const el = e.currentTarget
        const selection = el.ownerDocument.getSelection()
        if (!selection || selection.rangeCount === 0) return
        const range = selection.getRangeAt(0)
        if (!el.contains(range.startContainer)) return
        const offs = selectionOffsets(el)
        if (!offs) return
        let start = offs.start
        let end = offs.end
        let touched = false
        for (const chip of el.querySelectorAll(`[${QUOTE_CHIP_ATTR}]`)) {
          if (!range.intersectsNode(chip)) continue
          touched = true
          const chipStart = offsetOf(el, chip, 0)
          const chipEnd = chipStart + chip.getAttribute(QUOTE_CHIP_ATTR)!.length
          start = Math.min(start, chipStart)
          end = Math.max(end, chipEnd)
        }
        if (!touched) return
        e.clipboardData.setData('text/plain', value.slice(start, end))
        e.preventDefault()
      }}
      onInput={(e) => {
        const el = e.currentTarget
        dropEmptyResidue(el)
        onChange(joinTokens(serializeTokens(el)))
      }}
    />
  )
}
