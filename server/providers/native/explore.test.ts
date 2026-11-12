// server/providers/native/explore.test.ts
import { describe, expect, it } from 'vitest'
import {
  EXPLORE_AGENT_INSTRUCTION,
  EXPLORE_AGENT_NAME,
  filterExploreTools,
} from './explore.js'
import type { ToolDef } from './tools/types.js'

function tool(name: string, readOnlyHint?: unknown): ToolDef {
  return {
    name,
    description: `${name} description`,
    guidance: '',
    promptOrder: 1,
    schema: {},
    ...(readOnlyHint === undefined ? {} : { readOnlyHint }),
    async run() { return { text: 'ok' } },
  } as ToolDef
}

describe('Explore agent role', () => {
  it('uses the reserved case-sensitive name and fixed read-only instruction', () => {
    expect(EXPLORE_AGENT_NAME).toBe('Explore')
    expect(EXPLORE_AGENT_INSTRUCTION).toBe(
      'Explore the codebase read-only. Use available read-only tools to answer with concrete file references; do not modify files or run state-changing tools.',
    )
  })

  it('keeps only tools whose readOnlyHint is exactly true', () => {
    const read = tool('Read', true)
    const write = tool('Write', false)
    const undeclared = tool('Undeclared')
    const truthyString = tool('TruthString', 'true')
    const truthyNumber = tool('TruthNumber', 1)

    expect(filterExploreTools([read, write, undeclared, truthyString, truthyNumber])).toEqual([read])
  })

  it('returns a detached array without rewriting tool metadata', () => {
    const read = tool('Read', true)
    const input = [read]

    const output = filterExploreTools(input)

    expect(output).not.toBe(input)
    expect(output[0]).toBe(read)
    expect(output[0].readOnlyHint).toBe(true)
  })
})
