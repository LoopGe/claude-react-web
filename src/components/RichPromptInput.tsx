import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { joinTokens, tokenize } from '../utils/pastedText'
import { renderTokens, serializeTokens } from '../utils/richPromptDom'
import { offsetOf, slashWordBefore, caretOnFirstLine, placeCaretAtOffset } from './richPromptCaret'
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
  /** Called with a raw paste. When it returns true the paste was handled
   *  (collapsed); when false the caller inserted it verbatim. */
  onPasteText?: (raw: string) => boolean
  /** Right-click context menu handler. */
  onContextMenu?: (e: React.MouseEvent<HTMLElement>) => void
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
  onContextMenu,
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
    onChange(joinTokens(serializeTokens(el)))
  }

  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    // Take the paste over unconditionally. Left to itself a contenteditable
    // accepts text/html, which would put arbitrary markup (an <img onerror>,
    // say) inside the editor — and our serializer would then flatten it into
    // text we never intended to accept.
    e.preventDefault()
    const raw = e.clipboardData?.getData('text/plain') ?? ''
    if (!raw) return
    // The collapse policy gets first refusal so it stays the single owner of
    // the threshold and normalization.
    if (onPasteText?.(raw)) return
    insertPlainTextAtCaret(raw)
  }

  // Push `value` into the DOM only when it actually differs from what the DOM
  // already serializes to. On the typing path they always match, so this is a
  // no-op and the caret is left alone.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (composingRef.current) return
    if (joinTokens(serializeTokens(el)) === value) return
    el.replaceChildren(renderTokens(el.ownerDocument, tokenize(value)))
  }, [value, ref])

  // Grow instead of scrolling: measure the editor's content box. `scrollHeight`
  // on a contenteditable reflects its content, so reset to auto first.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value, ref])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onCompositionStart = () => {
      composingRef.current = true
    }
    const onCompositionEnd = () => {
      composingRef.current = false
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
  }, [onChange, ref])

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
      className={className}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      onContextMenu={onContextMenu}
      onInput={(e) => onChange(joinTokens(serializeTokens(e.currentTarget)))}
    />
  )
}
