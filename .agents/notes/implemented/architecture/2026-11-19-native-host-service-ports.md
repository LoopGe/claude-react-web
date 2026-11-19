# Agent Note: Native provider host-service ports

Status: implemented

## Problem

After the [provider seam neutralization](../../proposed/architecture/2026-11-18-provider-seam-neutralization.md),
the native provider's contract imports no concrete provider, but its
IMPLEMENTATION still reaches into host-domain service modules and reads the
`config` singleton directly. That blocks extracting native into its own
project: native pulls host state (config, anthropic-api, mcp-config, attachment
stores, skills, history-reader) instead of receiving those capabilities through
injected boundaries.

Some capabilities are already injected (`UploadStore`, `AgentDefinitionStore`,
`authFor`, `NativeModelContextResolver`, `canUseTool`, `WebFetchDeps`), and the
turn stream is native-owned (`streamAnthropicMessages`). The remaining direct
host-domain imports come under the same injection discipline: native depends
on native-defined port interfaces that the host implements.

## Decision

Pure structural decoupling, behavior-preserving, **full host-free**: native
production code has ZERO host-domain value import; the real adapters live
host-side; ports are required injection; the native test suite injects ports.
Three mechanisms, applied per dependency:

1. **Stateful host services → injected ports.** Native defines the port
   interface (neutral); the host injects an implementation. The real adapters
   live in a HOST adapter module wired by `default-providers.ts`; native has no
   host-wrapping default. Standalone native tests inject test ports. Live config
   reads use getter-backed views so call-time closures and config reload keep
   working.
2. **Pure stateless functions/constants → neutral shared modules.** Relocated so
   native and host both import them; no port plumbing needed for a pure function.
3. **Host policy stays host-side.** Profile resolution, fallback-profile
   construction, and credential handling live in the host port implementation,
   not in native.

Generic infrastructure (`log`, `metrics`, `errors.HttpError`, `pushable`,
`win32-job`, `shell-encoding`, `safe-dns`) stays a shared import — it is not
host-domain coupling.

### ConfigPort

The `config` singleton is a live mutable binding read at construction, create,
per-turn, and inside call-time closures. The port is a getter-backed live view
plus resolved-profile methods; raw credential fields never cross into native.

```ts
// native-defined (neutral)
interface NativeConfigPort {
  readonly nativeAttachmentFidelity: boolean
  readonly nativePdfDocuments: boolean
  readonly nativeAutoCompactRatio: number
  readonly modelList: readonly string[]
  readonly hasProfiles: boolean
  activeProfile(): ProviderProfile
  fallbackProfile(): ProviderProfile
}
```

- The host adapter implements the getters reading the CURRENT `config` binding
  (so reload is observed) and owns `activeProfile()` (= `resolveActiveProfile(config.profiles,
  config.activeProfileId, DEFAULT_PROFILE)`) and `fallbackProfile()` (built from
  `config.authToken/baseUrl/modelList/modelGroups/recapModel/commitMessageModel`),
  including the per-config `WeakMap` cache. `hasProfiles` = `config.profiles.length > 0`.
- `resolveActiveProfile` + `DEFAULT_PROFILE` stay host-side (inside the adapter);
  they do NOT move to shared. Only the `ProviderProfile` / `ModelGroupConfig`
  TYPES live in a neutral module (`shared/profile.ts`) so native can type the
  port result; `server/config.ts` re-exports them for host importers.
- **The two profile-choice branches stay in native, distinct**: the provider
  keeps `opts.profile ?? (port.hasProfiles ? port.activeProfile() :
  port.fallbackProfile())`; the session keeps its own policy
  `opts.profile ?? port.activeProfile()` (no legacy-fallback branch). The
  `hasProfiles` getter lets native reproduce the provider branch through the
  port without folding the choice into the adapter (which would silently change
  the session's empty-profiles resolution).
- Native reads `this.ports.config.X`; call-time closures (e.g.
  `pdfDocumentsEnabled`) capture the port. `fallbackProfile()` construction
  lives in the adapter, mirroring the former native behavior exactly.

### AuxLlmPort

`callAnthropicMessages` serves only AUXILIARY LLM calls (session titles via
`NativeSession.generateTitle`, web-fetch extraction) — the turn stream is
native-owned. Native always passes a `target` (credentials).

```ts
interface NativeAuxLlmPort {
  call(req: {
    model: string; system: string; userContent?: string | unknown[]
    maxTokens: number; temperature: number; signal?: AbortSignal
    messages?: Array<{ role: string; content: string | unknown[] }>
    caller?: string; target: { model?: string; baseUrl: string; authToken: string }
  }): Promise<string>
}
```

The host adapter wraps `callAnthropicMessages`. The request type is
native-defined (the host `CallOptions` is not exported). Injected via provider
ports; threaded to `NativeSession.generateTitle` and `WebFetchDeps` (`auxLlm`).

### McpTransportPort

```ts
interface NativeMcpTransportPort {
  createTransport(target: McpTransportTarget, opts?: { authProvider?: OAuthClientProvider; preferAuthProvider?: boolean }): Transport
  isAuthError(err: unknown): boolean
}
```

The host wraps `createMcpTransport` / `isMcpAuthError`. The `McpTransportTarget`
type lives in a neutral module (`shared/mcp-transport.ts`); `Transport` /
`OAuthClientProvider` are SDK types native already uses. Injected via
`NativeMcpConnectionsOptions` + `SharedRecordOptions` (`transportPort`); OAuth
`authFor` stays separately injected.

### AttachmentPort

`UploadStore` is injected end-to-end. The port covers the remaining direct
reads: `AttachmentObjectStore.readVerified` and `resolveAuthorizedAttachment`.

```ts
interface NativeAttachmentPort {
  readVerified(input: { path: string; digest: string; size: number; signal?: AbortSignal }): AsyncIterable<Uint8Array>
  resolveAuthorized(occurrence: ResolvedFileAttachment): Promise<ResolvedFileAttachment>
}
```

- The host adapter owns an `AttachmentObjectStore(stateDir)` and implements
  `resolveAuthorized` via `resolveAuthorizedAttachment(occurrence, { uploadStore, stateDir })`
  (the host has the uploadStore).
- The `AttachmentStoreError` class + its error codes live in a neutral module
  (`shared/attachment-store-error.ts`) so native's `instanceof` checks resolve
  against the same class the host throws; `server/attachment-object-store.ts`
  re-exports them for host importers.
- `VerifyFileInput` is neutral. `ResolvedFileAttachment` (a file-ref type, NOT
  the SDK frame alias) lives in `shared/attachment-types.ts`. The SDK FRAME
  alias (`AgentMessage = SDKMessage`) stays host-shaped — frame-vocabulary
  neutrality is deferred.

### SkillPort

```ts
interface NativeSkillPort {
  listSkills(cwd?: string): Promise<{ roots: SkillRootInfo[]; skills: SkillRecord[] }>
}
```

The host wraps `listSkills`. `parseSkillFrontmatter` (pure) + `MAX_SKILL_BYTES`
(constant) + `ParsedSkillFrontmatter` / `SkillRootInfo` types live in
`shared/skills.ts` (`SkillRecord` already lives there). Injected into
`NativeSkillCatalog`; `skill-render.ts` uses the neutral `parseSkillFrontmatter`.

### TranscriptPort

```ts
interface NativeTranscriptPort {
  normalize(line: RawLine, sessionId: string, trim: boolean): unknown
  paginateRenderable(renderable: RawLine[], sessionId: string, opts: { before?: number; beforeUuid?: string; limit: number }): HistoryPage
  normalizeSubagentLine(line: RawLine, sessionId: string): unknown | undefined
}
```

- The host wraps `history-reader.normalize` / `paginateRenderable` and
  `subagent-transcripts.normalizeSubagentLine`.
- `RawLine` / `HistoryPage` / `HistoryEntry` / `HistoryReadResult` types (SDK-free
  structural types) + `isSafeSessionId` / `isRenderableSdkMessage` (pure
  predicates; `isRenderableSdkMessage` carries `BROADCAST_SYSTEM_SUBTYPES` +
  `isInterruptPlaceholder` along) + `DEFAULT_DIR_NAME` (constant) live in a
  neutral module (`shared/transcript-format.ts`).
- SCOPE BOUNDARY: the port decouples native from the host history-reader
  MODULE (location decoupling). The SDK message SHAPE consumed via these
  helpers is NOT neutralized here — frame vocabulary is a separate effort.

### Pure functions / constants → neutral (no port)

- The effort-capability ladders (`effortLevelsForModel` / `supportsFastModeForModel`
  / `supportsThinkingForModel`, pure stateless) live in `shared/model-capability.ts`.
- `isQuestionResult` (pure symbol check) + the `QUESTION_RESULT` symbol live in
  `shared/question-result.ts` (the host broker stamps it; native checks it).
- `agentUnusableReason` (pure; its host-class parameter narrowed structurally)
  + the `AGENT_FIELDS` constant live in `shared/agent-definitions.ts` — native
  calls them over the already-injected agentStore.

### Injection architecture (full host-free)

- The port interfaces live in a neutral native module
  (`server/providers/native/ports.ts`), importing only shared types and SDK
  types.
- The REAL adapters live HOST-side (`server/providers/native-host-adapters.ts`),
  importing the host service modules and implementing the native port
  interfaces. `default-providers.ts` constructs them via `createNativeHostPorts`
  and injects them through `NativeProvider` opts.
- `ports: NativeHostPorts` is REQUIRED on `NativeProvider` opts and on
  `NativeSessionOptions` (grouping `config`, `auxLlm`, `mcpTransport`,
  `attachment`, `skill`, `transcript`). The provider threads ports into
  `LoopDeps` / tool factories / `NativeMcpConnections` / `NativeSkillCatalog`,
  replacing each direct host import at its call site.
- **Native production code has ZERO host-domain value import.** A structural
  pin (`server/providers/native/host-free.test.ts`) scans native prod imports,
  resolves specifiers to absolute repo paths (so native-internal `./skills.js`
  and neutral `shared/skills.js` never false-positive against host
  `server/skills.ts`), and bans VALUE imports of the host service modules:
  `config`, `anthropic-api`, `mcp-config`, `profiles`, `effort-capability`,
  `attachment-object-store`, `attachment-access`, `skills`, `permission-broker`,
  `history-reader`, `history-utils`, `subagent-transcripts`,
  `agent-definition-store`. Type-only imports of those modules are tolerated
  (the `AgentDefinitionStore` / `StoredAgentDefinition` injected-store types);
  the pin also asserts `ports.ts` and the neutral shared modules import NO
  host-domain module, value or type.
- The native test suite injects ports: standalone tests inject test ports or
  the host adapters; e2e suites (real disk skills, verified attachment reads)
  inject the real host adapters. Mocking targets the injected port, not host
  modules; config-driven tests inject a ConfigPort backed by the test config.

## Alternatives considered

- **ConfigPort raw view + neutral resolution helpers.** Rejected in favor of
  the resolved-profile interface: native gets a smaller higher-level interface,
  profile-resolution policy stays host-side, fewer neutral relocations are
  needed, raw credential fields stay out of native, and the per-config fallback
  cache moves to its correct host owner. The `hasProfiles` getter preserves the
  provider's distinct empty-profiles branch. Cost: the host adapter must mirror
  fallback-profile construction + caching exactly.
- **Adapter-boundary module (native-side host-wrapping defaults, pin excludes it)
  vs full host-free.** The adapter-boundary option keeps existing tests working
  with near-zero churn but leaves a native module importing host services.
  Rejected in favor of FULL HOST-FREE: adapters host-side, ports required,
  native prod zero host-domain import, test suite migrated. Cleanest extraction
  boundary; larger scope (test migration accepted).
- **One aggregate god-port vs grouped domain ports.** Chosen: grouped domain
  ports collected in a `NativeHostPorts` aggregate — cohesive interfaces,
  per-port testing.
- **Port everything including pure functions.** Rejected: pure stateless
  functions/constants relocate to shared; ports are for stateful host services.
- **Snapshot config at injection.** Rejected: config is a live binding read in
  call-time closures and reloads at runtime; getter-backed views preserve
  call-time semantics.

## Consequences

- Native production is host-free at the value-import level, pinned
  structurally; the extraction boundary no longer leaks host state into
  native. Config reload + call-time closure semantics and both profile-choice
  branches are preserved by the getter-backed live view.
- The cost is breadth: every `NativeProvider` construction injects ports
  (typecheck enforces the required field), and the test suite's mocking
  strategy moved from host modules to injected ports.
- The host adapter must mirror fallback-profile construction + per-config
  caching + active-profile resolution exactly; ConfigPort behavior tests pin
  resolved profiles (including the empty-profiles case), cache identity, and
  reload behavior.
- `AttachmentStoreError` has a single neutral definition, so native's
  `instanceof` checks resolve against the class the host throws.
- The pin checks module LOCATION, not shape: native still consumes SDK-shaped
  messages through the transcript helpers. Frame-vocabulary neutrality
  (`AgentMessage = SDKMessage`, `copyConsumedAt` / `projectFileBlocksForProvider`)
  and session-manager's `'native'` special-cases remain separate, deferred
  efforts; the type-only `agent-definition-store` imports are their adjacent
  residuals, documented as tolerated in the pin.
- Verification: the host-free pin + the provider-seam neutrality pin
  (`server/providers/seam-neutrality.test.ts`), the ConfigPort behavior tests,
  and the full `npm run verify` gate (typecheck ×4, lint, agent-notes, vitest
  suite, build).
