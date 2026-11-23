# @file / @folder Composer References Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Typing `@` in the composer opens a file/folder candidate menu whose picks insert atomic chips serializing to plain `@path` text the model reads itself, with click-to-preview and sent-message chip rendering.

**Architecture:** A shared mention grammar feeds a new composer token kind that round-trips through the existing contenteditable chip machinery (caret-aware so the forming query stays editable). A session-scoped search endpoint (git ls-files + fs-walk fallback) feeds a lazy picker isomorphic to the slash picker. A system-prompt guidance section (spawn+resume, both providers) tells the model to read referenced paths. Chips open the existing ResourceModal; sent messages render mentions as clickable chips.

**Tech Stack:** TypeScript, React 19 (contenteditable rich composer), Hono, vitest (happy-dom client / Node server), Playwright, existing runGit / ResourceModal / SDK preset-append systemPrompt.

**Spec:** `docs/superpowers/specs/2026-11-23-file-reference-design.md` (read fully; the agent note `.agents/notes/proposed/feature/2026-11-23-file-reference.md` carries rationale).

## Global Constraints

- DSH-original grammar: ANY `@non-space` chipifies (incl. prose `@bob`); matcher `(?<!\S)(@"[^"\n]+"|@[^\s]+)`; NO path-shape constraint, NO existence validation (deleted/bogus path → preview read-failed frame).
- Canonical separator `/`; input accepts `\`, normalized to `/` at format time BEFORE quoting (so `@"my dir/"`, never `\"`); trailing `/` (or input `\`) = directory; whitespace forces quotes; control chars + embedded quotes rejected; drive-letter absolute paths preserved.
- Chipification is caret-aware: the mention token containing the caret (forming trigger word) renders as editable TEXT; settled mentions (picked/pasted/restored/caret-departed) render as chips.
- Model receives plain `@path` text + guidance; NEVER file content; guidance applied at spawn AND resume (claude preset-append `{type:'preset',preset:'claude_code',append,snapshot:false}`) and native `systemPromptAppend`; must COMPOSE with persona (`Options.agent`) prompt, never replace — probe SDK precedence first.
- Search: git-first (`ls-files -z --cached --others --exclude-standard`, respects .gitignore) + bounded fs-walk fallback (non-repo); session-scoped, dormant-capable (cwd from meta); path containment (`isPathInside`); never reads file contents; ≤20 results.
- Paths pinned to session cwd (`meta.cwd`); model-initiated EnterWorktree divergence is an accepted limitation (do NOT add worktree-following).
- Repo rules: theme CSS vars in BOTH `:root` and `[data-theme="light"]`; no speculative defensive code; `createLogger` server diagnostics; git never via shell (`runGit`); both tsconfigs typecheck; picker/menu lazy (startup bundle unchanged).
- Every commit message ends with: `Co-Authored-By: Claude Code <noreply@anthropic.com>`

## Review Focus

1. **Caret inside a forming mention** (`@sr|c`) — stays editable text, Backspace deletes one char (not atomic chip), browser undo intact; chipifies only after caret departs. → Task 2 test.
2. **Spaces + Windows backslash + quoted dir** (`my dir\`, `D:\codes\x.ts`) — grammar normalizes to `@"my dir/"` / `D:/codes/x.ts`, round-trips, no `\"` quote collision. → Task 1 test.
3. **Mention mixed with paste-ref chips** (`@src/a.ts [Pasted text #1] @b.ts`) — tokenize/joinTokens round-trip preserves both kinds, no splicing. → Task 2 test.
4. **Search: non-repo cwd, huge repo, escape attempt** (`q=../../etc`) — fs-walk fallback works, results bounded, containment rejects root escape, no file contents read. → Task 3 test.
5. **Resume + persona** — guidance present after resume; a custom-agent session keeps its persona prompt alongside guidance (not clobbered). → Task 5 test.

---

### Task 1: Mention grammar (shared)

**Files:**
- Create: `shared/file-mention.ts`
- Test: `shared/file-mention.test.ts`

**Interfaces:**
- Produces:
  - `formatFileMention(path: string, isDir: boolean): string` — canonical `@path` / `@"path with spaces"` / `@dir/`; normalizes `\`→`/` before quoting; trailing `/` for dir; rejects control chars/embedded quotes (throw).
  - `parseFileMention(token: string): { path: string; dir: boolean } | null` — inverse; accepts `@path`, `@"quoted"`, trailing `/`; returns null for non-mentions.
  - `MENTION_PATTERN: RegExp` — the DSH matcher `(?<!\S)(@"[^"\n]+"|@[^\s]+)` for scanning text (global flag variant exported as `MENTION_PATTERN_G`).
  - `normalizeMentionPath(path: string): string` — `\`→`/`, collapse redundant separators (NOT `..` resolution — containment is the server's job).

- [ ] **Step 1: Write failing tests** — `shared/file-mention.test.ts`:
  - `formatFileMention('src/a.ts', false)` → `'@src/a.ts'`
  - `formatFileMention('my dir/a.ts', false)` → `'@"my dir/a.ts"'`
  - `formatFileMention('src/utils', true)` → `'@src/utils/'`
  - `formatFileMention('my dir', true)` → `'@"my dir/"'` (no `\"` collision)
  - `formatFileMention('src\\a.ts', false)` → `'@src/a.ts'`; `formatFileMention('D:\\codes\\x.ts', false)` → `'@D:/codes/x.ts'`
  - `formatFileMention('a\tb', false)` throws (control char); `formatFileMention('a"b', false)` throws (embedded quote)
  - `parseFileMention('@src/a.ts')` → `{path:'src/a.ts',dir:false}`; `parseFileMention('@"my dir/"')` → `{path:'my dir',dir:true}`; `parseFileMention('@bob')` → `{path:'bob',dir:false}`; `parseFileMention('hello')` → null
  - round-trip: `parseFileMention(formatFileMention(p,d))` recovers normalized `p`,`d` for the cases above
  - `MENTION_PATTERN_G` finds `@bob`, `@src/a.ts`, `@"my dir/"` in `'hi @bob see @src/a.ts and @"my dir/"'` (3 matches), not `email@x` (no preceding whitespace boundary)

- [ ] **Step 2: Run, verify FAIL** (`npx vitest run shared/file-mention.test.ts` — module missing).
- [ ] **Step 3: Implement** `shared/file-mention.ts` per signatures. Normalization before quoting; quote iff whitespace present; dir → ensure single trailing `/`.
- [ ] **Step 4: Run, verify PASS** + `npm run typecheck`.
- [ ] **Step 5: Commit.** `feat(reference): shared @file mention grammar`

---

### Task 2: Composer token model + caret-aware chip round-trip

**Files:**
- Modify: `src/utils/pastedText.ts:109-135` (PastedTextToken, tokenize, joinTokens)
- Modify: `src/utils/richPromptDom.ts:28-29,100-231` (chip consts, collectSegments, renderTokens, serializeTokens)
- Modify: `src/components/RichPromptInput.tsx:245-307` (domRepresentsValue + reconcile caret gate)
- Test: `src/utils/pastedText.test.ts` (extend), `src/utils/richPromptDom.test.ts` (extend or create), `src/components/RichPromptInput.mention.test.tsx` (create)

**Interfaces:**
- Consumes: `formatFileMention`/`parseFileMention`/`MENTION_PATTERN_G` (Task 1).
- Produces:
  - `PastedTextToken` gains `| { kind: 'mention'; text: string; path: string; dir: boolean }` (`text` = the formatted `@path` mention, which is also its serialized form).
  - `tokenize(text)` now splits on BOTH paste-refs and mentions (document order, no overlap); `joinTokens` maps mention→`text`.
  - `renderTokens` draws a mention chip `<span class="file-mention-chip" data-file-mention="<encoded path>" data-dir="0|1" contenteditable="false">@path</span>` (consts `MENTION_CHIP_CLASS`/`MENTION_CHIP_ATTR` exported from richPromptDom).
  - `serializeTokens` reads a mention chip back to `{kind:'mention',...}` via its data attrs (label text is the mention).
  - `domRepresentsValue(el, tokens, caretOffset?)` — a mention token whose serialized range contains `caretOffset` is treated as TEXT (not a chip) for the equality check, so reconcile leaves the forming word editable.

- [ ] **Step 1: Write failing tests**:
  - pastedText: `tokenize('@src/a.ts hi')` → `[mention(src/a.ts), text(' hi')]`; `joinTokens(tokenize(s))===s` for `'@bob [Pasted text #1] @src/a.ts'` (Review Focus 3); `tokenize('email@x')` → single text token (no boundary match).
  - richPromptDom: render→serialize round-trip for a mention chip preserves path/dir; mixed text+mention+paste-ref round-trips.
  - RichPromptInput (happy-dom): typing `@sr` with caret at end keeps it editable text (no `.file-mention-chip` in DOM, Backspace deletes one char); after caret departs (insert a space / move caret away) the settled `@sr` reconciles to a chip; a picked mention (inserted via handle) is a chip immediately. (Review Focus 1.)
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** the token kind + tokenize/joinTokens + renderTokens/serializeTokens/collectSegments + caret-aware domRepresentsValue/reconcile. The reconcile effect passes the current caret offset; a mention spanning the caret renders as text.
- [ ] **Step 4: Run, verify PASS** + existing pastedText/richPrompt/RichPromptInput suites (no regression) + typecheck.
- [ ] **Step 5: Commit.** `feat(reference): composer mention token with caret-aware chip round-trip`

---

### Task 3: File-search endpoint (server)

**Files:**
- Create: `server/file-search.ts` (search logic: git-first + walk fallback + rank)
- Modify: `server/routes/sessions.ts` (add `GET /sessions/:id/file-search`)
- Test: `server/file-search.test.ts`

**Interfaces:**
- Consumes: `runGit(cwd, args, opts)` (`server/git.ts:146`, result `{stdout,stderr,exitCode}`, opts `allowExitCodes`/`maxBuffer`/`timeoutMs`); `isPathInside` (`shared/app-plugins/path-security`); session meta cwd (dormant-capable lookup pattern from terminal ops).
- Produces:
  - `searchFiles(cwd: string, q: string, limit = 20): Promise<{ path: string; dir: boolean }[]>` — git repo → `runGit(cwd, ['ls-files','-z','--cached','--others','--exclude-standard'])` (NUL-split); non-repo/git-fail → bounded fs walk (basename exclusion `.git`,`node_modules`,`dist`,`build`,…; entry cap 50000); derive dir candidates from file-path parents; directory-scoped `q` (`a/b/`) lists live dir state with root-escape guard; fuzzy rank (exact>prefix>substring>subsequence + dir bonus); paths normalized `/`, relative to cwd, containment-checked.
  - Route `GET /sessions/:id/file-search?q=&limit=` → `{ results: {path,dir}[] }`; resolves cwd from session meta (live OR dormant); 404 unknown session; `q` required (empty → `{results:[]}`).

- [ ] **Step 1: Write failing tests** (temp dirs): git repo (init + tracked + untracked + .gitignored file) → ignored excluded, untracked included; non-repo → walk fallback finds files, excludes node_modules; `q='../../etc'` → no escape results (Review Focus 4); dir-scoped query lists subdir; ranking exact-before-prefix; limit honored; dormant session route works (meta cwd, no Query).
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** `searchFiles` + route. Use `allowExitCodes` for the non-repo git probe; bound the walk; never read file contents.
- [ ] **Step 4: Run, verify PASS** + typecheck.
- [ ] **Step 5: Commit.** `feat(reference): session-scoped file search (git-first + walk fallback)`

---

### Task 4: @ trigger + lazy picker (client)

**Files:**
- Modify: `src/components/richPromptCaret.ts` (add `atWordBefore`)
- Modify: `src/components/RichPromptInput.tsx` (add `replaceAtWord` to handle)
- Modify: `src/components/Composer.tsx:331-333,1001-1082` (parallel @ picker state + routing)
- Create: `src/components/FilePicker.tsx` (lazy menu component)
- Create: `src/hooks/useFileSearch.ts` (debounced abortable fetch of Task 3 endpoint)
- Test: `src/components/richPromptCaret.test.ts` (extend), `src/components/Composer.file-picker.test.tsx` (create), `src/hooks/useFileSearch.test.ts` (create)

**Interfaces:**
- Consumes: Task 1 grammar, Task 2 token/chip insertion, Task 3 endpoint.
- Produces:
  - `atWordBefore(text: string, offset: number): { word: string; start: number; quoted: boolean } | null` — quote-aware scan of the `@…` word ending at caret (handles opened `@"…` drill state; unlike slashWordBefore, spans spaces inside quotes).
  - `RichPromptHandle.replaceAtWord(text: string): void` — splices the forming `@word` with the picked mention text, restores caret.
  - `useFileSearch(sessionId, query, enabled): { results: {path,dir}[]; loading: boolean }` — ~150ms debounce, aborts stale requests.
  - `FilePicker` (lazy): grouped file/folder rows, `aria-activedescendant` keyboard nav, mousedown pick, anchor to editor; folder row Tab/chevron drills (keeps open-quote `@"dir/` editable + breadcrumbs), Enter settles `@dir/`; Esc/Shift+Tab dismiss; dismissed stays dismissed until query changes; `@"…"` restricts to files. Mutually exclusive with the slash picker.

- [ ] **Step 1: Write failing tests**: atWordBefore quote-aware (`'@src/a|'` → word `@src/a`; `'@"my dir/|'` → quoted drill word; `'hi @|'` → `@`); useFileSearch debounces + aborts stale (mock fetch); Composer @ trigger opens picker, arrow/Enter picks → chip inserted via replaceAtWord, Esc dismisses + stays dismissed until query changes, folder Tab drills, slash picker not simultaneously open.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** atWordBefore/replaceAtWord + picker state block (mirror slash) + useFileSearch + lazy FilePicker. Picker loads via React.lazy so startup is unaffected.
- [ ] **Step 4: Run, verify PASS** + Composer/slash-picker regression + typecheck + `npm run analyze:bundle` (startup unchanged).
- [ ] **Step 5: Commit.** `feat(reference): @ trigger and lazy file/folder picker`

---

### Task 5: System-prompt guidance (server)

**Files:**
- Create: `server/file-reference-guidance.ts` (the guidance text constant)
- Modify: `server/session-manager.ts` (spawn ~569/3385, resume ~12575, fork/clear/respawn sites; native `systemPromptAppend` ~3928/12689)
- Modify: `server/providers/claude/claude-provider.ts` (if preset wiring needed)
- Test: `server/file-reference-guidance.test.ts`

**Interfaces:**
- Consumes: SDK `Options.systemPrompt` preset-append shape (Side Chat pattern at session-manager:3385-3394); native `CreateSessionOptions.systemPromptAppend` → `renderSystem`.
- Produces: `FILE_REFERENCE_GUIDANCE: string` (adapted DSH FILE_REFERENCE_PROMPT: "@ tokens are paths the user referenced; read with the read tool when contents needed; don't claim inspected before reading; trailing slash = directory, list it"). Applied to every claude spawn path (create/resume/fork/clear/respawn) via preset-append, and native via systemPromptAppend; concatenated with SIDE_DEVELOPER_INSTRUCTIONS for side chats.

- [ ] **Step 1: PROBE SDK precedence** (Review Focus 5): a focused live test/spawn asserting a custom-agent (`Options.agent`) session keeps its persona prompt when `systemPrompt` preset-append is set. If preset-append CLOBBERS the agent prompt, change strategy to append guidance to the agent prompt instead. Record the result.
- [ ] **Step 2: Write failing tests**: guidance present in spawn opts AND resume opts for a regular session; persona session retains persona + guidance (per probe result); side chat has guidance + SIDE_DEVELOPER_INSTRUCTIONS; native renderSystem includes guidance.
- [ ] **Step 3: Run, verify FAIL.**
- [ ] **Step 4: Implement** the constant + wiring at all spawn/resume sites (both providers), composing per the probe.
- [ ] **Step 5: Run, verify PASS** + session-manager regression + typecheck.
- [ ] **Step 6: Commit.** `feat(reference): system-prompt guidance for @file references (spawn+resume, both providers)`

---

### Task 6: Chip click-to-preview + sent-message rendering

**Files:**
- Modify: `src/utils/richPromptDom.ts` / `RichPromptInput.tsx` (composer chip onClick)
- Modify: `src/utils/file-blocks.ts:12-40` (UserContentSegment + splitUserContentSegments mention split)
- Modify: `src/components/message-list/MessageView.tsx:256-328` (mention chip render + search countMatches)
- Create: `src/utils/mention-resource.ts` (relative→abs resolution + openResource helper)
- Test: `src/utils/file-blocks.test.ts` (extend), `src/components/message-list/MessageView.mention.test.tsx` (create)

**Interfaces:**
- Consumes: Task 1 `parseFileMention`/`MENTION_PATTERN_G`; `fileResource(sessionId, absPath)` (`shared/resource-address.ts:117`); `useOpenResource().openResource(sessionId, address)` (`src/resources/context.tsx`); session cwd.
- Produces:
  - `UserContentSegment` gains `| { readonly type: 'mention'; readonly text: string; readonly path: string; readonly dir: boolean }`; `splitUserContentSegments` splits text segments on mentions (after file-handle split).
  - `openMentionResource(sessionId, cwd, path): void` — resolves relative→abs against cwd, calls openResource(fileResource(...)).
  - Composer chip onClick + sent-message mention chip onClick → openMentionResource; MessageView search-highlight countMatches handles the mention segment.

- [ ] **Step 1: Write failing tests**: splitUserContentSegments yields mention segments for `'see @src/a.ts and @bob'` (text/mention/text/mention); MessageView renders a clickable mention chip; click calls openResource with the resolved absolute fileResource address; search countMatches counts mentions; composer chip click opens preview (mock openResource).
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** the segment type + split + helper + chip renderers + countMatches branch. Dormant session preview shows the existing read-failed frame (no new handling).
- [ ] **Step 4: Run, verify PASS** + file-blocks/MessageView regression + typecheck.
- [ ] **Step 5: Commit.** `feat(reference): chip click-to-preview and sent-message mention rendering`

---

### Task 7: Browser E2E + docs

**Files:**
- Create: `tests/browser/file-reference.spec.ts`
- Modify: `CLAUDE.md` (composer reference narrative)
- Move: `.agents/notes/proposed/feature/2026-11-23-file-reference.md` → `.agents/notes/implemented/feature/` (Status: implemented, facts to shipped names)
- Modify: spec Status → implemented

**Interfaces:**
- Consumes: all shipped tasks.

- [ ] **Step 1: Write the E2E** (playwright.app.config.ts pattern): open session → type `@` → picker shows files → pick a file → chip in composer → send → sent message renders clickable mention chip → click chip opens ResourceModal preview; folder Tab-drill settles `@dir/`; a path with spaces quotes correctly. Assert each.
- [ ] **Step 2: Run** `npx playwright test tests/browser/file-reference.spec.ts --config playwright.app.config.ts` — iterate to green.
- [ ] **Step 3: Manual acceptance** (record in report): real repo (.gitignore respected), non-repo cwd (walk fallback), path with spaces, Windows backslash input, resume preserves guidance, persona session keeps prompt.
- [ ] **Step 4: Docs** — CLAUDE.md narrative; move + update note (Status implemented); spec Status; `npm run verify:agent-notes` green.
- [ ] **Step 5: Full verify** — `npm run verify` green.
- [ ] **Step 6: Commit.** `feat(reference): browser E2E and architecture docs` + note move.
- [ ] **Step 7: Whole-branch review** — controller dispatches the final code-review (NOT the implementer).