// server/providers/native/subagent.ts
import type { AgentMessage } from '../../agent-message.js'
import type { AgentDefinitionStore } from '../../agent-definition-store.js'
import { runTurn, type LoopDeps } from './loop.js'
import type { CanonicalEvent } from './canonical.js'
import type { Frame, FrameContext } from './frames.js'
import type { NativeTaskManager } from './task-manager.js'
import type { ToolDef } from './tools/types.js'

/** Everything the Agent tool needs from the session that owns it. All fields
 *  are read at call time (except frameCtx, which is the session's frame
 *  context). */
export interface AgentToolDeps {
  cwd: string
  /** LIVE getter: a later `setModel` on the session must move the Agent's
   *  fallback, not leave it at the spawn-time model. */
  model: () => string
  /** LIVE getter: the subagent prompt plus the CURRENT skills section, so a
   *  `reloadSkills`/`applyFlagSettings` change reaches the next nested run. */
  system: () => string
  frameCtx: FrameContext
  /** LIVE getter: the session's builtins plus its current MCP/first-party
   *  defs. Read per call so a mid-session MCP change is honoured. */
  tools: () => ToolDef[]
  tasks: NativeTaskManager
  streamFor(
    req: { model: string; system: string; tools: unknown[]; messages: unknown[]; signal: AbortSignal },
    opts?: { suppressRetryFrames?: boolean },
  ): AsyncIterable<CanonicalEvent>
  requestPermission: LoopDeps['requestPermission']
  /** The session's persist+push path. Parentage comes from the nested frame
   *  context, so this is forwarded unchanged. */
  emit(frame: AgentMessage): void
  agentStore?: AgentDefinitionStore
}

interface AgentToolInput {
  description?: string
  prompt: unknown
  subagent_type?: unknown
  model?: string
}

/** The Agent tool's prompt-section guidance. Exported so the provider's static
 *  `tool:Agent` prompt section and the tool definition cannot drift. */
export const AGENT_GUIDANCE =
  "Delegate self-contained subtasks to a subagent via Agent when it saves context; the result is the subagent's final report."

/** The instruction used when no custom agent is named. */
const DEFAULT_AGENT_INSTRUCTION =
  'You are a subagent working independently inside the session working directory. ' +
  'Complete the task with the available tools and reply with a concise final report: ' +
  'what you did, what you found, and anything the parent agent must know.'

export function createAgentTool(deps: AgentToolDeps): ToolDef {
  return {
    name: 'Agent',
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
    async run(raw, ctx) {
      const input = raw as unknown as AgentToolInput
      if (!ctx.toolUseId) throw new Error('Agent requires a tool_use id')
      if (typeof input.prompt !== 'string' || !input.prompt.trim()) {
        return { text: 'prompt is required', isError: true }
      }
      const prompt = input.prompt
      if (input.subagent_type !== undefined && typeof input.subagent_type !== 'string') {
        return { text: `unknown subagent_type: ${String(input.subagent_type)}`, isError: true }
      }

      const requested = typeof input.subagent_type === 'string' ? input.subagent_type.trim() : ''
      let instruction = DEFAULT_AGENT_INSTRUCTION
      let defModel: string | undefined
      if (requested && requested !== 'general-purpose') {
        const def = deps.agentStore?.get(requested)
        if (!def || !def.enabled) {
          return { text: `unknown subagent_type: ${requested}`, isError: true }
        }
        instruction = def.prompt
        defModel = def.model
      }

      const nestedSystem = `${deps.system()}\n\n${instruction}`
      // Depth is capped at one by construction: the subagent never sees the
      // Agent tool, so it cannot fan out again.
      const nestedTools = deps.tools().filter((t) => t.name !== 'Agent')
      // The schema declares a string, but a model can still emit a number or
      // blank string. Treat both as absent so the nested run inherits the
      // definition/parent model instead of sending an invalid id to the API.
      const requestedModel =
        typeof input.model === 'string' && input.model.trim() ? input.model : undefined
      const nestedModel = requestedModel ?? defModel ?? deps.model()
      const nestedCtx: FrameContext = { ...deps.frameCtx, parentToolUseId: ctx.toolUseId }

      if (ctx.signal.aborted) return { text: 'aborted', isError: true }

      // Observe assistant text for the result; every frame still goes through
      // the session's own emit (parentage is stamped by nestedCtx).
      const assistantTexts: string[] = []
      try {
        await runTurn(
          {
            stream: (req) => deps.streamFor(req, { suppressRetryFrames: true }),
            tools: nestedTools,
            tasks: deps.tasks,
            cwd: deps.cwd,
            requestPermission: deps.requestPermission,
            emit: (frame) => {
              const f = frame as Frame
              if (f.type === 'assistant') {
                const content = f.message.content as Array<{ type: string; text: string }>
                assistantTexts.push(content.filter((b) => b.type === 'text').map((b) => b.text).join(''))
              }
              deps.emit(frame)
            },
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

      for (let i = assistantTexts.length - 1; i >= 0; i--) {
        if (assistantTexts[i].trim()) return { text: assistantTexts[i] }
      }
      return { text: '(no output)' }
    },
  }
}