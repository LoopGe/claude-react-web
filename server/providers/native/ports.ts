// Native-defined host-service ports: the injection boundary through which the
// native provider receives the host capabilities it does not own (config,
// auxiliary LLM calls, MCP transports, verified attachment reads, skill
// discovery, transcript normalization). The interfaces are neutral — only
// shared/* types and SDK types cross this boundary; the real implementations
// live HOST-side (../native-host-adapters.ts) and are injected via
// NativeProvider opts.ports. Raw credential fields never cross into native:
// ConfigPort hands over resolved profiles, not the config singleton.

import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { ProviderProfile } from '../../../shared/profile.js'
import type { McpTransportTarget } from '../../../shared/mcp-transport.js'
import type { ResolvedFileAttachment } from '../../../shared/attachment-types.js'
import type { SkillRecord, SkillRootInfo } from '../../../shared/skills.js'
import type { HistoryPage, RawLine } from '../../../shared/transcript-format.js'

/** Getter-backed LIVE view of the host config plus resolved-profile methods.
 *  Getters read the CURRENT config binding, so runtime reload and call-time
 *  closures observe fresh values. Profile resolution policy (active selection
 *  and legacy fallback construction) stays host-side inside the adapter. */
export interface NativeConfigPort {
  readonly nativeAttachmentFidelity: boolean
  readonly nativePdfDocuments: boolean
  readonly nativeAutoCompactRatio: number
  readonly modelList: readonly string[]
  readonly hasProfiles: boolean
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

/** Transcript format transforms: raw-line normalization, renderable paging,
 *  and subagent-line projection. The SDK message SHAPE consumed here is not
 *  neutralized by this port (frame vocabulary is a separate effort). */
export interface NativeTranscriptPort {
  normalize(line: RawLine, sessionId: string, trim: boolean): unknown
  paginateRenderable(renderable: RawLine[], sessionId: string, opts: { before?: number; beforeUuid?: string; limit: number }): HistoryPage
  normalizeSubagentLine(line: RawLine, sessionId: string): unknown | undefined
}

/** The grouped domain ports injected as one unit through NativeProvider opts
 *  and threaded into NativeSessionOptions. */
export interface NativeHostPorts {
  config: NativeConfigPort
  auxLlm: NativeAuxLlmPort
  mcpTransport: NativeMcpTransportPort
  attachment: NativeAttachmentPort
  skill: NativeSkillPort
  transcript: NativeTranscriptPort
}
