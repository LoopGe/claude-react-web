# Agent Note: Native provider host-service ports (option A item ③)

Status: proposed

## Problem

After the seam neutralization (A items 1+2, shipped), the native provider's
contract no longer imports concrete providers, but its IMPLEMENTATION still
directly imports ~15 host-domain service modules and reads the `config`
singleton. This blocks extracting native into its own project: native reaches
into host state (config, anthropic-api, mcp-config, attachment stores, skills,
history-reader) rather than receiving those capabilities through injected
boundaries.

Some capabilities are already injected (`UploadStore`, `AgentDefinitionStore`,
`authFor`, `NativeModelContextResolver`, `canUseTool`, `WebFetchDeps`); the turn
stream is native-owned (`streamAnthropicMessages`). Item ③ brings the REMAINING
direct host-domain imports under the same injection discipline, so native
depends on native-defined port interfaces that the host implements.

## Proposal

Pure structural decoupling, behavior-preserving. **Full host-free** (user
decision): native production code has ZERO host-domain value import; the real
adapters live host-side; ports are required injection; the existing native test
suite migrates to port injection. Three mechanisms, applied per dependency:

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
   not in native (decision B for ConfigPort, user-approved).

Generic infrastructure (`log`, `metrics`, `errors.HttpError`, `pushable`,
`win32-job`, `shell-encoding`, `safe-dns`) stays a shared import — it is not
host-domain coupling.

### ConfigPort (decision B)

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

- Host adapter implements the getters reading the CURRENT `config` binding (so
  reload is observed) and owns `activeProfile()` (= `resolveActiveProfile(config.profiles,
  config.activeProfileId, DEFAULT_PROFILE)`) and `fallbackProfile()` (built from
  `config.authToken/baseUrl/modelList/modelGroups/recapModel/commitMessageModel`),
  including the per-config `WeakMap` cache currently in `native-provider.ts:196-212`.
  `hasProfiles` = `config.profiles.length > 0`.
- `resolveActiveProfile` + `DEFAULT_PROFILE` stay host-side (inside the adapter);
  they do NOT move to shared. Only the `ProviderProfile` / `ModelGroupConfig`
  TYPES relocate to a neutral module (`shared/profile.ts`) so native can type the
  port result.
- **The two profile-choice branches stay in native, distinct** (builder-check Q2):
  `native-provider.ts:261` keeps `opts.profile ?? (port.hasProfiles ?
  port.activeProfile() : port.fallbackProfile())`; `native-session.ts:428` keeps
  its own policy `opts.profile ?? port.activeProfile()` (no legacy-fallback
  branch). The `hasProfiles` getter lets native reproduce the provider branch
  through the port without folding the choice into the adapter (which would
  silently change the session's empty-profiles resolution).
- Native reads `this.configPort.X` instead of `config.X`; call-time closures
  (e.g. `pdfDocumentsEnabled`) capture the port. `fallbackProfile()` construction
  leaves native (absorbed by the adapter, behavior mirrored exactly).

### AuxLlmPort

`callAnthropicMessages` is used only for AUXILIARY LLM calls (`generateTitle`
`native-session.ts:1798`, `web-fetch` `tools/web-fetch.ts:87`) — the turn stream is
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

Host adapter wraps `callAnthropicMessages`. The request type is native-defined
(the host `CallOptions` is not exported). Injected via provider ports; threaded to
`NativeSession.generateTitle` and `WebFetchDeps` (gains `auxLlm`).

### McpTransportPort

```ts
interface NativeMcpTransportPort {
  createTransport(target: McpTransportTarget, opts?: { authProvider?: OAuthClientProvider; preferAuthProvider?: boolean }): Transport
  isAuthError(err: unknown): boolean
}
```

Host wraps `createMcpTransport` / `isMcpAuthError`. `McpTransportTarget` type
relocates to a neutral module (`shared/mcp-transport.ts`); `Transport` /
`OAuthClientProvider` are SDK types native already uses. Injected via
`NativeMcpConnectionsOptions` + `SharedRecordOptions` (`transportPort`); OAuth
`authFor` stays already-injected.

### AttachmentPort

`UploadStore` is already injected end-to-end. The remaining direct imports are
`AttachmentObjectStore.readVerified`, `resolveAuthorizedAttachment`, and
`AttachmentStoreError` (native does `instanceof` checks).

```ts
interface NativeAttachmentPort {
  readVerified(input: { path: string; digest: string; size: number; signal?: AbortSignal }): AsyncIterable<Uint8Array>
  resolveAuthorized(occurrence: ResolvedFileAttachment): Promise<ResolvedFileAttachment>
}
```

- Host adapter owns an `AttachmentObjectStore(stateDir)` and implements
  `resolveAuthorized` via `resolveAuthorizedAttachment(occurrence, { uploadStore, stateDir })`
  (host has the uploadStore).
- `AttachmentStoreError` class + its error codes relocate to a neutral module
  (`shared/attachment-store-error.ts`) so native's `instanceof` checks resolve
  against the same class the host throws.
- `VerifyFileInput` type neutral. `ResolvedFileAttachment` (a file-ref type, NOT
  the SDK frame alias) relocates to neutral in ③ because the ports need it;
  `attachment-types.ts` already depends on it. The SDK FRAME alias
  (`AgentMessage = SDKMessage`) stays for ⑤.

### SkillPort

```ts
interface NativeSkillPort {
  listSkills(cwd?: string): Promise<{ roots: SkillRootInfo[]; skills: SkillRecord[] }>
}
```

Host wraps `listSkills`. `parseSkillFrontmatter` (pure) + `MAX_SKILL_BYTES`
(constant) + `ParsedSkillFrontmatter` / `SkillRootInfo` types relocate to
`shared/skills.ts` (extends the existing neutral skills module; `SkillRecord`
already lives there). Injected into `NativeSkillCatalog`; `skill-render.ts` uses
the neutral `parseSkillFrontmatter`.

### TranscriptPort

Native imports history-reader / history-utils / subagent-transcripts helpers.
Inject a port for the format-transform calls; relocate the types + pure
predicates to a neutral transcript-format module.

```ts
interface NativeTranscriptPort {
  normalize(line: RawLine, sessionId: string, trim: boolean): unknown
  paginateRenderable(renderable: RawLine[], sessionId: string, opts: { before?: number; beforeUuid?: string; limit: number }): HistoryPage
  normalizeSubagentLine(line: RawLine, sessionId: string): unknown | undefined
}
```

- Host wraps `history-reader.normalize` / `paginateRenderable` and
  `subagent-transcripts.normalizeSubagentLine`.
- `RawLine` / `HistoryPage` / `HistoryEntry` / `HistoryReadResult` types (SDK-free
  structural types, builder-verified) + `isSafeSessionId` / `isRenderableSdkMessage`
  (pure predicates; `isRenderableSdkMessage` carries `BROADCAST_SYSTEM_SUBTYPES` +
  `isInterruptPlaceholder` along) + `DEFAULT_DIR_NAME` (constant, lives in
  `json-file-store.ts`) relocate to a neutral module (`shared/transcript-format.ts`).
- SCOPE BOUNDARY (my call): ③ removes native's import of the host history-reader
  MODULE (location decoupling). The SDK message SHAPE consumed via these helpers
  is NOT neutralized here — that is ⑤ (frame vocabulary).

### Pure functions / constants → neutral (no port)

- `effort-capability.ts` ladders (`effortLevelsForModel` / `supportsFastModeForModel`
  / `supportsThinkingForModel`, pure stateless) → `shared/model-capability.ts`.
- `permission-broker.isQuestionResult` (pure symbol check) + the `QUESTION_RESULT`
  symbol → `shared/question-result.ts` (host broker stamps it; native checks it).
- `agent-definition-store.agentUnusableReason` (pure; its host-class parameter
  narrowed structurally) + `AGENT_FIELDS` constant → neutral
  (`shared/agent-definitions.ts`, extends existing) — native calls them over the
  already-injected agentStore.

### Injection architecture (full host-free)

- Native defines the port interfaces in a neutral native module
  (`server/providers/native/ports.ts`), importing only neutral types.
- The REAL adapters live HOST-side (`server/providers/native-host-adapters.ts`),
  importing the host service modules and implementing the native port interfaces.
  `default-providers.ts` constructs them and injects via `NativeProvider` opts.
- `NativeProvider` opts gains `ports: NativeHostPorts` (REQUIRED for real use;
  grouping `config`, `auxLlm`, `mcpTransport`, `attachment`, `skill`, `transcript`).
  The provider threads ports into `NativeSessionOptions` → `LoopDeps` / tool
  factories / `NativeMcpConnections` / `NativeSkillCatalog`, replacing each direct
  host import at its call site.
- **Native production code has ZERO host-domain value import.** A structural pin
  scans native prod imports and bans the host-domain service modules.
- **Test migration is in scope** (user decision): the ~150 `new NativeProvider({…})`
  constructions and ~30 test files that relied on host-wrapping defaults migrate
  to inject the host adapters (or test ports). `vi.mock('../../skills.js')` /
  `('../../anthropic-api.js')` strategies change to mocking the injected port;
  `__setConfigForTest`-driven tests inject a ConfigPort backed by the test config.
  The e2e suites (real disk skills / verified attachment reads) inject the real
  host adapters.

### Non-goals

- Frame vocabulary neutrality (`AgentMessage = SDKMessage`, `copyConsumedAt` /
  `projectFileBlocksForProvider`) → item ⑤.
- session-manager's 11 `'native'` special-cases → item ④.
- Generic infra relocation (log/metrics/utils) — stays shared.

## Alternatives considered

- **ConfigPort decision A (raw view + neutral resolution helpers).** Rejected in
  favor of B (user-approved): B gives native a smaller higher-level interface
  (resolved profiles), keeps profile-resolution policy host-side, needs fewer
  neutral relocations, keeps raw credential fields out of native, and moves the
  per-config fallback cache to its correct host owner. The `hasProfiles` getter
  preserves the provider's distinct empty-profiles branch (Q2). Cost: the host
  adapter must mirror fallback-profile construction + caching exactly.
- **Adapter-boundary module (native-side host-wrapping defaults, pin excludes it)
  vs full host-free.** The adapter-boundary option keeps existing tests working
  with near-zero churn but leaves a native module importing host services.
  Rejected in favor of FULL HOST-FREE (user decision): adapters host-side, ports
  required, native prod zero host-domain import, test suite migrates. Cleanest
  extraction boundary; larger ③ scope (test migration accepted).
- **One aggregate god-port vs grouped domain ports.** Chosen: grouped domain ports
  collected in a `NativeHostPorts` aggregate — cohesive interfaces, per-port
  testing.
- **Port everything including pure functions.** Rejected: pure stateless
  functions/constants relocate to shared; ports are for stateful host services.
- **Snapshot config at injection.** Rejected: config is a live binding read in
  call-time closures and reloads at runtime; getter-backed views preserve call-time
  semantics.

## Acceptance criteria

1. Native production code imports no host-domain service module directly:
   `config`, `anthropic-api`, `mcp-config`, `profiles`, `effort-capability`,
   `attachment-object-store`, `attachment-access`, `skills`, `permission-broker`,
   `history-reader`, `history-utils`, `subagent-transcripts`, `agent-definition-store`
   (value imports). A structural pin scans native prod imports.
2. The relocated pure functions/constants/types live in neutral modules importing
   no host-domain module; the host adapters live host-side.
3. Behavior unchanged: `npm run verify` green (typecheck ×4, lint, agent-notes,
   full vitest suite, build); config reload + call-time closure semantics +
   both profile-choice branches preserved.
4. The native test suite is migrated to port injection (host adapters or test
   ports); standalone native tests inject test ports; e2e suites inject real host
   adapters; all green.

## Risks

- **ConfigPort behavior drift**: the host adapter must mirror fallback-profile
  construction + per-config caching + active-profile resolution exactly, and the
  `hasProfiles` branch must reproduce `native-provider.ts:261` while
  `native-session.ts:428` keeps its distinct policy. Pinned by tests asserting
  resolved profiles (incl. empty-profiles case) + reload behavior.
- **Live-view semantics**: getters must read the current config binding (not a
  captured snapshot) so runtime reload and call-time closures behave as before.
- **AttachmentStoreError identity**: relocating the error class must keep native's
  `instanceof` checks resolving against the class the host throws (single neutral
  definition, re-export from the old host path for host importers).
- **TranscriptPort shape vs location**: relocating RawLine/HistoryPage to neutral
  does NOT decouple the SDK shape (⑤); the pin checks module-location, not shape.
- **Test migration breadth**: ~30 test files change injection + mocking strategy;
  a missed migration breaks `verify` (criterion 3). The migration is the largest
  part of ③'s scope; phased task-by-task with the suite green at each step.
