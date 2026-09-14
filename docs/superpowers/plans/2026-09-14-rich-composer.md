# Rich Composer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the composer's `<textarea>` with a contenteditable editor so `[Pasted text #N]` references render as real chips instead of reading as ordinary typed text.

**Architecture:** The canonical value stays a `string`. A chip is a DOM element; `renderTokens`/`serializeTokens` (already landed) convert between the string and the DOM, so `value`/`onChange` keep the exact signature the textarea has today and everything downstream is untouched. The editor is only a view.

**Tech Stack:** React 19, TypeScript, Vite, vitest + @testing-library/react (jsdom).

**Spec:** `docs/superpowers/specs/2026-09-14-rich-composer-design.md`

## Global Constraints

- `value: string` / `onChange: (v: string) => void` is the component's contract. Do not change it.
- Never let the DOM be the source of truth: every mutation must serialize back through `joinTokens(serializeTokens(el))`.
- Chips must stay `contenteditable="false"` with `data-pasted-ref` = the reference id (see `src/utils/richPromptDom.ts`: `CHIP_ATTR`, `CHIP_CLASS`).
- Line breaks are literal `\n` in text nodes, rendered by `white-space: pre-wrap`. Do not materialise `<br>` on Enter.
- Do not re-render the DOM from `value` while an IME composition is active.
- Pasted HTML must never enter the editor: always `preventDefault()` and insert `text/plain` explicitly.
- Keep the `<textarea>` path working behind the flag until Task 6 deletes it.
- Commands: `npm run typecheck` (both tsconfigs), `npm run lint`, `npx vitest run <path>`.

---

### Task 1: `RichPromptInput` core — render, serialize, type

The editor element, its chip rendering, and the value round-trip. No keyboard
handling, no paste, no interactions — a controlled field you can type in.

**Files:**
- Create: `src/components/RichPromptInput.tsx`
- Create: `src/components/RichPromptInput.test.tsx`
- Modify: `src/styles/chat.css` (append the chip + editor rules)

**Interfaces:**
- Consumes: `tokenize`, `joinTokens` (`src/utils/pastedText.ts`); `renderTokens`, `serializeTokens`, `CHIP_CLASS` (`src/utils/richPromptDom.ts`).
- Produces: `RichPromptInput`, with props (all later tasks extend this set):
  ```ts
  interface Props {
    value: string
    onChange: (v: string) => void
    ariaLabel: string
    placeholder?: string
    disabled?: boolean
    className?: string
    /** Forwarded ref to the editor element (later tasks need it for ranges). */
    editorRef?: React.RefObject<HTMLDivElement | null>
  }
  ```

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/RichPromptInput.test.tsx
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { RichPromptInput } from './RichPromptInput'
import { CHIP_CLASS } from '../utils/richPromptDom'

afterEach(() => cleanup())

function editor(container: HTMLElement): HTMLDivElement {
  return container.querySelector('[role="textbox"]') as HTMLDivElement
}

describe('RichPromptInput', () => {
  it('renders literal text', () => {
    const { container } = render(
      <RichPromptInput value="hello" onChange={vi.fn()} ariaLabel="Message" />,
    )
    expect(editor(container).textContent).toBe('hello')
  })

  it('renders a reference as a non-editable chip', () => {
    const { container } = render(
      <RichPromptInput
        value="hi [Pasted text #2 +9 lines]"
        onChange={vi.fn()}
        ariaLabel="Message"
      />,
    )
    const chip = container.querySelector(`.${CHIP_CLASS}`)!
    expect(chip).not.toBeNull()
    expect(chip.getAttribute('data-pasted-ref')).toBe('2')
    expect(chip.getAttribute('contenteditable')).toBe('false')
  })

  it('reports the serialized text as a chip is removed from the DOM', () => {
    // Stands in for Backspace-with-native-chip-deletion: the browser removes
    // the chip element, then fires `input`. We assert the round-trip, not how
    // the deletion happened.
    const onChange = vi.fn()
    const { container } = render(
      <RichPromptInput value="a [Pasted text #1] b" onChange={onChange} ariaLabel="Message" />,
    )
    const el = editor(container)
    el.querySelector(`.${CHIP_CLASS}`)!.remove()
    fireEvent.input(el)
    expect(onChange).toHaveBeenCalledWith('a  b')
  })

  it('reports typed text with the reference preserved', () => {
    const onChange = vi.fn()
    const { container } = render(
      <RichPromptInput value="[Pasted text #1]" onChange={onChange} ariaLabel="Message" />,
    )
    const el = editor(container)
    el.appendChild(document.createTextNode(' tail'))
    fireEvent.input(el)
    expect(onChange).toHaveBeenCalledWith('[Pasted text #1] tail')
  })

  it('does not touch the DOM when the incoming value already matches it', () => {
    // Re-rendering identical content would move the caret on every keystroke.
    const { container, rerender } = render(
      <RichPromptInput value="abc" onChange={vi.fn()} ariaLabel="Message" />,
    )
    const el = editor(container)
    rerender(<RichPromptInput value="abc" onChange={vi.fn()} ariaLabel="Message" />)
    expect(editor(container)).toBe(el)
  })

  it('rebuilds the DOM when the value changes from outside', () => {
    const { container, rerender } = render(
      <RichPromptInput value="one" onChange={vi.fn()} ariaLabel="Message" />,
    )
    rerender(<RichPromptInput value="two" onChange={vi.fn()} ariaLabel="Message" />)
    expect(editor(container).textContent).toBe('two')
  })

  it('exposes the editor through editorRef', () => {
    const ref = { current: null as HTMLDivElement | null }
    render(
      <RichPromptInput value="x" onChange={vi.fn()} ariaLabel="Message" editorRef={ref} />,
    )
    expect(ref.current?.getAttribute('role')).toBe('textbox')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/RichPromptInput.test.tsx`
Expected: FAIL — `Failed to resolve import "./RichPromptInput"`.

- [ ] **Step 3: Write the implementation**

```tsx
// src/components/RichPromptInput.tsx
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
  editorRef?: RefObject<HTMLDivElement | null>
}

/**
 * Contenteditable prompt field whose canonical value is a plain string.
 *
 * A `<textarea>` cannot style a substring, so `[Pasted text #N]` references
 * read as ordinary typed text. Here they are real elements — which also makes
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
```

- [ ] **Step 4: Add the styles**

Append to `src/styles/chat.css`:

```css
/* Rich composer: a contenteditable that renders `[Pasted text #N]` as chips.
   `pre-wrap` keeps literal \n as the only line-break mechanism, so the
   serializer never has to understand <br>. */
.rich-prompt {
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
  outline: none;
  cursor: text;
}

.rich-prompt:empty::before,
.rich-prompt[data-placeholder]:not(:focus):empty::before {
  content: attr(data-placeholder);
  color: var(--fg-dim);
  pointer-events: none;
}

.pasted-text-chip {
  display: inline-block;
  padding: 0 var(--space-1);
  border: 1px solid var(--msg-user-border);
  border-radius: var(--radius-3xs);
  background: var(--msg-user-bg);
  color: var(--msg-user-header-fg);
  font-weight: 600;
  white-space: pre;
  user-select: none;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/components/RichPromptInput.test.tsx`
Expected: PASS, 7 tests.

- [ ] **Step 6: Typecheck and lint**

Run: `npm run typecheck && npx eslint src/components/RichPromptInput.tsx src/components/RichPromptInput.test.tsx`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add src/components/RichPromptInput.tsx src/components/RichPromptInput.test.tsx src/styles/chat.css
git commit -m "feat(composer): contenteditable prompt field that renders pasted-text chips"
```

---

### Task 2: Enter family, auto-height, and placeholder behaviour

Keyboard submission without an IME ever sending a half-typed candidate, and
the editor growing instead of scrolling.

**Files:**
- Modify: `src/components/RichPromptInput.tsx`
- Modify: `src/components/RichPromptInput.test.tsx`
- Modify: `src/styles/chat.css`

**Interfaces:**
- Consumes: everything from Task 1.
- Produces: adds these props; Task 6 wires them from `Composer`:
  ```ts
  onSubmit?: () => void          // Enter, no modifier, not composing
  onNewline?: () => void         // Shift+Enter or Ctrl/Cmd+Enter
  /** Current text, for callers that must decide before mutating. */
  getValue?: () => string
  ```

- [ ] **Step 1: Write the failing test**

```tsx
// append to src/components/RichPromptInput.test.tsx
describe('RichPromptInput keyboard', () => {
  it('submits on Enter', () => {
    const onSubmit = vi.fn()
    const { container } = render(
      <RichPromptInput value="hi" onChange={vi.fn()} ariaLabel="M" onSubmit={onSubmit} />,
    )
    fireEvent.keyDown(editor(container), { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledOnce()
  })

  it('does not submit on Shift+Enter', () => {
    const onSubmit = vi.fn()
    const { container } = render(
      <RichPromptInput value="hi" onChange={vi.fn()} ariaLabel="M" onSubmit={onSubmit} />,
    )
    fireEvent.keyDown(editor(container), { key: 'Enter', shiftKey: true })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('does not submit while an IME composition is active', () => {
    // Enter confirms a CJK candidate; sending here ships a half-typed word.
    const onSubmit = vi.fn()
    const { container } = render(
      <RichPromptInput value="ni" onChange={vi.fn()} ariaLabel="M" onSubmit={onSubmit} />,
    )
    const el = editor(container)
    fireEvent.keyDown(el, { key: 'Enter', isComposing: true })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('accepts Enter that arrives while composing but was not fired by it', () => {
    // jsdom's fireEvent drops unknown props; assert the property the guard
    // actually reads so it cannot silently default to truthy.
    const el = document.createElement('div')
    fireEvent.keyDown(el, { key: 'Enter' })
    expect((el as unknown as { nativeEvent?: unknown }).nativeEvent).toBeUndefined()
  })

  it('reports a newline request on Ctrl+Enter', () => {
    const onNewline = vi.fn()
    const { container } = render(
      <RichPromptInput value="hi" onChange={vi.fn()} ariaLabel="M" onNewline={onNewline} />,
    )
    fireEvent.keyDown(editor(container), { key: 'Enter', ctrlKey: true })
    expect(onNewline).toHaveBeenCalledOnce()
  })

  it('shows the placeholder only while empty', () => {
    const { container } = render(
      <RichPromptInput value="" onChange={vi.fn()} ariaLabel="M" placeholder="Send a message" />,
    )
    expect(editor(container).getAttribute('data-placeholder')).toBe('Send a message')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/RichPromptInput.test.tsx -t keyboard`
Expected: FAIL — `onSubmit` never called.

- [ ] **Step 3: Implement the handlers**

In `RichPromptInput.tsx`, add the props to `Props` and the handler below. The
guard reads the **native** event, matching the textarea's
`e.nativeEvent.isComposing`:

```tsx
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
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
```

Attach `onKeyDown={handleKeyDown}` to the editor element, and add auto-height:

```tsx
  // Grow instead of scrolling: measure the editor's content box. `scrollHeight`
  // on a contenteditable reflects its content, so reset to auto first.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value, ref])
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/RichPromptInput.test.tsx`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/RichPromptInput.tsx src/components/RichPromptInput.test.tsx
git commit -m "feat(composer): Enter/Shift+Enter and auto-height on the rich prompt field"
```

---

### Task 3: Paste — plain text only, collapse preserved

The clipboard is the one path where a contenteditable will happily ingest
arbitrary HTML, so it must be taken over explicitly. The collapse behaviour
already exists and must keep working.

**Files:**
- Modify: `src/components/RichPromptInput.tsx`
- Modify: `src/components/RichPromptInput.test.tsx`

**Interfaces:**
- Consumes: `planPaste`, `formatPastedTextRef` (`src/utils/pastedText.ts`).
- Produces: `onPasteText` prop; Task 6 supplies the Composer's existing
  `placePastedText`-equivalent so the policy stays in one place.
  ```ts
  /** Called with a raw paste. When it returns true the paste was handled
   *  (collapsed); when false the caller inserted it verbatim. */
  onPasteText?: (raw: string) => boolean
  ```

- [ ] **Step 1: Write the failing test**

```tsx
// append to src/components/RichPromptInput.test.tsx
describe('RichPromptInput paste', () => {
  function paste(el: HTMLElement, data: Record<string, string>) {
    const event = createEvent.paste(el, {
      clipboardData: { getData: (t: string) => data[t] ?? '' },
    })
    fireEvent(el, event)
    return event
  }

  it('inserts pasted plain text at the caret', () => {
    const onChange = vi.fn()
    const { container } = render(
      <RichPromptInput value="" onChange={onChange} ariaLabel="M" />,
    )
    const el = editor(container)
    paste(el, { 'text/plain': 'pasted' })
    expect(el.textContent).toContain('pasted')
  })

  it('never lets HTML from the clipboard into the DOM', () => {
    const { container } = render(
      <RichPromptInput value="" onChange={vi.fn()} ariaLabel="M" />,
    )
    const el = editor(container)
    // Only text/plain is ever read; text/html must be ignored outright.
    paste(el, { 'text/html': '<img src=x onerror=alert(1)>', 'text/plain': 'safe' })
    expect(el.querySelector('img')).toBeNull()
    expect(el.textContent).toBe('safe')
  })

  it('gives the collapse policy first refusal', () => {
    const onPasteText = vi.fn(() => true)
    const { container } = render(
      <RichPromptInput value="" onChange={vi.fn()} ariaLabel="M" onPasteText={onPasteText} />,
    )
    paste(editor(container), { 'text/plain': 'anything' })
    expect(onPasteText).toHaveBeenCalledWith('anything')
  })

  it('inserts verbatim when the policy declines', () => {
    const onPasteText = vi.fn(() => false)
    const { container } = render(
      <RichPromptInput value="" onChange={vi.fn()} ariaLabel="M" onPasteText={onPasteText} />,
    )
    const el = editor(container)
    paste(el, { 'text/plain': 'small' })
    expect(el.textContent).toBe('small')
  })
})
```

Add `createEvent` to the existing `@testing-library/react` import.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/RichPromptInput.test.tsx -t paste`
Expected: FAIL — `onPasteText` never called / text not inserted.

- [ ] **Step 3: Implement**

```tsx
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
```

`insertPlainTextAtCaret` inserts a text node at the current range and leaves
the caret after it. If there is no range inside the editor (nothing focused
yet), append to the end:

```tsx
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
```

Attach `onPaste={handlePaste}` to the editor element.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/RichPromptInput.test.tsx`
Expected: PASS, 17 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/RichPromptInput.tsx src/components/RichPromptInput.test.tsx
git commit -m "feat(composer): plain-text-only paste on the rich prompt field"
```

---

### Task 4: Port the slash picker and the history edges

The two interactions that read text *around* the caret. Both currently use
`textarea.selectionStart`; on a `<div>` that is `undefined`, so the arithmetic
would silently produce garbage rather than throw.

**Files:**
- Modify: `src/components/RichPromptInput.tsx`
- Modify: `src/components/RichPromptInput.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  /** The `/word` immediately before the caret, or null. */
  getSlashWordAtCaret?: () => string | null
  /** True when the caret sits on the first line (for ↑ history). */
  caretOnFirstLine?: () => boolean
  /** Replace the `/word` before the caret with `text`. */
  replaceSlashWord?: (text: string) => void
  ```

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/richPromptCaret.test.ts
import { describe, it, expect } from 'vitest'
import { slashWordBefore, caretOnFirstLine } from './richPromptCaret'

describe('richPromptCaret', () => {
  it('reads the /word ending at the caret', () => {
    const text = 'hello /mod'
    expect(slashWordBefore(text, text.length)).toBe('/mod')
  })

  it('returns null when the word does not start with /', () => {
    const text = 'hello world'
    expect(slashWordBefore(text, text.length)).toBeNull()
  })

  it('returns null when the /word is already closed by a space', () => {
    const text = '/mod '
    expect(slashWordBefore(text, text.length)).toBeNull()
  })

  it('detects the first line', () => {
    expect(caretOnFirstLine('one\ntwo', 3)).toBe(true)
    expect(caretOnFirstLine('one\ntwo', 5)).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/RichPromptInput.test.tsx -t richPromptCaret`
Expected: FAIL — cannot resolve `./richPromptCaret`.

- [ ] **Step 3: Implement the pure helper, then bridge it**

Create `src/components/richPromptCaret.ts`:

```ts
/**
 * Caret queries for the rich composer, as pure functions over
 * `(text, offset)`.
 *
 * The offsets come from a DOM Range measured against the editor's serialized
 * text — the same string `RichPromptInput` keeps as its value — so these can be
 * tested without a DOM and cannot drift from the serializer.
 */

/** The `/word` ending at `offset`, or null when there isn't one. */
export function slashWordBefore(text: string, offset: number): string | null {
  const before = text.slice(0, offset)
  const wordStart = before.lastIndexOf(' ') + 1
  const word = before.slice(wordStart)
  return word.startsWith('/') && !word.includes(' ') ? word : null
}

/** True when nothing before `offset` spans a line break. */
export function caretOnFirstLine(text: string, offset: number): boolean {
  return !text.slice(0, offset).includes('\n')
}
```

On the component, expose the offset by serializing and measuring the Range:

```tsx
  /** Character offset of the caret within the serialized value. */
  const caretOffset = (): number | null => {
    const el = ref.current
    const selection = el?.ownerDocument.getSelection()
    if (!el || !selection || selection.rangeCount === 0) return null
    const range = selection.getRangeAt(0)
    if (!el.contains(range.startContainer)) return null
    const probe = range.cloneRange()
    probe.selectNodeContents(el)
    probe.setEnd(range.startContainer, range.startOffset)
    return probe.toString().length
  }
```

Then the component's props are thin wrappers over those helpers:
`getSlashWordAtCaret` is `slashWordBefore(value, caretOffset() ?? 0)`, the
`caretOnFirstLine` prop is `caretOnFirstLine(value, caretOffset() ?? 0)`, and
`replaceSlashWord(text)` replaces the `/word` slice and writes the result
through `onChange`, restoring the caret to the end of the replacement.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/RichPromptInput.test.tsx src/components/richPromptCaret.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/richPromptCaret.ts src/components/richPromptCaret.test.ts src/components/RichPromptInput.tsx src/components/RichPromptInput.test.tsx
git commit -m "feat(composer): caret queries (slash word, first line) for the rich prompt field"
```

---

### Task 5: Port the context menu's saved selection

The right-click Cut / Copy / Paste / Select-all menu snapshots
`{ selectionStart, selectionEnd }` **character offsets** when it opens, because
the menu takes focus and the textarea loses its selection. A `<div>` has no
offsets, so the snapshot has to become a DOM `Range` — and it has to survive
the menu taking focus, which is the part that makes this its own task.

**Files:**
- Modify: `src/components/RichPromptInput.tsx`
- Modify: `src/components/RichPromptInput.test.tsx`
- Modify: `src/components/Composer.tsx`

**Interfaces:**
- Consumes: `serializeTokens` / `renderTokens`.
- Produces:
  ```ts
  /** Offset pair for the current selection, or null when nothing is selected. */
  getSelectionOffsets?: () => { start: number; end: number } | null
  /** Replace `[start, end)` with `text` and leave the caret after it. */
  replaceOffsets?: (start: number, end: number, text: string) => void
  /** Select the whole editor. */
  selectAll?: () => void
  ```

- [ ] **Step 1: Write the failing test**

```tsx
// append to src/components/RichPromptInput.test.tsx
describe('RichPromptInput selection', () => {
  function select(el: HTMLElement, start: number, end: number) {
    const range = document.createRange()
    const node = el.firstChild!
    range.setStart(node, start)
    range.setEnd(node, end)
    const selection = document.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  }

  it('reports the selected offsets', () => {
    const ref = { current: null as HTMLDivElement | null }
    const { container } = render(
      <RichPromptInput value="hello world" onChange={vi.fn()} ariaLabel="M" editorRef={ref} />,
    )
    select(editor(container), 0, 5)
    expect(richApi(ref.current!).selectionOffsets()).toEqual({ start: 0, end: 5 })
  })

  it('reports null for a collapsed caret', () => {
    const ref = { current: null as HTMLDivElement | null }
    const { container } = render(
      <RichPromptInput value="hello" onChange={vi.fn()} ariaLabel="M" editorRef={ref} />,
    )
    select(editor(container), 2, 2)
    expect(richApi(ref.current!).selectionOffsets()).toBeNull()
  })
})
```

The assertions read through a small accessor rather than the ref directly, so
the component can expose these without widening its public prop surface:

```tsx
// src/components/richPromptApi.ts
import { joinTokens, tokenize } from '../utils/pastedText'
import { renderTokens, serializeTokens } from '../utils/richPromptDom'

/**
 * Offset-based selection helpers over a rich-prompt editor element.
 *
 * The context menu needs offsets because it acts on a snapshot taken when it
 * opened, not on live DOM state — see Composer's savedSelection.
 */
export function selectionOffsets(el: HTMLElement): { start: number; end: number } | null {
  const selection = el.ownerDocument.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null
  const range = selection.getRangeAt(0)
  if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) return null
  return { start: offsetOf(el, range.startContainer, range.startOffset), end: offsetOf(el, range.endContainer, range.endOffset) }
}

/** Character offset of a DOM position within the editor's serialized text. */
export function offsetOf(root: HTMLElement, container: Node, offset: number): number {
  const probe = root.ownerDocument.createRange()
  probe.selectNodeContents(root)
  probe.setEnd(container, offset)
  return probe.toString().length
}

/** Replace `[start, end)` with `text`, then place the caret after it. */
export function replaceOffsets(el: HTMLElement, start: number, end: number, text: string): void {
  const next = joinTokens(tokenize(joinTokens(serializeTokens(el)).slice(0, start) + text + joinTokens(serializeTokens(el)).slice(end)))
  el.replaceChildren(renderTokens(el.ownerDocument, tokenize(next)))
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/richPromptApi.test.ts`
Expected: FAIL — cannot resolve `./richPromptApi`.

- [ ] **Step 3: Implement and rewire the Composer**

Implement `richPromptApi.ts` as above, plus `selectAll(el)` calling
`range.selectNodeContents(el)`. Then in `Composer.tsx`, replace the
`setSavedSelection({ start: el.selectionStart, end: el.selectionEnd })` call
with `setSavedSelection(selectionOffsets(editorRef.current!) ?? { start: 0, end: 0 })`,
route `insertAtSavedSelection` through `replaceOffsets`, and make
`handleSelectAll` call `selectAll`. The menu's Cut/Copy keep reading
`input.slice(start, end)` — that still works, because the offsets are measured
against the same serialized string the component keeps as its value.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/richPromptApi.test.ts src/components/Composer.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/richPromptApi.ts src/components/richPromptApi.test.ts src/components/RichPromptInput.tsx src/components/Composer.tsx
git commit -m "feat(composer): offset selection helpers for the rich prompt field"
```

---

### Task 6: Wire behind a flag, verify, then delete the textarea path

The switch, and the removal of everything the textarea needed.

**Files:**
- Modify: `src/components/Composer.tsx`
- Modify: `src/components/Composer.test.tsx`
- Modify: `src/hooks/usePastedTextEditing.ts`
- Modify: `src/components/SideChatDrawer.tsx`
- Delete: `src/utils/richPromptDom.ts` is **kept** (the editor still uses it)

**Interfaces:**
- Consumes: `RichPromptInput` and all props from Tasks 1–4; the Composer's existing `handleRefPaste`, `placePastedText`, `insertAtCaret`, `handleRefKeyDown`, `widenToRef`.
- Produces: no new public surface.

- [ ] **Step 1: Add the flag and the swap**

In `Composer.tsx`, next to `SCHEDULE_SEND_ENABLED`:

```tsx
/** Rich (contenteditable) composer. Off reverts to the plain textarea. */
const RICH_COMPOSER_ENABLED = false
```

Render `RichPromptInput` when the flag is on, passing:
- `value={input}`, `onChange={setInput}`
- `onSubmit={onSend}`
- `className="textarea"` plus `rich-prompt` so it inherits the existing sizing
- `onPasteText`: a callback that runs `placePastedText` and returns whether it collapsed
- `getSlashWordAtCaret` / `replaceSlashWord` into the existing picker logic
- `caretOnFirstLine` into the existing `handleHistoryUp`
- `editorRef` in place of `textareaRef`

`handleRefKeyDown` and `widenToRef` are **not** wired: with real chips the
native caret and Backspace already treat a reference as one unit, which is the
behaviour those existed to fake.

- [ ] **Step 2: Run the existing Composer tests against the flag on**

Temporarily flip `RICH_COMPOSER_ENABLED` to `true`, then:

Run: `npx vitest run src/components/Composer.test.tsx`
Expected: the 8 paste/atomic-editing tests **fail** — they drive a `<textarea>`
and assert textarea selection semantics that no longer apply. Rewrite them
against the editor: assert on the serialized value produced by an `input`
event, and drop the caret-position assertions that only made sense for
`selectionStart`.

- [ ] **Step 3: Verify the whole suite with the flag on**

Run: `npm run test`
Expected: PASS. Any failure here is a real regression in the ported
interactions — the textarea assertions are the only ones expected to change.

- [ ] **Step 4: Delete the textarea path and the dead offset logic**

- Remove the `RICH_COMPOSER_ENABLED` flag and the textarea branch (keep the
  submitted-text behaviour, not the element).
- In `usePastedTextEditing.ts`, delete `replaceRange`'s offset bookkeeping and
  `handleRefKeyDown` / `widenToRef` / `refKeyAction` usage; keep
  `placePastedText` (still the policy entry point) and whatever the drawer and
  the context menu still need.
- In `SideChatDrawer.tsx`, wire the same swap. Then delete
  `refKeyAction`/`refRanges` from `src/utils/pastedText.ts` and their tests if
  nothing else uses them — check with
  `grep -rn "refKeyAction\|refRanges" src/`.

- [ ] **Step 5: Full verification**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: typecheck clean on both tsconfigs, lint clean on changed files, full
suite green except the known-flaky `server/cli-diagnostics` 5MB-cap test
(confirm by running it alone: `npx vitest run server/cli-diagnostics.test.ts`).

- [ ] **Step 6: Commit**

```bash
git add -A src/
git commit -m "feat(composer): rich composer by default, textarea path removed"
```

- [ ] **Step 7: Adversarial pass before declaring done**

These are the failures that only show up in a real browser. Do each by hand in
the running app (`npm run dev`) and record the result:

1. Paste >15 lines → chip appears. Send → the model receives the body, not the
   reference.
2. Click into the middle of a chip, then Backspace → the whole chip goes.
3. Arrow keys step over the chip in one move.
4. Compose with an IME (Chinese/Japanese) → Enter confirms the candidate
   instead of sending; the caret does not jump.
5. Paste rich HTML (copy from a web page) → only text arrives, no markup.
6. Type `/` at the start → the picker opens and confirming it replaces the
   word.
7. ↑ on the first line → walks history; ↑ mid-message → moves the caret.
8. Reload with an unsent chip → the chip comes back, and the body survives
   (the two-key draft).
9. Alt+Enter toggles the Edit/Preview tabs and still renders the value as
   Markdown; the editor regains focus on toggling back.
10. Right-click a selection → Cut/Copy/Paste/Select all act on the range that
   was selected when the menu opened, not on wherever the caret ended up.
