// server/providers/native/subagent.ts
import type { AgentDefinitionStore } from '../../agent-definition-store.js'
import { runTurn, type LoopDeps, type NativeLoopFrame, type PersistedToolResult } from './loop.js'
import type { CanonicalEvent } from './canonical.js'
import type { FrameContext } from './vocabulary/frame-context.js'
import type { NativeTaskManager } from './task-manager.js'
import type { ToolDef } from './tools/types.js'
import type { EffortLevel } from './anthropic-stream.js'
import { profileFromDefinition, type NativeAgentProfile } from './agent-profile.js'
import { filterToolsForProfile } from './agent-tools.js'
import type { NativeSkillView } from './skills.js'
import type { NativeProjectionOptions } from './attachment-projection.js'
import { isValidNativeMaxTurns } from './session-log/format.js'
import type { SessionEvent } from './vocabulary/session-event.js'
import type { RequestMessage } from './vocabulary/message.js'
import type { HookDecision, HookEvent } from './hooks/types.js'
import type { HookDispatchContext } from './hooks/engine.js'
import {
  EXPLORE_AGENT_INSTRUCTION,
  EXPLORE_AGENT_NAME,
  filterExploreTools,
} from './explore.js'

/** Everything the Agent tool needs from the session that owns it. All fields
 *  are read at call time (except frameCtx, which is the session's frame
 *  context). */
export interface AgentToolDeps {
  cwd: string
  /** LIVE getter: a later `setModel` on the session must move the Agent's
   *  fallback, not leave it at the spawn-time model. */
  model: () => string
  /** LIVE getter: an agent without an effort override inherits the parent's
   *  current effective effort, captured when this nested run starts. */
  effortLevel: () => EffortLevel | undefined
  /** LIVE getter: an agent without a permission override inherits the parent's
   *  current effective mode, captured when this nested run starts. */
  permissionMode: () => string
  /** LIVE getter: the subagent prompt plus the scoped Skill section. */
  system: (skillView: NativeSkillView) => string
  frameCtx: FrameContext
  /** LIVE getter: the session's builtins plus its current MCP/first-party
   *  defs. Read per call so a mid-session MCP change is honoured. */
  tools: () => ToolDef[]
  /** LIVE getter for ownership metadata paired with the current full snapshot. */
  mcpToolServers: () => ReadonlyMap<string, { name: string }>
  /** A scoped view over the parent's shared discovery cache. */
  skillView(policy?: readonly string[] | 'all'): NativeSkillView
  /** Nested runs never retain the parent view's stateful Skill tool instance. */
  skillToolFor(view: NativeSkillView): ToolDef
  tasks: NativeTaskManager
  streamFor(
    req: { model: string; system: string; tools: unknown[]; messages: unknown[]; signal: AbortSignal },
    opts?: { suppressRetryFrames?: boolean; effortLevel?: () => EffortLevel | undefined },
  ): AsyncIterable<CanonicalEvent>
  requestPermission(
    toolName: string,
    input: Record<string, unknown>,
    toolUseId: string,
    signal: AbortSignal,
    permissionMode?: string,
  ): ReturnType<LoopDeps['requestPermission']>
  /** The session's persist+push path. The neutral frame carries no envelope
   *  identity, so the nested runner forwards its sidechain parent explicitly;
   *  the session projects the frame to SDK with that parent. */
  emit(frame: NativeLoopFrame, parentToolUseId: string | null): void
  /** Canonical nested result persistence; parentage is explicit because the
   * shared session log also persists main-thread results. */
  persistToolResult(result: PersistedToolResult, parentToolUseId: string | null): void
  attachmentProjection: NativeProjectionOptions
  /** Durable catalog identity as a NEUTRAL v3 `subagent/descriptor` event (the
   *  log assigns `seq`). Descriptors deliberately bypass emit and model history;
   *  a nested request may start only after this append resolves. */
  appendDescriptor(
    input: Omit<SessionEvent<'subagent/descriptor'>, 'seq'>,
  ): Promise<SessionEvent<'subagent/descriptor'>>
  agentStore?: AgentDefinitionStore
  /** Hook decision point for the subagent lifecycle seams: SubagentStart at
   *  descriptor append, SubagentStop at the final report. Absent = no hook
   *  engine wired. The runner stamps the sidechain parent (the spawning
   *  tool_use id) on every dispatch so hook activity attributes to this
   *  subagent, never the main thread. */
  dispatchHook?: (
    event: HookEvent,
    input: Record<string, unknown>,
    ctx: HookDispatchContext,
  ) => Promise<HookDecision>
}

/** Forced-continuation bound for the SubagentStop seam, mirroring the Stop
 *  seam's cap (RS §5): an always-blocking hook must not loop the subagent
 *  forever. The count increments on EVERY forced continuation (exit-2 block OR
 *  additionalContext); the subagent ends with a warning when it exceeds the
 *  cap. */
const SUBAGENT_STOP_BLOCK_CAP = 8

/** The subagent's final report: the last non-empty assistant text. */
function lastReport(assistantTexts: readonly string[]): string {
  for (let i = assistantTexts.length - 1; i >= 0; i--) {
    if (assistantTexts[i].trim()) return assistantTexts[i]
  }
  return ''
}

interface AgentToolInput {
  description: string
  prompt: unknown
  subagent_type?: unknown
  model?: string
}

/** Shared Agent/Task guidance. The provider registers only `tool:Agent`; nested
 *  runs omit that section because both delegation tools are removed. */
export const AGENT_GUIDANCE =
  "Delegate self-contained subtasks to a subagent via Agent when it saves context; the result is the subagent's final report."

/** The instruction used when no custom agent is named. */
const DEFAULT_AGENT_INSTRUCTION =
  'You are a subagent working independently inside the session working directory. ' +
  'Complete the task with the available tools and reply with a concise final report: ' +
  'what you did, what you found, and anything the parent agent must know.'

export function createAgentTool(deps: AgentToolDeps, toolName: 'Agent' | 'Task' = 'Agent'): ToolDef {
  return {
    name: toolName,
    description:
      'Delegate a self-contained subtask to a subagent that works in its own context with the same tools and permissions, then returns a concise final report.',
    guidance: AGENT_GUIDANCE,
    promptOrder: 80,
    schema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Short description of the subtask.' },
        prompt: { type: 'string', description: 'The full task for the subagent to complete.' },
        subagent_type: {
          type: 'string',
          description: 'Agent definition to run as. Defaults to general-purpose.',
        },
        model: { type: 'string', description: 'Model override for the subagent.' },
      },
      required: ['description', 'prompt'],
    },
    backgroundable: {
      taskType: 'subagent',
      describe: (raw) => (raw as unknown as AgentToolInput).description,
      subagentType: (raw) => {
        const value = (raw as unknown as AgentToolInput).subagent_type
        return typeof value === 'string' && value.trim() ? value.trim() : 'general-purpose'
      },
    },
    async run(raw, ctx) {
      const input = raw as unknown as AgentToolInput
      if (!ctx.toolUseId) throw new Error(`${toolName} requires a tool_use id`)
      if (typeof input.prompt !== 'string' || !input.prompt.trim()) {
        return { text: 'prompt is required', isError: true }
      }
      const prompt = input.prompt
      if (input.subagent_type !== undefined && typeof input.subagent_type !== 'string') {
        return { text: `unknown subagent_type: ${String(input.subagent_type)}`, isError: true }
      }

      const requested = typeof input.subagent_type === 'string' ? input.subagent_type.trim() : ''
      let profile: NativeAgentProfile | undefined
      if (requested === EXPLORE_AGENT_NAME) {
        profile = { name: EXPLORE_AGENT_NAME, instruction: EXPLORE_AGENT_INSTRUCTION }
      } else if (requested && requested !== 'general-purpose') {
        const def = deps.agentStore?.get(requested)
        if (!def || !def.enabled) {
          return { text: `unknown subagent_type: ${requested}`, isError: true }
        }
        try {
          profile = profileFromDefinition(def)
        } catch (err) {
          return { text: err instanceof Error ? err.message : String(err), isError: true }
        }
      }

      if (profile?.maxTurns !== undefined && !isValidNativeMaxTurns(profile.maxTurns)) {
        return { text: 'maxTurns must be a positive integer', isError: true }
      }

      // The hook matcher target for both subagent events (RS §3 `qZe`): the
      // resolved agent type, with the same fallback the task roster uses.
      const agentType = requested || 'general-purpose'

      const instruction = profile?.instruction ?? DEFAULT_AGENT_INSTRUCTION
      const skillView = deps.skillView(profile?.skills)
      const nestedSystem = `${deps.system(skillView)}\n\n${instruction}`
      // Depth is capped at one by construction. Replace the stateful Skill
      // instance BEFORE filtering so the scoped view and allow/deny/MCP policy
      // both apply to the complete current nested snapshot.
      const profileTools = filterToolsForProfile(
        deps.tools()
          .filter((tool) => tool.name !== 'Agent' && tool.name !== 'Task')
          .map((tool) => tool.name === 'Skill' ? deps.skillToolFor(skillView) : tool),
        profile ?? {},
        deps.mcpToolServers(),
      )
      const nestedTools = requested === EXPLORE_AGENT_NAME
        ? filterExploreTools(profileTools)
        : profileTools
      // The schema declares a string, but a model can still emit a number or
      // blank string. Treat both as absent so the nested run inherits the
      // definition/parent model instead of sending an invalid id to the API.
      const requestedModel =
        typeof input.model === 'string' && input.model.trim() ? input.model : undefined
      const nestedModel = requestedModel ?? profile?.model ?? deps.model()
      const nestedEffort = profile?.effort ?? deps.effortLevel()
      const nestedPermissionMode = profile?.permissionMode ?? deps.permissionMode()
      const nestedCtx: FrameContext = { ...deps.frameCtx, parentToolUseId: ctx.toolUseId }

      if (ctx.signal.aborted) return { text: 'aborted', isError: true }

      // Observe assistant text for the result; every frame still goes through
      // the session's own emit (parentage is stamped by nestedCtx).
      const assistantTexts: string[] = []
      // The nested model history survives a SubagentStop forced continuation:
      // the next runTurn appends to the SAME history (the Stop seam's
      // continuation shape, one level up).
      const nestedHistory: RequestMessage[] = []
      const turnDeps: LoopDeps = {
        stream: (req) => deps.streamFor(req, {
          suppressRetryFrames: true,
          effortLevel: () => nestedEffort,
        }),
        tools: nestedTools,
        maxTurns: profile?.maxTurns,
        tasks: deps.tasks,
        cwd: deps.cwd,
        requestPermission: (toolName, toolInput, toolUseId, signal) =>
          deps.requestPermission(toolName, toolInput, toolUseId, signal, nestedPermissionMode),
        emit: (frame) => {
          if ('type' in frame && frame.type === 'assistant-frame') {
            const content = frame.message.content
            assistantTexts.push(content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join(''))
          }
          deps.emit(frame, nestedCtx.parentToolUseId ?? null)
        },
        persistToolResult: (result) => deps.persistToolResult(result, nestedCtx.parentToolUseId ?? null),
        attachmentProjection: deps.attachmentProjection,
        system: nestedSystem,
        emitResult: false,
      }
      let turn: Awaited<ReturnType<typeof runTurn>>
      try {
        const description = typeof input.description === 'string' ? input.description.trim() : ''
        // Neutral v3 descriptor: the identity rides `data`, the envelope `time`
        // is the ms-epoch of the ISO `data.timestamp` (the same pairing the
        // lossless v1/v2→v3 migration produces), and the sidechain parent is the
        // data fact (the descriptor envelope carries no parent axis).
        const timestamp = new Date().toISOString()
        await deps.appendDescriptor({
          type: 'subagent/descriptor',
          time: Date.parse(timestamp),
          data: {
            toolUseId: ctx.toolUseId,
            parentToolUseId: deps.frameCtx.parentToolUseId ?? null,
            kind: 'agent',
            toolName,
            label: description || requested || 'Subagent',
            depth: 1,
            profile: profile ? structuredClone(profile) : null,
            timestamp,
          },
        })
        if (ctx.signal.aborted) return { text: 'aborted', isError: true }
        // SubagentStart seam (RS §3/§9): fires once the descriptor is durable,
        // BEFORE the nested run starts. No conversation context exists yet
        // (RS §12.2: prompt/agent hooks report a non-blocking availability
        // error); additionalContext routes INTO the subagent prompt. Exit-2
        // stderr is user-only on this event — the hook activity record surfaces
        // it; a block never prevents the launch.
        const startContext: string[] = []
        if (deps.dispatchHook) {
          const startDecision = await deps.dispatchHook('SubagentStart', {
            session_id: deps.frameCtx.sessionId,
            cwd: deps.cwd,
            hook_event_name: 'SubagentStart',
            agent_id: ctx.toolUseId,
            agent_type: agentType,
          }, { signal: ctx.signal, hasContext: false, parentToolUseId: ctx.toolUseId })
          for (const context of startDecision.additionalContext) {
            if (context.trim() !== '') startContext.push(context)
          }
        }
        // The dispatch awaited hook subprocesses; re-check the abort before
        // the nested request starts.
        if (ctx.signal.aborted) return { text: 'aborted', isError: true }
        const initialMessages: RequestMessage[] = [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
        if (startContext.length > 0) {
          initialMessages.push({ role: 'user', content: [{ type: 'text', text: startContext.join('\n') }] })
        }
        turn = await runTurn(turnDeps, nestedCtx, nestedHistory, initialMessages, nestedModel, ctx.signal)
        if (ctx.signal.aborted) return { text: 'aborted', isError: true }
        // SubagentStop seam (RS §3/§9): dispatch at the final report, BEFORE
        // the report is handed back as the parent's tool_result. Exit-2 /
        // decision block feeds the stderr to the subagent and forces another
        // nested turn; additionalContext is the non-error continuation channel
        // (same capped path). stop_hook_active marks a forced continuation on
        // the next dispatch, exactly as the Stop seam does one level up.
        let stopHookActive = false
        let stopBlockCount = 0
        while (deps.dispatchHook && !ctx.signal.aborted) {
          const stopDecision = await deps.dispatchHook('SubagentStop', {
            session_id: deps.frameCtx.sessionId,
            cwd: deps.cwd,
            hook_event_name: 'SubagentStop',
            stop_hook_active: stopHookActive,
            agent_id: ctx.toolUseId,
            agent_type: agentType,
            last_assistant_message: lastReport(assistantTexts),
          }, { signal: ctx.signal, hasContext: true, parentToolUseId: ctx.toolUseId })
          // continue:false overrides exit-2 (RS §2.3); a maxTurns-capped turn
          // ends regardless (the Stop seam's maxTurns precedence).
          if (turn.isError || stopDecision.continue === false) break
          const feedback: string[] = []
          if (stopDecision.action === 'block') {
            const reason = stopDecision.block?.reason ?? ''
            // exit-2 with empty stderr is a real hook shape; the continuation
            // still happens, with a factual marker so the message is never empty.
            feedback.push(reason.trim() !== '' ? reason : 'SubagentStop hook blocked the subagent from stopping.')
          }
          for (const context of stopDecision.additionalContext) {
            if (context.trim() !== '') feedback.push(context)
          }
          if (feedback.length === 0) break
          stopBlockCount++
          stopHookActive = true
          if (stopBlockCount > SUBAGENT_STOP_BLOCK_CAP) {
            deps.emit({
              type: 'informational',
              text: `A hook blocked the subagent from stopping ${stopBlockCount} consecutive times — overriding and ending the subagent. `
                + "For SubagentStop hooks, check stop_hook_active in the input and return success while it's true.",
              sessionId: deps.frameCtx.sessionId,
              uuid: deps.frameCtx.uuid(),
              parentToolUseId: nestedCtx.parentToolUseId ?? null,
            }, nestedCtx.parentToolUseId ?? null)
            break
          }
          nestedHistory.push({ role: 'user', content: [{ type: 'text', text: feedback.join('\n') }] })
          turn = await runTurn(turnDeps, nestedCtx, nestedHistory, [], nestedModel, ctx.signal)
          if (ctx.signal.aborted) return { text: 'aborted', isError: true }
        }
      } catch (err) {
        return { text: err instanceof Error ? err.message : String(err), isError: true }
      } finally {
        // A foreground child ends with its parent; a detached child reaches this
        // only when its own task ends. Neither may clear another history's reads.
        deps.attachmentProjection.preparedPdfs?.clearHistory(nestedCtx.parentToolUseId ?? 'main')
      }

      // A scripted or in-flight stream may ignore the signal, so the abort is
      // checked again before the report is handed back as a tool_result.
      if (ctx.signal.aborted) return { text: 'aborted', isError: true }

      const finalReport = lastReport(assistantTexts)
      if (turn.isError) {
        const cutoff = `max turns reached (${turn.numTurns})`
        return { text: finalReport ? `${cutoff}\n\n${finalReport}` : cutoff, isError: true }
      }
      return { text: finalReport || '(no output)' }
    },
  }
}