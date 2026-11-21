# Native Frame Vocabulary Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the native provider's core speak a genuinely neutral, DSH-inspired frame vocabulary (zero SDK/host imports) behind two boundary adapters, so native is a clean lift-out module while the host stays SDK-shaped and behavior-preserving.

**Architecture:** Structure B (design R1/R3): a neutral `native/vocabulary/` module (Message/ContentBlock/StreamChunk/SessionEvent + constructors + BlockAssembler); a neutral core (turn loop, v3 log, replay, subagent, task-manager, tools); a **host adapter** (neutral frames/events ↔ SDK `AgentMessage`/`AgentUserMessage`, owns input identity + lease callbacks + the ~50-method handle) and a **wire adapter** (neutral model history → Anthropic API request). The wire STREAM IR is already neutral (`canonical.ts` `CanonicalEvent`, `anthropic-stream.ts`); the leak is at frame emission + model history + persistence, which this plan neutralizes. Native log evolves v1/v2 → v3 + lossless migration (R7 eager-at-open). Five phases; each keeps the app working via the adapters.

**Tech Stack:** TypeScript (Node ≥20 ESM, four tsconfigs), vitest (`globals:false`), `node:crypto` randomUUID, the existing `AttachmentObjectStore`/`shared/image-attachment`/`shared/attachment-types` refs, `canonical.ts` neutral stream IR.

**Spec:** `docs/superpowers/specs/2026-11-21-native-frame-vocabulary-design.md` (approved; R1–R7 builder-check resolutions are authoritative).

## Global Constraints

- BEHAVIOR-PRESERVING: host/client see identical SDK-shaped frames. `npm run typecheck` (×4: tsconfig.json, tsconfig.node.json, desktop/tsconfig.json, tests/browser/tsconfig.json) green + affected tests green at EVERY task; full `npm run verify` green at Task 18.
- Native CORE production code (`server/providers/native/**` excluding the two adapters + `*.test.ts`) has ZERO value/type import of `@anthropic-ai/claude-agent-sdk`, `../../agent-message.js` (`AgentMessage`/`AgentUserMessage`/`SDKMessage`), or host-contract frame types. The host adapter + wire adapter are the sole boundary importers. Generic infra (log/metrics/errors/pushable) + neutral `shared/*` stay allowed.
- The vocabulary module imports ONLY neutral `shared/*` types + node builtins — no SDK, no host-domain, no `../agent-message`.
- Tool-call arguments stay RAW JSON strings end-to-end (DSH obligation); the wire adapter parses to `tool_use.input` only at the API request boundary.
- `stream_event` raw Anthropic events pass through verbatim via opaque `RawStreamEvent{event:unknown}` (R2); the client's raw fields are byte-identical.
- Mixed image model: `ImageBlock = ImageRefBlock | LegacyImageBlock` (R5); migration preserves inline base64, no store offload.
- v3 migration is lossless + uuid/seq-preserving + idempotent; round-trip pin = PARSED-LINE equality (R7), not bytes.
- Diagnostics via `createLogger`; never bare `console.*`. Git via `runGit`. Conventional commits + `Co-Authored-By: Claude Code <noreply@anthropic.com>`.
- TDD adaptation for a refactor: each task's gate is typecheck + affected tests; behavior pins where a semantic could drift. The neutrality pin lands Task 18.
- Workspace per executor choice (isolated worktree recommended for a core refactor; main only with explicit owner consent). Code-review the full diff before landing. Stage only task files (concurrent sessions may edit the tree).

## Review Focus

- **Adapter field drift (highest frequency):** a neutral→SDK projection drops/alters a field a host consumer reads (pump's ~6 native system subtypes, result `modelUsage`/`iterations`/timing, assistant `usage`/`model`, user tool_result `tool_use_id`/`is_error`, envelope `uuid`/`parent_tool_use_id` null-vs-string). Expect byte-identical SDK frames. Pinned Task 6/7 reconstruction suite + Task 13 round-trip.
- **`stream_event` raw passthrough loss:** the client reads `content_block_start.content_block.name`, `content_block_delta.delta.text`, `message_delta.usage.output_tokens`, `message_stop`. Expect the raw event verbatim. Pinned Task 6 (raw byte-identity) + Task 9 live pin.
- **Migration fidelity loss:** v1/v2→v3 loses uuid identities, contiguous seq, thinking signatures/redacted data, compact text+context, skill bodies, attachment blockPaths, usage, agent base snapshot, parent null-vs-string. Expect lossless resume/fork/compact/leases. Pinned Task 12 round-trip on real image-bearing logs.
- **Model-history vs UI-history split drift:** neutral replay (model history) and the host adapter projection (UI history) diverge — consecutive tool_result grouping, signed-thinking filter, supplement dedup, sidechain skip. Expect identical post-wire-projection API messages + identical UI lines. Pinned Task 8/13.
- **Two-layer settlement drift:** live loop and replay assemble blocks differently (max-tokens tool-call drop, open-block fallback). Expect one shared BlockAssembler. Pinned Task 3 + Task 9/13.

---

## Phase 1 — Vocabulary module (neutral, zero SDK/host imports)

### Task 1: Branded ids + Message union + constructors

**Files:**
- Create: `server/providers/native/vocabulary/brand.ts`, `server/providers/native/vocabulary/message.ts`
- Test: `server/providers/native/vocabulary/message.test.ts`

**Interfaces:**
- Produces: `Branded<B extends string> = string & { readonly [BRAND]: B }` (`declare const BRAND: unique symbol`); `brandString<B>(s: string): Branded<B>`; `MessageId = Branded<'MessageId'>`, `ToolCallId = Branded<'ToolCallId'>`. `MessageBase { readonly id: MessageId; readonly content: readonly ContentBlock[]; readonly source: MessageSource }` (ContentBlock/MessageSource from Tasks 2/4 — forward-type via `import type`). `SystemMessage/DeveloperMessage/UserMessage/AssistantMessage/ToolResultMessage` per spec; `MessageRoleMap` interface (closed); `Message = MessageRoleMap[keyof MessageRoleMap]`. `RequestUserInput { role:'user'; content: UserMessage['content']; id?: never; source?: never }`; `RequestMessage = Message | RequestUserInput`. `deepFreeze<T>(v: T): T` (iterative worklist + WeakSet cycle guard, skips AbortSignal). `createMessage<T extends NewMessage>(input: T & {id?: never}): T & Pick<Message,'id'>`; `createAssistantMessage`, `createUserMessage`, `createDeveloperMessage`, `createSystemMessage(text)`, `createToolResultMessage({callId, content, isError})` — all `deepFreeze(structuredClone(...))`, mint branded id.

- [ ] **Step 1: Write failing tests** — `createToolResultMessage({callId, content:[text], isError:true})` yields `role:'tool'`, `source:{kind:'tool',callId}`, `toolCallId===callId`, `isError:true`, frozen (mutation throws/ignored); `createAssistantMessage` forces `role:'assistant'`, `source.kind:'model'`; `createMessage` mints a unique branded id; `deepFreeze` freezes nested content + tolerates cycles + skips AbortSignal.
- [ ] **Step 2: Run** `npx vitest run server/providers/native/vocabulary/message.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** brand.ts + message.ts (types may forward-reference ContentBlock/MessageSource via `import type` from Tasks 2/4; to keep Task 1 typechecking alone, declare minimal local placeholder types OR land Tasks 2/4 types first — see Step 3 note). Implement constructors + deepFreeze.
- [ ] **Step 4: Run** — expect PASS; `npm run typecheck` green.
- [ ] **Step 5: Commit** `feat(native): neutral vocabulary branded ids + Message union + constructors`.

> Builder note: Message references ContentBlock (Task 2) and MessageSource (Task 4). To keep each task typechecking alone, land the TYPE declarations in dependency order within Phase 1: Task 2 (ContentBlock) and Task 4 (source) declare types that Task 1 imports. The executor may reorder Phase 1 type-only declarations so the module typechecks at each commit; constructors/tests follow. The plan's task boundaries are review gates, not a strict commit order constraint within Phase 1.

### Task 2: ContentBlock union + TokenUsage + LlmFailure + FinishReason

**Files:**
- Create: `server/providers/native/vocabulary/types.ts`
- Test: `server/providers/native/vocabulary/types.test.ts`

**Interfaces:**
- Consumes: `ImageAttachmentRef` (`shared/image-attachment.ts`), `LegacyImageBlock` (`shared/image-attachment.ts`), `FileAttachmentRef`/`ResolvedFileAttachment` (`shared/attachment-types.ts`), `ToolCallId` (Task 1).
- Produces: `TextBlock{type:'text';text}`, `ReasoningBlock{type:'reasoning';text;signature?;redacted?:true;data?}`, `ImageRefBlock{type:'image';attachment:ImageAttachmentRef;offloaded?:true}`, `FileBlock{type:'file';attachment:FileAttachmentRef}`, `ToolCallBlock{type:'tool-call';id:ToolCallId;name;arguments:string}`, `ToolAdditionBlock{type:'tool-addition';toolName}`, `ToolRemovalBlock{type:'tool-removal';toolName}`; `ImageBlock = ImageRefBlock | LegacyImageBlock`; `ContentBlockMap` interface (merge-extensible) incl. `'image': ImageBlock`; `ContentBlock = ContentBlockMap[keyof ContentBlockMap]`; `ContentBlockType = keyof ContentBlockMap`. `TokenUsage{inputTokens;outputTokens;totalTokens?;cacheReadTokens?;cacheWriteTokens?;reasoningTokens?}` (disjoint). `LlmFailure{message;code;status?;providerRetryAfterMs?;requestId?}`. `FinishReasonMap` interface: `stop{kind:'stop'}|tool-calls{kind:'tool-calls'}|max-tokens{kind:'max-tokens'}|aborted{kind:'aborted';failure}|error{kind:'error';failure}`; `FinishReason = FinishReasonMap[keyof FinishReasonMap]`. `isRetainedThinkingBlock(block)` (moved from frames.ts: signed thinking / non-empty redacted data).

- [ ] **Step 1: Write failing tests** — `isRetainedThinkingBlock` keeps signed thinking + non-empty redacted, drops unsigned thinking; ContentBlock union discriminates; ToolCallBlock.arguments is a string (raw JSON); ImageBlock accepts both ref + legacy base64 forms.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** types.ts (no SDK/host imports; reuse neutral shared refs).
- [ ] **Step 4: Run** — expect PASS; typecheck green.
- [ ] **Step 5: Commit** `feat(native): neutral ContentBlock union + usage/failure/finish types`.

### Task 3: StreamChunk + RawStreamEvent + BlockAssembler

**Files:**
- Create: `server/providers/native/vocabulary/stream.ts`, `server/providers/native/vocabulary/assembler.ts`
- Test: `server/providers/native/vocabulary/assembler.test.ts`

**Interfaces:**
- Consumes: `ContentBlock`/`ContentBlockType`/`TokenUsage`/`FinishReason` (Task 2), `ToolCallId`/`MessageId`/`createAssistantMessage` (Task 1), `ModelMessageSource` (Task 4), `ReplayEnvelope` (Task 4).
- Produces: `StreamChunk` closed union (spec): `block-start{index;blockType}`, `text-delta{index;text}`, `reasoning-delta{index;text}`, `tool-call-delta{index;id;name?;argumentsDelta}`, `block-end{index;block}`, `usage{usage}`, `finish{reason;replayState?}`. `RawStreamEvent{type:'raw-stream-event';event:unknown}` (R2 opaque passthrough). `NativeLiveFrame = StreamChunk | RawStreamEvent`. `BlockAssembler` class: `push(chunk: StreamChunk): void`; `assembled(): void`; `blocks(): ContentBlock[]`; `interruptedBlocks(): ContentBlock[]` (text/reasoning only, non-whitespace); `get usage(): TokenUsage|undefined`; `get finish(): FinishReason` (default `{kind:'stop'}`); `get replayState(): ReplayEnvelope|undefined`; `message(source: Omit<ModelMessageSource,'kind'>): AssistantMessage`. Settlement: first close wins; straggler deltas/re-closes ignored; `finish.kind==='max-tokens'` drops every tool-call block AND prunes `replay.blocks` at same positions; misaligned envelope length ⇒ `replay:undefined`; open text/reasoning assemble from deltas; open tool-call fallback id `call-${index}`, name `''`.

- [ ] **Step 1: Write failing tests** — interleaved deltas by index assemble correctly; block-end authoritative over deltas; max-tokens drops tool-call blocks + prunes replay.blocks at matching positions; misaligned envelope discarded; open text block assembles from accumulated deltas; `message(source)` yields a frozen AssistantMessage; usage/finish accessors; `assertNever` on unknown chunk.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** stream.ts + assembler.ts (mirror DSH assembler.ts:38-208 semantics; one shared assembler for live + replay).
- [ ] **Step 4: Run** — expect PASS; typecheck green.
- [ ] **Step 5: Commit** `feat(native): neutral StreamChunk + RawStreamEvent + shared BlockAssembler`.

### Task 4: MessageSource + ContextForm + ReplayEnvelope

**Files:**
- Create: `server/providers/native/vocabulary/source.ts`
- Test: `server/providers/native/vocabulary/source.test.ts`

**Interfaces:**
- Produces: `AssistantProviderMetadata{provider;model;replayState?:unknown}`, `ModelMessageSource extends AssistantProviderMetadata{kind:'model'}`, `ToolMessageSource{kind:'tool';callId:ToolCallId}`, `SystemPromptMessageSource{kind:'system-prompt'}`; `MessageSourceMap` interface (merge-extensible): `user{kind:'user'}|model|tool|'system-prompt'`; `MessageSource = MessageSourceMap[keyof MessageSourceMap]`. `ContextForm = 'instructions'|'catalog'|'snapshot'|'notice'|'relay'|'recall'`; `ContextSnapshotSection{name;text}`; `ContextFormed` discriminated union (form?:never | instructions | catalog | snapshot{sections} | notice{summary} | relay | recall); `CONTEXT_SUMMARY_MAX_CHARS=120`; `boundContextSummary(s)`. `ReplayEnvelope{response:unknown;blocks?:readonly unknown[]}`.

- [ ] **Step 1: Write failing tests** — MessageSource discriminates by kind; ContextFormed cannot pick `snapshot` without sections nor `notice` without summary (type-level + runtime guard); boundContextSummary ellipsizes at 120; declaration merging adds a producer kind (compile-time pin via a test module augmenting MessageSourceMap).
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** source.ts.
- [ ] **Step 4: Run** — expect PASS; typecheck green.
- [ ] **Step 5: Commit** `feat(native): neutral MessageSource provenance + ContextForm + ReplayEnvelope`.

### Task 5: SessionEvent union (durable neutral log vocabulary)

**Files:**
- Create: `server/providers/native/vocabulary/session-event.ts`
- Test: `server/providers/native/vocabulary/session-event.test.ts`

**Interfaces:**
- Consumes: `Message`/`UserMessage`/`AssistantMessage`/`ToolResultMessage`/`DeveloperMessage`/`SystemMessage` (Task 1), `TokenUsage` (Task 2), `StreamChunk` (Task 3), `NativeFileAttachment` (`shared/attachment-types.ts`).
- Produces: `SessionSeq = number`; `AssistantStreamRecord` (packed timed runs: `text-chunks{time0;index;dt;texts}` | `reasoning-chunks{...}` | `tool-call-chunks{time0;index;dt;id;name?;args}` | `chunk{time;chunk}`). `SessionEventMap` interface (merge-extensible), durable counterparts of TODAY's 11-event union (R6): `'user/message': UserMessage`; `'assistant/message': {message:AssistantMessage;stream:AssistantStreamRecord[];usage?:TokenUsage;interrupted?:true}`; `'tool/result': {message:ToolResultMessage;error?{name;code;reason?};meta?:JsonValue}`; `'session/context': {text}`; `'turn/end': {reason:NativeTurnEndReason;usage?:TokenUsage}`; `'session/end-seed': {inherited?:true}`; `'session/compact': {text;context;uuid;timestamp}`; `'session/supplement': {uuid;text;timestamp}`; `'session/skill': {name;body;timestamp}`; `'subagent/descriptor': {toolUseId;parentToolUseId;kind:'agent'|'skill';toolName;label;depth;profile:NativeAgentProfile|null;timestamp}`; `'session/attachments': {attachments:NativeFileAttachment[];timestamp}`; `'session/agent': {name:string|null;definition?;base:NativeAgentBase;droppedAgent?}`. `SessionEvent<T> = {type:T;seq:SessionSeq;time:number;data:SessionEventMap[T];ignorable?:true}`; `NativeSessionEvent = SessionEvent<keyof SessionEventMap>`; `NativeSessionHeader{type:'session/header';v:3;id;cwd;createdAt;isSeeded;inheritedEventCount}`. `isSidechainEvent` (user/assistant/tool with non-null parent — parent carried on the message source or envelope; preserve null-vs-string).

- [ ] **Step 1: Write failing tests** — SessionEvent discriminates by type; seq contiguous validation; sidechain discriminator preserves null-vs-string parent; header v:3; each durable event round-trips JSON.stringify/parse.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** session-event.ts (neutral; NativeAgentProfile/NativeAgentBase types relocated to neutral or imported from a neutral home — if agent-profile.ts imports host types, relocate the pure types to vocabulary or shared first).
- [ ] **Step 4: Run** — expect PASS; typecheck green.
- [ ] **Step 5: Commit** `feat(native): neutral durable SessionEvent vocabulary (v3)`.

---

## Phase 2 — Adapters + reconstruction contract

### Task 6: Host adapter — neutral frames → SDK AgentMessage (+ reconstruction pin)

**Files:**
- Create: `server/providers/native-host-frame-adapter.ts` (host-side; imports SDK types + vocabulary)
- Test: `server/providers/native-host-frame-adapter.test.ts`

**Interfaces:**
- Consumes: vocabulary `Message`/`ContentBlock`/`NativeLiveFrame`/`RawStreamEvent`/`NativeSessionEvent`, `AgentMessage`/`AgentUserMessage` (`../../agent-message.js` — adapter is a boundary importer).
- Produces: `projectNativeFrameToSdk(frame: NativeLiveFrame, env: {sessionId;uuid;parentToolUseId;receivedAt?}): AgentMessage` — assistant Message → SDK assistant frame (`message.{id,model,content,stop_reason,usage}`; tool-call→tool_use{id,name,input:JSON.parse(arguments)}; reasoning→thinking(+signature)/redacted_thinking; text→text); tool result Message → SDK user tool_result frame; `RawStreamEvent` → `{type:'stream_event',event}` VERBATIM (R2). `projectNativeEventToSdk(event: NativeSessionEvent): AgentMessage|null` — operational events → exact SDK subtypes native emits (R6): init/api_retry/informational/task_started/task_notification/result. Envelope stamps `type/uuid/session_id/parent_tool_use_id`(null-vs-string)/receivedAt.

- [ ] **Step 1: Write failing tests (the reconstruction contract, R6-scoped)** — for each native emission, assert the projected SDK frame deep-equals the frame `frames.ts` produces today (golden frames captured from current constructors): assistant (content blocks incl. thinking signature/redacted, tool_use input parsed, usage/model), user tool_result (tool_use_id/is_error/content), result (subtype/is_error/num_turns/result/usage/modelUsage/iterations/fast_mode_state/timing), init/api_retry/informational/task_started/task_notification (full field sets). **stream_event raw byte-identity**: `projectNativeFrameToSdk({type:'raw-stream-event',event:E}).event === E` for real Anthropic events (content_block_start with tool name, content_block_delta, message_delta.usage, message_stop). Envelope parent null-vs-string preserved.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** the projection (adapter owns SDK field names; vocabulary carries facts; SDK-only representation in opaque envelope/meta).
- [ ] **Step 4: Run** — expect PASS; typecheck green.
- [ ] **Step 5: Commit** `feat(native): host adapter neutral→SDK frame projection + reconstruction pin`.

### Task 7: Host adapter — SDK input → neutral + handle surface

**Files:**
- Modify: `server/providers/native-host-frame-adapter.ts`
- Test: `server/providers/native-host-frame-adapter.test.ts`

**Interfaces:**
- Consumes: `AgentUserMessage`/`copyConsumedAt`/`projectFileBlocksForProvider` (agent-message), vocabulary `RequestMessage`/`createUserMessage`/`FileBlock`.
- Produces: `projectSdkInputToNative(message: AgentUserMessage): RequestMessage` — file blocks → neutral FileBlock ref (handle-text projection stays adapter-side via projectFileBlocksForProvider); base64 image → LegacyImageBlock; ref image → ImageRefBlock; text → TextBlock; re-key receivedAt identity onto neutral uuid. `NativeSessionCore` interface (the neutral core contract the adapter wraps): `messages: AsyncIterable<NativeLiveFrame>`; `enqueue(msg: RequestMessage): void`; `enqueueControl(msg: RequestMessage): void`; `drainQueued(): RequestMessage[]`; `clearQueued(): number`; neutral persistence-outcome callbacks; `compactInPlace`, `getAttachmentOccurrences`, `getSkillCompactionEntries`, `getContextUsage`, steering, interrupt/destroy/abort (neutral-typed). `wrapNativeCore(core: NativeSessionCore, hostCallbacks): ProviderSessionHandle` — implements the ~50-method handle, translating host-contract types ↔ neutral (drainQueuedInput→AgentUserMessage[], onUserMessageConsumed/Persistence wrap core outcomes, copyConsumedAt).

- [ ] **Step 1: Write failing tests** — SDK input with file/image/text blocks → neutral RequestMessage (file→ref, base64→LegacyImageBlock, ref→ImageRefBlock); receivedAt re-keyed; `wrapNativeCore` drainQueuedInput returns AgentUserMessage[] equal to legacy; lease callbacks fire on core neutral persistence outcomes; copyConsumedAt preserved across projection.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** input projection + NativeSessionCore interface + wrapNativeCore.
- [ ] **Step 4: Run** — expect PASS; typecheck green.
- [ ] **Step 5: Commit** `feat(native): host adapter SDK→neutral input + NativeSessionCore handle wrapper`.

### Task 8: Wire adapter — neutral model history → Anthropic API request

**Files:**
- Create: `server/providers/native/vocabulary/wire-projection.ts` (neutral core side; imports vocabulary + the API request shape types — this is the wire boundary)
- Modify: `server/providers/native/attachment-projection.ts` (projectNativeMessages consumes neutral history)
- Test: `server/providers/native/vocabulary/wire-projection.test.ts`

**Interfaces:**
- Consumes: vocabulary `Message`/`RequestMessage`/`ContentBlock`, `NativeProjectionOptions` (attachment-projection), `StreamRequest` (anthropic-stream).
- Produces: `projectNativeHistoryToWire(history: readonly RequestMessage[], opts: NativeProjectionOptions, signal: AbortSignal): Promise<unknown[]>` — neutral history → API request messages: first-class role-tool messages → tool_result blocks grouped into ONE user message per assistant turn (consecutive grouping); tool-call.arguments (raw JSON) → parsed tool_use.input; signed-thinking filter (isRetainedThinkingBlock); file/PDF projection (reuse projectNativeMessages's attachment logic); supplement/skill/sidechain semantics preserved. The round-trip pin compares post-projection API messages to today's `projectNativeMessages(historyFromEvents(...))` output.

- [ ] **Step 1: Write failing tests** — neutral history with consecutive tool results → ONE grouped user message; tool-call raw-JSON arguments → parsed input; unsigned thinking stripped, signed kept; sidechain skipped without closing group; supplement dedup (same uuid requeued as user drops supplement); file block → handle text / PDF document. **Round-trip pin**: for a real event corpus, `projectNativeHistoryToWire(neutralReplay(events))` deep-equals legacy `projectNativeMessages(historyFromEvents(events))`.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** wire-projection.ts; refactor projectNativeMessages to accept neutral history (or wrap).
- [ ] **Step 4: Run** — expect PASS; typecheck green.
- [ ] **Step 5: Commit** `feat(native): wire adapter neutral history→API request + round-trip pin`.

---

## Phase 3 — Core migration (atomic live + persistence + replay, R4)

### Task 9: Neutral turn loop — emit neutral frames + neutral model history

**Files:**
- Modify: `server/providers/native/loop.ts` (runTurn, LoopDeps, AggBlock)
- Test: `server/providers/native/loop.test.ts`

**Interfaces:**
- Consumes: vocabulary `BlockAssembler`/`StreamChunk`/`ContentBlock`/`Message`/`createAssistantMessage`/`createToolResultMessage`/`NativeLiveFrame`/`RawStreamEvent`, `CanonicalEvent` (canonical.ts — existing neutral wire IR), `projectNativeHistoryToWire` (Task 8).
- Produces: `LoopDeps.emit(frame: NativeLiveFrame): void` (was AgentMessage); `LoopDeps.persistToolResult(result: {uuid; message: ToolResultMessage}): void`; `runTurn(deps, frameCtx, history: RequestMessage[], turnInput: RequestMessage|readonly RequestMessage[], model, signal): Promise<TurnResult>` — history is NEUTRAL RequestMessage[] (was unknown[] API-shaped). The loop folds CanonicalEvent → BlockAssembler → neutral ContentBlock[] → createAssistantMessage; emits neutral assistant frame + RawStreamEvent passthrough (ev.raw); tool results → createToolResultMessage; per-round wire request via projectNativeHistoryToWire. `CanonicalEvent` may be aliased/adapted to StreamChunk (bridge `canonicalToChunk(ev)`), keeping anthropic-stream.ts unchanged.

- [ ] **Step 1: Write failing tests** — runTurn with a scripted CanonicalEvent stream emits neutral assistant frames (assembled blocks), RawStreamEvent passthrough byte-identical to ev.raw, neutral tool-result messages; history stays neutral RequestMessage[]; maxTurns synthetic error result; supplement drain joins neutral history; consecutive tool results group in wire projection. Live pin: emitted neutral frames project (Task 6) to the SAME SDK frames the legacy loop emitted.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** loop migration (AggBlock → BlockAssembler; emit neutral; history neutral; wire projection per round).
- [ ] **Step 4: Run** — expect PASS; typecheck green.
- [ ] **Step 5: Commit** `refactor(native): turn loop emits neutral frames + neutral model history`.

### Task 10: Neutral core session — NativeSessionCore emission + messages

**Files:**
- Modify: `server/providers/native/native-session.ts` (split: neutral core vs host-identity bookkeeping per R1)
- Test: `server/providers/native/native-session.test.ts`

**Interfaces:**
- Consumes: vocabulary types, `NativeSessionCore` (Task 7), `runTurn` (Task 9), `projectNativeFrameToSdk`/`wrapNativeCore` (Tasks 6/7).
- Produces: `NativeSession` implements `NativeSessionCore` (neutral): `messages: AsyncIterable<NativeLiveFrame>`; `enqueue(msg: RequestMessage)`; neutral `persistFrame`/`persistToolResult` (append neutral v3 events — Task 11); pumpLoop's turn-execution+persistence+emission body is neutral core; receivedAt identity/lease callbacks move to the adapter wrapper. `NativeSessionOptions` neutral-typed where it crosses into core (host-contract callbacks stay on the adapter wrapper, not core opts).

- [ ] **Step 1: Write failing tests** — core.messages yields neutral frames; enqueue accepts neutral RequestMessage; persistFrame appends neutral assistant event; the durable-retry pause works on neutral append failure; sidechain frames carry parent id neutrally. Live e2e: a full turn through core+adapter yields SDK frames identical to legacy (reuse e2e.test.ts harness).
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** the core/adapter split (R1): core neutral emission + persistence; adapter owns input identity + lease callbacks + handle surface.
- [ ] **Step 4: Run** — expect PASS; typecheck green.
- [ ] **Step 5: Commit** `refactor(native): neutral NativeSessionCore emission + messages`.

### Task 11: Persistence v3 — neutral event writer/reader

**Files:**
- Modify: `server/providers/native/session-log/format.ts` (v3 types + serialization + validation), `server/providers/native/session-log/log.ts` (writer)
- Test: `server/providers/native/session-log/format.test.ts`, `log.test.ts`

**Interfaces:**
- Consumes: vocabulary `NativeSessionEvent`/`NativeSessionHeader`/`SessionEventMap` (Task 5).
- Produces: `NATIVE_SESSION_LOG_V3 = 3`; `SUPPORTED_VERSIONS = [1,2,3]`; v3 `serializeEvent(event: NativeSessionEvent): string` / `parseEventLine` (seq contiguous, parent null-vs-string, unknown type/key corrupt); v3 writer appends neutral events. v1/v2 types retained for migration read. `eventRequiresV3` detector.

- [ ] **Step 1: Write failing tests** — v3 serialize/parse round-trips each neutral event; seq contiguity enforced; parent null-vs-string preserved (missing parent = corrupt); unknown type/key = corrupt; header v:3; v1/v2 still parse.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** v3 format + writer (keep v1/v2 parse for migration).
- [ ] **Step 4: Run** — expect PASS; typecheck green.
- [ ] **Step 5: Commit** `feat(native): v3 neutral session-log format + writer`.

### Task 12: v1/v2 → v3 lossless migration + round-trip pin

**Files:**
- Modify: `server/providers/native/session-log/log.ts` (migrateToV3), `server/providers/native/session-log/migration.ts` (new projection helpers)
- Test: `server/providers/native/session-log/migration.test.ts`

**Interfaces:**
- Consumes: v1/v2 `NativeLogEvent` (format.ts), vocabulary `NativeSessionEvent` constructors, `LegacyImageBlock`.
- Produces: `migrateEventToV3(event: NativeLogEvent): NativeSessionEvent` — user/assistant SDK-shaped events → neutral user/message + assistant/message (content blocks → neutral blocks; thinking signature/redacted preserved; tool_use → tool-call raw-JSON arguments; tool_result user frame → first-class tool/result); inline base64 image → LegacyImageBlock (R5, no offload); native-owned events → neutral counterparts verbatim; uuid/seq/parent/isCompactSummary/compact text+context/skill body/attachment blockPaths/usage/agent base preserved. `migrateToV3(log)` — eager-at-open (R7), idempotent, temp+fsync+rename+re-parse+cache-invalidate (reuse migrateToV2 safety), rewrites every event.

- [ ] **Step 1: Write failing tests** — **round-trip pin on real image-bearing v1/v2 logs**: migrate→v3→host-adapter-project (Task 6/13) → SDK lines PARSED-LINE-equal to legacy lines the host saw; uuid identities preserved; seq contiguous; thinking signatures intact; compact text+context intact; attachment blockPaths intact; inline base64 preserved as LegacyImageBlock; idempotent (migrate twice = same); fork preserves source until migrated.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** migration projection + migrateToV3 (eager-at-open trigger before first append).
- [ ] **Step 4: Run** — expect PASS; typecheck green.
- [ ] **Step 5: Commit** `feat(native): lossless v1/v2→v3 migration + parsed-line round-trip pin`.

### Task 13: Neutral replay + history read-path adapter seam

**Files:**
- Modify: `server/providers/native/session-log/replay.ts` (historyFromEvents → neutral), `reader.ts`, `cache.ts` (collectRenderable seam)
- Test: `server/providers/native/session-log/replay.test.ts`, `reader.test.ts`

**Interfaces:**
- Consumes: vocabulary `NativeSessionEvent`/`RequestMessage`, `projectNativeFrameToSdk`/`projectNativeEventToSdk` (Task 6), `projectNativeHistoryToWire` (Task 8), `transcriptPort.normalize/paginateRenderable` (host history-reader, SDK-shaped).
- Produces: `historyFromEvents(events: readonly NativeSessionEvent[]): RequestMessage[]` (NEUTRAL model history; compact floor, consecutive tool-result grouping, signed-thinking filter, skill body verbatim, supplement dedup, sidechain skip — semantics preserved). `repairInterruptedTurn` mints neutral synthetic error tool/results. History read path: neutral v3 events → adapter projects to SDK RawLines BEFORE cache.ts collectRenderable / reader.ts compact scan / publicNativeHistoryLine; transcriptPort.normalize stays SDK-shaped. Reconcile snapshot preserves sourceOrdinal/tornTail/status.

- [ ] **Step 1: Write failing tests** — neutral historyFromEvents reconstructs identical model history (post-wire-projection equals legacy); compact floor seeds context+text; consecutive tool results merge; unsigned thinking stripped; supplement dedup; sidechain skipped. **UI-history pin**: v3 events → adapter SDK lines → normalize equals legacy normalize output (parsed-line). Reconcile sourceOrdinal/tornTail preserved. Resume/fork/compact e2e green.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** neutral replay + the event→SDK-line projection seam before the three readers.
- [ ] **Step 4: Run** — expect PASS; typecheck green.
- [ ] **Step 5: Commit** `refactor(native): neutral replay + history read-path adapter projection`.

### Task 14: Provider wiring — core + adapter composition

**Files:**
- Modify: `server/providers/native/native-provider.ts` (createSession composes core + wrapNativeCore; remove LegacyNativeSession), `server/providers/default-providers.ts`
- Test: `server/providers/native/native-provider.test.ts`, `e2e.test.ts`, `e2e-persistence.test.ts`

**Interfaces:**
- Consumes: `NativeSession` (NativeSessionCore, Task 10), `wrapNativeCore` (Task 7), `migrateToV3` (Task 12).
- Produces: `NativeProvider.createSession` builds the neutral core + wraps via `wrapNativeCore(core, hostCallbacks)` → ProviderSessionHandle. LegacyNativeSession removed (its projectFileBlocksForProvider/copyConsumedAt now in the adapter). readHistoryPage/Entries/ForReconcile go through the adapter projection. Fidelity vs handle-only path unified through the adapter.

- [ ] **Step 1: Write failing tests** — createSession returns a handle whose messages yield SDK frames identical to legacy; resume/fork migrate eagerly + replay correctly; fidelity + handle-only paths both work; e2e.test.ts + e2e-persistence.test.ts green.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** composition; remove LegacyNativeSession.
- [ ] **Step 4: Run** — expect PASS; typecheck green; native e2e suite green.
- [ ] **Step 5: Commit** `refactor(native): provider composes neutral core + host adapter`.

---

## Phase 4 — subagent / task-manager / tools

### Task 15: Subagent neutral frames + descriptor

**Files:**
- Modify: `server/providers/native/subagent.ts`, `subagent-transcript-source.ts`, `subagent-transcripts.ts`
- Test: `server/providers/native/subagent.test.ts`, `e2e-subagent.test.ts`, `e2e-subagent-transcript.test.ts`

**Interfaces:**
- Consumes: vocabulary `NativeLiveFrame`/`createAssistantMessage`/`createToolResultMessage`/`subagent/descriptor` event, `runTurn` (Task 9), host adapter projection.
- Produces: nested runner emits neutral frames with parentToolUseId; descriptor appended as neutral subagent/descriptor event; subagent transcript reads project neutral→SDK via adapter. `emitResult:false` preserved.

- [ ] **Step 1: Write failing tests** — nested Agent/Task frames carry parent id neutrally; descriptor catalog neutral; subagent transcript SDK projection identical to legacy; e2e-subagent + e2e-subagent-transcript green.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — expect PASS; typecheck green.
- [ ] **Step 5: Commit** `refactor(native): subagent neutral frames + descriptor`.

### Task 16: Task-manager neutral events

**Files:**
- Modify: `server/providers/native/task-manager.ts`
- Test: `server/providers/native/task-manager.test.ts`, `e2e-background.test.ts`

**Interfaces:**
- Consumes: vocabulary operational events (task/started, task/notification), `NativeLiveFrame`, host adapter projection.
- Produces: NativeTaskManager emits neutral task events (constructor `emit: (frame: NativeLiveFrame) => void`); backgrounded settle → neutral task/notification; detach → neutral task/started. Live-only (not persisted; tasksSurviveRestart:false unchanged). Adapter projects to SDK task_started/task_notification.

- [ ] **Step 1: Write failing tests** — task events neutral; adapter projection equals legacy SDK task frames (full field set incl. patch/summary/output_file/run_id); e2e-background green.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — expect PASS; typecheck green.
- [ ] **Step 5: Commit** `refactor(native): task-manager neutral events`.

### Task 17: Tools neutral tool results

**Files:**
- Modify: `server/providers/native/tools/*.ts` (result construction), `tools/types.ts` (ToolDef result type)
- Test: `server/providers/native/tools/*.test.ts`, `e2e-tools.test.ts`, `e2e-read-file.test.ts`

**Interfaces:**
- Consumes: vocabulary `ToolResultMessage`/`createToolResultMessage`/`ContentBlock`/`FileBlock`.
- Produces: tool execution returns neutral tool-result content (text + neutral FileBlock refs); the loop wraps into createToolResultMessage. CanonicalToolResult → neutral. AttachmentRead/PDF results neutral.

- [ ] **Step 1: Write failing tests** — tool results neutral (text + file refs); adapter projection equals legacy SDK tool_result frames; e2e-tools + e2e-read-file + e2e-attachment-fidelity green.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — expect PASS; typecheck green.
- [ ] **Step 5: Commit** `refactor(native): tools emit neutral tool results`.

---

## Phase 5 — Neutrality pin + finalize

### Task 18: Structural neutrality pin + full verify + note → implemented

**Files:**
- Create: `server/providers/native/vocabulary/neutrality.test.ts`
- Modify: `.agents/notes/proposed/architecture/2026-11-18-provider-seam-neutralization.md` (option C → implemented; update status), CLAUDE.md (native vocabulary section)
- Test: full verify

**Interfaces:**
- Consumes: all prior tasks.
- Produces: structural pin scanning native CORE production files (exclude the two adapters + `*.test.ts`): ZERO import of `@anthropic-ai/claude-agent-sdk`, `agent-message.js`, or host-contract frame types; vocabulary module imports only neutral shared/* + node builtins; the two adapters are the sole boundary importers.

- [ ] **Step 1: Write the neutrality pin** — scan `server/providers/native/**` prod files (exclude adapters + tests); assert zero SDK/agent-message/host-contract frame imports; assert vocabulary module imports no host-domain/SDK; assert adapters are the only SDK importers in the native tree.
- [ ] **Step 2: Run pin** — expect PASS (green only after Phases 1-4 complete).
- [ ] **Step 3: Full verify** — `npm run verify` (typecheck ×4, lint, agent-notes, full vitest suite, build) all green; attribute any pre-existing flake (e2e-mcp Windows EBUSY).
- [ ] **Step 4: Update note + CLAUDE.md** — seam-neutralization note option C shipped (move/rewrite per notes README); CLAUDE.md native vocabulary section. `npm run verify:agent-notes` green.
- [ ] **Step 5: Commit** `feat(native): pin host-free neutral core; option C shipped`.
- [ ] **Step 6: Final whole-branch code-review** (most capable model) on the full diff; verify findings; fix confirmed (RED→GREEN); re-review non-trivial fixes. Only then land.

## Open questions deferred (product, not blocking)

- Vocabulary growth governance (DSH lesson: new core block lands with adapter+UI+compaction support) — a process note, not code.
- Whether CanonicalEvent is fully replaced by StreamChunk or kept as a bridged wire IR — builder settles in Task 9 (bridge `canonicalToChunk` keeps anthropic-stream.ts unchanged; full replacement is a later cleanup).
- Native agent-profile pure types relocation home (vocabulary vs shared) — builder settles in Task 5.