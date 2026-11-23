# @file / @folder Composer References — Phase 1 Design

Date: 2026-11-23
Status: implemented
Agent Note: [.agents/notes/implemented/feature/2026-11-23-file-reference.md](../../../.agents/notes/implemented/feature/2026-11-23-file-reference.md)

## Intent

Referencing a file today means typing or pasting its full path. DSH's
`@`-reference turns that into "type `@`, a few letters, Enter": a candidate
menu inserts an atomic chip that serializes to a canonical `@path` the model
reads itself. This ports the file/folder half of that feature onto our existing
rich composer. The driving value is daily input efficiency plus a structured,
clickable reference (preview on click) instead of error-prone plain text.

DSH semantics were source-verified (`packages/context/file-reference*`,
`packages/client/ui-reference`): the model receives **plain `@path` text, never
file content**; a system-prompt section tells it to read referenced paths; chip
serialization is identity (the `@path` string is ref, clipboard, and sent text).

## Decided by the user

- **DSH-style, path-not-content**: the model gets the canonical path and reads
  it with its own Read tool. No content injection at pick or send.
- **Phase 1 scope: @file + @folder** (folder Tab-drill included). **@session is
  deferred** to a separate project — DSH's session reference is a cross-session
  content-injection subsystem (host reads the target session, projects
  user/assistant text, budgets it, appends a second user message with an
  untrusted-warning frame + spill locator), comparable in complexity to the
  terminal feature, not "another candidate domain".

## Goals

1. Typing `@` in the composer opens a grouped file/folder candidate menu with
   fuzzy search; keyboard navigation keeps composer focus; picks insert atomic
   chips.
2. A chip serializes to canonical mention text — `@path`, `@"path with spaces"`,
   `@dir/` — inline in the sent string (identity serialization; survives
   copy/paste and draft save/restore).
3. The model receives that text plus a system-prompt guidance section: "@ tokens
   are paths the user explicitly referenced; read them with the read tool when
   contents are needed; do not claim to have inspected before reading; a trailing
   slash marks a directory, list it when contents matter."
4. Folder candidates drill (Tab/chevron descends, breadcrumbs navigate back);
   Enter settles the whole `@dir/`.
5. Clicking a chip — in the composer or in a sent message — opens the existing
   file preview (ResourceModal) at that path.
6. Sent messages render `@path` / `@dir/` as clickable chips.

## Non-goals (deferred / out)

- @session references (separate project).
- File content injection at pick/send; reading files client-side.
- Validating that a referenced path exists at send (DSH sends deleted paths
  as-is; the model's read fails and it re-plans — same here).
- `.gitignore`-less walking as the primary backend (we improve on DSH: git-first).
- A dedicated HTML/PDF preview (FilePreviewBody falls to code view; unchanged).

## Anti-goals (failure even if it "works")

- Regressing the slash-command picker, paste-collapse, the browser undo stack,
  or draft persistence.
- A search endpoint that escapes the session cwd or reads file contents.
- Growing the startup bundle with the picker/menu (lazy where it matters).

## Constraints

- Repo conventions (CLAUDE.md): theme CSS variables in both themes; no
  speculative defensive code; `createLogger` for server diagnostics; git never
  through a shell (`runGit`); path validation (`validateRepoRelativePath` /
  `isPathInside`); both tsconfigs typecheck.
- The composer is a contenteditable whose chips are RE-DERIVED from the plain
  string value by `tokenize` — a new chip kind MUST extend the token model +
  `tokenize` + `renderTokens` + `domRepresentsValue` round-trip, or it vanishes
  on the next reconcile.

## Architecture

### Mention grammar (shared)

New `shared/file-mention.ts`: `formatFileMention(path, isDir)` → `@path` /
`@"path with spaces"` / `@dir/`; rejects control chars and embedded quotes
(DSH `grammar.ts:35-45` parity). `parseFileMention(text)` inverse for the
sent-message matcher. Whitespace → quote; trailing slash → directory. Paths are
**workspace-relative** (relative to session cwd); a user-typed absolute path is
preserved (drive letter kept).

**Windows paths (resolved at builder-check).** The canonical separator is POSIX
`/` (git ls-files emits `/`; the model's Read accepts `/` on Windows). Input
accepts `\` and normalizes it to `/` **at format time, before quoting** — so a
Windows directory `my dir\` becomes `@"my dir/"`, never the `\"` quote-collision
form. A trailing `\` is a directory marker (→ `/`). Picked candidates are already
canonical (`/`), so their serialization is identity; hand-typed backslash paths
normalize to the canonical form (the one deliberate departure from strict
identity, documented). The non-repo fs-walk fallback normalizes its backslash
output to `/` too.

**Chipify scope (user-decided: DSH original).** ANY `@non-space` token chipifies
— including prose like `@bob` / `@here` — exactly DSH's matcher
`(?<!\S)(@"[^"\n]+"|@[^\s]+)`. No path-shape constraint, no existence validation:
clicking `@bob` opens the preview's read-failed frame, same as DSH. (An earlier
draft added a "prose untouched" shape constraint; the user rejected it in favor
of DSH parity.)

### Token model + chip (client)

Extend `src/utils/pastedText.ts` `PastedTextToken` with a mention kind
(`{ kind: 'mention'; text: string; path: string; dir: boolean }` whose `text` is
the formatted mention). `tokenize` gains a mention matcher (the strict grammar,
not a loose `@`); `renderTokens` (`src/utils/richPromptDom.ts`) renders a chip
span with a distinct data attribute (`data-file-mention`) + class, reusing the
`contenteditable="false"` atomic-Backspace behavior; `serializeTokens` /
`joinTokens` emit the mention text (label IS the serialized text);
`domRepresentsValue` recognizes the new chip. [builder call: exact token
shape/attr names]

**Chipification gating (resolved at builder-check).** An unquoted mention has no
closing delimiter — every prefix (`@s`, `@sr`, `@src/`) is grammatically
complete — so a context-free `tokenize` would chipify the forming query on the
second keystroke, making Backspace atomic mid-typing, rebuilding the DOM outside
the undo stack, and chipifying the folder-drill text under the caret. Therefore
reconcile is **caret-aware**: a mention token whose range contains the caret (the
forming trigger word the picker is consuming) renders as editable TEXT, never a
chip; all other settled mentions render as chips. A mention is "settled" when
picked from the menu, pasted, draft-restored, or hand-typed with the caret
departed. The flagship "type @, a few letters, Enter" flow keeps the query
editable until pick; the picked chip is inserted directly. Round-trip tests must
cover the caret-inside-mention case (text, not chip) and caret-departed (chip).

### @ trigger + picker (client)

Isomorphic to the slash picker (`slashWordBefore` / `replaceSlashWord` /
`pickerOpen/pickerQuery/pickerIndex` in Composer.tsx): add `atWordBefore`
(quote-aware — paths may contain spaces, unlike slash words) + `replaceAtWord`
to `RichPromptHandle`, a parallel picker state block, and a `FilePicker`
component (anchor to the editor, grouped file/folder rows, keyboard nav via
`aria-activedescendant`, mousedown pick). Behaviors (DSH parity):
- Esc / Shift+Tab dismiss; **dismissed stays dismissed until the query changes**
  (no flicker on caret restore).
- Folder row: Tab/chevron drills (keeps an open-quote `@"dir/` editable text +
  breadcrumbs); Enter settles `@dir/`.
- `@"…"` opened-quote restricts to files.
- Arrow/Enter/Tab routing mirrors the slash picker; the two pickers are mutually
  exclusive (a `/` word and an `@` word can't both be active).
The picker + menu load lazily so startup is unaffected. [builder call: lazy
boundary granularity]

### Search endpoint (server)

New session-scoped `GET /api/sessions/:id/file-search?q=<query>&limit=20`:
resolves cwd from session meta (works for **dormant** sessions — search needs
only the cwd, not a live Query). Backend:
- cwd is a git repo → `runGit(cwd, ['ls-files', '-z', '--cached', '--others',
  '--exclude-standard'])` (tracked + untracked-non-ignored; respects
  .gitignore — our improvement over DSH's no-gitignore fs walk).
- non-repo (or git failure via `allowExitCodes`) → bounded fs walk with a
  basename exclusion list (`.git`, `node_modules`, `dist`, `build`, …), entry cap.
- Folder candidates derived from file-path directories; a directory-scoped query
  (`a/b/…`) lists live directory state with root-escape guards.
- Fuzzy rank (exact/prefix/substring/subsequence + directory bonus), ≤20 results,
  response carries `{ path, dir }[]`. Client debounces keystrokes (~150ms) and
  aborts stale requests. Path containment enforced (`isPathInside`); never reads
  file contents. [builder call: index caching vs per-query walk; exact ranking
  weights]

### System-prompt guidance (server)

Append the guidance section to the SDK system prompt on **spawn AND resume**
(the SDK does not persist systemPrompt across resume — pattern at
`session-manager.ts:12575`), using the existing preset-append shape
`{ type:'preset', preset:'claude_code', append: <guidance>, snapshot:false }`
already used for Side Chat. Regular sessions set no systemPrompt today, so this
introduces the preset object for them. Native provider: pass the same guidance
via `CreateSessionOptions.systemPromptAppend` → `renderSystem`. Guidance text
adapted from DSH `FILE_REFERENCE_PROMPT`. [builder call: gate on read-tool
presence vs always-on (claude always has Read); exact wording]

**Persona + Side Chat composition (resolved at builder-check).** Guidance must
COMPOSE with a custom agent's (`Options.agent`) own system prompt, never replace
it — a blanket preset that clobbers the persona prompt would regress a feature
with deliberate drop-guards. The SDK's `agent` × `systemPrompt` precedence is
undocumented in `sdk.d.ts`, so the implementation MUST probe it (a small live
spawn asserting the persona prompt survives alongside the guidance) before
wiring every spawn path; if preset-append replaces the agent prompt, append the
guidance to the agent prompt instead. Side chats get the guidance too,
concatenated with `SIDE_DEVELOPER_INSTRUCTIONS`. Applies to every spawn path
(create/resume/fork/clear/respawn) for both providers.

### Chip click → preview (client)

Chip onClick resolves the mention path to absolute against the session cwd and
calls `useOpenResource().openResource(sessionId, fileResource(sessionId,
absPath))` (`shared/resource-address.ts`, `src/resources/context.tsx`).
FilePreviewBody renders image/markdown/code. Preview reads via `read-file`
(live sessions only); a dormant session's chip click shows the existing
read-failed frame — acceptable, documented. Right-click context menu (open /
copy path) is a polish extra. [builder call: relative→abs resolution helper]

### Sent-message rendering (client)

Add a `mention` segment to `splitUserContentSegments` (`src/utils/file-blocks.ts`)
using `parseFileMention`; `MessageView.tsx` renders it as a clickable chip
(same openResource path). The search-highlight loop (`MessageView.tsx:267-280`)
gains a `countMatches` branch for the new segment type.

## Alternatives that lost

- **Inject file content at pick/send.** User chose path-not-content (DSH parity);
  content injection bloats context and duplicates the model's Read.
- **@session in phase 1.** Deferred — it is a cross-session content-injection
  subsystem with security framing/budgeting/spill, not a candidate domain.
- **fs walk only (DSH backend).** We go git-first to respect .gitignore and stay
  fast in large repos; fs walk is the non-repo fallback.
- **Path-shape constraint to keep prose `@bob` untouched.** An earlier draft
  added it; the user chose DSH original instead (any `@non-space` chipifies).
- **Following the model's `EnterWorktree`.** DSH references root at the session
  cwd and have no dynamic-root equivalent; user chose DSH parity. Phase 1 pins
  paths to the session cwd (`meta.cwd`, which already IS the worktree for
  provisioned isolation). A model-initiated `EnterWorktree` mid-session diverges
  (CLI Read resolves against the worktree, picker/preview against `meta.cwd`) —
  accepted limitation, documented like the dormant-preview failure; worktree-
  following deferred.
- **Structured block / handle for the model.** DSH uses plain `@path` text +
  system guidance; a handle would need model-side parsing we don't have. Plain
  text is the verified, simplest contract.

## Risks

- The token-model round-trip (`tokenize`/`renderTokens`/`domRepresentsValue`) is
  pasted-text-specific; the mention kind must round-trip exactly or chips vanish
  on reconcile. Round-trip tests are the net.
- Quote-aware trigger scan is subtler than the space-splitting slash scan
  (paths with spaces, opened-quote drill state).
- systemPrompt must be applied at spawn AND resume for claude, and via
  systemPromptAppend for native — missing resume re-application silently drops
  guidance after a resume.
- git ls-files in a huge repo / non-repo walk must stay bounded (cap + debounce +
  abort) so typing never stalls.

## Testing

- Unit: mention grammar format/parse round-trip (spaces, quotes, trailing slash,
  control-char rejection); token-model round-trip (tokenize→render→serialize→
  domRepresentsValue) incl. mixed text+mention+paste chips; atWordBefore
  quote-aware scan; fuzzy ranking; search endpoint git/non-repo/fallback +
  containment + dormant.
- Client (happy-dom): picker trigger/nav/drill/dismiss-stays-dismissed; chip
  insertion + atomic Backspace; draft save/restore preserves chips; chip click
  opens ResourceModal; sent-message mention chip + search countMatches.
- Browser E2E: type @ → pick file → chip → send → model receives @path → click
  sent chip opens preview; folder drill; quoted path with spaces.
- Manual: a real repo (gitignore respected), a non-repo cwd (walk fallback), a
  path with spaces, resume preserves guidance.

## Left to the builder

Exact token/attr names, lazy-boundary granularity, search index caching vs
per-query walk, ranking weights, guidance wording + read-tool gating,
relative→abs helper, right-click menu polish — marked [builder call] above.
