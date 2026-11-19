# Native Host-Service Ports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the native provider fully host-free (option A item ③): zero host-domain value imports in native production code, via six injected domain ports implemented by host-side adapters, plus neutral relocation of pure functions/types and migration of the native test suite to port injection.

**Architecture:** Phase A relocates pure functions/constants/types to neutral `shared/` modules (re-exports keep host consumers working) and switches native's type/pure imports to them. Phase B scaffolds the port interfaces + host adapters + a test helper and injects ports into every NativeProvider construction while native still uses host imports (ports stored, unused). Phase C switches each service's native call sites from host import → injected port, removing that host import. Phase D makes ports required, removes residual host imports, and adds a structural neutrality pin. Suite stays green at every task.

**Tech Stack:** TypeScript / Node ≥ 20 ESM, vitest. Behavior-preserving structural refactor; no new runtime deps.

**Spec:** `.agents/notes/proposed/architecture/2026-11-19-native-host-service-ports.md`

## Global Constraints

- BEHAVIOR-PRESERVING: no runtime semantics change. `npm run typecheck` (×4: tsconfig.json, tsconfig.node.json, desktop/tsconfig.json, tests/browser/tsconfig.json) green and affected tests green at EVERY task; full `npm run verify` green at Task 13.
- END STATE: native production code (server/providers/native/**, excluding test files) has ZERO value import of: config, anthropic-api, mcp-config, profiles, effort-capability, attachment-object-store, attachment-access, skills, permission-broker, history-reader, history-utils, subagent-transcripts, agent-definition-store. Generic infra (log, metrics, errors, pushable, win32-job, shell-encoding, safe-dns) stays shared.
- ConfigPort decision B: getter-backed live view (reads CURRENT config binding, reload-safe) + resolved activeProfile()/fallbackProfile() + hasProfiles getter; raw credential fields never cross into native; profile-resolution policy + per-config fallback WeakMap cache live in the HOST adapter. The two native profile branches stay distinct: native-provider.ts:261 `opts.profile ?? (port.hasProfiles ? port.activeProfile() : port.fallbackProfile())`; native-session.ts:428 `opts.profile ?? port.activeProfile()`.
- Ports defined native-side in server/providers/native/ports.ts (neutral types only); real adapters HOST-side in server/providers/native-host-adapters.ts; default-providers.ts injects them.
- Relocated neutral modules import no host-domain module; host modules re-export relocated symbols for compatibility.
- AttachmentStoreError: single neutral definition; native instanceof resolves against the class the host throws.
- TranscriptPort = location decoupling only; SDK message SHAPE stays for item ⑤ (do not neutralize frame vocabulary; AgentMessage=SDKMessage and copyConsumedAt/projectFileBlocksForProvider untouched).
- Diagnostics via createLogger; never bare console.*. Commit conventional lowercase-led subject + `Co-Authored-By: Claude Code <noreply@anthropic.com>`.
- Work on a feature branch; code-review the full branch diff before main. Use plain git in the worktree (MCP git-tools targets the main checkout).
- TDD adaptation for a refactor: each task's gate is typecheck + affected tests green; behavior pins added where a semantic could drift (ConfigPort resolved profiles, AttachmentStoreError identity). The structural neutrality pin is added at Task 13.

## Review Focus

- **ConfigPort credential/model drift** — host adapter must mirror fallbackProfile construction + per-config WeakMap caching + activeProfile resolution exactly, and hasProfiles must reproduce the provider branch while the session keeps its distinct empty-profiles policy. Pinned Task 7 (resolved-profile assertions incl. empty-profiles + reload).
- **Live-config call-time semantics** — getters read the current binding, not a snapshot; pdfDocumentsEnabled-style closures and runtime reload behave as before. Pinned Task 7 (reload + closure test).
- **AttachmentStoreError identity** — native instanceof must match the host-thrown class after relocation (single neutral definition + host re-export). Pinned Task 3/10.
- **Test-migration completeness** — a missed construction/mock migration breaks verify; vi.mock host-module strategies must become port mocks. Pinned Task 6 (all constructions inject) + per-service tasks + Task 13 full verify.
- **Premature host-import removal** — removing a host import before its call sites switch to the port breaks runtime; each Phase C task switches call sites AND removes the import together. Pinned per-task typecheck + tests; Task 13 structural pin confirms zero residual.

## File Structure

- Create `shared/profile.ts` (ProviderProfile, ModelGroupConfig types), `shared/model-capability.ts` (effort ladders), `shared/question-result.ts` (isQuestionResult + QUESTION_RESULT), `shared/attachment-store-error.ts` (AttachmentStoreError + codes + VerifyFileInput), `shared/transcript-format.ts` (RawLine/HistoryPage/HistoryEntry/HistoryReadResult + isSafeSessionId/isRenderableSdkMessage + BROADCAST_SYSTEM_SUBTYPES/isInterruptPlaceholder + DEFAULT_DIR_NAME). Extend `shared/skills.ts` (parseSkillFrontmatter/MAX_SKILL_BYTES/ParsedSkillFrontmatter/SkillRootInfo) and `shared/agent-definitions.ts` (agentUnusableReason/AGENT_FIELDS). ResolvedFileAttachment → `shared/attachment-types.ts` or shared/profile-adjacent neutral module (agent-message re-exports).
- Create `server/providers/native/ports.ts` (6 port interfaces + NativeHostPorts aggregate).
- Create `server/providers/native-host-adapters.ts` (host-side adapters implementing the ports) + `server/providers/native-host-adapters.test.ts` or a test helper `makeNativePorts()`.
- Modify native call sites: native-provider.ts, native-session.ts, anthropic-stream.ts, loop.ts, mcp/connections.ts, mcp/shared-record.ts, pdf-documents.ts, tools/attachment-read.ts, tools/web-fetch.ts, skills.ts, skill-render.ts, session-log/{reader,paths,cache}.ts, subagent-transcripts.ts, model-context.ts.
- Modify host wiring: default-providers.ts; host modules re-export relocated symbols (config.ts, effort-capability.ts, permission-broker.ts, agent-definition-store.ts, attachment-object-store.ts, attachment-access.ts, skills.ts, history-reader.ts, history-utils.ts, subagent-transcripts.ts, json-file-store.ts, agent-message.ts).
- Modify ~30 native test files (port injection + mock strategy).
- Create `server/providers/native/host-free.test.ts` (structural neutrality pin, Task 13).

---

## Phase A — neutral relocations (type/pure imports leave native)

### Task 1: Profile types to shared/profile.ts

**Files:** Create `shared/profile.ts`; Modify `server/config.ts` (re-export), native type importers (model-context.ts:1, tools/web-fetch.ts:8, native-provider.ts, native-session.ts).
**Interfaces:** Produces `ProviderProfile` / `ModelGroupConfig` types from `shared/profile.ts` (verbatim from config.ts:54-71 + ModelGroupConfig). config.ts re-exports them.
- [ ] Move the type definitions verbatim to shared/profile.ts (no host imports). config.ts imports + `export type` re-exports. Switch native TYPE imports to shared/profile.ts. (config VALUE reads stay until Task 7.)
- [ ] Verify: `npm run typecheck` + `npx vitest run server/providers/native/model-context.test.ts server/providers/native/tools/web-fetch.test.ts` (or affected). Green.
- [ ] Commit: `refactor(shared): relocate ProviderProfile/ModelGroupConfig types to a neutral module` + footer.

### Task 2: Pure capability/question/agent functions to shared

**Files:** Create `shared/model-capability.ts`, `shared/question-result.ts`; Modify `shared/agent-definitions.ts`, host re-exporters (effort-capability.ts, permission-broker.ts, agent-definition-store.ts), native importers (anthropic-stream.ts, native-session.ts:694/920/1892, session-log/format.ts:245).
**Interfaces:** Produces `effortLevelsForModel`/`supportsFastModeForModel`/`supportsThinkingForModel` (shared/model-capability.ts), `isQuestionResult`+`QUESTION_RESULT` (shared/question-result.ts), `agentUnusableReason` (host-class param narrowed structurally)+`AGENT_FIELDS` (shared/agent-definitions.ts). Host modules re-export.
- [ ] Move the pure functions/constants verbatim to the neutral modules (no host-domain imports; agentUnusableReason's AgentDefinitionStore param narrowed to the structural shape it uses). Host modules import + re-export. Switch native imports to the neutral modules (removes native's effort-capability/permission-broker/agent-definition-store value imports).
- [ ] Verify: typecheck + `npx vitest run server/providers/native/native-session.test.ts server/providers/native/anthropic-stream.test.ts server/permission-broker.test.ts`. Green.
- [ ] Commit: `refactor(shared): relocate pure capability/question/agent helpers to neutral modules` + footer.

### Task 3: Attachment types + error to shared

**Files:** Create `shared/attachment-store-error.ts`; Modify `shared/attachment-types.ts` (or neutral home for ResolvedFileAttachment), host re-exporters (agent-message.ts, attachment-object-store.ts, attachment-access.ts), native importers (pdf-documents.ts, tools/attachment-read.ts, attachment-projection.ts).
**Interfaces:** Produces `AttachmentStoreError`+codes+`VerifyFileInput` (shared/attachment-store-error.ts); `ResolvedFileAttachment` relocated to neutral (agent-message.ts re-exports). attachment-types.ts imports ResolvedFileAttachment from the neutral home.
- [ ] Move AttachmentStoreError class + codes + VerifyFileInput verbatim to shared/attachment-store-error.ts; ResolvedFileAttachment to neutral. Host modules re-export (single definition; native instanceof resolves against host-thrown class). Switch native type/error imports to neutral. (AttachmentObjectStore.readVerified / resolveAuthorizedAttachment VALUE imports stay until Task 10.)
- [ ] Verify: typecheck + `npx vitest run server/providers/native/pdf-documents.test.ts server/providers/native/tools/attachment-read.test.ts`. Add a pin: native instanceof AttachmentStoreError matches an error constructed via the host re-export path. Green.
- [ ] Commit: `refactor(shared): relocate attachment error/types to neutral modules` + footer.

### Task 4: Skills pure helpers to shared/skills.ts

**Files:** Modify `shared/skills.ts`, `server/skills.ts` (re-export), native importers (skills.ts, skill-render.ts).
**Interfaces:** Produces `parseSkillFrontmatter`+`MAX_SKILL_BYTES`+`ParsedSkillFrontmatter`/`SkillRootInfo` types in shared/skills.ts. server/skills.ts re-exports. (listSkills VALUE import stays until Task 11.)
- [ ] Move parseSkillFrontmatter (pure) + MAX_SKILL_BYTES + the types verbatim into shared/skills.ts (SkillRecord already there). server/skills.ts re-exports. Switch native skill-render.ts/skills.ts pure imports to shared.
- [ ] Verify: typecheck + `npx vitest run server/providers/native/skills.test.ts server/providers/native/skill-render.test.ts`. Green.
- [ ] Commit: `refactor(shared): relocate skill frontmatter helpers to neutral skills module` + footer.

### Task 5: Transcript types + predicates to shared/transcript-format.ts

**Files:** Create `shared/transcript-format.ts`; Modify host re-exporters (history-reader.ts, history-utils.ts, json-file-store.ts), native importers (session-log/reader.ts, paths.ts, cache.ts, replay.ts, subagent-transcripts.ts, subagent-transcript-source.ts, attachment-projection.ts, native-provider.ts).
**Interfaces:** Produces `RawLine`/`HistoryPage`/`HistoryEntry`/`HistoryReadResult` types + `isSafeSessionId`/`isRenderableSdkMessage` (carrying BROADCAST_SYSTEM_SUBTYPES + isInterruptPlaceholder) + `DEFAULT_DIR_NAME` in shared/transcript-format.ts (SDK-free structural types). Host modules re-export. (normalize/paginateRenderable/normalizeSubagentLine VALUE imports stay until Task 12.)
- [ ] Move the types + pure predicates + constant verbatim to shared/transcript-format.ts (no host-domain imports; isRenderableSdkMessage brings its dependency constants). Host modules re-export. Switch native type/predicate imports to neutral.
- [ ] Verify: typecheck + `npx vitest run server/providers/native/session-log server/providers/native/subagent-transcripts.test.ts`. Green.
- [ ] Commit: `refactor(shared): relocate transcript-format types/predicates to a neutral module` + footer.

---

## Phase B — ports scaffolding (inject everywhere, native still uses host imports)

### Task 6: Port interfaces + host adapters + inject into all constructions

**Files:** Create `server/providers/native/ports.ts`, `server/providers/native-host-adapters.ts`, test helper `makeNativePorts()` (in native-host-adapters.ts or a test-utils module); Modify `server/providers/default-providers.ts`, `server/providers/native/native-provider.ts` (opts.ports?), `native-session.ts` (NativeSessionOptions.ports?), and ALL ~150 NativeProvider constructions across prod + ~30 test files.
**Interfaces:**
- Produces `ports.ts`: `NativeConfigPort` (per spec: nativeAttachmentFidelity/nativePdfDocuments/nativeAutoCompactRatio/modelList/hasProfiles getters + activeProfile()/fallbackProfile()), `NativeAuxLlmPort.call(req)`, `NativeMcpTransportPort.createTransport/isAuthError`, `NativeAttachmentPort.readVerified/resolveAuthorized`, `NativeSkillPort.listSkills`, `NativeTranscriptPort.normalize/paginateRenderable/normalizeSubagentLine`, and `NativeHostPorts { config; auxLlm; mcpTransport; attachment; skill; transcript }`. Neutral types only (imports shared/* + SDK).
- Produces `native-host-adapters.ts`: `createNativeHostPorts(deps: { stateDir; uploadStore; authFor }): NativeHostPorts` implementing each port by wrapping the host service modules (ConfigPort getter-backed live view + activeProfile/fallbackProfile + per-config WeakMap cache mirroring native-provider.ts:196-212; hasProfiles = config.profiles.length>0). Test helper `makeNativePorts()` builds these for tests.
- [ ] Write ports.ts interfaces (verbatim from spec) + native-host-adapters.ts implementations. ConfigPort adapter mirrors fallbackProfile construction + caching exactly.
- [ ] Add `ports?: NativeHostPorts` to NativeProvider opts + NativeSessionOptions; store on provider/session (UNUSED by call sites yet). default-providers.ts injects createNativeHostPorts(...).
- [ ] Update EVERY NativeProvider construction (prod + tests) to inject ports via makeNativePorts()/createNativeHostPorts. Native call sites still use host imports (ports stored, unused) — suite stays green.
- [ ] Add a host-adapters test: ConfigPort.activeProfile/fallbackProfile/hasProfiles match the current native-provider resolution for loaded + empty-profiles config; reload observed via getters.
- [ ] Verify: typecheck + FULL `npx vitest run server/providers/native` green (all constructions inject ports; behavior unchanged).
- [ ] Commit: `feat(native): port interfaces + host adapters; inject ports into all constructions` + footer.

---

## Phase C — per-service call-site switches (each removes its host import)

### Task 7: ConfigPort switch

**Files:** Modify native-provider.ts (config reads :203-208/:236/:244/:261-262/:273, fallbackProfile :196-212 removed), native-session.ts (:428/:1240/:1749/:1824), tools/web-fetch.ts (config type already neutral); remove native config/profiles value imports.
**Interfaces:** Consumes NativeConfigPort (Task 6).
- [ ] Switch native config reads to this.ports.config.X; provider profile branch → `opts.profile ?? (port.hasProfiles ? port.activeProfile() : port.fallbackProfile())`; session :428 → `opts.profile ?? port.activeProfile()`. Remove native fallbackProfile() (now in host adapter). pdfDocumentsEnabled closure captures port. Remove native's config/resolveActiveProfile/DEFAULT_PROFILE value imports.
- [ ] Behavior pin: resolved profile (loaded + empty-profiles) + nativeAttachmentFidelity/nativePdfDocuments closure reads + runtime reload match pre-refactor (assert via makeNativePorts ConfigPort backed by __setConfigForTest).
- [ ] Verify: typecheck + `npx vitest run server/providers/native/native-session.test.ts server/providers/native/native-provider.test.ts server/providers/native/e2e-attachment-fidelity.test.ts`. Green.
- [ ] Commit: `refactor(native): route config reads through ConfigPort` + footer.

### Task 8: AuxLlmPort switch

**Files:** Modify native-session.ts (generateTitle :1798), tools/web-fetch.ts (:87, WebFetchDeps gains auxLlm); remove native anthropic-api import.
**Interfaces:** Consumes NativeAuxLlmPort.
- [ ] generateTitle + web-fetch call this.ports.auxLlm.call(req) (req shape per spec; target from credentials). WebFetchDeps gains auxLlm threaded from session. Remove native anthropic-api value import.
- [ ] Verify: typecheck + `npx vitest run server/providers/native/tools/web-fetch.test.ts server/providers/native/native-session.test.ts` (generateTitle). Tests mock the auxLlm port (not vi.mock anthropic-api). Green.
- [ ] Commit: `refactor(native): route auxiliary LLM calls through AuxLlmPort` + footer.

### Task 9: McpTransportPort switch

**Files:** Modify mcp/connections.ts (:558/:573-576), mcp/shared-record.ts (:451/:511/:544); NativeMcpConnectionsOptions + SharedRecordOptions gain transportPort; remove native mcp-config import.
**Interfaces:** Consumes NativeMcpTransportPort; McpTransportTarget from shared/mcp-transport.ts (relocate the type here if not already neutral).
- [ ] connections/shared-record call transportPort.createTransport(target, opts)/isAuthError(err). Thread transportPort from provider → NativeMcpConnections → SharedRecord. Remove native mcp-config value import. (authFor stays injected.)
- [ ] Verify: typecheck + `npx vitest run server/providers/native/mcp`. Green.
- [ ] Commit: `refactor(native): route MCP transport creation through McpTransportPort` + footer.

### Task 10: AttachmentPort switch

**Files:** Modify pdf-documents.ts (:308/:311/:335), tools/attachment-read.ts (:189/:193/:197/:296); AttachmentReadDeps gains attachmentPort; remove native attachment-object-store/attachment-access imports.
**Interfaces:** Consumes NativeAttachmentPort.
- [ ] pdf-documents/attachment-read call attachmentPort.readVerified(input)/resolveAuthorized(occurrence). Host adapter owns AttachmentObjectStore(stateDir) + resolveAuthorizedAttachment(uploadStore). Thread attachmentPort via provider → session → AttachmentReadDeps. Remove native attachment-object-store/attachment-access value imports. instanceof AttachmentStoreError uses neutral class (Task 3).
- [ ] Verify: typecheck + `npx vitest run server/providers/native/pdf-documents.test.ts server/providers/native/tools/attachment-read.test.ts server/providers/native/e2e-attachment-fidelity.test.ts`. Green.
- [ ] Commit: `refactor(native): route attachment reads through AttachmentPort` + footer.

### Task 11: SkillPort switch

**Files:** Modify skills.ts (NativeSkillCatalog :86 listSkills), skill-render.ts (already neutral parseSkillFrontmatter); NativeSkillCatalog gains skillPort; remove native skills value import.
**Interfaces:** Consumes NativeSkillPort.
- [ ] NativeSkillCatalog.reload calls skillPort.listSkills(cwd). Thread skillPort from provider → session → catalog. Remove native skills value import (listSkills). MAX_SKILL_BYTES/parseSkillFrontmatter already neutral (Task 4).
- [ ] Verify: typecheck + `npx vitest run server/providers/native/skills.test.ts server/providers/native/skills-reload.test.ts server/providers/native/e2e-skills.test.ts server/providers/native/e2e-skill-invocation.test.ts`. Tests mock skillPort.listSkills (not vi.mock skills.js). Green.
- [ ] Commit: `refactor(native): route skill discovery through SkillPort` + footer.

### Task 12: TranscriptPort switch

**Files:** Modify session-log/reader.ts (:196/:210/:276), paths.ts (:22 isSafeSessionId already neutral), cache.ts (:149 isRenderableSdkMessage already neutral), subagent-transcripts.ts (:26/:35); session-log gains transcriptPort; remove native history-reader/history-utils/subagent-transcripts value imports.
**Interfaces:** Consumes NativeTranscriptPort.
- [ ] reader calls transcriptPort.normalize/paginateRenderable; subagent-transcripts calls transcriptPort.normalizeSubagentLine. Thread transcriptPort via provider → session → session-log. Remove native history-reader/history-utils/subagent-transcripts value imports (types/predicates already neutral, Task 5). DEFAULT_DIR_NAME already neutral.
- [ ] Verify: typecheck + `npx vitest run server/providers/native/session-log server/providers/native/subagent-transcripts.test.ts server/providers/native/e2e-mcp.test.ts`. Green.
- [ ] Commit: `refactor(native): route transcript transforms through TranscriptPort` + footer.

---

## Phase D — finalize host-free

### Task 13: Ports required + structural pin + full verify

**Files:** Modify native-provider.ts (opts.ports required), NativeSessionOptions (ports required); Create `server/providers/native/host-free.test.ts`; remove any residual host-domain value import.
**Interfaces:** Consumes all ports.
- [ ] Tighten opts.ports to REQUIRED (all constructions already inject from Task 6). Grep native prod for residual host-domain value imports; remove any stragglers (switch to port/neutral).
- [ ] Write host-free.test.ts structural pin: scan server/providers/native/** prod files (exclude *.test.ts); assert ZERO value import of the host-domain service list (config/anthropic-api/mcp-config/profiles/effort-capability/attachment-object-store/attachment-access/skills/permission-broker/history-reader/history-utils/subagent-transcripts/agent-definition-store). Generic infra allowed. Also assert ports.ts + neutral shared modules import no host-domain module.
- [ ] Run pin test (green). Run FULL `npm run verify` (typecheck ×4, lint, agent-notes, full vitest suite, build) — all green, behavior unchanged.
- [ ] Commit: `feat(native): require ports; pin host-free native production code` + footer.
