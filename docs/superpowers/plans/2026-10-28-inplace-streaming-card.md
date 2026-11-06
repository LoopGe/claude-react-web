# In-place Streaming Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the `streamingMode='inline'` path so the ordinary message card grows in place and settles in place (no preview/card swap); the overlay bubble path is untouched.

**Architecture:** A synthetic draft message (`isDraft`, stable `draft:<seq>` key) is appended to the transcript rows while a response streams; it renders through `MessageView` and its text body is an incremental bare-block markdown render fed by a new `liveTurn.draft` store state. On message finalization the real message row adopts the draft's key via an alias map (no remount); at result a still-live draft freezes as an interrupted partial. `StreamingFooter` becomes overlay-only.

**Tech Stack:** React 19 + TS, Vitest (jsdom), the existing session-store reducer/mirror, `splitStreamBlocks` + `compileMarkdown` (a9fb16e9 machinery).

**Spec:** `docs/superpowers/specs/2026-10-28-inplace-streaming-card-design.md`

## Global Constraints

- Hot path: 80 ms `LIVE_TURN_FLUSH`; per flush only the draft body's tail block may compile; Chat/MessageList must stay at 0 renders per flush **in both modes** (leaf isolation).
- `'overlay'` mode behavior is byte-for-byte untouched (bubble + `pruneFinalizedLiveTurnText` + `StreamingFooter`).
- Settled-card rendering pipeline stays untouched: `MessageView`/`blocks.tsx` changes are additive (draft branch only); settled text keeps whole-string `compileMarkdown`.
- Drafts are never persisted: `REPLAY_REPLACE` (reload) clears drafts, frozen drafts and key aliases; only real messages replay.
- Draft text = **main-thread** `delta.text` only. `delta.thinking` and sidechain text (`parent_tool_use_id !== null`) never enter the draft. Thinking rows / tool cards render at settle only (user rulings).
- Settle-insertion exceptions (accepted): thinking row lands above the body (text shifts once); `[text, tool_use, text]` responses insert the tool card mid-body at settle (text shifts once). Everything else about the body must not move.
- `streamingRenderMode` config key / switch UI / `DEFAULT_STREAMING_RENDER_MODE` are unchanged.
- Test baseline stays green: `streaming-render-isolation`, `MessageList.test`, `transcript-chrome.test`, `stream-segments.test`, `markdown-cache.test`, `reducer.test`.

## Review Focus

1. **Settle handoff remounts the card** (the core promise breaks silently) — a MESSAGE arrival must update the same row in place. Test: Task 2's remount pin (MessageView mount count stays 1 across supersede).
2. **Inline mode re-renders MessageList per flush** (leaf isolation regresses; the old inline row had this exact bug) — Test: Task 4's isolation extension (MessageList 0 renders per flush in inline mode).
3. **Sidechain or thinking text leaks into the draft** (it would vanish/shift at settle) — Test: Task 1's reducer pin (only `parent_tool_use_id === null` `delta.text` folds in).
4. **Interrupt loses or duplicates the partial** (freeze must fire exactly when a draft survives to `result`; never after a supersede) — Tests: Task 1's two reducer pins + Task 5's end-to-end pair.
5. **Draft rows render in overlay mode** (overlay transcript must show settled messages only) — Test: Task 2's overlay-gating pin.

## File Structure

- `src/session-store/draft-state.ts` (NEW) — pure draft lifecycle helpers (append / supersede / freeze). One responsibility: draft state transitions.
- `src/session-store/types.ts` — mirror fields (`draft`, `frozenDrafts`, `draftRowKeys`, `draftSeq`).
- `src/session-store/reducer.ts` — wire the helpers at delta-fold / MESSAGE / result / `REPLAY_REPLACE`.
- `src/session-store/store.ts` — snapshot projection (`draft`, `frozenDrafts`, `draftRowKeys`).
- `src/types.ts` — `isDraft?: true` client-only marker on `SdkMessage` (same class as `cacheDroppedMedia`).
- `src/components/message-list/draft-body.tsx` (NEW) — `DraftBlocks` (bare-block static body) + `DraftTextBody` (live leaf: store subscription + cursor). Reuses `splitStreamBlocks` / `compileMarkdown` / cursor CSS.
- `src/components/message-list/MessageView.tsx` — additive draft branch (timestamp-less header + draft body).
- `src/components/MessageList.tsx` — inline seam: append draft rows, `computeItemKey` alias, scan exclusions, overlay gating; `StreamingRowItem` removed.
- `src/components/message-list/transcript-chrome.tsx` — `StreamingFooter` overlay-only (`variant` prop retired).
- `src/styles/chat.css` — draft-body cursor scope; `--inline` block removed.

---

### Task 1: Store draft lifecycle (fold / supersede / freeze)

**Files:**
- Create: `src/session-store/draft-state.ts`
- Modify: `src/session-store/types.ts`, `src/session-store/reducer.ts`, `src/session-store/store.ts`
- Test: `src/session-store/draft-state.test.ts` (new), `src/session-store/reducer.test.ts`

**Interfaces (produces — later tasks depend on these exact names):**
- `type DraftState = { key: string; text: string }` (`key` = `draft:<seq>`).
- Mirror additions on `ServerMirror`: `draft: DraftState | null`, `frozenDrafts: readonly DraftState[]`, `draftRowKeys: Readonly<Record<string, string>>`, `draftSeq: number` (all initialized in `createInitialServerMirror`: `null` / `[]` / `{}` / `0`).
- Snapshot projection (`store.ts`, next to `streamingContent`): `draft: DraftState | null`, `frozenDrafts`, `draftRowKeys`.
- Pure helpers in `draft-state.ts`:
  - `appendDraftText(draft: DraftState | null, seq: number, text: string): DraftState` — extends `text`, or creates `{ key: 'draft:' + seq, text }`.
  - `supersedeDraft(draft: DraftState, messageUuid: string): { cleared: null; aliasEntry: [string, string] }` — `aliasEntry = [messageUuid, draft.key]`.
  - (Freezing needs no helper: the result case pushes `draft` onto `frozenDrafts` as-is.)
- Reducer behavior (the contract tests pin):
  - main-thread `content_block_delta` (`text_delta`, `parent_tool_use_id === null`) → `draft = appendDraftText(draft, draftSeq, delta.text)` (increment `draftSeq` once per draft creation).
  - `delta.thinking`, `input_json_delta`, and any `parent_tool_use_id !== null` delta → draft untouched.
  - assistant `MESSAGE` with `parent_tool_use_id === null` while `draft != null` → `draftRowKeys[uuid] = draft.key`, `draft = null`.
  - `result` frame: `draft != null` → `frozenDrafts = [...frozenDrafts, draft]`, `draft = null`; `draftRowKeys` **kept**.
  - `REPLAY_REPLACE` → `draft = null`, `frozenDrafts = []`, `draftRowKeys = {}`, `draftSeq = 0`.

- [ ] **Step 1: Write failing tests** in `draft-state.test.ts`:

```ts
it('appendDraftText starts a draft with key draft:<seq> and then extends only the text')
// appendDraftText(null, 3, 'a') -> { key: 'draft:3', text: 'a' }
// appendDraftText(that, 3, 'b') -> { key: 'draft:3', text: 'ab' }
it('supersedeDraft maps the message uuid to the draft key and clears the draft')
// supersedeDraft({ key: 'draft:3', text: 'ab' }, 'uuid-x') -> { cleared: null, aliasEntry: ['uuid-x', 'draft:3'] }
```

- [ ] **Step 2: Run** `npx vitest run src/session-store/draft-state.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** `draft-state.ts` (three pure functions, signatures above).
- [ ] **Step 4: Run** again — expect PASS.
- [ ] **Step 5: Write failing reducer tests** in `reducer.test.ts` (feed `MESSAGE` actions through `store.dispatch`, assert `store.getSnapshot()` / mirror fields):

```ts
it('folds main-thread text deltas into the in-place draft (thinking and sidechain excluded)')
// dispatch stream_event text_delta x2 (parent null) -> snapshot.draft.text === concatenation
// dispatch a thinking delta and a sidechain (parent set) text_delta -> draft.text unchanged
it('MESSAGE finalize supersedes the draft: alias uuid → draft key, draft cleared')
it('result with a live draft freezes it as an interrupted partial and clears the draft')
it('result after a supersede freezes nothing')
it('REPLAY_REPLACE clears draft, frozen drafts and key aliases')
```

- [ ] **Step 6: Run** `npx vitest run src/session-store/reducer.test.ts -t "draft"` — expect FAIL for the new ones.
- [ ] **Step 7: Implement** the reducer wiring (mirror fields in `types.ts`, init in `createInitialServerMirror`, delta-fold + MESSAGE + result + REPLAY_REPLACE cases calling `draft-state` helpers; project the three fields in `store.ts`).
- [ ] **Step 8: Run** `npx vitest run src/session-store` — expect all PASS.
- [ ] **Step 9: Commit** — `git add` the five files; message `feat(transcript): in-place draft state (fold / supersede / interrupt-freeze)`.

### Task 2: Draft rows in the row layer (keys, gating, scan exclusions)

**Files:**
- Modify: `src/components/message-list/transcript-rows.ts`, `src/components/MessageList.tsx`, `src/components/MessageList.test.tsx`
- Test: `src/components/message-list/transcript-rows.test.ts`, `src/components/MessageList.test.tsx`

**Interfaces:**
- Consumes: Task 1's `DraftState`, snapshot fields `draft` / `frozenDrafts` / `draftRowKeys`.
- Produces: `buildDraftRows(draft: DraftState | null, frozenDrafts: readonly DraftState[]): TranscriptRow[]` in `transcript-rows.ts` — synthetic rows whose `msg` is `{ type: 'assistant', uuid: draft.key, isDraft: true, message: { role: 'assistant', content: [{ type: 'text', text: '' }] } }` (no `timestamp` field — `MessageView` already hides an absent timestamp). Frozen rows are emitted first, live draft last. Each row carries the fields `TranscriptRow` requires (`itemIndex: -1`, `plainText: ''`, …— mirror how `buildTranscriptRows` fills settled rows).
- `computeItemKey` consults `draftRowKeys[msg.uuid]` first (alias wins over the uuid key).
- Scan rule everywhere rows are walked for indexing (search index loop in `MessageList.tsx`): skip rows with `msg.isDraft`.

- [ ] **Step 1: Write failing tests** in `transcript-rows.test.ts`:

```ts
it('buildDraftRows emits frozen rows first and the live draft last, each keyed by its draft key and marked isDraft')
it('buildDraftRows returns [] when there is no draft and no frozen rows')
```

- [ ] **Step 2: Run** — expect FAIL (function missing).
- [ ] **Step 3: Implement** `buildDraftRows`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Write failing MessageList tests** (extend the existing inline suite):

```ts
it('inline mode renders the draft row as an assistant card shell; overlay mode renders no draft row')
// store: seed history + dispatch one text draft delta (Task 1 behavior)
// inline render: container has a row whose [data-message-id] === 'draft:1' (or a .msg-assistant whose text comes later in Task 3)
// overlay render (same store): querySelector for the draft row is null
it('computeItemKey keeps the draft key after supersede (no remount)')
// wrap MessageView with a mount counter (counted() pattern from streaming-render-isolation);
// render inline with a draft, dispatch the finalizing MESSAGE, assert mount count === 1 and the row's key is still draft:1
it('a tool-only response produces no draft row')
// dispatch tool_use stream events only (content_block_start/deltas for input, no text deltas)
// -> snapshot.draft is null and the inline render has no draft row
it('the search index skips draft rows')
// draft with text 'needle'; open search for 'needle'; assert no match is reported for the draft row
```

- [ ] **Step 6: Run** `npx vitest run src/components/MessageList.test.tsx -t "draft"` — expect FAIL.
- [ ] **Step 7: Implement** — MessageList inline branch appends `buildDraftRows(...)` (subscribed via `useSessionSelector(sessionId, (s) => s.draft != null)` for presence and `useSessionField(sessionId, 'draft' | 'frozenDrafts' | 'draftRowKeys')` at render); `computeItemKey` alias-first; search loop skips `msg.isDraft`; entrance-animation gate skips `isDraft` rows (they must not replay a cascade). Overlay branch passes none of it.
- [ ] **Step 8: Run** `npx vitest run src/components/MessageList.test.tsx src/components/message-list/` — PASS.
- [ ] **Step 9: Commit** — `feat(transcript): draft rows in the row layer (stable keys, overlay gating, scan exclusions)`.

### Task 3: Draft body — bare-block incremental markdown

**Files:**
- Create: `src/components/message-list/draft-body.tsx`
- Modify: `src/components/message-list/MessageView.tsx`, `src/styles/chat.css`
- Test: `src/components/message-list/draft-body.test.tsx` (new)

**Interfaces:**
- Consumes: `splitStreamBlocks` (`src/utils/stream-segments.ts`), `compileMarkdown` (`src/utils/markdown-cache.ts`, `transient` option), Task 1 snapshot `draft`.
- Produces:
  - `DraftBlocks({ text }: { text: string }): JSX.Element` — renders `splitStreamBlocks(text)` **bare** (no per-block wrapper) inside one `<div className="md">`; code segments via `StreamCodeSegment` — **export it from `transcript-chrome.tsx`** (the overlay bubble keeps using it; do not move the component); tail prose block compiled with `{ transient: true }`, frozen blocks cached.
  - `DraftTextBody({ sessionId, frozenText }: { sessionId?: string; frozenText?: string }): JSX.Element` — live leaf: `frozenText` given → static `DraftBlocks` (no cursor); else subscribes `useOptionalSessionField(sessionId, 'draft')` and renders `DraftBlocks` + the tail cursor (reuse `.streaming-cursor` `::after` + fallback span; extend the chat.css selector scope from `.streaming-plain` to include `.draft-body`).
  - `MessageView` draft branch (additive): `msg.isDraft` → header renders as usual minus timestamp (absent field already hides it) + body `<DraftTextBody sessionId frozenText? />` in a `<div className="msg-body assistant-body draft-body">`.
- Pixel-parity contract (the test pins it): for any single-text-block content, `DraftBlocks` output DOM equals the settled whole-compile output (`<div className="md">{compileMarkdown(text, {})}</div>`) element-for-element.

- [ ] **Step 1: Write failing tests** in `draft-body.test.tsx`:

```ts
it('renders growing markdown bare-block with a tail cursor (headings/lists/code live)')
it('matches the settled whole-compile DOM exactly for the same source (pixel parity)')
// render(<div className="md">{compileMarkdown(src, {})}</div>) vs render(<DraftBlocks text={src}/>)
// expect(container.innerHTML) equality for a fixture with heading + list + fence
it('frozenText renders without a cursor')
it('the tail compile never enters the markdown LRU (transient)')  // may live in markdown-cache.test if already covered — keep only if not
```

- [ ] **Step 2: Run** — FAIL (module missing).
- [ ] **Step 3: Implement** `draft-body.tsx` + the `MessageView` branch + cursor CSS scope (a code block is only for the bare-render loop: map `splitStreamBlocks(text)` to `compileMarkdown(seg.content, { transient: isTail && seg.type === 'text' })` inside the one `.md`, code segments through the code renderer).
- [ ] **Step 4: Run** `npx vitest run src/components/message-list/draft-body.test.tsx src/components/message-list/transcript-chrome.test.tsx` — PASS (chrome suite proves StreamCodeSegment extraction didn't break the overlay bubble).
- [ ] **Step 5: Commit** — `feat(transcript): draft body — bare-block incremental markdown with settle parity`.

### Task 4: Seam switch + inline-footer retirement

**Files:**
- Modify: `src/components/MessageList.tsx`, `src/components/message-list/transcript-chrome.tsx`, `src/styles/chat.css`, `src/components/MessageList.test.tsx`, `src/components/message-list/transcript-chrome.test.tsx`, `src/components/streaming-render-isolation.test.tsx`, `docs/manual.zh-CN.md`, `docs/manual.en.md`
- Test: the modified suites above.

**Interfaces:**
- Consumes: Tasks 2–3 (draft rows + draft body). Produces: inline mode = draft-card experience end to end; `StreamingFooter` is overlay-only (`StreamingFooter` props become `{ content: string }` — `variant` deleted; `StreamingFooterVariant` type stays in `shared/streaming-render-mode.ts` for the setting union).

- [ ] **Step 1: Write failing tests / rewrite the inline suites** (they currently assert StreamingFooter tail rows):

```ts
// MessageList.test.tsx — replace the StreamingRowItem-era assertions:
it('inline mode: the growing text renders inside the draft card (not a footer row)')
// draft delta 'hello **world**' -> container.querySelector('.draft-body .md strong') shows 'world';
// container has NO .streaming-footer-wrapper
it('overlay mode still renders the streaming bubble (StreamingFooter), unchanged')
// existing overlay assertions stay as-is
// streaming-render-isolation.test.tsx:
it('inline mode keeps MessageList at 0 renders per flush (draft body leaf only)')
// modeled on the overlay pin: N deltas -> counts.MessageList === 0, counts draft-body >= flushes
```

- [ ] **Step 2: Run** — expect FAIL (inline path still renders the old row).
- [ ] **Step 3: Implement** — MessageList: inline branch renders `buildDraftRows` rows through the normal `itemContent`/`MessageView` path (Task 2 already appends; this step removes `StreamingRowItem`, `STREAMING_ROW_KEY`, the inline `streamingContent` subscription and the `StreamingFooter inline` call sites); frozen drafts render through `DraftTextBody frozenText`. `transcript-chrome.tsx`: delete the `variant` prop + inline branches (overlay render only). `chat.css`: remove `--inline` rules, scope cursor rules to `.draft-body`. Manuals: the switch's hint/描述 unchanged in meaning; add "（inline 档：卡片原地生长）" / "(inline: the card grows in place)" to the Appearance row descriptions in both manuals.
- [ ] **Step 4: Run** the five baseline suites (`streaming-render-isolation`, `MessageList.test`, `transcript-chrome.test`, `stream-segments.test`, `markdown-cache.test`) — PASS.
- [ ] **Step 5: Commit** — `feat(streaming): inline mode is the in-place card (footer inline variant retired)`.

### Task 5: Interrupt end-to-end + regression sweep

**Files:**
- Modify: `src/components/MessageList.test.tsx` (interrupt scenarios), `src/components/streaming-render-isolation.test.tsx` (if pins need the frozen case)
- Test: as above; plus the empirical CLI checklist (manual, in the commit message body or a `docs/` note if a defect is found).

**Interfaces:** Consumes everything above. Produces: the two interrupt branches proven at the UI level.

- [ ] **Step 1: Write failing tests** in `MessageList.test.tsx`:

```ts
it('interrupt without a salvaged message freezes the half-card in place (no cursor, stays after result)')
// draft delta -> dispatch result (aborted_streaming, no MESSAGE) -> frozen card remains with the text; a new draft delta renders BELOW it
it('interrupt with a salvaged message settles normally (freeze never appears)')
// draft delta -> dispatch MESSAGE (partial text) -> dispatch result -> exactly one settled card, no frozen row, same DOM node as the draft (mount counter stays 1)
```

- [ ] **Step 2: Run** — FAIL (frozen rendering not wired in the row/body path yet if Task 2/3 left it unexercised).
- [ ] **Step 3: Implement** any remaining wiring (frozen row → `DraftTextBody frozenText`, interrupted styling = no cursor + existing result-row "turn interrupted" marker is the surrounding context).
- [ ] **Step 4: Run** — PASS; then full `npm run test` + `npm run typecheck` + `npx eslint` on touched files.
- [ ] **Step 5: Empirical CLI check** (manual): run the app, interrupt during (a) thinking, (b) mid-text, (c) tool-input streaming — confirm which branch fires and that both look right; record findings in the commit message.
- [ ] **Step 6: Commit** — `feat(transcript): interrupt freeze for in-place cards + full regression`.
