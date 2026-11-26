// server/providers/native/hooks/engine.ts
// The hook orchestrator (design §1/§3, RS §4.9/§7/§12.3). One dispatch collects
// the event's matcher groups FRESH from the ordered sources (never a frozen
// snapshot, so a live applyHooks takes effect on the next event), filters them
// by the matcher, runs the matched hooks with the CLI concurrency discipline
// (command/http parallel capped at 12, prompt/agent serial), merges the results
// into one decision, and emits started/completed activity per hook. `once` is
// inert (settings-shaped hooks have no removal path, RS §4.3) and `if` is wired
// by a later task. The per-event ACTION mapping of a decision (does exit-2 block
// this event, deny-vs-erase-vs-continue, rewrite merge) belongs to the calling
// seams; the engine returns the merged decision facts.
import { randomUUID } from 'node:crypto'
import { createLogger } from '../../../log.js'
import { isPlainObject, isStringArray } from '../../../../shared/type-guards.js'
import type {
  CommandHookConfig,
  HookConfig,
  HookEvent,
  HookRunRecord,
  HookRunStatus,
  HookRuntimeEvent,
  HookType,
} from '../../../../shared/hooks.js'
import type { LoopDeps } from '../loop.js'
import type { ToolDef } from '../tools/types.js'
import { collectForEvent } from './collection.js'
import { matches, matcherTarget } from './matcher.js'
import { applyOnFailure, type HookExecResult } from './output.js'
import { runCommandHook, type HookExecContext } from './command-executor.js'
import type { HookModelOptions } from './model.js'
import type { HookDecision, HookSource } from './types.js'

const log = createLogger('native-hooks')

/** RS §4.9: the mixed command/http runner concurrency cap (`_Ze=12`). */
const PARALLEL_CAP = 12

/** The execution context an executor receives: the base command-exec context
 *  plus the event facts the prompt/agent executors consume (command/http ignore
 *  them). The engine fills event/hasContext/stream/tools/modelOpts/agentId from
 *  its options (tools/modelOpts/agentId are LIVE getters, read per dispatch). */
export type HookExecutor = (
  hook: HookConfig,
  input: Record<string, unknown>,
  ctx: HookExecContext & {
    event: HookEvent
    hasContext: boolean
    stream?: LoopDeps['stream']
    tools?: ToolDef[]
    modelOpts?: HookModelOptions
    agentId?: string
  },
) => Promise<HookExecResult>

export interface HookEngineOptions {
  /** Ordered hook-config sources (CLI precedence flag → settings → plugin →
   *  agent). Re-invoked on EVERY dispatch so live config changes apply. */
  sources: () => readonly HookSource[]
  /** Activity sink — the session wires this to the neutral hook/run frame. */
  emit: (e: HookRuntimeEvent) => void
  /** Per-type executors. `command` defaults to the real command runner; the
   *  other types arrive with their executor tasks. A type with no executor is a
   *  non-blocking start failure, not a crash. */
  executors: Partial<Record<HookType, HookExecutor>>
  cwd: string
  sessionId: string
  stream?: LoopDeps['stream']
  /** LIVE session-tool snapshot getter, read per dispatch — a mid-session
   *  MCP/persona change must reach the agent evaluator, not a spawn-frozen
   *  list. */
  tools?: () => ToolDef[]
  /** LIVE model-resolution facts for the prompt/agent executors (T12): the
   *  config small-fast value, the session's current main model and the
   *  transport gateway fact. Read per dispatch so a live model switch moves
   *  the gateway fallback. */
  modelOpts?: () => HookModelOptions
  /** The running context's agent id (RS §12.2 recursion guard): a
   *  `hook-agent-` prefix cancels prompt/agent rounds. Absent on the main
   *  thread; a subagent dispatch seam supplies its own id. */
  agentId?: () => string | undefined
}

/** The default command executor: the real runner (T4). The command slot is only
 *  invoked for command hooks, so the narrowing cast is sound by construction. */
const commandExecutor: HookExecutor = (hook, input, ctx) =>
  runCommandHook(hook as CommandHookConfig, input, ctx)

/** RS §3 exit-2 stderr audience: the tool events + Stop/SubagentStop feed the
 *  block message to the model; every other event surfaces it to the user only.
 *  Whether exit-2 actually BLOCKS a given event (SessionStart/PostCompact/
 *  PermissionRequest/PermissionDenied/StopFailure do not) is the seam's call.
 *  TaskCreated/TaskCompleted/TeammateIdle also feed stderr to the model in the
 *  CLI, but they are layer-2 (no native trigger seam, never dispatched here —
 *  RS §9.3), so their omission from this set is deliberate, not an oversight. */
const MODEL_TARGET_EVENTS = new Set<HookEvent>([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'SubagentStop',
])

/** Events that carry hookSpecificOutput.additionalContext (RS §3). Accumulated
 *  across hooks; a payload for any other event is not a context channel. */
const ADDITIONAL_CONTEXT_EVENTS = new Set<HookEvent>([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'UserPromptSubmit',
  'SessionStart',
  'Stop',
  'SubagentStart',
  'SubagentStop',
])

function blockTarget(event: HookEvent): 'model' | 'user' {
  return MODEL_TARGET_EVENTS.has(event) ? 'model' : 'user'
}

/** A hook's display name: its defining field (command / url / prompt). */
function hookName(hook: HookConfig): string {
  switch (hook.type) {
    case 'command':
      return hook.command
    case 'http':
      return hook.url
    case 'prompt':
    case 'agent':
      return hook.prompt
  }
}

/** Execution outcome → terminal run status. A blocked hook (exit 2 / onFailure
 *  rewrite) is a blocking ERROR; an exit-0 decision:'block' ran successfully and
 *  stays 'success' (the block is a decision, not an execution failure). */
function runStatus(outcome: HookExecResult['outcome']): HookRunStatus {
  switch (outcome) {
    case 'success':
      return 'success'
    case 'blocked':
    case 'error':
      return 'error'
    case 'cancelled':
      return 'cancelled'
  }
}

/** Is this result a blocking fact? Exit-2 / onFailure rewrite ('blocked') OR a
 *  parsed decision:'block' (the CLI folds `blocked = exit2 || decision==='block'`
 *  regardless of exit code — T3). Reading only `outcome` would un-block an
 *  exit-0 JSON block; reading only `decision` would miss a bare exit-2. */
function isBlocking(result: HookExecResult): boolean {
  return result.outcome === 'blocked' || result.decision?.decision === 'block'
}

/** The effective block message: for a 'blocked' result parseHookOutput already
 *  projected the JSON reason over stderr; for a folded decision:'block' the
 *  reason is the JSON reason, falling back to raw stderr. */
function blockMessage(result: HookExecResult): string {
  if (result.outcome === 'blocked') return result.stderr
  return result.decision?.reason ?? result.stderr
}

/** Primary-action precedence for the cross-hook merge (block dominates). */
const ACTION_RANK: Record<HookDecision['action'], number> = {
  block: 5,
  deny: 4,
  allow: 3,
  ask: 2,
  defer: 1,
  continue: 0,
}

/** The hookSpecificOutput is honored only when its hookEventName matches the
 *  dispatch event — the CLI's discriminated-union schema rejects a mismatched
 *  payload, so a PostToolUse-shaped hso must not leak through a PreToolUse
 *  dispatch. A mismatch drops the hso facts but NOT a valid top-level decision.
 *  This validation lives in the engine: it is the only place holding both the
 *  event and the raw hso. */
function validHso(result: HookExecResult, event: HookEvent): Record<string, unknown> | undefined {
  const hso = result.decision?.hookSpecificOutput
  if (!hso) return undefined
  if (hso.hookEventName !== event) {
    log.debug(`hook hookSpecificOutput.hookEventName ${JSON.stringify(hso.hookEventName)} != event ${JSON.stringify(event)}; payload rejected`)
    return undefined
  }
  return hso
}

interface ActionCandidate {
  action: HookDecision['action']
  block?: { reason: string; target: 'model' | 'user' }
  permission?: NonNullable<HookDecision['permission']>
}

/** One result's dominant primary action. Block overrides any allow/approve
 *  (RS §2.3, T3 note). Per-event applicability: permissionDecision is read only
 *  on PreToolUse, the PermissionRequest decision object only on PermissionRequest.
 *  `hso` is the already-event-validated hookSpecificOutput (or undefined). */
function actionCandidateOf(
  result: HookExecResult,
  hso: Record<string, unknown> | undefined,
  event: HookEvent,
): ActionCandidate | null {
  if (isBlocking(result)) {
    return { action: 'block', block: { reason: blockMessage(result), target: blockTarget(event) } }
  }
  const permDecision = event === 'PreToolUse' && typeof hso?.permissionDecision === 'string' ? hso.permissionDecision : undefined
  const permReason = event === 'PreToolUse' && typeof hso?.permissionDecisionReason === 'string' ? hso.permissionDecisionReason : undefined
  const prDecision = event === 'PermissionRequest' && isPlainObject(hso?.decision) ? hso.decision : undefined
  const prBehavior = typeof prDecision?.behavior === 'string' ? prDecision.behavior : undefined

  if (permDecision === 'deny' || prBehavior === 'deny') {
    const message = permReason ?? (typeof prDecision?.message === 'string' ? prDecision.message : undefined) ?? 'denied by hook'
    const interrupt = prDecision?.interrupt === true
    return { action: 'deny', permission: { behavior: 'deny', message, ...(interrupt ? { interrupt: true } : {}) } }
  }

  if (permDecision === 'allow' || prBehavior === 'allow' || result.decision?.decision === 'approve') {
    const updatedInput = isPlainObject(hso?.updatedInput)
      ? hso.updatedInput
      : isPlainObject(prDecision?.updatedInput)
        ? prDecision.updatedInput
        : undefined
    const updatedPermissions = Array.isArray(prDecision?.updatedPermissions) ? prDecision.updatedPermissions : undefined
    const permission: NonNullable<HookDecision['permission']> = { behavior: 'allow' }
    if (updatedInput) permission.updatedInput = updatedInput
    if (permReason) permission.reason = permReason
    if (updatedPermissions) permission.updatedPermissions = updatedPermissions
    return { action: 'allow', permission }
  }

  if (permDecision === 'ask') {
    return { action: 'ask', permission: { behavior: 'ask', ...(permReason ? { reason: permReason } : {}) } }
  }
  if (permDecision === 'defer') {
    return { action: 'defer', permission: { behavior: 'defer' } }
  }
  return null
}

/** Per-event hso side fields (RS §3). additionalContext and the PostToolUse
 *  rewrites are folded in mergeDecisions (they accumulate / need cross-hook
 *  state); these are the remaining single-value per-event facts. */
function foldEventFields(merged: HookDecision, hso: Record<string, unknown>, event: HookEvent): void {
  switch (event) {
    case 'UserPromptSubmit':
      if (typeof hso.sessionTitle === 'string') merged.sessionTitle = hso.sessionTitle
      if (hso.suppressOriginalPrompt === true) merged.suppressOriginalPrompt = true
      break
    case 'SessionStart':
      if (typeof hso.sessionTitle === 'string') merged.sessionTitle = hso.sessionTitle
      if (typeof hso.initialUserMessage === 'string') merged.initialUserMessage = hso.initialUserMessage
      if (isStringArray(hso.watchPaths)) merged.watchPaths = hso.watchPaths
      if (hso.reloadSkills === true) merged.reloadSkills = true
      break
    case 'PermissionDenied':
      if (hso.retry === true) merged.retry = true
      break
    default:
      break
  }
}

/** Merge results in COLLECTION order (deterministic regardless of completion
 *  order). The highest-rank primary action wins (first-in-order breaks ties);
 *  ALL side facts are carried — additionalContext always accumulates, rewrites
 *  are last-write-wins, and the per-event scalar fields are folded. The seams
 *  apply the per-event ACTION semantics to the returned multi-fact decision. */
function mergeDecisions(event: HookEvent, results: readonly HookExecResult[]): HookDecision {
  const merged: HookDecision = { action: 'continue', additionalContext: [] }
  let actionRank = 0
  // Whether merged.classifierContext is tied to the current last rewrite: a
  // tied assertion is dropped when a later hook's rewrite supersedes it; an
  // assertion returned without a rewrite survives (SDK PostToolUse contract).
  let classifierTied = false
  for (const result of results) {
    const decision = result.decision
    // Top-level scalar fields (event-agnostic). `continue` is STICKY-false:
    // once ANY hook sets continue:false a later continue:true cannot resurrect
    // continuation — the CLI accumulates a per-result preventContinuation flag
    // and short-circuits on any false (binary-verified `N`; the Stop seam ends
    // the turn on it). `stopReason` accompanies continue:false: only a stopping
    // hook's reason is carried (CLI command-result builder `v5` reads stopReason
    // solely inside its `continue===false` branch), last-write-wins among the
    // stopping hooks. The remaining scalars stay last-write-wins in collection
    // order.
    if (decision?.continue !== undefined) {
      if (decision.continue === false || merged.continue !== false) merged.continue = decision.continue
    }
    if (decision?.continue === false && decision.stopReason !== undefined) merged.stopReason = decision.stopReason
    if (decision?.suppressOutput !== undefined) merged.suppressOutput = decision.suppressOutput
    if (decision?.systemMessage !== undefined) merged.systemMessage = decision.systemMessage

    const hso = validHso(result, event)
    if (hso) {
      if (typeof hso.additionalContext === 'string' && ADDITIONAL_CONTEXT_EVENTS.has(event)) {
        merged.additionalContext.push(hso.additionalContext)
      }
      foldEventFields(merged, hso, event)
      if (event === 'PostToolUse') {
        const hasRewrite = typeof hso.updatedToolOutput === 'string' || typeof hso.updatedMCPToolOutput === 'string'
        if (hasRewrite) {
          if (classifierTied) {
            delete merged.classifierContext
            classifierTied = false
          }
          if (typeof hso.updatedToolOutput === 'string') merged.updatedToolOutput = hso.updatedToolOutput
          if (typeof hso.updatedMCPToolOutput === 'string') merged.updatedMCPToolOutput = hso.updatedMCPToolOutput
        }
        if (typeof hso.classifierContext === 'string') {
          merged.classifierContext = hso.classifierContext
          classifierTied = hasRewrite
        }
      }
    }

    const candidate = actionCandidateOf(result, hso, event)
    if (candidate && ACTION_RANK[candidate.action] > actionRank) {
      actionRank = ACTION_RANK[candidate.action]
      merged.action = candidate.action
      if (candidate.action === 'block') {
        merged.block = candidate.block
        delete merged.permission
      } else {
        merged.permission = candidate.permission
        delete merged.block
      }
    }

    // Exit-0 plain stdout (no parsed decision) feeds compact instructions on
    // PreCompact (RS §13.3) and model context on UserPromptSubmit/SessionStart
    // (RS §2.2).
    if (result.outcome === 'success' && !decision && result.stdout.trim()) {
      if (event === 'PreCompact') {
        merged.customInstructions = merged.customInstructions ? `${merged.customInstructions}\n${result.stdout}` : result.stdout
      } else if (event === 'UserPromptSubmit' || event === 'SessionStart') {
        merged.additionalContext.push(result.stdout)
      }
    }
  }
  return merged
}

export class HookEngine {
  private readonly executors: Partial<Record<HookType, HookExecutor>>

  constructor(private readonly opts: HookEngineOptions) {
    this.executors = { command: commandExecutor, ...opts.executors }
  }

  async dispatch(
    event: HookEvent,
    input: Record<string, unknown>,
    ctx: { signal: AbortSignal; hasContext: boolean },
  ): Promise<HookDecision> {
    // Fresh per-event collection (RS §12.3) — never a cached snapshot.
    const groups = collectForEvent(this.opts.sources(), event)
    const target = matcherTarget(event, input)
    const matched: HookConfig[] = []
    for (const group of groups) {
      // matches(m, undefined)===true encodes "no-target event ignores matcher".
      if (matches(group.matcher, target)) matched.push(...group.hooks)
    }
    if (matched.length === 0) return { action: 'continue', additionalContext: [] }

    const results: HookExecResult[] = new Array(matched.length)
    const parallel: number[] = []
    const serial: number[] = []
    matched.forEach((hook, index) => {
      if (hook.type === 'prompt' || hook.type === 'agent') serial.push(index)
      else parallel.push(index)
    })
    const runOne = async (index: number): Promise<void> => {
      results[index] = await this.runHook(matched[index], input, ctx, event)
    }
    // The two lanes run concurrently; each keeps its own discipline (RS §4.9).
    await Promise.all([this.runParallel(parallel, runOne), this.runSerial(serial, runOne)])
    return mergeDecisions(event, results)
  }

  /** command/http lane: at most PARALLEL_CAP hooks in flight; the rest queue. */
  private async runParallel(indices: readonly number[], runOne: (index: number) => Promise<void>): Promise<void> {
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < indices.length) {
        const index = indices[next++]
        await runOne(index)
      }
    }
    const workers = Array.from({ length: Math.min(PARALLEL_CAP, indices.length) }, () => worker())
    await Promise.all(workers)
  }

  /** prompt/agent lane: one at a time, in collection order. */
  private async runSerial(indices: readonly number[], runOne: (index: number) => Promise<void>): Promise<void> {
    for (const index of indices) await runOne(index)
  }

  /** Run one hook: emit started, execute (onFailure applied), emit completed. */
  private async runHook(
    hook: HookConfig,
    input: Record<string, unknown>,
    ctx: { signal: AbortSignal; hasContext: boolean },
    event: HookEvent,
  ): Promise<HookExecResult> {
    const hookId = randomUUID()
    const name = hookName(hook)
    const startedAt = Date.now()
    // The pump derives both id and hookId from hook_id, so they must be equal.
    this.opts.emit({
      kind: 'started',
      run: { id: hookId, hookId, hookName: name, event, status: 'started', startedAt, updatedAt: startedAt },
    })

    const execCtx: HookExecContext & {
      event: HookEvent
      hasContext: boolean
      stream?: LoopDeps['stream']
      tools?: ToolDef[]
      modelOpts?: HookModelOptions
      agentId?: string
    } = {
      cwd: this.opts.cwd,
      sessionId: this.opts.sessionId,
      signal: ctx.signal,
      event,
      hasContext: ctx.hasContext,
      ...(this.opts.stream !== undefined ? { stream: this.opts.stream } : {}),
      ...(this.opts.tools !== undefined ? { tools: this.opts.tools() } : {}),
      ...(this.opts.modelOpts !== undefined ? { modelOpts: this.opts.modelOpts() } : {}),
      ...(this.opts.agentId !== undefined ? { agentId: this.opts.agentId() } : {}),
    }
    const executor = this.executors[hook.type]
    let result: HookExecResult
    if (executor) {
      result = await executor(hook, input, execCtx)
    } else {
      // A type with no executor is a start failure (RS §2.4), reported not crashed.
      // The failure surfaces through the result + activity record; this is a trace.
      log.debug(`no executor registered for hook type "${hook.type}"`)
      result = { outcome: 'error', stdout: '', stderr: `no executor registered for hook type "${hook.type}"` }
    }
    // Idempotent for executors that already applied it (command runner does).
    result = applyOnFailure(hook, result)

    const run: HookRunRecord = {
      id: hookId,
      hookId,
      hookName: name,
      event,
      status: runStatus(result.outcome),
      startedAt,
      updatedAt: Date.now(),
    }
    if (result.stdout) run.stdout = result.stdout
    if (result.stderr) run.stderr = result.stderr
    if (result.exitCode !== undefined) run.exitCode = result.exitCode
    // Surface the effective message so a failure/degrade is not opaque in the
    // activity record (the precise invalid-JSON degrade reason lives in the
    // output contract's log; the raw output is carried here).
    const output = result.outcome === 'success' ? result.stdout : result.stderr || result.stdout
    if (output) run.output = output
    this.opts.emit({ kind: 'completed', run })
    return result
  }
}
