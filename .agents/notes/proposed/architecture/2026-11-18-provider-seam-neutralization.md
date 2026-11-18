# Agent Note: Provider seam neutralization and attachment-index relocation

Status: proposed

## Problem

The native provider is a candidate for extraction into its own project (option A
of the extraction evaluation: decouple in-monorepo first). Two structural defects
block a clean provider boundary today:

1. **The provider contract is not provider-neutral.** `server/providers/types.ts`
   — the shared `AgentProvider` / `ProviderSessionHandle` / `CreateSessionOptions`
   contract both providers implement — imports concrete-provider types in two
   places: `InProcessHookForward / InProcessSubagentStop / InProcessTaskSnapshot`
   from `./claude/inprocess-hooks.js` (types.ts:9), and `NativeFileAttachment` from
   `./native/session-log/format.js` (types.ts:12, used by `ProviderAttachmentOccurrence`,
   `ProviderCompactSeed`, `getAttachmentCatalog`). The neutral contract thus depends
   on both concrete providers.

2. **A production import cycle.** `server/attachment-reference-index.ts` (host root)
   imports `loadNativeSessionLog` + log types from `./providers/native/session-log/*`,
   while native (`native-provider.ts`, `native-session.ts`, `tools/attachment-read.ts`)
   imports `NativeAttachmentReferenceIndex` back from the host root. The index is
   native-specific (it parses native JSONL logs and reads the `native-sessions` dir)
   yet lives in the host root, creating the cycle.

## Proposal

Pure structural refactor, no behavior change.

- **Relocate the contract's imported types to neutral modules.**
  - `NativeFileAttachment` (extends `ResolvedFileAttachment` from `agent-message.ts`)
    and `NativeFileBlock` move to a new `server/providers/attachment-types.ts`
    (imports only `../agent-message.js`, already a types.ts dependency).
    `native/session-log/format.ts` re-exports them for compatibility; types.ts
    imports from `./attachment-types.js`.
  - `InProcessHookForward / InProcessSubagentStop / InProcessTaskSnapshot` (simple
    function types over `HookRuntimeEvent` from `shared/hooks.ts`) move to a new
    `server/providers/hook-types.ts` (imports only `../../shared/hooks.js`).
    `claude/inprocess-hooks.ts` re-exports them; types.ts imports from `./hook-types.js`.
  - After this, types.ts has **zero** imports from `./claude/` or `./native/`.
- **Relocate the attachment index into native.** Move
  `server/attachment-reference-index.ts` → `server/providers/native/attachment-reference-index.ts`
  (with `nativeAttachmentOccurrences`). Its `loadNativeSessionLog` / log-type imports
  become native-internal; native consumers import it internally; the host
  (`upload-store.ts`) imports it from native (one direction). The cycle dissolves
  because the index is no longer a host module native reaches back into.
- Re-exports keep the other ~13 `NativeFileAttachment` importers and the claude
  hook-type importers working without churn; only types.ts's import paths change
  for neutrality.

Scope boundary: the native-only optional handle methods (`getAttachmentCatalog`,
`seedCompactSummary`, `compactInPlace`, etc.) stay optional members of the neutral
contract (now neutral-typed). Capability-gating them and removing session-manager's
11 `'native'` special-cases is option A item 4, NOT this change. Full SDK-frame
vocabulary / persistence independence is option C, NOT this change.

## Alternatives considered

- **Break the cycle by dependency injection (inject `loadNativeSessionLog` into a
  host-root index).** Rejected: the index is inherently native's (it parses native
  log events and reads the native-sessions dir). Relocation aligns ownership
  (single writer, clear boundary) and removes the cycle naturally; DI would keep a
  native-specific module misplaced in the host root and add plumbing for no gain.
- **Rewrite all ~13 `NativeFileAttachment` importers to the neutral module.**
  Rejected as churn: only types.ts (the neutral contract) must stop reaching into
  native; native/host files may import native freely. A re-export from format.ts
  achieves neutrality with minimal change.
- **Capability-gate the native-only handle methods now.** Deferred to A item 4:
  it requires touching session-manager dispatch, a separate bounded step. Optional
  neutral-typed members are already provider-neutral for this change's purpose.

## Acceptance criteria

1. `server/providers/types.ts` imports nothing from `./claude/` or `./native/`
   (structural pin).
2. The new neutral modules (`attachment-types.ts`, `hook-types.ts`) import no
   concrete-provider module (structural pin).
3. No production import cycle between the attachment index and native (cycle check).
4. Behavior unchanged: `npm run verify` green (typecheck ×4, lint, agent-notes,
   full vitest suite, build).

## Risks

- **Type identity drift**: moving `NativeFileAttachment` could break a nominal-type
  assumption somewhere; typecheck ×4 + the full suite catch it. Re-exports preserve
  the public import paths.
- **New runtime cycle from relocation**: `upload-store → native/attachment-reference-index
  → native/session-log/format → host modules` must not loop back to upload-store;
  the cycle check verifies. native-session's `UploadStore` import is type-only
  (erased at runtime).
- **Neutral module accidentally re-coupling**: `attachment-types.ts` must import
  only `agent-message` (not native); `hook-types.ts` only `shared/hooks` (not claude).
  Structural pins guard this.
