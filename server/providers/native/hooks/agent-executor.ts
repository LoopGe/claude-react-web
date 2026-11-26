// server/providers/native/hooks/agent-executor.ts
// Runs a `type:'agent'` hook: an agentic verification loop (RS §6.2). The
// evaluator model gets the filtered session tools plus a StructuredOutput
// verdict tool it MUST call exactly once at the end; the verdict {ok, reason?}
// is retrieved from that tool call (the CLI's structured_output attachment is
// the same fact — `xee().safeParse` on the tool input), ok:false blocks. The
// system text, the verdict-tool schema/description, the 50-round cap and the
// block wording below are binary-extracted from the pinned CLI (2.1.311), not
// paraphrased. Reuses the core turn engine (runTurn, the nested-runner pattern
// of subagent.ts) rather than a second loop.
//
// Seam contract (the registration/wiring task owns the producers):
//   • ctx.stream is the core stream transport (LoopDeps['stream']); every round
//     is sent with the per-request `thinking:{type:'disabled'}` override, which
//     the production supplier projects over the session thinking config. The
//     verdict rides the TOOL call, so no outputFormat is sent (RS §6.2).
//   • ctx.tools is the LIVE session tool snapshot. Delegation tools (Agent/
//     Task) are filtered out — the evaluator must not spawn subagents — and a
//     session tool named StructuredOutput is dropped before the verdict tool
//     is appended (the CLI `PTr` filter reserves the name the same way).
//   • ctx.modelOpts is the config/profile model-resolution input (T12); the
//     agent gateway fallback to the session model fires only when no small-fast
//     value is configured (RS §6.2 `dc(y)`). Absent → DEFAULT_SMALL_FAST_MODEL.
//   • ctx.agentId is the running context's agent id; a `hook-agent-` prefix is
//     the hook evaluator's own subagent and cancels the round (RS §12.2). The
//     evaluator's own nested run carries NO dispatchHook, so recursion is also
//     structurally impossible inside it.
//   • ctx.transcriptPath is the T22 seam: the CLI-shaped projected transcript
//     artifact the evaluator may Read. Until that projection lands the system
//     text uses the CLI's no-transcript clause; the session-level
//     `Read(/<transcript>)` allow rule rides the same seam.
//   • The evaluator's frames and tool results are deliberately NOT persisted
//     or emitted: the CLI consumes its hook-agent query with no-op message
//     handlers (`a_t(pn,{onMessage:()=>{},…})`), so nothing enters the
//     transcript. Its read-state/PDF allocations are isolated under a
//     `hook-agent-<uuid>` history key (the CLI copies readFileState with
//     stripSeededFromContext), never the main thread's.
import { randomUUID } from 'node:crypto'
import { createLogger } from '../../../log.js'
import type { AgentHookConfig } from '../../../../shared/hooks.js'
import { runTurn, type LoopDeps } from '../loop.js'
import type { ToolDef } from '../tools/types.js'
import type { NativeTaskManager } from '../task-manager.js'
import type { NativeProjectionOptions } from '../attachment-projection.js'
import type { FrameContext } from '../vocabulary/frame-context.js'
import type { HookExecContext } from './command-executor.js'
import type { HookEvent } from './types.js'
import type { HookExecResult, SyncHookDecision } from './output.js'
import { checkAvailability } from './availability.js'
import { resolveHookModel, DEFAULT_SMALL_FAST_MODEL, type HookModelOptions } from './model.js'
import {
  ANTI_INJECTION,
  HOOK_AGENT_PREFIX,
  MAX_TIMEOUT_MS,
  fillArguments,
  validateVerdict,
  type Verdict,
} from './prompt-executor.js'

const log = createLogger('native-hooks')

/** RS §4.5: the agent-hook default timeout (60s; prompt is 30s). */
const DEFAULT_TIMEOUT_MS = 60_000

/** RS §6.2: the agentic round cap (CLI `mo=50`; exceeding it aborts). */
const MAX_ROUNDS = 50

/** The CLI `Qa` verdict tool name (`sTn()`). */
const VERDICT_TOOL_NAME = 'StructuredOutput'

/** The CLI `sTn()` prompt — the tool's model-facing description. */
const VERDICT_TOOL_DESCRIPTION =
  'Use this tool to return your verification result. You MUST call this tool exactly once at the end of your response.'

/** The CLI `sTn()` inputJSONSchema (reason optional, ok required). */
const VERDICT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: 'Whether the condition was met' },
    reason: { type: 'string', description: 'Reason, if the condition was not met' },
  },
  required: ['ok'],
  additionalProperties: false,
}

/** The execution context an agent hook receives: the prompt-hook facts plus
 *  the live session tools and the nested-runner deps the session wiring
 *  supplies (task manager, attachment projection, frame context). See the
 *  header for the producers the wiring owns. */
export interface AgentHookExecContext extends HookExecContext {
  event: HookEvent
  hasContext: boolean
  stream: LoopDeps['stream']
  tools: ToolDef[]
  modelOpts?: HookModelOptions
  agentId?: string
  tasks: NativeTaskManager
  attachmentProjection: NativeProjectionOptions
  frameCtx: FrameContext
  /** T22 seam: the projected CLI-shaped transcript path (absent until the
   *  transcript projection lands — the system text then uses the CLI's
   *  no-transcript clause). */
  transcriptPath?: string
}

/** The CLI `pZe` system text: the event-specific head (`ft`), the transcript
 *  clause, the tool-use instructions and the shared `Ree` anti-injection
 *  clause. Binary-extracted verbatim. */
function agentSystem(event: HookEvent, transcriptPath?: string): string {
  const head = event === 'Stop' || event === 'SubagentStop'
    ? 'You are verifying a stop condition in Claude Code. Your task is to verify that the agent completed the given plan.'
    : `You are evaluating a ${event} hook in Claude Code. Your task is to evaluate the condition described in the user message.`
  const transcript = transcriptPath !== undefined
    ? `The conversation transcript is available at: ${transcriptPath}\nYou can read this file to analyze the conversation history if needed.`
    : 'There is no conversation transcript file to read here.'
  return `${head} ${transcript}\n`
    + 'Use the available tools to inspect the codebase and verify the condition.\n'
    + 'Use as few steps as possible - be efficient and direct.\n'
    + `When done, return your result using the ${VERDICT_TOOL_NAME} tool, always with a reason.\n`
    + ANTI_INJECTION
}

/** Verdict → HookExecResult (RS §6.2 "ok:false → block, same as prompt").
 *  ok:true succeeds with EMPTY stdout — the CLI's hook_success content is '',
 *  so a successful verdict never injects context on UserPromptSubmit/
 *  SessionStart. ok:false blocks with the CLI `Agent hook condition was not
 *  met: <reason>` wording; on non-Stop events the block carries the same
 *  preventContinuation fact as the prompt verdict (continue:false +
 *  stopReason; the engine merge is sticky-false). Unlike the prompt variant
 *  there is NO impossible-success path — the binary's agent tail blocks on
 *  every ok:false. */
function verdictResult(verdict: Verdict, isStop: boolean): HookExecResult {
  if (verdict.ok) {
    log.debug(`agent hook condition met: ${verdict.reason ?? ''}`)
    return { outcome: 'success', stdout: '', stderr: '' }
  }
  const reason = verdict.reason ?? ''
  log.debug(`agent hook condition not met: ${reason}`)
  const decision: SyncHookDecision = { decision: 'block', reason }
  if (!isStop) {
    decision.continue = false
    decision.stopReason = reason
  }
  return { outcome: 'blocked', stdout: '', stderr: `Agent hook condition was not met: ${reason}`, decision }
}

/** Run one agent hook. Never throws: availability failures, API errors and
 *  missing verdicts are non-blocking results (prompt/agent do not honor
 *  onFailure:'block', RS §2.4); timeouts/aborts/recursion are cancelled. */
export async function runAgentHook(
  hook: AgentHookConfig,
  input: Record<string, unknown>,
  ctx: AgentHookExecContext,
): Promise<HookExecResult> {
  const availability = checkAvailability('agent', ctx.event, ctx.hasContext)
  if (!availability.ok) {
    return { outcome: 'error', stdout: '', stderr: availability.reason }
  }
  // RS §12.2 recursion guard: the hook evaluator's own subagent never runs
  // prompt/agent hooks (CLI `w.agentId?.startsWith(fPt)` → cancelled).
  if (ctx.agentId?.startsWith(HOOK_AGENT_PREFIX) === true) {
    return { outcome: 'cancelled', stdout: '', stderr: 'hook cancelled: agent hooks do not run inside the hook evaluator subagent (recursion guard)' }
  }
  if (ctx.signal.aborted) {
    return { outcome: 'cancelled', stdout: '', stderr: 'hook aborted' }
  }

  const isStop = ctx.event === 'Stop' || ctx.event === 'SubagentStop'
  const model = hook.model ?? (ctx.modelOpts ? resolveHookModel(ctx.modelOpts) : DEFAULT_SMALL_FAST_MODEL)
  const timeoutMs = hook.timeout ? Math.min(hook.timeout * 1000, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const onParentAbort = () => controller.abort()
  ctx.signal.addEventListener('abort', onParentAbort, { once: true })

  // The evaluator's own subagent identity (CLI `Tr(fPt + _Tn())`). It doubles
  // as the history key isolating the evaluator's read-state observations and
  // PDF reservations from the main thread's.
  const hookAgentId = `${HOOK_AGENT_PREFIX}${randomUUID()}`
  const evaluatorCtx: FrameContext = { ...ctx.frameCtx, parentToolUseId: hookAgentId }

  // The verdict is captured from the tool call (the CLI's structured_output
  // attachment is the same fact). An input failing the xee subset is a tool
  // ERROR, not a settlement — the model sees it and may retry, exactly as the
  // CLI's safeParse failure leaves the query running.
  let verdict: Verdict | null = null
  const verdictTool: ToolDef = {
    name: VERDICT_TOOL_NAME,
    description: VERDICT_TOOL_DESCRIPTION,
    guidance: '',
    promptOrder: 0,
    schema: VERDICT_SCHEMA,
    async run(raw) {
      const validated = validateVerdict(raw)
      if (!validated.ok) return { text: `invalid verdict: ${validated.error}`, isError: true }
      verdict = validated.verdict
      return { text: 'verdict recorded' }
    },
  }
  const tools = [
    ...ctx.tools.filter((t) => t.name !== 'Agent' && t.name !== 'Task' && t.name !== VERDICT_TOOL_NAME),
    verdictTool,
  ]

  // The agent user message is the GWe-interpolated prompt ALONE — no Stop
  // transcript-evidence wrapping (that is the prompt executor's `iTn` shape).
  const userText = fillArguments(hook.prompt, JSON.stringify(input))

  try {
    const turn = await runTurn(
      {
        stream: (req) => {
          // The CLI aborts the query the moment structured output arrives; the
          // native equivalent short-circuits the NEXT round to an empty stream
          // so runTurn settles cleanly (no tool calls → turn end) instead of
          // throwing through an aborted fetch.
          if (verdict !== null) return (async function* () {})()
          return ctx.stream({ ...req, thinking: { type: 'disabled' } })
        },
        tools,
        maxTurns: MAX_ROUNDS,
        tasks: ctx.tasks,
        cwd: ctx.cwd,
        // dontAsk (RS §6.2): the evaluator runs the session tools without a
        // permission prompt. The transcript Read allow-rule rides T22.
        requestPermission: async (_toolName, toolInput) => ({ allowed: true, input: toolInput }),
        // The CLI records nothing from the evaluator into the transcript.
        emit: () => {},
        persistToolResult: () => {},
        attachmentProjection: ctx.attachmentProjection,
        system: agentSystem(ctx.event, ctx.transcriptPath),
        emitResult: false,
      },
      evaluatorCtx,
      [],
      { role: 'user', content: [{ type: 'text', text: userText }] },
      model,
      controller.signal,
    )
    // A stream/loop that settles cleanly on abort (rather than throwing) is
    // still a cancellation, not a missing verdict.
    if (timedOut) {
      log.debug(`agent hook (${ctx.event}) timed out after ${timeoutMs}ms`)
      return { outcome: 'cancelled', stdout: '', stderr: `hook timed out after ${timeoutMs}ms` }
    }
    if (ctx.signal.aborted) {
      return { outcome: 'cancelled', stdout: '', stderr: 'hook aborted' }
    }
    if (verdict === null) {
      // runTurn's only isError source is the maxTurns cap (the 50th round's
      // calls get synthetic error results) — the CLI's `go` max-turns abort.
      if (turn.isError) {
        log.debug(`agent hook did not complete within ${MAX_ROUNDS} turns`)
        return { outcome: 'cancelled', stdout: '', stderr: `Agent hook did not complete within ${MAX_ROUNDS} turns` }
      }
      log.debug('agent hook did not return structured output')
      return { outcome: 'cancelled', stdout: '', stderr: 'Agent hook did not return structured output' }
    }
    return verdictResult(verdict, isStop)
  } catch (err) {
    if (timedOut) {
      log.debug(`agent hook (${ctx.event}) timed out after ${timeoutMs}ms`)
      return { outcome: 'cancelled', stdout: '', stderr: `hook timed out after ${timeoutMs}ms` }
    }
    if (ctx.signal.aborted) {
      return { outcome: 'cancelled', stdout: '', stderr: 'hook aborted' }
    }
    const message = err instanceof Error ? err.message : String(err)
    log.debug(`agent hook evaluator error: ${message}`)
    return { outcome: 'error', stdout: '', stderr: `Error executing agent hook: ${message}` }
  } finally {
    clearTimeout(timer)
    ctx.signal.removeEventListener('abort', onParentAbort)
    // Release the evaluator's PDF reservations (the nested-runner pattern);
    // its history key never collides with the main thread's.
    ctx.attachmentProjection.preparedPdfs?.clearHistory(hookAgentId)
  }
}
