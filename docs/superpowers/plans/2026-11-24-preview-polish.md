# File Preview Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four reading-polish features to the file preview: a wrap toggle, numbered-view syntax highlighting, a fading navigation highlight band, and a YAML frontmatter field list.

**Architecture:** A new `highlightLines` utility highlights whole text via the shared eager lowlight instance and splits the hast into per-line React nodes carrying span state across newlines; NumberedCode consumes it (language resolved via `detectLanguage(path)`, filename kept as a separate bar label). Wrap toggle and fading band are NumberedCode/CSS changes. Frontmatter is split in FilePreviewBody's markdown preview branch and rendered by a lazy-yaml field-list component.

**Tech Stack:** React 19, TypeScript, lowlight (existing `src/utils/lowlight-instance.ts`), hast-util-to-jsx-runtime (existing dep), yaml (new, lazy chunk), vitest (happy-dom client), Playwright.

**Spec:** `docs/superpowers/specs/2026-11-24-preview-polish-design.md` (read fully; agent note `.agents/notes/proposed/feature/2026-11-24-preview-polish.md`).

## Global Constraints

- ONE lowlight instance (`src/utils/lowlight-instance.ts`) — do NOT add a second highlighter (Shiki etc.).
- Copy stays clean: copied text === raw code; gutter numbers are a CSS counter (`.code-line::before`), never in textContent; highlighted spans' textContent === original line text.
- Highlighting: whole-text highlight then per-line split CARRYING open-element span state across `\n` — NEVER per-line independent highlight (breaks multi-line comments/strings).
- Language wiring: highlight language via `detectLanguage(path)` (`src/utils/file-display.ts:170`, returns `string|null`), NEVER the display title/filename; filename is a separate bar label.
- Guard `isRegisteredLanguage(lang)`; unknown/absent language → plain per-line text, no throw.
- Wrap default ON; toggles `white-space` `pre`↔`pre-wrap`; must not break gutter alignment or scroll-to-line centering.
- Fading band ~2s (ease-in → hold ~0.6s → fade), re-triggers on each navigation revision; band color via theme variable in BOTH `:root` and `[data-theme="light"]` (no hex).
- Frontmatter: preview-mode only; leading `---`/`...` block requires a closing delimiter (a leading `---` horizontal rule without close is NOT frontmatter); lazy yaml parser; parse failure / non-object → verbatim fallback; source mode renders full original contents.
- No speculative defensive code (the unknown-language / parse-failure fallbacks are proven contract states). Both tsconfigs typecheck; client tests happy-dom; startup bundle must not grow (yaml lazy; lowlight already eager).
- Every commit message ends with: `Co-Authored-By: Claude Code <noreply@anthropic.com>`

## Review Focus

1. **Multi-line token split** — a block comment / template string spanning lines 3–5 must render highlighted correctly on EACH line (span state carried), not break or drop. → Task 1 test.
2. **Copy cleanliness** — copying a highlighted numbered view yields the raw code exactly (no gutter numbers, no highlight markup). → Task 2 test.
3. **Unknown language** — a `.xyz` file (detectLanguage null / unregistered) renders plain text, no throw. → Task 1 + Task 2 test.
4. **Wrap + navigation** — with wrap ON (taller lines), #L scroll-to-line still centers the target. → Task 3 test.
5. **Frontmatter false positive + failure** — a leading `---` HR without a closing delimiter is NOT eaten; invalid YAML falls back to verbatim, no crash. → Task 5 test.

---

### Task 1: highlightLines utility

**Files:**
- Create: `src/utils/highlight-lines.ts`
- Test: `src/utils/highlight-lines.test.tsx`

**Interfaces:**
- Consumes: `lowlight` + `isRegisteredLanguage` (`src/utils/lowlight-instance.ts`); `toJsxRuntime` (`hast-util-to-jsx-runtime`).
- Produces: `highlightLines(lang: string | undefined, contents: string): ReactNode[]` — one ReactNode per source line (trailing phantom newline dropped, matching NumberedCode's line split). Unknown/unregistered lang → plain text nodes. Highlighted nodes' combined textContent === contents (minus phantom trailing newline).

- [ ] **Step 1: Write failing tests** — `highlight-lines.test.tsx`:
  - multi-line block comment `/* a\nb\nc */` (lang 'javascript'): render each line node to static markup, assert line 2 contains 'b' wrapped in the comment span class (span state carried), and joined textContent === original.
  - template string spanning lines similarly.
  - unknown lang ('xyz' / undefined) → plain text nodes, textContent === contents, no throw.
  - trailing newline: `'a\nb\n'` → 2 line nodes (no phantom 3rd).
  - empty contents → `[]` or one empty node consistently with NumberedCode.
- [ ] **Step 2: Run, verify FAIL** (`npx vitest run src/utils/highlight-lines.test.tsx` — module missing).
- [ ] **Step 3: Implement** `highlightLines`: guard isRegisteredLanguage; `lowlight.highlight(lang, contents)` → hast root; walk the hast splitting text nodes at `\n` while maintaining an open-element stack, building per-line hast subtrees; render each via toJsxRuntime. (The split algorithm is the engineering — pin it with the multi-line tests.) Memoization is the caller's job (Task 2).
- [ ] **Step 4: Run, verify PASS** + typecheck.
- [ ] **Step 5: Commit.** `feat(preview): highlightLines utility (whole-text lowlight + per-line split)`

---

### Task 2: NumberedCode highlighting + language wiring

**Files:**
- Modify: `src/components/file-preview/NumberedCode.tsx` (Props, renderedLines, bar label)
- Modify: `src/components/file-preview/FilePreviewBody.tsx:134-140` (pass detected lang + filename label)
- Test: `src/components/file-preview/NumberedCode.test.tsx` (create/extend)

**Interfaces:**
- Consumes: `highlightLines` (Task 1); `detectLanguage`, `splitFilePath` (`src/utils/file-display.ts`).
- Produces: NumberedCode Props gains `label?: string` (bar label); `lang` now means the DETECTED language (string|undefined). FilePreviewBody passes `lang={detectLanguage(path) ?? undefined}` and `label={splitFilePath(title).base || title}`. The `.code-block-lang` bar shows `label ?? lang ?? 'code'`.

- [ ] **Step 1: Write failing tests**:
  - rendered code lines contain highlight spans for a known language (e.g. javascript keyword span).
  - copy: `useCopy` copies `contents` raw — assert copied text === contents (no gutter/markup) (Review Focus 2).
  - unknown language (lang undefined) → plain text lines, no throw (Review Focus 3).
  - bar label shows the filename `label`, not the detected lang.
  - >MAX_NUMBERED_LINES fallback still renders (and highlights via the markdown path or joined highlightLines).
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement**: NumberedCode `renderedLines` memo calls `highlightLines(lang, contents)` (memoized on lang+contents) and places `highlighted[i]` inside each `.code-line` span (data-line/target/range classes unchanged). Add `label` prop; bar shows label. FilePreviewBody passes detected lang + filename label. Keep copy reading `contents`.
- [ ] **Step 4: Run, verify PASS** + FilePreviewBody/NumberedCode regression + typecheck.
- [ ] **Step 5: Commit.** `feat(preview): numbered-view syntax highlighting + detectLanguage wiring`

---

### Task 3: Wrap toggle

**Files:**
- Modify: `src/components/file-preview/NumberedCode.tsx` (wrap state + button + pre class)
- Modify: `src/styles/file-viewer.css` (`.numbered-code-wrap` white-space; gutter alignment under wrap)
- Test: `src/components/file-preview/NumberedCode.test.tsx` (extend)

**Interfaces:**
- Consumes: NumberedCode (Task 2).
- Produces: a wrap toggle button in `.code-block-bar` beside Copy (`aria-pressed`, title "Toggle word wrap"); default wrap ON; `<pre>` gains `numbered-code-wrap` class when ON (`white-space: pre-wrap`), OFF → `pre`.

- [ ] **Step 1: Write failing tests**:
  - default wrap ON: pre has `numbered-code-wrap` class, button aria-pressed=true.
  - click toggles class off/on + aria-pressed.
  - wrap ON + a `line` target: scroll-to-line effect centers the target (recompute under taller lines) (Review Focus 4).
  - gutter numbers stay aligned under wrap (CSS counter intact).
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** wrap state (default true) + icon button + conditional pre class; CSS `.numbered-code-wrap { white-space: pre-wrap }` (and `overflow-wrap` for unbreakable tokens [builder call]); ensure the scroll-to-line effect recomputes when wrap changes with an active target. Wrap persistence/scope beyond numbered view [builder call].
- [ ] **Step 4: Run, verify PASS** + typecheck.
- [ ] **Step 5: Commit.** `feat(preview): wrap toggle for numbered code view`

---

### Task 4: Fading highlight band

**Files:**
- Modify: `src/styles/file-viewer.css` (`.code-line-target`/`.code-line-in-range` keyframe animation + theme variable)
- Modify: `src/components/file-preview/NumberedCode.tsx` (re-trigger animation on revision)
- Test: `src/components/file-preview/NumberedCode.test.tsx` (extend)

**Interfaces:**
- Consumes: NumberedCode target/range classes + revision (Task 2/3).
- Produces: target/range highlight animates (~2s ease-in → hold ~0.6s → fade) via CSS keyframe; re-triggers on each revision bump (key the animated span/class on revision so a re-open replays). Band color via a theme variable defined in both themes.

- [ ] **Step 1: Write failing tests**:
  - target line carries the animation class/style; a revision bump re-triggers (key change remounts/resets animation).
  - same-content refetch (revision unchanged) does NOT replay.
  - range lines animate too.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** CSS keyframe on `.code-line-target`/`.code-line-in-range` background (theme variable, both themes); NumberedCode keys the target span (or animation reset) on revision so navigation replays. Direct background animation (not a separate band element) [builder call confirmed].
- [ ] **Step 4: Run, verify PASS** + typecheck + style-guard tests.
- [ ] **Step 5: Commit.** `feat(preview): fading navigation highlight band`

---

### Task 5: Frontmatter field list

**Files:**
- Create: `src/utils/frontmatter.ts` (`splitFrontmatter`)
- Create: `src/components/file-preview/FrontmatterFields.tsx` (lazy yaml field list)
- Modify: `src/components/file-preview/FilePreviewBody.tsx:100-122` (markdown preview branch)
- Modify: `package.json` (add `yaml` dependency)
- Test: `src/utils/frontmatter.test.ts`, `src/components/file-preview/FrontmatterFields.test.tsx`

**Interfaces:**
- Consumes: FilePreviewBody markdown branch (contents, showSource).
- Produces:
  - `splitFrontmatter(contents: string): { frontmatter: string | null; body: string }` — leading `---\n…\n---`/`...` block (closing delimiter REQUIRED); else frontmatter null, body = contents.
  - `FrontmatterFields({ source }: { source: string })` — lazy `import('yaml')` parse → key/value field list; parse failure / non-object → verbatim `<pre>` fallback.
  - FilePreviewBody preview branch renders `<FrontmatterFields source={frontmatter}/>` (when non-null) above `<Markdown text={body}/>`; source mode renders full `contents` unchanged.

- [ ] **Step 1: Write failing tests**:
  - splitFrontmatter: valid `---\ntitle: x\n---\nbody` → {frontmatter:'title: x', body:'body'}; leading `---` HR without close → {null, original}; `...` close variant; CRLF handled.
  - FrontmatterFields: valid YAML → field rows (key/value); invalid YAML → verbatim pre, no crash; non-scalar values stringified [builder call]; nested object rendered readably.
  - FilePreviewBody: markdown with frontmatter → field list + body markdown; source mode → full contents incl frontmatter.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** splitFrontmatter (regex, closing required), FrontmatterFields (lazy yaml, verbatim fallback), FilePreviewBody preview-branch integration. Add `yaml` dep (lazy chunk).
- [ ] **Step 4: Run, verify PASS** + FilePreviewBody regression + typecheck + `npm run analyze:bundle` (yaml lazy, startup unchanged).
- [ ] **Step 5: Commit.** `feat(preview): YAML frontmatter field list in markdown preview`

---

### Task 6: Browser E2E + docs

**Files:**
- Create: `tests/browser/preview-polish.spec.ts`
- Modify: `CLAUDE.md` (file-preview narrative)
- Move: `.agents/notes/proposed/feature/2026-11-24-preview-polish.md` → `implemented/feature/` (Status implemented, facts to shipped names)
- Modify: spec Status → implemented

**Interfaces:**
- Consumes: all shipped tasks.

- [ ] **Step 1: Write the E2E** (playwright.app.config.ts fixture pattern): open a code file → highlighted lines + wrap toggle flips + copy yields raw code; navigate #L → fading band present; open a markdown file with frontmatter → field list rendered. Assert each.
- [ ] **Step 2: Run** `npx playwright test tests/browser/preview-polish.spec.ts --config playwright.app.config.ts` — iterate to green.
- [ ] **Step 3: Manual acceptance** (record): multi-line-comment code file, long-line file (wrap), CJK-content file (highlight + wrap), frontmatter markdown file.
- [ ] **Step 4: Docs** — CLAUDE.md narrative; move + update note (Status implemented); spec Status; `npm run verify:agent-notes` green.
- [ ] **Step 5: Full verify** — `npm run verify` green.
- [ ] **Step 6: Commit.** `feat(preview): browser E2E and architecture docs` + note move.
- [ ] **Step 7: Whole-branch review** — controller dispatches the final code-review (NOT the implementer).