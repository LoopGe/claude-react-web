# Agent Note: Native reasoning-signature provider decoupling

Status: proposed

## Problem

The native core is neutral with respect to the HOST (the SDK seam — see [provider seam neutralization](../../implemented/architecture/2026-11-18-provider-seam-neutralization.md)), but its reasoning vocabulary and streaming IR still carry Anthropic-specific signature semantics. The core is meant to be a lift-out, provider-neutral module; today it is provider-neutral in form yet Anthropic-shaped in its reasoning/auth content. With one provider this is safe and correct; a second model provider whose reasoning has different auth semantics — no cryptographic signature, a different redacted-reasoning shape, or an opaque reasoning summary — would not fit without being forced into Anthropic's `thinking`/`signature` mold.

The coupling sits in three core layers; a fourth is already correctly adapter-side:

- `server/providers/native/canonical.ts` — the "protocol-neutral streaming IR" carries a `{ type: 'signature' }` delta and `thinking` / `redacted_thinking` block starts (Anthropic protocol concepts).
- `server/providers/native/loop.ts` (`CanonicalBridge`) — accumulates the signature delta and settles it at `block_end` into the neutral block; the neutral `StreamChunk` deliberately has no signature delta, so the signature rides the authoritative block-end.
- `server/providers/native/vocabulary/types.ts` — `ReasoningBlock` carries `signature?` / `redacted?` / `data?` fields, and `isRetainedThinkingBlock` encodes Anthropic's signed-thinking replay rule in the core vocabulary.
- `server/providers/native/wire/wire-projection.ts` — projects the block's signature into the Anthropic API `thinking` block and applies the signed-thinking filter. This layer is already adapter-side (correct), but reads the signature from the core block rather than an adapter-private payload.

The opaque-envelope seam that would carry this adapter-privately ALREADY EXISTS and is wired: `vocabulary/source.ts` defines `AssistantProviderMetadata.replayState?: unknown` and `ReplayEnvelope { response; blocks? }` (core stores and forwards it verbatim, never reads inside), and `vocabulary/assembler.ts` maintains the envelope from the terminal `finish` chunk, pruning per-block entries in step with kept blocks and discarding it on length mismatch. The gap is that the Anthropic signature rides the core block/IR instead of this envelope.

This is a forward risk, not a current defect: there is no concrete second provider yet. This note records the target design so the decoupling is plan-ready when a second provider is committed; executing it now would be speculative abstraction for an unproven need (the repository's guard-evidence rule).

## Proposal

Complete the DSH model the vocabulary already mirrors: move the provider reasoning auth out of the core block/IR and into the existing opaque, adapter-owned `ReplayEnvelope`, so the core owns only neutral reasoning text.

Target shape, when a second provider is committed:

- `ReasoningBlock` reduces to `{ type: 'reasoning'; text: string }` (whether a neutral redacted marker stays in the core or also moves into the envelope is settled at planning). `signature` / redacted `data` become an adapter-private envelope payload, opaque to core.
- The canonical streaming IR's reasoning deltas become text-only. The Anthropic adapter absorbs `signature_delta` into its envelope payload instead of emitting a core `signature` delta; the bridge no longer settles a signature at `block_end`.
- The wire adapter re-attaches the signature from the envelope (not the block) when projecting the Anthropic request, and owns the signed-thinking filter (`isRetainedThinkingBlock` moves adapter-side), validation, and graceful degradation to signature-free neutral history when the envelope is unusable. Add the one core gate DSH uses: strip `replayState` whose owning adapter differs from the target provider's adapter.
- v3 logs migrate the existing `ReasoningBlock.signature` / `redacted` / `data` into the envelope losslessly, via the same eager-at-open migration mechanism that already preserves thinking-signature.
- The assembler's envelope maintenance is already in place and stays.

Reference model — DSH (`D:/codes/deepseek-harness`, proven across DeepSeek / Anthropic / Gemini routes): core `ReasoningBlock = { type; text }` with no signature field (`packages/llm/llm/src/types.ts`); signatures ride the opaque `ReplayEnvelope` (`types.ts:467-486`), stamped per-adapter at the terminal `finish` chunk; canonical deltas are text-only (`types.ts:499`); the assembler keeps envelope blocks index-aligned without reading either half (`llm/src/assembler.ts:135-150`); the only core gate strips foreign-adapter `replayState` (`llm/src/index.ts:1041-1052`); re-attachment, prefix-binding and degradation are adapter-side (`llm-pi-ai/src/replay.ts`, `llm-deepseek/src/replay.ts`). DSH's core carries no signature field anywhere — that is what lets one vocabulary serve every route.

Trigger: a concrete commitment to add a second model provider. Until then this note is the design of record; no code changes.

## Alternatives considered

**Adapter-private durable sidecar for signatures (core stores only reasoning text).** Rejected as the target: the signature must survive restart and replay, so a sidecar adds new durable storage plus an occurrence-identity join to re-attach it. The opaque envelope already rides the message source and the v3 log losslessly — moving the signature there reuses existing persistence instead of adding a parallel store. The deeper core neutrality a sidecar buys is nothing the envelope lacks.

**Keep the Anthropic-shaped canonical IR and force-fit a second provider into it (signature optional).** Rejected: it leaves `redacted_thinking` / `signature` vocabulary in the core, so a provider with different reasoning semantics (opaque summary, no signature) is shoehorned into Anthropic's mold — the coupling this note removes. "Signature is already optional" does not make the IR provider-neutral.

**Execute the decoupling now, with no second provider yet.** Rejected for timing: it touches the streaming hot path (canonical IR ↔ bridge ↔ assembler) and requires a v3 log migration for zero current functional gain. The envelope seam already exists, so the future migration is contained and well-defined; the guard-evidence rule says record the design and wait for the proven need rather than build speculative generality.

**Do nothing, leave no record.** Rejected: the coupling is a real architectural inconsistency — a "neutral" core carrying one provider's auth semantics. Recording the precise surface and the DSH-grounded target makes the future refactor a plan-ready task instead of a rediscovery.

## Acceptance criteria

Observable state when the decoupling is executed (not now):

- The core `ReasoningBlock`, canonical IR, and bridge carry no provider signature/auth field and no signed-thinking replay rule; those live adapter-side (the envelope payload and the wire filter). A search for `signature` across the core vocabulary/IR/bridge finds no core field.
- The Anthropic signature rides the opaque `ReplayEnvelope`; the assembler maintains index alignment without reading it; a foreign-adapter `replayState` is stripped before projection.
- The wire adapter re-attaches the signature from the envelope and owns the signed-thinking filter and degradation; Anthropic follow-up replay fidelity is unchanged (signed thinking preserved, unsigned stripped).
- v3 logs migrate `block.signature` / `redacted` / `data` into the envelope losslessly; existing sessions resume with identical model history and replay behavior.
- A second provider adds its reasoning representation by writing its own adapter envelope payload, with no change to the core vocabulary, canonical IR, bridge, or assembler.
- The neutrality pin still passes; the full native suite (streaming, replay, migration, e2e-thinking) is green.

## Risks

- The streaming hot path (canonical IR ↔ bridge ↔ assembler settlement) is subtle; moving the signature out of `block_end` settlement risks a block/envelope alignment regression. The assembler's existing prune/discard semantics must be preserved exactly.
- The v3 migration must preserve the signature losslessly — it is required for Anthropic replay, so a lossy migration silently breaks follow-up requests. The existing thinking-signature-preserving migration is the template and the round-trip pin the guard.
- Deferring leaves the inconsistency in place until a second provider is committed; this is accepted under guard-evidence, and the note is the mitigation that keeps the design plan-ready.
- The envelope payload shape and whether a neutral `redacted` marker stays in the core are left to planning; a wrong choice could re-introduce a provider-shaped core field. The acceptance search is the guard.

## Related

- [Provider seam neutralization](../../implemented/architecture/2026-11-18-provider-seam-neutralization.md) — the host-neutralization (option C) this extends to provider neutrality; it built the neutral vocabulary and the opaque-envelope seam this proposal completes.