// Session metadata persistence.
//
// The SDK itself writes full conversation history to ~/.claude/projects/;
// we only need to remember which sessions existed, their metadata, and
// whether they're resumable. On startup we load this list so dormant
// sessions can appear in the UI as "hibernated" — the user clicks to
// resume and we spin up a fresh Query with `options.resume = <id>`.
//
// Storage is a single JSON file in stateDir (default ~/.claude-react-web/).
// Writes are atomic (tmp + rename) and debounced so a burst of updates
// doesn't thrash the disk. We never block the API path on the write —
// callers fire-and-forget via upsert/remove; shutdown() flushes.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { EffortLevel, PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import { JsonFileStore, DEFAULT_DIR_NAME } from './json-file-store.js'
import type { JsonFileStoreOptions } from './json-file-store.js'
import { createLogger } from './log.js'
import { validateSessionHooksConfig, type SessionHooksConfig } from '../shared/hooks.js'
import type { SessionMemorySettings } from '../shared/session-info.js'

const log = createLogger('persistence')

/** Metadata we need to resurrect a session. Deliberately a subset of
 *  Options — no auth tokens, no full SDK config. Everything here must
 *  be safe to ship to the frontend inside SessionInfo. */
export interface SessionMeta {
  id: string
  provider?: string
  createdAt: number
  lastActivityAt: number
  cwd?: string
  model?: string
  permissionMode?: PermissionMode
  title?: string
  /** Anthropic beta flags forwarded verbatim to the SDK on every
   *  re-spawn (restart / resume / fork). Persists the 1M-context flag
   *  for Sonnet 4 across server restarts. */
  betas?: string[]
  /** User intent: whether fast mode was requested. Re-applied to the SDK
   *  on re-spawn (resume / restart). Only the intent is persisted — the
   *  SDK's runtime fast_mode_state is re-reported after respawn. */
  fastMode?: boolean
  /** Per-session auto-memory settings (enable / directory / auto-dream).
   *  Re-applied to the SDK via applyFlagSettings on every re-spawn. The
   *  whole object is undefined when no memory key has been pinned. */
  memory?: SessionMemorySettings
  /** User intent: reasoning effort level. Re-applied to the SDK on
   *  re-spawn (resume / restart / fork). */
  effortLevel?: EffortLevel
  /** Structured hook configuration applied via Query.applyFlagSettings(). */
  hooks?: SessionHooksConfig
  /** Monotonic counter of user turns seen; used as a rough "is there
   *  anything to resume?" hint for the UI. */
  messageCount: number
  /** Present once the underlying Query has finished or errored. Terminated
   *  sessions stay in the index (so the user can read the transcript), but
   *  resume() refuses to re-spawn them. */
  terminated: boolean
  terminatedReason?: string
  error?: string
  /** Epoch ms of the last completed turn. Used by the frontend to flag
   *  unread badges when a turn completes while the user is looking at
   *  another session. */
  lastTurnAt?: number
  /** Snapshot of HEAD captured when the session was first spawned.
   *  Survives across process restarts so the GitPanel "This session"
   *  view stays anchored even if the server is bounced mid-conversation. */
  gitStartSha?: string
  /** When present, this session is a Side Chat forked from the
   *  indicated parent session. Undefined for normal sessions. */
  parentId?: string
  /** For a Side Chat (parentId set): the uuid of the parent's last
   *  renderable message at fork time. The fork copies the parent's
   *  transcript verbatim into this session's on-disk file, then appends
   *  this session's own messages; this uuid is the boundary between them.
   *  History reads (getHistoryPage / resume seed / search) pass it as
   *  `afterUuid` so the inherited parent prefix is never surfaced in the
   *  Side Chat UI (it's reference-only context for the model). Undefined
   *  for non-Side-Chat sessions. */
  forkBoundaryUuid?: string
  /** Names of MCP servers the session was spawned with. Survives
   *  restarts so the client can compute "available" without relying
   *  on the flaky mcp-status SDK control request. */
  mcpServerNames?: string[]
  /** Compound keys (`<plugin>@<marketplace>`) of the plugin subset this
   *  session was spawned with. `undefined` = all enabled (default); `[]` =
   *  none. Persisted so resume/fork re-inject the same subset. */
  enabledPlugins?: string[]
  /** Per-session override for the pinned "current question" header.
   *  Undefined = inherit the global config default. Persisted so the
   *  override survives reload. */
  showPinnedUserMessage?: boolean
  /** Per-session override for idle auto-recap. Undefined = inherit the
   *  global config default. Persisted so the override survives reload. */
  autoRecap?: boolean
  /** True when the user explicitly slept this session (dormant) via the
   *  "Sleep" action. Distinguishes deliberate dormancy from a passive
   *  restart/crash dormant state so the client can skip auto-resume paths.
   *  Cleared on resume. Persisted so the intent survives a restart. */
  slept?: boolean
}

const FILE_NAME = 'sessions.json'

export function defaultStateDir(): string {
  return join(homedir(), DEFAULT_DIR_NAME)
}

export type PersistenceOptions = JsonFileStoreOptions

/**
 * SessionStore — owns the on-disk index and schedules debounced writes.
 *
 * Usage:
 *   const store = new SessionStore({ stateDir })
 *   await store.load()
 *   store.upsert(meta)
 *   store.remove(id)
 *   await store.flush()  // typically on SIGINT
 */
export class SessionStore extends JsonFileStore<SessionMeta> {
  constructor(opts: PersistenceOptions = {}) {
    super(opts, FILE_NAME, DEFAULT_DIR_NAME, 'persistence')
  }

  protected getKey(meta: SessionMeta): string {
    return meta.id
  }

  /** Parse the on-disk JSON array into SessionMeta entries. */
  protected parseItems(raw: string): SessionMeta[] {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      log.warn(`${this.file} is not an array; ignoring`)
      return []
    }
    const entries: SessionMeta[] = []
    for (const item of parsed) {
      const meta = coerceMeta(item)
      if (meta) entries.push(meta)
    }
    return entries
  }

  /** SessionMeta serialises as a JSON array. */
  protected serializeForWrite(items: SessionMeta[]): unknown {
    return items
  }

  /** Read the index from disk. A missing or corrupt file is treated as
   *  empty — we never want a bad file to prevent startup. */
  async load(): Promise<SessionMeta[]> {
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      const entries = this.parseItems(raw)
      this.initEntries(entries)
      return entries
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT') return []
      log.warn(`failed to read ${this.file}: ${e.message}`)
      return []
    }
  }
}

/** Narrow and normalise untrusted JSON into a SessionMeta, or null if it's
 *  unusable. Forward-compatible: unknown extra fields are ignored. */
function coerceMeta(raw: unknown): SessionMeta | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = typeof r.id === 'string' ? r.id : null
  if (!id) return null
  const createdAt = typeof r.createdAt === 'number' ? r.createdAt : Date.now()
  const lastActivityAt = typeof r.lastActivityAt === 'number' ? r.lastActivityAt : createdAt
  return {
    id,
    provider: typeof r.provider === 'string' ? r.provider : 'claude',
    createdAt,
    lastActivityAt,
    cwd: typeof r.cwd === 'string' ? r.cwd : undefined,
    model: typeof r.model === 'string' ? r.model : undefined,
    permissionMode: typeof r.permissionMode === 'string' ? (r.permissionMode as PermissionMode) : undefined,
    title: typeof r.title === 'string' ? r.title : undefined,
    betas: Array.isArray(r.betas) && r.betas.every((b) => typeof b === 'string')
      ? (r.betas as string[])
      : undefined,
    fastMode: typeof r.fastMode === 'boolean' ? r.fastMode : undefined,
    memory: coerceMemory(r.memory),
    effortLevel:
      r.effortLevel === 'low' || r.effortLevel === 'medium' || r.effortLevel === 'high' ||
      r.effortLevel === 'xhigh' || r.effortLevel === 'max'
        ? r.effortLevel
        : undefined,
    hooks: coerceHooks(r.hooks),
    messageCount: typeof r.messageCount === 'number' ? r.messageCount : 0,
    terminated: typeof r.terminated === 'boolean' ? r.terminated : false,
    terminatedReason: typeof r.terminatedReason === 'string' ? r.terminatedReason : undefined,
    error: typeof r.error === 'string' ? r.error : undefined,
    lastTurnAt: typeof r.lastTurnAt === 'number' ? r.lastTurnAt : undefined,
    gitStartSha: typeof r.gitStartSha === 'string' ? r.gitStartSha : undefined,
    parentId: typeof r.parentId === 'string' ? r.parentId : undefined,
    forkBoundaryUuid: typeof r.forkBoundaryUuid === 'string' ? r.forkBoundaryUuid : undefined,
    mcpServerNames: Array.isArray(r.mcpServerNames) && r.mcpServerNames.every((n: unknown) => typeof n === 'string')
      ? (r.mcpServerNames as string[])
      : undefined,
    enabledPlugins: Array.isArray(r.enabledPlugins) && r.enabledPlugins.every((n: unknown) => typeof n === 'string')
      ? (r.enabledPlugins as string[])
      : undefined,
    showPinnedUserMessage: typeof r.showPinnedUserMessage === 'boolean' ? r.showPinnedUserMessage : undefined,
    autoRecap: typeof r.autoRecap === 'boolean' ? r.autoRecap : undefined,
    slept: typeof r.slept === 'boolean' ? r.slept : undefined,
  }
}

function coerceHooks(raw: unknown): SessionHooksConfig | undefined {
  if (raw == null) return undefined
  const result = validateSessionHooksConfig(raw)
  return result.ok ? result.value : undefined
}

/** Narrow untrusted JSON into SessionMemorySettings. Returns undefined
 *  when nothing usable remains — "all keys cleared" and "field absent"
 *  are the same state, so the wholesale upsert in writeStore can never
 *  resurrect a stale value. Exported for session-manager's snapshotMeta,
 *  which normalises the create-body `memory` through the same gate. */
export function coerceMemory(raw: unknown): SessionMemorySettings | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  const out: SessionMemorySettings = {}
  if (typeof r.autoMemoryEnabled === 'boolean') out.autoMemoryEnabled = r.autoMemoryEnabled
  if (typeof r.autoDreamEnabled === 'boolean') out.autoDreamEnabled = r.autoDreamEnabled
  if (typeof r.autoMemoryDirectory === 'string' && r.autoMemoryDirectory.trim()) {
    out.autoMemoryDirectory = r.autoMemoryDirectory.trim()
  }
  return Object.keys(out).length > 0 ? out : undefined
}
