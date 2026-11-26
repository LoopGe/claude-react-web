// server/providers/native/hooks/output.ts
import { createLogger } from '../../../log.js'
import { isPlainObject } from '../../../../shared/type-guards.js'
import type { HookConfig } from '../../../../shared/hooks.js'

const log = createLogger('native-hooks')

/** The parsed `SyncHookJSONOutput` fields (RS §2.1). The eight fields of the
 *  CLI's `EL()` zod schema plus the two wire-only fields on the CLI validation
 *  whitelist (`kgo`): `metrics` and `rewakeSummary`. `hookSpecificOutput` is
 *  kept as a loose record here — its per-event `hookEventName` / decision
 *  validation and mapping belong to the dispatch seams (later tasks), and this
 *  contract does not receive the event. */
export interface SyncHookDecision {
  continue?: boolean
  suppressOutput?: boolean
  stopReason?: string
  decision?: 'approve' | 'block'
  reason?: string
  systemMessage?: string
  terminalSequence?: string
  metrics?: Record<string, unknown>
  rewakeSummary?: string
  hookSpecificOutput?: Record<string, unknown>
}

/** One hook execution's raw capture turned into a decision-ready result.
 *  `outcome` is the exit-code contract (RS §2.3): 0 → success, 2 → blocked,
 *  anything else → non-blocking error; an exit-0 stdout that fails JSON
 *  validation also degrades to a non-blocking error. `decision` carries the
 *  parsed sync JSON for the per-event seams; a `decision:'block'` at exit 0 is
 *  parsed here and acted on per-event, not folded into `outcome`. For a
 *  blocked result `stderr` holds the effective block message (the JSON block
 *  reason when present, else the raw stderr — RS §2.3 "JSON block reason
 *  overrides stderr"). `async` marks a runtime `{async:true}` response. */
export interface HookExecResult {
  outcome: 'success' | 'blocked' | 'error' | 'cancelled'
  exitCode?: number
  stdout: string
  stderr: string
  decision?: SyncHookDecision
  async?: boolean
}

/** Internal stdout-parse classification (the CLI `zY` return shapes). */
type ParsedOutput =
  | { kind: 'plain' }
  | { kind: 'async' }
  | { kind: 'sync'; decision: SyncHookDecision }
  | { kind: 'invalid'; error: string }

const BOOLEAN_FIELDS = ['continue', 'suppressOutput'] as const
const STRING_FIELDS = ['stopReason', 'reason', 'systemMessage', 'terminalSequence', 'rewakeSummary'] as const

/** Hand validator for the sync branch of the CLI `Lce` union (RS §2.1). Each
 *  PRESENT whitelist field must have its declared type; a wrong type fails
 *  validation (→ plain text + error). Unknown keys are stripped, not rejected —
 *  the CLI's zod object strips them and only logs (`Qpe`), so an unknown key is
 *  a no-op, not a failure. */
function validateSync(raw: unknown): { ok: true; decision: SyncHookDecision } | { ok: false; error: string } {
  if (!isPlainObject(raw)) return { ok: false, error: 'hook JSON output must be an object' }
  const decision: SyncHookDecision = {}
  for (const key of BOOLEAN_FIELDS) {
    if (key in raw) {
      const value = raw[key]
      if (typeof value !== 'boolean') return { ok: false, error: `${key} must be a boolean` }
      decision[key] = value
    }
  }
  for (const key of STRING_FIELDS) {
    if (key in raw) {
      const value = raw[key]
      if (typeof value !== 'string') return { ok: false, error: `${key} must be a string` }
      decision[key] = value
    }
  }
  if ('decision' in raw) {
    const value = raw.decision
    if (value !== 'approve' && value !== 'block') return { ok: false, error: 'decision must be "approve" or "block"' }
    decision.decision = value
  }
  if ('metrics' in raw) {
    const value = raw.metrics
    if (!isPlainObject(value)) return { ok: false, error: 'metrics must be an object' }
    decision.metrics = value
  }
  if ('hookSpecificOutput' in raw) {
    const value = raw.hookSpecificOutput
    if (!isPlainObject(value)) return { ok: false, error: 'hookSpecificOutput must be an object' }
    decision.hookSpecificOutput = value
  }
  return { ok: true, decision }
}

/** The CLI `Avr` JSON-lines detection (RS §2.2 step 4): ≥2 non-empty lines,
 *  each individually valid JSON that either fails the union schema or validates
 *  to an empty no-op. Such output is "several JSON documents", treated as plain
 *  text without an error. A line that is a real (non-empty) decision — or async
 *  — disqualifies the whole output. */
function isJsonLinesOfNoops(trimmed: string): boolean {
  const lines = trimmed.split('\n').filter((line) => line.trim() !== '')
  if (lines.length < 2) return false
  return lines.every((line) => {
    let raw: unknown
    try {
      raw = JSON.parse(line.trim())
    } catch {
      return false
    }
    if (isPlainObject(raw) && raw.async === true) return false
    const validated = validateSync(raw)
    if (!validated.ok) return true
    return Object.keys(validated.decision).length === 0
  })
}

/** Parse hook stdout per the CLI `zY` contract (RS §2.2). Trimmed output not
 *  starting with `{` is plain text. A raw parse with `async===true` is the
 *  runtime async response (`KFr`). Otherwise JSON.parse + the sync validator: success
 *  → decision; failure → plain text + reported error. When JSON.parse throws:
 *  not ending with `}` → plain text (not a JSON object); JSON lines of no-ops
 *  (`Avr`) → plain text; otherwise → plain text + reported error. Never throws. */
function parseStdout(stdout: string): ParsedOutput {
  const trimmed = stdout.trim()
  if (!trimmed.startsWith('{')) return { kind: 'plain' }
  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch (err) {
    if (!trimmed.endsWith('}')) return { kind: 'plain' }
    if (isJsonLinesOfNoops(trimmed)) return { kind: 'plain' }
    return { kind: 'invalid', error: `hook output looks like a JSON object but is not valid JSON: ${String(err)}` }
  }
  if (isPlainObject(raw) && raw.async === true) return { kind: 'async' }
  const validated = validateSync(raw)
  if (validated.ok) return { kind: 'sync', decision: validated.decision }
  return { kind: 'invalid', error: validated.error }
}

function buildResult(
  outcome: HookExecResult['outcome'],
  stdout: string,
  stderr: string,
  exitCode: number,
  decision: SyncHookDecision | undefined,
  isAsync: boolean,
): HookExecResult {
  const result: HookExecResult = { outcome, exitCode, stdout, stderr }
  if (decision !== undefined) result.decision = decision
  if (isAsync) result.async = true
  return result
}

/** Turn a hook's raw stdout / stderr / exit code into a decision-ready result
 *  (RS §2.2 / §2.3). Exit 2 blocks; the block message is stderr unless the
 *  parsed JSON makes a block decision with a reason, which overrides it. Exit 2
 *  blocks even over a `permissionDecision:"allow"`. Exit 0 succeeds unless the
 *  stdout failed JSON validation (then a non-blocking error). Any other exit is
 *  a non-blocking error. The `continue:false`-overrides-exit-2 rule is a Stop /
 *  SubagentStop per-event override applied at that seam, not here. */
export function parseHookOutput(stdout: string, stderr: string, exitCode: number, hook: HookConfig): HookExecResult {
  const parsed = parseStdout(stdout)
  if (parsed.kind === 'invalid') {
    log.debug(`[${hook.type}] hook output degraded to plain text: ${parsed.error}`)
  }
  const decision = parsed.kind === 'sync' ? parsed.decision : undefined
  const isAsync = parsed.kind === 'async'

  if (exitCode === 2) {
    const blockMessage = decision?.decision === 'block' && decision.reason ? decision.reason : stderr
    return buildResult('blocked', stdout, blockMessage, exitCode, decision, isAsync)
  }
  const outcome = exitCode === 0 && parsed.kind !== 'invalid' ? 'success' : 'error'
  return buildResult(outcome, stdout, stderr, exitCode, decision, isAsync)
}

/** The CLI `Pje` onFailure predicate (RS §2.4): only command (non-async,
 *  non-asyncRewake) and http honor `onFailure:'block'`; prompt / agent do not. */
function onFailureBlocks(hook: HookConfig): boolean {
  switch (hook.type) {
    case 'command':
      return hook.onFailure === 'block' && hook.async !== true && hook.asyncRewake !== true
    case 'http':
      return hook.onFailure === 'block'
    default:
      return false
  }
}

/** Rewrite a hook failure as a block when `onFailure:'block'` applies (RS §2.4,
 *  the CLI `e0t`). A failure is a start failure / non-0-non-2 exit / invalid
 *  JSON (outcome 'error') or a timeout (outcome 'cancelled', RS §4.5). Success
 *  and already-blocked results pass through untouched, as do exempt hook types.
 *  The rewritten block message names the onFailure policy and keeps the failure
 *  detail; a timeout reads "timed out" rather than "failed". */
export function applyOnFailure(hook: HookConfig, result: HookExecResult): HookExecResult {
  if (!onFailureBlocks(hook)) return result
  if (result.outcome === 'success' || result.outcome === 'blocked') return result
  if (result.outcome === 'cancelled') {
    return { ...result, outcome: 'blocked', stderr: 'timed out; blocking because onFailure is "block"' }
  }
  const detail = result.stderr.trim()
  const message = `failed; blocking because onFailure is "block"${detail ? `\n${detail}` : ''}`
  return { ...result, outcome: 'blocked', stderr: message }
}
