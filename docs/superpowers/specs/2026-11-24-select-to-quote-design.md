# Select-to-Quote — Design

Date: 2026-11-24
Status: implemented
Decision record: [.agents/notes/implemented/feature/2026-11-24-select-to-quote.md](../../../.agents/notes/implemented/feature/2026-11-24-select-to-quote.md)
Research: DSH `packages/client/ui-chat/src/client/chat/{text-selection,text-interaction}.ts`,
`packages/session/message-quotes/src/client/{quote-text,quote-rule}.ts`,
`packages/client/ui-primitives/src/{QuotePreview.tsx,markdown/quote-text.ts}`,
`packages/client/ui-conversation/src/client/input/editor/QuoteNode.tsx`.

## Intent

When reading a transcript, the user often wants to respond to a specific passage — a
snippet of the assistant's code, a sentence of its explanation, a tool's output, or
their own earlier words. Select-to-quote lets them select transcript text, click a
floating **Quote** button, and get an atomic quote chip in the composer that transmits
as a Markdown blockquote. The model receives the quoted passage as ordinary Markdown
context; the sent message renders the quote as a compact chip. High-value coding
gesture (DSH parity).

## Decided by the user

- Include select-to-quote as the next feature; **work directly on main, no worktree**.
- **Composer representation: DSH-style atomic chip** — decoded-excerpt compact chip
  (quote-mark icon + clipped text + remove control + full-text hover popover). This
  requires extending the DOM→text bridge (display ≠ serialization); hand-typed
  blockquotes also chipify; editing is whole-chip (atomic).
- **Selection sources: prose + tool output** — user/assistant message prose, tool-result
  output (Read/Bash code — the primary code-quoting surface), and thinking blocks;
  renderer chrome excluded.

## Goals

- Select transcript text → floating Quote button near the selection → click inserts an
  atomic quote chip into the composer at the caret.
- The composer chip shows a compact width-capped decoded excerpt (clipped → full-text
  popover), is removed as a whole unit (atomic Backspace/Delete), and restores with the
  draft (via `tokenize`, the text-string draft model).
- On send, the quote transmits in place as a Markdown blockquote (`> line` per line),
  line-leading so the model and renderer recognize it. **Zero server/protocol change.**
- The sent message renders blockquote runs as a compact quote chip (inert, no remove),
  sharing the composer chip's presentation. Hand-typed blockquotes render identically.
- Quoted text is the **visible projected text** (block boundaries preserved, renderer
  chrome excluded), not raw textContent.

## Non-goals (out of this cut)

- DSH's generic text-interaction plugin framework (focused Quote-only selection toolbar).
- `QuoteSummary` source-attribution machinery (label/title/detail/body) — plain excerpt
  only [builder call: lightweight source label later if useful].
- Right-click context-menu Quote entry (floating button primary; deferred).
- Quoting from non-transcript surfaces (file preview, diff panel).
- Subagent/Workflow/Skill overlay transcripts as selection sources [builder call: main
  panel transcript only this cut; overlays deferred].
- Nested-quote special handling (a quoted `>` is re-quoted line-by-line like any text).

## Anti-goals (failure even if it "works")

- The quote transmits as anything other than clean, line-leading Markdown blockquote
  text (model reads ordinary `> …`; no special tokens/protocol).
- Quoted text carries renderer chrome (button labels, copy icons, fold toggles, timers,
  status badges, KaTeX MathML, sr-only, attachment-chip labels) or loses block structure.
- A quoted passage containing `[Pasted text #N …]`-shaped text or a file-handle string
  is re-parsed by `expandPastedTextRefs` / `splitFileHandleText` (resurrecting an
  attachment or splicing paste content from inside a quote). Quotes must be OPAQUE to
  those parsers.
- The composer chip's value drifts from its serialization (display ≠ serialization must
  be bridged, not ignored): `joinTokens(tokenize(s)) === s` must hold, and the chip's
  contribution to the composer value must be its exact blockquote run, not its displayed
  excerpt.
- A manually-typed blockquote and a selection-inserted quote render differently.
- Draft persistence loses the quote (reload restores the chip via `tokenize`).
- The floating button appears for collapsed / cross-source / excluded selections, or
  stays stuck after the selection clears / scrolls away.
- Startup bundle grows.

## Constraints

- Repo rules (CLAUDE.md): theme CSS variables in BOTH `:root` and `[data-theme="light"]`
  (no hex); no speculative defensive code; both tsconfigs typecheck; client tests
  happy-dom; startup bundle must not grow.
- The composer is **text-string-driven**: the draft is a raw string (sessionStorage
  `DRAFT_KEY_PREFIX`); chips are a pure function `tokenize(value)` → reconcile →
  `renderTokens` (`RichPromptInput.tsx`). There is NO out-of-band chip state. A quote
  chip therefore requires `tokenize` (`src/utils/pastedText.ts`) to recognize blockquote
  runs — so hand-typed `> …` chipifies too (user-accepted).
- The mention chip works because its textContent IS its serialization (`@path`);
  `collectSegments` (`src/utils/richPromptDom.ts`) reads textContent as the chip's value
  contribution and the caret arithmetic is built on that equality. A decoded-excerpt
  quote chip breaks that equality, so the bridge must be extended (see Architecture §3).
- Model-visible format = DSH `formatQuoteText` (normalize CRLF, one `> `-prefixed line
  per input line); decode = `quoteTextOf` (strip one `^ {0,3}>[ \t]?` per line);
  recognition = `messageQuoteRanges` (line-leading `^ {0,3}>` runs, global m-flag,
  anywhere in the text — NOT message-anchored).

## Architecture

### 1. Selection detection + visible-text projection

Port DSH `text-selection.ts` (self-contained, no deps), scoped to our transcript:
- Selection sources (`data-text-interaction-source`): user-message prose, assistant
  markdown body, tool-result output bodies (Read/Bash/etc.), thinking blocks. NOT the
  tool-card chrome (header, fold toggle, timer, status badge), NOT attachment chips.
- `readTextSelection(root, selection)`: single non-collapsed range in ONE enabled source;
  null across sources / excluded / hidden / inert.
- `selectedText(selection)`: project selected DOM to visible text — block tags → `\n`,
  cells → `\t`, soft breaks → space (unless pre/pre-wrap); exclude chrome (buttons
  outside code, `.katex-mathml`, `aria-hidden`, `.sr-only`,
  `[data-text-interaction-exclude]`, attachment-chip nodes). Trim; empty → null.
- Mark tool-card chrome and attachment chips `data-text-interaction-exclude` so a
  selection spanning them drops their text [builder call: exact exclusion markers].

### 2. Floating Quote button (focused selection toolbar)

A lightweight selection listener on the transcript scroll area (not DSH's plugin
framework): on selectionchange/pointerup/Shift+arrow keyup, read the selection; valid +
non-empty projected text → show a floating Quote button (portal, theme vars,
`aria-label="Quote selection"`). Placement: prefer above the selection rect, fall back
below; clamp to visible scroll bounds; avoid the composer; reposition on scroll/resize;
dismiss on selection clear / Escape / pointerdown elsewhere / window blur. Click:
capture `selectedText`, clear selection, insert the quote chip at the composer caret,
focus composer, dismiss button.

### 3. Composer atomic quote chip — the DOM→text bridge extension

This is the load-bearing integration (NOT a free "reuse"):
- **Token**: `tokenize` gains a line-based blockquote-run recognizer (port
  `messageQuoteRanges`). A quote token carries the **exact matched run text** (the
  `> …` lines verbatim, including markers/whitespace) so `joinTokens(tokenize(s)) === s`
  holds (the model's pinned round-trip invariant). `joinTokens` emits the exact run; a
  quote run is guaranteed line-leading (a leading `\n` is inserted if the run would
  otherwise start mid-line) and separated from following prose by a blank line.
- **Display ≠ serialization bridge**: the settled chip DOM shows the DECODED excerpt
  (`quoteTextOf`, no `>` markers) + quote-mark icon + remove control, width-capped and
  clipped (full-text popover when clipped). The chip carries its exact serialization in
  a data attribute (`data-quote-text`). `collectSegments` / `serializeTokens` read that
  attribute (NOT textContent) for a quote chip's value contribution; the caret
  stop-point mapping uses the serialization length for quote chips. This is a real
  extension of the single DOM→text walk + caret arithmetic (mention chips keep their
  textContent===serialization path unchanged).
- **Forming / settled / editing** (multi-line caret gate, DSH-parity atomic): a quote
  run is a settled chip when the caret is OUTSIDE it; the caret entering the run
  de-chipifies the WHOLE run to editable blockquote text (the existing
  `demoteCaretMentions` whole-token demotion, extended to multi-line runs); the caret
  leaving re-settles it. Atomic Backspace/Delete at the chip boundary removes the whole
  run; arrow keys cross a settled chip without entering. Editing inside a quote means
  editing the raw `> …` text (then it re-settles) — there is no in-chip character editing
  (user-accepted, DSH parity).
- **Insert from selection**: the Quote button inserts `formatQuoteText(selectedText)`
  as a quote run at the caret (line-leading + blank-line separator), which `tokenize`
  recognizes → settled chip.
- **Draft restore**: the draft is the raw string; on reload `tokenize` re-recognizes the
  blockquote run → chip. No separate persistence mechanism (corrects the earlier
  IndexedDB-chip premise).
- **Clipboard**: copying a settled quote chip yields its exact Markdown blockquote
  (`data-quote-text`), DSH QuoteNode parity.

### 4. Serialization, transmission, and parser opacity

- **In place, not hoisted**: the quote stays at the caret position the user chose (the
  earlier "prepend" wording is dropped). `joinTokens` guarantees a line-leading run +
  blank-line separator so a quote after prose is `prose\n\n> …` (recognized), never
  `prose> …` (mid-line, unrecognized).
- **Zero server change**: the sent text is the blockquote run + separator + prose; the
  existing `POST /sessions/:id/messages` text path carries it; the model reads Markdown.
- **Opacity threading** (required for the anti-goal): quote ranges are threaded through
  `composeOutgoing` (`src/utils/outgoing-text.ts`) so `expandPastedTextRefs` and trimming
  SKIP quote-run spans, and through `splitUserContentSegments`
  (`src/utils/file-blocks.ts`) so blockquote runs are recognized FIRST and protected
  from `splitFileHandleText` / mention splitting. A quoted file-handle or paste-ref
  string stays literal text inside the quote. This is real integration work (the
  parsers currently take plain strings); it is in scope.

### 5. Sent blockquote rendering

Extend `splitUserContentSegments` with a quote segment: recognize line-leading
blockquote runs (`messageQuoteRanges`, anywhere in the text) → a quote segment carrying
the decoded excerpt (`quoteTextOf`); render as the same compact QuotePreview chip, inert
(no remove). Adjacent paragraph separators render as inline space (DSH quote-rule
parity) so the quote flows with following prose. A manually-typed blockquote renders
identically (same recognition). Inline `>` not at line start stays ordinary text.

## Alternatives that lost

- **Special quote content block / server protocol.** Model reads Markdown blockquote
  natively; rejected (plain Markdown, DSH parity).
- **Composer holds editable blockquote text (chip only in sent).** Lighter (no bridge
  extension), but the user chose the DSH-style atomic composer chip. Rejected by decision.
- **Raw-blockquote-textContent chip (CSS-clipped, shows `>`).** Keeps textContent===
  serialization (no bridge), but shows `>` markers, not the DSH decoded-excerpt look the
  user chose. Rejected by decision.
- **Porting DSH's generic plugin framework / Lexical.** Overhead / wrong editor; focused
  toolbar + our chip model. Rejected.
- **Raw textContent slice for the quote.** Carries chrome / loses structure. Rejected —
  visible-text projection.
- **QuoteSummary source attribution first cut.** Defer (YAGNI).

## Risks

- **Bridge correctness**: display≠serialization for quote chips must keep
  `joinTokens(tokenize(s))===s` AND the caret arithmetic consistent (serialization
  length, not displayed length). This is the hardest piece; pin with round-trip + caret
  tests across multi-line runs, nested `>`, missing space after `>`, trailing whitespace.
- **Multi-line caret gate**: whole-run demotion on caret entry must not flicker
  destructively or lose text; pin forming/settled transitions.
- **Parser opacity**: threading quote ranges through `composeOutgoing` + the splitter
  must not break existing mention/file/paste handling; pin a quoted-file-handle and
  quoted-paste-ref staying literal.
- **Projection fidelity**: our transcript DOM (code blocks, tables, KaTeX, tool cards)
  differs from DSH's; the block-tag walk + chrome exclusion must match. Test against real
  rendered messages incl. tool output.
- **Floating placement**: scroll/resize/composer-avoidance must not leave a stuck button.
- **Blockquote false positives**: inline `>` (mid-line) must NOT chipify; only line-leading
  `^ {0,3}>` runs.

## Testing

- Unit (node): `formatQuoteText`/`quoteTextOf`/`messageQuoteRanges` (CRLF, multi-line,
  inline `>` not a quote, nested `>`, missing space, trailing whitespace);
  `tokenize`/`joinTokens` round-trip incl. quote runs (the pinned invariant);
  parser-opacity (quoted file-handle / paste-ref stays literal through composeOutgoing +
  splitter).
- Client (happy-dom): projection (block boundaries, chrome exclusion, cross-source null,
  collapsed null, tool-output source); floating button show/dismiss/placement; composer
  quote chip display≠serialization bridge (collectSegments reads data-quote-text, caret
  mapping), atomic removal, caret cross, multi-line forming/settled, draft restore via
  tokenize; sent blockquote segment (inert chip) + manual-blockquote parity.
- Browser E2E (playwright.app.config.ts): select assistant prose / tool-output code →
  Quote button → chip → send → assert sent text is line-leading blockquote → sent renders
  quote chip; multi-line + code-block + CJK excerpt; draft reload restores chip; a quoted
  file-handle string does NOT resurrect an attachment.
- Manual: a real code-block quote from a tool card, a multi-paragraph quote, a CJK quote,
  quoting own earlier message.

## Left to the builder

Exact chrome-exclusion markers on tool cards/attachment chips; overlay transcripts
(deferred); QuoteSummary source label (deferred); context-menu entry (deferred);
copy-of-sent-quote format (excerpt vs blockquote, pick one); popover primitive reuse;
exact chip DOM/CSS on our primitives — marked [builder call] above.