// Host-side implementations of the native provider's service ports
// (native/ports.ts). This module lives OUTSIDE native/ on purpose: it is the
// only place that wraps the host service modules (config, anthropic-api,
// mcp-config, attachment stores, skills, history-reader, subagent-transcripts)
// into the neutral port interfaces. default-providers.ts constructs the ports
// and injects them via NativeProvider opts; tests use makeNativePorts().

import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { config, DEFAULT_PROFILE, type ServerConfig } from '../config.js'
import { resolveActiveProfile } from '../profiles.js'
import type { ProviderProfile } from '../../shared/profile.js'
import { callAnthropicMessages } from '../anthropic-api.js'
import { createMcpTransport, isMcpAuthError } from '../mcp-config.js'
import { AttachmentObjectStore } from '../attachment-object-store.js'
import { resolveAuthorizedAttachment } from '../attachment-access.js'
import { listSkills } from '../skills.js'
import { normalize, paginateRenderable } from '../history-reader.js'
import { normalizeSubagentLine } from '../subagent-transcripts.js'
import type { UploadStore } from '../upload-store.js'
import { resolveNativeStateDir } from './native/session-log/paths.js'
import type { NativeConfigPort, NativeHostPorts } from './native/ports.js'

export interface NativeHostPortsDeps {
  /** App state dir; resolved exactly like NativeProvider's own stateDir so
   *  the attachment object store roots at the same directory. */
  stateDir?: string
  /** The process-wide upload registry. Required only by the attachment
   *  port's resolveAuthorized; handle-only sessions never call it. */
  uploadStore?: UploadStore
  /** Accepted for wiring symmetry with the provider opts. No port consumes
   *  it: OAuth authFor stays directly injected into NativeMcpConnections,
   *  which resolves the per-server provider and passes it to
   *  createTransport as opts.authProvider. */
  authFor?: (name: string) => OAuthClientProvider | undefined
}

/** Build the real host adapters for one NativeProvider. The ConfigPort is a
 *  getter-backed LIVE view (reload-safe), and its fallback-profile cache is
 *  per-ports-object — the same granularity as the provider's per-instance
 *  WeakMap it mirrors. */
export function createNativeHostPorts(deps: NativeHostPortsDeps = {}): NativeHostPorts {
  const stateDir = resolveNativeStateDir(deps.stateDir)
  const objects = new AttachmentObjectStore(stateDir)
  // Mirrors native-provider.ts's per-config fallback cache: one snapshot per
  // config generation (the frozen binding is replaced on reload), so requests
  // and discovery share one route within a generation.
  const fallbackProfiles = new WeakMap<ServerConfig, ProviderProfile>()
  const configPort: NativeConfigPort = {
    get nativeAttachmentFidelity() { return config.nativeAttachmentFidelity },
    get nativePdfDocuments() { return config.nativePdfDocuments },
    get nativeAutoCompactRatio() { return config.nativeAutoCompactRatio },
    get modelList() { return config.modelList },
    get hasProfiles() { return config.profiles.length > 0 },
    activeProfile: () => resolveActiveProfile(config.profiles, config.activeProfileId, DEFAULT_PROFILE),
    fallbackProfile(): ProviderProfile {
      const cached = fallbackProfiles.get(config)
      if (cached) return cached
      // Legacy/unloaded config has no profile objects. Snapshot its scalar values
      // once per config generation so requests and discovery share one route.
      const profile = {
        ...DEFAULT_PROFILE,
        authToken: config.authToken ?? '',
        baseUrl: config.baseUrl,
        modelList: config.modelList,
        modelGroups: config.modelGroups,
        recapModel: config.recapModel,
        commitMessageModel: config.commitMessageModel,
      }
      fallbackProfiles.set(config, profile)
      return profile
    },
  }
  return {
    config: configPort,
    auxLlm: {
      call: (req) => callAnthropicMessages(req),
    },
    mcpTransport: {
      createTransport: (target, opts) => createMcpTransport(target, opts),
      isAuthError: (err) => isMcpAuthError(err),
    },
    attachment: {
      readVerified: (input) => objects.readVerified(input),
      resolveAuthorized: (occurrence) => {
        if (!deps.uploadStore) {
          throw new Error('native attachment port: resolveAuthorized requires an injected uploadStore')
        }
        return resolveAuthorizedAttachment(occurrence, { uploadStore: deps.uploadStore, stateDir })
      },
    },
    skill: {
      listSkills: (cwd) => listSkills(cwd),
    },
    transcript: {
      normalize: (line, sessionId, trim) => normalize(line, sessionId, trim),
      paginateRenderable: (renderable, sessionId, opts) => paginateRenderable(renderable, sessionId, opts),
      normalizeSubagentLine: (line, sessionId) => normalizeSubagentLine(line, sessionId),
    },
  }
}

/** Test entry point: builds the real host adapters for a test provider.
 *  Pass the same stateDir/uploadStore the provider itself receives so the
 *  ports stay consistent with its wiring; bare `makeNativePorts()` gives a
 *  config/aux/transcript-only setup for handle-only unit sessions. */
export function makeNativePorts(deps: NativeHostPortsDeps = {}): NativeHostPorts {
  return createNativeHostPorts(deps)
}
