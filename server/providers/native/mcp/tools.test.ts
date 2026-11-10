// server/providers/native/mcp/tools.test.ts
//
// The adapter is thin: one ToolDef per discovered tool, named by the shared
// API-safe FQN, with the discovered JSON Schema passed through unchanged and
// every call delegated to the connection manager (signal included).

import { describe, expect, it } from 'vitest'
import { MCP_PROMPT_ORDER_BASE, mcpToolDefs } from './tools.js'
import type { NativeMcpConnections, NativeMcpToolInfo } from './connections.js'

const echoInfo: NativeMcpToolInfo = {
  server: 'a',
  name: 'echo',
  fqn: 'mcp__a__echo',
  rawName: 'echo',
  description: 'Echo the given text back.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
}

const readInfo: NativeMcpToolInfo = {
  server: 'b',
  name: 'read',
  fqn: 'mcp__b__read',
  rawName: 'read',
  description: 'Read a resource.',
  inputSchema: { type: 'object', properties: {} },
}

interface Call {
  fqn: string
  input: Record<string, unknown>
  signal: AbortSignal
}

function fakeConnections(infos: NativeMcpToolInfo[]) {
  const calls: Call[] = []
  const conns = {
    tools: () => infos,
    call: async (fqn: string, input: Record<string, unknown>, signal: AbortSignal) => {
      calls.push({ fqn, input, signal })
      return { text: `ok:${fqn}` }
    },
  } as unknown as NativeMcpConnections
  return { conns, calls }
}

describe('mcpToolDefs', () => {
  it('maps each discovered tool onto a ToolDef named by its FQN', () => {
    const { conns } = fakeConnections([echoInfo, readInfo])

    const defs = mcpToolDefs(conns)

    expect(defs.map((def) => def.name)).toEqual(['mcp__a__echo', 'mcp__b__read'])
    expect(defs[0].description).toBe('Echo the given text back.')
    // Guidance is never a prompt section: the system prompt is rendered once
    // at create time, so MCP tools carry an empty guidance string.
    expect(defs.map((def) => def.guidance)).toEqual(['', ''])
    expect(MCP_PROMPT_ORDER_BASE).toBe(200)
    expect(defs.map((def) => def.promptOrder)).toEqual([200, 201])
    // Schema passthrough (same object, not a copy or a re-derived shape).
    expect(defs[0].schema).toBe(echoInfo.inputSchema)
    expect(defs[1].schema).toBe(readInfo.inputSchema)
  })

  it('delegates run(input, ctx) to the connection with its signal', async () => {
    const { conns, calls } = fakeConnections([echoInfo, readInfo])
    const defs = mcpToolDefs(conns)
    const controller = new AbortController()

    const outcome = await defs[1].run({ uri: 'ui://x' }, { cwd: '/tmp', signal: controller.signal })

    expect(outcome).toEqual({ text: 'ok:mcp__b__read' })
    expect(calls).toEqual([
      { fqn: 'mcp__b__read', input: { uri: 'ui://x' }, signal: controller.signal },
    ])
  })
})
