// server/providers/native/structured-run.ts
//
// The one-shot app-level structured run: a TRANSIENT runTurn context with the
// terminal StructuredOutput runtime attached — no NativeSession, no durable
// log, no live subscribers. The model history lives in a throwaway array and
// tool results are never persisted. This is the native backend of the
// AgentProvider.runStructured seam (the claude provider spawns a headless SDK
// query instead); the subagent entry attaches the same runtime in subagent.ts.
//
// Headless permission policy: there is no approval surface, so anything that
// would reach a human prompt is denied immediately — the equivalent of the
// claude one-shot's `permissionPrompts: 'none'`. The mode-specific auto-allow
// paths still apply, mirroring the broker's gates:
//   • bypassPermissions — allow everything (the explicit opt-in, like the
//     claude one-shot's allowDangerouslySkipPermissions).
//   • acceptEdits — in-cwd edits and safe edit Bash auto-allow (the broker's
//     acceptEdits paths, with the sensitive-path opt-in left at its
//     fail-closed default: a headless run reads no host config).
//   • default / dontAsk / auto — only provably read-only calls flow: the
//     ToolDef.readOnlyHint evidence (the StructuredOutput capture carries it)
//     and read-only Bash. 'auto' has no headless classifier — the classifier
//     answerer is session-scoped — so it fails closed to the read-only set.
// The read-only Bash and edit-scope classifiers are the SAME pure helpers the
// broker uses, so the live and headless gates cannot drift.

import { randomUUID } from 'node:crypto'
import { HttpError } from '../../errors.js'
import { isReadOnlyBash } from '../../readonly-bash.js'
import { isAutoApprovableEditBash, isInScopeEditTool } from '../../accept-edits-bash.js'
import { coerceStructuredOutput, type StructuredRunRequest, type StructuredRunResult } from '../../../shared/structured.js'
import { runTurn, type LoopDeps } from './loop.js'
import type { RequestMessage } from './vocabulary/message.js'
import { defaultFrameContext } from './vocabulary/frame-context.js'
import { attachStructuredRuntime, STRUCTURED_OUTPUT_GUIDANCE } from './structured.js'
import type { ToolDef } from './tools/types.js'
import { bashTool } from './tools/bash.js'
import { createReadTool } from './tools/read.js'
import { writeTool } from './tools/write.js'
import { createEditTool } from './tools/edit.js'
import { grepTool } from './tools/grep.js'
import { globTool } from './tools/glob.js'
import { lsTool } from './tools/ls.js'
import { notebookEditTool } from './tools/notebook-edit.js'
import { NativeReadState } from './read-state.js'
import { NativeTaskManager } from './task-manager.js'
import { PromptSectionRegistry, IDENTITY_SECTION } from './prompt/sections.js'
import { streamAnthropicMessages } from './anthropic-stream.js'
import { DEFAULT_MAX_TOKENS } from './native-session.js'

/** Resolved facts the provider hands the one-shot runner: the working
 *  directory, the effective model, the profile credentials, and the test
 *  stream seam (provider._testStream) when set. */
export interface StructuredRunContext {
  cwd: string
  model: string
  credentials: { baseUrl: string; authToken: string }
  stream?: LoopDeps['stream']
}

function abortedResult(): StructuredRunResult {
  return { ok: false, errorSubtype: 'error_during_execution', errors: ['run aborted'] }
}

/** The headless auto-allow decision for one tool call: the broker's mode
 *  gates minus the prompt. Whatever would park for a human answer is denied
 *  here, because a one-shot run has no answerer. */
function headlessDecision(
  mode: string,
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  readOnlyHint: boolean,
): { allowed: boolean; message?: string } {
  if (mode === 'bypassPermissions') return { allowed: true }
  const command = (input as { command?: unknown }).command
  if (readOnlyHint || (toolName === 'Bash' && isReadOnlyBash(command))) {
    return { allowed: true }
  }
  if (mode === 'acceptEdits') {
    if (isInScopeEditTool(toolName, input, cwd) || (toolName === 'Bash' && isAutoApprovableEditBash(command, cwd))) {
      return { allowed: true }
    }
  }
  return {
    allowed: false,
    message: mode === 'dontAsk'
      ? 'dontAsk mode: auto-denied. Only read-only tools and read-only ' +
        'Bash commands run in this mode; switch modes to make changes.'
      : `headless structured run: ${toolName} is not auto-allowed in '${mode}' mode and there is no permission prompt surface`,
  }
}

/** Run one non-persisted structured turn to terminal and narrow the outcome.
 *  A valid capture wins over a later turn-cap error; max-turns exhaustion maps
 *  to error_max_turns; a plain-text finish (no capture) and execution errors
 *  map to error_during_execution. The external signal aborts the run. */
export async function runStructuredOnce(
  req: StructuredRunRequest,
  ctx: StructuredRunContext,
  signal?: AbortSignal,
): Promise<StructuredRunResult> {
  // Native has no USD cost model (no pricing table, no cost accumulation), so
  // a budget intent cannot be enforced. Accepting it would silently drop the
  // cap — reject loudly, the same rule createSession applies to sandbox.
  if (req.maxBudgetUsd !== undefined) {
    throw new HttpError(501, 'provider native does not enforce maxBudgetUsd for structured runs')
  }
  const controller = new AbortController()
  // External abort (client cancel / route timeout) tears the run down exactly
  // as a local abort would; the guard also covers an already-aborted signal.
  const onAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  const mode = req.permissionMode ?? 'default'
  try {
    if (controller.signal.aborted) return abortedResult()
    // An unsupported schema throws here (a caller/wiring error no corrected
    // arguments can satisfy); the catch narrows it into an execution error
    // naming the construct — it never reaches the model as a retry.
    const structured = attachStructuredRuntime(req.schema)
    const readState = new NativeReadState()
    // Lean builtin set: file/shell tools plus the terminal capture. No
    // delegation (Agent/Task need the session machinery), no MCP, no
    // AskUserQuestion (headless has no answerer), no network tools.
    const baseTools: ToolDef[] = [
      bashTool,
      createReadTool(readState),
      writeTool,
      createEditTool(readState),
      grepTool,
      globTool,
      lsTool,
      notebookEditTool,
    ]
    const tools = [...baseTools, structured.tool]
    const registry = new PromptSectionRegistry()
    registry.register(IDENTITY_SECTION)
    for (const tool of baseTools) {
      registry.register({ name: `tool:${tool.name}`, order: tool.promptOrder, text: tool.guidance })
    }
    // The finish demand reads LAST (the subagent attach's pattern): the
    // capture tool's own section is not registered — the guidance is
    // appended once, after every other section.
    const system = `${registry.render()}\n\n${STRUCTURED_OUTPUT_GUIDANCE}`
    const history: RequestMessage[] = []
    const stream: LoopDeps['stream'] = ctx.stream ?? ((r) =>
      streamAnthropicMessages(
        {
          baseUrl: ctx.credentials.baseUrl,
          authToken: ctx.credentials.authToken,
          model: r.model,
          system: r.system,
          tools: r.tools,
          messages: r.messages,
          maxTokens: DEFAULT_MAX_TOKENS,
          signal: r.signal,
        },
        async () => { /* headless: no live frame to surface a retry on */ },
      ))
    const turn = await runTurn(
      {
        stream,
        tools,
        maxTurns: req.maxTurns,
        // Headless has no TaskOutput tool and this inline manager is never
        // destroyed, so model opt-in backgrounding (run_in_background) is
        // bounded by the command's own lifetime but unreaped; the no-op sink
        // drops the settle injection (no live task channel, no durable log).
        tasks: new NativeTaskManager(() => { /* no live task channel */ }),
        cwd: ctx.cwd,
        requestPermission: async (toolName, input, _toolUseId, callSignal, readOnlyHint) => {
          if (callSignal.aborted) return { allowed: false, input, message: 'aborted' }
          // Terminal guard: a captured value closes the run, so every further
          // tool call is denied without consulting the policy (the subagent
          // attach's same rule; the tool itself also blocks a second capture).
          if (structured.isClosed()) {
            return {
              allowed: false,
              input,
              message: 'Structured output already recorded: the run is complete, so this tool call is not executed.',
            }
          }
          const decision = headlessDecision(mode, toolName, input, ctx.cwd, readOnlyHint === true)
          return decision.allowed
            ? { allowed: true, input }
            : { allowed: false, input, message: decision.message }
        },
        // No live subscribers and no durable log: frames are discarded and
        // tool results live only in the throwaway history array.
        emit: () => { /* headless */ },
        persistToolResult: () => { /* non-persisted run */ },
        attachmentProjection: {},
        system,
        emitResult: false,
      },
      defaultFrameContext(randomUUID()),
      history,
      { role: 'user', content: [{ type: 'text', text: req.prompt }] },
      ctx.model,
      controller.signal,
    )
    // A scripted or in-flight stream may ignore the signal, so the abort is
    // checked again before an outcome is reported (the subagent runner's rule).
    if (controller.signal.aborted) return abortedResult()
    const captured = structured.captured()
    // A valid capture stands even if the run later hit its turn cap.
    if (captured) {
      return coerceStructuredOutput({
        ok: true,
        structuredOutput: captured.value,
        rawText: turn.finalText,
        numTurns: turn.numTurns,
      })
    }
    // runTurn marks the whole turn errored ONLY on maxTurns exhaustion (tool
    // failures surface as error tool_results the model recovers from).
    if (turn.isError) {
      return coerceStructuredOutput({
        ok: false,
        errorSubtype: 'error_max_turns',
        errors: [`max turns reached (${turn.numTurns})`, ...(turn.finalText ? [turn.finalText] : [])],
      })
    }
    // No capture: the run failed its output contract — a failure, not a
    // silent text success. The partial answer rides along for the caller.
    return coerceStructuredOutput({
      ok: false,
      errorSubtype: 'error_during_execution',
      errors: ['run ended without calling StructuredOutput', ...(turn.finalText ? [turn.finalText] : [])],
    })
  } catch (err) {
    // External abort surfaces as AbortError from the stream; return a benign
    // aborted result (the route owns the 408/cancel response).
    if (err && (err as Error).name === 'AbortError') return abortedResult()
    return coerceStructuredOutput({
      ok: false,
      errorSubtype: 'error_during_execution',
      errors: [err instanceof Error ? err.message : String(err)],
    })
  } finally {
    signal?.removeEventListener('abort', onAbort)
    controller.abort()
  }
}
