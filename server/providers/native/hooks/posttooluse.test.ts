// server/providers/native/hooks/posttooluse.test.ts
// T9: the PostToolUse / PostToolUseFailure dispatch seams in the neutral turn
// loop. Routing is by THROW-vs-RETURN only (RS §12.1): a normal return — even
// one whose result carries a soft isError — fires PostToolUse; a thrown error
// fires PostToolUseFailure. The MCP adapter normalizes MCP isError:true into a
// throw (CLI `ys` parity) so MCP errors reach Failure via the catch path. The
// seam applies the engine-merged updatedToolOutput rewrite (last-write-wins,
// RS §4.9), collects additionalContext, and feeds an exit-2 block's stderr to
// the model as next-round feedback (the tool already ran, so its result stands).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { NativeProvider } from '../native-provider.js'
import { makeNativePorts } from '../../native-host-adapters.js'
import type { CanonicalEvent } from '../canonical.js'
import type { SessionHooksConfig } from '../../../../shared/hooks.js'
import type { Frame } from '../../native-frames.js'

const tempDirs: string[] = []

/** A fresh temp state dir per test; the project skills root is created so
 *  construction-time discovery never logs an ENOENT warning (pristine output). */
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  await mkdir(join(dir, '.claude', 'skills'), { recursive: true })
  return dir
}

/** Redirect user-scope skill discovery at a temp empty dir so the developer's
 *  real ~/.claude/skills can never leak in (same fixture as pretooluse.test.ts). */
let skillsConfigDir: string
let previousConfigDir: string | undefined

beforeEach(async () => {
  skillsConfigDir = await mkdtemp(join(tmpdir(), 'native-posttooluse-config-'))
  await mkdir(join(skillsConfigDir, 'skills'), { recursive: true })
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = skillsConfigDir
})

afterEach(async () => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  await rm(skillsConfigDir, { recursive: true, force: true })
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

/** One assistant round whose only call is `name` with `input`. */
function toolTurn(toolUseId: string, name: string, input: Record<string, unknown>): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'tool_use', id: toolUseId, name } },
    { kind: 'block_delta', index: 0, delta: { type: 'tool_input', json: JSON.stringify(input) } },
    { kind: 'block_end', index: 0 },
    { kind: 'message_end', stopReason: 'tool_use', usage: { output_tokens: 5 } },
  ]
}

function textTurn(text: string): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'text' } },
    { kind: 'block_delta', index: 0, delta: { type: 'text', text } },
    { kind: 'block_end', index: 0 },
    { kind: 'message_end', stopReason: 'end_turn', usage: { output_tokens: 5 } },
  ]
}

let userMsgSeq = 0
function userMsg(text: string) {
  return {
    type: 'user' as const,
    message: { role: 'user' as const, content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    session_id: '',
    uuid: `u-${++userMsgSeq}`,
  }
}

/** A command hook matched on `matcher` for one event. Explicit bash shell so the
 *  command is identical on win32 (Git Bash) and posix. */
function commandHook(command: string) {
  return { type: 'command' as const, command, shell: 'bash' as const }
}

function postHook(matcher: string, command: string): SessionHooksConfig {
  return { PostToolUse: [{ matcher, hooks: [commandHook(command)] }] }
}

function failureHook(matcher: string, command: string): SessionHooksConfig {
  return { PostToolUseFailure: [{ matcher, hooks: [commandHook(command)] }] }
}

/** Both post events matched on the same tool, so exactly one fires depending on
 *  throw-vs-return routing. The hook bodies are inert; the dispatch itself is
 *  observed through the hook_started activity frames. */
function routingHooks(matcher: string): SessionHooksConfig {
  return {
    PostToolUse: [{ matcher, hooks: [commandHook('echo post-ran')] }],
    PostToolUseFailure: [{ matcher, hooks: [commandHook('echo failure-ran')] }],
  }
}

/** The JSON a command hook echoes to emit a PostToolUse hookSpecificOutput. */
function postHsoJson(fields: Record<string, unknown>): string {
  return `echo '${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', ...fields } })}'`
}

/** The JSON a command hook echoes to emit a PostToolUseFailure hookSpecificOutput. */
function failureHsoJson(fields: Record<string, unknown>): string {
  return `echo '${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUseFailure', ...fields } })}'`
}

/** An in-memory MCP server whose single tool always returns isError:true. */
function boomServer(): McpServer {
  const server = new McpServer({ name: 'boom-server', version: '1.0.0' })
  server.registerTool(
    'boom',
    { description: 'Always fails.', inputSchema: {} },
    async () => ({ content: [{ type: 'text', text: 'mcp-boom-error-text' }], isError: true }),
  )
  return server
}

interface TurnOutcome {
  dir: string
  frames: Frame[]
  requests: Array<{ messages: unknown[] }>
}

/** Drive one tool turn through the real provider + loop with the given hooks
 *  config (and optional MCP servers). The canUseTool spy always allows, so the
 *  permission flow never blocks the tool. */
async function runToolTurn(opts: {
  hooks?: SessionHooksConfig
  toolName: string
  toolInput: Record<string, unknown>
  mcpServers?: Record<string, unknown>
}): Promise<TurnOutcome> {
  const dir = await tempDir('posttooluse-')
  const provider = new NativeProvider({ stateDir: dir, ports: makeNativePorts({ stateDir: dir }) })
  const requests: Array<{ messages: unknown[] }> = []
  const scripts: CanonicalEvent[][] = [toolTurn('tu-1', opts.toolName, opts.toolInput), textTurn('done')]
  ;(provider as unknown as { _testStream: unknown })._testStream = async function* (req: { messages: unknown[] }) {
    requests.push(structuredClone(req))
    for (const ev of scripts.shift() ?? []) yield ev
  }
  const session = provider.createSession({
    id: 'posttooluse',
    cwd: dir,
    ...(opts.hooks ? { providerExtras: { sdkOptions: { settings: { hooks: opts.hooks } } } } : {}),
    ...(opts.mcpServers ? { mcpServers: opts.mcpServers } : {}),
    canUseTool: async (_toolName: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input }),
  })
  const frames: Frame[] = []
  void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()
  try {
    session.enqueueUserMessage(userMsg('go') as never)
    await vi.waitFor(() => {
      expect(frames.filter((f) => f.type === 'result')).toHaveLength(1)
    })
  } finally {
    await session.destroy()
  }
  return { dir, frames, requests }
}

/** The hook events dispatched this turn, read from the hook_started activity
 *  frames (one per matched hook, stamped with its event name). */
function hookEvents(frames: Frame[]): string[] {
  return frames
    .filter((f) => (f as { type?: string }).type === 'system' && (f as { subtype?: string }).subtype === 'hook_started')
    .map((f) => (f as { hook_event?: string }).hook_event as string)
}

/** The tool_result frames (role-'user' messages carrying a tool_use_id). */
function toolResults(frames: Frame[]): Array<{ tool_use_id: string; content: unknown; is_error?: boolean }> {
  return frames
    .filter((f) => f.type === 'user')
    .map((f) => (f as Frame).message.content[0] as { tool_use_id: string; content: unknown; is_error?: boolean })
    .filter((c) => c.tool_use_id !== undefined)
}

/** marker.txt content, or null when absent. */
async function markerText(dir: string): Promise<string | null> {
  try {
    return await readFile(join(dir, 'marker.txt'), 'utf8')
  } catch {
    return null
  }
}

describe('PostToolUse / PostToolUseFailure routing (RS §12.1: throw-vs-return)', () => {
  it('a soft isError normal return fires PostToolUse, NOT PostToolUseFailure', async () => {
    // Skill with an unknown name returns { text, isError:true } NORMALLY (no
    // throw) — the soft-failure case that must still route to PostToolUse.
    const { frames } = await runToolTurn({
      hooks: routingHooks('Skill'),
      toolName: 'Skill',
      toolInput: { skill: 'no-such-skill-xyz' },
    })
    expect(hookEvents(frames)).toEqual(['PostToolUse'])
    // The soft failure still produces an error tool_result.
    const results = toolResults(frames)
    expect(results).toHaveLength(1)
    expect(results[0].is_error).toBe(true)
  }, 20_000)

  it('a thrown error fires PostToolUseFailure, NOT PostToolUse', async () => {
    // Read of a missing file throws ToolInputError (non-backgroundable, so the
    // throw reaches the loop's catch path rather than being softened).
    const { frames } = await runToolTurn({
      hooks: routingHooks('Read'),
      toolName: 'Read',
      toolInput: { file_path: 'does-not-exist.txt' },
    })
    expect(hookEvents(frames)).toEqual(['PostToolUseFailure'])
    const results = toolResults(frames)
    expect(results).toHaveLength(1)
    expect(results[0].is_error).toBe(true)
  }, 20_000)

  it('an MCP tool returning isError:true fires PostToolUseFailure (via throw)', async () => {
    const { frames } = await runToolTurn({
      hooks: routingHooks('mcp__a__boom'),
      toolName: 'mcp__a__boom',
      toolInput: {},
      mcpServers: { a: { type: 'sdk', instance: boomServer() } },
    })
    expect(hookEvents(frames)).toEqual(['PostToolUseFailure'])
    const results = toolResults(frames)
    expect(results).toHaveLength(1)
    expect(results[0].is_error).toBe(true)
    // The MCP error payload survives as the error result text.
    expect(JSON.stringify(results[0].content)).toContain('mcp-boom-error-text')
  }, 20_000)
})

describe('PostToolUse updatedToolOutput rewrite (RS §4.9: last-write-wins)', () => {
  it('two rewrite hooks merge last-write-wins and replace the result content', async () => {
    const hooks: SessionHooksConfig = {
      PostToolUse: [{
        matcher: 'Bash',
        hooks: [
          commandHook(postHsoJson({ updatedToolOutput: 'rewrite-A' })),
          commandHook(postHsoJson({ updatedToolOutput: 'rewrite-B' })),
        ],
      }],
    }
    const { frames } = await runToolTurn({
      hooks,
      toolName: 'Bash',
      toolInput: { command: 'echo original-output' },
    })
    const results = toolResults(frames)
    expect(results).toHaveLength(1)
    const content = JSON.stringify(results[0].content)
    // The LAST hook in collection order wins; the earlier rewrite is gone.
    expect(content).toContain('rewrite-B')
    expect(content).not.toContain('rewrite-A')
    expect(content).not.toContain('original-output')
  }, 20_000)
})

describe('PostToolUse additionalContext + exit-2 stderr to model', () => {
  it('injects additionalContext into the conversation for the next model round', async () => {
    const hooks = postHook('Bash', postHsoJson({ additionalContext: 'post-context-xyz' }))
    const { requests } = await runToolTurn({
      hooks,
      toolName: 'Bash',
      toolInput: { command: 'echo hi' },
    })
    expect(requests.length).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(requests[1].messages)).toContain('post-context-xyz')
  }, 20_000)

  it('exit-2 feeds stderr to the model while the tool result stands (tool already ran)', async () => {
    const hooks = postHook('Bash', 'echo post-exit2-stderr >&2; exit 2')
    const { dir, frames, requests } = await runToolTurn({
      hooks,
      toolName: 'Bash',
      toolInput: { command: 'echo ran > marker.txt' },
    })
    // The tool ran despite the block (PostToolUse is after execution).
    expect(await markerText(dir)).toContain('ran')
    // The block stderr reaches the model as next-round feedback.
    expect(requests.length).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(requests[1].messages)).toContain('post-exit2-stderr')
    // The successful tool result is NOT erased by the block.
    const results = toolResults(frames)
    expect(results).toHaveLength(1)
    expect(results[0].is_error).toBeFalsy()
  }, 20_000)
})

describe('PostToolUseFailure additionalContext + exit-2 stderr to model', () => {
  it('injects additionalContext into the conversation for the next model round', async () => {
    const hooks = failureHook('Read', failureHsoJson({ additionalContext: 'failure-context-xyz' }))
    const { requests } = await runToolTurn({
      hooks,
      toolName: 'Read',
      toolInput: { file_path: 'does-not-exist.txt' },
    })
    expect(requests.length).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(requests[1].messages)).toContain('failure-context-xyz')
  }, 20_000)

  it('exit-2 feeds stderr to the model on the failure path', async () => {
    const hooks = failureHook('Read', 'echo failure-exit2-stderr >&2; exit 2')
    const { requests } = await runToolTurn({
      hooks,
      toolName: 'Read',
      toolInput: { file_path: 'does-not-exist.txt' },
    })
    expect(requests.length).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(requests[1].messages)).toContain('failure-exit2-stderr')
  }, 20_000)
})
