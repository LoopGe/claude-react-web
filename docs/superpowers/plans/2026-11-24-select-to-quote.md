# Select-to-Quote Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user select transcript text (prose, tool output, thinking), click a floating Quote button, and get an atomic composer quote chip that transmits as a line-leading Markdown blockquote; the sent message renders blockquote runs as a compact inert chip. Zero server/protocol change.

**Architecture:** The composer is text-string-driven (`tokenize(value)` → reconcile → `renderTokens`; draft is a raw sessionStorage string). A quote is a new atomic chip kind: `tokenize` recognizes line-leading blockquote runs (so hand-typed `>` chipifies too); the token carries the EXACT matched run (preserving `joinTokens(tokenize(s))===s`). The settled chip displays the DECODED excerpt but carries its serialization in `data-quote-text` — a real extension of the DOM→text bridge (`collectSegments`/caret mapping read serialization, not textContent, for quote chips). Quote runs are threaded opaque through `composeOutgoing` and `splitUserContentSegments` so quoted file-handle/paste-ref text stays literal. Selection uses a ported visible-text projection + a focused floating Quote toolbar.

**Tech Stack:** React 19, TypeScript, Vite, vitest (happy-dom client / node logic), Playwright. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-24-select-to-quote-design.md` (read fully). DSH reference: `text-selection.ts`, `message-quotes/{quote-text,quote-rule}.ts`, `QuotePreview.tsx`, `markdown/quote-text.ts`, `QuoteNode.tsx`.

**EXECUTION: directly on `main`, NO worktree/branch (user directive).** The main checkout holds another session's uncommitted WIP — stage ONLY this feature's files per commit, never `git add -A`/`.`; never touch the other session's changes. Reconcile local main vs origin/main before pushing.

## Global Constraints

- Transmission = clean line-leading Markdown blockquote (`> line` per line, DSH `formatQuoteText`); decode `quoteTextOf` (strip one `^ {0,3}>[ \t]?` per line); recognition `messageQuoteRanges` (line-leading `^ {0,3}>` runs, global m-flag, anywhere — NOT message-anchored). Zero server change.
- Round-trip invariant: `joinTokens(tokenize(s)) === s` MUST hold for quote runs (exact matched run token; nested `>`, missing space after `>`, trailing whitespace, doubled separators all round-trip losslessly).
- Display ≠ serialization bridged: a quote chip's value contribution is its `data-quote-text` (exact run), NOT its displayed excerpt; caret mapping uses serialization length. Mention chips' textContent===serialization path unchanged.
- Quote runs OPAQUE to `expandPastedTextRefs`/trim (`composeOutgoing`) and `splitFileHandleText`/mention splitting (`splitUserContentSegments`): a quoted file-handle/paste-ref stays literal.
- In-place serialization (NOT hoisted prepend); a quote run is line-leading (leading `\n` if mid-line) + blank-line separator from following prose.
- Multi-line caret gate: caret outside run = settled chip; caret entering de-chipifies the WHOLE run to editable text; leaving re-settles; atomic Backspace/Delete whole-run; arrows cross without entering. No in-chip character editing.
- Selection sources: user/assistant prose + tool-result output + thinking; chrome (tool-card header/fold/timer/badge, buttons, KaTeX MathML, aria-hidden, sr-only, attachment chips) excluded via projection + `data-text-interaction-exclude`.
- Draft restore via `tokenize` (raw-string model); no out-of-band chip persistence.
- CSS theme vars BOTH `:root` and `[data-theme="light"]`, no hex; no speculative defensive code; both tsconfigs typecheck; client tests happy-dom; startup bundle must not grow.
- Every commit ends `Co-Authored-By: Claude Code <noreply@anthropic.com>`. Stage only feature files (other session WIP present).

## Review Focus

1. **Round-trip break** — `joinTokens(tokenize(s)) !== s` for a quote run (nested `>`, missing space, trailing whitespace, doubled separator). → Task 2.
2. **Caret drift / value drift** — a quote chip's displayed excerpt leaks into the composer value or caret offsets use displayed length instead of serialization length. → Task 3.
3. **Opacity leak** — a quoted file-handle string resurrects an attachment, or a quoted `[Pasted text #N]` splices paste content. → Task 5.
4. **Mid-line / inline `>` false positive** — `prose> …` mid-line is neither recognized nor rendered; an inline `>` chipifies. → Task 2 + Task 5.
5. **Projection chrome leak** — quoted text carries a button label, fold toggle, timer, status badge, or attachment-chip label, or loses block structure. → Task 4.

---

### Task 1: Quote text utilities

**Files:**
- Create: `src/utils/quote-text.ts`, `src/utils/quote-text.test.ts`.

**Interfaces:**
- Produces: `formatQuoteText(text: string): string` (normalize CRLF, one `> `-prefixed line per input line); `quoteTextOf(text: string): string` (strip one `^ {0,3}>[ \t]?` per line, normalize CRLF); `messageQuoteRanges(text: string): readonly MessageQuoteRange[]` (`{start,end}` UTF-16 spans of consecutive line-leading `^ {0,3}>` runs, global m-flag, nonblank after decode; inline `>` excluded). Tasks 2/4/5 consume these.

- [ ] **Step 1: Write failing tests** — formatQuoteText (multi-line, CRLF, empty line → `> `); quoteTextOf (strips one marker, nested `>>` keeps one, CRLF); messageQuoteRanges (line-leading runs anywhere, inline `prose> x` NOT a run, `^ {0,3}>` up-to-3-space indent, blank decoded run excluded, `----` not a quote).
- [ ] **Step 2: Run, verify FAIL** (`npx vitest run src/utils/quote-text.test.ts`).
- [ ] **Step 3: Implement** (port DSH `quote-text.ts` + `formatQuoteText`).
- [ ] **Step 4: Run, verify PASS** + typecheck.
- [ ] **Step 5: Commit.** `feat(quote): quote text utilities (format/decode/ranges)`

---

### Task 2: Token model — blockquote recognizer + exact-run serialization

**Files:**
- Modify: `src/utils/pastedText.ts` (tokenize quote recognizer + joinTokens serialization), `src/utils/pastedText.test.ts`.

**Interfaces:**
- Consumes: `messageQuoteRanges` (Task 1).
- Produces: a `quote` token kind `{ kind: 'quote', text: <exact matched run> }` recognized by `tokenize` from line-leading blockquote runs; `joinTokens` emits the exact run, guaranteeing line-leading (insert leading `\n` if the run would start mid-line) + a blank-line separator before following prose. `joinTokens(tokenize(s)) === s` preserved. Task 3 (bridge) and Task 5 (opacity) consume the quote token + its range.

- [ ] **Step 1: Write failing tests** — tokenize recognizes a line-leading blockquote run as ONE quote token carrying the exact run; joinTokens(tokenize(s))===s for: simple run, multi-line run, nested `>>`, missing space after `>`, trailing whitespace, run after prose (line-leading guaranteed), run before prose (blank-line separator), two adjacent runs, inline `>` NOT a token. The existing mention/file/text round-trips unchanged.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** the recognizer (use messageQuoteRanges; exact-run text) + joinTokens line-leading/separator logic. Keep the token's text === the exact source span (no normalization that breaks round-trip).
- [ ] **Step 4: Run, verify PASS** + the full pastedText round-trip suite + typecheck.
- [ ] **Step 5: Commit.** `feat(quote): tokenize blockquote runs + exact-run joinTokens`

---

### Task 3: Composer quote chip — DOM→text bridge extension

**Files:**
- Modify: `src/utils/richPromptDom.ts` (collectSegments/serializeTokens read data-quote-text; caret stop-point mapping uses serialization length; renderTokens quote chip; demoteCaretMentions multi-line whole-run), its tests.
- Create: `src/components/QuotePreview.tsx` (compact decoded-excerpt chip: quote-mark icon + clipped text + remove control + full-text hover popover; inert variant for sent), `src/components/QuotePreview.test.tsx`.
- Modify: `src/styles/` (quote chip CSS, theme vars both themes; reuse existing popover primitive).

**Interfaces:**
- Consumes: quote token (Task 2), `quoteTextOf` (Task 1).
- Produces: a settled quote chip DOM (`contenteditable=false`, `data-quote-text=<exact run>`, displays `quoteTextOf` excerpt) rendered by renderTokens; collectSegments/serializeTokens read `data-quote-text` for quote chips (value contribution = exact run); caret mapping uses serialization length; multi-line caret gate (caret entering de-chipifies whole run, leaving re-settles, atomic whole-run removal, arrows cross). QuotePreview shared by composer (removable) and sent (inert). Task 4 inserts via this; Task 5 reuses QuotePreview inert.

- [ ] **Step 1: Write failing tests** — collectSegments reads data-quote-text (value === exact run, NOT displayed excerpt); caret stop-point arithmetic uses serialization length for a quote chip (multi-line); renderTokens produces the decoded-excerpt chip with data-quote-text; caret entering a multi-line run de-chipifies the whole run to editable text, leaving re-settles; atomic Backspace/Delete removes whole run; arrow crosses settled chip; clipboard yields exact blockquote; QuotePreview clipped→popover, remove control (composer) vs inert (sent).
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** the bridge extension (quote chips read serialization, caret mapping), renderTokens quote chip, multi-line demoteCaretMentions, QuotePreview + CSS. Mention chip path unchanged.
- [ ] **Step 4: Run, verify PASS** + richPromptDom regression (mention/file chips unaffected) + typecheck + style guards.
- [ ] **Step 5: Commit.** `feat(quote): composer atomic quote chip + DOM-text bridge`

---

### Task 4: Selection projection + sources + floating Quote toolbar

**Files:**
- Create: `src/utils/text-selection.ts` (readTextSelection/selectedText projection, port DSH), `src/utils/text-selection.test.ts`.
- Create: `src/components/QuoteSelectionToolbar.tsx` (floating Quote button + placement/dismiss) or a `useQuoteSelection` hook, test.
- Modify: transcript message bodies / tool-result output / thinking blocks → `data-text-interaction-source`; tool-card chrome + attachment chips → `data-text-interaction-exclude` (MessageList / tool card components).

**Interfaces:**
- Consumes: composer quote insert (Task 3), `formatQuoteText` (Task 1).
- Produces: `readTextSelection(root, selection): TextSelection | null` (single non-collapsed range in one enabled source); `selectedText(selection): string | null` (visible projection: block tags→\n, cells→\t, soft breaks→space unless pre, exclude chrome). Floating Quote button shows on valid selection, places above/below clamped to visible bounds avoiding composer, dismisses on clear/Esc/pointerdown/blur; click inserts `formatQuoteText(selectedText)` as a quote run at the composer caret.

- [ ] **Step 1: Write failing tests** — readTextSelection (single source, cross-source null, collapsed null, excluded/hidden null); selectedText projection (block boundaries, soft breaks, pre preserved, chrome excluded: button/katex-mathml/aria-hidden/sr-only/attachment-chip/tool-card badge); floating button show on valid selection / dismiss paths / placement clamp; click inserts a quote chip at caret (integration with Task 3).
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** projection port, source/exclude marking on transcript surfaces, floating toolbar + insert.
- [ ] **Step 4: Run, verify PASS** + typecheck.
- [ ] **Step 5: Commit.** `feat(quote): selection projection + floating Quote toolbar`

---

### Task 5: Parser opacity + sent blockquote rendering

**Files:**
- Modify: `src/utils/outgoing-text.ts` (composeOutgoing skips expandPastedTextRefs/trim inside quote runs), its tests.
- Modify: `src/utils/file-blocks.ts` (splitUserContentSegments recognizes blockquote runs FIRST → quote segment, protected from splitFileHandleText/mention splitting), its tests.
- Modify: user-message rendering (render the quote segment as inert QuotePreview; adjacent paragraph separators inline space).

**Interfaces:**
- Consumes: `messageQuoteRanges`/`quoteTextOf` (Task 1), quote token ranges (Task 2), QuotePreview inert (Task 3).
- Produces: composeOutgoing leaves quote-run spans literal (no paste-ref expansion/trim inside); splitUserContentSegments emits a quote segment for line-leading runs (anywhere), protected from file-handle/mention re-parsing; sent rendering shows the inert chip; a quoted file-handle/paste-ref stays literal text.

- [ ] **Step 1: Write failing tests** — composeOutgoing: a quote containing `[Pasted text #N …]` is NOT expanded; a quote containing a file-handle string is NOT re-parsed; trimming preserves quote interior. splitUserContentSegments: a mid-text line-leading blockquote run → quote segment (not file/mention); a quoted file-handle stays literal; inline `>` not a quote; manual blockquote === selection quote rendering. Sent render: inert chip + inline-space separator.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** opacity threading (quote ranges through composeOutgoing + splitter) + quote segment rendering.
- [ ] **Step 4: Run, verify PASS** + outgoing/file-blocks regression (existing mention/file/paste handling unaffected) + typecheck.
- [ ] **Step 5: Commit.** `feat(quote): parser opacity + sent blockquote chip rendering`

---

### Task 6: Browser E2E + docs + verify

**Files:**
- Create: `tests/browser/select-to-quote.spec.ts`.
- Modify: `CLAUDE.md` (select-to-quote narrative), `playwright.app.config.ts` (testMatch).
- Create: `.agents/notes/implemented/feature/2026-11-24-select-to-quote.md`.
- Modify: spec Status → implemented.

**Interfaces:**
- Consumes: all shipped tasks.

- [ ] **Step 1: Write the E2E** (app-config fixture harness): select assistant prose / tool-output code → Quote button → composer chip → send → assert sent text is line-leading blockquote → sent renders inert quote chip; multi-line + code-block + CJK excerpt; draft reload restores chip; a quoted file-handle string does NOT resurrect an attachment. Zero uncaught page errors.
- [ ] **Step 2: Run** `npx playwright test tests/browser/select-to-quote.spec.ts --config playwright.app.config.ts` — iterate to green.
- [ ] **Step 3: Manual acceptance** (record): tool-card code quote, multi-paragraph quote, CJK quote, quoting own earlier message.
- [ ] **Step 4: Docs** — CLAUDE.md narrative; agent note (shipped names, the bridge-extension + opacity decisions); spec Status; `npm run verify:agent-notes` green.
- [ ] **Step 5: Full verify** — `npm run verify`. Pre-existing flaky server tests + app-panel-reshow browser failures are NOT this batch's regression; any OTHER failure is yours.
- [ ] **Step 6: Commit.** `feat(quote): browser E2E and architecture docs`
- [ ] **Step 7: Whole-branch review** — controller dispatches the final code-review (NOT the implementer).