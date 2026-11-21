# Native Frame Vocabulary Redesign — Design

Status: draft (brainstorming output; pending builder-check + owner approval)
Date: 2026-11-21
Spec lineage: `.agents/notes/proposed/architecture/2026-11-18-provider-seam-neutralization.md` (option C),
`.agents/notes/implemented/architecture/2026-11-19-native-host-service-ports.md` (option A item ③, host-free ports — shipped).

## Intent and the why

The native provider builds agent frames in-process, but its runtime frame type is
`Frame = AgentMessage & Record<string, any>` where `AgentMessage = SDKMessage`
(`server/agent-message.ts:6`) — a type alias that imports the Anthropic Agent SDK's
message union. Every native frame constructor (`server/providers/native/frames.ts`)
builds an SDK-shaped object and casts it `as AgentMessage`. The input side
(`AgentUserMessage`, `copyConsumedAt`, `projectFileBlocksForProvider`) is SDK-shaped too.

Seam-neutralization A1–A4 and the host-free six-port refactor (item ③) are shipped:
native production code no longer imports host-domain *services*. The last structural
dependency on the host is the **frame vocabulary itself** — native speaks the SDK's
message types. This blocks lifting native out as its own project.

**Goal (owner-confirmed):** native becomes a clean monorepo module that does not depend
on host-shaped frame types and can be lifted out. NOT a separate process/package, no
communication protocol. The host stays SDK-shaped; only native's core is neutralized.

**Chosen approach (owner-confirmed):**
- **Structure B** — a neutral native core + a host-side translating adapter. The shared
  provider contract (`ProviderSessionHandle`, `AgentMessage`) stays SDK-shaped and
  host-owned; the host's ~12 SDK-typed consumer modules are untouched.
- **Genuinely redesigned vocabulary, close to DSH's full model** — not a faithful
  structural mirror of `SDKMessage`. Native owns a DSH-inspired message/content/stream
  vocabulary; the adapter does real translation native↔SDK.
- **Persistence evolves** — native's log is already a native-owned, versioned event
  format (v1/v2); the redesign lands v3 + migration, leveraging the existing versioning
  infrastructure. No clean break.

## Prior art: DSH (deepseek-harness)

DSH owns a provider-neutral vocabulary package `@deepseek-ai/dsh-llm` (zero provider SDK
imports) that is the single frame language end-to-end — core loop, session log,
persistence, GUI, both out-of-process SDKs. Adapters alone translate provider wire
messages into neutral `StreamChunk`s; the core never imports an adapter. The only
`@anthropic-ai/claude-agent-sdk` import in DSH is a leaf plugin that consumes the SDK
stream privately and maps only the terminal result to neutral text — direct precedent
for our native/SDK split.

We borrow DSH's **model** (below) but apply it **locally to native**: DSH's host is
neutral-native (built that way); ours stays SDK-shaped, so the translation adapter sits
at the native↔host boundary instead of neutralizing the whole contract. DSH's lessons we
adopt: map only what consumers actually use (leave the rest adapter-private); an opaque
`unknown` escape hatch for provider-only fidelity; written adapter obligations; raw-JSON
tool arguments end-to-end; structured failure codes at the boundary; vocabulary growth is
gated (a new core block lands with adapter + UI + compaction support together).

## Goals

1. A neutral native vocabulary module with **zero** `@anthropic-ai/claude-agent-sdk`
   imports and zero host-domain imports — DSH full model, tailored to native.
2. Native core (loop, frames, session-log, subagent, task-manager, tools, replay) speaks
   only the neutral vocabulary; no `as AgentMessage` casts, no `AgentMessage`/
   `AgentUserMessage`/`SDKMessage` type imports in core production code.
3. A host-side adapter translates neutral native frames → SDK-shaped `AgentMessage` for
   the host, and SDK-shaped `AgentUserMessage` input → neutral native input. The host
   consumer contract is reconstructed **losslessly** for every field consumers read.
4. Persistence v3 stores the neutral vocabulary; v1/v2 logs migrate losslessly (uuids,
   seq chain, thinking signatures, compact text+context, skill bodies, attachment
   catalogs/blockPaths, usage, agent base snapshot, parent_tool_use_id null-vs-string).
5. A structural neutrality pin asserts native core production code imports no SDK /
   host-contract frame types.
6. Behavior-preserving: the host/client see identical SDK-shaped frames; full
   `npm run verify` green; existing native sessions resume/fork/replay unchanged.

## Non-goals

- Neutralizing the host consumer modules or the shared `ProviderSessionHandle` contract
  (that is full option A; explicitly out — host stays SDK-shaped).
- Neutralizing the **claude** provider (it is the SDK-facing provider; it keeps importing
  the SDK).
- A separate process/package or wire protocol for native.
- Redesigning the client's `SdkMessage` rendering types (client stays SDK-shaped).
- Image GC / retention (separate deferred product decision).

## Anti-goals (failure even if it "works")

- A "neutral" vocabulary that is just `SDKMessage` re-exported under a new name (no real
  decoupling — native still structurally depends on SDK shapes via the alias).
- An adapter that drops or alters any SDK field a host consumer reads (silent transcript
  corruption, wrong task state, broken compact/replay).
- A v3 migration that loses uuid identities, thinking signatures, or attachment
  blockPaths (breaks resume/fork/compact-hydration/attachment-deletion leases).
- Vocabulary growth that requires touching host consumers to add a native block (the
  boundary must absorb new native vocabulary without host churn).

## Constraints

- Behavior-preserving at every phase; typecheck ×4 + affected tests green per task; full
  `npm run verify` green at the end.
- Diagnostics via `createLogger`; never bare `console.*`. Git via `runGit`. CSS theme vars.
- TDD adaptation for a refactor: each task's gate is typecheck + affected tests; behavior
  pins where a semantic could drift (adapter reconstruction, migration round-trip,
  neutrality pin).
- The SDK package stays a dependency of the **host/claude/adapter**, never of native core.
- Conventional commits + `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

## Builder-check resolutions (2026-11-21, authoritative refinements)

A fresh builder reviewer verified the draft against real code and surfaced seven gaps.
All are settled here as architect calls (drawing on existing project decisions); they
refine the sketches below where they conflict. The owner checks these calls while reading.

**R1 — the core/adapter cut (the pump splits).** The CORE owns the neutral turn engine:
turn execution (`runTurn`/loop), neutral v3 log append/flush/migrate, model-history replay,
PDF budget reservations, neutral emission, and the durable-retry pause (a neutral
persistence-append failure state). The ADAPTER owns the host-contract translation surface:
`AgentUserMessage` → neutral `RequestMessage` input projection (file→handle text via
`projectFileBlocksForProvider`, `copyConsumedAt`), the `receivedAt` identity re-keyed from
the host `AgentUserMessage` WeakMap onto the neutral uuid, the host lease callbacks
(`onUserMessageConsumed`/`onUserMessagePersistence` wrap the core's neutral persistence
outcomes), and the ~50-method `ProviderSessionHandle` surface — control methods typed in
host-contract types (`compactInPlace`, `getAttachmentOccurrences`, `drainQueuedInput` →
`AgentUserMessage[]`, steering, `getSkillCompactionEntries`) translate between host-contract
and neutral core methods. `pumpLoop` therefore splits: its turn-execution + persistence +
emission body is core (neutral); the host-identity bookkeeping around it is adapter. The
boundary is real, not nominal: the core has zero host-contract imports; the adapter owns
translation, NOT core persistence.

**R2 — `stream_event` fidelity via opaque raw passthrough.** The closed `StreamChunk`
union serves the assembler/model turn. Native ALSO forwards raw Anthropic protocol events
to the client (`stream_event`; the client reads `content_block_start.content_block.name`,
`content_block_delta.delta.text`, `message_delta.usage.output_tokens`, `message_stop`).
The neutral live vocabulary therefore has a second frame kind: `RawStreamEvent { event:
unknown }` — an opaque passthrough (DSH `ReplayEnvelope` precedent). The adapter projects a
neutral live frame to the SDK `stream_event` frame carrying `event` verbatim, so the client
sees byte-identical raw fields. The neutrality pin guarantees no SDK **type** imports in
core; opaque `unknown` blobs are permitted. `stream_event` raw passthrough joins the
phase-2 reconstruction pin (byte-identical event).

**R3 — two boundary adapters, not one.** Native is itself a provider that calls the
Anthropic API directly. So native has TWO adapters around the neutral core:
- **wire adapter** (`native/wire/`): neutral model history → Anthropic API request shape
  (tool_result grouping into user messages, parsed `tool_use.input` from raw-JSON
  arguments, signed-thinking filter, file/PDF projection). Imports the Anthropic API
  request types (its boundary). This is where `historyFromEvents`'s API-shaped output and
  `projectNativeMessages` move: replay produces NEUTRAL model history; the wire adapter
  projects it to the request. The round-trip pin's "identical model history" compares
  post-wire-projection API messages.
- **host adapter** (`native-host-adapters.ts` / sibling): neutral frames/events → SDK
  `AgentMessage` for host consumers; SDK input → neutral. Imports the SDK types.
The neutral core imports NEITHER boundary's types. The neutrality pin covers core only.

**R4 — phases 3+4 merge (atomic live+persistence migration).** Migrating the live loop to
neutral while the log stays v1/v2 SDK-shaped would require throwaway bidirectional
scaffolding at the core↔log seam (neutral→legacy-event writes AND SDK→neutral replay).
To keep "each phase independently green" honest, the live loop + persistence + replay
migrate together in one phase. No throwaway scaffolding.

**R5 — `ImageBlock` is a mixed model.** The vocabulary's image block is `ImageRefBlock |
LegacyImageBlock` (the latter already defined in `shared/image-attachment.ts`). This is
the shipped image-references decision ("legacy base64 accepted forever"). v1/v2 logs
persist inline base64 user content verbatim; migration preserves it as `LegacyImageBlock`
— NO migration-time offload to the store (no host-service side effect inside a neutral
migration). The round-trip pin passes on image-bearing logs.

**R6 — contract scoped to native's actual emissions; durable/live split preserved.** The
reconstruction contract enumerates only what NATIVE emits, not the full claude subtype
surface. Native's live system frames are ~6: `init`, `api_retry`, `informational`,
`task_started`, `task_notification`, `result` (+ `stream_event`). The ~25-subtype list in
the draft was over-inclusive (claude-only frames like `hook_*`, `plugin_install`,
`memory_recall`, `elicitation_complete`, `notification`, `thinking_tokens`,
`prompt_suggestion` are NOT native emissions and need no native projection). v3 persists
the neutral counterparts of TODAY's 11-event durable union; live-only frames stay live-only
(not newly persisted) — `tasksSurviveRestart: false` behavior unchanged. The durable
`SessionEventMap` and the live-frame union are distinct; operational live frames are not
durable events.

**R7 — migration eager-at-open; pin is parsed-line equality.** A v3 writer cannot append
neutral events to an unmigrated v1/v2 log, so resume/fork migrates v1/v2→v3 at open,
before the first append. The durable-retry pause covers pre-append migration failures.
Migration is idempotent and reuses the byte-preserving machinery's safety (temp+fsync+
rename, re-parse, cache invalidation) but rewrites every event (not header-only). The
round-trip pin means PARSED-LINE equality (legacy SDK lines the host saw == adapter
projection of migrated v3), not byte equality. Large image-heavy logs pay migration
latency at open; correctness-first.

## The vocabulary model (DSH full model, native-tailored)

A new neutral module — proposed `server/providers/native/vocabulary/` (lift-out unit;
imports only neutral `shared/*` types + node builtins). Mirrors DSH's `dsh-llm` shapes.
Merge-extensible maps are TypeScript `interface`s (declaration merging); derived unions
are `Map[keyof Map]`. Closed unions are type aliases consumers `switch` + `assertNever`.

### Messages (`message.ts`)

```ts
interface MessageBase {
  readonly id: MessageId                 // branded string
  readonly content: readonly ContentBlock[]
  readonly source: MessageSource
}
interface SystemMessage    extends MessageBase { role: 'system';    source: MessageSourceMap['system-prompt'] }
interface DeveloperMessage extends MessageBase { role: 'developer' }
interface UserMessage      extends MessageBase { role: 'user' }
interface AssistantMessage extends MessageBase { role: 'assistant'; source: ModelMessageSource }
interface ToolResultMessage extends MessageBase {
  role: 'tool'; source: ToolMessageSource
  toolCallId: ToolCallId; isError?: boolean
}
interface MessageRoleMap { system: SystemMessage; developer: DeveloperMessage; user: UserMessage; assistant: AssistantMessage; tool: ToolResultMessage }
type Message = MessageRoleMap[keyof MessageRoleMap]
```

Tool results are **first-class role-`tool` messages**, not content blocks (DSH). Request
input: `RequestUserInput { role:'user'; content; id?: never; source?: never }`;
`RequestMessage = Message | RequestUserInput`. Branded ids (`MessageId`, `ToolCallId`)
via a neutral brand helper.

### Content blocks (`types.ts`)

```ts
interface TextBlock        { type: 'text'; text: string }
interface ReasoningBlock   { type: 'reasoning'; text: string; signature?: string; redacted?: true; data?: string }
interface ImageRefBlock    { type: 'image'; attachment: ImageAttachmentRef; offloaded?: true }
interface LegacyImageBlock { type: 'image'; source: { type: 'base64'; data: string; media_type: string } }
type ImageBlock = ImageRefBlock | LegacyImageBlock   // mixed model (see resolution R5)
interface FileBlock        { type: 'file'; attachment: FileAttachmentRef }
interface ToolCallBlock    { type: 'tool-call'; id: ToolCallId; name: string; arguments: string /* RAW JSON */ }
interface ToolAdditionBlock{ type: 'tool-addition'; toolName: string }
interface ToolRemovalBlock { type: 'tool-removal'; toolName: string }
interface ContentBlockMap { 'text': TextBlock; 'reasoning': ReasoningBlock; 'image': ImageBlock; 'file': FileBlock; 'tool-call': ToolCallBlock; 'tool-addition': ToolAdditionBlock; 'tool-removal': ToolRemovalBlock }
type ContentBlock = ContentBlockMap[keyof ContentBlockMap]
```

`ImageAttachmentRef`/`FileAttachmentRef` reuse the neutral `shared/image-attachment.ts` /
`shared/attachment-types.ts` refs already shipped (content-addressed). `ReasoningBlock`
carries DSH's reasoning plus the **thinking signature / redacted data** native must
preserve for API replay (`isRetainedThinkingBlock` semantics move here). Tool-call
arguments stay raw JSON strings end-to-end.

### Live stream (`types.ts`) — closed union

```ts
type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: ToolCallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason; replayState?: ReplayEnvelope }
```

`FinishReasonMap` (merge-extensible): `stop | tool-calls | max-tokens | aborted{failure} |
error{failure}`. `TokenUsage` disjoint counts (`inputTokens` uncached only;
`cacheReadTokens`/`cacheWriteTokens`/`reasoningTokens` separate). `LlmFailure { message;
code; status?; providerRetryAfterMs?; requestId? }` — structured codes defined at the
native API boundary (`CONTEXT_WINDOW_EXCEEDED`, `EMPTY_RESPONSE`, `AUTH`, `RATE_LIMIT`,
`TIMEOUT`, `TRANSPORT`, …).

### Provenance (`message.ts`)

```ts
interface ModelMessageSource { kind: 'model'; provider: string; model: string; replayState?: unknown }
interface ToolMessageSource  { kind: 'tool'; callId: ToolCallId }
interface SystemPromptMessageSource { kind: 'system-prompt' }
interface MessageSourceMap { user: { kind:'user' }; model: ModelMessageSource; tool: ToolMessageSource; 'system-prompt': SystemPromptMessageSource }
type MessageSource = MessageSourceMap[keyof MessageSourceMap]
```

`ContextForm` axis (closed): `instructions | catalog | snapshot | notice | relay | recall`,
mixed into source via a discriminated `ContextFormed` (a form cannot be chosen without its
required fields, e.g. `snapshot` carries `sections`, `notice` carries `summary`). Native
producers declare their own source kinds via declaration merging (subagent continuation,
compact summary, skill injection, supplement) — no catch-all kind.

`ReplayEnvelope { response: unknown; blocks?: readonly unknown[] }` — opaque to core,
adapter-owned, stored on `AssistantMessage.source.replayState`; per-block entries align
1:1 with emitted blocks; length mismatch discards the envelope; passed only to the same
adapter instance that owns both historical and target provider.

### Constructors + assembler

`createMessage` / `createAssistantMessage` / `createToolResultMessage` / `createUserMessage`
/ `createDeveloperMessage` / `createSystemMessage` — `deepFreeze(structuredClone(...))`,
branded id minting. One shared `BlockAssembler` folds `StreamChunk`s → blocks → message
(`push`, `assembled`, `blocks`, `interruptedBlocks`, `message(source)`); settlement rule:
`finish.kind === 'max-tokens'` drops tool-call blocks and prunes `replay.blocks` at the
same positions. The live loop and log replay share the assembler so they cannot diverge.

### Durable events (`session-event.ts`) — the native log vocabulary

`SessionEventMap` (merge-extensible interface), `SessionEvent<T> = { type; seq; time;
data: SessionEventMap[T]; ignorable? }`. Model-turn events embed `Message`:

```ts
'user/message':      UserMessage
'assistant/message': { message: AssistantMessage; stream: AssistantStreamRecord[]; usage?: TokenUsage; interrupted?: true }
'tool/result':       { message: ToolResultMessage; error?: { name; code; reason? }; meta?: JsonValue }
'developer/message': { message: DeveloperMessage }
'system/message':    { message: SystemMessage }
'turn/start' | 'turn/end': { turn; reason? }
'step/start' | 'step/end': { turn; step }
'request/header' | 'request/context'
'session/end-seed':  { inherited?: true }
```

**Native-specific operational events** (the host's rich system/result surface — see
"Adapter reconstruction contract") are typed native events in the same map, NOT SDK
shapes: `task/started`, `task/notification`, `task/progress`, `api/retry`, `informational`,
`permission/denied`, `model/refusal-fallback`, `compact/boundary`, `session/attachments`,
`session/agent`, `subagent/descriptor`, `session/skill`, `session/supplement`,
`session/context`, `result`, `init`. Each carries its facts in neutral field names; the
adapter projects each to the exact SDK system/result subtype the host reads. `result`
carries usage/modelUsage/iterations/timing/fast_mode_state as neutral facts.

`SESSION_FORMAT_VERSION` bumps to 3 (native log). `AssistantStreamRecord` packs timed
chunk runs (DSH shape) for compacted replay.

## Architecture: core / adapter / host boundary

```
native/vocabulary/        (neutral: Message/ContentBlock/StreamChunk/SessionEvent + constructors + assembler; zero SDK/host imports)
  ← native core           (neutral turn engine: loop, session-log v3, replay, subagent, task-manager, tools, PDF budgets; speaks vocabulary only)
  ← native/wire adapter   (neutral model history → Anthropic API request; imports API request types)        [R3]
  ← native host adapter   (implements ProviderSessionHandle; neutral frames/events ↔ SDK; owns input identity, lease callbacks, copyConsumedAt/projectFileBlocksForProvider; imports SDK types)  [R1/R3]
  ← host                  (session-manager, pump, history-reader, recap, …; SDK-shaped, UNCHANGED)
```

The core/adapter cut and the two-adapter structure are authoritative in R1/R3 above. The
core owns the neutral turn engine + persistence; the host adapter owns the host-contract
translation surface (input identity, lease callbacks, the ~50-method handle); the wire
adapter owns the neutral→Anthropic-API request projection. The core imports neither
boundary's types.

- The **adapter** is the host-facing surface currently in `native-provider.ts` /
  `native-session.ts` (the `LegacyNativeSession` wrapper + `messages`/`enqueueUserMessage`).
  It becomes the explicit translation seam: it implements the SDK-shaped
  `ProviderSessionHandle`, wraps a neutral `NativeSessionCore`, and owns the SDK import +
  `copyConsumedAt`/`projectFileBlocksForProvider`. Proposed home: extend
  `server/providers/native-host-adapters.ts` (already host-side, already wraps the six
  ports) with a `createNativeSessionHandle(core): ProviderSessionHandle`, or a sibling
  `native-frame-adapter.ts`. The neutral core exposes a neutral interface
  (`NativeSessionCore`: neutral `messages: AsyncIterable<NativeFrame>`, neutral input
  enqueue, neutral history reads).
- **Two translation points live, two read paths:**
  - Live out: core emits neutral frames/events → adapter projects to SDK `AgentMessage`
    before `output.push` to the host.
  - Live in: host `AgentUserMessage` → adapter projects to neutral `RequestMessage`
    (file blocks → neutral `FileBlock` ref; the handle-text projection
    `projectFileBlocksForProvider` stays adapter-side) → core enqueue.
  - History out: neutral v3 log events → adapter projects to SDK `RawLine`s **before**
    `cache.ts collectRenderable` / `reader.ts` compact scan / `replay.ts` (the critical
    seam the recon identified: those three readers currently treat persisted events
    directly as SDK RawLines). Model-history replay (`historyFromEvents`) consumes neutral
    events natively (core), no SDK.
  - The `transcriptPort.normalize/paginateRenderable` (host history-reader) stays
    SDK-shaped; the adapter feeds it SDK lines projected from neutral events.

### Adapter reconstruction contract (lossless)

The adapter MUST reconstruct every SDK field host consumers read (recon §4). Key groups:
- Envelope on every frame: `type`, `uuid`, `session_id`, `parent_tool_use_id`
  (null-vs-string authoritative), `receivedAt`/`consumedAt`/`restoredFromDisk` stamps.
- assistant: `message.{id,model,content,stop_reason,usage}`; content `tool_use`
  `{id,name,input}` (input = parsed JSON from raw-JSON arguments); thinking blocks with
  signature/redacted data; `usage.{input_tokens,output_tokens,cache_creation_input_tokens,cache_read_input_tokens}`.
- user tool_result: `content[].{tool_use_id,content,is_error}`; `tool_use_result.backgroundTaskId`;
  launch-ack `agentId:` text; `isSynthetic/isCompactSummary/isMeta`.
- system subtypes (each a typed native event → exact SDK subtype): `init`,
  `compact_boundary`, `commands_changed`, `notification`, `thinking_tokens`,
  `session_state_changed`, `status`, `files_persisted`,
  `task_started/updated/progress/notification` (full field set incl.
  `patch`, `summary`, `last_tool_name`, `output_file`, `run_id`, `resource_links`),
  `background_tasks_changed`, `model_refusal_fallback` (`retracted_message_uuids`),
  `model_refusal_no_fallback`, `hook_started/progress/response`, `permission_denied`,
  `informational`, `plugin_install`, `local_command_output`, `memory_recall`,
  `elicitation_complete`, `prompt_suggestion`, `api_retry`, `error`.
- result: `subtype`, `is_error`, `num_turns`, `result`, `terminal_reason`, `usage`
  (`iterations[]`, `type:'message'`), `modelUsage`, `result_index`, `local_command`,
  `fast_mode_state`, `total_cost_usd`, `duration_ms`, timing fields.
- Broadcast/ring gates (`BROADCAST_SYSTEM_SUBTYPES`, `type !== 'stream_event'`) are
  host-side and unchanged; the adapter's projected subtypes must match the allowlist.

**Fidelity rule:** neutral vocabulary carries the facts; SDK-only representation details
the core must not type live in the opaque `ReplayEnvelope` / event `meta: JsonValue`. The
adapter is the only place that knows SDK field names.

## Persistence v3 + migration

- v3 stores neutral `SessionEvent`s (the vocabulary above). Header `v: 3`.
- Migration v1/v2 → v3 is **lossless and uuid/seq-preserving**: project each legacy
  `user`/`assistant` SDK-shaped event into neutral `user/message`/`assistant/message`
  (content blocks → neutral blocks; thinking signature/redacted preserved; tool_use →
  tool-call with raw-JSON arguments; tool_result user frame → first-class
  `tool/result`); native-owned events (compact/skill/supplement/descriptor/attachments/
  agent/context/turn-end) map to their neutral counterparts verbatim. The contiguous seq
  chain, `parent_tool_use_id` null-vs-string, `isCompactSummary`, compact `text`+`context`,
  skill `body`, attachment catalog + occurrence blockPaths, `turn/end.usage`, assistant
  usage/model, `session/agent` base snapshot all survive.
- Reuse the existing byte-preserving migration machinery (`migrateToV2` pattern:
  temp+fsync+rename, re-parse, cache invalidation, post-gate buffered append). Migration
  is idempotent; forks preserve source version until migrated; fresh seeds default v3.
- A v3 log reads back through the adapter's event→SDK-line projection so the host history
  path is unchanged; model-history replay consumes neutral events directly.
- **Round-trip pin:** for a corpus of real v1/v2 logs, migrate→v3→adapter-project→SDK
  lines must equal the legacy SDK lines the host saw pre-migration (byte-stable modulo
  ordering), and neutral replay must reconstruct identical model history.

## Phasing (each phase keeps the app working via the adapters; R4 merges live+persistence)

1. **Vocabulary module** — neutral types + constructors + assembler + branded ids + mixed
   `ImageBlock` + `RawStreamEvent` passthrough kind, zero SDK/host imports; unit tests
   mirror DSH semantics (assembler settlement, max-tokens drop, freeze, raw-JSON args). No
   core change yet.
2. **Adapters skeleton + reconstruction contract** — host adapter (neutral frames/events →
   SDK shapes; SDK input → neutral) AND wire adapter (neutral history → API request); a
   comprehensive reconstruction test suite pinning every field NATIVE emits and host
   consumers read (R6-scoped contract, incl. `stream_event` raw passthrough byte-identity).
   Core still emits SDK-shaped frames internally; adapters exercised via a temporary
   neutral projection. Establishes the lossless contract before core migration.
3. **Core migration: live loop + persistence + replay (atomic, R4)** — loop/frames emit
   neutral frames/events; session-log writes neutral v3; replay/model-history consume
   neutral; wire adapter projects neutral history → API request; v1/v2→v3 eager-at-open
   migration (R7) + parsed-line round-trip pin; host history read path goes through the
   host adapter projection; `stream_event` raw passthrough preserved. Live + resume/fork/
   compact green together (no throwaway bidirectional scaffolding).
4. **Core migration: subagent / task-manager / tools** — sidechain frames, task events,
   tool results speak neutral; descriptor catalog neutral. Subagent transcript + background
   task e2e green.
5. **Neutrality pin + finalize** — structural pin: native CORE production code imports no
   SDK / host-contract / API-request frame types (the two adapters are the sole boundary
   importers); full `npm run verify` green; update the owning agent note → implemented.

## What's left to the builder

- Exact module/file layout under `native/vocabulary/` and the adapter home (extend
  `native-host-adapters.ts` vs sibling module) — settle by following existing conventions.
- The precise neutral field names for operational events and the per-event SDK projection
  tables (derive from the reconstruction contract; pin with tests).
- Brand helper location (reuse a neutral `shared/brand.ts` or native-local).
- Migration corpus selection + the round-trip test harness mechanics.
- Whether `ReasoningBlock` models redacted thinking as a flag vs a separate block (DSH has
  only `reasoning`; native needs redacted_data — builder settles, pin the API-replay
  semantics).
- AssistantStreamRecord packing granularity for native's compacted replay.

## Risks

- **Adapter completeness is the load-bearing risk.** The host contract is broad (~20
  system subtypes + rich result fields). A missed field is silent transcript corruption.
  Mitigation: the reconstruction contract is enumerated from real consumer code (recon §4)
  and pinned field-by-field in phase 2 BEFORE core migration; the round-trip pin catches
  drift.
- **Migration fidelity.** uuid/seq/thinking-signature/blockPath loss breaks
  resume/fork/compact/leases. Mitigation: lossless round-trip pin on real logs; reuse the
  proven byte-preserving migration machinery.
- **Vocabulary evolution cost (DSH's lesson).** A neutral contract shifts cost from casts
  to coordinated vocabulary growth: a new native block must land with adapter projection +
  UI rendering + compaction support together. Mitigation: gate vocabulary growth; the
  adapter absorbs new vocabulary without host churn (anti-goal guard).
- **Scope.** This is a multi-phase refactor of native's core. Mitigation: each phase is
  behavior-preserving and independently green; the adapter keeps the host working
  throughout; no big-bang.
- **Two-layer settlement drift.** Live loop and replay must share the assembler (DSH
  invariant) or they diverge. Mitigation: one shared `BlockAssembler`, pinned.