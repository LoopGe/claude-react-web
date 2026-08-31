// One-shot structured output (SDK Options.outputFormat / JSON-schema): give a
// prompt + schema, run a headless agent to a terminal `result` message, and
// return the parsed JSON. Browser-safe, SDK-agnostic — the server narrows the
// provider's SDK result through coerceStructuredOutput before it goes over the
// wire, so the client renders a guaranteed-clean shape.

/** Permission mode for a structured run. Deliberately NOT the full SDK
 *  PermissionMode set:
 *   - `'plan'` is excluded — plan mode terminates via ExitPlanMode, which the
 *     headless one-shot has no answerer for (it would block to the timeout,
 *     never producing a `result` frame).
 *   - `'auto'` is excluded for now (model-classifier decisions; a possible
 *     future enhancement).
 *  `'bypassPermissions'` is allowed but requires the SDK's
 *  `allowDangerouslySkipPermissions` guard, set by the provider. */
export type StructuredPermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'dontAsk'

export interface StructuredRunRequest {
  /** The instruction to run (the agent executes tools to reach it). */
  prompt: string
  /** JSON-schema the agent must conform its output to. */
  schema: Record<string, unknown>
  cwd?: string
  model?: string
  maxTurns?: number
  maxBudgetUsd?: number
  permissionMode?: StructuredPermissionMode
}

/** Mirrors the SDK's SDKResultMessage, narrowed. `ok: true` carries the parsed
 *  `structuredOutput` plus run metadata; `ok: false` carries an error subtype
 *  and any SDK-provided error strings. */
export interface StructuredRunResult {
  ok: boolean
  /** Parsed JSON payload (SDKResultSuccess.structured_output). */
  structuredOutput?: unknown
  /** Raw SDKResultSuccess.result text (the agent's final string). */
  rawText?: string
  numTurns?: number
  totalCostUsd?: number
  /** SDKResultError subtype — the terminal failure reason. */
  errorSubtype?:
    | 'error_during_execution'
    | 'error_max_turns'
    | 'error_max_budget_usd'
    | 'error_max_structured_output_retries'
  errors?: string[]
}

export const STRUCTURED_ERROR_SUBTYPES = new Set([
  'error_during_execution',
  'error_max_turns',
  'error_max_budget_usd',
  'error_max_structured_output_retries',
])

/** Defensive narrowing of an unknown SDK result frame into
 *  StructuredRunResult. On success pulls structuredOutput/rawText/metadata; on
 *  error preserves a recognized subtype else folds to a generic execution
 *  error. Entirely malformed input collapses to a generic error so the client
 *  always has something safe to render. */
export function coerceStructuredOutput(v: unknown): StructuredRunResult {
  if (typeof v !== 'object' || v === null) {
    return { ok: false, errorSubtype: 'error_during_execution' }
  }
  const r = v as Record<string, unknown>
  if (r.ok === true) {
    const out: StructuredRunResult = { ok: true }
    if (r.structuredOutput !== undefined) out.structuredOutput = r.structuredOutput
    if (typeof r.rawText === 'string') out.rawText = r.rawText
    if (typeof r.numTurns === 'number' && Number.isFinite(r.numTurns)) out.numTurns = r.numTurns
    if (typeof r.totalCostUsd === 'number' && Number.isFinite(r.totalCostUsd)) out.totalCostUsd = r.totalCostUsd
    return out
  }
  const out: StructuredRunResult = { ok: false }
  const sub = r.errorSubtype
  if (typeof sub === 'string' && STRUCTURED_ERROR_SUBTYPES.has(sub)) out.errorSubtype = sub as StructuredRunResult['errorSubtype']
  else out.errorSubtype = 'error_during_execution'
  if (Array.isArray(r.errors)) {
    const errs = r.errors.filter((e): e is string => typeof e === 'string' && !!e)
    if (errs.length > 0) out.errors = errs
  }
  return out
}