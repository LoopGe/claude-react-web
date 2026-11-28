// Host-side implementations of the native provider's service ports
// (native/ports.ts). This module lives OUTSIDE native/ on purpose: it is the
// only place that wraps the host service modules (config, anthropic-api,
// mcp-config, attachment stores, skills, history-reader, subagent-transcripts,
// the CLAUDE.md memory reader, the auto-memory store) into the neutral port
// interfaces.
// default-providers.ts constructs the ports and injects them via
// NativeProvider opts; tests use makeNativePorts().

import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { config, DEFAULT_PROFILE, type ServerConfig } from '../config.js'
import { resolveActiveProfile } from '../profiles.js'
import type { ProviderProfile } from '../../shared/profile.js'
import { callAnthropicMessages } from '../anthropic-api.js'
import { createMcpTransport, isMcpAuthError } from '../mcp-config.js'
import { AttachmentObjectStore } from '../attachment-object-store.js'
import { resolveAuthorizedAttachment } from '../attachment-access.js'
import { listSkills } from '../skills.js'
import { listPluginContributions } from '../plugin-contributions.js'
import type { MpStore } from '../mp-store.js'
import { normalize, paginateRenderable } from '../history-reader.js'
import { normalizeSubagentLine } from '../subagent-transcripts.js'
import { projectNativeEventToSdkLine } from './native-host-frame-adapter.js'
import { createMemoryReader } from './native-host-memory.js'
import { createAutoMemoryPort, resolveMemoryRoots } from './native-host-auto-memory.js'
import type { UploadStore } from '../upload-store.js'
import { resolveNativeStateDir } from './native/session-log/paths.js'
import type { NativeAutoMemoryPort, NativeConfigPort, NativeHostPorts, NativeMemoryPort, NativeWorktreePort } from './native/ports.js'
import { digestOfImageRef } from '../../shared/image-attachment.js'
import { AttachmentStoreError } from '../../shared/attachment-store-error.js'
import { existsSync, promises as fs } from 'node:fs'
import { attachmentRoot, objectPathOf } from '../attachment-paths.js'
import { HttpError } from '../errors.js'
import { dirname, join, resolve, sep } from 'node:path'
import {
  branchExists, createWorktree, getGitCommonDir, listWorktrees,
  pruneWorktrees, removeWorktreeDir, runGit, tryCaptureGitHead,
} from '../git.js'
import { withRepoLock } from '../session-worktree.js'

/** Bare lowercase sha256 — the shape a store-backed attachment id must carry. */
const DIGEST_PATTERN = /^[a-f0-9]{64}$/

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
  /** Marketplace store for read-only plugin discovery (skills + the
   *  commands/agents/hooks/MCP contributions). Absent = the skill port stays
   *  user/project-only and the plugin port is undefined (handle-only unit
   *  sessions). */
  mpStore?: MpStore
  /** CLAUDE.md chain-reader override (tests inject fixture-backed readers);
   *  absent = the real host reader, createMemoryReader(). */
  memory?: NativeMemoryPort
  /** Auto-memory port override (tests inject fixture-backed ports); absent =
   *  the real host port over the resolved stateDir. */
  autoMemory?: NativeAutoMemoryPort
}

/** Build the real host adapters for one NativeProvider. The ConfigPort is a
 *  getter-backed LIVE view (reload-safe), and its fallback-profile cache is
 *  per-ports-object — the same granularity as the provider's per-instance
 *  WeakMap it mirrors. */
export function createNativeHostPorts(deps: NativeHostPortsDeps = {}): NativeHostPorts {
  const stateDir = resolveNativeStateDir(deps.stateDir)
  const objects = new AttachmentObjectStore(stateDir)
  const mpStore = deps.mpStore
  // Mirrors native-provider.ts's per-config fallback cache: one snapshot per
  // config generation (the frozen binding is replaced on reload), so requests
  // and discovery share one route within a generation.
  const fallbackProfiles = new WeakMap<ServerConfig, ProviderProfile>()
  const configPort: NativeConfigPort = {
    get nativeAttachmentFidelity() { return config.nativeAttachmentFidelity },
    get nativePdfDocuments() { return config.nativePdfDocuments },
    get nativeAutoCompactRatio() { return config.nativeAutoCompactRatio },
    get nativeDefaultContextWindow() { return config.nativeDefaultContextWindow },
    get nativeDreamAfterMs() { return config.nativeDreamAfterMs },
    get nativeDreamSessionCount() { return config.nativeDreamSessionCount },
    get modelList() { return config.modelList },
    get hasProfiles() { return config.profiles.length > 0 },
    get smallFastModel() { return config.smallFastModel },
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
    image: {
      publishImage: async (bytes, meta) => {
        const published = await objects.publishImage(bytes, meta)
        return { digest: published.digest, bytes: published.bytes }
      },
      readImage: async (attachment) => {
        const digest = digestOfImageRef(attachment.id)
        if (digest === null) throw new AttachmentStoreError('corrupt', `malformed image reference: ${attachment.id}`)
        const stored = await objects.readVerifiedImage(digest)
        // The declared facts are the durable occurrence; a mismatch means the
        // occurrence was tampered with or the store lost the object's identity.
        if (stored.meta.bytes !== attachment.bytes
          || stored.meta.mediaType !== attachment.mediaType
          || stored.meta.width !== attachment.width
          || stored.meta.height !== attachment.height) {
          throw new AttachmentStoreError('corrupt', `image reference does not match the stored image: ${attachment.id}`)
        }
        return { mediaType: stored.meta.mediaType, base64: Buffer.from(stored.bytes).toString('base64') }
      },
    },
    attachment: {
      readVerified: (input) => objects.readVerified(input),
      publish: (input) => objects.publishStream(input),
      resolveAuthorized: async (occurrence) => {
        // A `sha256:` id is a store-backed occurrence (a working-directory PDF
        // Read). Its bytes live in the object tree, not the upload registry;
        // resolve to the object path and let readVerified prove the digest.
        const digest = occurrence.id.startsWith('sha256:') ? occurrence.id.slice('sha256:'.length) : null
        if (digest !== null) {
          if (!DIGEST_PATTERN.test(digest) || digest !== occurrence.digest) {
            throw new HttpError(400, `attachment does not match its store identity: ${occurrence.id}`)
          }
          const objectPath = objectPathOf(attachmentRoot(stateDir), digest)
          const info = await fs.stat(objectPath).catch(() => undefined)
          if (!info || !info.isFile()) throw new HttpError(400, `attachment object is missing: ${occurrence.id}`)
          if (info.size !== occurrence.size) {
            throw new HttpError(400, `attachment does not match its object: ${occurrence.id}`)
          }
          return { ...occurrence, path: objectPath }
        }
        if (!deps.uploadStore) {
          throw new Error('native attachment port: resolveAuthorized requires an injected uploadStore')
        }
        return resolveAuthorizedAttachment(occurrence, { uploadStore: deps.uploadStore, stateDir })
      },
    },
    skill: {
      listSkills: (cwd, enabledPlugins) => listSkills(cwd, mpStore ? { mpStore, enabledPlugins } : undefined),
    },
    // Present only with a marketplace store — the eight always-on ports keep
    // their key set when plugin discovery is unavailable.
    ...(mpStore ? { plugin: { listContributions: (enabledPlugins?: string[]) => listPluginContributions(mpStore, enabledPlugins) } } : {}),
    transcript: {
      normalize: (line, sessionId, trim) => normalize(line, sessionId, trim),
      paginateRenderable: (renderable, sessionId, opts) => paginateRenderable(renderable, sessionId, opts),
      normalizeSubagentLine: (line, sessionId) => normalizeSubagentLine(line, sessionId),
      projectEventToSdkLine: (event, sessionId) => projectNativeEventToSdkLine(event, sessionId),
    },
    memory: deps.memory ?? createMemoryReader(),
    autoMemory: deps.autoMemory ?? createAutoMemoryPort({ stateDir }),
    worktree: createWorktreePort(),
  }
}

/** The CLI's per-segment worktree-name grammar, enforced again host-side: the
 *  tool validates for the MODEL, this validates the filesystem path we are
 *  about to build (`..` would escape `.claude/worktrees`). */
const WORKTREE_NAME_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/

async function repoTopLevel(cwd: string): Promise<string | null> {
  const r = await runGit(cwd, ['rev-parse', '--show-toplevel'], { allowAnyExitCode: true, noOptionalLocks: true })
  const top = r.stdout.trim()
  return r.exitCode === 0 && top !== '' ? top : null
}

/** Real git implementation of the worktree port. Every mutating call runs
 *  under the per-common-dir lock (worktree add/remove/prune race on it). */
export function createWorktreePort(): NativeWorktreePort {
  return {
    async list(cwd) {
      const top = await repoTopLevel(cwd)
      if (top === null) return null
      const entries = await listWorktrees(top)
      return entries.map((entry) => ({ path: entry.path, branch: entry.branch }))
    },

    async create(cwd, name) {
      if (!WORKTREE_NAME_RE.test(name) || name.split('/').includes('..')) {
        throw new Error(`invalid worktree name: ${name}`)
      }
      const top = await repoTopLevel(cwd)
      if (top === null) throw new Error(`EnterWorktree needs a git repository: ${cwd} is not inside one`)
      const head = await tryCaptureGitHead(top)
      if (head === undefined) throw new Error(`EnterWorktree needs a repository with at least one commit: ${top}`)
      const worktreePath = join(top, '.claude', 'worktrees', name)
      if (existsSync(worktreePath)) throw new Error(`a worktree already exists at ${worktreePath}`)
      const base = `worktree-${name.replaceAll('/', '-')}`
      const branch = (await branchExists(top, base)) ? `${base}-${Date.now()}` : base
      await fs.mkdir(dirname(worktreePath), { recursive: true })
      await withRepoLock(await getGitCommonDir(top), () => createWorktree(top, worktreePath, branch, head, true))
      return { path: worktreePath, branch }
    },

    async adopt(cwd, path) {
      const top = await repoTopLevel(cwd)
      if (top === null) throw new Error(`EnterWorktree needs a git repository: ${cwd} is not inside one`)
      const managedRoot = resolve(join(top, '.claude', 'worktrees'))
      const target = resolve(path)
      if (!target.startsWith(managedRoot + sep)) {
        throw new Error(`switching is limited to worktrees this repository manages under ${managedRoot}; spawn an Agent with cwd set to any other directory instead`)
      }
      const entries = await listWorktrees(top)
      const match = entries.find((entry) => resolve(entry.path) === target)
      if (!match) throw new Error(`git lists no worktree at ${target}`)
      return { path: match.path, branch: match.branch }
    },

    async inspect(worktreePath, mainCwd) {
      const status = await runGit(worktreePath, ['status', '--porcelain'], { noOptionalLocks: true })
      const dirtyFiles = status.stdout.split('\n').filter((line) => line.trim() !== '').slice(0, 50)
      let unmergedCommits = 0
      const mainHead = await runGit(mainCwd, ['rev-parse', 'HEAD'], { allowAnyExitCode: true, noOptionalLocks: true })
      if (mainHead.exitCode === 0 && mainHead.stdout.trim() !== '') {
        const count = await runGit(
          worktreePath,
          ['rev-list', '--count', 'HEAD', `^${mainHead.stdout.trim()}`],
          { allowAnyExitCode: true },
        )
        const parsed = Number.parseInt(count.stdout.trim(), 10)
        if (Number.isFinite(parsed) && parsed > 0) unmergedCommits = parsed
      }
      return { dirtyFiles, unmergedCommits }
    },

    async remove(mainCwd, worktreePath, branch, force) {
      await withRepoLock(await getGitCommonDir(mainCwd), async () => {
        if (force) {
          await removeWorktreeDir(mainCwd, worktreePath)
        } else {
          await runGit(mainCwd, ['worktree', 'remove', worktreePath], { timeoutMs: 30_000 })
        }
        if (branch !== null) {
          await runGit(mainCwd, ['branch', '-D', branch], { allowAnyExitCode: true })
        }
        await pruneWorktrees(mainCwd).catch(() => { /* best-effort registration cleanup */ })
      })
    },
  }
}

/** Test entry point: builds the real host adapters for a test provider.
 *  Pass the same stateDir/uploadStore the provider itself receives so the
 *  ports stay consistent with its wiring; bare `makeNativePorts()` gives a
 *  config/aux/transcript-only setup for handle-only unit sessions. Memory
 *  and autoMemory default to EMPTY stubs here — never the real host readers —
 *  so test ports stay hermetic on machines with a real ~/.claude/CLAUDE.md or
 *  memory store; inject deps.memory / deps.autoMemory for fixture-backed
 *  chains. The autoMemory stub's resolve is the lexical root computation
 *  only (it never creates directories) and its dream methods are no-ops, but
 *  listSessionsTouchedSince keeps the REAL scan over the resolved stateDir:
 *  dream tests seed session logs into their test stateDir and read them back
 *  through this surface. */
export function makeNativePorts(deps: NativeHostPortsDeps = {}): NativeHostPorts {
  const ports = createNativeHostPorts(deps)
  return {
    ...ports,
    ...(deps.memory ? {} : { memory: { read: async () => ({ files: [], isGitRepo: false }) } }),
    ...(deps.autoMemory ? {} : {
      autoMemory: {
        ...ports.autoMemory,
        resolve: async (cwd, override) => {
          const roots = resolveMemoryRoots(cwd, resolveNativeStateDir(deps.stateDir), override)
          return { ownDir: roots.own, claudeDir: null }
        },
        listCandidates: async () => [],
        readIndex: async () => null,
        readMemoryFile: async () => ({ content: '', truncated: false }),
        readDreamState: async () => ({}),
        claimDream: async () => false,
        releaseDream: async () => {},
      },
    }),
  }
}
