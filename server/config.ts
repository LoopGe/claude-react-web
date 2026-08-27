// Server-side configuration defaults.
//
// Configuration is loaded from <stateDir>/config.json (default
// ~/.claude-react-web/config.json). CLI flags (--model) take priority
// over the config file; hardcoded defaults are the final fallback.
//
// After loadConfig() runs the config object is frozen — mutation attempts
// throw at runtime, making the "load once" invariant explicit.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { SkillLoadMode } from '../shared/skills.js'
import {
  enableFileLogging, disableFileLogging, setLogConfig,
  LOG_LEVELS, LOG_LEVEL_FROM_ENV, LOG_SCOPES_FROM_ENV, type LogLevel,
  createLogger,
} from './log.js'
import { setWebAuth } from './auth.js'
import { HttpError } from './errors.js'

const log = createLogger('config')

/** A named bundle mapping the three CLI model tiers to concrete models.
 *  Empty slots fall back to the group's main model (see model-groups.ts).
 *  `main` is the slot used as the session's main model; defaults to 'opus'. */
export interface ModelGroupConfig {
  id: string
  name: string
  opus?: string
  sonnet?: string
  haiku?: string
  main?: 'opus' | 'sonnet' | 'haiku'
}

/** Schema for config.json */
interface ConfigFile {
  modelList?: string[]
  modelGroups?: ModelGroupConfig[]
  recapModel?: string
  /** Model used by the AI commit-message generator under the GitPanel
   *  "This session" view. Defaults to the same haiku model as recap; pick
   *  a different one (e.g. opus for higher quality at much higher cost)
   *  per project preference. */
  commitMessageModel?: string
  maxUploadBytes?: number
  historyCap?: number
  /** Separate FIFO budget for subagent frames (parent_tool_use_id != null)
   *  in the in-memory replay ring. Independent of historyCap so subagent
   *  volume never evicts main-thread frames. Default: 300. */
  subagentHistoryCap?: number
  /** Forward subagent text/thinking blocks into the message stream so the
   *  client's SubagentOverlay can render the full nested transcript.
   *  SDK Options key (spawn-time only — NOT a Settings key, so it cannot
   *  be flipped at runtime). Default: true. */
  forwardSubagentText?: boolean
  maxOpenPanels?: number
  /** Milliseconds of SDK silence before the session is considered stuck
   *  and auto-interrupted. Set to 0 to disable. Default: 1 hour. */
  workingStuckMs?: number
  /** Bearer token sent as `Authorization: Bearer <token>` to the API
   *  (works for both the official endpoint and Anthropic-compatible proxies).
   *  Required — server refuses to start without it. */
  authToken?: string
  /** API endpoint. Defaults to the official one. Override to point at a
   *  proxy / relay. No trailing slash expected; trimmed during load. */
  baseUrl?: string
  /** Shared WEB ACCESS token (NOT the Anthropic key above). When set, the
   *  web UI requires this token to access REST + WebSocket. Used as the
   *  startup initial value; the effective auth state lives in auth.ts's
   *  holder, not in the frozen config. Intentionally NOT in
   *  WRITABLE_CONFIG_KEYS — the UI must not be able to rewrite it. */
  accessToken?: string
  /** Write logs to a file in `<stateDir>/logs/`. Default: false. */
  logToFile?: boolean
  /** Persisted runtime log level. Restored on boot UNLESS the LOG_LEVEL env
   *  var (or DEBUG_SESSION) is set, in which case env wins as a per-launch
   *  override. Written by PUT /api/log. */
  logLevel?: string
  /** Persisted runtime scope filter (null / [] = all scopes). Restored on
   *  boot unless the LOG_SCOPES env var is set. Written by PUT /api/log. */
  logScopes?: string[] | null
  /** npm registry URL the update checker probes. Defaults to the public
   *  npm registry (https://registry.npmjs.org). Set to empty string to
   *  disable the update check entirely (banner stays hidden, About tab
   *  shows "disabled"). Override to point at a private registry. */
  updateCheckRegistry?: string
  skillLoadMode: string
  enabledSkills: string[]
  autoClassifierModel: string
  autoClassifierTimeout: number
  /** Global default for the pinned "current question" header. Per-session
   *  overrides (SessionMeta.showPinnedUserMessage) take priority; sessions
   *  without an override inherit this value. */
  showPinnedUserMessage: boolean
  /** Global default for auto-generating a session recap when idle. Per-session
   *  overrides (SessionMeta.autoRecap) take priority; sessions without an
   *  override inherit this value. Manual recap (Alt+R) is never gated. */
  autoRecap: boolean
  /** When true, acceptEdits and bypassPermissions modes also auto-approve
   *  edits/commands targeting "sensitive" config paths (.git/, .claude/,
   *  .vscode/, .idea/, shell & git config files) that otherwise still prompt
   *  even in those modes. Default false preserves the safe behavior. Does NOT
   *  affect ExitPlanMode / AskUserQuestion (interactive review is never
   *  bypassed) or the dontAsk lockdown mode. */
  allowSensitivePathEdits: boolean
  /** Max output tokens per model response, passed to the CLI subprocess as
   *  CLAUDE_CODE_MAX_OUTPUT_TOKENS. 0 = use the CLI's own default. */
  maxOutputTokens: number
}

export interface ServerConfig {
  readonly modelList: readonly string[]
  readonly modelGroups: readonly ModelGroupConfig[]
  readonly defaultModel: string
  readonly recapModel: string
  readonly commitMessageModel: string
  readonly maxUploadBytes: number
  readonly historyCap: number
  /** FIFO budget for subagent frames — see ConfigFile.subagentHistoryCap. */
  readonly subagentHistoryCap: number
  /** Forward subagent text/thinking — see ConfigFile.forwardSubagentText. */
  readonly forwardSubagentText: boolean
  readonly workingStuckMs: number
  readonly maxOpenPanels: number
  /** Undefined until config.json is loaded and `authToken` is populated.
   *  `requireAuthToken()` throws if accessed before that. */
  readonly authToken: string | undefined
  readonly baseUrl: string
  /** Shared web access token loaded from config.json. Empty when unset.
   *  Read once at startup by cli.ts; the live auth state lives in auth.ts. */
  readonly accessToken: string
  readonly logToFile: boolean
  /** npm registry the update checker probes. Defaults to the public npm
   *  registry; empty string means the user explicitly disabled the check.
   *  Stored as a string (not optional) so callers can do plain
   *  `if (config.updateCheckRegistry)` without defending against undefined. */
  readonly updateCheckRegistry: string
  readonly skillLoadMode: SkillLoadMode
  readonly enabledSkills: readonly string[]
  /** Model used by the auto-mode security classifier. Should be a fast,
   *  cheap model — haiku is the default. */
  readonly autoClassifierModel: string
  /** Timeout (ms) for classifier API calls. */
  readonly autoClassifierTimeout: number
  /** Global default for the pinned "current question" header. Sessions
   *  without an explicit override inherit this. */
  readonly showPinnedUserMessage: boolean
  /** Global default for idle auto-recap. Sessions without an explicit
   *  override inherit this. */
  readonly autoRecap: boolean
  /** When true, acceptEdits/bypassPermissions also bypass the sensitive-path
   *  safety checks. See ConfigFile.allowSensitivePathEdits. */
  readonly allowSensitivePathEdits: boolean
  /** Max output tokens per model response (CLAUDE_CODE_MAX_OUTPUT_TOKENS).
   *  0 = CLI default. */
  readonly maxOutputTokens: number
}

/** Hardcoded defaults. Captured as its own constant so applyParsedConfig
 *  can rebuild from defaults each load — that way removing a key from
 *  config.json (or PUT /api/config sending {key: ''}) actually reverts
 *  to the default instead of silently retaining the previously-loaded
 *  value in memory. */
const DEFAULTS: ServerConfig = Object.freeze<ServerConfig>({
  modelList: Object.freeze([
    'anthropic/claude-sonnet-4-20250514',
    'claude-opus-4-20250514',
    'claude-haiku-3-5-20241022',
  ]),
  modelGroups: Object.freeze([]),
  defaultModel: 'anthropic/claude-sonnet-4-20250514',
  recapModel: 'claude-haiku-4-5-20251001',
  commitMessageModel: 'claude-haiku-4-5-20251001',
  maxUploadBytes: 25 * 1024 * 1024,
  historyCap: 500,
  subagentHistoryCap: 300,
  forwardSubagentText: true,
  workingStuckMs: 60 * 60 * 1000,
  maxOpenPanels: 3,
  authToken: undefined,
  baseUrl: 'https://api.anthropic.com',
  accessToken: '',
  logToFile: false,
  updateCheckRegistry: 'https://registry.npmjs.org',
  skillLoadMode: 'default',
  enabledSkills: Object.freeze([]),
  autoClassifierModel: 'claude-haiku-4-5-20251001',
  autoClassifierTimeout: 5000,
  showPinnedUserMessage: true,
  autoRecap: true,
  allowSensitivePathEdits: false,
  maxOutputTokens: 0,
})

/** Current server config. Frozen after loadConfig() — reads are safe,
 *  writes throw at runtime. */
export let config: ServerConfig = DEFAULTS

/** Return the configured auth token or throw. Use at request time so a
 *  missing token surfaces as an HTTP 401 rather than a silent fallback. */
export function requireAuthToken(): string {
  const token = config.authToken
  if (!token) {
    throw new HttpError(
      401,
      'authToken is not configured. Set `authToken` in config.json (and optionally `baseUrl`).',
    )
  }
  return token
}

/** Test-only: merge overrides into the current frozen config and re-freeze.
 *  Production code loads config via loadConfig(); tests call this to set
 *  authToken/baseUrl without writing a temp file. */
export function __setConfigForTest(overrides: Partial<ServerConfig>): void {
  config = Object.freeze({ ...config, ...overrides })
}

/**
 * Load config from `<stateDir>/config.json`, replacing the config object
 * with a frozen merge of defaults + file values. If the file is missing a
 * starter config is scaffolded; if it is malformed, defaults are used
 * silently.
 */
export async function loadConfig(stateDir: string): Promise<void> {
  const file = join(stateDir, 'config.json')
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch {
    // File doesn't exist — scaffold a starter config so the user has a
    // concrete file to edit (fill in authToken, adjust models, etc.).
    try {
      await fs.mkdir(stateDir, { recursive: true })
      const scaffold = JSON.stringify(
        {
          authToken: '',
          baseUrl: 'https://api.anthropic.com',
          modelList: config.modelList.slice(),
          recapModel: config.recapModel,
          commitMessageModel: config.commitMessageModel,
          maxUploadBytes: config.maxUploadBytes,
          historyCap: config.historyCap,
          maxOpenPanels: config.maxOpenPanels,
        },
        null,
        2,
      )
      await fs.writeFile(file, scaffold, 'utf8')
      log.info(`created ${file} - fill in authToken to get started`)
    } catch (err) {
      log.warn(`could not scaffold ${file}:`, (err as Error).message)
    }
    return
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    log.warn(`${file} is not valid JSON, using defaults:`, (err as Error).message)
    return
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    log.warn(`${file} must be a JSON object, using defaults`)
    return
  }

  applyParsedConfig(parsed as ConfigFile, stateDir, file)
}

/** Merge a parsed config.json object into the in-memory config.
 *  Extracted from loadConfig() so doUpdateConfigFile() can skip the
 *  second disk read after writing an update.
 *
 *  Crucially we rebuild from `DEFAULTS`, not the current `config`. If
 *  the user removes a key from config.json (or PUT /api/config sends
 *  `{key: null}` / `{key: ''}` to clear it), `existing` will lack that
 *  key and the merged result must fall back to the hardcoded default.
 *  Building from `config` would carry the stale loaded value forward,
 *  making cleared keys behave like "no change". */
function applyParsedConfig(file_: ConfigFile, stateDir: string, file: string): void {
  const merged: ServerConfig = { ...DEFAULTS }

  if (Array.isArray(file_.modelList) && file_.modelList.length > 0) {
    const models = file_.modelList.filter((m) => typeof m === 'string' && m.trim())
    if (models.length > 0) {
      ;(merged as { modelList: readonly string[] }).modelList = Object.freeze(models)
      ;(merged as { defaultModel: string }).defaultModel = models[0]
      log.info(`loaded ${models.length} model(s) from ${file}, default: ${merged.defaultModel}`)
    }
  }

  // Model groups: a named bundle of tier-slot → concrete-model mappings.
  // A malformed entry is dropped with a warning (never blocks config load,
  // matching the file's tolerance for other fields); duplicate ids keep the
  // last entry. Groups with zero tier slots are unusable (resolveGroup's
  // main would fall to '') so they are dropped too.
  if (Array.isArray(file_.modelGroups)) {
    const byId = new Map<string, ModelGroupConfig>()
    for (const g of file_.modelGroups) {
      if (typeof g !== 'object' || g === null || Array.isArray(g)) {
        log.warn('dropping malformed model group (not an object)')
        continue
      }
      const raw = g as unknown as Record<string, unknown>
      const { id, name, main } = raw
      if (typeof id !== 'string' || !id.trim() || typeof name !== 'string' || !name.trim()) {
        log.warn('dropping model group with a missing/blank id or name')
        continue
      }
      if (main !== undefined && main !== 'opus' && main !== 'sonnet' && main !== 'haiku') {
        log.warn(`dropping model group ${id}: main must be one of opus|sonnet|haiku`)
        continue
      }
      let slotOk = true
      for (const slot of ['opus', 'sonnet', 'haiku'] as const) {
        const v = raw[slot]
        if (v !== undefined && typeof v !== 'string') {
          log.warn(`dropping model group ${id}: slot ${slot} must be a string`)
          slotOk = false
          break
        }
      }
      if (!slotOk) continue
      const entry: ModelGroupConfig = { id: id.trim(), name: name.trim() }
      for (const slot of ['opus', 'sonnet', 'haiku'] as const) {
        const v = raw[slot]
        if (typeof v === 'string' && v.trim()) entry[slot] = v.trim()
      }
      if (main !== undefined) entry.main = main as 'opus' | 'sonnet' | 'haiku'
      if (!entry.opus && !entry.sonnet && !entry.haiku) {
        log.warn(`dropping model group ${id}: no tier slots`)
        continue
      }
      byId.set(entry.id, entry)
    }
    if (byId.size > 0) {
      ;(merged as { modelGroups: readonly ModelGroupConfig[] }).modelGroups = Object.freeze([...byId.values()])
      log.info(`loaded ${byId.size} model group(s) from ${file}`)
    }
  }

  if (typeof file_.recapModel === 'string' && file_.recapModel.trim()) {
    ;(merged as { recapModel: string }).recapModel = file_.recapModel.trim()
  }

  if (typeof file_.commitMessageModel === 'string' && file_.commitMessageModel.trim()) {
    ;(merged as { commitMessageModel: string }).commitMessageModel = file_.commitMessageModel.trim()
  }

  if (typeof file_.maxUploadBytes === 'number' && file_.maxUploadBytes > 0) {
    ;(merged as { maxUploadBytes: number }).maxUploadBytes = Math.round(file_.maxUploadBytes)
    log.info(`maxUploadBytes: ${merged.maxUploadBytes}`)
  }

  if (typeof file_.historyCap === 'number' && file_.historyCap > 0) {
    ;(merged as { historyCap: number }).historyCap = Math.round(file_.historyCap)
    log.info(`historyCap: ${merged.historyCap}`)
  }

  if (typeof file_.subagentHistoryCap === 'number' && file_.subagentHistoryCap > 0) {
    ;(merged as { subagentHistoryCap: number }).subagentHistoryCap = Math.round(file_.subagentHistoryCap)
    log.info(`subagentHistoryCap: ${merged.subagentHistoryCap}`)
  }

  if (typeof file_.forwardSubagentText === 'boolean') {
    ;(merged as { forwardSubagentText: boolean }).forwardSubagentText = file_.forwardSubagentText
    log.info(`forwardSubagentText: ${merged.forwardSubagentText}`)
  }

  if (typeof file_.maxOpenPanels === 'number' && file_.maxOpenPanels !== 0) {
    ;(merged as { maxOpenPanels: number }).maxOpenPanels = Math.max(2, Math.min(5, Math.round(file_.maxOpenPanels)))
    log.info(`maxOpenPanels: ${merged.maxOpenPanels}`)
  }

  if (typeof file_.workingStuckMs === 'number' && file_.workingStuckMs >= 0) {
    ;(merged as { workingStuckMs: number }).workingStuckMs = Math.round(file_.workingStuckMs)
    log.info(`workingStuckMs: ${merged.workingStuckMs}`)
  }

  if (typeof file_.authToken === 'string' && file_.authToken.trim()) {
    ;(merged as { authToken?: string }).authToken = file_.authToken.trim()
    // Never log the token itself — just confirm it's present.
    log.info('authToken: configured')
  }

  if (typeof file_.baseUrl === 'string' && file_.baseUrl.trim()) {
    // Strip trailing slash so callers can always do `${baseUrl}/v1/...`.
    const trimmed = file_.baseUrl.trim().replace(/\/+$/, '')
    ;(merged as { baseUrl: string }).baseUrl = trimmed
    log.info(`baseUrl: ${trimmed}`)
  }

  if (typeof file_.accessToken === 'string' && file_.accessToken.trim()) {
    ;(merged as { accessToken: string }).accessToken = file_.accessToken.trim()
    // Never log the token value — just confirm a web access token is set.
    log.info('accessToken (web access): configured')
  }

  if (typeof file_.logToFile === 'boolean') {
    ;(merged as { logToFile: boolean }).logToFile = file_.logToFile
    log.info(`logToFile: ${file_.logToFile}`)
  }

  if (file_.skillLoadMode === 'default' || file_.skillLoadMode === 'all' || file_.skillLoadMode === 'allowlist') {
    ;(merged as { skillLoadMode: SkillLoadMode }).skillLoadMode = file_.skillLoadMode
  }

  if (Array.isArray(file_.enabledSkills)) {
    const enabledSkills = file_.enabledSkills.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim())
    ;(merged as { enabledSkills: readonly string[] }).enabledSkills = Object.freeze([...new Set(enabledSkills)])
  }

  if (typeof file_.updateCheckRegistry === 'string') {
    // Don't normalize trailing slashes here — the user may have a server
    // with a quirky path component (e.g. an artifactory path that ends
    // in `/api/npm/mi-npm`). We pass the value through to the fetcher
    // verbatim and let it concatenate `/<package>/latest`.
    const trimmed = file_.updateCheckRegistry.trim()
    ;(merged as { updateCheckRegistry: string }).updateCheckRegistry = trimmed
    if (trimmed) {
      log.info(`updateCheckRegistry: ${trimmed}`)
    }
  }

  if (typeof file_.autoClassifierModel === 'string' && file_.autoClassifierModel.trim()) {
    ;(merged as { autoClassifierModel: string }).autoClassifierModel = file_.autoClassifierModel.trim()
  }

  if (typeof file_.autoClassifierTimeout === 'number' && file_.autoClassifierTimeout > 0) {
    ;(merged as { autoClassifierTimeout: number }).autoClassifierTimeout = Math.round(file_.autoClassifierTimeout)
  }

  if (typeof file_.showPinnedUserMessage === 'boolean') {
    ;(merged as { showPinnedUserMessage: boolean }).showPinnedUserMessage = file_.showPinnedUserMessage
  }

  if (typeof file_.autoRecap === 'boolean') {
    ;(merged as { autoRecap: boolean }).autoRecap = file_.autoRecap
  }

  if (typeof file_.allowSensitivePathEdits === 'boolean') {
    ;(merged as { allowSensitivePathEdits: boolean }).allowSensitivePathEdits = file_.allowSensitivePathEdits
  }

  if (typeof file_.maxOutputTokens === 'number' && file_.maxOutputTokens >= 0) {
    ;(merged as { maxOutputTokens: number }).maxOutputTokens = file_.maxOutputTokens
  }

  config = Object.freeze(merged)

  // Enable or disable file logging based on the loaded config.
  if (config.logToFile) {
    enableFileLogging(stateDir)
  } else {
    disableFileLogging()
  }

  // Restore persisted log level / scopes. Env vars are a per-launch override
  // and win over the persisted value, so only restore the dimensions that
  // weren't set via env. setLogConfig only touches the fields we pass.
  const logUpdate: { level?: LogLevel; scopes?: string[] | null } = {}
  if (!LOG_LEVEL_FROM_ENV
    && typeof file_.logLevel === 'string'
    && LOG_LEVELS.includes(file_.logLevel as LogLevel)) {
    logUpdate.level = file_.logLevel as LogLevel
  }
  if (!LOG_SCOPES_FROM_ENV && file_.logScopes !== undefined) {
    if (file_.logScopes === null
      || (Array.isArray(file_.logScopes) && file_.logScopes.every((s) => typeof s === 'string'))) {
      logUpdate.scopes = file_.logScopes
    }
  }
  if (logUpdate.level !== undefined || logUpdate.scopes !== undefined) {
    setLogConfig(logUpdate)
  }
}

/** Mutable fields the client is allowed to update via PUT /api/config. */
export const WRITABLE_CONFIG_KEYS = [
  'authToken',
  'baseUrl',
  'modelList',
  'modelGroups',
  'recapModel',
  'commitMessageModel',
  'maxUploadBytes',
  'historyCap',
  'maxOpenPanels',
  'workingStuckMs',
  'logToFile',
  'logLevel',
  'logScopes',
  'updateCheckRegistry',
  'skillLoadMode',
  'enabledSkills',
  'autoClassifierModel',
  'autoClassifierTimeout',
  'showPinnedUserMessage',
  'autoRecap',
  'allowSensitivePathEdits',
  'maxOutputTokens',
] as const

/**
 * Read the raw config.json from disk and return it. Returns an empty object
 * if the file doesn't exist or is malformed.
 */
export async function readConfigFile(stateDir: string): Promise<Record<string, unknown>> {
  const file = join(stateDir, 'config.json')
  try {
    const raw = await fs.readFile(file, 'utf8')
    const parsed = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch { /* ignore */ }
  return {}
}

/**
 * Merge partial updates into config.json on disk, then hot-reload the
 * in-memory config via loadConfig(). Only fields listed in
 * WRITABLE_CONFIG_KEYS are accepted.
 *
 * Writes are serialized via a promise chain so that concurrent callers
 * (e.g. two browser tabs hitting PUT /config) cannot read-modify-write
 * the same snapshot and silently overwrite each other's changes.
 */
let configWriteQueue: Promise<void> = Promise.resolve()

export function updateConfigFile(
  stateDir: string,
  updates: Record<string, unknown>,
): Promise<void> {
  // Two concerns to balance:
  //   1. The caller MUST see the real outcome of THIS write (resolve or
  //      reject) — otherwise we'd hide write failures from the HTTP layer.
  //   2. The queue MUST NOT be poisoned by a prior failure. If a previous
  //      `doUpdateConfigFile` rejected, a naive `queue.then(thisWrite)`
  //      would skip the handler and propagate the old rejection to every
  //      subsequent caller forever — one transient ENOSPC / EPERM and
  //      every later config write silently no-ops.
  //
  // Solution: the queue swallows errors so it stays fulfilled, but we
  // return a separate promise that exposes the current write's outcome.
  const thisWrite = configWriteQueue.then(() => doUpdateConfigFile(stateDir, updates))
  configWriteQueue = thisWrite.catch(() => {
    // Don't propagate — the next caller's chained .then() must still run.
  })
  return thisWrite
}

async function doUpdateConfigFile(
  stateDir: string,
  updates: Record<string, unknown>,
): Promise<void> {
  const existing = await readConfigFile(stateDir)
  for (const key of WRITABLE_CONFIG_KEYS) {
    if (key in updates) {
      const val = updates[key]
      // Treat null / empty-string as "remove the override" (revert to default).
      if (val === null || val === '') {
        delete existing[key]
      } else {
        existing[key] = val
      }
    }
  }
  const file = join(stateDir, 'config.json')
  await fs.writeFile(file, JSON.stringify(existing, null, 2), 'utf8')
  // Apply the merged result directly instead of re-reading from disk.
  applyParsedConfig(existing as unknown as ConfigFile, stateDir, file)
}

/** Enqueue an arbitrary read-modify-write on the same serialized
 *  `configWriteQueue` as `updateConfigFile`, for fields that aren't in
 *  `WRITABLE_CONFIG_KEYS` (e.g. `accessToken`). The mutate fn operates on the
 *  raw parsed config object in place; the helper persists + re-applies it.
 *  This MUST be used for any direct config.json edit so a concurrent
 *  `updateConfigFile` can't interleave and clobber (or be clobbered by) it. */
export function queueConfigWrite(
  stateDir: string,
  mutate: (existing: Record<string, unknown>) => Promise<void> | void,
): Promise<void> {
  const thisWrite = configWriteQueue.then(() => doRawConfigUpdate(stateDir, mutate))
  configWriteQueue = thisWrite.catch(() => {
    // Don't poison the queue — same rationale as updateConfigFile.
  })
  return thisWrite
}

async function doRawConfigUpdate(
  stateDir: string,
  mutate: (existing: Record<string, unknown>) => Promise<void> | void,
): Promise<void> {
  const existing = await readConfigFile(stateDir)
  await mutate(existing)
  const file = join(stateDir, 'config.json')
  await fs.writeFile(file, JSON.stringify(existing, null, 2), 'utf8')
  applyParsedConfig(existing as unknown as ConfigFile, stateDir, file)
}

/** Clear connection credentials: authToken + baseUrl (→ defaults) and the web
 *  access token (accessToken, which bypasses WRITABLE_CONFIG_KEYS). Reloads
 *  config and clears live web-auth state. All three deletes run as one
 *  atomic read-modify-write on the config write queue, so a concurrent
 *  PUT /config cannot interleave and silently undo the clear or be clobbered. */
export async function clearCredentials(stateDir: string): Promise<void> {
  await queueConfigWrite(stateDir, (existing) => {
    delete existing.authToken
    delete existing.baseUrl
    delete existing.accessToken
  })
  await loadConfig(stateDir)
  setWebAuth('', false)
}

