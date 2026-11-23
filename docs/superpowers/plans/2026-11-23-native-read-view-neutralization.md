# Native Read-View Neutralization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the native core read neutral v3 events directly (not the legacy `log.events` projection), so the core is neutral on BOTH write and read paths and the legacy projection shrinks to v1/v2 migration + writer write-compat + the host history seam only.

**Architecture:** Option C left the core "writes neutral, reads legacy (via `projectNeutralEventToLegacy`)". Four read-side consumers (attachment index, agent-profile selection, PDF budgets, usage restore) plus `getAttachmentOccurrences`/`getSkillCompactionEntries`/fork seeds still read the legacy `events` view. Migrate each to read `neutralEvents` (with a `migrateEventToV3` fallback for unmigrated v1/v2 logs), neutralize fork seeds, then shrink `log.events`/the live projection and tighten the neutrality pin. Behavior-preserving: every consumer's output must be identical to today's legacy-read output.

**Tech Stack:** TypeScript (Node ≥20 ESM, five tsconfigs), vitest, the neutral vocabulary (`server/providers/native/vocabulary/`), `migrateEventToV3` (`session-log/migration.ts`), the TS-AST neutrality pin (`vocabulary/neutrality.test.ts`).

**Spec:** `.agents/notes/implemented/architecture/2026-11-18-provider-seam-neutralization.md` (option C; this completes its read-side neutrality). Consumer map: the 2026-11-23 investigation (attachment-reference-index.ts:32/100/110, agent-profile.ts:82, pdf-documents.ts:98, native-session.ts:927/1656/1743, log.ts:234/237/133/400, format.ts:1212 projectNeutralEventToLegacy, fork.ts:63).

## Global Constraints

- BEHAVIOR-PRESERVING: each migrated consumer's output deep-equals today's legacy-read output for the same log (v3 AND v1/v2). `npm run typecheck` (×5) green + affected tests green at EVERY task; full `npm run verify` green at Task 6.
- The neutral read uses `neutralEvents` for v3 logs; for unmigrated v1/v2 logs (arbitrary on-disk reads, e.g. attachment-index `rebuild`) fall back via `migrateEventToV3` — NEVER drop occurrences.
- `projectNeutralEventToLegacy` MUST STAY for: v1/v2 writer write-compat (`log.ts:404`), the host history seam (`native-host-frame-adapter.ts` `projectNativeEventToSdkLine`), and the migration round-trip pin (`migration.test.ts`). Only the LIVE read-view usages (`log.ts:133/335/400`) are removable.
- `getAttachmentOccurrences` blockPath coordinates are a HOST contract (`compact-attachments.ts` joins by uuid+path against the SDK-shaped merged transcript): `user/message` → `[i]`; `tool/result` → `[0, inner]` (the legacy projection wraps tool/result content in one tool_result block at outer index 0). Preserve these EXACTLY.
- Neutrality: core production files import no SDK/host-frame vocabulary; the pin (`vocabulary/neutrality.test.ts`) stays green and is tightened at Task 6.
- Diagnostics via `createLogger`; never bare `console.*`. Conventional commits + `Co-Authored-By: Claude Code <noreply@anthropic.com>`. Stage only task files (concurrent sessions may edit the tree).
- TDD adaptation for a refactor: each task's gate is typecheck + affected tests; behavior pins assert neutral-read output == legacy-read output.

## Review Focus

- **Unmigrated v1/v2 on-disk read:** attachment-index `rebuild` / PDF rebuild read arbitrary logs where `neutralEvents` is undefined. Expect identical occurrences via the `migrateEventToV3` fallback (no dropped file/PDF). Pinned Task 1 (helper) + Task 3 (consumers on a v1/v2 fixture).
- **blockPath coordinate contract:** `getAttachmentOccurrences` feeds host `compact-attachments` hydration joined by uuid+path. Expect `user/message`→`[i]`, `tool/result`→`[0,inner]`; a wrong coordinate silently breaks compact attachment hydration. Pinned Task 4 + e2e-attachment-fidelity.
- **Sidechain PDF counting:** PDF rebuild counts sidechain (parent_tool_use_id ≠ null) PDFs via tool_result inner blocks today. Expect the neutral `tool/result` scan to preserve sidechain counting + the compact floor. Pinned Task 3.
- **Fork seed identity:** fork uuid-cut / session_id rewrite / skill pairing over neutral events. Expect fork resume to preserve prompt uuids, skill adjacency, and the cut point identically. Pinned Task 5 + e2e-skill-invocation/e2e-persistence fork cases.
- **Usage restore model/parent filter:** main-thread usage filters parentToolUseId === null and reads model. Expect `assistant/message` `data.usage` + `data.message.source.model` + envelope parent to reproduce `restoreUsage` exactly (resume AND fork). Pinned Task 2.

---

## Task 1: Shared neutral-read foundation

**Files:**
- Create: `server/providers/native/session-log/neutral-read.ts`
- Test: `server/providers/native/session-log/neutral-read.test.ts`

**Interfaces:**
- Consumes: `NativeSessionEvent`/`NativeSessionHeader` (vocabulary/session-event), `NativeLogEvent` (format), `migrateEventToV3` (migration), `NativeFileAttachment` (shared/attachment-types), `FileBlock` (vocabulary/types).
- Produces:
  - `neutralEventsOf(snapshot: { events: readonly NativeLogEvent[]; neutralEvents?: readonly NativeSessionEvent[] | null }): NativeSessionEvent[]` — returns `neutralEvents` when present (v3), else `events.map(migrateEventToV3)` (v1/v2 fallback). The single fallback decision point (replaces the ad-hoc `native-session.ts:131-133` copy).
  - `neutralFileOccurrences(events: readonly NativeSessionEvent[]): Array<{ attachment: NativeFileAttachment; messageUuid: string; parentToolUseId: string | null; blockPath: readonly number[] }>` — scans `session/attachments` (`data.attachments`, messageUuid '' / blockPath []), `user/message` (`data.content` FileBlocks → blockPath `[i]`, messageUuid `data.id`, parentToolUseId envelope), `tool/result` (`data.message.content` FileBlocks → blockPath `[0, inner]`, messageUuid `data.message.id`, parentToolUseId envelope). The FileBlock.attachment is cast to the resolved `NativeFileAttachment` superset (same duck-typing as today). Shared by Tasks 3 (attachment/PDF) and 4 (occurrences).

- [ ] **Step 1: Write failing tests** — `neutralEventsOf` returns neutralEvents for a v3 snapshot; for a v1/v2 snapshot (neutralEvents undefined) returns events.map(migrateEventToV3) (deep-equal). `neutralFileOccurrences` on a neutral fixture (user/message with a direct FileBlock at index 1 + a tool/result with an inner FileBlock at index 0 + a session/attachments catalog) yields the exact {attachment, messageUuid, parentToolUseId, blockPath} tuples: user→[1], tool/result→[0,0], catalog→[]; sidechain parent preserved. Run `npx vitest run server/providers/native/session-log/neutral-read.test.ts` — expect FAIL.
- [ ] **Step 2: Implement** neutral-read.ts (pure; imports vocabulary + migration + shared types only).
- [ ] **Step 3: Run** — expect PASS; `npm run typecheck` green.
- [ ] **Step 4: Commit** `feat(native): shared neutral-read helpers (neutralEventsOf + neutralFileOccurrences)`.

## Task 2: Agent-profile selection + usage restore + skill compaction reads

**Files:**
- Modify: `server/providers/native/agent-profile.ts:82` (agentSelectionFromEvents), `server/providers/native/native-session.ts` (restoreUsage :927, getSkillCompactionEntries :1743, the 3 selection seed literals :685-696/:812-819/:891-897, resume usage read :848)
- Test: `server/providers/native/agent-profile.test.ts`, `server/providers/native/native-session.test.ts`, `server/providers/native/e2e-agent-profile.test.ts`

**Interfaces:**
- Consumes: `neutralEventsOf` (Task 1), `NativeSessionEvent` 'session/agent'/'assistant/message'/'turn/end'/'user/message'/'session/skill', `sdkUsageOf` (native-session.ts:137).
- Produces: `agentSelectionFromEvents(events: readonly NativeSessionEvent[]): NativeAgentSelectionEvent | undefined` (reads 'session/agent' `data.{name,definition,base,droppedAgent}`); `restoreUsage` reads neutral 'assistant/message' `data.usage` + `data.message.source.model` + envelope parentToolUseId===null filter, 'turn/end' `data.usage` fallback, 'session/compact' reset; `getSkillCompactionEntries` reads neutral 'user/message' (parentToolUseId===null, uuid=data.id) + adjacent 'session/skill' (body=data.body). The 3 selection seed literals become neutral 'session/agent' events.

- [ ] **Step 1: Write failing tests** — agentSelectionFromEvents on neutral events returns the same selection as on the legacy projection; restoreUsage(resume) on a neutral v3 log reproduces the legacy usage totals (main-thread only, model carried); getSkillCompactionEntries returns the same {afterUserUuid, body} pairs. Behavior pin: neutral-read output == legacy-read output for a representative log. Run targeted — expect FAIL.
- [ ] **Step 2: Implement** the neutral reads (agent-profile + native-session restoreUsage/getSkillCompactionEntries/selection seeds). Resume reads `neutralEventsOf(log)`; fork usage read uses the fallback (Task 5 neutralizes fork seeds fully).
- [ ] **Step 3: Run** — expect PASS incl e2e-agent-profile; typecheck green.
- [ ] **Step 4: Commit** `refactor(native): agent-profile/usage/skill reads consume neutral events`.

## Task 3: Attachment index + PDF budgets reads

**Files:**
- Modify: `server/providers/native/attachment-reference-index.ts:32/100/110` (nativeAttachmentOccurrences + rebuild + replaceSession), `server/providers/native/pdf-documents.ts:98` (rebuildFromEvents), `server/providers/native/native-session.ts:1224` (syncAttachmentReferences passes neutralEventsOf)
- Test: `server/providers/native/attachment-reference-index.test.ts`, `server/providers/native/pdf-documents.test.ts`, `server/providers/native/e2e-attachment-fidelity.test.ts`

**Interfaces:**
- Consumes: `neutralEventsOf` + `neutralFileOccurrences` (Task 1), `NativeSessionEvent` 'session/compact'.
- Produces: `nativeAttachmentOccurrences(events: readonly NativeSessionEvent[]): NativeFileAttachment[]` (maps neutralFileOccurrences → .attachment, dedup as today); `PdfBudgetLedger.rebuildFromEvents(events: readonly NativeSessionEvent[])` (compact floor from 'session/compact'; per-occurrence parentToolUseId → historyKey; modelForm==='pdf-document'/.digest/.size from the attachment). Callers pass `neutralEventsOf(snapshot)` (rebuild handles unmigrated v1/v2 via the fallback).

- [ ] **Step 1: Write failing tests** — nativeAttachmentOccurrences on neutral events == legacy output (direct + tool_result inner file blocks); rebuildFromEvents on neutral events == legacy PDF budget (incl sidechain parent counting + compact floor). **v1/v2 fixture pin:** rebuild on an unmigrated v1/v2 log (neutralEvents undefined) yields identical occurrences via the fallback. Run targeted — expect FAIL.
- [ ] **Step 2: Implement** the neutral reads (attachment index + PDF + syncAttachmentReferences).
- [ ] **Step 3: Run** — expect PASS incl e2e-attachment-fidelity; typecheck green.
- [ ] **Step 4: Commit** `refactor(native): attachment index + PDF budgets consume neutral events`.

## Task 4: getAttachmentOccurrences neutral read (host blockPath contract)

**Files:**
- Modify: `server/providers/native/native-session.ts:1656` (getAttachmentOccurrences), `:1695` (getAttachmentCatalog)
- Test: `server/providers/native/native-session.test.ts`, `server/providers/native/e2e-attachment-fidelity.test.ts`, `server/compact-attachments.test.ts`

**Interfaces:**
- Consumes: `neutralEventsOf` + `neutralFileOccurrences` (Task 1), `ProviderAttachmentOccurrence` (providers/types: {messageUuid, blockPath, attachment}).
- Produces: `getAttachmentOccurrences(): ProviderAttachmentOccurrence[]` reads neutral events via neutralFileOccurrences, emitting the HOST SDK-transcript coordinates: user/message → blockPath `[i]`; tool/result → blockPath `[0, inner]`. getAttachmentCatalog reads neutral 'session/attachments' data.attachments.

- [ ] **Step 1: Write failing tests** — getAttachmentOccurrences on a neutral log emits blockPath `[i]` for user direct files and `[0, inner]` for tool/result inner files, messageUuid = data.id / data.message.id; deep-equals the legacy output. **Host join pin:** compact-attachments hydration joins these occurrences by uuid+path against the SDK merged transcript identically (e2e-attachment-fidelity compact case). Run targeted — expect FAIL.
- [ ] **Step 2: Implement** the neutral read preserving the exact blockPath coordinates.
- [ ] **Step 3: Run** — expect PASS incl e2e-attachment-fidelity + compact-attachments; typecheck green.
- [ ] **Step 4: Commit** `refactor(native): getAttachmentOccurrences reads neutral events, preserves host blockPath`.

## Task 5: Fork seed neutralization

**Files:**
- Modify: `server/providers/native/session-log/fork.ts:63` (buildForkSeed), `:107` (synthetic repair projection), `server/providers/native/native-session.ts:884-912` (openForkLog), `server/providers/native/session-log/log.ts` (NativeSeed.events), `server/providers/native/session-log/cache.ts:191` (nextSeq)
- Test: `server/providers/native/session-log/fork.test.ts`, `server/providers/native/e2e-skill-invocation.test.ts`, `server/providers/native/e2e-persistence.test.ts`

**Interfaces:**
- Consumes: `neutralEventsOf` (Task 1), `NativeSessionEvent`, `migrateEventToV3`.
- Produces: `buildForkSeed` operates on NEUTRAL events (uuid cut, session_id rewrite via neutral envelope, skill pairing over neutral 'user/message'+'session/skill'); `NativeSeed.events` carries neutral events; openForkLog seeds neutral; the `fork.ts:107` synthetic-repair→legacy projection removed (repair returns neutral). cache nextSeq from neutralEvents length.

- [ ] **Step 1: Write failing tests** — buildForkSeed on a neutral source produces a neutral seed with the cut point preserved, prompt uuids intact, session_id rewritten, skill adjacency paired; fork resume reproduces the legacy fork behavior (e2e-skill-invocation fork cases + e2e-persistence fork). Behavior pin: neutral fork seed → resume == legacy fork seed → resume. Run targeted — expect FAIL.
- [ ] **Step 2: Implement** fork neutralization (buildForkSeed + openForkLog + NativeSeed + repair + cache nextSeq).
- [ ] **Step 3: Run** — expect PASS incl e2e-skill-invocation + e2e-persistence fork; typecheck green.
- [ ] **Step 4: Commit** `refactor(native): fork seeds operate on neutral events`.

## Task 6: Shrink legacy read view + tighten pin + finish tests

**Files:**
- Modify: `server/providers/native/session-log/log.ts:133/335/400` (remove live read-view projection; events becomes v1/v2-only or dropped for v3), `append` return (neutral), `server/providers/native/vocabulary/neutrality.test.ts` (tighten), remaining test assertions
- Test: `server/providers/native/session-log/log.test.ts` (writer v1/v2 contract STAYS), `format.test.ts`, `migration.test.ts` (round-trip pin STAYS), full verify

**Interfaces:**
- Consumes: all prior tasks (no core consumer reads the legacy v3 view anymore).
- Produces: `log.events` for a v3 log is no longer the live projected read view (either dropped or v1/v2-only); `append` returns the neutral event; `projectNeutralEventToLegacy` retained ONLY for v1/v2 write-compat (log.ts:404) + host seam + migration pin. The neutrality pin bans named imports of `NativeLogEvent`/`NativeEventInput`/`projectNeutralEventToLegacy` in core production files outside a session-log allowlist (format/log/migration/fork), reusing the TS-AST infra.

- [ ] **Step 1: Write the tightened pin** — ban NativeLogEvent/NativeEventInput/projectNeutralEventToLegacy named imports in core prod outside the session-log allowlist; assert no core consumer reads `.events` on the log outside session-log. Run — expect FAIL on any residual legacy read.
- [ ] **Step 2: Shrink** log.ts live read-view projection (load/seed/append no longer project v3→legacy for core reads); append returns neutral; update remaining callers/tests. Keep projectNeutralEventToLegacy for write-compat + host seam + migration pin.
- [ ] **Step 3: Run pin** — expect PASS. Migrate remaining test assertions from log.events to neutralEvents (native-session.test, e2e-* per investigation §8); log.test/fork.test/format.test/migration.test stay legacy (compat contracts).
- [ ] **Step 4: Full verify** — `npm run verify` (typecheck ×5, lint, agent-notes, full vitest, build) green; attribute pre-existing flakes (read-state/write-edit mtime, e2e-mcp Windows EBUSY).
- [ ] **Step 5: Update note** — seam-neutralization note: read-side neutrality complete (present-tense fact). `npm run verify:agent-notes` green.
- [ ] **Step 6: Commit** `refactor(native): shrink legacy read view to migration/compat; tighten neutrality pin`.
- [ ] **Step 7: Final whole-branch code-review** (most capable model) on the full diff; verify findings; fix confirmed (RED→GREEN); re-review non-trivial fixes. Only then land.

## Open questions deferred

- Whether `log.events` is fully dropped for v3 or kept as a thin v1/v2-only view — builder settles at Task 6 by what the writer write-compat + host seam still need.
- The exact session-log allowlist for the tightened pin (format/log/migration/fork) — builder settles by the residual legitimate legacy users.