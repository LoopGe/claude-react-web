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
import { isPlainObject } from '../../../../shared/type-guards.js'
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
import type { HookDecision, HookSource } from './types.js'

const log = createLogger('native-hooks')

/** RS §4.9: the mixed command/http runner concurrency cap (`_Ze=12`). */
const PARALLEL_CAP = 12

/** The execution context an executor receives: the base command-exec context
 *  plus the event facts the prompt/agent executors consume (command/http ignore
 *  them). The engine fills event/hasContext/stream/tools. */
export type HookExecutor = (
  hook: HookConfig,
  input: Record<string, unknown>,
  ctx: HookExecContext & {
    event: HookEvent
    hasContext: boolean
    stream?: LoopDeps['stream']
    tools?: ToolDef[]
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
  tools?: ToolDef[]
}

/** The default command executor: the real runner (T4). The command slot is only
 *  invoked for command hooks, so the narrowing cast is sound by construction. */
const commandExecutor: HookExecutor = (hook, input, ctx) =>
  runCommandHook(hook as CommandHookConfig, input, ctx)

/** RS §3 exit-2 stderr audience: the tool events + Stop/SubagentStop feed the
 *  block message to the model; every other event surfaces it to the user only.
 *  Whether exit-2 actually BLOCKS a given event (SessionStart/PostCompact/
 *  PermissionRequest/PermissionDenied/StopFailure do not) is the seam's call. */
const MODEL_TARGET_EVENTS = new Set<HookEvent>([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'SubagentStop',
])

/** Events whose exit-0 plain stdout feeds model context / compact instructions
 *  (RS §2.2 / §3 / §13.3). The seam interprets the resulting context per event. */
const CONTEXT_STDOUT_EVENTS = new Set<HookEvent>(['UserPromptSubmit', 'SessionStart', 'PreCompact'])

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

interface Candidate {
  decision: HookDecision
  rank: number
}

/** Extract one result's dominant decision fact. Precedence ranks:
 *  block(4) > deny(3) > allow(2) > context(1) > continue(0). Block overrides any
 *  allow/approve (RS §2.3, T3 note). hookSpecificOutput is read loosely here —
 *  per-event validation (hookEventName match, event applicability) is the seam's. */
function candidateOf(result: HookExecResult, event: HookEvent): Candidate | null {
  if (isBlocking(result)) {
    return { decision: { behavior: 'block', reason: blockMessage(result), target: blockTarget(event) }, rank: 4 }
  }
  const hso = result.decision?.hookSpecificOutput
  const permDecision = typeof hso?.permissionDecision === 'string' ? hso.permissionDecision : undefined
  // PermissionRequest carries a `{behavior:allow|deny,…}` decision object.
  const prDecision = isPlainObject(hso?.decision) ? hso.decision : undefined
  const prBehavior = typeof prDecision?.behavior === 'string' ? prDecision.behavior : undefined

  if (permDecision === 'deny' || prBehavior === 'deny') {
    const message =
      (typeof hso?.permissionDecisionReason === 'string' ? hso.permissionDecisionReason : undefined) ??
      (typeof prDecision?.message === 'string' ? prDecision.message : undefined) ??
      'denied by hook'
    const interrupt = prDecision?.interrupt === true
    return { decision: interrupt ? { behavior: 'deny', message, interrupt: true } : { behavior: 'deny', message }, rank: 3 }
  }

  if (permDecision === 'allow' || prBehavior === 'allow' || result.decision?.decision === 'approve') {
    const updatedInput = isPlainObject(hso?.updatedInput)
      ? hso.updatedInput
      : isPlainObject(prDecision?.updatedInput)
        ? prDecision.updatedInput
        : undefined
    return { decision: updatedInput ? { behavior: 'allow', updatedInput } : { behavior: 'allow' }, rank: 2 }
  }

  const additionalContext = typeof hso?.additionalContext === 'string' ? hso.additionalContext : undefined
  if (additionalContext) {
    return { decision: { behavior: 'context', text: additionalContext }, rank: 1 }
  }
  // Exit-0 plain stdout (no parsed decision) feeds context on the context events.
  if (CONTEXT_STDOUT_EVENTS.has(event) && result.outcome === 'success' && !result.decision && result.stdout.trim()) {
    return { decision: { behavior: 'context', text: result.stdout }, rank: 1 }
  }
  return null
}

/** Merge results in COLLECTION order (deterministic regardless of completion
 *  order); the highest-rank fact wins, first-in-order breaks ties. A single
 *  HookDecision variant is returned — collecting side facts (additionalContext
 *  alongside an allow/block, rewrites, continue:false) needs a richer seam
 *  contract and is deferred to the dispatch seams. */
function mergeDecisions(event: HookEvent, results: readonly HookExecResult[]): HookDecision {
  let best: HookDecision = { behavior: 'continue' }
  let bestRank = 0
  for (const result of results) {
    const candidate = candidateOf(result, event)
    if (candidate && candidate.rank > bestRank) {
      best = candidate.decision
      bestRank = candidate.rank
    }
  }
  return best
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
    if (matched.length === 0) return { behavior: 'continue' }

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

    const execCtx: HookExecContext & { event: HookEvent; hasContext: boolean; stream?: LoopDeps['stream']; tools?: ToolDef[] } = {
      cwd: this.opts.cwd,
      sessionId: this.opts.sessionId,
      signal: ctx.signal,
      event,
      hasContext: ctx.hasContext,
      ...(this.opts.stream !== undefined ? { stream: this.opts.stream } : {}),
      ...(this.opts.tools !== undefined ? { tools: this.opts.tools } : {}),
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
