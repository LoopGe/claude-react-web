import { isPlainObject } from './type-guards'

export const SUPPORTED_HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PermissionRequest',
  'PermissionDenied',
  'Setup',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'Elicitation',
  'ElicitationResult',
  'ConfigChange',
  'WorktreeCreate',
  'WorktreeRemove',
  'InstructionsLoaded',
  'CwdChanged',
  'FileChanged',
] as const

export type HookEvent = (typeof SUPPORTED_HOOK_EVENTS)[number]

export type HookType = 'command' | 'http' | 'prompt' | 'agent'

export type HookShell = 'bash' | 'powershell'

export interface BaseHookConfig {
  type: HookType
  if?: string
  timeout?: number
  statusMessage?: string
  once?: boolean
  /** What a failure of this hook does (SDK Settings hook field, 0.3.295):
   *  could not start (missing script/plugin dir), timed out, exited with a
   *  code other than 0/2, or printed JSON that is invalid or fails
   *  validation. 'continue' (default): the failure is reported and the
   *  action goes ahead. 'block': the failure counts as exit code 2, so the
   *  action the event guards (a tool call, a permission request, a prompt)
   *  is blocked. Ignored by the CLI for async hooks and on Stop,
   *  SubagentStop, TaskCompleted and TeammateIdle. */
  onFailure?: 'continue' | 'block'
}

export interface CommandHookConfig extends BaseHookConfig {
  type: 'command'
  command: string
  shell?: HookShell
  async?: boolean
  asyncRewake?: boolean
}

export interface HttpHookConfig extends BaseHookConfig {
  type: 'http'
  url: string
  headers?: Record<string, string>
  allowedEnvVars?: string[]
}

export interface PromptHookConfig extends BaseHookConfig {
  type: 'prompt'
  prompt: string
  model?: string
}

export interface AgentHookConfig extends BaseHookConfig {
  type: 'agent'
  prompt: string
  model?: string
}

export type HookConfig = CommandHookConfig | HttpHookConfig | PromptHookConfig | AgentHookConfig

export interface HookMatcherConfig {
  matcher?: string
  hooks: HookConfig[]
}

export type SessionHooksConfig = Partial<Record<HookEvent, HookMatcherConfig[]>>

/** Engine-internal MULTI-FACT hook decision (controller ruling after the T6
 *  review). The CLI's `hookSpecificOutput` carries SIMULTANEOUS facts — a hook
 *  can allow AND add context, rewrite output AND assert classifier context — so
 *  a single-variant union would discard honored facts. The merged decision
 *  carries a primary `action` PLUS all side facts. The engine validates each
 *  hook's `hookSpecificOutput.hookEventName === event` and gates per-event field
 *  applicability; the per-event ACTION semantics (does exit-2 block this event,
 *  deny-vs-erase-vs-continue, rewrite application) live in the dispatch seams.
 *  Field names follow RS §3 per-event hookSpecificOutput. Neutral: no SDK types
 *  (`updatedPermissions` is a loose passthrough the host seam projects). */
export interface HookDecision {
  /** Primary action, rank-merged across hooks: block > deny > allow > ask >
   *  defer > continue. */
  action: 'continue' | 'block' | 'allow' | 'deny' | 'ask' | 'defer'
  /** Present when action === 'block': the effective block message + its RS §3
   *  audience (model vs user). */
  block?: { reason: string; target: 'model' | 'user' }
  /** The dominant permission decision (PreToolUse permissionDecision /
   *  PermissionRequest decision). Absent when action is continue/block. */
  permission?: {
    behavior: 'allow' | 'deny' | 'ask' | 'defer'
    updatedInput?: Record<string, unknown>
    reason?: string
    message?: string
    interrupt?: boolean
    /** Neutral passthrough; the host seam projects to SDK PermissionUpdate[]. */
    updatedPermissions?: unknown[]
  }
  /** ALWAYS accumulated across hooks, never dropped when an action dominates. */
  additionalContext: string[]
  /** PostToolUse rewrites — last-write-wins in collection order (RS §4.9). */
  updatedToolOutput?: string
  updatedMCPToolOutput?: string
  classifierContext?: string
  /** Stop forced-continuation; continue:false overrides exit-2 (RS §2.3) — the
   *  seam applies that override, the engine carries the fact. */
  continue?: boolean
  stopReason?: string
  suppressOutput?: boolean
  systemMessage?: string
  /** UserPromptSubmit / SessionStart. */
  suppressOriginalPrompt?: boolean
  sessionTitle?: string
  /** SessionStart. */
  initialUserMessage?: string
  watchPaths?: string[]
  reloadSkills?: boolean
  /** PermissionDenied. */
  retry?: boolean
  /** PreCompact exit-0 plain stdout (custom compact instructions, RS §13.3). */
  customInstructions?: string
}

export type HookRunStatus = 'started' | 'progress' | 'success' | 'error' | 'cancelled'

export interface HookRunRecord {
  id: string
  hookId: string
  hookName: string
  event: string
  status: HookRunStatus
  startedAt: number
  updatedAt: number
  stdout?: string
  stderr?: string
  output?: string
  exitCode?: number
  /** Structured input summary from in-process read+react hooks. Not present on external settings-hook frames. */
  hookInput?: string
}

export type HookRuntimeEvent =
  | { kind: 'started'; run: HookRunRecord }
  | { kind: 'progress'; run: HookRunRecord }
  | { kind: 'completed'; run: HookRunRecord }

export interface HooksValidationError {
  path: string
  message: string
}

export type HooksValidationResult =
  | { ok: true; value: SessionHooksConfig }
  | { ok: false; errors: HooksValidationError[] }

export function formatHooksValidationErrors(errors: HooksValidationError[]): string {
  return errors.map((error) => `${error.path} ${error.message}`).join('; ')
}


const SUPPORTED_EVENT_SET = new Set<string>(SUPPORTED_HOOK_EVENTS)
const SHELL_SET = new Set<string>(['bash', 'powershell'])

function optionalString(value: unknown, path: string, errors: HooksValidationError[]): string | undefined {
  if (value == null) return undefined
  if (typeof value !== 'string') {
    errors.push({ path, message: 'must be a string' })
    return undefined
  }
  return value
}

function optionalBoolean(value: unknown, path: string, errors: HooksValidationError[]): boolean | undefined {
  if (value == null) return undefined
  if (typeof value !== 'boolean') {
    errors.push({ path, message: 'must be a boolean' })
    return undefined
  }
  return value
}

function optionalPositiveNumber(value: unknown, path: string, errors: HooksValidationError[]): number | undefined {
  if (value == null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    errors.push({ path, message: 'must be a positive number' })
    return undefined
  }
  return value
}

function optionalStringRecord(value: unknown, path: string, errors: HooksValidationError[]): Record<string, string> | undefined {
  if (value == null) return undefined
  if (!isPlainObject(value)) {
    errors.push({ path, message: 'must be an object of string values' })
    return undefined
  }
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') {
      errors.push({ path: `${path}.${key}`, message: 'must be a string' })
      continue
    }
    out[key] = item
  }
  return out
}

function optionalStringArray(value: unknown, path: string, errors: HooksValidationError[]): string[] | undefined {
  if (value == null) return undefined
  if (!Array.isArray(value)) {
    errors.push({ path, message: 'must be an array of strings' })
    return undefined
  }
  const out: string[] = []
  value.forEach((item, index) => {
    if (typeof item !== 'string') {
      errors.push({ path: `${path}[${index}]`, message: 'must be a string' })
    } else {
      out.push(item)
    }
  })
  return out
}

const ON_FAILURE_SET = new Set<string>(['continue', 'block'])

function assignBase(target: HookConfig, raw: Record<string, unknown>, path: string, errors: HooksValidationError[]): HookConfig {
  const condition = optionalString(raw.if, `${path}.if`, errors)
  const timeout = optionalPositiveNumber(raw.timeout, `${path}.timeout`, errors)
  const statusMessage = optionalString(raw.statusMessage, `${path}.statusMessage`, errors)
  const once = optionalBoolean(raw.once, `${path}.once`, errors)
  const onFailure = optionalString(raw.onFailure, `${path}.onFailure`, errors)
  if (condition !== undefined) target.if = condition
  if (timeout !== undefined) target.timeout = timeout
  if (statusMessage !== undefined) target.statusMessage = statusMessage
  if (once !== undefined) target.once = once
  if (onFailure !== undefined) {
    // Present but unknown → error (not strip): 'block' vs 'continue' is a
    // enforcement-semantics choice, and silently dropping a typo'd 'blok'
    // would flip the user's intent to the laxer default.
    if (!ON_FAILURE_SET.has(onFailure)) errors.push({ path: `${path}.onFailure`, message: 'must be "continue" or "block"' })
    else target.onFailure = onFailure as 'continue' | 'block'
  }
  return target
}

function validatePromptLikeHook(
  raw: Record<string, unknown>,
  path: string,
  errors: HooksValidationError[],
): PromptHookConfig | AgentHookConfig | null {
  if (typeof raw.prompt !== 'string' || raw.prompt.trim().length === 0) {
    errors.push({ path: `${path}.prompt`, message: 'must be a non-empty string' })
    return null
  }
  const hook: PromptHookConfig | AgentHookConfig = raw.type === 'prompt'
    ? { type: 'prompt', prompt: raw.prompt }
    : { type: 'agent', prompt: raw.prompt }
  const model = optionalString(raw.model, `${path}.model`, errors)
  if (model !== undefined) hook.model = model
  return assignBase(hook, raw, path, errors) as PromptHookConfig | AgentHookConfig
}

function validateHook(raw: unknown, path: string, errors: HooksValidationError[]): HookConfig | null {
  if (!isPlainObject(raw)) {
    errors.push({ path, message: 'must be an object' })
    return null
  }
  if (raw.type !== 'command' && raw.type !== 'http' && raw.type !== 'prompt' && raw.type !== 'agent') {
    errors.push({ path: `${path}.type`, message: 'must be "command", "http", "prompt", or "agent"' })
    return null
  }

  if (raw.type === 'command') {
    if (typeof raw.command !== 'string' || raw.command.trim().length === 0) {
      errors.push({ path: `${path}.command`, message: 'must be a non-empty string' })
      return null
    }
    const hook: CommandHookConfig = { type: 'command', command: raw.command }
    const shell = optionalString(raw.shell, `${path}.shell`, errors)
    if (shell !== undefined) {
      if (!SHELL_SET.has(shell)) errors.push({ path: `${path}.shell`, message: 'must be "bash" or "powershell"' })
      else hook.shell = shell as HookShell
    }
    const asyncHook = optionalBoolean(raw.async, `${path}.async`, errors)
    const asyncRewake = optionalBoolean(raw.asyncRewake, `${path}.asyncRewake`, errors)
    if (asyncHook !== undefined) hook.async = asyncHook
    if (asyncRewake !== undefined) hook.asyncRewake = asyncRewake
    return assignBase(hook, raw, path, errors)
  }

  if (raw.type === 'prompt' || raw.type === 'agent') {
    return validatePromptLikeHook(raw, path, errors)
  }

  if (typeof raw.url !== 'string' || raw.url.trim().length === 0) {
    errors.push({ path: `${path}.url`, message: 'must be a non-empty URL string' })
    return null
  }
  try {
    const parsed = new URL(raw.url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      errors.push({ path: `${path}.url`, message: 'must use http or https' })
    }
  } catch {
    errors.push({ path: `${path}.url`, message: 'must be a valid URL' })
  }
  const hook: HttpHookConfig = { type: 'http', url: raw.url }
  const headers = optionalStringRecord(raw.headers, `${path}.headers`, errors)
  const allowedEnvVars = optionalStringArray(raw.allowedEnvVars, `${path}.allowedEnvVars`, errors)
  if (headers !== undefined) hook.headers = headers
  if (allowedEnvVars !== undefined) hook.allowedEnvVars = allowedEnvVars
  return assignBase(hook, raw, path, errors)
}

export function validateSessionHooksConfig(input: unknown): HooksValidationResult {
  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ path: 'hooks', message: 'must be an object' }] }
  }
  const errors: HooksValidationError[] = []
  const value: SessionHooksConfig = {}

  for (const [event, matchers] of Object.entries(input)) {
    if (!SUPPORTED_EVENT_SET.has(event)) {
      errors.push({ path: event, message: `unsupported hook event; supported events: ${SUPPORTED_HOOK_EVENTS.join(', ')}` })
      continue
    }
    if (!Array.isArray(matchers)) {
      errors.push({ path: event, message: 'must be an array of matcher objects' })
      continue
    }
    const normalizedMatchers: HookMatcherConfig[] = []
    matchers.forEach((matcher, matcherIndex) => {
      const matcherPath = `${event}[${matcherIndex}]`
      if (!isPlainObject(matcher)) {
        errors.push({ path: matcherPath, message: 'must be an object' })
        return
      }
      if (!Array.isArray(matcher.hooks)) {
        errors.push({ path: `${matcherPath}.hooks`, message: 'must be an array' })
        return
      }
      const normalizedHooks: HookConfig[] = []
      matcher.hooks.forEach((hook, hookIndex) => {
        const normalized = validateHook(hook, `${matcherPath}.hooks[${hookIndex}]`, errors)
        if (normalized) normalizedHooks.push(normalized)
      })
      const matcherValue: HookMatcherConfig = { hooks: normalizedHooks }
      const matcherString = optionalString(matcher.matcher, `${matcherPath}.matcher`, errors)
      if (matcherString !== undefined) matcherValue.matcher = matcherString
      normalizedMatchers.push(matcherValue)
    })
    value[event as HookEvent] = normalizedMatchers
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value }
}

export function emptyHooksConfig(config: SessionHooksConfig | undefined): boolean {
  if (!config) return true
  return Object.values(config).every((matchers) => !matchers || matchers.length === 0)
}

export function toSdkHooksSettings(config: SessionHooksConfig): Record<string, unknown> {
  const hooks: Record<string, unknown> = {}
  for (const event of SUPPORTED_HOOK_EVENTS) {
    const matchers = config[event]
    if (matchers && matchers.length > 0) {
      hooks[event] = matchers.map((matcher) => ({
        ...(matcher.matcher !== undefined ? { matcher: matcher.matcher } : {}),
        hooks: matcher.hooks.map((hook) => ({ ...hook })),
      }))
    }
  }
  return hooks
}

/** Neutral MULTI-FACT hook decision shared by the provider seam and the native
 *  hook engine. The CLI's `hookSpecificOutput` carries SIMULTANEOUS facts — a
 *  hook can allow AND add context, rewrite output AND assert classifier context
 *  — so a single-variant union would discard honored facts. The merged decision
 *  carries a primary `action` PLUS all side facts. The engine validates each
 *  hook's `hookSpecificOutput.hookEventName === event` and gates per-event field
 *  applicability; the per-event ACTION semantics (does exit-2 block this event,
 *  deny-vs-erase-vs-continue, rewrite application) live in the dispatch seams.
 *  Field names follow the CLI per-event hookSpecificOutput. Neutral: no SDK
 *  types (`updatedPermissions` is a loose passthrough the host seam projects).
 *  Lives in shared/ (not native/) so the provider contract (providers/types.ts)
 *  can reference it without importing a concrete provider (seam-neutrality pin). */
export interface HookDecision {
  /** Primary action, rank-merged across hooks: block > deny > allow > ask >
   *  defer > continue. */
  action: 'continue' | 'block' | 'allow' | 'deny' | 'ask' | 'defer'
  /** Present when action === 'block': the effective block message + its
   *  audience (model vs user). */
  block?: { reason: string; target: 'model' | 'user' }
  /** The dominant permission decision (PreToolUse permissionDecision /
   *  PermissionRequest decision). Absent when action is continue/block. */
  permission?: {
    behavior: 'allow' | 'deny' | 'ask' | 'defer'
    updatedInput?: Record<string, unknown>
    reason?: string
    message?: string
    interrupt?: boolean
    /** Neutral passthrough; the host seam projects to SDK PermissionUpdate[]. */
    updatedPermissions?: unknown[]
  }
  /** ALWAYS accumulated across hooks, never dropped when an action dominates. */
  additionalContext: string[]
  /** PostToolUse rewrites — last-write-wins in collection order. */
  updatedToolOutput?: string
  updatedMCPToolOutput?: string
  classifierContext?: string
  /** Stop forced-continuation; continue:false overrides exit-2 — the seam
   *  applies that override, the engine carries the fact. */
  continue?: boolean
  stopReason?: string
  suppressOutput?: boolean
  systemMessage?: string
  /** UserPromptSubmit / SessionStart. */
  suppressOriginalPrompt?: boolean
  sessionTitle?: string
  /** SessionStart. */
  initialUserMessage?: string
  watchPaths?: string[]
  reloadSkills?: boolean
  /** PermissionDenied. */
  retry?: boolean
  /** PreCompact exit-0 plain stdout (custom compact instructions). */
  customInstructions?: string
}
