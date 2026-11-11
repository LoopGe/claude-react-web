import { describe, expect, it } from 'vitest'
import { filterToolsForProfile } from './agent-tools.js'
import type { ToolDef } from './tools/types.js'

function tool(name: string): ToolDef {
  return {
    name,
    description: `${name} description`,
    guidance: '',
    promptOrder: 1,
    schema: {},
    run: async () => ({ text: 'ok' }),
  }
}

describe('filterToolsForProfile', () => {
  it('treats an empty tools allowlist as no tools', () => {
    const tools = [tool('Read'), tool('mcp__workspace__lookup')]
    const ownership = new Map([['mcp__workspace__lookup', { name: 'workspace' }]])

    expect(filterToolsForProfile(tools, { tools: [] }, ownership)).toEqual([])
  })

  it('applies disallowedTools after the tools allowlist', () => {
    const tools = [tool('Read'), tool('Write'), tool('Bash')]

    const filtered = filterToolsForProfile(tools, {
      tools: ['Read', 'Write'],
      disallowedTools: ['Write'],
    }, new Map())

    expect(filtered.map((entry) => entry.name)).toEqual(['Read'])
  })

  it('filters MCP tools by server ownership rather than their FQN', () => {
    const tools = [
      tool('Read'),
      tool('mcp__workspace__lookup'),
      tool('mcp__allowed__other'),
    ]
    const ownership = new Map([
      ['mcp__workspace__lookup', { name: 'allowed' }],
      ['mcp__allowed__other', { name: 'workspace' }],
    ])

    const filtered = filterToolsForProfile(tools, { mcpServers: ['allowed'] }, ownership)

    expect(filtered.map((entry) => entry.name)).toEqual(['Read', 'mcp__workspace__lookup'])
    expect(filterToolsForProfile(tools, { mcpServers: [] }, ownership).map((entry) => entry.name)).toEqual(['Read'])
  })

  it('keeps the full rebuilt tool set when no filters are present', () => {
    const tools = [tool('Read'), tool('mcp__workspace__lookup')]
    const ownership = new Map([['mcp__workspace__lookup', { name: 'workspace' }]])

    expect(filterToolsForProfile(tools, {}, ownership)).toEqual(tools)
  })
})
