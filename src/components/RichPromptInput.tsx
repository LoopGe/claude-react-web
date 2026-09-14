import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { joinTokens, tokenize } from '../utils/pastedText'
import { renderTokens, serializeTokens } from '../utils/richPromptDom'

interface Props {
  value: string
  onChange: (v: string) => void
  ariaLabel: string
  placeholder?: string
  disabled?: boolean
  className?: string
  /** Forwarded ref to the editor element (later tasks need it for ranges). */
  editorRef?: RefObject<HTMLDivElement | null>
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
}: Props) {
  const localRef = useRef<HTMLDivElement>(null)
  const ref = editorRef ?? localRef
  // Set while an IME composition is in flight. Re-rendering the DOM from
  // `value` mid-composition moves the caret and can drop the candidate.
  const composingRef = useRef(false)

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
    el.addEventListener('compositionstart', onCompositionStart)
    el.addEventListener('compositionend', onCompositionEnd)
    return () => {
      el.removeEventListener('compositionstart', onCompositionStart)
      el.removeEventListener('compositionend', onCompositionEnd)
    }
  }, [onChange, ref])

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
      onInput={(e) => onChange(joinTokens(serializeTokens(e.currentTarget)))}
    />
  )
}
