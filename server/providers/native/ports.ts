// Native-defined host-service ports: the injection boundary through which the
// native provider receives the host capabilities it does not own (config,
// auxiliary LLM calls, MCP transports, verified attachment reads, skill
// discovery, plugin contributions, transcript normalization, the CLAUDE.md
// memory chain). The interfaces are neutral — only shared/* types and SDK types
// cross this boundary; the real implementations live HOST-side
// (../native-host-adapters.ts) and are injected via NativeProvider opts.ports.
// Raw credential fields never cross into native: ConfigPort hands over
// resolved profiles, not the config singleton.

import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { ProviderProfile } from '../../../shared/profile.js'
import type { McpTransportTarget } from '../../../shared/mcp-transport.js'
import type { ResolvedFileAttachment } from '../../../shared/attachment-types.js'
import type { SkillRecord, SkillRootInfo } from '../../../shared/skills.js'
import type { StoredAgentDefinition } from '../../../shared/agent-definitions.js'
import type { SessionHooksConfig } from '../../../shared/hooks.js'
import type { HistoryPage, RawLine } from '../../../shared/transcript-format.js'
import type { NativeSessionEvent } from './vocabulary/session-event.js'

/** Getter-backed LIVE view of the host config plus resolved-profile methods.
 *  Getters read the CURRENT config binding, so runtime reload and call-time
 *  closures observe fresh values. Profile resolution policy (active selection
 *  and legacy fallback construction) stays host-side inside the adapter. */
export interface NativeConfigPort {
  readonly nativeAttachmentFidelity: boolean
  readonly nativePdfDocuments: boolean
  readonly nativeAutoCompactRatio: number
  /** Fallback context window for routes with no override and no successful
   *  discovery — see ConfigFile.nativeDefaultContextWindow. */
  readonly nativeDefaultContextWindow: number
  readonly modelList: readonly string[]
  readonly hasProfiles: boolean
  /** Small-fast model for the prompt/agent hook evaluators (the CLI's
   *  ANTHROPIC_SMALL_FAST_MODEL override path). EMPTY = unset — the hook
   *  model resolver applies its own default. */
  readonly smallFastModel: string
  activeProfile(): ProviderProfile
  fallbackProfile(): ProviderProfile
}

/** Auxiliary LLM round-trips only (session titles, web-fetch extraction) —
 *  the turn stream is native-owned. Native always passes a `target`
 *  (the session's resolved credentials). */
export interface NativeAuxLlmPort {
  call(req: {
    model: string
    system: string
    userContent?: string | unknown[]
    maxTokens: number
    temperature: number
    signal?: AbortSignal
    messages?: Array<{ role: string; content: string | unknown[] }>
    caller?: string
    target: { model?: string; baseUrl: string; authToken: string }
  }): Promise<string>
}

/** MCP client transport construction + auth-failure classification. OAuth
 *  `authFor` stays separately injected; the caller resolves the per-server
 *  provider and passes it as `opts.authProvider`. */
export interface NativeMcpTransportPort {
  createTransport(target: McpTransportTarget, opts?: { authProvider?: OAuthClientProvider; preferAuthProvider?: boolean }): Transport
  isAuthError(err: unknown): boolean
}

/** Verified attachment byte reads + registry authorization. The host adapter
 *  owns the object store and the upload registry; native never touches either
 *  directly. Errors surface as the neutral AttachmentStoreError. */
export interface NativeAttachmentPort {
  readVerified(input: { path: string; digest: string; size: number; signal?: AbortSignal }): AsyncIterable<Uint8Array>
  resolveAuthorized(occurrence: ResolvedFileAttachment): Promise<ResolvedFileAttachment>
}

/** Skill discovery over the host's user/project skill roots, plus the
 *  read-only plugin roots when the host adapter has a marketplace store.
 *  `enabledPlugins` is the per-session plugin subset (compound
 *  `<plugin>@<marketplace>` keys); `undefined` = all enabled, `[]` = none.
 *  Plugin discovery stays host-side — the port only forwards the subset. */
export interface NativeSkillPort {
  listSkills(cwd?: string, enabledPlugins?: string[]): Promise<{ roots: SkillRootInfo[]; skills: SkillRecord[] }>
}

/** One plugin slash command. `name` is the BARE command name — the plugin's
 *  subdirectory namespace plus the sanitized file basename (`frontend:component`),
 *  or the manifest object-map key. The `plugin:` qualification happens at
 *  integration, exactly like plugin skills. `body` is the prompt template (file
 *  body or manifest inline content, frontmatter already parsed out). */
export interface PluginCommand {
  name: string
  description: string
  argumentHint: string
  body: string
}

/** A contained per-plugin failure. `kind` names what refused: the contribution
 *  type ('manifest' | 'commands' | 'agents' | 'hooks' | 'mcp'), 'modules'
 *  (executable hook modules — native loads data only), 'traversal' (a manifest
 *  path escaping the plugin dir) or 'scan' (an unexpected per-plugin failure).
 *  `detail` is the human-readable reason, including the offending path. */
export interface PluginContributionError {
  kind: string
  detail: string
}

/** Everything one enabled plugin contributes besides skills (the skill catalog
 *  owns those). `key` is the compound `<plugin>@<marketplace>` Settings key;
 *  `name` is the plugin's own manifest name with the catalog name as fallback.
 *  Command and agent names are path-derived and subdir-namespaced, bare of the
 *  plugin prefix. `hooks` is validated SessionHooksConfig (files deduped by
 *  realpath); `mcpServers` stays opaque server configs — merge precedence
 *  belongs to the consumer, not the loader. */
export interface PluginContributions {
  key: string
  name: string
  dir: string
  commands: PluginCommand[]
  agents: StoredAgentDefinition[]
  hooks: SessionHooksConfig
  mcpServers: Record<string, unknown>
  errors: PluginContributionError[]
}

/** Plugin contribution discovery over the host's marketplace store — the
 *  commands/agents/hooks/MCP parallel to NativeSkillPort. `enabledPlugins` is
 *  the per-session subset (undefined = all enabled, [] = none, else compound
 *  key membership). Discovery, parsing and containment stay host-side
 *  (server/plugin-contributions.ts); the core receives typed data only.
 *  The payload types live here rather than in the loader because this file may
 *  import only shared/** and native/** (host-free pin) — the loader re-exports
 *  them for host consumers. */
export interface NativePluginPort {
  listContributions(enabledPlugins?: string[]): Promise<PluginContributions[]>
}

/** Transcript format transforms: raw-line normalization, renderable paging,
 *  and subagent-line projection. The SDK message SHAPE consumed here is not
 *  neutralized by this port (frame vocabulary is a separate effort). */
export interface NativeTranscriptPort {
  normalize(line: RawLine, sessionId: string, trim: boolean): unknown
  paginateRenderable(renderable: RawLine[], sessionId: string, opts: { before?: number; beforeUuid?: string; limit: number }): HistoryPage
  normalizeSubagentLine(line: RawLine, sessionId: string): unknown | undefined
  /** Project one durable neutral event to the SDK RawLine the CLI transcript
   *  uses (the host history-read seam `projectNativeEventToSdkLine`). Returns
   *  null for non-message events. This is the injected projection port for the
   *  hook transcript artifact (T22): the core materializer owns the JSONL
   *  projection/write, but the neutral→SDK-line translation stays host-side, so
   *  the core never imports the host adapter. Both types crossing here are
   *  neutral (vocabulary event + shared RawLine). */
  projectEventToSdkLine(event: NativeSessionEvent, sessionId: string): RawLine | null
}

/** Host-side CLAUDE.md chain reader. Worktree origin resolution and per-file
 *  caching are host concerns; the core receives text only. `files` is ordered
 *  user first, then project ancestors root→cwd; a worktree chain loads the
 *  worktree's own files first, then the origin repo chain. */
export interface NativeMemoryFile {
  path: string
  scope: 'user' | 'project' | 'local'
  content: string
}

export interface NativeMemoryReadResult {
  files: NativeMemoryFile[]
  isGitRepo: boolean
}

export interface NativeMemoryPort {
  read(cwd: string): Promise<NativeMemoryReadResult>
}

/** The grouped domain ports injected as one unit through NativeProvider opts
 *  and threaded into NativeSessionOptions. */
export interface NativeHostPorts {
  config: NativeConfigPort
  auxLlm: NativeAuxLlmPort
  mcpTransport: NativeMcpTransportPort
  attachment: NativeAttachmentPort
  skill: NativeSkillPort
  /** Absent when the host has no marketplace store (handle-only unit
   *  sessions): plugin contributions are then simply unavailable, exactly as
   *  the skill port stays user/project-only without one. */
  plugin?: NativePluginPort
  transcript: NativeTranscriptPort
  memory: NativeMemoryPort
}
