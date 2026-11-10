// server/providers/native/subagent.ts
import type { AgentMessage } from '../../agent-message.js'
import type { AgentDefinitionStore } from '../../agent-definition-store.js'
import { runTurn, type LoopDeps } from './loop.js'
import type { CanonicalEvent } from './canonical.js'
import type { Frame, FrameContext } from './frames.js'
import type { ToolDef } from './tools/types.js'

/** Everything the Agent tool needs from the session that owns it. All fields
 *  are read at call time (except frameCtx/model/system, which are the
 *  session's current values resolved by the caller's closure). */
export interface AgentToolDeps {
  cwd: string
  model: string
  system: string
  frameCtx: FrameContext
  /** LIVE getter: the session's builtins plus its current MCP/first-party
   *  defs. Read per call so a mid-session MCP change is honoured. */
  tools: () => ToolDef[]
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
  prompt: string
  subagent_type?: string
  model?: string
}

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
    guidance:
      "Delegate self-contained subtasks to a subagent via Agent when it saves context; the result is the subagent's final report.",
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

      const nestedSystem = `${deps.system}\n\n${instruction}`
      // Depth is capped at one by construction: the subagent never sees the
      // Agent tool, so it cannot fan out again.
      const nestedTools = deps.tools().filter((t) => t.name !== 'Agent')
      const nestedModel = input.model ?? defModel ?? deps.model
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
            cwd: deps.cwd,
            requestPermission: deps.requestPermission,
            emit: (frame) => {
              const f = frame as Frame
              if (f.type === 'assistant') {
                const content = (f.message as { content?: unknown })?.content
                if (Array.isArray(content)) {
                  assistantTexts.push(
                    content
                      .filter((b) => b && typeof b === 'object' && (b as { type?: string }).type === 'text')
                      .map((b) => (b as { text: string }).text)
                      .join(''),
                  )
                }
              }
              deps.emit(frame)
            },
            system: nestedSystem,
            emitResult: false,
          },
          nestedCtx,
          [],
          { role: 'user', content: [{ type: 'text', text: input.prompt }] },
          nestedModel,
          ctx.signal,
        )
      } catch (err) {
        return { text: err instanceof Error ? err.message : String(err), isError: true }
      }

      // A scripted or in-flight stream may ignore the signal, so the abort is
      // checked again before the report is handed back as a tool_result.
      if (ctx.signal.aborted) return { text: 'aborted', isError: true }

      let text = ''
      for (let i = assistantTexts.length - 1; i >= 0; i--) {
        if (assistantTexts[i].trim()) { text = assistantTexts[i]; break }
      }
      if (!text) text = assistantTexts.join('')
      return { text: text.trim() ? text : '(no output)' }
    },
  }
}