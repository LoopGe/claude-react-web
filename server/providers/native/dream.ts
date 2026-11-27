// server/providers/native/dream.ts
//
// Dream consolidation run construction (core) for native auto-memory. The
// trigger (when to fire) is the session's turn-end hook (Task 11); this module
// owns the pure timing predicate, the consolidation prompt, the constrained
// tool set, and the nested-run construction the trigger calls.
//
// A dream run is a fire-and-forget background subagent: it mirrors the Agent
// tool's nested `runTurn` construction (subagent.ts) but is launched
// programmatically, confined to Read/Write/Edit, and given its own containment
// roots — write ONLY the cwd's own memory dir, read that dir plus the native
// session-log tree (its consolidation source material). It registers with the
// shared task manager as a foreground subagent and is immediately backgrounded,
// so it never blocks the user turn and its transcript is viewable through the
// existing subagent surface.
//
// Neutrality: this module imports only sibling core modules, the neutral
// vocabulary, neutral shared types and node builtins — no host services, no SDK.
// The native-sessions read root is a neutral path join over the injected
// stateDir, never a host import.

import { join } from 'node:path'
import { createLogger } from '../../log.js'
import { runTurn, type LoopDeps } from './loop.js'
import type { AgentToolDeps } from './subagent.js'
import type { FrameContext } from './vocabulary/frame-context.js'
import type { ToolDef, ToolOutcome } from './tools/types.js'
import { filterToolsForProfile } from './agent-tools.js'
import type { RequestMessage } from './vocabulary/message.js'

const log = createLogger('native-dream')

/** Whether a cwd is due for a dream consolidation: at least `afterMs` since the
 *  last dream AND at least `sessionCount` same-cwd sessions touched since. An
 *  absent `lastDreamAt` (no prior dream) satisfies the window gate outright, so
 *  only the count gate binds. Both boundaries are inclusive (CLI parity). */
export function shouldDream(
  lastDreamAt: number | undefined,
  now: number,
  touchedCount: number,
  cfg: { afterMs: number; sessionCount: number },
): boolean {
  const windowMet = lastDreamAt === undefined || now - lastDreamAt >= cfg.afterMs
  return windowMet && touchedCount >= cfg.sessionCount
}

/** The consolidation instruction, verbatim from the design (CLI dream
 *  precedent, RS §2.5). The model reads the listed session logs and the current
 *  index, then improves the store — writes confined to `ownDir`. */
export const DREAM_PROMPT = (input: { ownDir: string; logPaths: string[]; index: string | null }): string =>
  'You are the memory consolidation agent for this project. Review the recent session logs and the current memory files, '
  + 'then improve the memory store: merge duplicates, update stale facts, remove entries derivable from code or git history, '
  + `and keep MEMORY.md as a one-line-per-memory index. Write only inside ${input.ownDir}. Do not modify any other directory.\n\n`
  + 'Session logs (read with the Read tool):\n'
  + `${input.logPaths.join('\n')}\n\n`
  + `Memory directory: ${input.ownDir}\n`
  + 'Current index:\n'
  + `${input.index ?? '(empty index)'}`

/** The dream tool set: exactly Read/Write/Edit, via the same profile filter the
 *  Agent tool uses. Read reaches the session logs + memory files; Write/Edit are
 *  confined to the own root by the run's containment roots and the broker
 *  exemption. The allow-list already restricts to these three builtin names
 *  (none has an MCP owner), so an empty ownership map is the correct pairing. */
export function dreamToolFilter(tools: readonly ToolDef[]): ToolDef[] {
  return filterToolsForProfile(
    tools,
    { tools: ['Read', 'Write', 'Edit'], disallowedTools: [], mcpServers: [] },
    new Map(),
  )
}

/** The session-owned seams a dream run needs — the same shape the Agent tool
 *  reads (live getters for model-independent facts, the session's stream /
 *  permission / persist+push paths). Picked from AgentToolDeps so the wiring can
 *  reuse the exact lambdas the Agent tool already binds. */
export type DreamRunDeps = Pick<
  AgentToolDeps,
  | 'cwd' | 'frameCtx' | 'tasks' | 'tools' | 'permissionMode' | 'effortLevel'
  | 'streamFor' | 'requestPermission' | 'emit' | 'persistToolResult'
  | 'attachmentProjection' | 'appendDescriptor'
>

/** The per-run facts the trigger supplies: the resolved own root, the touched
 *  session-log paths, the current index snapshot, the state dir (the native
 *  session-log read root is derived from it), the resolved dream model, the
 *  nested system prompt, and the session-lifetime signal. */
export interface DreamRunInput {
  ownDir: string
  logPaths: string[]
  index: string | null
  stateDir: string
  model: string
  system: string
  signal: AbortSignal
}

/** The handle the trigger awaits: the dream task id and a promise that settles
 *  with the run's outcome (success OR failure — it never rejects), so the
 *  trigger can release the per-cwd lease in a `finally`. */
export interface DreamRunHandle {
  toolUseId: string
  settled: Promise<ToolOutcome>
}

/** Construct and launch one background dream run. The descriptor is appended
 *  FIRST (durable before any nested request, the subagent convention), then the
 *  run registers as a foreground subagent and is immediately backgrounded —
 *  `execute` keeps running after the flip. Returns once the task is registered
 *  (not once the run finishes); await `handle.settled` for the outcome. */
export async function startDreamRun(deps: DreamRunDeps, input: DreamRunInput): Promise<DreamRunHandle> {
  const toolUseId = `dream-${deps.frameCtx.uuid()}`
  const nativeSessionsDir = join(input.stateDir, 'native-sessions')
  const nestedCtx: FrameContext = { ...deps.frameCtx, parentToolUseId: toolUseId }
  const nestedPermissionMode = deps.permissionMode()
  const nestedEffort = deps.effortLevel()
  const nestedTools = dreamToolFilter(deps.tools())
  const prompt = DREAM_PROMPT({ ownDir: input.ownDir, logPaths: input.logPaths, index: input.index })
  const initialMessages: RequestMessage[] = [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
  const nestedHistory: RequestMessage[] = []

  // Durable catalog identity before any nested request. A top-level delegated
  // run (parentToolUseId null) uses depth 1 — the same convention as a
  // main-thread-spawned subagent; the v3 parser requires a positive integer.
  const timestamp = new Date().toISOString()
  await deps.appendDescriptor({
    type: 'subagent/descriptor',
    time: Date.parse(timestamp),
    data: {
      toolUseId,
      parentToolUseId: null,
      kind: 'agent',
      toolName: 'Agent',
      label: 'Memory consolidation',
      depth: 1,
      profile: null,
      timestamp,
    },
  })

  const turnDeps: LoopDeps = {
    stream: (req) => deps.streamFor(req, {
      suppressRetryFrames: true,
      effortLevel: () => nestedEffort,
    }),
    tools: nestedTools,
    tasks: deps.tasks,
    cwd: deps.cwd,
    // Dream containment: write ONLY the own root; read the own root plus the
    // native session-log tree (the consolidation source material).
    memoryRoots: () => ({ write: [input.ownDir], read: [input.ownDir, nativeSessionsDir] }),
    requestPermission: (toolName, toolInput, id, signal, readOnlyHint) =>
      deps.requestPermission(toolName, toolInput, id, signal, nestedPermissionMode, readOnlyHint),
    emit: (frame) => deps.emit(frame, toolUseId),
    persistToolResult: (result) => deps.persistToolResult(result, toolUseId),
    attachmentProjection: deps.attachmentProjection,
    system: input.system,
    emitResult: false,
  }

  // runForeground invokes `execute` synchronously, so `execution` is assigned
  // by the time it returns; the background flip below does not stop it.
  let execution!: Promise<ToolOutcome>
  const execute = (signal: AbortSignal): Promise<ToolOutcome> => {
    execution = (async () => {
      try {
        const turn = await runTurn(turnDeps, nestedCtx, nestedHistory, initialMessages, input.model, signal)
        if (signal.aborted) return { text: 'aborted', isError: true }
        if (turn.isError) return { text: turn.finalText || `max turns reached (${turn.numTurns})`, isError: true }
        return { text: turn.finalText || '(no output)' }
      } catch (err) {
        return { text: err instanceof Error ? err.message : String(err), isError: true }
      } finally {
        deps.attachmentProjection.preparedPdfs?.clearHistory(toolUseId)
      }
    })()
    return execution
  }

  deps.tasks.runForeground({
    toolUseId,
    taskType: 'subagent',
    description: 'Memory consolidation',
    subagentType: 'dream',
  }, execute, input.signal)
  deps.tasks.background(toolUseId)

  log.debug(`[${deps.frameCtx.sessionId}] dream run started: ${toolUseId}`)
  return { toolUseId, settled: execution }
}
