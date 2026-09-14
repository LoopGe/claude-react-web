# Rich composer: render `[Pasted text #N]` references as chips

Date: 2026-09-14

## Problem

The paste-collapse feature (merged in `3b299f7`) replaces a long paste in the
composer with a `[Pasted text #N +X lines]` reference, holding the body in a
side map and expanding it on send. The mechanism works; two UX gaps remain.

**1. The reference is visually indistinguishable from typed text.** The
composer is a native `<textarea>` (`Composer.tsx`, `.textarea` at
`src/styles/controls.css:313`), which cannot style a substring. The reference
therefore renders exactly like text the user typed, so there is no affordance
that says "this is a collapsed block, not something you wrote".

**2. After sending, the transcript shows the expanded body.** This is *by
design* and was confirmed as expected behaviour: `send()` expands the reference
before `POST /messages` (the model must receive the body), and the transcript
renders what was sent. Making the bubble collapse instead would require the
server to persist both forms and a wire-protocol change; that was considered
and explicitly deferred. **Out of scope here.**

So this spec covers gap 1 only.

## What has already landed

`5f12966` adds the two pure pieces, with tests, and wires nothing:

- `pastedText.tokenize` / `joinTokens` — split composer text into literal runs
  and reference tokens. Exact inverses.
- `richPromptDom.renderTokens` / `serializeTokens` — bridge those tokens to
  DOM. Chips are `contenteditable="false"`; a stray `<br>` is read back as a
  newline; adjacent text nodes merge.

The reason these landed first is that they are the safety property of the whole
change: pushing any composer text through the DOM and back must return it
byte-identical. That round-trip is tested (`richPromptDom.test.ts`, "DOM
round-trip is the identity for any composer text").

## Design

### The seam: the string stays canonical

```
DOM  ⇄  renderTokens / serializeTokens  ⇄  string  ⇄  everything downstream
```

`input: string` / `setInput: (v: string) => void` is unchanged. The editor is
only a **view**: it renders tokens to DOM, and on every `input` event
serializes back to a string.

This is the decision that keeps the blast radius inside `Composer`. Everything
that consumes the composer's value is untouched:

`Chat.send`, `planSubmission`, `composeOutgoing`, the two-key draft
(`draft:` / `draft-bodies:`), `useInputHistory`, `useComposerSnippets`,
`usePastedTexts`, app-plugin command contributions, `ChatEmptyState`
suggestions.

### Why contenteditable, and what was rejected

| Approach | Why not |
|---|---|
| **Mirror highlight layer** (transparent textarea over a styled div) | No input-core rewrite, but requires pixel-exact agreement on font metrics, padding, wrapping, auto-height and scroll between two elements, in both normal and `textarea-expanded` modes. Misalignment is the default failure mode and is only visible at certain widths. |
| **Chip strip above the textarea** (like the existing pasted-image chips) | Zero alignment risk and reuses an existing pattern, but does not fix the actual complaint: the reference inside the text is still ordinary text. |
| **contenteditable + real chips** (chosen) | The chip becomes a real element, so the caret and Backspace treat a reference as one unit *natively* — which is what `usePastedTextEditing` currently has to do with character offsets. It also makes a chip directly clickable for a future expand affordance. Cost: the composer's DOM-dependent interactions must be ported (below). |

An accepted side effect: with real chips, most of `usePastedTextEditing`'s
`refKeyAction` / `replaceRange` offset machinery becomes unnecessary and should
be deleted rather than kept alongside.

## What must be ported

Every one of these currently depends on `<textarea>` character offsets
(`selectionStart` / `selectionEnd`) and breaks the moment the element is a
`<div>` — `selectionStart` is `undefined`, so the arithmetic silently produces
garbage rather than throwing. These are the real cost of this change.

| Location | Today | Under contenteditable |
|---|---|---|
| `Composer.tsx:226` `confirmPicker` | `el.selectionStart` + `input.slice` to find the `/word` | derive the `/word` from the DOM Range before the caret |
| `Composer.tsx:447` context-menu open | `setSavedSelection({ start, end })` | snapshot a DOM `Range`; it must survive the menu taking focus |
| `insertAtSavedSelection` | splice by offsets | operate on the saved `Range` |
| `Composer.tsx:737` `/` trigger | `e.target.selectionStart` | same DOM-Range derivation as `confirmPicker` |
| `Composer.tsx:869` ↑ history edge | `input.slice(0, selectionStart).includes('\n')` | ask whether the caret is on the first line |
| `handleSelectAll` | `setSelectionRange(0, input.length)` | select the editor's contents |
| auto-height, `textarea-expanded` | measured from the textarea | measured from the editor element |
| `placeholder`, `aria-label` | native attributes | contenteditable has no `placeholder` → `:empty::before`; keep `role="textbox"` + `aria-label` |
| `usePastedTextEditing` | offsets + `refKeyAction` | mostly deleted; native chip deletion replaces it |

## Known hazards

These are the two that produce "works when I try it, broken at the edges".

1. **IME composition.** CJK input fires `compositionstart`/`compositionend`
   around edits. The composer already guards Enter with
   `e.nativeEvent.isComposing`; the rich editor needs the same guard on the
   `input`-driven re-render, or re-rendering mid-composition moves the caret.
   A common approach is to not re-render from `value` while composing.
2. **Paste must be forced to plain text.** A contenteditable will otherwise
   accept arbitrary HTML from the clipboard. Everything pasted must go through
   `e.preventDefault()` + an explicit insert of `text/plain`, and existing
   paste paths must be re-checked. Note the collapse path already exists and
   must keep working: `handleRefPaste` in `usePastedTextEditing`.

Two smaller ones, both already handled in the serializer and worth keeping
green: adjacent text-node merging, and `<br>` → `\n`.

## Rollout

Behind a flag, with the textarea kept as the fallback — this component is the
project's most-used surface and the change must be revertible in one line.

1. New `RichPromptInput` component, same `value`/`onChange`/`onKeyDown` props
   the textarea takes today.
2. Composer selects between it and the textarea on a module constant (the same
   pattern as `SCHEDULE_SEND_ENABLED` in `Composer.tsx`).
3. Port the interactions in the table above.
4. Delete the textarea path, the flag, and the now-dead offset logic in
   `usePastedTextEditing`.

## Testing

- Serializer and DOM bridge: unit tests, already green (`5f12966`).
- Chip rendering: assert the DOM shape, that chips are `contenteditable=false`,
  and that a chip carries its reference id.
- **Round-trip through the real editor**: type, paste a large block, edit around
  the chip, then assert the serialized string. This is the regression that
  matters.
- IME: simulate `compositionstart` → `input` → `compositionend` and assert the
  caret does not move and the value is not clobbered.
- Paste sanitization: paste HTML and assert only its text survives.
- Ported interactions: the slash picker, context-menu paste, and the ↑ history
  edge each need a case at the new element.

## Out of scope

- Collapsing the transcript bubble (deferred, needs server-side storage of both
  forms).
- Clicking a chip to expand or re-open the pasted body.
- Any change to the collapse threshold, the body map, or the send path.
