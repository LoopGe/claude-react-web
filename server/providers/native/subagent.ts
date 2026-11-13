// server/providers/native/subagent.ts
import type { AgentMessage } from '../../agent-message.js'
import type { AgentDefinitionStore } from '../../agent-definition-store.js'
import { runTurn, type LoopDeps, type PersistedToolResult } from './loop.js'
import type { CanonicalEvent } from './canonical.js'
import type { Frame, FrameContext } from './frames.js'
import type { NativeTaskManager } from './task-manager.js'
import type { ToolDef } from './tools/types.js'
import type { EffortLevel } from './anthropic-stream.js'
import { profileFromDefinition, type NativeAgentProfile } from './agent-profile.js'
import { filterToolsForProfile } from './agent-tools.js'
import type { NativeSkillView } from './skills.js'
import type { NativeProjectionOptions } from './attachment-projection.js'
import { isValidNativeMaxTurns } from './session-log/format.js'
import type { NativeSubagentDescriptorEvent } from './session-log/format.js'
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
  /** The session's persist+push path. Parentage comes from the nested frame
   *  context, so this is forwarded unchanged. */
  emit(frame: AgentMessage): void
  /** Canonical nested result persistence; parentage is explicit because the
   * shared session log also persists main-thread results. */
  persistToolResult(result: PersistedToolResult, parentToolUseId: string | null): void
  attachmentProjection: NativeProjectionOptions
  /** Durable catalog identity. Descriptors deliberately bypass emit and model
   *  history; a nested request may start only after this append resolves. */
  appendDescriptor(
    input: Omit<NativeSubagentDescriptorEvent, 'seq' | 'timestamp'>,
  ): Promise<NativeSubagentDescriptorEvent>
  agentStore?: AgentDefinitionStore
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
      let turn: Awaited<ReturnType<typeof runTurn>>
      try {
        const description = typeof input.description === 'string' ? input.description.trim() : ''
        await deps.appendDescriptor({
          type: 'subagent/descriptor',
          toolUseId: ctx.toolUseId,
          parentToolUseId: deps.frameCtx.parentToolUseId ?? null,
          kind: 'agent',
          toolName,
          label: description || requested || 'Subagent',
          depth: 1,
          profile: profile ? structuredClone(profile) : null,
        })
        if (ctx.signal.aborted) return { text: 'aborted', isError: true }
        turn = await runTurn(
          {
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
              const f = frame as Frame
              if (f.type === 'assistant') {
                const content = f.message.content as Array<{ type: string; text: string }>
                assistantTexts.push(content.filter((b) => b.type === 'text').map((b) => b.text).join(''))
              }
              deps.emit(frame)
            },
            persistToolResult: (result) => deps.persistToolResult(result, nestedCtx.parentToolUseId ?? null),
            attachmentProjection: deps.attachmentProjection,
            system: nestedSystem,
            emitResult: false,
          },
          nestedCtx,
          [],
          { role: 'user', content: [{ type: 'text', text: prompt }] },
          nestedModel,
          ctx.signal,
        )
      } catch (err) {
        return { text: err instanceof Error ? err.message : String(err), isError: true }
      }

      // A scripted or in-flight stream may ignore the signal, so the abort is
      // checked again before the report is handed back as a tool_result.
      if (ctx.signal.aborted) return { text: 'aborted', isError: true }

      let finalReport = ''
      for (let i = assistantTexts.length - 1; i >= 0; i--) {
        if (assistantTexts[i].trim()) {
          finalReport = assistantTexts[i]
          break
        }
      }
      if (turn.isError) {
        const cutoff = `max turns reached (${turn.numTurns})`
        return { text: finalReport ? `${cutoff}\n\n${finalReport}` : cutoff, isError: true }
      }
      return { text: finalReport || '(no output)' }
    },
  }
}