# File Preview Polish — Design (wrap / line highlighting / fading band / frontmatter)

Date: 2026-11-24
Status: proposed (awaiting approval)
Agent Note: [.agents/notes/proposed/feature/2026-11-24-preview-polish.md](../../../.agents/notes/proposed/feature/2026-11-24-preview-polish.md)

## Intent

The file preview (ResourceModal → FilePreviewBody) already has #L line navigation,
static line highlight, git-snapshot auto-reload, markdown preview/source toggle, and
image Lightbox zoom. Four reading-polish gaps remain, all small and self-contained:
long lines force horizontal scrolling (no wrap toggle), the numbered code view is
uncolored plain text (no syntax highlighting), the navigation highlight is static (no
fading band), and YAML frontmatter renders as raw markdown instead of a field list.
This batch closes those four. PDF preview is a SEPARATE follow-up project (user-decided
split — PDF is a distinct larger subsystem with its own resource-inlining pipeline).

## Decided by the user

- Scope: these four items as ONE batch; PDF separate.
- (Playback approved; the specific defaults below marked [builder call] are mine.)

## Goals

1. **Wrap toggle**: a toggle in the numbered-code toolbar switches long-line wrapping
   (`white-space: pre` ↔ `pre-wrap`), `aria-pressed` state.
2. **Numbered-view syntax highlighting**: each code line is syntax-highlighted using
   the shared lowlight instance, without breaking multi-line constructs and without
   polluting copied text.
3. **Fading highlight band**: the navigation target/range highlight animates (fade in,
   hold, fade out ~2s) and re-triggers on each navigation, instead of a static class.
4. **Frontmatter field list**: markdown preview renders leading YAML frontmatter as a
   key/value field list (lazy yaml parser, verbatim fallback), body renders the rest.

## Non-goals (out of this batch)

- PDF preview (separate project), HTML rendering, renderer dropdown, fs.watch for
  external edits, dormant-session preview, explicit scroll-offset preservation.
- Per-line independent highlighting (breaks multi-line comments/strings) — explicitly
  rejected; whole-text highlight then line-split.

## Anti-goals (failure even if it "works")

- Copied text gains gutter numbers or highlight markup (copy must stay the raw code).
- Highlighting splits a multi-line token (block comment / template string) incorrectly.
- Wrap breaks line-number gutter alignment or the scroll-to-line math.
- Frontmatter parse failure crashes the preview (must fall back to verbatim).
- Highlighting an unknown language throws (must fall back to plain text).
- Startup bundle grows (yaml parser lazy; highlighting reuses the eager lowlight).

## Constraints

- Repo rules (CLAUDE.md): theme CSS variables in BOTH `:root` and `[data-theme="light"]`
  (no hex); no speculative defensive code (the fallbacks below are proven contract
  states: unknown language, parse failure); both tsconfigs typecheck; client tests
  happy-dom; the one lowlight instance (`src/utils/lowlight-instance.ts`) is the only
  highlighter — do NOT add a second (Shiki etc.).
- Copy cleanliness: gutter numbers are a CSS counter (`.code-line::before`), never in
  textContent; highlighted spans' textContent must equal the original line text.

## Architecture

### 1. Wrap toggle (NumberedCode)

`src/components/file-preview/NumberedCode.tsx`: add `wrap` state + an icon button in
`.code-block-bar` beside Copy (`aria-pressed`, title "Toggle word wrap"). The `<pre>`
gains a conditional class (e.g. `numbered-code-wrap`) flipping `white-space` `pre` ↔
`pre-wrap` in `src/styles/file-viewer.css`. Default wrap **ON** [builder call: DSH
parity, reading-friendly; changes the current nowrap default — user did not object].
The >MAX_NUMBERED_LINES CodeBlock fallback and the markdown source view get the same
toggle treatment if trivially shareable [builder call: scope of wrap beyond numbered
view]. Wrap state persistence (per-session localStorage vs none) [builder call].
The scroll-to-line effect already centers via scrollTop math; verify wrap (taller
lines) doesn't break centering — recompute on wrap change if a target is active.

### 2. Numbered-view syntax highlighting

New utility `highlightLines(lang: string | undefined, contents: string): ReactNode[]`
(location [builder call: src/utils/highlight-lines.ts]):
- Guard `isRegisteredLanguage(lang)`; unknown/absent → return plain per-line text nodes.
- **Language wiring (resolved at builder-check):** `FilePreviewBody` currently passes
  `splitFilePath(title).base || title` (a FILENAME like `Foo.tsx`) as `lang` — it has
  only ever been a toolbar label. Highlighting must resolve the language via
  `detectLanguage(path)` (repo rule: detection follows `path`, never the display
  `title`), NOT the filename, or the `isRegisteredLanguage` guard fails for every file.
  NumberedCode therefore takes a detected `lang` for highlighting AND a separate
  filename `label` for the `.code-block-lang` bar; FilePreviewBody passes
  `detectLanguage(path)` + the filename label.
- Highlight the WHOLE text once via the shared `lowlight.highlight(lang, contents)`
  (hast root), then split into per-line hast subtrees CARRYING the open-element stack
  across `\n` text nodes (so a span opened on line 3 and closed on line 5 renders
  correctly on each line). Render each line's subtree via `toJsxRuntime`
  (`hast-util-to-jsx-runtime`, already a dependency, used by markdown-cache).
- Memoize on (lang, contents). The MAX_NUMBERED_LINES=5000 cap keeps it bounded.
- `NumberedCode` renders `highlighted[i]` inside each `.code-line` span instead of raw
  text; the `data-line` anchor, target/range classes, and CSS-counter gutter are
  unchanged. Copy still reads `contents` (the raw string), so highlight never leaks.
- The >5000 fallback CodeBlock should also highlight [builder call: reuse the markdown
  rehypeHighlightLite path or highlightLines joined].
- The split algorithm (walk hast, split text nodes at newline, maintain element stack,
  emit per-line subtrees) is the main engineering; pin it with a multi-line-token test.

### 3. Fading highlight band

`src/styles/file-viewer.css`: replace the static `.code-line-target` /
`.code-line-in-range` background with a CSS keyframe animation (~2s: ease-in, hold
~0.6s at peak, fade out), DSH timing parity. Re-trigger on each navigation: key the
animated element/class on `revision` so a re-open replays the animation (React remount
or animation-name reset). [builder call: animate the target line's background directly
(simplest) vs a separate absolutely-positioned band element (DSH parity, survives
renderer re-renders) — recommend the direct background animation]. Wrap toggle may
clear the band early (DSH) [builder call: optional]. Range highlight uses the same
animation. Both themes define the band color via a theme variable.

### 4. Frontmatter field list

`FilePreviewBody.tsx` markdown branch (preview mode only): split leading frontmatter
with a `splitFrontmatter(contents): { frontmatter: string | null; body: string }`
helper (regex `^---\n … \n---` / `...`, DSH frontmatter.ts parity). Render a
`FrontmatterFields` component above `<Markdown text={body}>`:
- Lazy-load a yaml parser chunk (`import('yaml')`); parse to key/value pairs; render a
  definition-list/field table. Parse failure or non-object → verbatim `<pre>` fallback
  (proven contract state, not speculation).
- Source mode (`showSource`) renders the FULL original contents unchanged (frontmatter
  included) — the split is preview-only.
- `yaml` dependency added (lazy chunk, startup unaffected) [builder call: parser lib —
  `yaml` vs `js-yaml`].

## Alternatives that lost

- **Per-line independent highlighting.** Breaks multi-line comments/strings; rejected
  for whole-text highlight + line-split.
- **A second highlighter (Shiki).** DSH uses Shiki; we reuse the existing eager lowlight
  instance (CLAUDE.md: one lowlight instance) — no new highlighter, no startup cost.
- **Separate band element (DSH).** Considered; direct target-line background animation
  is simpler and sufficient [builder call may revisit].
- **Bundling PDF into this batch.** User split it out — distinct subsystem, own
  resource-inlining pipeline, deserves independent review.
- **Wrap default OFF (preserve current).** Chose ON for reading parity [builder call].

## Risks

- The hast line-split carrying span state is the load-bearing correctness piece; a
  naive HTML-string split by `\n` breaks spans. Multi-line-token tests are the net.
- Highlighting cost on large files: bounded by the 5000-line cap + memoization; verify
  no per-keystroke re-highlight (contents stable across refetch).
- Wrap changes line heights → scroll-to-line centering must recompute; test it.
- Frontmatter regex must not eat a leading `---` horizontal rule that isn't frontmatter
  (require a closing `---`/`...`); test the false-positive case.

## Testing

- Unit: highlightLines multi-line token (block comment / template string spanning lines)
  renders correctly per line; unknown language → plain; copy textContent === raw line;
  splitFrontmatter (valid, missing-close, leading-HR false positive, parse-failure
  fallback).
- Client (happy-dom): wrap toggle flips class + aria-pressed; scroll-to-line centers
  under wrap; fading band re-triggers on revision; frontmatter field list renders +
  verbatim fallback; source mode shows full contents.
- Browser E2E: open a code file → highlighted lines + wrap toggle + copy clean; navigate
  #L → fading band; open a markdown file with frontmatter → field list.
- Manual: a real multi-line-comment code file, a long-line file (wrap), a CJK-content
  file (highlight + wrap), a frontmatter markdown file.

## Left to the builder

Wrap default/persistence/scope, highlight utility location + split algorithm details,
band animation mechanism (direct vs element) + exact timing, frontmatter parser lib +
regex edges, >5000 fallback highlighting path — marked [builder call] above.