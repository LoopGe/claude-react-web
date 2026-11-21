# Agent Note: Provider seam neutralization and attachment-index relocation

Status: implemented

## Problem

The native provider is a candidate for extraction into its own project
(decouple in-monorepo first). Three structural defects block a clean provider
boundary:

1. **The provider contract is not provider-neutral.** `server/providers/types.ts`
   — the shared `AgentProvider` / `ProviderSessionHandle` / `CreateSessionOptions`
   contract both providers implement — imports concrete-provider types: the
   in-process hook / subagent / task types from `./claude/inprocess-hooks.js`,
   and `NativeFileAttachment` from `./native/session-log/format.js`. The neutral
   contract depends on both concrete providers.
2. **A production import cycle.** The attachment reference index (host root)
   imports the native session-log loader and log types, while native imports the
   index back from the host root. The index is native-specific — it parses native
   JSONL logs and reads the `native-sessions` dir — yet lives in the host root.
3. **The frame vocabulary itself is host-shaped.** Native's runtime frame type is
   `Frame = AgentMessage & Record<string, any>` where `AgentMessage = SDKMessage`;
   every native frame constructor builds an SDK-shaped object and casts it
   `as AgentMessage`, and the input side (`AgentUserMessage`, `copyConsumedAt`,
   `projectFileBlocksForProvider`) is SDK-shaped too. Even with host services
   injected, native still speaks the SDK's message types — the last structural
   dependency on the host, and the one that blocks lifting native out.

## Decision

Pure structural refactor, behavior-preserving. The host stays SDK-shaped; only
native's core is neutralized. It ships in bounded steps (A1–A4) followed by the
full frame-vocabulary redesign (option C).

### Neutral contract + index relocation (A1–A3)

The contract's imported types live in neutral modules: `NativeFileAttachment` /
`NativeFileBlock` in `server/providers/attachment-types.ts`, and
`InProcessHookForward / InProcessSubagentStop / InProcessTaskSnapshot` in
`server/providers/hook-types.ts`. `native/session-log/format.ts` and
`claude/inprocess-hooks.ts` re-export them so the other importers keep their
paths. `types.ts` imports nothing from `./claude/` or `./native/`.

The attachment index lives in native:
`server/providers/native/attachment-reference-index.ts` (with
`nativeAttachmentOccurrences`). Its log imports are native-internal; the host
(`upload-store.ts`) imports it from native — one direction, so the cycle is gone.

### Capability flags (A4)

session-manager carries no provider-name special-cases. Provider-specific
manager behavior reads capability flags on `ProviderCapabilities`
(`supportsSandbox`, `tasksSurviveRestart`, `interleavedSubagentHistory`,
`hostDrivenAutoCompact`, `persistentAttachmentRefs`, `cliSidePlanSteering`,
`ownsCliTranscriptJsonl`), all through one `capsOf(provider)` helper. A structural
pin (`seam-neutrality.test.ts`) asserts session-manager contains zero
`===`/`!==` comparisons against `'native'` or `'claude'`.

### Neutral frame vocabulary + two adapters (option C)

Native owns a DSH-inspired neutral vocabulary and speaks it end-to-end; the two
adapters alone translate at the boundaries. The design spec
(`docs/superpowers/specs/2026-11-21-native-frame-vocabulary-design.md`) carries
the full model and the R1–R7 resolutions; the shipped structure is:

- **`server/providers/native/vocabulary/`** — the neutral frame language and the
  lift-out unit: `Message` / `ContentBlock` / `StreamChunk` + provenance, the
  durable `SessionEventMap` (the v3 log language), the live `AssistantFrame` /
  `OperationalFrame` union, constructors + the shared `BlockAssembler`, branded
  ids, and the relocated identity facts (`FrameContext` / `defaultFrameContext` /
  `Usage`). It imports ONLY neutral `shared/*` refs, Node builtins and sibling
  vocabulary — zero SDK or host-domain imports.
- **The core** (`loop.ts`, `native-session.ts`, `subagent.ts`, `task-manager.ts`,
  `tools/`, `session-log/`, replay) speaks only the vocabulary: the neutral turn
  engine, neutral v3 log append/flush/migrate, neutral model-history replay, and
  neutral emission. The core WRITE path appends neutral v3 events directly; the
  writer's legacy-input migration serves reading/migrating legacy logs and the
  writer's own v1/v2 compat contract, never core writes.
- **Host adapter** (SDK allowed) — `server/providers/native-host-frame-adapter.ts`
  (`wrapNativeCore` implements the SDK-shaped `ProviderSessionHandle`; neutral
  frames/events ↔ `AgentMessage`; host-input identity, lease callbacks,
  `copyConsumedAt` / `projectFileBlocksForProvider`), with adapter-side siblings
  `native-frames.ts` (legacy SDK frame builders kept for tests),
  `native-subagent-transcript-source.ts` (the host transcript source), and
  `native-provider.ts` (the composition root implementing `AgentProvider`, wiring
  the neutral core into `wrapNativeCore`).
- **Wire adapter** (API projection) — `native/wire/wire-projection.ts` +
  `native/attachment-projection.ts` project neutral model history → the Anthropic
  API request (tool_result grouping, raw-JSON tool arguments, signed-thinking
  filter, file/PDF projection).
- **Persistence v3** — native logs store neutral `SessionEvent`s; v1/v2 logs
  migrate losslessly eager-at-open (uuid / seq / thinking-signature /
  attachment-blockPath preserving; temp+fsync+rename). The host history read path
  projects neutral events → SDK `RawLine`s through the adapter seam
  (`projectNativeEventToSdkLine`) before the renderable filter; `log.events`
  remains the legacy read view for read-side consumers (attachment index, PDF
  budgets, usage restore).

The SDK package stays a dependency of the host / claude / adapter, never of
native core.

## Alternatives considered

- **Break the cycle by dependency injection (inject the log loader into a
  host-root index).** Rejected: the index is inherently native's (it parses native
  log events and reads the native-sessions dir). Relocation aligns ownership
  (single writer, clear boundary) and removes the cycle naturally; DI would keep a
  native-specific module misplaced in the host root and add plumbing for no gain.
- **Rewrite all ~13 `NativeFileAttachment` importers to the neutral module.**
  Rejected as churn: only `types.ts` (the neutral contract) must stop reaching into
  native; native/host files may import native freely. A re-export from `format.ts`
  achieves neutrality with minimal change.
- **Full option A — neutralize the host consumer contract too.** Rejected: the
  host's ~12 SDK-typed consumer modules stay SDK-shaped. Neutralizing the whole
  `ProviderSessionHandle` contract is a much larger blast radius; the chosen
  structure B keeps the contract host-owned and puts a translating adapter at the
  native↔host boundary instead.
- **A faithful structural mirror of `SDKMessage` under a new name.** Rejected as
  an anti-goal: re-exporting the SDK union is no real decoupling — native would
  still structurally depend on SDK shapes via the alias. The vocabulary is
  genuinely redesigned (DSH full model, native-tailored), and the adapter does real
  translation.
- **A separate process / package or wire protocol for native.** Rejected: the goal
  is a clean in-monorepo module that can be lifted out, not a runtime split. No
  communication protocol is introduced.

## Consequences

The native core is host-free and lift-out-ready: it imports no SDK / host-contract
frame vocabulary and no host-domain service, and the two adapters are the sole
boundary importers. The cost is that adapter completeness is load-bearing — a
missed SDK field a host consumer reads is silent transcript corruption — and that
vocabulary growth is now coordinated: a new native block lands with adapter
projection + UI rendering + compaction support together, rather than a cast.

What pins the behavior:

- `native/vocabulary/neutrality.test.ts` — the structural neutrality pin: core
  production files import no SDK / `agent-message` / host frame vocabulary (value
  AND type-only), the vocabulary imports only neutral `shared/*` + Node builtins +
  siblings, the adapters are the sole boundary importers, and every core
  `log.append` / `appendDurable` object literal carries the neutral `data:`
  envelope.
- `native/host-free.test.ts` — the host-domain service ban (the six-port
  discipline; see the [host-service ports](2026-11-19-native-host-service-ports.md)
  note).
- The adapter reconstruction suite and the migration parsed-line round-trip pin
  (`projectNeutralEventToLegacy(migrateEventToV3(e)) === e` on real corpora) guard
  losslessness; the full `npm run verify` gate guards behavior preservation.

Known trade-offs kept: large image-heavy v1/v2 logs pay migration latency at open
(correctness-first, R7); the legacy read view (`log.events`) remains for read-side
consumers; and the writer still accepts legacy inputs for its v1/v2 compat contract
even though the core write path is neutral-only.