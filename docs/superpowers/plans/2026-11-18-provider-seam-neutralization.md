# Provider Seam Neutralization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the provider contract provider-neutral and dissolve the attachment-index ↔ native production import cycle — option A items 1+2 of the native-provider extraction evaluation, a behavior-preserving structural refactor.

**Architecture:** Relocate the two concrete-provider type imports out of `server/providers/types.ts` into neutral modules (`attachment-types.ts`, `hook-types.ts`) with re-exports for compatibility; relocate the native-specific `NativeAttachmentReferenceIndex` from the host root into `server/providers/native/` so native no longer reaches back into a host module. No runtime behavior changes.

**Tech Stack:** TypeScript / Node ≥ 20 ESM, vitest. Pure import/type relocation; no new runtime deps.

**Spec:** `.agents/notes/proposed/architecture/2026-11-18-provider-seam-neutralization.md`

## Global Constraints

- BEHAVIOR-PRESERVING: this is a structural refactor. No runtime semantics change. The full existing suite (11048 tests) must stay green; typecheck ×4 (tsconfig.json, tsconfig.node.json, desktop/tsconfig.json, tests/browser/tsconfig.json) green.
- After the refactor `server/providers/types.ts` imports NOTHING from `./claude/` or `./native/`.
- The new neutral modules import no concrete-provider module: `attachment-types.ts` imports only `../agent-message.js`; `hook-types.ts` imports only `../../shared/hooks.js`.
- Re-exports preserve existing public import paths (format.ts re-exports NativeFileAttachment/NativeFileBlock; inprocess-hooks.ts re-exports the three hook types) so the ~13 other importers need no change.
- No production import cycle between the attachment index and native after relocation.
- Diagnostics via createLogger(scope); never bare console.* (the relocated index keeps its existing logger).
- Commit messages: conventional commits, lowercase-led subject (commitlint rejects capital-led), end with exactly `Co-Authored-By: Claude Code <noreply@anthropic.com>`.
- Work on a feature branch; run the code-review skill on the full branch diff before anything lands on main.
- TDD adaptation for a pure refactor: each task's gate is typecheck + the affected existing tests staying green; Task 4 adds structural neutrality pins (the regression guard) and the cycle check.

## Review Focus

- **Type identity drift** — moving `NativeFileAttachment` (extends `ResolvedFileAttachment`) must not break a nominal-type assumption; typecheck ×4 + full suite catch it. Pinned by Task 1/4 typecheck + suite.
- **New runtime cycle from relocation** — `upload-store → native/attachment-reference-index → native/session-log/format → host modules` must not loop back to upload-store (native-session's UploadStore import is type-only). Pinned by Task 4 cycle check + full suite (a harmful ESM cycle surfaces as undefined imports / load failures).
- **Neutral module re-coupling** — `attachment-types.ts` must not import native; `hook-types.ts` must not import claude. Pinned by Task 4 structural import-scan test.
- **types.ts still reaching a concrete provider** — after both type moves, types.ts has zero `./claude/`/`./native/` imports. Pinned by Task 4 structural test.
- **Behavior change sneaking in** — the refactor must not alter runtime; the full suite (11048 tests) unchanged is the gate. Pinned by Task 4 full verify.

## File Structure

- Create `server/providers/attachment-types.ts` — `NativeFileAttachment` (extends `ResolvedFileAttachment`) + `NativeFileBlock`; imports only `../agent-message.js`.
- Create `server/providers/hook-types.ts` — `InProcessHookForward` / `InProcessSubagentStop` / `InProcessTaskSnapshot`; imports only `../../shared/hooks.js` (`HookRuntimeEvent`).
- Modify `server/providers/native/session-log/format.ts` — remove the two type definitions, import + re-export from `../../attachment-types.js`.
- Modify `server/providers/claude/inprocess-hooks.ts` — remove the three type definitions, import + re-export from `../hook-types.js`.
- Modify `server/providers/types.ts` — line 9 import from `./hook-types.js`; line 12 import from `./attachment-types.js`.
- Move `server/attachment-reference-index.ts` → `server/providers/native/attachment-reference-index.ts` (class + `nativeAttachmentOccurrences`); imports become native-internal.
- Move `server/attachment-reference-index.test.ts` → `server/providers/native/attachment-reference-index.test.ts`; update imports.
- Modify importers of the index: `server/upload-store.ts` (host→native), `server/providers/native/native-provider.ts`, `native-session.ts`, `tools/attachment-read.ts` (native-internal), and tests `tools/attachment-read.test.ts`, `explore.test.ts`.
- Create `server/providers/seam-neutrality.test.ts` — structural import-scan pins.

---

### Task 1: Relocate NativeFileAttachment / NativeFileBlock to a neutral module

**Files:**
- Create: `server/providers/attachment-types.ts`
- Modify: `server/providers/native/session-log/format.ts:44-52`, `server/providers/types.ts:12,19,25,306`

**Interfaces:**
- Consumes: `ResolvedFileAttachment` from `server/agent-message.ts`.
- Produces: `attachment-types.ts` exports `NativeFileAttachment` (extends ResolvedFileAttachment, `modelForm: 'handle' | 'pdf-document'`) and `NativeFileBlock` (`{ type: 'file'; attachment: NativeFileAttachment }`). format.ts re-exports both (unchanged public path). types.ts imports NativeFileAttachment from `./attachment-types.js`.

- [ ] **Step 1: Create the neutral module**

`server/providers/attachment-types.ts`: import type `ResolvedFileAttachment` from `../agent-message.js`; move the exact `NativeFileAttachment` interface (format.ts:44-47) and `NativeFileBlock` interface (format.ts:49-52) here verbatim. No other imports.

- [ ] **Step 2: Re-export from format.ts**

In `native/session-log/format.ts`: delete the two interface definitions; add `import type { NativeFileAttachment, NativeFileBlock } from '../../attachment-types.js'` and `export type { NativeFileAttachment, NativeFileBlock } from '../../attachment-types.js'`. All other format.ts types that reference them resolve via the import. (Verify the relative path: format.ts is server/providers/native/session-log/, attachment-types.ts is server/providers/ → `../../attachment-types.js`.)

- [ ] **Step 3: Point types.ts at the neutral module**

In `server/providers/types.ts`: change line 12 from `import type { NativeFileAttachment } from './native/session-log/format.js'` to `import type { NativeFileAttachment } from './attachment-types.js'`.

- [ ] **Step 4: Verify**

Run: `npm run typecheck` (all four configs) and `npx vitest run server/providers/native/session-log server/providers/native/attachment-projection.test.ts server/providers/native/pdf-documents.test.ts server/compact-attachments.test.ts server/attachment-reference-index.test.ts`.
Expected: PASS — type identity preserved, re-exports keep all importers working.

- [ ] **Step 5: Commit**

```bash
git add server/providers/attachment-types.ts server/providers/native/session-log/format.ts server/providers/types.ts
git commit -m "refactor(providers): move NativeFileAttachment to a neutral contract module

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: Relocate the in-process hook types to a neutral module

**Files:**
- Create: `server/providers/hook-types.ts`
- Modify: `server/providers/claude/inprocess-hooks.ts:8,15-18,32-40`, `server/providers/types.ts:9`

**Interfaces:**
- Consumes: `HookRuntimeEvent` from `shared/hooks.ts`.
- Produces: `hook-types.ts` exports `InProcessHookForward`, `InProcessTaskSnapshot`, `InProcessSubagentStop` (exact signatures from inprocess-hooks.ts:8,15-18,32-40). inprocess-hooks.ts re-exports all three. types.ts imports them from `./hook-types.js`.

- [ ] **Step 1: Create the neutral module**

`server/providers/hook-types.ts`: import type `HookRuntimeEvent` from `../../shared/hooks.js`; move the three type aliases verbatim (InProcessHookForward = (sessionId: string, event: HookRuntimeEvent) => void; InProcessTaskSnapshot = (sessionId, tasks: Array<{id; status?}>) => void; InProcessSubagentStop = (sessionId, info: {agentId; transcriptPath?; lastAssistantMessage?; backgroundTasks?}) => void). Keep their doc comments. No other imports (no SDK, no claude).

- [ ] **Step 2: Re-export from inprocess-hooks.ts**

In `claude/inprocess-hooks.ts`: delete the three type definitions; add `import type { InProcessHookForward, InProcessTaskSnapshot, InProcessSubagentStop } from '../hook-types.js'` and `export type { InProcessHookForward, InProcessTaskSnapshot, InProcessSubagentStop } from '../hook-types.js'`. The rest of inprocess-hooks.ts (capHookInput etc.) unchanged.

- [ ] **Step 3: Point types.ts at the neutral module**

In `server/providers/types.ts`: change line 9 from `import type { InProcessHookForward, InProcessSubagentStop, InProcessTaskSnapshot } from './claude/inprocess-hooks.js'` to `... from './hook-types.js'`.

- [ ] **Step 4: Verify neutrality + types**

Run: `npm run typecheck` and `npx vitest run server/providers/claude server/session-manager.test.ts`.
Expected: PASS. Confirm types.ts now has ZERO imports from `./claude/` or `./native/` (grep its import lines).

- [ ] **Step 5: Commit**

```bash
git add server/providers/hook-types.ts server/providers/claude/inprocess-hooks.ts server/providers/types.ts
git commit -m "refactor(providers): move in-process hook types to a neutral contract module

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: Relocate the attachment index into native (break the cycle)

**Files:**
- Move: `server/attachment-reference-index.ts` → `server/providers/native/attachment-reference-index.ts`
- Move: `server/attachment-reference-index.test.ts` → `server/providers/native/attachment-reference-index.test.ts`
- Modify: `server/upload-store.ts:22`, `server/providers/native/native-provider.ts:44`, `server/providers/native/native-session.ts:38`, `server/providers/native/tools/attachment-read.ts:10`, `server/providers/native/tools/attachment-read.test.ts`, `server/providers/native/explore.test.ts`

**Interfaces:**
- Consumes: native-internal `loadNativeSessionLog` (`./session-log/log.js`) + log types (`./session-log/format.js`).
- Produces: `NativeAttachmentReferenceIndex` class + `nativeAttachmentOccurrences` function now exported from `server/providers/native/attachment-reference-index.ts` (unchanged signatures). Host `upload-store.ts` imports the class from `./providers/native/attachment-reference-index.js`; native consumers import it internally.

- [ ] **Step 1: Move the module**

`git mv server/attachment-reference-index.ts server/providers/native/attachment-reference-index.ts`. Update its imports to native-internal: `loadNativeSessionLog` from `./session-log/log.js`; types `NativeEventInput, NativeFileAttachment, NativeFileBlock, NativeLogEvent` from `./session-log/format.js`; `createLogger` from `../../log.js`. The class body + `nativeAttachmentOccurrences` are unchanged. Update the header comment to note it lives in native (indexes native logs).

- [ ] **Step 2: Update importers**

- `server/upload-store.ts:22`: `import { NativeAttachmentReferenceIndex } from './providers/native/attachment-reference-index.js'` (host→native, one direction).
- `server/providers/native/native-provider.ts:44`: import from `./attachment-reference-index.js`.
- `server/providers/native/native-session.ts:38`: import from `./attachment-reference-index.js`.
- `server/providers/native/tools/attachment-read.ts:10`: import from `../attachment-reference-index.js`.
- Tests `tools/attachment-read.test.ts`, `explore.test.ts`: update to the new native path.
(Verify each relative path against the file's location; the destination is server/providers/native/attachment-reference-index.ts.)

- [ ] **Step 3: Move the test**

`git mv server/attachment-reference-index.test.ts server/providers/native/attachment-reference-index.test.ts`. Update its imports (the class + nativeAttachmentOccurrences from `./attachment-reference-index.js`; any host helpers like loadNativeSessionLog from `./session-log/log.js`; temp-dir/log helpers adjust paths). Keep all test cases unchanged.

- [ ] **Step 4: Verify**

Run: `npm run typecheck` and `npx vitest run server/providers/native/attachment-reference-index.test.ts server/providers/native/tools/attachment-read.test.ts server/providers/native/explore.test.ts server/upload-store.test.ts server/compact-attachments.test.ts`.
Expected: PASS. Confirm no remaining importer references the old `server/attachment-reference-index.js` path (grep).

- [ ] **Step 5: Commit**

```bash
git add -A server/
git commit -m "refactor(native): move attachment-reference index into native to break the import cycle

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: Structural neutrality pins + cycle check + full verify

**Files:**
- Create: `server/providers/seam-neutrality.test.ts`

**Interfaces:**
- Consumes: the refactored types.ts / attachment-types.ts / hook-types.ts / relocated index.
- Produces: regression pins asserting seam neutrality + neutral-module purity.

- [ ] **Step 1: Write the structural pin test**

`server/providers/seam-neutrality.test.ts` reads source files (fs.readFileSync) and asserts import specifiers:

```ts
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
// resolve paths relative to this test file (server/providers/)
it('provider contract imports no concrete provider', () => {
  const src = readFileSync(typesPath, 'utf8')
  const imports = [...src.matchAll(/from\s+'(\.[^']+)'/g)].map(m => m[1])
  expect(imports.some(p => p.startsWith('./claude/') || p.startsWith('./native/'))).toBe(false)
})
it('neutral attachment-types imports no concrete provider', () => {
  // attachment-types.ts import specifiers: only ../agent-message.js allowed; no ./native/ ./claude/
})
it('neutral hook-types imports no concrete provider', () => {
  // hook-types.ts import specifiers: only ../../shared/hooks.js allowed; no ./claude/ ./native/
})
it('attachment index lives in native (no host-root module)', () => {
  // assert server/providers/native/attachment-reference-index.ts exists; server/attachment-reference-index.ts does NOT
})
```

- [ ] **Step 2: Run the pin test**

Run: `npx vitest run server/providers/seam-neutrality.test.ts`
Expected: PASS (all four pins green after Tasks 1-3).

- [ ] **Step 3: Cycle check**

Verify no production import cycle remains between the attachment index and native. Inspect the import graph: `native/attachment-reference-index.ts` imports only `./session-log/log.js`, `./session-log/format.js`, `../../log.js`; `upload-store.ts` imports it one-way; native-session's `UploadStore` import is `import type` (erased). Confirm `native/session-log/format.ts`'s host imports (agent-definition-store, agent-message) do not import upload-store or the index back. If a madge-style check is available run it; otherwise document the manual graph inspection in the report. A harmful ESM cycle would also surface as undefined-import load failures in the full suite.

- [ ] **Step 4: Full verify**

Run: `npm run verify`
Expected: typecheck ×4, lint, verify:agent-notes, full vitest suite (11048 tests), build — all green, behavior unchanged.

- [ ] **Step 5: Commit**

```bash
git add server/providers/seam-neutrality.test.ts
git commit -m "test(providers): pin seam neutrality and attachment-index ownership

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```
